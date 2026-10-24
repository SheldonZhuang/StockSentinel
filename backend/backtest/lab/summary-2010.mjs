// 汇总：本会话所有策略，统一从 2010-04-01 起，本金 $10,000，(a) 一次性无定投、(b) 每月首个交易日定投 3000 HKD（÷7.8）。
// 输出总收益（$）、总收益率、年化（一次性=CAGR，定投=XIRR），各自按总收益降序。
// 用法（backend/ 下）：NDX_OFFLINE=1 node backtest/lab/summary-2010.mjs   （只读缓存，不联网）
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanel } from './data.mjs';
import { backtest } from './engine.mjs';
import * as S from './strategies.mjs';
import { readJSON } from '../ndx-rotation/lib.mjs';
import { holdLeg } from '../ndx-rotation/engine.mjs';
import { tradingDays } from '../ndx-rotation/calendar.mjs';
import { hypoRows } from './hypo10-13.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const START = '2010-04-01', INIT = 10000, MONTHLY = 3000 / 7.8;
const pct = x => `${(x * 100).toFixed(1)}%`;
const usd = x => `$${Math.round(x).toLocaleString('en-US')}`;

// ---------- 实验室策略：同一面板（2010 前数据只用于指标预热）----------
const SECT = ['XLB', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLU', 'XLV', 'XLY'];
const SYMS = ['SPY', 'QQQ', 'TQQQ', 'QLD', 'SSO', 'UPRO', 'SOXL', 'TLT', 'IEF', 'AGG', 'EFA', 'GLD', 'DBC', 'RYMFX', 'CBOE:PUT', 'CBOE:BXM', ...SECT];
const P = await loadPanel(SYMS, { from: '2008-01-01', extend: true });
const sma = (risk, signal, o = {}) => () => S.smaFilter({ risk, signal, n: 200, band: 0.02, ...o });
const T5 = (risk, signal, t = 0.4, lb = 20) => () => S.volTarget({ risk, target: t, lookback: lb, gate: { signal, n: 200, band: 0.02 } });
const T5c = T5('UPRO', 'SPY');
const M2a = () => S.adm({ hold: { SPY: 'SSO' } }), M2c = () => S.adm({ hold: { SPY: 'UPRO' }, volTarget: 0.4 });
const TREND = () => S.tsmom({ syms: ['SPY', 'EFA', 'TLT', 'IEF', 'GLD', 'DBC'], target: 0.1 });
const bh = s => () => S.buyHold({ [s]: 1 });
const LAB = [
  ['基准 SPY 买持', bh('SPY')], ['基准 QQQ 买持', bh('QQQ')],
  ['假设8/9-3 全仓 TQQQ', bh('TQQQ')], ['假设8/9-4 全仓 SOXL', bh('SOXL')], ['QLD 买持（纳指2x）', bh('QLD')],
  ['T1 TQQQ+200日线±2% 日检', sma('TQQQ', 'QQQ')], ['T2 TQQQ+200日线 月检', sma('TQQQ', 'QQQ', { band: 0, freq: 'monthly' })],
  ['T3 QLD+200日线±2%', sma('QLD', 'QQQ')], ['T4 TQQQ 波动目标40%', () => S.volTarget({ risk: 'TQQQ', target: 0.4, lookback: 20 })],
  ['T5 TQQQ 波动目标40%+200日线', T5('TQQQ', 'QQQ')], ['T6 TQQQ+200日线 空仓持TLT', sma('TQQQ', 'QQQ', { off: 'TLT' })],
  ['T5b QLD 波动目标40%+200日线', T5('QLD', 'QQQ')], ['T5c UPRO 波动目标40%+SPY200日线', T5c],
  ['M1 GEM 双动量', () => S.gem({})], ['M2 ADM 加速双动量', () => S.adm({})], ['M3 ADM 纳指版', () => S.adm({ us: 'QQQ' })],
  ['M2a ADM 美股腿SSO', M2a], ['M2b ADM 美股腿UPRO', () => S.adm({ hold: { SPY: 'UPRO' } })], ['M2c ADM UPRO+波动目标', M2c],
  ['M2d ADM 美股腿QLD', () => S.adm({ us: 'QQQ', hold: { QQQ: 'QLD' } })], ['M2e ADM TQQQ+波动目标', () => S.adm({ us: 'QQQ', hold: { QQQ: 'TQQQ' }, volTarget: 0.4 })],
  ['R1 行业趋势 9个SPDR', () => S.sectorTrend({ syms: SECT })], ['P1 60/40 SPY/TLT', () => S.buyHold({ SPY: 0.6, TLT: 0.4 }, { rebalance: 'monthly' })],
  ['O1 卖put指数 CBOE PUT', bh('CBOE:PUT')], ['O2 备兑指数 CBOE BXM', bh('CBOE:BXM')], ['F1 RYMFX 管理期货基金', bh('RYMFX')],
  ['F2 ETF趋势 6资产', TREND], ['G1 黄金 GLD', bh('GLD')], ['RP 风险平价 SPY/IEF/GLD/DBC', () => S.riskParity({ syms: ['SPY', 'IEF', 'GLD', 'DBC'] })],
  ['X1 T5c 70%+ETF趋势 30%', () => S.combo([[0.7, T5c], [0.3, TREND]])], ['X2 T5c 70%+黄金 30%', () => S.combo([[0.7, T5c], [0.3, bh('GLD')]])],
  ['X3 T5c 70%+RYMFX 30%', () => S.combo([[0.7, T5c], [0.3, bh('RYMFX')]])], ['X4 T5c/M2c/M2a 各1/3', () => S.combo([[1 / 3, T5c], [1 / 3, M2c], [1 / 3, M2a]])],
  ['X5 三入围各25%+趋势25%', () => S.combo([[0.25, T5c], [0.25, M2c], [0.25, M2a], [0.25, TREND]])],
  ['X6 T5c 60%+卖put 40%', () => S.combo([[0.6, T5c], [0.4, bh('CBOE:PUT')]])],
  ['X7 T5c 50%+M2a 20%+黄金 30%', () => S.combo([[0.5, T5c], [0.2, M2a], [0.3, bh('GLD')]])],
];

// ---------- 假设 8/9 的纳指轮动（逐日净值，开盘价成交）----------
const OUT = path.join(HERE, '../../data/_ndx_rotation/out');
const S1 = (() => { const j = readJSON(path.join(OUT, 's1_result_pit.json')); return j.picks || j.legs; })();
const S2 = readJSON(path.join(OUT, 's2_result_idx.json')).legs;
const U = readJSON(path.join(OUT, 'universe.json')).years;
const days = await tradingDays();
const realSell = d => (d && !String(d).includes('open') ? d : null);
const clip = legs => legs.flatMap(l => { const s = realSell(l.sellD); return s && s <= START ? [] : [{ sym: l.sym, buyD: l.buyD < START ? START : l.buyD, sellD: s }]; });
const s1With = ex => S1.map(p => ex.has(p.sym) ? { ...p, sym: (U[String(p.year - 1)]?.all || []).filter(x => x.ret != null).sort((a, b) => b.ret - a.ret).find(x => !ex.has(x.sym)).sym } : p);
async function navOf(legs) {
  let v = 1; const m = new Map();
  for (const l of legs) { const r = await holdLeg(l.sym, l.buyD, l.sellD, days); for (const p of r.daily) m.set(p.d, v * p.v); v *= r.mult; }
  const ds = [...m.keys()].sort(); return { dates: ds, curve: Float64Array.from(ds, d => m.get(d)) };
}
const ROT = [
  ['假设8/9-1 涨幅冠军循环（能源股按GICS剔除）', clip(s1With(new Set(['FANG', 'BKR', 'PTEN'])))],
  ['假设8/9-1 涨幅冠军循环（太阳能也算能源）', clip(s1With(new Set(['FANG', 'BKR', 'PTEN', 'ENPH', 'FSLR', 'SEDG'])))],
  ['假设8/9-2 最大权重股循环', clip(S2)],
];

// ---------- 统一结算 ----------
function xirr(flows) {
  const t0 = Date.parse(flows[0].d);
  const f = r => flows.reduce((s, c) => s + c.amt / (1 + r) ** ((Date.parse(c.d) - t0) / (365.25 * 864e5)), 0);
  let lo = -0.99, hi = 5; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; f(m) > 0 ? (lo = m) : (hi = m); }
  return (lo + hi) / 2;
}
function settle({ dates, curve }, end) {
  let n = dates.length; while (dates[n - 1] > end) n--;
  const yrs = (Date.parse(dates[n - 1]) - Date.parse(dates[0])) / (365.25 * 864e5);
  const lumpFinal = INIT * curve[n - 1] / curve[0];
  let units = INIT / curve[0], invested = INIT; const flows = [{ d: dates[0], amt: -INIT }];
  for (let i = 1; i < n; i++) if (dates[i].slice(0, 7) !== dates[i - 1].slice(0, 7)) { units += MONTHLY / curve[i]; invested += MONTHLY; flows.push({ d: dates[i], amt: -MONTHLY }); }
  const dcaFinal = units * curve[n - 1]; flows.push({ d: dates[n - 1], amt: dcaFinal });
  return { end: dates[n - 1], lump: { final: lumpFinal, gain: lumpFinal - INIT, ret: lumpFinal / INIT - 1, ann: (lumpFinal / INIT) ** (1 / yrs) - 1 },
    dca: { final: dcaFinal, invested, gain: dcaFinal - invested, ret: dcaFinal / invested - 1, ann: xirr(flows) } };
}

