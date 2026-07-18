// TQQQ/SQQQ/TQQQ期权 执行层方案评估（2026-07-18 用户四方案）：
// 在既有信号时间线（V3+V4+W5 基线，runReplay 重放拿逐月档位）上评估用户提出的
// 方案1/2（TQQQ+SQQQ 现货，"如已买入则本次不执行"=不补仓不再平衡）、
// 方案1A/2A（修正映射：attack∪neutral 视为 TQQQ 持有期——attack 档历史 0 次，字面版将永远空仓）、
// 方案3/4（TQQQ LEAPS Call + 短期 Put，粗粒度 BS 建模，无真实历史期权数据）。
// 合成标的（日度，诚实口径）：
//   TQQQ代理 = 3×QQQ日收益 − 2×FFR_d − ER_d（ER 0.86%/年）；
//   SQQQ代理 = −3×QQQ日收益 + 4×FFR_d − ER_d（ER 0.95%/年，做空所得现金计息）。
// 运行：node backend/backtest/tqqq-schemes.mjs（repo 根或 backend 目录均可）
// 只读复用 run-backtest.js / execution-layer.mjs 的导出，不修改线上代码与既有脚本默认行为。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import { loadData, runReplay, VARIANTS_DEFAULT } from './run-backtest.js';
import { synthLeveragedDaily, monthlyCloseMap } from './execution-layer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

// ---------- 纯函数（backend/tests/tqqq-schemes.test.js 覆盖） ----------

/**
 * 自定义系数的日度杠杆合成：nav ×= 1 + beta×r + ffrMult×FFR_d − ER_d
 * TQQQ代理: beta=3, ffrMult=−2（借入2倍名义付息）；SQQQ代理: beta=−3, ffrMult=+4（3倍空头所得+1倍本金计息）
 * @param {Array<{date, close:number}>} bars - 升序日线（adjClose 总回报口径）
 * @param {(date:string)=>number} rateOfDate - 该日适用联邦基金利率（年化%）
 */
export function synthDailyCustom(bars, rateOfDate, { beta, ffrMult, erPct, tradingDays = 252 } = {}) {
  const out = [];
  let nav = 1;
  for (let i = 0; i < bars.length; i++) {
    if (i > 0 && nav > 0) {
      const r = bars[i].close / bars[i - 1].close - 1;
      const ffrD = ((rateOfDate(bars[i].date) ?? 0) / 100) / tradingDays;
      nav *= 1 + beta * r + ffrMult * ffrD - (erPct / 100) / tradingDays;
      if (nav < 0) nav = 0; // 单日亏穿理论爆仓保护（3x 需单日∓33%）
    }
    out.push({ date: bars[i].date, close: nav });
  }
  return out;
}

/** 标准正态CDF（Abramowitz-Stegun 7.1.26，误差<7.5e-8） */
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Black-Scholes 欧式期权定价（无股息）。T≤0 → 内在价值；sigma≤0 → 贴现内在价值下界。
 * @param {number} T - 剩余年限；@param {number} r - 无风险利率（小数）；@param {number} sigma - 年化波动率（小数）
 */
