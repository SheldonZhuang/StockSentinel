// 策略实验室第二批：围绕第一批的两个幸存者（T5 波动目标+均线、M2 ADM）做邻域与杠杆变体，
// 并用"滚动 5 年起点"检验（每月一个起点、各自独立建仓）替代单一起点，报告最差/中位 5 年年化与跑赢 SPY 的比例。
// 用法（backend/ 下）：NDX_OFFLINE=1 node backtest/lab/run2.mjs
import { loadPanel } from './data.mjs';
import { backtest, stats } from './engine.mjs';
import * as S from './strategies.mjs';

const pct = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const P = await loadPanel(['SPY', 'QQQ', 'TQQQ', 'QLD', 'SSO', 'UPRO', 'TLT', 'EFA'], { extend: true });
const W0 = P.dates[260];

const C = [
  ['SPY 买持', () => S.buyHold({ SPY: 1 })],
  ['QQQ 买持', () => S.buyHold({ QQQ: 1 })],
  ['TQQQ 买持', () => S.buyHold({ TQQQ: 1 })],
  // T5 邻域：目标波动 × lookback（均线门 200±2% 固定）
  ...[0.3, 0.4, 0.5].flatMap(t => [10, 20, 60].map(lb => [`T5 TQQQ vt${t * 100}% lb${lb}+200d`, () => S.volTarget({ risk: 'TQQQ', target: t, lookback: lb, gate: { signal: 'QQQ', n: 200, band: 0.02 } })])),
  ['T5b QLD vt40% lb20+200d', () => S.volTarget({ risk: 'QLD', target: 0.4, lookback: 20, gate: { signal: 'QQQ', n: 200, band: 0.02 } })],
  ['T5c UPRO vt40% lb20+SPY200d', () => S.volTarget({ risk: 'UPRO', target: 0.4, lookback: 20, gate: { signal: 'SPY', n: 200, band: 0.02 } })],
  ['M2 ADM', () => S.adm({})],
  ['M2a ADM 美股腿 SSO(2x)', () => S.adm({ hold: { SPY: 'SSO' } })],
  ['M2b ADM 美股腿 UPRO(3x)', () => S.adm({ hold: { SPY: 'UPRO' } })],
  ['M2c ADM 美股腿 UPRO+vt40%', () => S.adm({ hold: { SPY: 'UPRO' }, volTarget: 0.4 })],
  ['M2d ADM 美股腿 QLD(2x)', () => S.adm({ us: 'QQQ', hold: { QQQ: 'QLD' } })],
  ['M2e ADM 美股腿 TQQQ+vt40%', () => S.adm({ us: 'QQQ', hold: { QQQ: 'TQQQ' }, volTarget: 0.4 })],
];

// 滚动 5 年：每月首个交易日为起点（从 W0 到 末日−5 年），每个起点独立重跑
const starts = P.dates.filter((d, i) => i >= 260 && d.slice(0, 7) !== P.dates[i - 1].slice(0, 7) && d <= `${+P.dates.at(-1).slice(0, 4) - 5}${P.dates.at(-1).slice(4)}`);
const plus5 = d => `${+d.slice(0, 4) + 5}${d.slice(4)}`;
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];

const spyRoll = new Map(starts.map(a => [a, stats(backtest(P, S.buyHold({ SPY: 1 }), { start: a, end: plus5(a) })).cagr]));
console.log(`面板 ${P.dates[0]} → ${P.dates.at(-1)}；全期起点 ${W0}；滚动 5 年起点 ${starts.length} 个（${starts[0]} … ${starts.at(-1)}）`);
console.log(`${'策略'.padEnd(30)}  全期年化  全期回撤  夏普  样本内  样本外 | 5年滚动: 最差  10%分位  中位  跑赢SPY  亏钱占比`);
for (const [name, mk] of C) {
  const full = stats(backtest(P, mk(), { start: W0 }));
  const ins = stats(backtest(P, mk(), { start: W0, end: '2009-12-31' }));
  const oos = stats(backtest(P, mk(), { start: '2010-01-01' }));
  const r = starts.map(a => [a, stats(backtest(P, mk(), { start: a, end: plus5(a) })).cagr]);
  const v = r.map(x => x[1]).sort((x, y) => x - y);
  const beat = r.filter(([a, c]) => c > spyRoll.get(a)).length / r.length;
  const lose = v.filter(c => c < 0).length / v.length;
  console.log(`${name.padEnd(30)} ${pct(full.cagr).padStart(8)} ${pct(full.mdd).padStart(9)} ${full.sharpe.toFixed(2).padStart(5)} ${pct(ins.cagr).padStart(7)} ${pct(oos.cagr).padStart(7)} | ${pct(v[0]).padStart(9)} ${pct(q(v, 0.1)).padStart(8)} ${pct(q(v, 0.5)).padStart(6)} ${pct(beat, 0).padStart(7)} ${pct(lose, 0).padStart(8)}`);
}
