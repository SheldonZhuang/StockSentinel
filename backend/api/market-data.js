import axios from 'axios';
import { closesFromMoomoo, quoteFromMoomoo, moomooEnabled } from './moomoo-data.js';
import yahooFinance from 'yahoo-finance2';

// 统一行情入口：Yahoo → Tiingo → Twelve Data 三层回退
// 背景：Yahoo 对数据中心/非住宅IP大面积限流（本机与Railway都持续429），
// 备用源 key 缺失时优雅跳过该层，全失败返回 null，永不 throw
const TIINGO_DAILY_URL = sym => `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(sym)}/prices`;
const TIINGO_IEX_URL = sym => `https://api.tiingo.com/iex/${encodeURIComponent(sym)}`;
const TWELVEDATA_SERIES_URL = 'https://api.twelvedata.com/time_series';
const TWELVEDATA_PRICE_URL = 'https://api.twelvedata.com/price';
// FMP 新版 stable 接口（旧 v3 对2025-08后注册的key已关闭）；免费层250次/天
const FMP_QUOTE_URL = 'https://financialmodelingprep.com/stable/quote';
const FMP_RATIOS_URL = 'https://financialmodelingprep.com/stable/ratios-ttm';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10分钟：省备用源配额（TwelveData 8次/分钟最紧）并提速自选股页面
const CLOSES_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 历史日线盘中不变，12小时缓存大幅降低备用源配额消耗
const CLOSES_TODAY_TTL_MS = 10 * 60 * 1000; // 含当日的序列：最后一根是盘中跳动的半根bar，不能缓存12h当收盘价用

// UTC 今日（与各 provider 的 chart period2 口径一致，用于判断序列是否含"今天"这根未定盘的 bar）
function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

const fmpKey = () => process.env.FMP_API_KEY || process.env.financialmodelingprep_API_KEY;
// TwelveData 免费层 8次/分钟：全局最小调用间隔，超频会返回 status:error 白白烧掉调用
const TWELVEDATA_MIN_INTERVAL_MS = 8000;

// 指数/收益率的常见写法（TradingView风格等）→ Yahoo 符号惯例
// ^ 前缀符号自动跳过 moomoo 层（用户账户美股指数无权限），走 Yahoo chart 直连
// 注意：裸词别名（VIX/SPX/NDX）当前无同名真实上市代码；若未来出现同名新股会被此表吞掉，加别名前先查证
const SYMBOL_ALIASES = {
  'US10Y': '^TNX',  // 10年期美债收益率
  'US30Y': '^TYX',
  'US5Y': '^FVX',
  '.VIX': '^VIX',
  'VIX': '^VIX',
  '.SPX': '^GSPC',
  'SPX': '^GSPC',
  '.NDX': '^NDX',
  'NDX': '^NDX',
  '.DJI': '^DJI',
  // 公司名误输入 → 正确代码（自选股历史数据兼容）
  'NEBIUS': 'NBIS',
  '海力士': 'SKHY',
};
export const normalizeSymbol = s => SYMBOL_ALIASES[String(s || '').toUpperCase()] || s;

const cache = new Map();
// in-flight 去重：同 key 并发请求共享同一次拉取，避免重复烧备用源配额（TwelveData 8次/分钟最紧）
const inFlight = new Map();
let lastTwelveDataCallAt = 0;
// 串行队列：并发调用者逐个排队等自己的时间窗，避免多个调用者读到同一个
// lastTwelveDataCallAt、睡完同时醒来齐发导致 429（自选股接口是并发拉全部股票的）
let twelveDataQueue = Promise.resolve();

function twelveDataThrottle() {
  const turn = twelveDataQueue.then(async () => {
    const wait = lastTwelveDataCallAt + TWELVEDATA_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastTwelveDataCallAt = Date.now();
  });
  twelveDataQueue = turn;
  return turn;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  cache.set(key, { at: Date.now(), value, ttl });
}

/** 测试用：清空缓存并重置节流状态 */
export function clearMarketDataCache() {
  cache.clear();
  inFlight.clear();
  lastTwelveDataCallAt = 0;
  twelveDataQueue = Promise.resolve();
}

/** 同 key 并发合并：已有相同请求在飞则直接等它的结果 */
function dedupe(key, fn) {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// --- 日线收盘价：升序 [{date, close}] ---

async function closesFromYahoo(symbol, startDate, endDate) {
  try {
    const bars = await yahooFinance.historical(symbol, { period1: startDate, period2: endDate });
    const closes = (bars || [])
      .map(b => ({ date: b.date instanceof Date ? b.date.toISOString().slice(0, 10) : String(b.date).slice(0, 10), close: b.close }))
      .filter(b => b.close !== null && b.close !== undefined && !isNaN(b.close));
    if (closes.length) return closes;
  } catch (err) {
    // yahoo-finance2 库走的 cookie/crumb 握手端点对部分 IP 持续 429；
    // 原始 chart 接口不受影响（实测同机可用），降级直连再试一次
    console.warn(`[market-data] yahoo lib closes(${symbol}) failed, trying raw chart:`, err.message.slice(0, 80));
  }
  return closesFromYahooChart(symbol, startDate, endDate);
}

/** Yahoo 原始 chart API 直连（绕开库端点限流），升序 [{date, close}]，取复权价 */
async function closesFromYahooChart(symbol, startDate, endDate) {
  const period1 = Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000);
  const period2 = Math.floor(new Date(endDate + 'T00:00:00Z').getTime() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await axios.get(url, { timeout: 15000 });
  const result = res.data?.chart?.result?.[0];
  const ts = result?.timestamp;
  if (!ts) return null;
  const adj = result?.indicators?.adjclose?.[0]?.adjclose;
  const raw = result?.indicators?.quote?.[0]?.close;
  const closes = ts
    .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: adj?.[i] ?? raw?.[i] }))
    .filter(b => b.close !== null && b.close !== undefined && !isNaN(b.close));
  return closes.length ? closes : null;
}

