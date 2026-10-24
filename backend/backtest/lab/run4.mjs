// 策略实验室第四批：决赛圈压力测试——不同起点（含最坏时点）、定投版（同假设 9）、税后粗估，最后统一打分。
// 用法（backend/ 下）：NDX_OFFLINE=1 node backtest/lab/run4.mjs
import { loadPanel } from './data.mjs';
import { backtest, stats } from './engine.mjs';
import * as S from './strategies.mjs';

const pct = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const usd = x => `$${Math.round(x).toLocaleString('en-US')}`;
// GLD 2004-11 起：面板从 2004-11 开始，2005-12 后统计（预热 1 年）；趋势腿需要 DBC（2006-02），单独标注
const P = await loadPanel(['SPY', 'UPRO', 'SSO', 'TLT', 'EFA', 'GLD', 'IEF', 'DBC', 'QQQ', 'TQQQ'], { from: '2004-01-01', extend: true });
const W0 = P.dates[260];

const T5c = () => S.volTarget({ risk: 'UPRO', target: 0.4, lookback: 20, gate: { signal: 'SPY', n: 200, band: 0.02 } });
const M2a = () => S.adm({ hold: { SPY: 'SSO' } });
const TREND = () => S.tsmom({ syms: ['SPY', 'EFA', 'TLT', 'IEF', 'GLD', 'DBC'], target: 0.10 });
const F = [
  ['SPY 买持', () => S.buyHold({ SPY: 1 })],
  ['QQQ 买持', () => S.buyHold({ QQQ: 1 })],
  ['TQQQ 买持', () => S.buyHold({ TQQQ: 1 })],
  ['T5c UPRO 波动目标+200日线', T5c],
  ['M2a ADM（SSO）', M2a],
  ['X2 T5c 70% + 黄金 30%', () => S.combo([[0.7, T5c], [0.3, () => S.buyHold({ GLD: 1 })]])],
  ['X1 T5c 70% + ETF趋势 30%', () => S.combo([[0.7, T5c], [0.3, TREND]])],
  ['X7 T5c 50% + M2a 20% + 黄金 30%', () => S.combo([[0.5, T5c], [0.2, M2a], [0.3, () => S.buyHold({ GLD: 1 })]])],
];

// ---- 1. 不同起点（一次性 $10,000 持有至今）----
const STARTS = [['全期', W0], ['2007-10 次贷顶部', '2007-10-09'], ['2010-04（同假设 8）', '2010-04-01'], ['2020-02 疫情前顶', '2020-02-19'], ['2022-01 加息前顶', '2022-01-03']];
console.log(`面板 ${P.dates[0]} → ${P.dates.at(-1)}；全期起点 ${W0}`);
console.log(`\n== 1. 不同起点一次性投入 $10,000 至今：年化 / 最大回撤 ==\n${'策略'.padEnd(30)}` + STARTS.map(s => s[0].padStart(20)).join(''));
for (const [name, mk] of F) {
  console.log(name.padEnd(30) + STARTS.map(([, a]) => { const st = stats(backtest(P, mk(), { start: a })); return `${pct(st.cagr)} / ${pct(st.mdd, 0)}`.padStart(20); }).join(''));
}

