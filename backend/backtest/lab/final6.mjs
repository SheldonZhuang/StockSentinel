// 六个候选同口径对比（用户 2026-10-24）：$10,000 本金 + 每月 3000 HKD 定投（另给一次性对照），2000-01-03 起至 2026-10-21。
//   1 全仓 TQQQ  2 QQQ 买持  3 X2（T5c 70% + 黄金 30%）  4 T5c（UPRO 波动目标 40% + SPY 200 日线）
//   5 假设 11（QQQ 跌破 120 日线买 TQQQ、进场高点回撤 2% 卖、国库券）  6 假设 19（滚动 3 年期 TQQQ Call）
// 检验：① 2000 年起 ② 高点起点（2000-03-10、2007-10-31、2021-11-19）③ 每月一个起点的滚动分布（2000-01 → 2016-10，至少持有 10 年）
//       ④ 最大回撤、水下时间（从前高跌下去到重新站回前高的时长）与"最长水下"
// 口径：1/5/6 用开盘成交的账户模拟（与假设 8–19 一致），2/3/4 用实验室引擎（次日收盘成交）。两者差别 <1pp/年（见 summary-2010 说明）。
// 合成段：TQQQ 2010-02 前、UPRO 2009-06 前按 3 倍日杠杆合成；黄金 2004-11 GLD 上市前按国库券计（偏保守）。
// 用法（backend/ 下）：node backtest/lab/final6.mjs
import { loadAll, simH10, xirr, INIT, MONTHLY, COST } from './hypo10-13.mjs';
import { simLeaps } from './hypo14-19.mjs';
import { synth2000 } from './synth.mjs';
import { loadPanel } from './data.mjs';
import { backtest } from './engine.mjs';
import * as S from './strategies.mjs';

const END = '2026-10-21';
const pct = x => (isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—'), usd = x => `$${Math.round(x).toLocaleString('en-US')}`;
const yrsBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / (365.25 * 864e5);

// ---------- 实验室面板（2/3/4）----------
const PX = await loadPanel(['SPY', 'QQQ', 'UPRO'], { from: '1999-01-01', extend: true });
{ // 黄金腿：GLD 2004-11 前按国库券
  const G = await loadPanel(['GLD'], { from: '2004-01-01', extend: false });
  const gi = new Map(G.dates.map((d, i) => [d, G.ret.GLD[i]]));
  PX.ret.GLDX = Float64Array.from(PX.dates, (d, i) => (i === 0 ? 0 : gi.has(d) ? gi.get(d) : PX.rf[i]));
  PX.px.GLDX = new Float64Array(PX.dates.length); for (let i = 0; i < PX.dates.length; i++) PX.px.GLDX[i] = i ? PX.px.GLDX[i - 1] * (1 + PX.ret.GLDX[i]) : 1;
}
const T5c = () => S.volTarget({ risk: 'UPRO', target: 0.4, lookback: 20, gate: { signal: 'SPY', n: 200, band: 0.02 } });
const LAB = { QQQ: () => S.buyHold({ QQQ: 1 }), X2: () => S.combo([[0.7, T5c], [0.3, () => S.buyHold({ GLDX: 1 })]]), T5c };

/** 实验室净值曲线 → 一次性 / 定投账户曲线 */
function labRun(key, start, dca) {
  const r = backtest(PX, LAB[key](), { start, end: END });
  let units = INIT / r.curve[0], invested = INIT; const flows = [{ d: r.dates[0], amt: -INIT }], curve = [];
  for (let i = 0; i < r.dates.length; i++) {
    if (dca && i > 0 && r.dates[i].slice(0, 7) !== r.dates[i - 1].slice(0, 7)) { units += MONTHLY / r.curve[i]; invested += MONTHLY; flows.push({ d: r.dates[i], amt: -MONTHLY }); }
    curve.push({ d: r.dates[i], v: units * r.curve[i] });
  }
  return finish(curve, flows, invested, dca);
}
/** 全仓 TQQQ（开盘成交） */
function holdRun(D, start, dca) {
  const days = D.days.filter(d => d >= start && d <= END), T = D.px.TQQQ;
  let units = INIT * (1 - COST) / T.get(days[0]).ao, invested = INIT; const flows = [{ d: days[0], amt: -INIT }], curve = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (dca && i > 0 && d.slice(0, 7) !== days[i - 1].slice(0, 7)) { units += MONTHLY * (1 - COST) / T.get(d).ao; invested += MONTHLY; flows.push({ d, amt: -MONTHLY }); }
    curve.push({ d, v: units * T.get(d).ac });
  }
  return finish(curve, flows, invested, dca);
}
function finish(curve, flows, invested, dca) {
  const final = curve.at(-1).v, ann = dca ? xirr([...flows, { d: curve.at(-1).d, amt: final }]) : (final / INIT) ** (1 / yrsBetween(curve[0].d, curve.at(-1).d)) - 1;
  return { final, invested, gain: final - invested, ret: final / invested - 1, ann, curve, ...underwater(curve), ...belowInvested(curve, invested, flows) };
}
/** 账户市值 < 累计投入（亏着本金）的最长连续时长与最深缺口；dca 曲线需重建累计投入：按月首日追加 */
function belowInvested(curve, investedFinal, flows = null) {
  let inv = INIT, start = null, longest = 0, span = null, worst = 0;
  for (let i = 0; i < curve.length; i++) {
    const { d, v } = curve[i];
    if (i > 0 && investedFinal > INIT && d.slice(0, 7) !== curve[i - 1].d.slice(0, 7)) inv += MONTHLY;
    worst = Math.min(worst, v / inv - 1);
    if (v < inv) { if (!start) start = d; } else if (start) { const L = yrsBetween(start, d); if (L > longest) { longest = L; span = [start, d]; } start = null; }
  }
  if (start) { const L = yrsBetween(start, curve.at(-1).d); if (L > longest) { longest = L; span = [start, '至今']; } }
  return { belowLongest: longest, belowSpan: span, belowWorst: worst };
}
/**
 * 回撤与水下：mdd = 账户市值相对历史最高的最大跌幅（定投版含新投入的钱，"账户里看到的跌幅"）；
 * recover = 最大回撤那一段从前高到重新站回前高用了多久（未站回则到期末仍在水下）；longest = 所有水下段里最长的一段
 */
