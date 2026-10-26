// 假设 22（融资融券账户）/ 假设 23（期货账户）候选策略回测（用户 2026-10-26："不限策略，尽可能赚钱"）。
// 统一：$51,000 + 每月 3000 HKD，2000-01 起（2010 前合成），收盘信号次日成交、5bp、现金按 3 个月国库券。
// 融资：借入部分付 rf + 2.5%/年；维持保证金 30%（权益/持仓 < 30% → 强制砍回 1 倍，模拟追保强平）。
// 期货：NQ/MNQ 的隐含融资≈rf（基差），所以"N 倍 QQQ"按 N×QQQ 日收益 − (N−1)×rf 建模，不加利差；滚动成本每季约 2bp 忽略。
//   期货维持保证金按约 1/8 名义（NQ 约 12–14%）→ 权益/名义 < 12% 强平。
// 用法（backend/ 下）：node backtest/lab/hypo22-23.mjs
import { loadPanel } from './data.mjs';
import { backtest } from './engine.mjs';
import * as S from './strategies.mjs';
import { xirr } from './hypo10-13.mjs';

const INIT = 51000, MONTHLY = 3000 / 7.8, END = '2026-10-23';
const usd = x => `$${Math.round(x).toLocaleString('en-US')}`, pct = x => `${(x * 100).toFixed(1)}%`;
// 不放 GLD：面板取所有标的共同日期，GLD 2004-11 才上市会把起点推到 2005，丢掉 2000–02 熊市
const P = await loadPanel(['QQQ', 'TQQQ'], { from: '1999-01-01', extend: true });
console.log(`面板 ${P.dates[0]} → ${P.dates.at(-1)}；2000 起 = ${P.dates[260]}`);

// 固定倍数持有（每月月末再平衡回目标倍数）
const lev = (sym, x) => ctx => (!ctx.state.s || ctx.monthEnd) ? (ctx.state.s = 1, { [sym]: x }) : null;
// 波动目标：仓位 = min(cap, target / 20 日波动)，变化 ≥0.1 才调
const vt = (sym, target, cap) => S.volTarget({ risk: sym, target, lookback: 20, cap, step: 0.1 });

const CANDS = {
  '假设22 融资账户': [
    ['TQQQ 1.0×（不融资，=假设20）', lev('TQQQ', 1), {}],
    ['TQQQ 1.3×（融资 30%）', lev('TQQQ', 1.3), { borrowSpread: 2.5, maint: 0.3 }],
    ['TQQQ 1.5×（融资 50%）', lev('TQQQ', 1.5), { borrowSpread: 2.5, maint: 0.3 }],
    ['TQQQ 波动目标 60%，最多 1.5×', vt('TQQQ', 0.6, 1.5), { borrowSpread: 2.5, maint: 0.3 }],
    ['TQQQ 波动目标 80%，最多 1.5×', vt('TQQQ', 0.8, 1.5), { borrowSpread: 2.5, maint: 0.3 }],
  ],
  '假设23 期货账户（NQ/MNQ 以 QQQ×N 近似）': [
    ['QQQ 2× 期货', lev('QQQ', 2), { maint: 0.12 }],
    ['QQQ 3× 期货', lev('QQQ', 3), { maint: 0.12 }],
    ['QQQ 4× 期货', lev('QQQ', 4), { maint: 0.12 }],
    ['QQQ 波动目标 60%，最多 4×', vt('QQQ', 0.6, 4), { maint: 0.12 }],
    ['QQQ 波动目标 60% + 200 日线，最多 4×', S.volTarget({ risk: 'QQQ', target: 0.6, lookback: 20, cap: 4, step: 0.1, gate: { signal: 'QQQ', n: 200, band: 0.02 } }), { maint: 0.12 }],
  ],
};

/** 净值曲线 → 定投账户 */
function dcaAccount(r) {
  let units = INIT / r.curve[0], invested = INIT, peak = 0, mdd = 0, below = 0;
  const flows = [{ d: r.dates[0], amt: -INIT }];
  for (let i = 0; i < r.dates.length; i++) {
    if (i && r.dates[i].slice(0, 7) !== r.dates[i - 1].slice(0, 7)) { units += MONTHLY / Math.max(r.curve[i], 1e-12); invested += MONTHLY; flows.push({ d: r.dates[i], amt: -MONTHLY }); }
    const v = units * r.curve[i]; peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); below = Math.min(below, v / invested - 1);
  }
  const final = units * r.curve.at(-1);
  return { final, invested, ann: xirr([...flows, { d: r.dates.at(-1), amt: final }]), mdd, below, marginCalls: r.marginCalls, wiped: Math.min(...r.curve) <= 1e-9 };
}
const starts = P.dates.filter((d, i, a) => i > 260 && d <= '2016-10-31' && d.slice(0, 7) !== a[i - 1].slice(0, 7)).filter((_, k) => k % 2 === 0);
for (const [acct, list] of Object.entries(CANDS)) {
  console.log(`\n==== ${acct} ====`);
  const rows = list.map(([n, mk, o]) => {
    const a = dcaAccount(backtest(P, mk, { start: '2010-04-01', end: END, ...o }));
    const b = dcaAccount(backtest(P, mk, { start: P.dates[260], end: END, ...o }));
    const roll = starts.map(s => dcaAccount(backtest(P, mk, { start: s, end: END, ...o })));
    const ann = roll.map(x => x.ann).sort((x, y) => x - y);
    return { n, a, b, worst: ann[0], med: ann[Math.floor(ann.length / 2)], wipe: roll.filter(x => x.wiped).length / roll.length };
  }).sort((x, y) => y.b.final - x.b.final);
  for (const r of rows) console.log(`${r.n.padEnd(34)} 2010起 ${usd(r.a.final).padStart(13)} | 2000起 ${usd(r.b.final).padStart(13)} 年化 ${pct(r.b.ann).padStart(6)} 回撤 ${pct(r.b.mdd).padStart(7)} 追保 ${r.b.marginCalls} 次${r.b.wiped ? ' 【归零】' : ''} | ${starts.length} 起点 年化最差 ${pct(r.worst).padStart(6)} 中位 ${pct(r.med).padStart(6)} 归零占比 ${pct(r.wipe)}`);
}
