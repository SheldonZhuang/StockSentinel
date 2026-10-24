// 汇总表前三名的两项稳健性检验（用户 2026-10-24）：
//   A 一次性前三 = 假设16（滚动 2 年期 Call）、假设18（滚动 3 年期 Call）、全仓 TQQQ
//   B 定投前三   = 假设17、假设19、全仓 TQQQ+定投 —— 同样三个策略的定投版，所以合并测 3 个策略 × 2 种资金方式
// 检验 1 起点平移：2010-04 起到"末日前 5 年"每月一个起点，各自持有到 2026-10-21，看年化分布与亏本比例
// 检验 2 从 2000-01-03 起：TQQQ 2010-02 前用 QQQ 日收益合成（3×r − 2×(rf+0.6%) − 0.86% 费率，与实验室校准一致）；
//   合成开盘价 = 前一合成收盘 × (1 + 3×QQQ 隔夜涨跌)；期权估值同前，VXN 2001-02 前用 QQQ 20 日已实现波动×1.2 代替
// 用法（backend/ 下）：node backtest/lab/robust-top3.mjs
import { loadAll, xirr, INIT, MONTHLY, COST } from './hypo10-13.mjs';
import { simLeaps } from './hypo14-19.mjs';
import { synth2000 } from './synth.mjs';

const END = '2026-10-21';
const pct = x => `${(x * 100).toFixed(1)}%`, usd = x => `$${Math.round(x).toLocaleString('en-US')}`;

/** 全仓 TQQQ 买持（开盘买入、收盘估值、定投在每月首个交易日开盘买入），与 simLeaps 同一日历与结算口径 */
function simHold(D, end, { start, dca = false }) {
  const days = (D.days || [...D.px.TQQQ.keys()]).filter(d => d >= start && d <= end && D.px.TQQQ.has(d)).sort();
  const T = D.px.TQQQ;
  let units = INIT * (1 - COST) / T.get(days[0]).ao, invested = INIT, maxV = 0, mdd = 0;
  const flows = [{ d: days[0], amt: -INIT }];
  for (let i = 1; i < days.length; i++) {
    const d = days[i];
    if (dca && d.slice(0, 7) !== days[i - 1].slice(0, 7)) { units += MONTHLY * (1 - COST) / T.get(d).ao; invested += MONTHLY; flows.push({ d, amt: -MONTHLY }); }
    const v = units * T.get(d).ac; maxV = Math.max(maxV, v); mdd = Math.min(mdd, v / maxV - 1);
  }
  const final = units * T.get(days.at(-1)).ac, yrs = (Date.parse(days.at(-1)) - Date.parse(days[0])) / (365.25 * 864e5);
  const ann = dca ? xirr([...flows, { d: days.at(-1), amt: final }]) : (final / INIT) ** (1 / yrs) - 1;
  return { final, invested, gain: final - invested, ret: final / invested - 1, ann, mdd };
}

const STRATS = [
  ['滚动 2 年期 Call（假设16/17）', (D, o) => simLeaps(D, END, { years: 2, ...o })],
  ['滚动 3 年期 Call（假设18/19）', (D, o) => simLeaps(D, END, { years: 3, ...o })],
  ['全仓 TQQQ（假设8/9-3）', (D, o) => simHold(D, END, o)],
];

const D = await loadAll();

