// 模拟盘五个策略同口径回测（用户 2026-10-26）：$51,000 + 每月 3000 HKD，数据到 2026-10-23，按实盘规则：
//   假设19 100% 平值远月 Call；假设20 TQQQ 整股买持；假设21 80% TQQQ + 20% 平值远月 Call（换仓再平衡）
//   假设22 TQQQ 按波动调仓位（目标 80%、最多 1.2 倍、融资 rf+2.5%、权益/持仓 <75% 强平）
//   假设23 MNQ 期货按波动调仓位（目标 60%、最多 4 倍 QQQ、整张粒度、保证金现金不计息、维持保证金 12%）
// 期权定价按 10-25 实测期权链校准（IV 2.1×VXN、价差 3%）。19/20/21 用开盘成交的账户模拟，22/23 用实验室引擎（次日收盘成交）。
// 用法（backend/ 下）：node backtest/lab/compare19-23.mjs
import { loadAll, xirr } from './hypo10-13.mjs';
import { simH20, END } from './hypo19-20.mjs';
import { synth2000 } from './synth.mjs';
import { simMix } from './upgrade-options.mjs';
import { loadPanel } from './data.mjs';
import { backtest } from './engine.mjs';
import * as S from './strategies.mjs';

const INIT = 51000, M = 3000 / 7.8;
const usd = x => `$${Math.round(x).toLocaleString('en-US')}`, pct = x => `${(x * 100).toFixed(1)}%`;
const D = await loadAll(), SY = await synth2000(D);
const P = await loadPanel(['QQQ', 'TQQQ'], { from: '1999-01-01', extend: true });

function labAccount(mk, o, start, dca, noInterest) {
  const r = backtest(P, mk(), { start, end: END, ...o });
  let u = INIT / r.curve[0], inv = INIT, adj = 1, peak = 0, mdd = 0, below = 0, bStart = null, bLong = 0;
  const fl = [{ d: r.dates[0], amt: -INIT }];
  for (let i = 0; i < r.dates.length; i++) {
    if (i && noInterest) adj *= 1 - r.rf[i];
    if (i && dca && r.dates[i].slice(0, 7) !== r.dates[i - 1].slice(0, 7)) { u += M / (r.curve[i] * adj); inv += M; fl.push({ d: r.dates[i], amt: -M }); }
    const v = u * r.curve[i] * adj; peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); below = Math.min(below, v / inv - 1);
    if (v < inv) bStart ??= r.dates[i]; else if (bStart) { bLong = Math.max(bLong, (Date.parse(r.dates[i]) - Date.parse(bStart)) / 3.156e10); bStart = null; }
  }
  if (bStart) bLong = Math.max(bLong, (Date.parse(r.dates.at(-1)) - Date.parse(bStart)) / 3.156e10);
  const final = u * r.curve.at(-1) * adj;
  const ann = dca ? xirr([...fl, { d: r.dates.at(-1), amt: final }]) : (final / INIT) ** (1 / ((Date.parse(r.dates.at(-1)) - Date.parse(r.dates[0])) / 3.156e10)) - 1;
  return { final, invested: inv, gain: final - inv, ret: final / inv - 1, ann, mdd, belowWorst: below, belowLongest: bLong, marginCalls: r.marginCalls };
}
const H22 = () => S.volTarget({ risk: 'TQQQ', target: 0.8, lookback: 20, cap: 1.2, step: 0.1 });
const H23 = () => S.volTarget({ risk: 'QQQ', target: 0.6, lookback: 20, cap: 4, step: 1.0 });
const V = [
  ['假设19 远月Call 100%', (DD, o) => simMix(DD, END, { init: INIT, ...o, w: 0, kRatio: 1.02 })],
  ['假设20 TQQQ 买持', (DD, o) => simH20(DD, END, { start: o.start, dca: o.dca, whole: true, init: INIT })],
  ['假设21 TQQQ80%+Call20%', (DD, o) => simMix(DD, END, { init: INIT, ...o, w: 0.8, kRatio: 1.02 })],
  ['假设22 TQQQ 波动调仓 ≤1.2倍', (DD, o) => labAccount(H22, { borrowSpread: 2.5, maint: 0.75 }, o.start === '2000-01-03' ? P.dates[260] : o.start, o.dca, false)],
  ['假设23 MNQ期货 波动调仓 ≤4倍', (DD, o) => labAccount(H23, { maint: 0.12 }, o.start === '2000-01-03' ? P.dates[260] : o.start, o.dca, true)],
];
const show = (title, rows) => {
  console.log(`\n== ${title}（按期末总资产降序）==`);
  rows.sort((a, b) => b[1].final - a[1].final).forEach(([n, r], i) => console.log(`${i + 1}|${n}|${usd(r.invested)}|${usd(r.final)}|${usd(r.gain)}|${pct(r.ret)}|${pct(r.ann)}|${pct(r.mdd)}|${r.belowLongest?.toFixed(1) ?? '-'}`));
};
for (const dca of [true, false]) for (const [t, DD, st] of [['2010-04-01 起', D, '2010-04-01'], ['2000 起（2000-03 后的熊市在内）', SY, '2000-01-03'], ['2007-10-31 次贷前顶起', SY, '2007-10-31'], ['2021-11-19 加息前顶起', SY, '2021-11-19']])
  show(`${dca ? '定投' : '一次性'} · ${t}`, V.map(([n, f]) => [n, f(DD, { start: st, dca })]));
const starts = SY.days.filter((d, i, a) => d >= '2000-04-01' && d <= '2016-10-31' && (i === 0 || d.slice(0, 7) !== a[i - 1].slice(0, 7))).filter((_, k) => k % 2 === 0);
console.log(`\n== 起点平移（${starts.length} 个，定投到 ${END}）：年化 最差 / 中位 / 最好 | 期末中位 | 第一名占比 ==`);
const res = V.map(([n, f]) => [n, starts.map(s => f(SY, { start: s, dca: true }))]);
for (const [n, v] of res) {
  const a = v.map(x => x.ann).sort((x, y) => x - y), fin = v.map(x => x.final).sort((x, y) => x - y);
  const firsts = starts.filter((_, k) => res.every(([n2, v2]) => n2 === n || v[k].final >= v2[k].final)).length;
  console.log(`${n}|${pct(a[0])}|${pct(a[Math.floor(a.length / 2)])}|${pct(a.at(-1))}|${usd(fin[Math.floor(fin.length / 2)])}|${pct(firsts / starts.length)}`);
}
