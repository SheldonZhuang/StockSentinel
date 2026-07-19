// 日度粒度历史重放：最大限度复刻线上每日 cron（runDailyUpdate+computeLocks）的判定路径，
// 2000-01-01~2026-06-30 逐交易日推进，测出线上系统的真实节点判断时机——
// 现有全部准确率数字来自月度采样回放（run-backtest.js），日级反应能力
// （日频油价事件层 / 日频EPU / 按日利率台阶锁 / 30天降档确认）被采样粒度抹平。
// 运行：node backend/backtest/daily-replay.mjs（FRED_API_KEY 从 backend/.env 读取）
// 只 import 线上纯函数与月度回放数据管道，不修改任何现有文件的默认行为。
//
// ── 可见性口径（与月度回放同一约定：决策时点=交易日收盘，隔离"粒度差异"而非"滞后约定差异"）──
//  日频市场化序列（利率台阶生效日/SPY收盘/DCOILWTICO/USEPUINDXD/T10Y3M）：obs.date ≤ 当日即可见。
//    注：线上 cron 在 06:00 UTC 跑，实际比这里晚约1个日历日看到前一日数据（油价线上走期货实时无此滞后；
//    FRED 日频序列编制上另有1~5日发布滞后未建模——与月度回放同样的残余局限，对照因此干净）。
//  周频 WALCL：周三数据周四发布 → obs.date+1 ≤ 当日（复用 lastTwoWeeklyAsOf，与线上/月度回放同口径）。
//  月度序列按真实发布日阶梯化（近似规则与月度回放"月末只见M-1"一致，日内保持上一可见值）：
//    MTSO133FMS(月P)   → P+1月15日可见（财政部MTS次月中旬发布）
//    PCEPI(月P)        → P+2月1日可见（BEA发布日在月末边界上，月度回放同用M-2）
//    SAHMREALTIME(月P) → P+1月第一个周五可见（随非农）
//    EPUTRADE(月P)     → P+1月最后一日可见（编制滞后约1个月）
//  货币决议方向（calcDecisionPrevRate 线上语义）：FOMC日历覆盖 2025-01 起；
//    2000-01~2024-12 日历缺失 → 线上同款退化路径"最近一次实际调整的方向"（台阶方向近似，
//    差异仅在"暂停决议"日：线上判宽松，近似口径在上次台阶后100天回看窗口内保持原方向）。
//  AI供需维恒 neutral（同月度回放：AI主题2015前不存在）；进攻档因此不可达，
//  T10Y3M 曲线否决（只否决attack）在本重放中结构性无操作，仍按线上路径接线并如实报告。
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import cfg from '../config/signal.config.js';
import {
  calcMonetarySignal, calcAdminSignal, calcFiscalSignal, calcFinalSignal,
  calcLockActive, applyDowngradeHold, applyTrendReentry, applyYieldCurveVeto, calcTrendState,
} from '../api/signal.js';
import { calcDecisionPrevRate } from '../api/fetch-macro.js';
import { calcPercentile, calcMaSeries } from '../api/fetch-policy.js';
import { getLastFomcDecisionDate } from '../config/fomc-meetings.js';
import {
  loadData, runReplay, evaluate, VARIANTS_DEFAULT,
  spliceRateSeries, lastTwoWeeklyAsOf, lastDayOfMonth, findPeakTrough, calcMissedPct, ttmChangePct,
} from './run-backtest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .env 解析对 cwd 稳健：先按 cwd（backend/ 下运行），再兜底 backend/.env（仓库根运行）
dotenv.config();
dotenv.config({ path: path.join(__dirname, '../.env') });
const S = cfg.SIGNAL;

const REPLAY_START = '2000-01-01';
const REPLAY_END = '2026-06-30';
const WARMUP_START = '1999-01-01'; // 锁/迟滞状态热身年（1999无≥50bp调整、萨姆低位，2000-01起状态干净）

// ---------- 纯函数（backend/tests/daily-replay.test.js 覆盖） ----------

