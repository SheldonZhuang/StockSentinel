// 本金规模对假设 19/20/21 的影响（用户 2026-10-25）：本金 $1 万 / $1.3 万 / $2 万 / $5 万 / $10 万，定投都是每月 3000 HKD。
// 关心两件事：①第一张 Call 要等多久（期权只能整张买）②本金变大后假设 21 是否仍领先假设 20。
// 用法（backend/ 下）：node backtest/lab/principal-size.mjs
import { loadAll } from './hypo10-13.mjs';
import { simH20, END } from './hypo19-20.mjs';
import { synth2000 } from './synth.mjs';
import { simMix } from './upgrade-options.mjs';

const usd = x => `$${Math.round(x).toLocaleString('en-US')}`, pct = x => `${(x * 100).toFixed(1)}%`;
const D = await loadAll(), S = await synth2000(D);
const SIZES = [10000, 13000, 20000, 50000, 100000];
const starts = S.days.filter((d, i, a) => d <= '2016-10-31' && (i === 0 || d.slice(0, 7) !== a[i - 1].slice(0, 7))).filter((_, k) => k % 2 === 0);
console.log(`起点平移样本：${starts.length} 个（2000-01 → 2016-10，每 2 个月一个）`);
for (const init of SIZES) {
  const run = (DD, start) => ({
    h19: simMix(DD, END, { start, dca: true, w: 0, kRatio: 1.02, init }),
    h20: simH20(DD, END, { start, dca: true, whole: true, init }),
    h21: simMix(DD, END, { start, dca: true, w: 0.8, kRatio: 1.02, init }),
  });
  const a = run(D, '2010-04-01'), b = run(S, '2000-01-03');
  const roll = starts.map(s => run(S, s));
  const beat = roll.filter(r => r.h21.final > r.h20.final).length / roll.length;
  const ratio = roll.map(r => r.h21.final / r.h20.final).sort((x, y) => x - y);
  console.log(`\n本金 ${usd(init)}（20% = ${usd(init * 0.2)}）`);
  console.log(`  2010 起期末  H21 ${usd(a.h21.final)} | H20 ${usd(a.h20.final)} | H19 ${usd(a.h19.final)}   H21/H20 = ${(a.h21.final / a.h20.final).toFixed(2)}×`);
  console.log(`  2000 起期末  H21 ${usd(b.h21.final)} | H20 ${usd(b.h20.final)} | H19 ${usd(b.h19.final)}   H21/H20 = ${(b.h21.final / b.h20.final).toFixed(2)}×`);
  console.log(`  起点平移：H21 超过 H20 的起点 ${pct(beat)}；H21/H20 倍数 最低 ${ratio[0].toFixed(2)}× 中位 ${ratio[Math.floor(ratio.length / 2)].toFixed(2)}×；H21 最大回撤（2000 起）${pct(b.h21.mdd)} vs H20 ${pct(b.h20.mdd)}`);
}
