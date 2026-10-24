// 用户 2026-10-23 的假设 1–6：两个窗口（2000 至今 / 最近 20 年）× 是否剔除能源股。
// 复用全期回测的选股排序（out/universe.json 每年全部成员的上一年回报）与 S2 持仓序列（out/s2_result_idx.json），
// 同一引擎逐日重算净值。
// 能源股判定（两种口径都给）：
//   GICS：能源板块（石油/天然气/油服/煤）——NDX 成员里出现过的：FANG、BKR、PTEN、FWLT（工程，非能源，不计）……
//   宽口径：GICS 能源 + 太阳能/清洁能源设备（ENPH、FSLR、SEDG）
// 用法（backend/ 下）：NDX_OFFLINE=1 node backtest/ndx-rotation/scenarios.mjs
import path from 'path';
import { fileURLToPath } from 'url';
import { readJSON } from './lib.mjs';
import { holdLeg, buyHold, stats } from './engine.mjs';
import { tradingDays } from './calendar.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../../data/_ndx_rotation/out');
const U = readJSON(path.join(OUT, 'universe.json')).years;
const S2 = readJSON(path.join(OUT, 's2_result_idx.json'));

// GICS 能源板块（曾在 NDX 中的代码；FWLT Foster Wheeler 是工程建设，GICS 归工业，不计入）
const ENERGY_GICS = new Set(['FANG', 'BKR', 'PTEN', 'XOM', 'CVX', 'COP', 'EOG', 'OXY', 'SLB', 'HAL', 'MPC', 'PSX', 'VLO', 'APA', 'DVN', 'CEG']);
const ENERGY_BROAD = new Set([...ENERGY_GICS, 'ENPH', 'FSLR', 'SEDG', 'PLUG', 'RUN']);

const days = await tradingDays();
const end = days.at(-1);
const firstDay = y => days.find(d => d.startsWith(String(y)));
const lastY = +end.slice(0, 4);
const win20 = `${lastY - 20}${end.slice(4)}`;
const pct = x => `${(x * 100).toFixed(1)}%`;
const usd = x => `$${Math.round(x).toLocaleString('en-US')}`;

/** S1 每年的选股：Y-1 年回报最高、且不在剔除集合里的成员 */
function s1Picks(exclude) {
  const picks = [];
  for (let y = 2000; y <= lastY; y++) {
    const o = U[String(y - 1)];
    const ranked = (o?.all || o?.top || []).filter(x => x.ret != null).sort((a, b) => b.ret - a.ret);
    const pick = ranked.find(x => !exclude.has(x.sym));
    const skipped = ranked.slice(0, ranked.indexOf(pick)).map(x => x.sym);
    const buyD = firstDay(y);
    const sellD = y < lastY ? firstDay(y + 1) : null;
    picks.push({ year: y, sym: pick.sym, prior: pick.ret, buyD, sellD, skipped });
  }
  return picks;
}

/** S2 持仓：剔除集合里的名字由第二顺位顶替（全期没有出现能源股时与原序列相同） */
function s2Legs(exclude) {
  const hit = S2.legs.filter(l => exclude.has(l.sym));
  if (hit.length) throw new Error(`S2 has excluded names ${hit.map(l => l.sym)} — second-rank fallback not implemented`);
  return S2.legs.map(l => ({ sym: l.sym, buyD: l.buyD, sellD: l.sellD && !String(l.sellD).includes('open') ? l.sellD : null }));
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
async function bench(sym, d0) {
  return stats((await buyHold(sym, d0, days)).map(p => ({ d: p.d, v: p.v * 10000 })));
}

const line = (name, st) => `  ${name.padEnd(26)} ${st.from} → ${st.to}  期末 ${usd(st.final).padStart(10)}  总收益 ${pct(st.totalRet).padStart(9)}  年化 ${pct(st.cagr).padStart(6)}  最大回撤 ${pct(st.mdd)}`;

for (const [title, from] of [['2000 年至今', '2000-01-01'], ['最近 20 年', win20]]) {
  console.log(`\n===== ${title}（窗口起点 ${from}）=====`);
  for (const [exName, ex] of [['不剔除', new Set()], ['剔除能源股·GICS口径', ENERGY_GICS], ['剔除能源股·含太阳能', ENERGY_BROAD]]) {
    const p1 = s1Picks(ex).filter(p => p.buyD >= from);
    const l2 = s2Legs(ex).filter(l => l.buyD >= from);
    const st1 = await run(p1);
    const st2 = await run(l2);
    console.log(`[${exName}]`);
    console.log(line('方案1 涨幅最大个股循环法', st1));
    console.log(line('方案2 最大权重股循环法', st2));
    const changed = p1.filter(p => p.skipped.length);
    if (changed.length) console.log('  方案1 被剔除后改选：', changed.map(p => `${p.year} 踢掉 ${p.skipped.join('/')} → ${p.sym}`).join('；'));
  }
  const d0 = s1Picks(new Set()).find(p => p.buyD >= from).buyD;
  const q = await bench('QQQ', d0);
  const s = await bench('SPY', d0);
  console.log('[基准，与方案1同起点]');
  console.log(line('QQQ 买入持有', q));
  console.log(line('SPY 买入持有', s));
}