export function bsPrice(S, K, T, r, sigma, type) {
  if (T <= 0) return Math.max(type === 'call' ? S - K : K - S, 0);
  if (sigma <= 0) {
    const disc = K * Math.exp(-r * T);
    return Math.max(type === 'call' ? S - disc : disc - S, 0);
  }
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return type === 'call'
    ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
    : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

/**
 * 滚动252日实现波动率（年化，日对数收益std×√252），按月末采样 → Map('YYYY-MM'→vol小数)
 * 观测不足 window 时用可得全部（≥minObs），再少 → 该月缺失
 */
export function rollingVolByMonth(bars, { window = 252, minObs = 60 } = {}) {
  const rets = [];
  for (let i = 1; i < bars.length; i++) {
    rets.push({ date: bars[i].date, r: Math.log(bars[i].close / bars[i - 1].close) });
  }
  const out = new Map(); // 升序遍历，后者覆盖 → 留月末
  for (let i = 0; i < rets.length; i++) {
    if (i + 1 < minObs) continue;
    const win = rets.slice(Math.max(0, i + 1 - window), i + 1).map(o => o.r);
    const mean = win.reduce((a, b) => a + b, 0) / win.length;
    const varc = win.reduce((a, b) => a + (b - mean) ** 2, 0) / (win.length - 1);
    out.set(rets[i].date.slice(0, 7), Math.sqrt(varc) * Math.sqrt(252));
  }
  return out;
}

/**
 * 月度净值路径 → 统计：全期/年度/回撤/最低净值比（归零风险=minNavRatio<0.2）
 * points 首点为基期；子样本统计由调用方切片（statsFromNav 自动以首点重定基）
 */
export function statsFromNav(points) {
  if (!points || points.length < 2) return null;
  const base = points[0].nav;
  if (!(base > 0)) return null;
  let peak = base, mdd = 0, min = base;
  const yearFactors = new Map(), yearMonths = new Map();
  for (let i = 1; i < points.length; i++) {
    const nav = points[i].nav;
    peak = Math.max(peak, nav);
    min = Math.min(min, nav);
    if (peak > 0) mdd = Math.min(mdd, nav / peak - 1);
    const prev = points[i - 1].nav;
    const r = prev > 0 ? nav / prev - 1 : 0;
    const y = points[i].month.slice(0, 4);
    yearFactors.set(y, (yearFactors.get(y) ?? 1) * (1 + r));
    yearMonths.set(y, (yearMonths.get(y) ?? 0) + 1);
  }
  const years = (points.length - 1) / 12;
  const end = points[points.length - 1].nav;
  return {
    totalPct: (end / base - 1) * 100,
    cagrPct: end > 0 ? (Math.pow(end / base, 1 / years) - 1) * 100 : -100,
    mddPct: mdd * 100,
    years,
    minNavRatio: min / base,
    yearly: new Map([...yearFactors].map(([y, f]) => [y, (f - 1) * 100])),
    yearMonths,
  };
}

/**
 * 权重口径的月度净值路径（E0/E3 对照行用，与 execution-layer.simulateExecution 同口径但返回逐月路径）
 */
export function navPathFromWeights(months, weightsOf, assetRet, rateMap) {
  const points = [{ month: months[0].month, nav: 1 }];
  let nav = 1;
  for (let i = 1; i < months.length; i++) {
    const w = weightsOf(months[i - 1].final);
    let ret = 0;
    for (const [asset, weight] of Object.entries(w)) {
      if (!weight) continue;
      const r = asset === 'cash'
        ? ((rateMap.get(months[i - 1].month) ?? 0) / 100) / 12
        : assetRet(asset, months[i - 1].month, months[i].month);
      if (r === null || r === undefined || isNaN(r)) throw new Error(`资产 ${asset} 缺 ${months[i - 1].month}→${months[i].month} 月收益`);
      ret += weight * r;
    }
    nav *= 1 + ret;
    points.push({ month: months[i].month, nav });
  }
  return points;
}

/**
 * TQQQ/SQQQ 现货方案状态机（月末按当月档位调仓；"如已买入则本次不执行"=不补仓不再平衡，仓位随市值漂移）：
 *  - tqqqTiers: 允许持有 TQQQ 的档位集合。买入触发=当前无持仓时买至 tqqqTargetPct×组合净值（现金封顶）；
 *    字面 attack 语义（attackRebalance）：attack 月先清 SQQQ，TQQQ 再平衡到目标（唯一的再平衡例外，按用户原文"调整到85%"）
 *  - reduceSellsHalf: 进入 reduce 档时一次性卖出 50% TQQQ（连续 reduce 月不重复减半，与"已执行则本次不执行"口径一致）
 *  - defenseClearsTqqq: defense 档清仓 TQQQ
 *  - sqqqLeg: 'drift'=无持仓时买至5%后随市值漂移（字面口径）；'rebalance'=每月末重平到5%（常备保险口径）；'none'=无SQQQ腿
 *  现金（含10%备用金）按上月联邦基金利率月化计息；ETF交易未计摩擦（见脚本尾局限声明）
 * @returns {{points:Array<{month,nav}>, tqqqMonths:number, sqqqMonths:number}}
 */
export function simulateEtfScheme(months, px, rateMap, {
  tqqqTiers = ['attack'],
  attackRebalance = false,
  reduceSellsHalf = false,
  defenseClearsTqqq = false,
  sqqqLeg = 'drift',
  tqqqTargetPct = 0.85,
  sqqqTargetPct = 0.05,
} = {}) {
  let cash = 1, tqqqU = 0, sqqqU = 0, prevTier = null, tqqqMonths = 0, sqqqMonths = 0;
  const points = [];
  for (let i = 0; i < months.length; i++) {
    const m = months[i].month, f = months[i].final;
    if (i > 0) cash *= 1 + ((rateMap.get(months[i - 1].month) ?? 0) / 100) / 12;
    const pT = px.tqqq.get(m), pS = px.sqqq.get(m);
    if (pT === undefined || pS === undefined) throw new Error(`合成TQQQ/SQQQ 缺 ${m} 月末价`);
    const nav = cash + tqqqU * pT + sqqqU * pS;
    // ---- 卖出侧 ----
    if (f === 'defense' && defenseClearsTqqq && tqqqU > 0) { cash += tqqqU * pT; tqqqU = 0; }
    if (f === 'reduce' && reduceSellsHalf && prevTier !== 'reduce' && tqqqU > 0) {
      cash += (tqqqU / 2) * pT; tqqqU /= 2;
    }
    if (f === 'attack' && attackRebalance && sqqqU > 0) { cash += sqqqU * pS; sqqqU = 0; } // 字面：先卖出SQQQ
    // ---- SQQQ 腿（attack 档不买保险） ----
    if (f !== 'attack' && sqqqLeg !== 'none') {
      if (sqqqLeg === 'rebalance') {
        const diff = sqqqTargetPct * nav - sqqqU * pS;
        const trade = diff > 0 ? Math.min(diff, cash) : diff;
        sqqqU += trade / pS; cash -= trade;
      } else if (sqqqU === 0) {
        const spend = Math.min(sqqqTargetPct * nav, cash);
        sqqqU += spend / pS; cash -= spend;
      }
    }
    // ---- TQQQ 买入侧 ----
    if (tqqqTiers.includes(f)) {
      if (f === 'attack' && attackRebalance) {
        const diff = tqqqTargetPct * nav - tqqqU * pT;
        const trade = diff > 0 ? Math.min(diff, cash) : diff;
        tqqqU += trade / pT; cash -= trade;
      } else if (tqqqU === 0) {
        const spend = Math.min(tqqqTargetPct * nav, cash);
        tqqqU += spend / pT; cash -= spend;
      }
    }
    if (tqqqU > 0) tqqqMonths++;
    if (sqqqU > 0) sqqqMonths++;
    points.push({ month: m, nav: cash + tqqqU * pT + sqqqU * pS });
    prevTier = f;
  }
  return { points, tqqqMonths, sqqqMonths };
}

/**
 * TQQQ 期权方案状态机（粗粒度BS建模）：
 *  - LEAPS Call：行权价 S×1.2、36个月，剩余≤2个月时滚动（按当时BS价卖旧买新，各收0.5%摩擦）；
 *    callTiers 档位内且无持仓时买入，预算=85%×组合净值（现金封顶）；defense 清仓；
 *    reduceSellsHalf=true（方案3）：进入 reduce 一次性卖出50%合约
 *  - 短期 Put：行权价 S×0.8、6个月，常备（到期按内在价值结算后立即续买，预算=5%×净值）
 *  - IV = 合成TQQQ滚动252日实现波动率×ivMult(1.15)；无风险利率=当月FFR；月末重定价
 * @returns {{points, callMonths:number}}
 */
export function simulateOptionScheme(months, pxMap, volByMonth, rateMap, {
  callTiers = ['attack'],
  reduceSellsHalf = false,
  callBudgetPct = 0.85, putBudgetPct = 0.05,
  callTenorM = 36, callRollBeforeM = 2, callStrikeMult = 1.2,
  putTenorM = 6, putStrikeMult = 0.8,
  ivMult = 1.15, frictionPct = 0.005,
} = {}) {
  let cash = 1, call = null, put = null, prevTier = null, callMonths = 0;
  const points = [];
  for (let i = 0; i < months.length; i++) {
    const m = months[i].month, f = months[i].final;
    if (i > 0) cash *= 1 + ((rateMap.get(months[i - 1].month) ?? 0) / 100) / 12;
    const S = pxMap.get(m), rv = volByMonth.get(m);
    if (S === undefined || rv === undefined) throw new Error(`合成TQQQ 缺 ${m} 价格/波动率`);
    const iv = rv * ivMult;
    const r = (rateMap.get(m) ?? 0) / 100;
    const callVal = () => (call ? call.units * bsPrice(S, call.K, Math.max(0, (call.expIdx - i) / 12), r, iv, 'call') : 0);
    const putVal = () => (put ? put.units * bsPrice(S, put.K, Math.max(0, (put.expIdx - i) / 12), r, iv, 'put') : 0);
    // ---- Put 到期结算（内在价值，无摩擦；续买在下方统一处理） ----
    if (put && i >= put.expIdx) { cash += put.units * Math.max(put.K - S, 0); put = null; }
    // ---- Call 滚动卖出（剩余≤2个月）与档位驱动卖出 ----
    if (call && call.expIdx - i <= callRollBeforeM) { cash += callVal() * (1 - frictionPct); call = null; }
    if (call && f === 'defense') { cash += callVal() * (1 - frictionPct); call = null; }
    if (call && f === 'reduce' && reduceSellsHalf && prevTier !== 'reduce') {
      cash += (callVal() / 2) * (1 - frictionPct); call.units /= 2;
    }
    // ---- Call 买入（档位内且无持仓） ----
    if (callTiers.includes(f) && !call) {
      const spend = Math.min(callBudgetPct * (cash + putVal()), cash);
      if (spend > 0) {
        const price = bsPrice(S, callStrikeMult * S, callTenorM / 12, r, iv, 'call');
        call = { units: spend / (price * (1 + frictionPct)), K: callStrikeMult * S, expIdx: i + callTenorM };
        cash -= spend;
      }
    }
    // ---- Put 常备续买 ----
    if (!put) {
      const spend = Math.min(putBudgetPct * (cash + callVal()), cash);
      if (spend > 0) {
        const price = bsPrice(S, putStrikeMult * S, putTenorM / 12, r, iv, 'put');
        put = { units: spend / (price * (1 + frictionPct)), K: putStrikeMult * S, expIdx: i + putTenorM };
        cash -= spend;
      }
    }
    if (call) callMonths++;
    points.push({ month: m, nav: cash + callVal() + putVal() });
    prevTier = f;
  }
  return { points, callMonths };
}

// ---------- 数据（QQQ 日线：本地缓存 45 天陈旧护栏，过期回源 Tiingo） ----------

async function loadQqqBars() {
  const cacheFile = path.join(__dirname, 'qqq-cache.json');
  const today = new Date().toISOString().slice(0, 10);
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const last = cached.bars?.length ? cached.bars[cached.bars.length - 1].date : null;
    if (last && (Date.parse(today) - Date.parse(last)) / 86400000 <= 45) return cached.bars;
  }
  const token = process.env.TIINGO_API_KEY;
  if (!token) throw new Error('qqq-cache.json 缺失/陈旧且 TIINGO_API_KEY 未设置（backend/.env）');
  const res = await axios.get('https://api.tiingo.com/tiingo/daily/qqq/prices', {
    params: { startDate: '1997-01-01', token }, timeout: 60000,
  });
  const bars = (res.data || [])
    .map(b => ({ date: String(b.date).slice(0, 10), close: b.adjClose ?? b.close }))
    .filter(b => !isNaN(b.close));
  if (bars.length < 1000) throw new Error(`QQQ 拉取不完整（${bars.length} bars），不写缓存`);
  fs.writeFileSync(cacheFile, JSON.stringify({ source: 'Tiingo QQQ 总回报（adjClose）', fetchedAt: today, bars }));
  return bars;
}