// ---------- 检验 1：起点平移 ----------
const starts = [...D.px.TQQQ.keys()].sort().filter((d, i, a) => d >= '2010-04-01' && d <= '2021-10-21' && (i === 0 || d.slice(0, 7) !== a[i - 1].slice(0, 7)));
console.log(`== 检验 1：起点平移（${starts[0]} … ${starts.at(-1)}，每月一个起点共 ${starts.length} 个，都持有到 ${END}）==`);
console.log(`${'策略'.padEnd(26)} 资金      年化: 最差     10%分位   中位     最好   | 期末低于投入的起点占比  最差起点`);
const shift = {};
for (const [name, f] of STRATS) for (const dca of [false, true]) {
  const r = starts.map(s => [s, f(D, { start: s, dca })]);
  const a = r.map(x => x[1].ann).sort((x, y) => x - y);
  const lose = r.filter(x => x[1].final < x[1].invested).length / r.length;
  const worst = r.reduce((m, x) => (x[1].ann < m[1].ann ? x : m));
  shift[name + dca] = { min: a[0], p10: a[Math.floor(a.length * 0.1)], med: a[Math.floor(a.length / 2)], max: a.at(-1), lose };
  console.log(`${name.padEnd(26)} ${dca ? '定投  ' : '一次性'}  ${pct(a[0]).padStart(8)} ${pct(a[Math.floor(a.length * 0.1)]).padStart(9)} ${pct(a[Math.floor(a.length / 2)]).padStart(8)} ${pct(a.at(-1)).padStart(8)} | ${pct(lose).padStart(8)}               ${worst[0]}（期末 ${usd(worst[1].final)}）`);
}

// ---------- 检验 2：从 2000 年起 ----------
const S = await synth2000(D);
console.log(`\n== 检验 2：从 2000-01-03 起至 ${END}（TQQQ 2010-02 前为合成；本金 $10,000 / 定投每月 3000 HKD）==`);
const y2k = [];
for (const [name, f] of STRATS) for (const dca of [false, true]) {
  const r = f(S, { start: '2000-01-03', dca });
  y2k.push([`${name}${dca ? ' + 定投' : ''}`, r, dca]);
}
for (const k of [false, true]) {
  console.log(`\n${k ? 'B. 定投' : 'A. 一次性'}（按总收益降序）`);
  y2k.filter(x => x[2] === k).sort((a, b) => b[1].gain - a[1].gain).forEach(([n, r], i) =>
    console.log(`  ${i + 1}. ${n.padEnd(30)} 投入 ${usd(r.invested).padStart(9)}  期末 ${usd(r.final).padStart(12)}  总收益 ${usd(r.gain).padStart(12)}  总收益率 ${pct(r.ret).padStart(9)}  年化 ${pct(r.ann).padStart(6)}  最大回撤 ${pct(r.mdd)}`));
}
// 2000–2002 发生了什么：合成 TQQQ 与各策略在 2003-01-02 时的资产
console.log('\n2000-01 起到 2003-01-02 的账户（一次性 $10,000）：');
for (const [name, f] of STRATS) { const r = f({ ...S, days: S.days.filter(d => d <= '2003-01-02') }, { start: '2000-01-03' }); console.log(`  ${name.padEnd(28)} ${usd(r.final)}（最大回撤 ${pct(r.mdd)}）`); }

// 定投口径对照：新钱"当天加仓同一张合约"（默认）vs"存国库券、下次换仓时一起买新合约"
// 默认口径在合约深度虚值时会用很低的价格买入大量合约（类似买彩票），可能高估结果
console.log('\n定投口径对照（2010-04 起 / 2000-01 起，期末总资产）：');
for (const y of [2, 3]) {
  const a = simLeaps(D, END, { years: y, dca: true }), b = simLeaps(D, END, { years: y, dca: true, dcaMode: 'nextRoll' });
  const a0 = simLeaps(S, END, { years: y, dca: true, start: '2000-01-03' }), b0 = simLeaps(S, END, { years: y, dca: true, start: '2000-01-03', dcaMode: 'nextRoll' });
  console.log(`  ${y}年期  2010起：当天加仓 ${usd(a.final)}（${pct(a.ann)}） / 换仓时再买 ${usd(b.final)}（${pct(b.ann)}）   2000起：当天加仓 ${usd(a0.final)}（${pct(a0.ann)}） / 换仓时再买 ${usd(b0.final)}（${pct(b0.ann)}）`);
}