function underwater(curve) {
  let peak = -1, peakD = null, mdd = 0, mddPeakD = null, mddTroughD = null, uwStart = null, longest = 0, longestSpan = null;
  for (const { d, v } of curve) {
    if (v >= peak) {
      if (uwStart) { const L = yrsBetween(uwStart, d); if (L > longest) { longest = L; longestSpan = [uwStart, d]; } uwStart = null; }
      peak = v; peakD = d;
    } else {
      if (!uwStart) uwStart = peakD;
      if (v / peak - 1 < mdd) { mdd = v / peak - 1; mddPeakD = peakD; mddTroughD = d; }
    }
  }
  const last = curve.at(-1).d;
  if (uwStart) { const L = yrsBetween(uwStart, last); if (L > longest) { longest = L; longestSpan = [uwStart, '至今未回']; } }
  // 最大回撤那一段的回本时间
  let rec = null; if (mddPeakD) { const pv = curve.find(p => p.d === mddPeakD).v; const back = curve.find(p => p.d > mddTroughD && p.v >= pv); rec = back ? [mddPeakD, mddTroughD, back.d] : [mddPeakD, mddTroughD, null]; }
  return { mdd, rec, longest, longestSpan };
}

const withUW = r => ({ ...r, ...underwater(r.curve), ...belowInvested(r.curve, r.invested) }); // 账户模拟自带 mdd，水下时间统一用同一函数重算
const D0 = await loadAll(), D = await synth2000(D0);
const CANDS = [
  ['全仓 TQQQ', (s, dca) => holdRun(D, s, dca)],
  ['QQQ 买持', (s, dca) => labRun('QQQ', s, dca)],
  ['X2 T5c 70%+黄金 30%', (s, dca) => labRun('X2', s, dca)],
  ['T5c UPRO 波动目标+200日线', (s, dca) => labRun('T5c', s, dca)],
  ['假设11 跌破120日线买TQQQ', (s, dca) => withUW(simH10(D, END, { start: s, dca }))],
  ['假设19 滚动3年期Call', (s, dca) => withUW(simLeaps(D, END, { years: 3, start: s, dca }))],
];
const recStr = r => !r.rec ? '—' : r.rec[2] ? `${yrsBetween(r.rec[0], r.rec[2]).toFixed(1)} 年（${r.rec[0].slice(0, 7)}→${r.rec[2].slice(0, 7)}）` : `未回本（${r.rec[0].slice(0, 7)} 起）`;