async function closesFromTiingo(symbol, startDate, endDate) {
  const token = process.env.TIINGO_API_KEY;
  if (!token) return null;
  const res = await axios.get(TIINGO_DAILY_URL(symbol), {
    params: { startDate, endDate, token },
    timeout: 15000,
  });
  if (!Array.isArray(res.data)) return null;
  const closes = res.data
    .map(r => ({ date: String(r.date).slice(0, 10), close: r.adjClose ?? r.close }))
    .filter(b => b.close !== null && b.close !== undefined && !isNaN(b.close));
  return closes.length ? closes : null;
}

async function closesFromTwelveData(symbol, startDate, endDate) {
  const apikey = process.env.TWELVEDATA_API_KEY;
  if (!apikey) return null;
  await twelveDataThrottle();
  const res = await axios.get(TWELVEDATA_SERIES_URL, {
    params: { symbol, interval: '1day', start_date: startDate, end_date: endDate, apikey },
    timeout: 15000,
  });
  if (res.data?.status === 'error' || !Array.isArray(res.data?.values)) return null;
  const closes = res.data.values
    .map(r => ({ date: String(r.datetime).slice(0, 10), close: parseFloat(r.close) }))
    .filter(b => !isNaN(b.close))
    .reverse(); // TwelveData 返回降序，统一为升序
  return closes.length ? closes : null;
}

/**
 * 日线收盘价（三层回退 + 10分钟缓存）
 * @returns {Array<{date: string, close: number}>|null} 升序；全部失败 → null
 */
