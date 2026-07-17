import axios from 'axios';
import cfg from '../config/signal.config.js';
import { fetchSeries, fetchReleaseDate, latestValue, latestDate } from './fetch-macro.js';
import { todayET, daysAgoET } from '../utils/datetime.js';

const {
  FRED_SERIES,
  FISCAL_LOOKBACK_DAYS,
  EPU_LOOKBACK_DAYS,
  AI_SEMI_IP_LOOKBACK_DAYS,
} = cfg;

const NULL_FISCAL = { outlaysTtm: null, outlaysTtmPrev: null, outlaysChangePct: null, fiscalPeriodDate: null, fiscalReleaseDate: null };
const NULL_ADMIN = {
  epuTrade: null, epuTradePercentile: null, epuTradePeriodDate: null,
  epuDaily: null, epuDailyPercentile: null, epuDailyPeriodDate: null,
  oilWti: null, oilChange30dPct: null, oilPeriodDate: null, oilSource: null,
};
const NULL_AI = { semiIpYoy: null, semiIpPeriodDate: null, semiIpReleaseDate: null };

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
 * 两个日线序列的区间收益差，单位 %。
 * 先对齐到两序列的共同日期区间（交集的首末交易日），避免窗口不等长导致的失真：
 * 新上市标的（AI 篮子常有新 IPO）或跨 provider 回退（Yahoo 全量 vs TwelveData 截断历史）时，
 * 一方只覆盖 40 天、另一方 90 天，直接比首末 close 会把该标的系统性误判为跑输/跑赢。
 * 共同交易日不足 minOverlap 则返回 null（数据不可比，交由上层降级）。
 * @returns {number|null} semiRet - benchRet
 */
export function calcRelativeReturn(semiBars, benchBars, minOverlap = 2) {
  const clean = bars => (bars || [])
    .filter(b => b && b.date && b.close !== null && b.close !== undefined && !isNaN(b.close));
  const semi = clean(semiBars);
  const bench = clean(benchBars);
  if (semi.length < minOverlap || bench.length < minOverlap) return null;

  // 对齐到共同区间 [max(首日), min(末日)]，各自取该区间内首末有效 close
  const lo = semi[0].date > bench[0].date ? semi[0].date : bench[0].date;
  const semiHi = semi[semi.length - 1].date;
  const benchHi = bench[bench.length - 1].date;
  const hi = semiHi < benchHi ? semiHi : benchHi;
  if (lo >= hi) return null;

  const windowRet = bars => {
    const win = bars.filter(b => b.date >= lo && b.date <= hi);
    if (win.length < minOverlap) return null;
    return (win[win.length - 1].close / win[0].close - 1) * 100;
  };
  const semiRet = windowRet(semi);
  const benchRet = windowRet(bench);
  if (semiRet === null || benchRet === null) return null;
  return semiRet - benchRet;
}

/**
 * 正值月度序列的 TTM 同比（联邦支出用）：最近12月合计 vs 此前12月合计
 * @param {Array} observations - FRED 观测（日期降序）
 */
export function calcTtmChange(observations) {
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
  return { ttmCurrent, ttmPrevYear, changePct: (ttmCurrent / ttmPrevYear - 1) * 100 };
}

/**
 * 财政：联邦月度支出 → 实际(剔除通胀)TTM同比变化（支出=政府规模，"大市场小政府"原则的直接度量）
 * 用实际支出而非名义：名义支出自然增速≈名义GDP≈5%，卡在阈值上会让财政约一半时间预挂收紧
 * （假警报主因）。剔除通胀后，实际同比围绕零漂移，阈值只在政府真实扩张/收缩时触发。
 * 实际同比 ≈ 名义TTM同比 − 同期TTM平均PCE通胀
 */