// ---------- 主流程 ----------

const f1 = v => (v === null || v === undefined || isNaN(v) ? '—' : v.toFixed(1));

function reportRow(name, stats, extra = {}) {
  if (!stats) return { 方案: name, 备注: '样本不足' };
  const sub = extra.sub2010;
  const fullYears = [...stats.yearly].filter(([y]) => stats.yearMonths.get(y) === 12);
  const worst = fullYears.reduce((a, b) => (b[1] < a[1] ? b : a), ['—', Infinity]);
  return {
    方案: name,
    全期年化: f1(stats.cagrPct) + '%',
    最大回撤: f1(stats.mddPct) + '%',
    '2010起年化': f1(sub?.cagrPct) + '%',
    最差单年: `${worst[0]} ${f1(worst[1])}%`,
    '2008年': f1(stats.yearly.get('2008')) + '%',
    '2020年': f1(stats.yearly.get('2020')) + '%',
    '2022年': f1(stats.yearly.get('2022')) + '%',
    '最低净值(%初值)': (stats.minNavRatio * 100).toFixed(1) + '%',
    '曾破初值20%': stats.minNavRatio < 0.2 ? '是' : '否',
    ...extra.cols,
  };
}

async function main() {
  const D = await loadData();
  const { rateMap } = D;
  console.log('[tqqq-schemes] 重放基线信号时间线（V3+V4+W5 默认档）...');
  const timeline = runReplay(D, VARIANTS_DEFAULT).filter(t => t.spx !== null);
  const tierCount = {};
  for (const t of timeline) tierCount[t.final] = (tierCount[t.final] ?? 0) + 1;
  console.log(`[tqqq-schemes] ${timeline.length} 个月（${timeline[0].month} ~ ${timeline[timeline.length - 1].month}） 档位分布:`, JSON.stringify(tierCount));
  console.log(`[tqqq-schemes] attack 档出现 ${tierCount.attack ?? 0} 次 —— 字面版方案的 TQQQ 触发条件`);

  const qqqBars = await loadQqqBars();
  const rateOfDate = d => rateMap.get(d.slice(0, 7)) ?? 0;
  // 合成标的（用户指定模型）：TQQQ = 3r − 2×FFR_d − ER_d；SQQQ = −3r + 4×FFR_d − ER_d
  const tqqqDaily = synthDailyCustom(qqqBars, rateOfDate, { beta: 3, ffrMult: -2, erPct: 0.86 });
  const sqqqDaily = synthDailyCustom(qqqBars, rateOfDate, { beta: -3, ffrMult: 4, erPct: 0.95 });
  const px = {
    tqqq: monthlyCloseMap(tqqqDaily),
    sqqq: monthlyCloseMap(sqqqDaily),
    spy: monthlyCloseMap(D.spx),
    qqq2x: monthlyCloseMap(synthLeveragedDaily(qqqBars, rateOfDate)),
  };
  const volByMonth = rollingVolByMonth(tqqqDaily);
  const navPoints = asset => timeline.map(t => {
    const v = px[asset].get(t.month);
    if (v === undefined) throw new Error(`${asset} 缺 ${t.month}`);
    return { month: t.month, nav: v };
  });
  // 与 execution-layer 的"2010起"同口径：2010-01 为基期，首个收益月为 2010-02
  const sub2010Of = points => statsFromNav(points.filter(p => p.month >= '2010-01'));

  // ===== 参照0：合成裸标的买入持有（给用户看标的性质） =====
  console.log('\n===== 参照：合成TQQQ/SQQQ 全期买入持有（2000-01~%s，日度3x合成含费；裸标的性质展示） ====='.replace('%s', timeline[timeline.length - 1].month));
  const bhRows = [];
  for (const [asset, label] of [['tqqq', '合成TQQQ 买入持有'], ['sqqq', '合成SQQQ 买入持有']]) {
    const pts = navPoints(asset);
    bhRows.push(reportRow(label, statsFromNav(pts), { sub2010: sub2010Of(pts) }));
  }
  console.table(bhRows);

  // ===== 参照1：E0/E3（昨天执行层结论的对照行） =====
  const assetRet = (asset, m0, m1) => {
    const a = px[asset].get(m0), b = px[asset].get(m1);
    return a && b ? b / a - 1 : null;
  };
  const E0 = f => (f === 'defense' ? { cash: 1 } : { spy: 1 });
  const E3 = f => (f === 'defense' ? { cash: 1 } : f === 'reduce' ? { spy: 1 } : { qqq2x: 1 });
  // E7 修复版映射（定性结论4用）：3x框架若要可用的最小修正——月度再平衡回85%目标仓（消灭漂移）、
  // reduce真减仓（→SPY）、defense→现金、无SQQQ常备腿
  const E7 = f => (f === 'defense' ? { cash: 1 } : f === 'reduce' ? { spy: 1 } : { tqqq: 0.85, cash: 0.15 });
  const e0Pts = navPathFromWeights(timeline, E0, assetRet, rateMap);
  const e3Pts = navPathFromWeights(timeline, E3, assetRet, rateMap);
  const e7Pts = navPathFromWeights(timeline, E7, assetRet, rateMap);
  const ctrlRows = [
    reportRow('E0 基线(defense→现金,余SPY)', statsFromNav(e0Pts), { sub2010: sub2010Of(e0Pts) }),
    reportRow('E3 激进(neutral∪attack→2xQQQ)', statsFromNav(e3Pts), { sub2010: sub2010Of(e3Pts) }),
    reportRow('E7 修复版(neutral∪attack→85%TQQQ月度再平衡,reduce→SPY,defense→现金)', statsFromNav(e7Pts), { sub2010: sub2010Of(e7Pts) }),
  ];

  // ===== 静态直觉：2026年当下参数的 LEAPS 权利金/theta =====
  const lastM = timeline[timeline.length - 1].month;
  const ivNow = volByMonth.get(lastM) * 1.15;
  const rNow = (rateMap.get(lastM) ?? 0) / 100;
  const callNow = bsPrice(1, 1.2, 3, rNow, ivNow, 'call');
  const callY2 = bsPrice(1, 1.2, 2, rNow, ivNow, 'call'); // 同价同波动持有1年后
  const putNow = bsPrice(1, 0.8, 0.5, rNow, ivNow, 'put');
  console.log(`\n===== 静态直觉（${lastM} 参数：合成TQQQ实现波动率×1.15 = IV ${(ivNow * 100).toFixed(1)}%，FFR ${(rNow * 100).toFixed(2)}%） =====`);
  console.log(`36个月 1.2×S Call 权利金 ≈ 标的现价的 ${(callNow * 100).toFixed(1)}%；标的原地不动持有1年后价值 ${(callY2 * 100).toFixed(1)}% → 首年theta损耗 ≈ 权利金的 ${((1 - callY2 / callNow) * 100).toFixed(1)}%（≈标的价的 ${((callNow - callY2) * 100).toFixed(1)}%/年）`);
  console.log(`6个月 0.8×S Put 权利金 ≈ 标的现价的 ${(putNow * 100).toFixed(1)}%；按"每次投入组合净值5%、一年滚动2次"口径，Put腿毛支出 ≈ 组合净值的 10%/年（危机年靠内在价值回收部分）`);

  // ===== 方案1/2：现货（字面 + 善意 + 修正映射） =====
  const etf = opts => simulateEtfScheme(timeline, px, rateMap, opts);
  const ETF_SCHEMES = [
    ['方案1 字面（TQQQ仅attack档,reduce减半,defense不动TQQQ）', { tqqqTiers: ['attack'], attackRebalance: true, reduceSellsHalf: true }],
    ['方案1 字面+善意（defense清仓TQQQ）', { tqqqTiers: ['attack'], attackRebalance: true, reduceSellsHalf: true, defenseClearsTqqq: true }],
    ['方案2 字面（同1但reduce不减TQQQ）', { tqqqTiers: ['attack'], attackRebalance: true }],
    ['方案1A 修正映射（attack∪neutral持TQQQ85%,reduce减半,defense清仓+SQQQ5%）', { tqqqTiers: ['attack', 'neutral'], reduceSellsHalf: true, defenseClearsTqqq: true }],
    ['方案2A 修正映射（同1A但reduce不减TQQQ）', { tqqqTiers: ['attack', 'neutral'], defenseClearsTqqq: true }],
    ['方案1A-无SQQQ腿（对冲腿单独核算基准）', { tqqqTiers: ['attack', 'neutral'], reduceSellsHalf: true, defenseClearsTqqq: true, sqqqLeg: 'none' }],
    ['方案2A-无SQQQ腿', { tqqqTiers: ['attack', 'neutral'], defenseClearsTqqq: true, sqqqLeg: 'none' }],
    ['方案1A-SQQQ月度重平5%（常备保险口径）', { tqqqTiers: ['attack', 'neutral'], reduceSellsHalf: true, defenseClearsTqqq: true, sqqqLeg: 'rebalance' }],
    ['方案2A-SQQQ月度重平5%', { tqqqTiers: ['attack', 'neutral'], defenseClearsTqqq: true, sqqqLeg: 'rebalance' }],
  ];
  const etfRows = [...ctrlRows];
  const etfRuns = new Map();
  for (const [name, opts] of ETF_SCHEMES) {
    const run = etf(opts);
    etfRuns.set(name, run);
    etfRows.push(reportRow(name, statsFromNav(run.points), {
      sub2010: sub2010Of(run.points),
      cols: { TQQQ持月: run.tqqqMonths, SQQQ持月: run.sqqqMonths },
    }));
  }
  console.log('\n===== 方案1/2（TQQQ/SQQQ现货；月末按档位调仓，不补仓不再平衡，现金计FFR利息，ETF交易未计摩擦） =====');
  console.table(etfRows);

  // ===== SQQQ 对冲腿单独核算（修正版：含腿 − 无腿） =====
  console.log('\n===== SQQQ 对冲腿单独核算（年化成本 = 含腿CAGR − 无腿CAGR；危机贡献 = 当年收益差 pp） =====');
  const legRows = [];
  for (const [withName, baseName] of [
    ['方案1A 修正映射（attack∪neutral持TQQQ85%,reduce减半,defense清仓+SQQQ5%）', '方案1A-无SQQQ腿（对冲腿单独核算基准）'],
    ['方案2A 修正映射（同1A但reduce不减TQQQ）', '方案2A-无SQQQ腿'],
    ['方案1A-SQQQ月度重平5%（常备保险口径）', '方案1A-无SQQQ腿（对冲腿单独核算基准）'],
    ['方案2A-SQQQ月度重平5%', '方案2A-无SQQQ腿'],
  ]) {
    const a = statsFromNav(etfRuns.get(withName).points);
    const b = statsFromNav(etfRuns.get(baseName).points);
    legRows.push({
      对比: withName.split('（')[0] + ' vs 无腿',
      '年化成本(pp)': f1(a.cagrPct - b.cagrPct),
      '2008贡献(pp)': f1((a.yearly.get('2008') ?? NaN) - (b.yearly.get('2008') ?? NaN)),
      '2020贡献(pp)': f1((a.yearly.get('2020') ?? NaN) - (b.yearly.get('2020') ?? NaN)),
      '2022贡献(pp)': f1((a.yearly.get('2022') ?? NaN) - (b.yearly.get('2022') ?? NaN)),
      '回撤变化(pp)': f1(a.mddPct - b.mddPct),
    });
  }
  console.table(legRows);

  // ===== 方案3/4：期权（字面 + 修正映射） =====
  const opt = opts => simulateOptionScheme(timeline, px.tqqq, volByMonth, rateMap, opts);
  const OPT_SCHEMES = [
    ['方案3 字面（LEAPS仅attack档,reduce减半LEAPS）', { callTiers: ['attack'], reduceSellsHalf: true }],
    ['方案4 字面（LEAPS仅attack档,不减）', { callTiers: ['attack'] }],
    ['方案3A 修正映射（attack∪neutral持LEAPS,reduce减半）', { callTiers: ['attack', 'neutral'], reduceSellsHalf: true }],
    ['方案4A 修正映射（attack∪neutral持LEAPS,不减）', { callTiers: ['attack', 'neutral'] }],
  ];
  const optRows = [];
  for (const [name, opts] of OPT_SCHEMES) {
    const run = opt(opts);
    optRows.push(reportRow(name, statsFromNav(run.points), {
      sub2010: sub2010Of(run.points),
      cols: { LEAPS持月: run.callMonths },
    }));
  }
  console.log('\n===== 方案3/4（TQQQ期权，BS粗粒度建模：IV=合成TQQQ滚动252日实现波动率×1.15，FFR贴现，滚动各收0.5%摩擦；Put常备6个月滚动） =====');
  console.table(optRows);

  console.log(`
局限声明（BS建模）：
- 无真实历史期权数据，权利金全部由 Black-Scholes 用"合成TQQQ实现波动率×1.15"生成——真实 TQQQ 期权
  有波动率微笑/期限结构/买卖价差，深度虚值 LEAPS 实际买入价通常比 BS+15% 更贵，本模型偏乐观；
- 合成 TQQQ 用固定费用模型（3r−2×FFR−ER），真实 TQQQ 2010 年才上市，2000-2009 段为反事实推演；
- ETF 现货交易未计摩擦/滑点/税；期权只在滚动与档位买卖时收 0.5%，未计做市价差与指派风险；
- attack 档在318个月中出现 0 次是信号系统的既有事实（AI维历史缺席），字面版方案的结果由此结构性决定。`);
}

// 直接运行时执行（被 import / vitest 收集时只导出纯函数）
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(err => { console.error('[tqqq-schemes] failed:', err); process.exit(1); });
}
