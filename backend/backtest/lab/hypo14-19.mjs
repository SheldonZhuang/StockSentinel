// 用户假设 14–19（2026-10-24）：全仓滚动 TQQQ LEAPS Call（行权价 = 股价×102%，期限 1/2/3 年，到期前 3 个月卖出再买新的）。
// 14/16/18 一次性 $10,000；15/17/19 每月首个交易日追加 3000 HKD。
// 定投资金处理：期权是单一合约组合，每月新增的钱按当天开盘、用同一张合约（同行权价同到期日）的理论价加仓——
//   等价于"新钱立即买入当前持有的那张 Call"，不另开新到期日。
// 估值与假设 12 相同：Black-Scholes，TQQQ 隐含波动 = 3×VXN（下限 30%），买入理论价 +3%、卖出 −3%；无风险利率 DTB3。
// 已知不足：BS 用平值附近单一波动率，未建模偏斜与期限结构；真实 TQQQ LEAPS 最长约 2–2.5 年，3 年期在市场上通常不存在（见报告）。
// 用法（backend/ 下）：node backtest/lab/hypo14-19.mjs
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAll, calendar, bs, xirr, addDays, INIT, MONTHLY, OPT_SPREAD } from './hypo10-13.mjs';

const ROLL_BEFORE = 91; // 到期前 3 个月卖出

/** @param years 期限 1/2/3 */
export function simLeaps(D, end, { years = 1, dca = false, ivMult = 3, spread = OPT_SPREAD, strike = 1.02, log = null, start = null } = {}) {
  const cal = calendar(D, end), bill = cal.bill, days = start ? cal.days.filter(d => d >= start) : cal.days;
  const T = D.px.TQQQ;
  const sigma = d => Math.max(0.3, ivMult * D.vxn(d) / 100), r = d => D.rf(d) / 100;
  const yf = (a, b) => (Date.parse(b) - Date.parse(a)) / (365 * 864e5);
  let opt = null, cash = INIT, invested = INIT, rolls = 0, maxV = 0, mdd = 0, pk = null, ddWin = null, wiped = 0;
  const flows = [{ d: days[0], amt: -INIT }], curve = [];
  const price = (o, Sx, d, vd) => bs('c', Sx, o.K, yf(d, o.exp), r(d), sigma(vd));
  const open = (d, vd) => { // 全部现金按开盘价买新合约
    const Sx = T.get(d).ao, K = Sx * strike, exp = addDays(d, Math.round(years * 365));
    const unit = bs('c', Sx, K, years, r(d), sigma(vd)) * (1 + spread);
    opt = { K, exp, sellOn: addDays(exp, -ROLL_BEFORE), n: cash / unit };
    log?.push({ d, act: 'buy', S: +Sx.toFixed(2), K: +K.toFixed(2), exp, cost: Math.round(cash), unitPct: +(unit / Sx * 100).toFixed(1) });
    cash = 0;
  };
  for (let i = 0; i < days.length; i++) {
    const d = days[i], prev = i ? days[i - 1] : d, Sx = T.get(d).ao;
    if (i > 0) cash *= bill.get(d).ac / bill.get(prev).ac;
    // 到了"到期前 3 个月"：开盘卖出旧合约，同一开盘买入新合约
    if (opt && d >= opt.sellOn) {
      const v = opt.n * price(opt, Sx, d, prev) * (1 - spread);
      log?.push({ d, act: 'sell', S: +Sx.toFixed(2), proceeds: Math.round(v) });
      if (v < 1) wiped++;
      cash += v; opt = null; rolls++;
    }
    if (dca && i > 0 && d.slice(0, 7) !== prev.slice(0, 7)) {
      invested += MONTHLY; flows.push({ d, amt: -MONTHLY });
      if (opt) opt.n += MONTHLY / (price(opt, Sx, d, prev) * (1 + spread)); else cash += MONTHLY;
    }
    if (!opt && cash > 0) open(d, i ? prev : d);
    const c = T.get(d).ac, v = cash + (opt ? opt.n * price(opt, c, d, d) : 0);
    curve.push({ d, v });
    if (v > maxV) { maxV = v; pk = d; } if (v / maxV - 1 < mdd) { mdd = v / maxV - 1; ddWin = [pk, d]; }
  }
  const final = curve.at(-1).v, yrs = yf(curve[0].d, curve.at(-1).d);
  const ann = dca ? xirr([...flows, { d: curve.at(-1).d, amt: final }]) : (final / INIT) ** (1 / yrs) - 1;
  return { end: curve.at(-1).d, final, invested, gain: final - invested, ret: final / invested - 1, ann, mdd, ddWin, rolls, wiped };
}

/** 汇总表用 */
export async function leapsRows(end, D0 = null) {
  const D = D0 || await loadAll();
  const pair = (a, b) => ({ end: a.end, lump: { final: a.final, gain: a.gain, ret: a.ret, ann: a.ann }, dca: { final: b.final, invested: b.invested, gain: b.gain, ret: b.ret, ann: b.ann } });
  return [1, 2, 3].map((y, k) => [`假设${14 + 2 * k}/${15 + 2 * k} 全仓滚动 TQQQ ${y}年期 Call（102%行权，到期前3月换）`, pair(simLeaps(D, end, { years: y }), simLeaps(D, end, { years: y, dca: true }))]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const D = await loadAll(), end = '2026-10-21';
  const pct = x => `${(x * 100).toFixed(1)}%`, usd = x => `$${Math.round(x).toLocaleString('en-US')}`;
  for (const y of [1, 2, 3]) {
    for (const dca of [false, true]) {
      const log = []; const r = simLeaps(D, end, { years: y, dca, log });
      console.log(`${y}年期 ${dca ? '定投' : '一次性'}  期末 ${usd(r.final).padStart(12)}  总收益 ${usd(r.gain).padStart(12)}  总收益率 ${pct(r.ret).padStart(9)}  年化 ${pct(r.ann).padStart(6)}  最大回撤 ${pct(r.mdd)}（${r.ddWin?.join('→')}）  换仓 ${r.rolls} 次`);
      if (!dca) for (const l of log) console.log('    ', l.d, l.act, l.act === 'buy' ? `股价 ${l.S} 行权 ${l.K} 到期 ${l.exp} 投入 $${l.cost.toLocaleString()} 权利金=${l.unitPct}%×股价` : `股价 ${l.S} 卖得 $${l.proceeds.toLocaleString()}`);
    }
  }
  console.log('\n敏感性（一次性，年化）：IV 倍数 × 买卖价差');
  for (const y of [1, 2, 3]) console.log(`  ${y}年期  ` + [[2.5, 0.03], [3, 0.03], [3.5, 0.03], [3, 0.08], [3, 0.15]].map(([iv, sp]) => `IV${iv}×/价差${sp * 100}%: ${pct(simLeaps(D, end, { years: y, ivMult: iv, spread: sp }).ann)}`).join('  '));
}
