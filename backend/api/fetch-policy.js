import yahooFinance from 'yahoo-finance2';
import cfg from '../config/signal.config.js';
import { fetchSeries, fetchReleaseDate, latestValue, latestDate } from './fetch-macro.js';
import { todayET, daysAgoET } from '../utils/datetime.js';

const {
  FRED_SERIES,
  FISCAL_LOOKBACK_DAYS,
  EPU_LOOKBACK_DAYS,
  AI_MARKET_SYMBOLS,
  AI_MARKET_WINDOW_DAYS,
  AI_SEMI_IP_LOOKBACK_DAYS,
} = cfg;

const NULL_FISCAL = { deficitTtm: null, deficitTtmPrev: null, deficitTtmChangePct: null, fiscalPeriodDate: null, fiscalReleaseDate: null };
const NULL_ADMIN = { epuTrade: null, epuTradePercentile: null, epuTradePeriodDate: null };
const NULL_AI = { smhSpyRelReturnPct: null, semiIpYoy: null, semiIpPeriodDate: null, semiIpReleaseDate: null };

/**
 * 计算滚动12月(TTM)赤字总额及同比变化
 * @param {Array} observations - FRED 观测数组（按日期降序），赤字月份 value 为负
 * @returns {{ttmCurrent, ttmPrevYear, changePct}} changePct 为正表示赤字扩大
 */
export function calcTtmDeficitChange(observations) {
  const values = [];
  for (const obs of observations) {
    const v = parseFloat(obs.value);
    if (!isNaN(v)) values.push(v);
    if (values.length === 24) break;
  }
  if (values.length < 24) return { ttmCurrent: null, ttmPrevYear: null, changePct: null };

  const ttmCurrent = values.slice(0, 12).reduce((a, b) => a + b, 0);
  const ttmPrevYear = values.slice(12, 24).reduce((a, b) => a + b, 0);
  if (ttmPrevYear === 0) return { ttmCurrent, ttmPrevYear, changePct: null };

  // 值为负代表赤字，取负号转为"赤字规模"后比较：changePct > 0 表示赤字扩大（财政扩张）
  const changePct = ((-ttmCurrent) - (-ttmPrevYear)) / Math.abs(ttmPrevYear) * 100;
  return { ttmCurrent, ttmPrevYear, changePct };
}

/**
 * latest 在 values 中的百分位（0-100，保留1位小数）
 */
export function calcPercentile(latest, values) {
  if (latest === null || latest === undefined || !values.length) return null;
  const below = values.filter(v => v <= latest).length;
  return Math.round((below / values.length) * 1000) / 10;
}

/**
 * 两个日线序列的区间收益差（首个有效close → 最后有效close），单位 %
 * @returns {number|null} semiRet - benchRet
 */
export function calcRelativeReturn(semiBars, benchBars) {
  const ret = bars => {
    const closes = (bars || []).map(b => b.close).filter(v => v !== null && v !== undefined && !isNaN(v));
    if (closes.length < 2) return null;
    return (closes[closes.length - 1] / closes[0] - 1) * 100;
  };
  const semiRet = ret(semiBars);
  const benchRet = ret(benchBars);
  if (semiRet === null || benchRet === null) return null;
  return semiRet - benchRet;
}

/**
 * 财政：联邦月度赤字 → TTM同比变化
 */
export async function fetchFiscalData(apiKey) {
  const obs = await fetchSeries(FRED_SERIES.FISCAL_DEFICIT, daysAgoET(FISCAL_LOOKBACK_DAYS), apiKey);
  const { ttmCurrent, ttmPrevYear, changePct } = calcTtmDeficitChange(obs);
  const fiscalPeriodDate = latestDate(obs);
  const fiscalReleaseDate = fiscalPeriodDate
    ? await fetchReleaseDate(FRED_SERIES.FISCAL_DEFICIT, fiscalPeriodDate, apiKey).catch(() => null)
    : null;
  return {
    deficitTtm: ttmCurrent,
    deficitTtmPrev: ttmPrevYear,
    deficitTtmChangePct: changePct,
    fiscalPeriodDate,
    fiscalReleaseDate,
  };
}

/**
 * 行政：贸易政策不确定性指数 → 近10年百分位
 * （学术编制系列，ALFRED 修订记录不可靠，不取发布日期）
 */
export async function fetchAdminData(apiKey) {
  const obs = await fetchSeries(FRED_SERIES.EPU_TRADE, daysAgoET(EPU_LOOKBACK_DAYS), apiKey);
  const epuTrade = latestValue(obs);
  const values = obs.map(o => parseFloat(o.value)).filter(v => !isNaN(v));
  return {
    epuTrade,
    epuTradePercentile: calcPercentile(epuTrade, values),
    epuTradePeriodDate: latestDate(obs),
  };
}

/**
 * AI供需：市场代理（SMH vs SPY 相对收益）+ 基本面代理（半导体IP同比）
 * 两个子拉取各自容错：一边失败不影响另一边
 */
export async function fetchAiSupplyData(apiKey) {
  const [market, fundamental] = await Promise.all([
    (async () => {
      const period1 = daysAgoET(AI_MARKET_WINDOW_DAYS);
      const period2 = todayET();
      const [semiBars, benchBars] = await Promise.all([
        yahooFinance.historical(AI_MARKET_SYMBOLS.SEMI, { period1, period2 }),
        yahooFinance.historical(AI_MARKET_SYMBOLS.BENCH, { period1, period2 }),
      ]);
      return { smhSpyRelReturnPct: calcRelativeReturn(semiBars, benchBars) };
    })().catch(err => {
      console.warn('[fetch-policy] AI market fetch failed:', err.message);
      return { smhSpyRelReturnPct: null };
    }),
    (async () => {
      const obs = await fetchSeries(FRED_SERIES.SEMI_IP, daysAgoET(AI_SEMI_IP_LOOKBACK_DAYS), apiKey, 'pc1');
      const semiIpPeriodDate = latestDate(obs);
      const semiIpReleaseDate = semiIpPeriodDate
        ? await fetchReleaseDate(FRED_SERIES.SEMI_IP, semiIpPeriodDate, apiKey).catch(() => null)
        : null;
      return { semiIpYoy: latestValue(obs), semiIpPeriodDate, semiIpReleaseDate };
    })().catch(err => {
      console.warn('[fetch-policy] AI fundamental fetch failed:', err.message);
      return { semiIpYoy: null, semiIpPeriodDate: null, semiIpReleaseDate: null };
    }),
  ]);
  return { ...market, ...fundamental };
}

/**
 * 拉取财政/行政/AI供需三个维度的自动判定数据
 * 各维度独立容错：单维度失败 → 该维度指标全 null（判定函数会给 neutral），不影响其他维度，永不 throw
 */
export async function fetchPolicyData() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    console.warn('[fetch-policy] FRED_API_KEY not set, policy signals fall back to neutral');
    return { ...NULL_FISCAL, ...NULL_ADMIN, ...NULL_AI };
  }

  const [fiscal, admin, ai] = await Promise.all([
    fetchFiscalData(apiKey).catch(err => {
      console.warn('[fetch-policy] fiscal fetch failed:', err.message);
      return NULL_FISCAL;
    }),
    fetchAdminData(apiKey).catch(err => {
      console.warn('[fetch-policy] admin fetch failed:', err.message);
      return NULL_ADMIN;
    }),
    fetchAiSupplyData(apiKey).catch(err => {
      console.warn('[fetch-policy] ai supply fetch failed:', err.message);
      return NULL_AI;
    }),
  ]);

  return { ...fiscal, ...admin, ...ai };
}
