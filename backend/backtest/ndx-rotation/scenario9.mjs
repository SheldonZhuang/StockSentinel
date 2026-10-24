// 假设 9（用户 2026-10-23）：假设 8 + 每月定投。2010-04-01 本金 $10,000 一次买入，之后每月首个交易日追加 3000 港元，
// 按同一方案的当日净值买入（等价于把新钱并入当前持仓，换仓时整体换），持有至今。
//   港元换美元：固定 7.8（联系汇率，2010 年以来在 7.75–7.85 区间，误差 <0.7%）
//   首笔定投在 2010-05（4 月已投本金）；定投当天按收盘净值成交
//   收益口径：总收益率 = 期末资产 / 累计投入 − 1；年化 = 资金加权 XIRR（定投场景下 CAGR 无意义）
// 用法（backend/ 下）：NDX_OFFLINE=1 node backtest/ndx-rotation/scenario9.mjs
import path from 'path';
import { fileURLToPath } from 'url';
import { readJSON } from './lib.mjs';
import { holdLeg, buyHold } from './engine.mjs';
import { tradingDays } from './calendar.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../../data/_ndx_rotation/out');
const S1 = (() => { const j = readJSON(path.join(OUT, 's1_result_pit.json')); return j.picks || j.legs; })();
const S2 = readJSON(path.join(OUT, 's2_result_idx.json')).legs;
const U = readJSON(path.join(OUT, 'universe.json')).years;

const INIT = 10000, MONTHLY = 3000 / 7.8;
const days = await tradingDays();
const START = days.find(d => d >= '2010-04-01');
const pct = x => `${(x * 100).toFixed(1)}%`;
const usd = x => `$${Math.round(x).toLocaleString('en-US')}`;
const realSell = d => (d && !String(d).includes('open') ? d : null);

function clip(legs) {
  const out = [];
  for (const l of legs) {
    const sell = realSell(l.sellD);
    if (sell && sell <= START) continue;
    out.push({ sym: l.sym, buyD: l.buyD < START ? START : l.buyD, sellD: sell });
  }
  return out;
}

/** 单位净值曲线（起点 1） */
async function navOf(legs) {
  let v = 1; const nav = new Map([[legs[0].buyD, 1]]);
  for (const l of legs) {
    const r = await holdLeg(l.sym, l.buyD, l.sellD, days);
    for (const p of r.daily) nav.set(p.d, v * p.v);
    v *= r.mult;
  }
  return nav;
}
const navBench = async sym => new Map((await buyHold(sym, START, days)).map(p => [p.d, p.v]));

function xirr(flows) {
  const t0 = Date.parse(flows[0].d);
  const f = r => flows.reduce((s, c) => s + c.amt / (1 + r) ** ((Date.parse(c.d) - t0) / (365.25 * 864e5)), 0);
  let lo = -0.99, hi = 5;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; f(m) > 0 ? (lo = m) : (hi = m); }
  return (lo + hi) / 2;
}

/** 定投模拟：持有"份额"，每月首个交易日按当日净值买入 */
function dca(nav) {
  const ds = [...nav.keys()].sort();
  let units = INIT / nav.get(ds[0]), invested = INIT, peak = 0, mdd = 0;
  const flows = [{ d: ds[0], amt: -INIT }];
  for (let i = 1; i < ds.length; i++) {
    const d = ds[i];
    if (d.slice(0, 7) !== ds[i - 1].slice(0, 7)) { units += MONTHLY / nav.get(d); invested += MONTHLY; flows.push({ d, amt: -MONTHLY }); }
    const val = units * nav.get(d);
    peak = Math.max(peak, val); mdd = Math.min(mdd, val / peak - 1);
  }
  const end = ds.at(-1), final = units * nav.get(end);
  flows.push({ d: end, amt: final });
  return { final, invested, totalRet: final / invested - 1, irr: xirr(flows), mdd, end, n: flows.length - 2 };
}

function s1With(energy) {
  return S1.map(p => {
    if (!energy.has(p.sym)) return p;
    const ranked = (U[String(p.year - 1)]?.all || []).filter(x => x.ret != null).sort((a, b) => b.ret - a.ret);
    return { ...p, sym: ranked.find(x => !energy.has(x.sym)).sym };
  });
}
if (S2.some(l => ['FANG', 'BKR', 'PTEN', 'ENPH', 'FSLR', 'SEDG'].includes(l.sym))) throw new Error('S2 holds an energy name');

const rows = [
  ['方案1 涨幅最大·GICS口径', dca(await navOf(clip(s1With(new Set(['FANG', 'BKR', 'PTEN']))))) ],
  ['方案1 涨幅最大·含太阳能', dca(await navOf(clip(s1With(new Set(['FANG', 'BKR', 'PTEN', 'ENPH', 'FSLR', 'SEDG']))))) ],
  ['方案2 最大权重股', dca(await navOf(clip(S2)))],
  ['方案3 全仓 TQQQ', dca(await navBench('TQQQ'))],
  ['方案4 全仓 SOXL', dca(await navBench('SOXL'))],
  ['基准 QQQ', dca(await navBench('QQQ'))],
  ['基准 SPY', dca(await navBench('SPY'))],
];
const r0 = rows[0][1];
console.log(`窗口 ${START} → ${r0.end}；本金 ${usd(INIT)} + 定投 ${r0.n} 期 × $${MONTHLY.toFixed(2)}（3000 HKD）；累计投入 ${usd(r0.invested)}`);
for (const [n, r] of rows) console.log(`${n.padEnd(18)} 期末 ${usd(r.final).padStart(12)}  总收益 ${pct(r.totalRet).padStart(9)}  年化(XIRR) ${pct(r.irr).padStart(6)}  账户最大回撤 ${pct(r.mdd)}`);
