// 期权策略"升级版"能否超过假设 20（TQQQ 买持 + 定投）？（用户 2026-10-25）
// 升级思路来自假设 12–19 的失败原因：平值 Call 时间价值高（约 0.37×股价）、换仓撞上暴跌会接近归零。
//   U1 深度实值 LEAPS：行权价 = 股价×0.6（Delta≈0.87，时间价值小、不会轻易归零），100% 资金
//   U2 平值 LEAPS（=假设 19 可执行版，但按实测期权链重新定价）
//   U3 80% TQQQ + 20% 深度实值 LEAPS，每次换仓时再平衡回 80/20
//   U4 80% TQQQ + 20% 平值 LEAPS（=假设 12 去掉择时信号）
//   U5 50% TQQQ + 50% 深度实值 LEAPS
// 期权定价按 2026-10-25 moomoo 实测 TQQQ 期权链校准：平值 IV ≈ 2.1×VXN，实值更高（K/S=0.6 时约 1.1 倍）；
//   单边价差深度实值 ≈ 2%、平值 ≈ 3–5%，默认 3%（另测 5%）；每张 $0.65。到期选当时最远的 1 月，到期前 91 天换仓。
// 定投：每月 3000 HKD 按目标比例分配，股票部分当天买整股，期权部分攒够 1 张再买（2010 前合成段按可分割）。
// 用法（backend/ 下）：node backtest/lab/upgrade-options.mjs
import { loadAll, calendar, bs, addDays, INIT, MONTHLY, COST } from './hypo10-13.mjs';
import { simH20, farJan, stats, END } from './hypo19-20.mjs';
import { synth2000 } from './synth.mjs';

const yf = (a, b) => (Date.parse(b) - Date.parse(a)) / (365 * 864e5);

export function simMix(D, end, { start, dca = true, w = 0, kRatio = 0.6, ivBase = 2.1, half = 0.03, fee = 0.65, rollDays = 91 } = {}) {
  const { days, bill } = calendar(D, end, start), T = D.px.TQQQ;
  const r = d => D.rf(d) / 100;
  const sig = (d, K, S) => Math.max(0.3, ivBase * D.vxn(d) / 100 * (K < S ? 1 + 0.25 * (1 - K / S) : 1));
  const val = (o, S, d, vd) => bs('c', S, o.K, yf(d, o.exp), r(d), sig(vd, o.K, S));
  let shares = 0, optCash = 0, stockCash = 0, opt = null, invested = INIT;
  const flows = [{ d: days[0], amt: -INIT }], curve = [];
  const ratio = d => { const x = T.get(d); return x.o ? x.o / x.ao : null; };
  const buyShares = d => {
    const x = T.get(d), rt = ratio(d);
    if (rt) { const nom = x.o * (1 + COST), k = Math.floor(stockCash / nom); shares += k * rt; stockCash -= k * nom; } // shares 以复权股计：名义股 × (名义价/复权价)
    else { shares += stockCash / (x.ao * (1 + COST)); stockCash = 0; }
  };
  const buyOpt = (d, vd) => {
    const S = T.get(d).ao, rt = ratio(d);
    if (!opt) {
      const exp = farJan(d);
      opt = { K: rt ? Math.max(1, Math.round(T.get(d).o * kRatio)) / rt : S * kRatio, exp, sellOn: addDays(exp, -rollDays), n: 0, mult: rt ? 100 * rt : null };
    }
    const ask = val(opt, S, d, vd) * (1 + half);
    if (opt.mult) { const per = ask * opt.mult + fee, k = Math.floor(optCash / per); if (k > 0) { opt.n += k * opt.mult; optCash -= k * per; } }
    else { opt.n += optCash / ask; optCash = 0; }
  };
  // 建仓
  stockCash = INIT * w; optCash = INIT * (1 - w);
  for (let i = 0; i < days.length; i++) {
    const d = days[i], prev = i ? days[i - 1] : d, S = T.get(d).ao, newMonth = i && d.slice(0, 7) !== prev.slice(0, 7);
    if (i) { const g = bill.get(d).ac / bill.get(prev).ac; optCash *= g; stockCash *= g; }
    if (opt && d >= opt.sellOn) { // 换仓：卖旧合约，按目标比例再平衡（混合版）
      const contracts = opt.mult ? opt.n / opt.mult : 0;
      optCash += Math.max(opt.n * val(opt, S, d, prev) * (1 - half) - contracts * fee, 0); opt = null;
      if (w > 0 && w < 1) {
        const total = optCash + stockCash + shares * S * (1 - COST), wantStock = total * w, stockVal = shares * S;
        if (stockVal > wantStock) { const sell = (stockVal - wantStock) / S; shares -= sell; optCash += sell * S * (1 - COST); }
        else { const move = Math.min(optCash, (wantStock - stockVal)); optCash -= move; stockCash += move; }
      }
    }
    if (dca && newMonth) { invested += MONTHLY; flows.push({ d, amt: -MONTHLY }); stockCash += MONTHLY * w; optCash += MONTHLY * (1 - w); }
    if (i === 0 || newMonth || !opt) { if (w > 0) buyShares(d); if (w < 1) buyOpt(d, i ? prev : d); }
    const c = T.get(d).ac;
    curve.push({ d, v: optCash + stockCash + shares * c + (opt ? opt.n * val(opt, c, d, d) : 0) });
  }
  return { ...stats(curve, flows, invested, {}), curve, dbg: { shares, optCash, stockCash, opt } };
}