// ---------- ① 2000 年起 ----------
for (const dca of [true, false]) {
  console.log(`\n== ① 2000-01-03 起，${dca ? '$10,000 + 每月 3000 HKD 定投' : '一次性 $10,000'}（按总收益降序）==`);
  const rows = CANDS.map(([n, f]) => [n, f('2000-01-03', dca)]).sort((a, b) => b[1].gain - a[1].gain);
  rows.forEach(([n, r], i) => console.log(`${String(i + 1).padStart(2)}. ${n.padEnd(24)} 投入 ${usd(r.invested).padStart(9)} 期末 ${usd(r.final).padStart(12)} 总收益 ${usd(r.gain).padStart(12)} 总收益率 ${pct(r.ret).padStart(9)} 年化 ${pct(r.ann).padStart(6)} | 最大回撤 ${pct(r.mdd).padStart(7)} 回本 ${recStr(r)}  最长水下 ${r.longest.toFixed(1)} 年 | 亏本金最长 ${r.belowLongest.toFixed(1)} 年${r.belowSpan ? `（${r.belowSpan[0].slice(0, 7)}→${String(r.belowSpan[1]).slice(0, 7)}）` : ''} 最深 ${pct(r.belowWorst)}`));
}

// ---------- ② 高点起点 ----------
for (const [label, s] of [['2000-03-10 科网泡沫顶', '2000-03-10'], ['2007-10-31 次贷前顶', '2007-10-31'], ['2021-11-19 加息前顶', '2021-11-19']]) {
  console.log(`\n== ② 从 ${label} 起定投至今（按总收益降序；括号内为一次性 $10,000 的期末）==`);
  CANDS.map(([n, f]) => [n, f(s, true), f(s, false)]).sort((a, b) => b[1].gain - a[1].gain).forEach(([n, r, l], i) =>
    console.log(`${String(i + 1).padStart(2)}. ${n.padEnd(24)} 投入 ${usd(r.invested).padStart(9)} 期末 ${usd(r.final).padStart(12)} 总收益 ${usd(r.gain).padStart(12)} 年化 ${pct(r.ann).padStart(6)} | 最大回撤 ${pct(r.mdd).padStart(7)} 回本 ${recStr(r)}  （一次性期末 ${usd(l.final)}）`));
}

// ---------- ③ 滚动起点（定投，至少持有 10 年）----------
const starts = D.days.filter((d, i, a) => d >= '2000-01-03' && d <= '2016-10-21' && (i === 0 || d.slice(0, 7) !== a[i - 1].slice(0, 7)));
console.log(`\n== ③ 起点平移：2000-01 → 2016-10 每月一个起点（${starts.length} 个），定投持有到 ${END}（至少 10 年）==`);
console.log(`${'策略'.padEnd(24)}   XIRR 最差  10%分位   中位    最好 | 期末<投入 占比 | 最大回撤 中位  最差`);
for (const [n, f] of CANDS) {
  const rs = starts.map(s => f(s, true));
  const a = rs.map(r => r.ann).sort((x, y) => x - y), m = rs.map(r => r.mdd).sort((x, y) => x - y);
  const lose = rs.filter(r => r.final < r.invested).length / rs.length;
  console.log(`${n.padEnd(24)} ${pct(a[0]).padStart(9)} ${pct(a[Math.floor(a.length * 0.1)]).padStart(8)} ${pct(a[Math.floor(a.length / 2)]).padStart(7)} ${pct(a.at(-1)).padStart(7)} | ${pct(lose).padStart(9)} | ${pct(m[Math.floor(m.length / 2)]).padStart(9)} ${pct(m[0]).padStart(7)}`);
}