const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const addDaysISO = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** 'YYYY-MM' 加 n 个月 */
export function addMonthsYM(month, n) {
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/** 该月第一个周五（YYYY-MM-DD）——非农/SAHMREALTIME 发布日近似 */
export function firstFridayOf(month) {
  const [y, m] = month.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return `${month}-${String(1 + ((5 - dow + 7) % 7)).padStart(2, '0')}`;
}

// 月度序列发布日阶梯化规则（月P的观测从该日起可见）
export const mtsVisibleFrom = m => `${addMonthsYM(m, 1)}-15`;          // 财政MTS：次月中旬
export const pcepiVisibleFrom = m => `${addMonthsYM(m, 2)}-01`;        // PCEPI：次次月初（月度回放M-2同口径）
export const sahmVisibleFrom = m => firstFridayOf(addMonthsYM(m, 1));  // 萨姆：次月初随非农
export const epuTradeVisibleFrom = m => lastDayOfMonth(addMonthsYM(m, 1)); // EPUTRADE：月后约1个月

/** [{month,value,...}] → 附 visibleFrom（升序输入，visibleFrom 单调） */
export function buildVisibleSeries(rows, visibleFromFn) {
  return rows.map(r => ({ ...r, visibleFrom: visibleFromFn(r.month) }));
}

/** 升序台阶表：相邻观测的每次变动 {date(新值生效日), diffBp, prevValue} */
export function calcRateStepsAsc(asc) {
  const steps = [];
  for (let i = 1; i < asc.length; i++) {
    const diffBp = Math.round((asc[i].value - asc[i - 1].value) * 100);
    if (diffBp !== 0) steps.push({ date: asc[i].date, diffBp, prevValue: asc[i - 1].value });
  }
  return steps;
}

/** 升序数组内最后一个 key ≤ target 的下标（无 → -1），二分 */
export function lastIdxLE(arr, target, key = 'date') {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][key] <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

/**
 * 货币维利率输入（线上 fetch-macro 同口径）：100天回看窗口内的
 * currentRate / 最新台阶 / prevDistinct，交给线上 calcDecisionPrevRate 得 prevRate。
 * decisionDate=null（2025年前，FOMC日历未覆盖）→ 线上同款退化：最近一次实际调整的方向；
 * 窗口内无台阶 → prevRate=currentRate（差0 → 暂停→宽松，与线上一致）
 */
export function rateInputsAsOf(splicedAsc, stepsAsc, asOfDate, { decisionDate = null, lookbackDays = cfg.RATE_LOOKBACK_DAYS } = {}) {
  const ci = lastIdxLE(splicedAsc, asOfDate);
  const currentRate = ci >= 0 ? splicedAsc[ci].value : null;
  const windowStart = addDaysISO(asOfDate, -lookbackDays);
  const si = lastIdxLE(stepsAsc, asOfDate);
  const lastStep = si >= 0 && stepsAsc[si].date > windowStart ? stepsAsc[si] : null;
  const prevRate = calcDecisionPrevRate({
    currentRate,
    rateSteps: lastStep ? [{ date: lastStep.date, diffBp: lastStep.diffBp }] : [],
    prevDistinct: lastStep ? lastStep.prevValue : null,
    decisionDate,
  });
  return { currentRate, prevRate, lastStep };
}

/**
 * 日度锁状态机——逐位复刻线上 server.js computeLocks 语义（该函数未导出，无法直接 import；
 * 本实现与其"快照差+台阶扫描"逻辑一一对应，触发/解锁判定复用线上 calcLockActive 单一来源）：
 *  - 调整事件：优先取 (上一快照日, 今日] 内幅度最大的台阶；窗口无台阶退回端点差；
 *    首跑（无快照）只看最近一笔台阶
 *  - 锁龄：prevLockActive 时 = 今日 − lockSince（V3 最短锁存期 LOCK_MIN_AGE_DAYS=60 天）
 *  - 锁存起始日演进：新激活→今日；持续→沿用；解除→清空
 * @param {object} prev - 上一交易日快照 {date, rate, sahmLockActive, reactiveLockActive,
 *                        sahmLockSince, reactiveLockSince} | null
 */
export function computeLocksDaily({ today, currentRate, sahmValue, stepsAsc, prev }) {
  const baselineRate = prev?.rate ?? null;
  const endpointDiffBp = currentRate !== null && baselineRate !== null
    ? Math.round((currentRate - baselineRate) * 100)
    : null;
  let stepsSince;
  if (prev?.date) {
    stepsSince = stepsAsc.filter(s => s.date > prev.date && s.date <= today);
  } else {
    const i = lastIdxLE(stepsAsc, today);
    stepsSince = i >= 0 ? [stepsAsc[i]] : [];
  }
  const rateDiffBp = stepsSince.length
    ? stepsSince.reduce((a, b) => (Math.abs(b.diffBp) > Math.abs(a.diffBp) ? b : a)).diffBp
    : endpointDiffBp;

  const ageDays = since => (since ? Math.floor((Date.parse(today) - Date.parse(since)) / 86400000) : null);
  const sahmTrigger = sahmValue !== null && sahmValue !== undefined && sahmValue >= cfg.SAHM_TRIGGER_THRESHOLD;
  const reactiveTrigger = rateDiffBp !== null && Math.abs(rateDiffBp) >= cfg.RATE_REACTIVE_ADJUSTMENT_BP;

  const prevSahm = !!prev?.sahmLockActive;
  const prevReactive = !!prev?.reactiveLockActive;
  const sahmLockActive = calcLockActive({
    triggerToday: sahmTrigger, rateDiffBp, currentRate,
    prevLockActive: prevSahm, lockAgeDays: prevSahm ? ageDays(prev.sahmLockSince) : null,
  });
  const reactiveLockActive = calcLockActive({
    triggerToday: reactiveTrigger, rateDiffBp, currentRate,
    prevLockActive: prevReactive, lockAgeDays: prevReactive ? ageDays(prev.reactiveLockSince) : null,
  });
  const sahmLockSince = sahmLockActive ? (prevSahm ? (prev.sahmLockSince ?? today) : today) : null;
  const reactiveLockSince = reactiveLockActive ? (prevReactive ? (prev.reactiveLockSince ?? today) : today) : null;
  return { rateDiffBp, sahmTrigger, reactiveTrigger, sahmLockActive, reactiveLockActive, sahmLockSince, reactiveLockSince };
}

/** WTI 30天涨跌幅（线上 calcWindowChangePct 同口径）：最新观测 vs 最接近30天前的观测 */
export function oilChange30dAsOf(asc, asOfDate, windowDays = cfg.OIL_SHOCK_WINDOW_DAYS) {
  const li = lastIdxLE(asc, asOfDate);
  if (li < 0) return null;
  const latest = asc[li];
  const bi = lastIdxLE(asc, addDaysISO(latest.date, -windowDays));
  if (bi < 0 || asc[bi].value === 0) return null;
  return (latest.value - asc[bi].value) / asc[bi].value * 100;
}

/** T10Y3M 连续倒挂交易日数（升序逐点累计；线上从最新观测向前数连续<0，等价） */
export function curveRunLengths(asc) {
  const runs = new Array(asc.length);
  let r = 0;
  for (let i = 0; i < asc.length; i++) {
    r = asc[i].value < 0 ? r + 1 : 0;
    runs[i] = r;
  }
  return runs;
}

/**
 * O系油价水平护栏（2026-07-18 评估，默认关）：判定当前WTI是否处于"低位"——
 * 危机后复苏的大涨是"低位反弹"（2009-03/2020-06，EPU仍高位但非战争），
 * 战争/供给冲击推高的是"高位再飙升"（2022-03俄乌）。
 * @param {object} guard - {mode:'median', windowObs} 低于近windowObs个观测的中位数=低位；
 *                        {mode:'drawdown', windowObs, ddPct} 距窗口内最高价回撤仍超ddPct%=低位
 * @returns {boolean|null} null=无观测
 */
export function oilLevelLowAsOf(oilAsc, asOfDate, guard) {
  const li = lastIdxLE(oilAsc, asOfDate);
  if (li < 0) return null;
  const from = Math.max(0, li - guard.windowObs + 1);
  const price = oilAsc[li].value;
  if (guard.mode === 'drawdown') {
    let hi = -Infinity;
    for (let i = from; i <= li; i++) if (oilAsc[i].value > hi) hi = oilAsc[i].value;
    return (price / hi - 1) * 100 <= -guard.ddPct;
  }
  const win = [];
  for (let i = from; i <= li; i++) win.push(oilAsc[i].value);
  win.sort((a, b) => a - b);
  const mid = win.length >> 1;
  const median = win.length % 2 ? win[mid] : (win[mid - 1] + win[mid]) / 2;
  return price < median;
}

// ---------- FRED 拉取（与 run-backtest 共用 fred-cache.json，同 key 格式/同 TTL） ----------

const FRED_CACHE = path.join(__dirname, 'fred-cache.json');
const FRED_CACHE_TTL_MS = 24 * 3600 * 1000;

async function fredSeriesCached(id, apiKey, extra = '') {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(FRED_CACHE, 'utf8')); } catch { /* 空缓存 */ }
  const cacheKey = `${id}|1987-01-01|${extra}`;
  const hit = cache[cacheKey];
  if (hit && Date.now() - hit.at < FRED_CACHE_TTL_MS) return hit.obs;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&observation_start=1987-01-01&api_key=${apiKey}&file_type=json&sort_order=asc&limit=100000${extra}`;
  const res = await axios.get(url, { timeout: 60000 });
  const obs = (res.data.observations || [])
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .filter(o => !isNaN(o.value));
  cache[cacheKey] = { at: Date.now(), obs };
  fs.writeFileSync(FRED_CACHE, JSON.stringify(cache));
  return obs;
}

// ---------- 日度重放主体 ----------

/**
 * 逐交易日重放（交易日=SPY有bar的日子；周末/假日线上cron照跑但无新市场数据，
 * 判定输入不变，档位不会变——唯一例外是30天降档确认恰在非交易日到期，会顺延到下一交易日，
 * 误差≤2个日历日，如实注明）。
 * @returns {Array<record>} 含热身期（1999），调用方按日期过滤
 */
export function runDailyReplay(DD, opts = {}) {
  const { spx, walcl, ratesAsc, stepsAsc, epuDailyAsc, oilAsc, curveAsc, curveRuns,
    mtsVis, pcepiVis, sahmVis, epuTradeVis } = DD;
  const oilGuard = opts.oilGuard ?? { mode: 'median', lookbackObs: 504 }; // O1已上线（2026-07-19采纳）：与线上 calcAdminSignal 的油价水平护栏一致；传 null 可复现采纳前行为

  const startIdx = spx.findIndex(b => b.date >= WARMUP_START);
  if (startIdx < 0) throw new Error('SPX 数据不含热身起点之后的bar');
  const records = [];
  let prevSnap = null; // {date, rate, sahmLockActive, reactiveLockActive, sahmLockSince, reactiveLockSince, final, pendingSince}

  // 单调指针（各序列升序）
  let pMts = -1, pPcepi = -1, pSahm = -1, pEpuT = -1;
  let loSpx = 0, loEpuD = 0, loEpuT = 0;
  const mtsVals = [], pcepiVals = [];

  for (let di = startIdx; di < spx.length && spx[di].date <= REPLAY_END; di++) {
    const bar = spx[di];
    const today = bar.date;

    // -- 货币：利率（100天窗口+决议口径）+ WALCL 最新两条周度观测 --
    const decisionDate = getLastFomcDecisionDate(today); // 2025年前 → null（台阶方向近似）
    const { currentRate, prevRate, lastStep } = rateInputsAsOf(ratesAsc, stepsAsc, today, { decisionDate });
    const { curr: currentBalanceSheet, prev: prevBalanceSheet } = lastTwoWeeklyAsOf(walcl, today);
    const monetary = calcMonetarySignal({ currentRate, prevRate, currentBalanceSheet, prevBalanceSheet });

    // -- 财政：可见月阶梯推进 → 名义TTM同比 − PCEPI TTM通胀 --
    while (pMts + 1 < mtsVis.length && mtsVis[pMts + 1].visibleFrom <= today) mtsVals.push(mtsVis[++pMts].value);
    while (pPcepi + 1 < pcepiVis.length && pcepiVis[pPcepi + 1].visibleFrom <= today) pcepiVals.push(pcepiVis[++pPcepi].value);
    const nominalFiscalPct = ttmChangePct(mtsVals);
    let fiscalInflationPct = null;
    if (pcepiVals.length >= 24) {
      const last24 = pcepiVals.slice(-24);
      const avgCur = last24.slice(12).reduce((a, b) => a + b, 0) / 12;
      const avgPrev = last24.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
      if (avgPrev !== 0) fiscalInflationPct = (avgCur / avgPrev - 1) * 100;
    }
    const fiscalPct = nominalFiscalPct !== null && fiscalInflationPct !== null
      ? nominalFiscalPct - fiscalInflationPct : nominalFiscalPct;
    const fiscal = calcFiscalSignal({ outlaysChangePct: fiscalPct });

    // -- 行政：EPUTRADE(月度,发布阶梯) + USEPUINDXD 7日均线(日频) 双代理 + 油价事件层 --
    const winStart = addDaysISO(today, -cfg.EPU_LOOKBACK_DAYS);
    while (pEpuT + 1 < epuTradeVis.length && epuTradeVis[pEpuT + 1].visibleFrom <= today) pEpuT++;
    while (loEpuT <= pEpuT && epuTradeVis[loEpuT].date <= winStart) loEpuT++;
    let epuTradePercentile = null;
    if (pEpuT >= loEpuT) {
      const win = [];
      for (let i = loEpuT; i <= pEpuT; i++) win.push(epuTradeVis[i].value);
      epuTradePercentile = calcPercentile(epuTradeVis[pEpuT].value, win);
    }
    while (loEpuD < epuDailyAsc.length && epuDailyAsc[loEpuD].date <= winStart) loEpuD++;
    const hiEpuD = lastIdxLE(epuDailyAsc, today);
    let epuDailyPercentile = null;
    if (hiEpuD >= loEpuD) {
      const desc = [];
      for (let i = hiEpuD; i >= loEpuD; i--) desc.push(epuDailyAsc[i]);
      const ma = calcMaSeries(desc, cfg.EPU_DAILY_MA_DAYS);
      if (ma.length) epuDailyPercentile = calcPercentile(ma[ma.length - 1], ma);
    }
    const oilChange30dPct = oilChange30dAsOf(oilAsc, today);
    // O系油价水平护栏（评估开关，默认关）：飙升侧命中且WTI处"低位"→ 该日油价输入置null，
    // 行政维回落到EPU双代理一致判定（暴跌侧不受影响——低位暴跌的宽松判定语义不变）
    let oilForAdmin = oilChange30dPct;
    let oilGuardSuppressed = false;
    if (oilGuard && oilChange30dPct !== null && oilChange30dPct >= cfg.OIL_SHOCK_PCT
      && oilLevelLowAsOf(oilAsc, today, oilGuard) === true) {
      oilForAdmin = null;
      oilGuardSuppressed = true;
    }
    const admin = calcAdminSignal({ epuTradePercentile, epuDailyPercentile, oilChange30dPct: oilForAdmin });

    // -- 萨姆（发布阶梯）与锁（快照差+台阶） --
    while (pSahm + 1 < sahmVis.length && sahmVis[pSahm + 1].visibleFrom <= today) pSahm++;
    const sahmValue = pSahm >= 0 ? sahmVis[pSahm].value : null;
    const locks = computeLocksDaily({ today, currentRate, sahmValue, stepsAsc, prev: prevSnap });

    // -- 趋势门（SPY日线，calcTrendState 线上单一来源；约400天窗口保证10个月末收盘） --
    const trendStart = addDaysISO(today, -400);
    while (loSpx < spx.length && spx[loSpx].date < trendStart) loSpx++;
    const trendState = calcTrendState(spx.slice(loSpx, di + 1));

    // -- 曲线否决（仅attack；AI恒neutral下结构性无操作，仍按线上路径接线） --
    const ci = lastIdxLE(curveAsc, today);
    const invertedDays = ci >= 0 ? curveRuns[ci] : null;

    // -- 最终信号（与 runDailyUpdate 同顺序）：树+曲线否决 → 锁强制 → 趋势再入场 → 降档迟滞 --
    const aiSupply = S.NEUTRAL;
    const tree = applyYieldCurveVeto(calcFinalSignal(aiSupply, monetary, fiscal, admin), invertedDays);
    let raw = (locks.sahmLockActive || locks.reactiveLockActive) ? 'defense' : tree;
    raw = applyTrendReentry(raw, {
      sahmLockActive: locks.sahmLockActive,
      reactiveLockActive: locks.reactiveLockActive,
      spxAboveSma10: trendState.spxAboveSma10,
    });
    const hold = applyDowngradeHold(raw, prevSnap?.final ?? null, prevSnap?.pendingSince ?? null, today);

    const rec = {
      date: today, spx: bar.close,
      monetary, fiscal, admin, aiSupply,
      rawFinal: raw, final: hold.signal, pendingSince: hold.pendingSince,
      sahmLockActive: locks.sahmLockActive, reactiveLockActive: locks.reactiveLockActive,
      sahmLockSince: locks.sahmLockSince, reactiveLockSince: locks.reactiveLockSince,
      metrics: {
        rate: currentRate, rateDiffBp: locks.rateDiffBp, lastStepDate: lastStep?.date ?? null,
        fiscalPct, epuTradePct: epuTradePercentile, epuDailyPct: epuDailyPercentile,
        oilPct: oilChange30dPct, oilGuardSuppressed, sahm: sahmValue,
        spxAboveSma10: trendState.spxAboveSma10, invertedDays,
      },
    };
    records.push(rec);
    prevSnap = {
      date: today, rate: currentRate,
      sahmLockActive: locks.sahmLockActive, reactiveLockActive: locks.reactiveLockActive,
      sahmLockSince: locks.sahmLockSince, reactiveLockSince: locks.reactiveLockSince,
      final: hold.signal, pendingSince: hold.pendingSince,
    };
  }
  return records;
}

// ---------- 评估 ----------

/** 日度净值模拟：曝险由上一交易日档位决定；defense→现金（目标利率/252 单日计息） */
export function simulateNavDailyRecs(recs, { reduceWeight = 1, buyHold = false, signalKey = 'final' } = {}) {
  if (recs.length < 2) return null;
  let nav = 1, peak = 1, mdd = 0, trades = 0;
  let prevExposed = null;
  for (let i = 1; i < recs.length; i++) {
    const ret = recs[i].spx / recs[i - 1].spx;
    const cash = 1 + ((recs[i - 1].metrics.rate ?? 0) / 100) / 252;
    const f = recs[i - 1][signalKey];
    const w = buyHold ? 1 : f === 'defense' ? 0 : f === 'reduce' ? reduceWeight : 1;
    nav *= w * ret + (1 - w) * cash;
    if (prevExposed !== null && w !== prevExposed) trades++;
    prevExposed = w;
    peak = Math.max(peak, nav);
    mdd = Math.min(mdd, nav / peak - 1);
  }
  const years = dayDiff(recs[0].date, recs[recs.length - 1].date) / 365.25;
  return { totalPct: (nav - 1) * 100, cagrPct: (Math.pow(nav, 1 / years) - 1) * 100, mddPct: mdd * 100, years, trades };
}

/** 连续 defense 片段（生效档） */
export function defenseEpisodesDaily(recs, signalKey = 'final') {
  const eps = [];
  let start = null;
  for (let i = 0; i < recs.length; i++) {
    const isDef = recs[i][signalKey] === 'defense';
    if (isDef && start === null) start = i;
    if (!isDef && start !== null) { eps.push({ startIdx: start, endIdx: i - 1 }); start = null; }
  }
  if (start !== null) eps.push({ startIdx: start, endIdx: recs.length - 1 });
  return eps.map(e => ({
    ...e, start: recs[e.startIdx].date, end: recs[e.endIdx].date, days: e.endIdx - e.startIdx + 1,
  }));
}

/** 假阳性判定（月度口径的日度版）：片段起点后365个日历日内最低收盘回撤 ≤ −15% 才算真阳性 */
export function episodeIsFalsePositive(ep, spxAsc) {
  const startPx = spxAsc[lastIdxLE(spxAsc, ep.start)]?.close;
  if (!startPx) return null;
  const horizon = addDaysISO(ep.start, 365);
  let minPx = Infinity;
  for (let i = lastIdxLE(spxAsc, ep.start); i < spxAsc.length && spxAsc[i].date <= horizon; i++) {
    if (spxAsc[i].close < minPx) minPx = spxAsc[i].close;
  }
  if (minPx === Infinity) return null;
  return (minPx / startPx - 1) * 100 > -15;
}

/** 某维度在 idx 日为 tight 时，向前回溯连续 tight 的起始日 */
function dimTightSince(recs, idx, key) {
  let i = idx;
  while (i > 0 && recs[i - 1][key] === 'tight') i--;
  return recs[i].date;
}

/** 危机路径统计（日度版 crisisPathStats）：首防日→底部日逐日复利 */
function crisisPathStatsDaily(recs, startDate, endDate) {
  const i0 = recs.findIndex(r => r.date >= startDate);
  const i1 = lastIdxLE(recs, endDate);
  if (i0 < 0 || i1 <= i0) return null;
  let navS = 1, navB = 1, defDays = 0;
  for (let i = i0 + 1; i <= i1; i++) {
    const ret = recs[i].spx / recs[i - 1].spx;
    navB *= ret;
    if (recs[i - 1].final === 'defense') {
      defDays++;
      navS *= 1 + ((recs[i - 1].metrics.rate ?? 0) / 100) / 252;
    } else navS *= ret;
  }
  return {
    savedPct: (navS - navB) * 100,
    coveragePct: (defDays / (i1 - i0)) * 100,
  };
}

const CRISES = [ // 与 run-backtest.js CRISES 同表（未导出，数据常量按值同步）
  { name: '2000 互联网泡沫', searchStart: '1999-06-01', searchEnd: '2003-03-31', peakWindow: ['1999-06-01', '2000-12-31'] },
  { name: '2008 金融危机', searchStart: '2007-01-01', searchEnd: '2009-06-30', peakWindow: ['2007-01-01', '2008-03-31'] },
  { name: '2020 新冠崩盘', searchStart: '2019-06-01', searchEnd: '2020-09-30', peakWindow: ['2019-06-01', '2020-03-01'] },
  { name: '2022 加息熊市', searchStart: '2021-06-01', searchEnd: '2023-01-31', peakWindow: ['2021-06-01', '2022-02-28'] },
  { name: '2025 关税战', searchStart: '2024-12-01', searchEnd: '2025-12-31', peakWindow: ['2024-12-01', '2025-03-31'] },
  { name: '2026 美伊战争', searchStart: '2025-11-01', searchEnd: '2026-07-31', peakWindow: ['2025-11-01', '2026-02-28'] },
];

/** 首防日触发者归因：锁（含触发事件）优先，其次列出各 tight 维度及其连续收紧起始日 */
function attributeTrigger(recs, idx) {
  const r = recs[idx];
  const parts = [];
  if (r.reactiveLockActive && r.reactiveLockSince === r.date) {
    parts.push(`应对式锁(台阶${r.metrics.rateDiffBp > 0 ? '+' : ''}${r.metrics.rateDiffBp}bp@${r.metrics.lastStepDate})`);
  } else if (r.reactiveLockActive) parts.push(`应对式锁(自${r.reactiveLockSince})`);
  if (r.sahmLockActive && r.sahmLockSince === r.date) parts.push(`萨姆锁(值${r.metrics.sahm})`);
  else if (r.sahmLockActive) parts.push(`萨姆锁(自${r.sahmLockSince})`);
  for (const [key, label] of [['monetary', '货币'], ['fiscal', '财政'], ['admin', '行政']]) {
    if (r[key] === 'tight') parts.push(`${label}tight(自${dimTightSince(recs, idx, key)})`);
  }
  if (r.admin === 'tight' && r.metrics.oilPct !== null && r.metrics.oilPct >= cfg.OIL_SHOCK_PCT) {
    parts.push(`油价+${r.metrics.oilPct.toFixed(1)}%/30天`);
  }
  return parts.join(' + ') || '（无收紧维度？）';
}

function crisisRowsDaily(recs, spxBars) {
  const eps = defenseEpisodesDaily(recs);
  return CRISES.map(c => {
    const { peak } = findPeakTrough(spxBars, ...c.peakWindow);
    if (!peak) return { name: c.name, error: '数据缺失' };
    const { trough } = findPeakTrough(spxBars, peak.date, c.searchEnd);
    const idx = recs.findIndex(r => r.date >= c.searchStart && r.date <= c.searchEnd && r.final === 'defense');
    const firstDef = idx >= 0 ? recs[idx] : null;
    const leadDays = firstDef ? dayDiff(firstDef.date, peak.date) : null;
    const { missedPct, missedKind } = firstDef
      ? calcMissedPct(firstDef.spx, peak.close, leadDays) : { missedPct: null, missedKind: null };
    const path = firstDef ? crisisPathStatsDaily(recs, firstDef.date, trough.date) : null;
    const after = firstDef ? recs.slice(idx + 1).find(r => r.final !== 'defense') : null;
    // 首防日所在片段若始于搜索窗之前（如2025：2024-09锁的遗留），如实标注 + 给出窗内新起片段
    const containing = firstDef ? eps.find(e => e.start <= firstDef.date && firstDef.date <= e.end) : null;
    const legacyEpisodeStart = containing && containing.start < c.searchStart ? containing.start : null;
    const freshEpisode = legacyEpisodeStart
      ? eps.find(e => e.start >= c.searchStart && e.start <= c.searchEnd) ?? null : null;
    return {
      name: c.name, peakDate: peak.date, troughDate: trough.date,
      drawdownPct: (trough.close / peak.close - 1) * 100,
      firstDefDate: firstDef?.date ?? null, leadDays, missedPct, missedKind,
      savedPct: path?.savedPct ?? null, coveragePct: path?.coveragePct ?? null,
      recoverDate: after?.date ?? null,
      trigger: firstDef ? attributeTrigger(recs, idx) : '未触发',
      legacyEpisodeStart,
      freshDefDate: freshEpisode?.start ?? null,
      freshLeadDays: freshEpisode ? dayDiff(freshEpisode.start, peak.date) : null,
    };
  });
}

// ---------- 数据加载 ----------

export async function loadDailyData() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED_API_KEY not set');
  const D = await loadData(); // 月度回放数据包（SPX日线/WALCL/月度序列/RateM 等，含缓存）
  console.log('[daily-replay] fetching daily FRED series (USEPUINDXD/T10Y3M/DCOILWTICO/DFEDTAR/DFEDTARU)...');
  const [dfedtar, dfedtaru, epuDailyAsc, oilAsc, curveAsc] = await Promise.all([
    fredSeriesCached('DFEDTAR', apiKey),
    fredSeriesCached('DFEDTARU', apiKey),
    fredSeriesCached('USEPUINDXD', apiKey),
    fredSeriesCached('DCOILWTICO', apiKey),
    fredSeriesCached('T10Y3M', apiKey),
  ]);
  const ratesAsc = spliceRateSeries(
    dfedtar.map(o => ({ ...o, value: String(o.value) })),
    dfedtaru.map(o => ({ ...o, value: String(o.value) })),
  );
  const sahmM = [...D.sahmMap.entries()].map(([month, value]) => ({ month, value }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
  return {
    D,
    DD: {
      spx: D.spx, walcl: D.walcl,
      ratesAsc, stepsAsc: calcRateStepsAsc(ratesAsc),
      epuDailyAsc, oilAsc, curveAsc, curveRuns: curveRunLengths(curveAsc),
      mtsVis: buildVisibleSeries(D.fiscalM, mtsVisibleFrom),
      pcepiVis: buildVisibleSeries(D.pcepiM, pcepiVisibleFrom),
      sahmVis: buildVisibleSeries(sahmM, sahmVisibleFrom),
      epuTradeVis: buildVisibleSeries(D.epuM, epuTradeVisibleFrom),
    },
  };
}

// ---------- 报告 ----------

const fmtLead = r => r.leadDays === null ? '未触发'
  : r.leadDays > 0 ? `提前${r.leadDays}天` : `滞后${-r.leadDays}天`;
const f1 = v => v === null || v === undefined ? '—' : v.toFixed(1);

function flipDiagnostics(recs) {
  const changes = [];
  for (let i = 1; i < recs.length; i++) {
    if (recs[i].final !== recs[i - 1].final) changes.push({ i, date: recs[i].date, from: recs[i - 1].final, to: recs[i].final });
  }
  // A→B→A 折返（7个交易日内回到原档）
  const roundTrips = [];
  for (let k = 0; k < changes.length - 1; k++) {
    const a = changes[k], b = changes[k + 1];
    if (b.to === a.from && b.i - a.i <= 7) roundTrips.push({ from: a.from, to: a.to, date1: a.date, date2: b.date, span: b.i - a.i });
  }
  const defReduceRT = roundTrips.filter(rt =>
    (rt.from === 'defense' && rt.to === 'reduce') || (rt.from === 'reduce' && rt.to === 'defense'));
  // 迟滞行为：raw≠final 天数；pending 结局（确认降档 vs 被升档吸收）
  let holdDays = 0, confirmed = 0, absorbed = 0;
  const sev = s => ({ defense: 3, reduce: 2, neutral: 1, attack: 0 })[s] ?? 1;
  for (let i = 1; i < recs.length; i++) {
    if (recs[i].rawFinal !== recs[i].final) holdDays++;
    if (recs[i - 1].pendingSince && !recs[i].pendingSince) {
      if (sev(recs[i].final) < sev(recs[i - 1].final)) confirmed++;
      else absorbed++;
    }
  }
  // raw（无迟滞）下的折返对照
  const rawChanges = [];
  for (let i = 1; i < recs.length; i++) {
    if (recs[i].rawFinal !== recs[i - 1].rawFinal) rawChanges.push({ i, from: recs[i - 1].rawFinal, to: recs[i].rawFinal });
  }
  let rawRoundTrips = 0;
  for (let k = 0; k < rawChanges.length - 1; k++) {
    if (rawChanges[k + 1].to === rawChanges[k].from && rawChanges[k + 1].i - rawChanges[k].i <= 7) rawRoundTrips++;
  }
  return { changes, roundTrips, defReduceRT, holdDays, confirmed, absorbed, rawChangesCount: rawChanges.length, rawRoundTrips };
}

// ---------- O系评估（--eval-oil）：油价飙升护栏加"油价水平"条件 ----------
// 背景（本脚本基线运行发现）：最大单项损耗 2009-03-12~05-01（油价+25%且日频EPU 94分位被
// 误判战争冲击→行政tight→防守踏空V型底，-17.5pp），根因是"EPU平静=复苏"假设在危机刚过不成立。
// 硬约束：六危机时点不得变差（2022-03-23俄乌触发必须保住）、日度年化≥11.3%

/** 区间内策略收益%（defense吃现金）——O系目标段挽回计算用 */
function windowStratRet(recs, a, b) {
  let nav = 1;
  for (let i = 1; i < recs.length; i++) {
    if (recs[i - 1].date < a || recs[i - 1].date > b) continue;
    const ret = recs[i].spx / recs[i - 1].spx;
    const cash = 1 + ((recs[i - 1].metrics.rate ?? 0) / 100) / 252;
    nav *= recs[i - 1].final === 'defense' ? cash : ret;
  }
  return (nav - 1) * 100;
}

/** 连续被抑制日压缩为区间串 */
function suppressedSpans(recs) {
  const spans = [];
  let cur = null;
  for (const r of recs) {
    if (r.metrics.oilGuardSuppressed) {
      if (!cur) cur = { start: r.date, end: r.date, n: 0 };
      cur.end = r.date; cur.n++;
    } else if (cur) { spans.push(cur); cur = null; }
  }
  if (cur) spans.push(cur);
  return spans;
}

async function runEvalOil(D, DD) {
  const spxBars = D.spx.filter(b => b.date <= REPLAY_END);
  const DEFS = [
    ['基线(护栏关)', null],
    ['O1 低于2年中位(504obs)', { mode: 'median', windowObs: 504 }],
    ['O2a 1年中位(252)', { mode: 'median', windowObs: 252 }],
    ['O2b 3年中位(756)', { mode: 'median', windowObs: 756 }],
    ['O3 距2年高点回撤>40%', { mode: 'drawdown', windowObs: 504, ddPct: 40 }],
  ];
  const SEGS = [['2009-03-01', '2009-06-30', '2009复苏段'], ['2020-05-01', '2020-06-30', '2020-06段']];
  let base = null;
  const rows = [];
  const details = new Map();
  for (const [name, guard] of DEFS) {
    const recs = runDailyReplay(DD, { oilGuard: guard }).filter(r => r.date >= REPLAY_START && r.date <= REPLAY_END);
    const sim = simulateNavDailyRecs(recs);
    const eps = defenseEpisodesDaily(recs);
    const fp = eps.map(e => episodeIsFalsePositive(e, spxBars)).filter(v => v === true).length;
    const cr = crisisRowsDaily(recs, spxBars);
    if (!base) base = { recs, cr, sim };
    const segRet = SEGS.map(([a, b]) => windowStratRet(recs, a, b));
    const baseSegRet = SEGS.map(([a, b]) => windowStratRet(base.recs, a, b));
    // 硬约束：每场危机 leadDays 不得比基线差（未触发→触发算改善；触发→未触发算变差）
    let timingOk = true;
    const timingChanges = [];
    cr.forEach((r, i) => {
      const b = base.cr[i];
      if (b.firstDefDate && !r.firstDefDate) { timingOk = false; timingChanges.push(`${r.name}丢失`); }
      else if (b.leadDays != null && r.leadDays != null && r.leadDays < b.leadDays) {
        timingOk = false; timingChanges.push(`${r.name} ${b.leadDays}→${r.leadDays}天`);
      } else if (b.firstDefDate !== r.firstDefDate) timingChanges.push(`${r.name} ${b.firstDefDate}→${r.firstDefDate}`);
    });
    const c22 = cr.find(r => r.name.startsWith('2022'));
    const ukraineKept = c22?.firstDefDate === base.cr.find(r => r.name.startsWith('2022'))?.firstDefDate;
    const pass = timingOk && ukraineKept && sim.cagrPct >= 11.3;
    rows.push({
      组合: name, 年化: sim.cagrPct.toFixed(2) + '%', 回撤: sim.mddPct.toFixed(1) + '%',
      假阳性: `${fp}/${eps.length}`,
      防守占比: (recs.filter(r => r.final === 'defense').length / recs.length * 100).toFixed(1) + '%',
      抑制天数: recs.filter(r => r.metrics.oilGuardSuppressed).length,
      '2009段挽回pp': (segRet[0] - baseSegRet[0]).toFixed(1),
      '2020-06段挽回pp': (segRet[1] - baseSegRet[1]).toFixed(1),
      '2022首防': c22?.firstDefDate ?? '未触发',
      危机时点变化: timingChanges.join('; ') || '无',
      硬约束: pass ? '过' : '✗',
    });
    details.set(name, { recs, cr, eps, sim });
  }
  console.log('\n═════ O系油价水平护栏（日度重放；硬约束=六危机时点不变差·2022-03-23保住·年化≥11.3%）═════');
  console.table(rows);

  // O1 明细：抑制区间 + 危机表全对照 + 片段对照
  const o1 = details.get('O1 低于2年中位(504obs)');
  console.log('\n----- O1 被抑制的油价飙升日（低位反弹判定生效区间） -----');
  for (const s of suppressedSpans(o1.recs)) console.log(`  ${s.start} ~ ${s.end}（${s.n}个交易日）`);
  console.log('\n----- O1 危机表全对照（vs 基线） -----');
  console.table(o1.cr.map((r, i) => ({
    危机: r.name, '基线首防': base.cr[i].firstDefDate ?? '未触发', 'O1首防': r.firstDefDate ?? '未触发',
    '基线时点': fmtLead(base.cr[i]), 'O1时点': fmtLead(r),
    '基线少亏pp': f1(base.cr[i].savedPct), 'O1少亏pp': f1(r.savedPct),
    '基线覆盖%': f1(base.cr[i].coveragePct), 'O1覆盖%': f1(r.coveragePct),
  })));
  console.log('----- O1 防守片段（vs 基线12段） -----');
  o1.eps.forEach(e => {
    const fp = episodeIsFalsePositive(e, spxBars);
    console.log(`  ${e.start} ~ ${e.end}（${e.days}天）${fp === true ? '【假阳性】' : fp === false ? '【真危机】' : '【无法判定】'}`);
  });

  // 月度口径同款开关（结构性冗余的实证：飙升tight要求epuHigh，抑制后百分位回落仍tight）
  console.log('\n----- 月度回放同款开关（runReplay + oilLevelGuard） -----');
  const tlBase = runReplay(D, VARIANTS_DEFAULT).filter(t => t.month <= '2026-06');
  const tlO1 = runReplay(D, { ...VARIANTS_DEFAULT, oilLevelGuard: true }).filter(t => t.month <= '2026-06');
  const diffM = tlBase.filter((t, i) => t.final !== tlO1[i].final || t.admin !== tlO1[i].admin).map(t => t.month);
  const sB = evaluate(D, tlBase), sO = evaluate(D, tlO1);
  console.log(`月度基线 年化${sB.overall.stratCagr.toFixed(2)}% 回撤${sB.overall.stratMdd.toFixed(1)}% 假阳性${sB.falsePositives}/${sB.episodes} | ` +
    `月度O1 年化${sO.overall.stratCagr.toFixed(2)}% 回撤${sO.overall.stratMdd.toFixed(1)}% 假阳性${sO.falsePositives}/${sO.episodes}`);
  console.log(diffM.length
    ? `逐月diff（admin或final变化）：${diffM.join(' ')}`
    : '逐月diff：无——证实月度单代理口径下飙升tight分支结构性冗余（epuHigh前提下抑制后百分位回落仍tight），月度不劣化自动满足');
}

async function main() {
  const t0 = Date.now();
  const { D, DD } = await loadDailyData();
  if (process.argv.includes('--eval-oil')) return runEvalOil(D, DD);

  console.log('[daily-replay] running daily replay...');
  const all = runDailyReplay(DD);
  const recs = all.filter(r => r.date >= REPLAY_START && r.date <= REPLAY_END);
  const spxBars = D.spx.filter(b => b.date <= REPLAY_END);

  console.log('[daily-replay] running monthly replay for comparison...');
  const tlM = runReplay(D, VARIANTS_DEFAULT);
  const tlMClip = tlM.filter(t => t.month <= '2026-06');
  const sM = evaluate(D, tlMClip);

  // ===== 1. 六场危机日级时点 vs 月度 =====
  const daily = crisisRowsDaily(recs, spxBars);
  console.log('\n═════ 六场危机：日度重放 vs 月度重放 ═════');
  console.table(daily.map(r => {
    const m = sM.crisisRows.find(x => x.name === r.name);
    return {
      危机: r.name, 顶部: r.peakDate,
      '日度首防': r.firstDefDate ?? '未触发', '日度时点': fmtLead(r),
      '月度首防月': m?.firstDefMonth ?? '未触发',
      '月度时点': m?.leadDays == null ? '—' : (m.leadDays > 0 ? `提前${m.leadDays}天` : `滞后${-m.leadDays}天`),
      '日−月差(天)': r.leadDays != null && m?.leadDays != null ? r.leadDays - m.leadDays : '—',
      '日度少亏pp': f1(r.savedPct), '月度少亏pp': f1(m?.savedPct),
      '日度覆盖%': f1(r.coveragePct), '月度覆盖%': f1(m?.coveragePct),
    };
  }));
  console.log('\n----- 首防日触发者归因（日频输入谁先动） -----');
  for (const r of daily) {
    console.log(`${r.name}: ${r.firstDefDate ?? '未触发'}${r.firstDefDate ? ` ← ${r.trigger}` : ''}${r.recoverDate ? `（恢复非防守 ${r.recoverDate}）` : ''}`);
    if (r.legacyEpisodeStart) {
      console.log(`  ⚠ 该首防日属于始于搜索窗之前的遗留防守片段（${r.legacyEpisodeStart} 起）；` +
        `本次危机内新起的防守片段：${r.freshDefDate ?? '无'}${r.freshLeadDays != null ? `（${r.freshLeadDays > 0 ? '提前' + r.freshLeadDays : '滞后' + -r.freshLeadDays}天）` : ''}`);
    }
  }

  // ===== 2. 整体指标对照 =====
  const simD = simulateNavDailyRecs(recs);
  const simDHalf = simulateNavDailyRecs(recs, { reduceWeight: 0.5 });
  const simDBH = simulateNavDailyRecs(recs, { buyHold: true });
  const simDRaw = simulateNavDailyRecs(recs, { signalKey: 'rawFinal' });
  const defDays = recs.filter(r => r.final === 'defense').length;
  const reduceDays = recs.filter(r => r.final === 'reduce').length;
  const epsD = defenseEpisodesDaily(recs);
  const fpVerdicts = epsD.map(e => episodeIsFalsePositive(e, spxBars));
  const fpCount = fpVerdicts.filter(v => v === true).length;
  const mTotal = sM.defMonths + sM.reduceMonths + sM.nonDefMonths;
  console.log('\n═════ 整体指标：日度 vs 月度 ═════');
  console.table([
    {
      口径: '日度重放(线上路径)', 年化: simD.cagrPct.toFixed(2) + '%', 最大回撤: simD.mddPct.toFixed(1) + '%',
      买入持有年化: simDBH.cagrPct.toFixed(2) + '%',
      防守占比: (defDays / recs.length * 100).toFixed(1) + '%', 减仓占比: (reduceDays / recs.length * 100).toFixed(1) + '%',
      'reduce=50%仓年化': simDHalf.cagrPct.toFixed(2) + '%',
      防守片段: epsD.length, 假阳性: `${fpCount}/${epsD.length}`, 调仓次数: simD.trades,
    },
    {
      口径: '月度重放(现成绩单)', 年化: sM.overall.stratCagr.toFixed(2) + '%', 最大回撤: sM.overall.stratMdd.toFixed(1) + '%',
      买入持有年化: sM.overall.buyHoldCagr.toFixed(2) + '%',
      防守占比: (sM.defMonths / mTotal * 100).toFixed(1) + '%', 减仓占比: (sM.reduceMonths / mTotal * 100).toFixed(1) + '%',
      'reduce=50%仓年化': sM.overall.reduceHalfCagr.toFixed(2) + '%',
      防守片段: sM.episodes, 假阳性: `${sM.falsePositives}/${sM.episodes}`, 调仓次数: '—(月度)',
    },
  ]);
  console.log('防守片段明细（日度）：');
  epsD.forEach((e, i) => {
    const fp = fpVerdicts[i];
    console.log(`  ${e.start} ~ ${e.end}（${e.days}个交易日）${fp === true ? '【假阳性】' : fp === false ? '【真危机】' : '【无法判定】'}`);
  });

  // ===== 3. 日内翻转诊断 =====
  const fd = flipDiagnostics(recs);
  console.log('\n═════ 翻转诊断（月度采样看不见的高频行为） ═════');
  console.log(`生效档变更 ${fd.changes.length} 次（26.5年，月度重放为 ${(() => { let c = 0; for (let i = 1; i < tlMClip.length; i++) if (tlMClip[i].final !== tlMClip[i - 1].final) c++; return c; })()} 次）`);
  console.log(`7交易日内 A→B→A 折返 ${fd.roundTrips.length} 次，其中 defense↔reduce ${fd.defReduceRT.length} 次`);
  if (fd.roundTrips.length) {
    for (const rt of fd.roundTrips) console.log(`  ${rt.date1} ${rt.from}→${rt.to} → ${rt.date2} 回到${rt.from}（${rt.span}个交易日）`);
  }
  console.log(`30天降档确认期：扛住候选降档 ${fd.holdDays} 个交易日；降档确认生效 ${fd.confirmed} 次、被升档吸收（拦下折返）${fd.absorbed} 次`);
  console.log(`若无迟滞（raw档）：变更 ${fd.rawChangesCount} 次、7日内折返 ${fd.rawRoundTrips} 次 → 迟滞把折返压掉 ${fd.rawRoundTrips - fd.roundTrips.length} 次`);
  console.log(`raw档直接执行的年化 ${simDRaw.cagrPct.toFixed(2)}%/调仓${simDRaw.trades}次 vs 生效档 ${simD.cagrPct.toFixed(2)}%/调仓${simD.trades}次（迟滞的收益/换手代价）`);

  // 曲线否决实际参与度（诚实披露：AI恒neutral → attack不可达 → 否决必然0次）
  const vetoDays = recs.filter(r => r.metrics.invertedDays !== null && r.metrics.invertedDays >= cfg.YIELD_CURVE_INVERSION_CONFIRM_DAYS).length;
  console.log(`\nT10Y3M 曲线否决：确认期内共 ${vetoDays} 个交易日，但 AI维恒neutral→attack不可达→实际否决 0 次（结构性无操作，如实报告）`);

  fs.writeFileSync(path.join(__dirname, 'daily-replay-raw.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), replayRange: [REPLAY_START, REPLAY_END],
    crisisDaily: daily, monthlyCrisis: sM.crisisRows,
    overall: { daily: { ...simD, defDays, reduceDays, totalDays: recs.length, episodes: epsD.length, falsePositives: fpCount }, monthly: sM.overall },
    flips: { changes: fd.changes.length, roundTrips: fd.roundTrips, holdDays: fd.holdDays, confirmed: fd.confirmed, absorbed: fd.absorbed },
    episodes: epsD.map((e, i) => ({ ...e, falsePositive: fpVerdicts[i] })),
    timeline: recs,
  }, null, 1));
  console.log(`\n[daily-replay] done in ${((Date.now() - t0) / 1000).toFixed(1)}s → backtest/daily-replay-raw.json（${recs.length} 个交易日）`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(err => { console.error('[daily-replay] failed:', err); process.exit(1); });
}