import path from 'path';
import { fileURLToPath } from 'url';
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
export const V = [
  ['假设20 TQQQ 买持+定投（整股）', (D, o) => simH20(D, END, { ...o, whole: true })],
  ['U1 深度实值LEAPS 100%（K=0.6S）', (D, o) => simMix(D, END, { ...o, w: 0, kRatio: 0.6 })],
  ['U2 平值LEAPS 100%（K=1.02S，实测定价）', (D, o) => simMix(D, END, { ...o, w: 0, kRatio: 1.02 })],
  ['U3 TQQQ 80% + 深度实值LEAPS 20%', (D, o) => simMix(D, END, { ...o, w: 0.8, kRatio: 0.6 })],
  ['U4 TQQQ 80% + 平值LEAPS 20%', (D, o) => simMix(D, END, { ...o, w: 0.8, kRatio: 1.02 })],
  ['U5 TQQQ 50% + 深度实值LEAPS 50%', (D, o) => simMix(D, END, { ...o, w: 0.5, kRatio: 0.6 })],
];

if (IS_MAIN) {
const pct = x => `${(x * 100).toFixed(1)}%`, usd = x => `$${Math.round(x).toLocaleString('en-US')}`;
const D = await loadAll(), S = await synth2000(D);
for (const [title, DD, start] of [['A. 2010-04-01 起（真实数据）', D, '2010-04-01'], ['B. 2000-01-03 起（2010 前合成）', S, '2000-01-03']]) {
  console.log(`\n== ${title} → ${END}，$10,000 + 每月 3000 HKD，按期末总资产降序 ==`);
  V.map(([n, f]) => [n, f(DD, { start, dca: true })]).sort((a, b) => b[1].final - a[1].final).forEach(([n, r], i) =>
    console.log(`${i + 1}. ${n.padEnd(34)} 投入 ${usd(r.invested)} 期末 ${usd(r.final).padStart(12)} 总收益 ${usd(r.gain).padStart(12)} 年化 ${pct(r.ann).padStart(6)} 最大回撤 ${pct(r.mdd).padStart(7)} 低于投入最深 ${pct(r.belowWorst)} 最长 ${r.belowLongest.toFixed(1)}年`));
}
const starts = S.days.filter((d, i, a) => d <= '2016-10-31' && (i === 0 || d.slice(0, 7) !== a[i - 1].slice(0, 7)));
console.log(`\n== C. 起点平移（${starts.length} 个起点，定投到 ${END}）：年化 最差/中位，以及"期末超过假设20"的起点占比 ==`);
const base = starts.map(s => simH20(S, END, { start: s, dca: true, whole: true }).final);
for (const [n, f] of V) {
  const v = starts.map(s => f(S, { start: s, dca: true })), a = v.map(x => x.ann).sort((x, y) => x - y);
  const beat = v.filter((x, k) => x.final > base[k]).length / v.length;
  console.log(`${n.padEnd(34)} 最差 ${pct(a[0]).padStart(6)} 10%分位 ${pct(a[Math.floor(a.length * 0.1)]).padStart(6)} 中位 ${pct(a[Math.floor(a.length / 2)]).padStart(6)} 最好 ${pct(a.at(-1)).padStart(6)} | 超过假设20 ${pct(beat).padStart(6)}`);
}
console.log('\n== D. 价差敏感性（2000 起定投，单边价差 3% → 5%）==');
for (const [n, f] of V.slice(1)) {
  const a = f(S, { start: '2000-01-03', dca: true }), b = f(S, { start: '2000-01-03', dca: true, half: 0.05 });
  console.log(`${n.padEnd(34)} ${usd(a.final).padStart(12)} → ${usd(b.final).padStart(12)}`);
}
}