export async function getDailyCloses(symbol, startDate, endDate) {
  symbol = normalizeSymbol(symbol);
  const key = `closes:${symbol}:${startDate}:${endDate}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  return dedupe(key, async () => {
    const cachedAgain = cacheGet(key); // 排队期间可能已被同 key 请求填充
    if (cachedAgain !== undefined) return cachedAgain;

    const providers = [
      // moomoo OpenD 本地网关（美股LV3，仅 MOOMOO_WS_PORT 配置时参与；失败静默回落）
      ...(moomooEnabled() ? [['moomoo', closesFromMoomoo]] : []),
      ['yahoo', closesFromYahoo],
      ['tiingo', closesFromTiingo],
      ['twelvedata', closesFromTwelveData],
    ];
    for (const [name, fn] of providers) {
      try {
        const closes = await fn(symbol, startDate, endDate);
        if (closes) {
          if (name !== 'yahoo' && name !== 'moomoo') console.warn(`[market-data] ${symbol} closes via fallback: ${name}`);
          // endDate 覆盖到今天：最后一根 bar 是盘中实时价（非收盘），用短 TTL 避免把它当收盘价缓存一整天
          const ttl = endDate >= utcToday() ? CLOSES_TODAY_TTL_MS : CLOSES_CACHE_TTL_MS;
          cacheSet(key, closes, ttl);
          return closes;
        }
      } catch (err) {
        console.warn(`[market-data] ${name} closes(${symbol}) failed:`, err?.message || String(err).slice(0, 120));
      }
    }
    return null; // 全失败不缓存，下次调用重试
  });
}

// --- 实时报价 ---

async function quoteFromYahoo(symbol) {
  let q;
  try {
    q = await yahooFinance.quote(symbol);
  } catch (err) {
    // 库端点限流时降级原始 chart 接口的 meta（只有价格，估值字段交给后续 FMP 补全）
    console.warn(`[market-data] yahoo lib quote(${symbol}) failed, trying raw chart:`, err.message.slice(0, 80));
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const res = await axios.get(url, { timeout: 15000 });
    const meta = res.data?.chart?.result?.[0]?.meta;
    if (meta?.regularMarketPrice === null || meta?.regularMarketPrice === undefined) return null;
    return {
      price: meta.regularMarketPrice,
      trailingPE: null,
      forwardPE: null,
      priceToSales: null,
      priceToBook: null,
      shortName: meta.shortName ?? null,
      source: 'yahoo-chart',
    };
  }
  if (q?.regularMarketPrice === null || q?.regularMarketPrice === undefined) return null;
  return {
    price: q.regularMarketPrice,
    trailingPE: q.trailingPE ?? null,
    forwardPE: q.forwardPE ?? null,
    priceToSales: null, // yahoo quote 无P/S，由 FMP ratios 补全
    priceToBook: q.priceToBook ?? null,
    shortName: q.shortName ?? null,
    source: 'yahoo',
  };
}

async function quoteFromTiingo(symbol) {
  const token = process.env.TIINGO_API_KEY;
  if (!token) return null;
  const res = await axios.get(TIINGO_IEX_URL(symbol), { params: { token }, timeout: 15000 });
  const row = Array.isArray(res.data) ? res.data[0] : null;
  const price = row?.tngoLast ?? row?.last ?? row?.prevClose ?? null;
  if (price === null || isNaN(price)) return null;
  // 备用源只有价格，估值字段降级为 null
  return { price, trailingPE: null, forwardPE: null, priceToSales: null, priceToBook: null, shortName: null, source: 'tiingo' };
}

async function quoteFromTwelveData(symbol) {
  const apikey = process.env.TWELVEDATA_API_KEY;
  if (!apikey) return null;
  await twelveDataThrottle();
  const res = await axios.get(TWELVEDATA_PRICE_URL, { params: { symbol, apikey }, timeout: 15000 });
  const price = parseFloat(res.data?.price);
  if (isNaN(price)) return null;
  return { price, trailingPE: null, forwardPE: null, priceToSales: null, priceToBook: null, shortName: null, source: 'twelvedata' };
}

async function quoteFromFmp(symbol) {
  const apikey = fmpKey();
  if (!apikey) return null;
  const res = await axios.get(FMP_QUOTE_URL, { params: { symbol, apikey }, timeout: 15000 });
  const row = Array.isArray(res.data) ? res.data[0] : null;
  const price = row?.price ?? null;
  if (price === null || isNaN(price)) return null;
  return { price, trailingPE: null, forwardPE: null, priceToSales: null, priceToBook: null, shortName: row.name ?? null, source: 'fmp' };
}

/**
 * Yahoo quoteSummary 补全估值字段（覆盖全部美股与ETF；本机库端点偶发429，静默跳过）
 */
async function fillFundamentalsFromYahooSummary(symbol, quote) {
  if (quote.trailingPE !== null && quote.priceToSales !== null) return quote;
  try {
    const s = await yahooFinance.quoteSummary(symbol, { modules: ['summaryDetail'] });
    const d = s?.summaryDetail;
    if (!d) return quote;
    return {
      ...quote,
      trailingPE: quote.trailingPE ?? (d.trailingPE > 0 ? d.trailingPE : null) ?? null,
      priceToSales: quote.priceToSales ?? d.priceToSalesTrailing12Months ?? null,
    };
  } catch {
    return quote;
  }
}

/**
 * FMP ratios-ttm 补全估值字段（真实P/E与P/S，个股有效；ETF/指数无财报返回空属正常）
 * 任一失败静默跳过，不影响价格
 */
async function fillFundamentalsFromFmp(symbol, quote) {
  const apikey = fmpKey();
  if (!apikey) return quote;
  if (quote.trailingPE !== null && quote.priceToSales !== null) return quote;
  try {
    const res = await axios.get(FMP_RATIOS_URL, { params: { symbol, apikey }, timeout: 15000 });
    const r = Array.isArray(res.data) ? res.data[0] : null;
    if (!r) return quote;
    return {
      ...quote,
      trailingPE: quote.trailingPE ?? r.priceToEarningsRatioTTM ?? null,
      priceToSales: quote.priceToSales ?? r.priceToSalesRatioTTM ?? null,
      priceToBook: quote.priceToBook ?? r.priceToBookRatioTTM ?? null,
    };
  } catch (err) {
    console.warn(`[market-data] fmp ratios(${symbol}) failed:`, err?.message || String(err).slice(0, 120));
    return quote;
  }
}

/**
 * 实时报价（四层回退 + FMP估值补全 + 10分钟缓存）
 * @returns {{price, trailingPE, forwardPE, priceToSales, priceToBook, shortName, source}|null}
 */
export async function getQuote(symbol) {
  symbol = normalizeSymbol(symbol);
  const key = `quote:${symbol}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  return dedupe(key, async () => {
    const cachedAgain = cacheGet(key);
    if (cachedAgain !== undefined) return cachedAgain;

    const providers = [
      ...(moomooEnabled() ? [['moomoo', quoteFromMoomoo]] : []),
      ['yahoo', quoteFromYahoo],
      ['tiingo', quoteFromTiingo],
      ['twelvedata', quoteFromTwelveData],
      ['fmp', quoteFromFmp],
    ];
    for (const [name, fn] of providers) {
      try {
        let quote = await fn(symbol);
        if (quote) {
          if (name !== 'yahoo') console.warn(`[market-data] ${symbol} quote via fallback: ${name}`);
          quote = await fillFundamentalsFromFmp(symbol, quote);
          quote = await fillFundamentalsFromYahooSummary(symbol, quote);
          cacheSet(key, quote);
          return quote;
        }
      } catch (err) {
        console.warn(`[market-data] ${name} quote(${symbol}) failed:`, err?.message || String(err).slice(0, 120));
      }
    }
    return null;
  });
}