// ---- 2. 定投版（同假设 9：2010-04-01 本金 $10,000，之后每月首个交易日 3000 HKD ≈ $384.62）----
function xirr(flows) {
  const t0 = Date.parse(flows[0].d);
  const f = r => flows.reduce((s, c) => s + c.amt / (1 + r) ** ((Date.parse(c.d) - t0) / (365.25 * 864e5)), 0);
  let lo = -0.99, hi = 5; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; f(m) > 0 ? (lo = m) : (hi = m); }
  return (lo + hi) / 2;
}
function dca(res, init = 10000, monthly = 3000 / 7.8) {
  const { dates, curve } = res;
  let units = init / curve[0], invested = init, peak = 0, mdd = 0;
  const flows = [{ d: dates[0], amt: -init }];
  for (let i = 1; i < dates.length; i++) {
    if (dates[i].slice(0, 7) !== dates[i - 1].slice(0, 7)) { units += monthly / curve[i]; invested += monthly; flows.push({ d: dates[i], amt: -monthly }); }
    const v = units * curve[i]; peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1);
  }
  const final = units * curve.at(-1); flows.push({ d: dates.at(-1), amt: final });
  return { final, invested, irr: xirr(flows), mdd };
}
console.log('\n== 2. 定投版（2010-04-01 本金 $10,000 + 每月 3000 HKD，同假设 9）==');
for (const [name, mk] of F) {
  const d = dca(backtest(P, mk(), { start: '2010-04-01' }));
  console.log(`${name.padEnd(30)} 累计投入 ${usd(d.invested)}  期末 ${usd(d.final).padStart(11)}  年化(XIRR) ${pct(d.irr).padStart(6)}  账户最大回撤 ${pct(d.mdd)}`);
}

// ---- 3. 税后粗估（悲观口径）：每年的净盈利在当年按 30% 扣税（亏损年不退税、不结转）；买持类只在末尾一次性按 20% 长期税率 ----
// 真实税负取决于税务身份、账户类型（IRA/港股账户等），这里只用来比较"高换手策略的税前优势还剩多少"
console.log('\n== 3. 税后粗估（全期，换手策略每年盈利扣 30%；买持期末扣 20%）==');
for (const [name, mk] of F) {
  const st = stats(backtest(P, mk(), { start: W0 }));
  const buyHoldLike = st.tradesPerYear < 0.5;
  let v = 1;
  for (const [y, r] of Object.entries(st.yearly)) v *= buyHoldLike ? 1 + r : 1 + (r > 0 ? r * 0.7 : r);
  if (buyHoldLike) v = 1 + (v - 1) * 0.8;
  const after = v ** (1 / st.years) - 1;
  console.log(`${name.padEnd(30)} 税前 ${pct(st.cagr).padStart(6)}  税后≈ ${pct(after).padStart(6)}  次/年 ${st.tradesPerYear.toFixed(1)}`);
}

// ---- 4. 统一打分（全期）：最差 5 年滚动年化、最大回撤、税后年化、换手 ----
const starts = P.dates.filter((d, i) => i > 260 && d.slice(0, 7) !== P.dates[i - 1].slice(0, 7) && d <= `${+P.dates.at(-1).slice(0, 4) - 5}${P.dates.at(-1).slice(4)}`);
const plus5 = d => `${+d.slice(0, 4) + 5}${d.slice(4)}`;
console.log(`\n== 4. 统一打分（全期 ${W0} 起；滚动 5 年起点 ${starts.length} 个）==`);
console.log(`${'策略'.padEnd(30)}   年化    回撤  夏普  Calmar | 5年滚动 最差  10%分位  中位  跑赢SPY`);
const spy = new Map(starts.map(a => [a, stats(backtest(P, S.buyHold({ SPY: 1 }), { start: a, end: plus5(a) })).cagr]));
for (const [name, mk] of F) {
  const st = stats(backtest(P, mk(), { start: W0 }));
  const r = starts.map(a => [a, stats(backtest(P, mk(), { start: a, end: plus5(a) })).cagr]);
  const v = r.map(x => x[1]).sort((a, b) => a - b);
  const beat = r.filter(([a, c]) => c > spy.get(a)).length / r.length;
  console.log(`${name.padEnd(30)} ${pct(st.cagr).padStart(6)} ${pct(st.mdd).padStart(7)} ${st.sharpe.toFixed(2).padStart(5)} ${st.calmar.toFixed(2).padStart(6)} | ${pct(v[0]).padStart(9)} ${pct(v[Math.floor(v.length * 0.1)]).padStart(8)} ${pct(v[Math.floor(v.length / 2)]).padStart(6)} ${pct(beat, 0).padStart(7)}`);
}
