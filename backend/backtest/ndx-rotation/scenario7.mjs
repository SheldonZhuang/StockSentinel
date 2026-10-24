// 假设 7（用户 2026-10-23）：2010-04-01 至今，本金 $10,000，四个方案同一起点。
//   方案1 涨幅最大个股循环法：起点当天买入"2010 年的选股"（= 2009 年回报冠军），持有到 2011 年首个交易日，之后照常每年换仓
//   方案2 最大权重股循环法：起点当天买入"当时在任的最大权重股"（上一次调仓选出的那只），持有到下一次调仓后换仓，之后照常
//   方案3 全仓 TQQQ、方案4 全仓 SOXL：起点开盘买入持有
// 四个方案都在同一天、同一价格口径（开盘价，Tiingo adjOpen/adjClose 总回报）起步，结果可直接比较。
// 用法（backend/ 下）：NDX_OFFLINE=1 node backtest/ndx-rotation/scenario7.mjs
import path from 'path';
import { fileURLToPath } from 'url';
import { readJSON } from './lib.mjs';
import { holdLeg, buyHold, stats } from './engine.mjs';
import { tradingDays } from './calendar.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../../data/_ndx_rotation/out');
const S1 = (() => { const j = readJSON(path.join(OUT, 's1_result_pit.json')); return j.picks || j.legs; })();
const S2 = readJSON(path.join(OUT, 's2_result_idx.json')).legs;

const days = await tradingDays();
const START = days.find(d => d >= '2010-04-01');
const end = days.at(-1);
const pct = x => `${(x * 100).toFixed(1)}%`;
const usd = x => `$${Math.round(x).toLocaleString('en-US')}`;
const realSell = d => (d && !String(d).includes('open') ? d : null);

/** 从 START 起截取持仓序列：起点所在的那一段从 START 开始，之后各段照旧 */
function clip(legs) {
  const out = [];
  for (const l of legs) {
    const sell = realSell(l.sellD);
    if (sell && sell <= START) continue;
    out.push({ sym: l.sym, buyD: l.buyD < START ? START : l.buyD, sellD: sell });
  }
  return out;
}

async function run(legs) {
  let v = 10000;
  const curve = [{ d: legs[0].buyD, v }];
  for (const l of legs) {
    const r = await holdLeg(l.sym, l.buyD, l.sellD, days);
    for (const p of r.daily) if (p.d !== curve.at(-1).d) curve.push({ d: p.d, v: v * p.v });
    v *= r.mult;
  }
  return stats(curve);
}
const bench = async sym => stats((await buyHold(sym, START, days)).map(p => ({ d: p.d, v: p.v * 10000 })));

// 假设 8 = 假设 7 + "能源股踢掉，选第二顺位"：`--exclude-energy=gics|broad`。
// 2010 年以来 S1 的选股里只有 2023 年 ENPH（GICS 信息技术/太阳能设备）可能被视为能源股；S2 从未持有能源股
const EX = process.argv.find(a => a.startsWith('--exclude-energy='))?.split('=')[1];
const ENERGY = { gics: new Set(['FANG', 'BKR', 'PTEN']), broad: new Set(['FANG', 'BKR', 'PTEN', 'ENPH', 'FSLR', 'SEDG']) }[EX] || new Set();
const U = readJSON(path.join(OUT, 'universe.json')).years;
const s1Src = S1.map(p => {
  if (!ENERGY.has(p.sym)) return p;
  const ranked = (U[String(p.year - 1)]?.all || []).filter(x => x.ret != null).sort((a, b) => b.ret - a.ret);
  const alt = ranked.find(x => !ENERGY.has(x.sym));
  console.log(`能源股剔除：${p.year} ${p.sym} → ${alt.sym}`);
  return { ...p, sym: alt.sym };
});
if (S2.some(l => ENERGY.has(l.sym))) throw new Error('S2 holds an energy name — second-rank fallback not implemented');
const s1 = clip(s1Src);
const s2 = clip(S2);
const rows = [
  ['方案1 涨幅最大个股循环法', await run(s1)],
  ['方案2 最大权重股循环法', await run(s2)],
  ['方案3 全仓 TQQQ', await bench('TQQQ')],
  ['方案4 全仓 SOXL', await bench('SOXL')],
  ['基准 QQQ', await bench('QQQ')],
  ['基准 SPY', await bench('SPY')],
];
console.log(`窗口 ${START} → ${end}`);
for (const [n, st] of rows) {
  console.log(`${n.padEnd(16)} 期末 ${usd(st.final).padStart(11)}  总收益 ${pct(st.totalRet).padStart(9)}  年化 ${pct(st.cagr).padStart(6)}  最大回撤 ${pct(st.mdd)}（${st.mddWindow?.peakD} → ${st.mddWindow?.d}）`);
}
console.log('方案1 持仓:', s1.map(l => `${l.buyD.slice(0, 4)} ${l.sym}`).join(', '));
const runs = [];
for (const l of s2) { const last = runs.at(-1); if (last && last.sym === l.sym) last.to = l.sellD; else runs.push({ sym: l.sym, from: l.buyD, to: l.sellD }); }
console.log('方案2 持仓:', runs.map(r => `${r.sym} ${r.from}→${r.to || '至今'}`).join(' | '));
