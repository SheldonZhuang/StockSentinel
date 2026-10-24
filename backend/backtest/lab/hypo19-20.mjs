// 假设 19（滚动 TQQQ LEAPS Call + 定投）与假设 20（TQQQ 买持 + 定投）重测（用户 2026-10-24），数据到 2026-10-23。
// 假设 19 两个版本：
//   理论版：原规则（3 年期、行权价 102%、到期前 3 个月换仓），估值 IV = 3×VXN、买卖各 3%，可买零碎合约
//   可执行版：按 2026-10-24 moomoo 实测的 TQQQ 期权链修正——
//     ① 到期日：TQQQ 最远只有约 2.25 年的 1 月 LEAPS（实测最远 2029-01-19），规则改为"买当时可得最远的 1 月到期"
//        （每年 9 月挂出 Y+3 年 1 月；到期前 3 个月是 10 月，所以之后每次都是约 2.25 年期、持有约 2 年）
//     ② 隐含波动：实测 2029-01 平值附近 IV ≈ 59%，同日 VXN 28.7 → IV ≈ 2.1×VXN（敏感性另测 3×）
//     ③ 价差：实测买 23.0 / 卖 25.4，中间价 24.2，单边约 5%；每张另计 $0.65 费用（假设）
//     ④ 整数张：1 张 = 100 股，按名义股价计算（2010-02 起有真实名义价）；2010 前合成段无名义价，按可分割处理
//     ⑤ 定投：每月 3000 HKD 先进现金（国库券 BIL），够买 1 张时按当月首个交易日开盘买入同一张合约
// 假设 20：每月首个交易日开盘买 TQQQ；理论版可买零股，可执行版只买整股、零头留现金
// 用法（backend/ 下）：node backtest/lab/hypo19-20.mjs
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAll, calendar, bs, xirr, addDays, INIT, MONTHLY, COST } from './hypo10-13.mjs';
import { simLeaps } from './hypo14-19.mjs';
import { synth2000 } from './synth.mjs';

export const END = '2026-10-23';
const yf = (a, b) => (Date.parse(b) - Date.parse(a)) / (365 * 864e5);
const thirdFriday = (y, m) => { const dow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return `${y}-${String(m).padStart(2, '0')}-${String(1 + ((5 - dow + 7) % 7) + 14).padStart(2, '0')}`; };
/** 当天可买到的最远 1 月 LEAPS 到期日（9 月起挂出 Y+3 年 1 月） */
export const farJan = d => { const y = +d.slice(0, 4), m = +d.slice(5, 7); return thirdFriday(m >= 9 ? y + 3 : y + 2, 1); };

function stats(curve, flows, invested, extra) {
  const final = curve.at(-1).v;
  let peak = 0, mdd = 0, inv = INIT, below = 0, belowStart = null, belowLongest = 0;
  for (let i = 0; i < curve.length; i++) {
    const { d, v } = curve[i];
    if (i && d.slice(0, 7) !== curve[i - 1].d.slice(0, 7) && invested > INIT) inv += MONTHLY;
    peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); below = Math.min(below, v / inv - 1);
    if (v < inv) belowStart ??= d; else if (belowStart) { belowLongest = Math.max(belowLongest, yf(belowStart, d)); belowStart = null; }
  }
  if (belowStart) belowLongest = Math.max(belowLongest, yf(belowStart, curve.at(-1).d));
  const ann = xirr([...flows, { d: curve.at(-1).d, amt: final }]);
  return { end: curve.at(-1).d, final, invested, gain: final - invested, ret: final / invested - 1, ann, mdd, belowWorst: below, belowLongest, ...extra };
}