export async function fetchFiscalData(apiKey) {
  const obs = await fetchSeries(FRED_SERIES.FISCAL_OUTLAYS, daysAgoET(FISCAL_LOOKBACK_DAYS), apiKey);
  const { ttmCurrent, ttmPrevYear, changePct: nominalChangePct } = calcTtmChange(obs);

  // 同期通胀：PCE价格指数近12月均值 vs 前12月均值的同比（与支出TTM窗口对齐）
  let inflationPct = null;
  try {
    const pceObs = await fetchSeries(FRED_SERIES.PCE_PRICE_INDEX, daysAgoET(FISCAL_LOOKBACK_DAYS), apiKey);
    const pceVals = [];
    for (const o of pceObs) {
      const v = parseFloat(o.value);
      if (!isNaN(v)) pceVals.push(v);
      if (pceVals.length === 24) break;
    }
    if (pceVals.length >= 24) {
      const avgCur = pceVals.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
      const avgPrev = pceVals.slice(12, 24).reduce((a, b) => a + b, 0) / 12;
      if (avgPrev !== 0) inflationPct = (avgCur / avgPrev - 1) * 100;
    }
  } catch (err) {
    console.warn('[fetch-policy] PCE price index fetch failed, fiscal falls back to nominal:', err.message);
  }

  // 实际支出同比 = 名义同比 − 通胀（通胀拉取失败则退回名义，保持可用）
  const realChangePct = (nominalChangePct !== null && inflationPct !== null)
    ? nominalChangePct - inflationPct
    : nominalChangePct;

  const fiscalPeriodDate = latestDate(obs);
  const fiscalReleaseDate = fiscalPeriodDate
    ? await fetchReleaseDate(FRED_SERIES.FISCAL_OUTLAYS, fiscalPeriodDate, apiKey).catch(() => null)
    : null;
  return {
    outlaysTtm: ttmCurrent,
    outlaysTtmPrev: ttmPrevYear,
    outlaysChangePct: realChangePct,       // 实际同比（信号判定用）
    outlaysNominalChangePct: nominalChangePct, // 名义同比（展示/诊断用）
    fiscalInflationPct: inflationPct,
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
 * Yahoo 原始 chart API 直连拉日线（绕开 yahoo-finance2 库的 cookie/crumb 握手端点——
 * 该端点对部分 IP 持续 429，而原始 chart 接口不受影响，期货 CL=F 实测可用）
 * @returns {Array<{date, close:number}>|null} 升序
 */
export async function fetchYahooChartCloses(symbol, rangeDays) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${rangeDays}d&interval=1d`;
  const res = await axios.get(url, { timeout: 15000 });
  const result = res.data?.chart?.result?.[0];
  const ts = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!ts || !closes) return null;
  const bars = ts
    .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter(b => b.close !== null && b.close !== undefined && !isNaN(b.close));
  return bars.length ? bars : null;
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
      // ① WTI期货 CL=F（原始chart接口直连，最新交易日，战争定价第一反应）
      // ② FRED DCOILWTICO 现货（EIA编制，发布滞后3~5个工作日，兜底并标注"现货(滞后)"）
      try {
        const bars = await fetchYahooChartCloses('CL=F', cfg.OIL_LOOKBACK_DAYS);
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
 * AI供需基本面：半导体产出同比（供给侧，末端）。
 * （调用量/capex 由 fetchAiChainData 提供，在 server 层合成三件套；SMH-SPY股价代理已移除）
 */
export async function fetchAiSupplyData(apiKey) {
  try {
    const obs = await fetchSeries(FRED_SERIES.SEMI_IP, daysAgoET(AI_SEMI_IP_LOOKBACK_DAYS), apiKey, 'pc1');
    const semiIpPeriodDate = latestDate(obs);
    const semiIpReleaseDate = semiIpPeriodDate
      ? await fetchReleaseDate(FRED_SERIES.SEMI_IP, semiIpPeriodDate, apiKey).catch(() => null)
      : null;
    return { semiIpYoy: latestValue(obs), semiIpPeriodDate, semiIpReleaseDate };
  } catch (err) {
    console.warn('[fetch-policy] AI fundamental fetch failed:', err.message);
    return { semiIpYoy: null, semiIpPeriodDate: null, semiIpReleaseDate: null };
  }
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
