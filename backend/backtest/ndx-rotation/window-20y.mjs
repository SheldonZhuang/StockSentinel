// "最近 20 年"窗口版（用户 2026-10-23）：复用全期回测已定好的选股 / 持仓序列（out/s1_result_pit.json、
// out/s2_result_idx.json、out/s2_result_cap.json），只截取窗口内的持有段，按同一引擎逐日重算净值与最大回撤。
// 窗口：最近交易日往回 20 年。
//   S1 只在每年首个交易日换仓 → 从窗口起点之后的第一个年初开始（不在年中半路买入"去年冠军"）；
//   S2 只在调仓后换仓 → 从窗口起点之后第一次调仓的下一交易日开始。
// 基准 QQQ / SPY 与各自策略同起点、同终点。
// 用法（backend/ 下）：NDX_OFFLINE=1 node backtest/ndx-rotation/window-20y.mjs
import path from 'path';
import { fileURLToPath } from 'url';
import { readJSON } from './lib.mjs';
import { holdLeg, buyHold, stats } from './engine.mjs';
import { tradingDays } from './calendar.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../../data/_ndx_rotation/out');
const load = f => readJSON(path.join(OUT, f));

const days = await tradingDays();
const end = days.at(-1);
const windowStart = `${Number(end.slice(0, 4)) - 20}${end.slice(4)}`;
const pct = x => `${(x * 100).toFixed(1)}%`;
const usd = x => `$${Math.round(x).toLocaleString('en-US')}`;
const realSell = d => (d && !String(d).includes('open') ? d : null);

/** 依次持有各段，返回逐日净值 [{d,v}]（起始 10000） */
async function runLegs(legs) {
  let v = 10000;
  const curve = [{ d: legs[0].buyD, v }];
  for (const l of legs) {
    const r = await holdLeg(l.sym, l.buyD, realSell(l.sellD), days);
    for (const p of r.daily) if (p.d !== curve.at(-1).d) curve.push({ d: p.d, v: v * p.v });
    v *= r.mult;
  }
  return curve;
}

async function bench(sym, d0) {
  const c = await buyHold(sym, d0, days);
  return stats(c.map(p => ({ d: p.d, v: p.v * 10000 })));
}

async function report(label, legs) {
  const curve = await runLegs(legs);
  return { label, st: stats(curve), qqq: await bench('QQQ', legs[0].buyD), spy: await bench('SPY', legs[0].buyD) };
}

const s1All = (() => { const j = load('s1_result_pit.json'); return j.picks || j.legs; })();
const s1w = s1All.filter(p => p.buyD >= windowStart).map(p => ({ sym: p.sym, buyD: p.buyD, sellD: p.sellD, year: p.year, holdRet: p.holdRet }));
const s2iw = load('s2_result_idx.json').legs.filter(l => l.buyD >= windowStart);
const s2cw = load('s2_result_cap.json').legs.filter(l => l.buyD >= windowStart);

const rows = [
  await report('S1 涨幅最大个股循环法（时点成分）', s1w),
  await report('S2 最大权重股循环法（指数股数法）', s2iw),
  await report('S2 最大权重股循环法（市值法）', s2cw),
];

console.log(`window: ${windowStart} → ${end}`);
for (const r of rows) {
  const { st, qqq, spy } = r;
  console.log(`\n${r.label}  ${st.from} → ${st.to}（${st.years.toFixed(2)} 年）`);
  console.log(`  期末 ${usd(st.final)}  总收益 ${pct(st.totalRet)}  年化 ${pct(st.cagr)}  最大回撤 ${pct(st.mdd)}（${st.mddWindow?.peakD} → ${st.mddWindow?.d}）`);
  console.log(`  同起点 QQQ  期末 ${usd(qqq.final)}  总收益 ${pct(qqq.totalRet)}  年化 ${pct(qqq.cagr)}  回撤 ${pct(qqq.mdd)}`);
  console.log(`  同起点 SPY  期末 ${usd(spy.final)}  总收益 ${pct(spy.totalRet)}  年化 ${pct(spy.cagr)}  回撤 ${pct(spy.mdd)}`);
}
console.log('\nS1 picks:', s1w.map(p => `${p.year} ${p.sym} ${(p.holdRet * 100).toFixed(0)}%`).join(', '));
const runs = [];
for (const l of s2iw) { const last = runs.at(-1); if (last && last.sym === l.sym) last.to = l.sellD; else runs.push({ sym: l.sym, from: l.buyD, to: l.sellD }); }
console.log('S2(idx) holdings:', runs.map(r => `${r.sym} ${r.from}→${realSell(r.to) || 'now'}`).join(' | '));
