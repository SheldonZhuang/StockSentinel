// 假设 19 / 20 / 21 同口径综合比较（用户 2026-10-25）。三者用同一套引擎与期权定价（upgrade-options.mjs 的 simMix，按 10-25 实测期权链校准）：
//   假设19 = 100% 平值 LEAPS（K≈1.02S，最远到期 >2 年，到期前 91 天换仓）
//   假设20 = 100% TQQQ 整股买持
//   假设21 = 80% TQQQ + 20% 平值 LEAPS，换仓时再平衡回 80/20
// 资金：$10,000 + 每月 3000 HKD（另给一次性 $10,000 对照）。数据到 2026-10-23；2010-02 前 TQQQ 为合成。
// 用法（backend/ 下）：node backtest/lab/compare19-21.mjs
import { loadAll } from './hypo10-13.mjs';
import { simH20, END } from './hypo19-20.mjs';
import { synth2000 } from './synth.mjs';
import { simMix } from './upgrade-options.mjs';

const H = [
  ['假设19 平值LEAPS 100%', (D, o) => simMix(D, END, { ...o, w: 0, kRatio: 1.02 })],
  ['假设20 TQQQ 买持', (D, o) => simH20(D, END, { start: o.start, dca: o.dca, whole: true })],
  ['假设21 TQQQ 80% + 平值LEAPS 20%', (D, o) => simMix(D, END, { ...o, w: 0.8, kRatio: 1.02 })],
];
const pct = x => `${(x * 100).toFixed(1)}%`, usd = x => `$${Math.round(x).toLocaleString('en-US')}`;
const D = await loadAll(), S = await synth2000(D);

for (const dca of [true, false]) {
  for (const [title, DD, start] of [['2010-04-01 起', D, '2010-04-01'], ['2000-01-03 起', S, '2000-01-03'], ['2000-03-10 科网顶起', S, '2000-03-10'], ['2007-10-31 次贷前顶起', S, '2007-10-31'], ['2021-11-19 加息前顶起', S, '2021-11-19']]) {
    console.log(`\n== ${dca ? '定投' : '一次性'} · ${title}（按期末总资产降序）==`);
    H.map(([n, f]) => [n, f(DD, { start, dca })]).sort((a, b) => b[1].final - a[1].final).forEach(([n, r], i) =>
      console.log(`${i + 1}|${n}|${usd(r.invested)}|${usd(r.final)}|${usd(r.gain)}|${pct(r.ret)}|${pct(r.ann)}|${pct(r.mdd)}|${pct(r.belowWorst)}|${r.belowLongest.toFixed(1)}`));
  }
}
const starts = S.days.filter((d, i, a) => d <= '2016-10-31' && (i === 0 || d.slice(0, 7) !== a[i - 1].slice(0, 7)));
console.log(`\n== 起点平移（${starts.length} 个，定投到 ${END}）==`);
const res = H.map(([n, f]) => [n, starts.map(s => f(S, { start: s, dca: true }))]);
for (const [n, v] of res) {
  const a = v.map(x => x.ann).sort((x, y) => x - y), fin = v.map(x => x.final).sort((x, y) => x - y), m = v.map(x => x.mdd).sort((x, y) => x - y);
  const firsts = starts.filter((_, k) => res.every(([n2, v2]) => n2 === n || v[k].final >= v2[k].final)).length;
  console.log(`${n}|${pct(a[0])}|${pct(a[Math.floor(a.length / 2)])}|${pct(a.at(-1))}|${usd(fin[Math.floor(fin.length / 2)])}|${pct(m[Math.floor(m.length / 2)])}|${pct(firsts / starts.length)}|${pct(v.filter(x => x.final < x.invested).length / v.length)}`);
}
console.log('\n== 期权假设敏感性（2000 起定投期末；IV 倍数 × 单边价差）==');
for (const [n, f] of H) console.log(n + '|' + [[2.1, 0.03], [2.1, 0.05], [2.5, 0.04], [3.0, 0.04]].map(([iv, h]) => `${iv}×/${h * 100}%: ${usd(f(S, { start: '2000-01-03', dca: true, ivBase: iv, half: h }).final)}`).join(' | '));