/** 假设 20：TQQQ 买持 + 定投。whole=true 只买整股（名义价），零头留国库券 */
export function simH20(D, end, { start, dca = true, whole = false } = {}) {
  const { days, bill } = calendar(D, end, start), T = D.px.TQQQ;
  let units = 0, cash = INIT, invested = INIT; const flows = [{ d: days[0], amt: -INIT }], curve = [];
  const buy = d => {
    const row = T.get(d), adjPx = row.ao * (1 + COST);
    if (whole && row.o) { const nomPx = row.o * (1 + COST), k = Math.floor(cash / nomPx); units += k * row.o / row.ao; cash -= k * nomPx; }
    else { units += cash / adjPx; cash = 0; }
  };
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (i) cash *= bill.get(d).ac / bill.get(days[i - 1]).ac;
    if (dca && i && d.slice(0, 7) !== days[i - 1].slice(0, 7)) { cash += MONTHLY; invested += MONTHLY; flows.push({ d, amt: -MONTHLY }); }
    if (i === 0 || (dca && d.slice(0, 7) !== days[i - 1].slice(0, 7))) buy(d);
    curve.push({ d, v: cash + units * T.get(d).ac });
  }
  return stats(curve, flows, invested, {});
}

/** 假设 19 可执行版（见文件头） */
export function simH19Exec(D, end, { start, dca = true, ivMult = 2.1, half = 0.05, fee = 0.65, strike = 1.02, log = null } = {}) {
  const { days, bill } = calendar(D, end, start), T = D.px.TQQQ;
  const sigma = d => Math.max(0.3, ivMult * D.vxn(d) / 100), r = d => D.rf(d) / 100;
  let cash = INIT, opt = null, invested = INIT, rolls = 0, idleDays = 0;
  const flows = [{ d: days[0], amt: -INIT }], curve = [];
  const mid = (o, S, d, vd) => bs('c', S, o.K, yf(d, o.exp), r(d), sigma(vd));
  const buy = (d, vd) => {
    const row = T.get(d), S = row.ao, ratio = row.o ? row.o / row.ao : null; // ratio：名义价/复权价
    if (!opt) {
      const exp = farJan(d);
      // 行权价取最接近 102% 的整数美元（名义）；合成段无名义价直接用 102%
      const K = ratio ? Math.max(1, Math.round(row.o * strike)) / ratio : S * strike;
      opt = { K, exp, sellOn: addDays(exp, -91), n: 0, mult: ratio ? 100 * ratio : null };
    }
    const unitAsk = mid(opt, S, d, vd) * (1 + half);
    if (opt.mult) { // 整数张
      const per = unitAsk * opt.mult + fee, k = Math.floor(cash / per);
      if (k > 0) { opt.n += k * opt.mult; cash -= k * per; log?.push({ d, act: 'buy', contracts: k, perContract: Math.round(per), exp: opt.exp, strikeNominal: Math.round(opt.K * ratio) }); }
    } else { opt.n += cash / unitAsk; cash = 0; }
  };
  for (let i = 0; i < days.length; i++) {
    const d = days[i], prev = i ? days[i - 1] : d, S = T.get(d).ao, newMonth = i && d.slice(0, 7) !== prev.slice(0, 7);
    if (i) cash *= bill.get(d).ac / bill.get(prev).ac;
    if (opt && d >= opt.sellOn) { // 到期前 3 个月：开盘卖出全部，同一开盘买入新合约
      const contracts = opt.mult ? opt.n / opt.mult : 0;
      const v = opt.n * mid(opt, S, d, prev) * (1 - half) - contracts * fee;
      log?.push({ d, act: 'sell', proceeds: Math.round(v) });
      cash += Math.max(v, 0); opt = null; rolls++;
    }
    if (dca && newMonth) { cash += MONTHLY; invested += MONTHLY; flows.push({ d, amt: -MONTHLY }); }
    if (i === 0 || newMonth || !opt || (opt && opt.n === 0)) buy(d, i ? prev : d);
    if (!opt || opt.n === 0) idleDays++;
    const c = T.get(d).ac;
    curve.push({ d, v: cash + (opt ? opt.n * mid(opt, c, d, d) : 0) });
  }
  return stats(curve, flows, invested, { rolls, idleShare: idleDays / days.length });
}

/** 理论版假设 19（复用 simLeaps）补上同一套统计 */
function simH19Theory(D, end, o) {
  const r = simLeaps(D, end, { years: 3, ...o });
  const flows = [{ d: r.curve[0].d, amt: -INIT }];
  if (o.dca) for (let i = 1; i < r.curve.length; i++) if (r.curve[i].d.slice(0, 7) !== r.curve[i - 1].d.slice(0, 7)) flows.push({ d: r.curve[i].d, amt: -MONTHLY });
  return stats(r.curve, flows, r.invested, { rolls: r.rolls });
}

