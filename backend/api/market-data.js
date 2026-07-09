import axios from 'axios';
import yahooFinance from 'yahoo-finance2';

// 统一行情入口：Yahoo → Tiingo → Twelve Data 三层回退
// 背景：Yahoo 对数据中心/非住宅IP大面积限流（本机与Railway都持续429），
// 备用源 key 缺失时优雅跳过该层，全失败返回 null，永不 throw
const TIINGO_DAILY_URL = sym => `https://api.tiingo.com/tiingo/daily/${sym}/prices`;
const TIINGO_IEX_URL = sym => `https://api.tiingo.com/iex/${sym}`;
const TWELVEDATA_SERIES_URL = 'https://api.twelvedata.com/time_series';
const TWELVEDATA_PRICE_URL = 'https://api.twelvedata.com/price';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10分钟：省备用源配额（TwelveData 8次/分钟最紧）并提速自选股页面

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
}

/** 测试用：清空缓存 */
export function clearMarketDataCache() {
  cache.clear();
}

// --- 日线收盘价：升序 [{date, close}] ---

async function closesFromYahoo(symbol, startDate, endDate) {
  const bars = await yahooFinance.historical(symbol, { period1: startDate, period2: endDate });
  const closes = (bars || [])
    .map(b => ({ date: b.date instanceof Date ? b.date.toISOString().slice(0, 10) : String(b.date).slice(0, 10), close: b.close }))
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
  const key = `closes:${symbol}:${startDate}:${endDate}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const providers = [
    ['yahoo', closesFromYahoo],
    ['tiingo', closesFromTiingo],
    ['twelvedata', closesFromTwelveData],
  ];
  for (const [name, fn] of providers) {
    try {
      const closes = await fn(symbol, startDate, endDate);
      if (closes) {
        if (name !== 'yahoo') console.warn(`[market-data] ${symbol} closes via fallback: ${name}`);
        cacheSet(key, closes);
        return closes;
      }
    } catch (err) {
      console.warn(`[market-data] ${name} closes(${symbol}) failed:`, err.message);
    }
  }
  return null; // 全失败不缓存，下次调用重试
}

// --- 实时报价 ---

async function quoteFromYahoo(symbol) {
  const q = await yahooFinance.quote(symbol);
  if (q?.regularMarketPrice === null || q?.regularMarketPrice === undefined) return null;
  return {
    price: q.regularMarketPrice,
    trailingPE: q.trailingPE ?? null,
    forwardPE: q.forwardPE ?? null,
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
  return { price, trailingPE: null, forwardPE: null, priceToBook: null, shortName: null, source: 'tiingo' };
}

async function quoteFromTwelveData(symbol) {
  const apikey = process.env.TWELVEDATA_API_KEY;
  if (!apikey) return null;
  const res = await axios.get(TWELVEDATA_PRICE_URL, { params: { symbol, apikey }, timeout: 15000 });
  const price = parseFloat(res.data?.price);
  if (isNaN(price)) return null;
  return { price, trailingPE: null, forwardPE: null, priceToBook: null, shortName: null, source: 'twelvedata' };
}

/**
 * 实时报价（三层回退 + 10分钟缓存）。备用源只有价格，估值字段为 null
 * @returns {{price, trailingPE, forwardPE, priceToBook, shortName, source}|null}
 */
export async function getQuote(symbol) {
  const key = `quote:${symbol}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const providers = [
    ['yahoo', quoteFromYahoo],
    ['tiingo', quoteFromTiingo],
    ['twelvedata', quoteFromTwelveData],
  ];
  for (const [name, fn] of providers) {
    try {
      const quote = await fn(symbol);
      if (quote) {
        if (name !== 'yahoo') console.warn(`[market-data] ${symbol} quote via fallback: ${name}`);
        cacheSet(key, quote);
        return quote;
      }
    } catch (err) {
      console.warn(`[market-data] ${name} quote(${symbol}) failed:`, err.message);
    }
  }
  return null;
}