const END = [P.dates.at(-1), days.at(-1)].sort()[0]; // 共同末日
const rows = [];
for (const [name, mk] of LAB) { const r = backtest(P, mk(), { start: START }); rows.push([name, settle(r, END)]); }
for (const [name, legs] of ROT) rows.push([name, settle(await navOf(legs), END)]);
rows.push(...(await hypoRows(END))); // 假设 10–13：开盘成交逐日账户模拟（定投版在开盘买入）

console.log(`窗口 ${START} → ${END}；本金 ${usd(INIT)}；定投每月 3000 HKD ≈ $${MONTHLY.toFixed(2)}，累计投入 ${usd(rows[0][1].dca.invested)}`);
for (const [title, k] of [['A. 一次性 $10,000、无定投（年化 = CAGR）', 'lump'], ['B. $10,000 + 每月 3000 HKD 定投（年化 = XIRR）', 'dca']]) {
  console.log(`\n== ${title}，按总收益降序 ==`);
  console.log(`${'#'.padStart(3)}  ${'策略'.padEnd(36)} ${'期末总资产'.padStart(12)} ${'总收益'.padStart(13)} ${'总收益率'.padStart(10)} ${'年化'.padStart(7)}`);
  [...rows].sort((a, b) => b[1][k].gain - a[1][k].gain).forEach(([n, r], i) =>
    console.log(`${String(i + 1).padStart(3)}  ${n.padEnd(36)} ${usd(r[k].final).padStart(12)} ${usd(r[k].gain).padStart(13)} ${pct(r[k].ret).padStart(10)} ${pct(r[k].ann).padStart(7)}`));
}
