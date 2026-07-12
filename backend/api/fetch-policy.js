import cfg from '../config/signal.config.js';
import { fetchSeries, fetchReleaseDate, latestValue, latestDate } from './fetch-macro.js';
import { getDailyCloses } from './market-data.js';
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
const NULL_ADMIN = {
  epuTrade: null, epuTradePercentile: null, epuTradePeriodDate: null,
  epuDaily: null, epuDailyPercentile: null, epuDailyPeriodDate: null,
  oilWti: null, oilChange30dPct: null, oilPeriodDate: null, oilSource: null,
};
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
 * 日频序列 → n日移动均线序列（输入观测按日期降序，输出均线值数组升序）
 * 日频EPU单日噪声极大（任何头条都会跳），均线平滑后再算百分位
 */
export function calcMaSeries(observations, n) {
  const asc = [];
  for (let i = observations.length - 1; i >= 0; i--) {
    const v = parseFloat(observations[i].value);
    if (!isNaN(v)) asc.push(v);
  }
  const ma = [];
  let sum = 0;
  for (let i = 0; i < asc.length; i++) {
    sum += asc[i];
    if (i >= n) sum -= asc[i - n];
    if (i >= n - 1) ma.push(sum / n);
  }
  return ma;
}

/**
 * 窗口涨跌幅：最新观测 vs 约 windowDays 天前的观测（%）
 * @param {Array} observations - FRED 观测（日期降序），值可能含无效"."
 * @returns {{latest: number|null, changePct: number|null, latestDate: string|null}}
 */
export function calcWindowChangePct(observations, windowDays) {
  const valid = (observations || [])
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .filter(o => !isNaN(o.value));
  if (!valid.length) return { latest: null, changePct: null, latestDate: null };
  const latest = valid[0];
  const target = new Date(new Date(latest.date + 'T00:00:00Z').getTime() - windowDays * 86400000)
    .toISOString().slice(0, 10);
  // 降序找第一个日期 <= 目标日的观测（最接近30天前的交易日）
  const base = valid.find(o => o.date <= target);
  if (!base || base.value === 0) return { latest: latest.value, changePct: null, latestDate: latest.date };
  return {
    latest: latest.value,
    changePct: (latest.value - base.value) / base.value * 100,
    latestDate: latest.date,
  };
}

/**
 * 行政：油价事件层（WTI 30天涨跌幅，战争冲击实时代理）+ EPU双代理（月度贸易专项 + 日频7日均线）
 * 三侧独立容错：任一失败不影响其余（判定函数对缺失有降级规则）
 */
export async function fetchAdminData(apiKey) {
  const [trade, daily, oil] = await Promise.all([
    (async () => {
      const obs = await fetchSeries(FRED_SERIES.EPU_TRADE, daysAgoET(EPU_LOOKBACK_DAYS), apiKey);
      const epuTrade = latestValue(obs);
      const values = obs.map(o => parseFloat(o.value)).filter(v => !isNaN(v));
      return {
        epuTrade,
        epuTradePercentile: calcPercentile(epuTrade, values),
        epuTradePeriodDate: latestDate(obs),
      };
    })().catch(err => {
      console.warn('[fetch-policy] EPU trade fetch failed:', err.message);
      return { epuTrade: null, epuTradePercentile: null, epuTradePeriodDate: null };
    }),
    (async () => {
      const obs = await fetchSeries(FRED_SERIES.EPU_DAILY, daysAgoET(EPU_LOOKBACK_DAYS), apiKey);
      const ma = calcMaSeries(obs, cfg.EPU_DAILY_MA_DAYS);
      const latestMa = ma.length ? ma[ma.length - 1] : null;
      return {
        epuDaily: latestMa,
        epuDailyPercentile: calcPercentile(latestMa, ma),
        epuDailyPeriodDate: latestDate(obs),
      };
    })().catch(err => {
      console.warn('[fetch-policy] EPU daily fetch failed:', err.message);
      return { epuDaily: null, epuDailyPercentile: null, epuDailyPeriodDate: null };
    }),
    (async () => {
      // 油价两层（用户拍板：油价水平语义必须是真实WTI，不用ETF代理）：
      // ① WTI期货 CL=F（真实期货价，最新交易日，战争定价第一反应）
      // ② FRED DCOILWTICO 现货（EIA编制，发布滞后3~5个工作日，兜底并标注"现货(滞后)"）
      try {
        const bars = await getDailyCloses('CL=F', daysAgoET(cfg.OIL_LOOKBACK_DAYS), todayET());
        const obs = (bars || [])
          .map(b => ({ date: b.date, value: String(b.close) }))
          .sort((a, b) => (a.date < b.date ? 1 : -1)); // calcWindowChangePct 期望降序
        const { latest, changePct, latestDate: d } = calcWindowChangePct(obs, cfg.OIL_SHOCK_WINDOW_DAYS);
        if (latest !== null && changePct !== null) {
          return { oilWti: latest, oilChange30dPct: changePct, oilPeriodDate: d, oilSource: 'futures' };
        }
      } catch (err) {
        console.warn('[fetch-policy] CL=F futures failed:', err.message);
      }
      const obs = await fetchSeries(FRED_SERIES.OIL_WTI, daysAgoET(cfg.OIL_LOOKBACK_DAYS), apiKey);
      const { latest, changePct, latestDate: d } = calcWindowChangePct(obs, cfg.OIL_SHOCK_WINDOW_DAYS);
      return { oilWti: latest, oilChange30dPct: changePct, oilPeriodDate: d, oilSource: latest !== null ? 'spot' : null };
    })().catch(err => {
      console.warn('[fetch-policy] oil fetch failed:', err.message);
      return { oilWti: null, oilChange30dPct: null, oilPeriodDate: null, oilSource: null };
    }),
  ]);
  return { ...trade, ...daily, ...oil };
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
        getDailyCloses(AI_MARKET_SYMBOLS.SEMI, period1, period2),
        getDailyCloses(AI_MARKET_SYMBOLS.BENCH, period1, period2),
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