export const VARIANTS = [
  ['假设19 理论版（3年期、IV 3×VXN、价差3%、可分割）', (D, o) => simH19Theory(D, END, o)],
  ['假设19 可执行版（最远1月LEAPS、IV 2.1×VXN、价差5%、整数张）', (D, o) => simH19Exec(D, END, o)],
  ['假设19 可执行版·IV 3×VXN（期权更贵的情形）', (D, o) => simH19Exec(D, END, { ...o, ivMult: 3 })],
  ['假设20 TQQQ 买持+定投（可买零股）', (D, o) => simH20(D, END, o)],
  ['假设20 TQQQ 买持+定投（只买整股）', (D, o) => simH20(D, END, { ...o, whole: true })],
];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pct = x => `${(x * 100).toFixed(1)}%`, usd = x => `$${Math.round(x).toLocaleString('en-US')}`;
  const D = await loadAll(), S = await synth2000(D);
  for (const [title, DD, start] of [['A. 2010-04-01 起（真实数据）', D, '2010-04-01'], ['B. 2000-01-03 起（TQQQ 2010-02 前合成）', S, '2000-01-03']]) {
    console.log(`\n== ${title} → ${END}，$10,000 + 每月 3000 HKD，按期末总资产降序 ==`);
    VARIANTS.map(([n, f]) => [n, f(DD, { start, dca: true })]).sort((a, b) => b[1].final - a[1].final).forEach(([n, r], i) =>
      console.log(`${i + 1}. ${n.padEnd(44)} 投入 ${usd(r.invested)}  期末 ${usd(r.final).padStart(12)}  总收益 ${usd(r.gain).padStart(12)}  总收益率 ${pct(r.ret).padStart(9)}  年化 ${pct(r.ann).padStart(6)}  最大回撤 ${pct(r.mdd)}  低于投入 最深 ${pct(r.belowWorst)} 最长 ${r.belowLongest.toFixed(1)} 年${r.rolls != null ? `  换仓 ${r.rolls}` : ''}${r.idleShare != null ? `  空仓等凑够1张 ${pct(r.idleShare)}` : ''}`));
  }
  // 起点平移：2000-01 → 2016-10 每月一个起点，定投到 END
  const starts = S.days.filter((d, i, a) => d <= '2016-10-31' && (i === 0 || d.slice(0, 7) !== a[i - 1].slice(0, 7)));
  console.log(`\n== C. 起点平移：${starts[0]} … ${starts.at(-1)} 每月一个起点（${starts.length} 个），定投到 ${END}（年化 XIRR）==`);
  for (const [n, f] of VARIANTS) {
    const v = starts.map(s => f(S, { start: s, dca: true })), a = v.map(x => x.ann).sort((x, y) => x - y), m = v.map(x => x.mdd).sort((x, y) => x - y);
    console.log(`${n.padEnd(44)} 最差 ${pct(a[0]).padStart(6)}  10%分位 ${pct(a[Math.floor(a.length * 0.1)]).padStart(6)}  中位 ${pct(a[Math.floor(a.length / 2)]).padStart(6)}  最好 ${pct(a.at(-1)).padStart(6)}  亏本起点 ${pct(v.filter(x => x.final < x.invested).length / v.length)}  回撤中位 ${pct(m[Math.floor(m.length / 2)])}`);
  }
  const log = []; simH19Exec(D, END, { start: '2010-04-01', log });
  console.log('\n假设19 可执行版 2010 起 前 12 笔与最近 6 笔动作：'); for (const l of [...log.slice(0, 12), { d: '…' }, ...log.slice(-6)]) console.log(' ', l.d, l.act ?? '', l.contracts ? `${l.contracts} 张 × $${l.perContract} 到期 ${l.exp} 行权≈$${l.strikeNominal}` : l.proceeds != null ? `卖得 $${l.proceeds.toLocaleString()}` : '');
}
