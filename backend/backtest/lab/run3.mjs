// 策略实验室第三批：期权收入（CBOE PUT/BXM）、管理期货（真实基金 + ETF 趋势近似）、黄金/商品/风险平价分散，
// 以及"入围策略 + 分散腿"组合。重点看 2008、2022（股债同跌）两个压力年。
// 面板从 2007-01 起（PUT 日频、DBC/SSO 的共同起点），2008 年完整在内。
// 用法（backend/ 下）：NDX_OFFLINE=1 node backtest/lab/run3.mjs
import { loadPanel } from './data.mjs';
import { backtest, stats } from './engine.mjs';
import * as S from './strategies.mjs';

const pct = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const SYMS = ['SPY', 'UPRO', 'SSO', 'TLT', 'IEF', 'EFA', 'GLD', 'DBC', 'CBOE:PUT', 'CBOE:BXM'];
const P = await loadPanel(SYMS, { from: '2006-01-01', extend: true });
const W0 = P.dates[Math.max(260, P.dates.findIndex(d => d >= '2008-01-01'))]; // 至少 1 年预热（12 月动量/200 日线）
console.log(`面板 ${P.dates[0]} → ${P.dates.at(-1)}（${P.dates.length} 天）；统计起点 ${W0}；合成段：` +
  Object.entries(P.meta).filter(([, m]) => m.synthUntil).map(([s, m]) => `${s}<${m.synthUntil}`).join(' '));

const T5c = () => S.volTarget({ risk: 'UPRO', target: 0.4, lookback: 20, gate: { signal: 'SPY', n: 200, band: 0.02 } });
const M2c = () => S.adm({ hold: { SPY: 'UPRO' }, volTarget: 0.4 });
const M2a = () => S.adm({ hold: { SPY: 'SSO' } });
const TREND = () => S.tsmom({ syms: ['SPY', 'EFA', 'TLT', 'IEF', 'GLD', 'DBC'], target: 0.10 });
const C = [
  ['SPY 买持', () => S.buyHold({ SPY: 1 })],
  ['60/40 SPY/IEF 月平衡', () => S.buyHold({ SPY: 0.6, IEF: 0.4 }, { rebalance: 'monthly' })],
  ['O1 CBOE PUT（卖 put 指数，扣 0.5%）', () => S.buyHold({ 'CBOE:PUT': 1 })],
  ['O2 CBOE BXM（备兑指数，扣 0.5%）', () => S.buyHold({ 'CBOE:BXM': 1 })],
  ['F2 ETF 趋势 6 资产 目标波动10%', TREND],
  ['G1 GLD 黄金', () => S.buyHold({ GLD: 1 })],
  ['RP 风险平价 SPY/IEF/GLD/DBC', () => S.riskParity({ syms: ['SPY', 'IEF', 'GLD', 'DBC'] })],
  ['T5c UPRO vt40%+SPY200d', T5c],
  ['M2c ADM UPRO+vt40%', M2c],
  ['M2a ADM SSO', M2a],
  ['X1 T5c 70% + ETF趋势 30%', () => S.combo([[0.7, T5c], [0.3, TREND]])],
  ['X2 T5c 70% + GLD 30%', () => S.combo([[0.7, T5c], [0.3, () => S.buyHold({ GLD: 1 })]])],
  ['X4 T5c/M2c/M2a 各 1/3', () => S.combo([[1 / 3, T5c], [1 / 3, M2c], [1 / 3, M2a]])],
  ['X5 三入围 各 25% + ETF趋势 25%', () => S.combo([[0.25, T5c], [0.25, M2c], [0.25, M2a], [0.25, TREND]])],
  ['X6 T5c 60% + PUT 40%', () => S.combo([[0.6, T5c], [0.4, () => S.buyHold({ 'CBOE:PUT': 1 })]])],
];

const starts = P.dates.filter((d, i) => d >= W0 && d.slice(0, 7) !== P.dates[i - 1].slice(0, 7) && d <= `${+P.dates.at(-1).slice(0, 4) - 5}${P.dates.at(-1).slice(4)}`);
const plus5 = d => `${+d.slice(0, 4) + 5}${d.slice(4)}`;
console.log(`滚动 5 年起点 ${starts.length} 个（${starts[0]} … ${starts.at(-1)}）\n`);
console.log(`${'策略'.padEnd(34)}   年化    回撤  夏普  2008年  2020年  2022年  次/年 | 5年滚动 最差   中位`);
for (const [name, mk] of C) {
  const st = stats(backtest(P, mk(), { start: W0 }));
  const v = starts.map(a => stats(backtest(P, mk(), { start: a, end: plus5(a) })).cagr).sort((x, y) => x - y);
  console.log(`${name.padEnd(34)} ${pct(st.cagr).padStart(6)} ${pct(st.mdd).padStart(7)} ${st.sharpe.toFixed(2).padStart(5)} ${pct(st.yearly['2008']).padStart(7)} ${pct(st.yearly['2020']).padStart(7)} ${pct(st.yearly['2022']).padStart(7)} ${st.tradesPerYear.toFixed(1).padStart(6)} | ${pct(v[0]).padStart(8)} ${pct(v[Math.floor(v.length / 2)]).padStart(6)}`);
}

// RYMFX（Rydex 管理期货基金，2008-01 起）单独面板：与 ETF 趋势近似对照同一窗口
const R = await loadPanel(['SPY', 'UPRO', 'RYMFX', 'EFA', 'TLT', 'IEF', 'GLD', 'DBC'], { from: '2006-01-01', extend: true });
const R0 = R.dates[260];
console.log(`
== 管理期货真实基金对照（${R0} 起，RYMFX 上市后预热 1 年）==`);
for (const [name, mk] of [['SPY 买持', () => S.buyHold({ SPY: 1 })], ['F1 RYMFX 管理期货基金', () => S.buyHold({ RYMFX: 1 })], ['F2 ETF 趋势 6 资产', TREND], ['T5c', T5c], ['X3 T5c 70% + RYMFX 30%', () => S.combo([[0.7, T5c], [0.3, () => S.buyHold({ RYMFX: 1 })]])], ['X1 T5c 70% + ETF趋势 30%', () => S.combo([[0.7, T5c], [0.3, TREND]])]]) {
  const st = stats(backtest(R, mk(), { start: R0 }));
  console.log(`${name.padEnd(34)} ${pct(st.cagr).padStart(6)} ${pct(st.mdd).padStart(7)} ${st.sharpe.toFixed(2).padStart(5)} 2020 ${pct(st.yearly['2020']).padStart(7)} 2022 ${pct(st.yearly['2022']).padStart(7)}`);
}
