// 用户假设 10–13（2026-10-24）：TQQQ + 纳斯达克综合指数 120 日线 / 高点回撤 2% / KDJ / 布林，及期权版（LEAPS Call + 短期 Put）。
// 逐日账户模拟，收盘出信号、次日开盘成交（与假设 8/9 一致），每笔股票/ETF 成交扣 5bp。
// 信号源：纳斯达克综合指数用 ONEQ（Fidelity 综合指数 ETF，复权）代替——Tiingo 无指数行情；另给 QQQ（纳指 100）对照，因为规则第 2 条写的是 QQQ。
// 期权：无历史期权报价，用 Black-Scholes 估值，TQQQ 隐含波动 = 3 × VXN（纳指 100 波动率指数，FRED VXNCLS），
//       买入按理论价 +3%、卖出 −3%（买卖价差）；结果只能当量级参考。
// 用法（backend/ 下）：node backtest/lab/hypo10-13.mjs   （首次会下载 ONEQ 高低价与 VXN，之后读缓存）
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { cached, tiingo } from '../ndx-rotation/lib.mjs';
import { riskFree } from './data.mjs';

export const START = '2010-04-01', INIT = 10000, MONTHLY = 3000 / 7.8, COST = 0.0005, OPT_SPREAD = 0.03;

// ---------- 数据 ----------
async function ohlc(t) { // 复权高低收（KDJ 要用高低价；ndx-rotation 的缓存只存了开收）
  const txt = await cached(`tiingo_hl/${t}.json`, async () => {
    const r = await axios.get(`https://api.tiingo.com/tiingo/daily/${t}/prices`, { params: { startDate: '2003-01-01', token: process.env.TIINGO_API_KEY }, timeout: 60000 });
    return JSON.stringify(r.data.map(d => ({ d: d.date.slice(0, 10), h: d.adjHigh, l: d.adjLow, c: d.adjClose })));
  });
  return JSON.parse(txt);
}
async function vxnSeries() {
  const txt = await cached('fred/VXNCLS.json', async () => {
    const r = await axios.get('https://api.stlouisfed.org/fred/series/observations', { params: { series_id: 'VXNCLS', api_key: process.env.FRED_API_KEY, file_type: 'json', observation_start: '2001-01-01' }, timeout: 60000 });
    return JSON.stringify(r.data.observations.filter(o => o.value !== '.').map(o => [o.date, +o.value]));
  });
  const obs = JSON.parse(txt);
  return d => { let lo = 0, hi = obs.length - 1, a = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (obs[m][0] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return obs[a][1]; };
}

/** 指标：SMA120、布林(20,2)、KDJ(9,3,3)、近 20 日最高收盘；返回 Map<date, {...}> */
function indicators(rows) {
  const out = new Map(); let K = 50, D = 50;
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i].c, w = (n) => rows.slice(Math.max(0, i - n + 1), i + 1);
    const s120 = i >= 119 ? w(120).reduce((a, r) => a + r.c, 0) / 120 : NaN;
    const b = w(20), mid = b.reduce((a, r) => a + r.c, 0) / b.length, sd = Math.sqrt(b.reduce((a, r) => a + (r.c - mid) ** 2, 0) / b.length);
    const k9 = w(9), hh = Math.max(...k9.map(r => r.h ?? r.c)), ll = Math.min(...k9.map(r => r.l ?? r.c));
    const rsv = hh > ll ? (c - ll) / (hh - ll) * 100 : 50;
    K = (2 * K + rsv) / 3; D = (2 * D + K) / 3; const J = 3 * K - 2 * D;
    const hi20 = Math.max(...w(20).map(r => r.c));
    out.set(rows[i].d, { c, s120, up: mid + 2 * sd, lo: mid - 2 * sd, K, D, J, hi20 });
  }
  return out;
}

export function xirr(flows) {
  const t0 = Date.parse(flows[0].d);
  const f = r => flows.reduce((s, c) => s + c.amt / (1 + r) ** ((Date.parse(c.d) - t0) / (365.25 * 864e5)), 0);
  let lo = -0.99, hi = 5; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; f(m) > 0 ? (lo = m) : (hi = m); }
  return (lo + hi) / 2;
}
const ncdf = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
export function bs(type, S, K, T, r, s) {
  if (T <= 0) return Math.max(type === 'c' ? S - K : K - S, 0);
  const d1 = (Math.log(S / K) + (r + s * s / 2) * T) / (s * Math.sqrt(T)), d2 = d1 - s * Math.sqrt(T);
  return type === 'c' ? S * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2) : K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1);
}
export const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

export async function loadAll() {
  const rf = await riskFree(), vxn = await vxnSeries();
  const px = {};
  for (const t of ['TQQQ', 'QQQ', 'BIL']) px[t] = new Map((await tiingo(t)).rows.map(r => [r.d, r]));
  // 信号：QQQ 复权高低收（KDJ 要高低价）。用户 2026-10-24 修订：信号统一用 QQQ ETF，现金统一用国库券
  return { rf, vxn, px, sig: { QQQ: indicators(await ohlc('QQQ')) } };
}

// from：起算日（默认 2010-04-01）；D.days 存在时用它作交易日历（2000 年起的合成 TQQQ 压力测试用，不需要 QQQ 指标）
export function calendar(D, end, from = START) {
  const base = D.days || [...D.px.TQQQ.keys()].filter(d => D.px.QQQ.has(d) && D.sig.QQQ.has(d));
  const days = base.filter(d => d >= from && d <= end).sort();
  // 现金腿 = 国库券：BIL（SPDR 1–3 个月国库券 ETF，2007-05 上市，真实总回报）；缺 BIL 报价的日子按 3 个月国库券利率 DTB3 计息
  const bil = D.px.BIL, bill = new Map(); let b = 1;
  days.forEach((d, i) => {
    if (i) { const p = days[i - 1], r = bil.has(d) && bil.has(p) ? bil.get(d).ac / bil.get(p).ac - 1 : D.rf(d) / 100 / 252; b *= 1 + r; }
    bill.set(d, { ao: b, ac: b });
  });
  return { days, bill };
}
const prevSigDay = (sig, d) => { let best = null; for (const k of sig.keys()) if (k < d && (!best || k > best)) best = k; return best; };

/**
 * 假设 10/11：100% TQQQ 或 100% 现金腿（TMF 或国库券），入场 = 均线条件，离场 = 自入场以来信号最高收盘回撤 2%。
 * rule='literal'：用户原文"空仓时收盘低于 120 日线就买入"；rule='trend'：反过来，收盘高于 120 日线才买（顺势对照）
 */
export function simH10(D, end, { signal = 'QQQ', cash = 'BILL', rule = 'literal', dca = false } = {}) {
  const { days, bill } = calendar(D, end);
  const S = D.sig[signal], P = s => (s === 'BILL' ? bill : D.px[s]);
  const wantIn = x => (rule === 'literal' ? x.c < x.s120 : x.c > x.s120);
  let pk = null, ddWin = null, sym, units, invested = INIT, peak = null, pending = null, trades = 0, inDays = 0, maxV = 0, mdd = 0;
  const flows = [{ d: days[0], amt: -INIT }], curve = [];
  const s0 = S.get(prevSigDay(S, days[0]));
  sym = wantIn(s0) ? 'TQQQ' : cash; units = INIT * (1 - COST) / P(sym).get(days[0]).ao; trades++;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (i > 0 && pending) { let v = units * P(sym).get(d).ao * (1 - COST) * (1 - COST); sym = pending; units = v / P(sym).get(d).ao; pending = null; trades++; }
    if (dca && i > 0 && d.slice(0, 7) !== days[i - 1].slice(0, 7)) { units += MONTHLY * (1 - COST) / P(sym).get(d).ao; invested += MONTHLY; flows.push({ d, amt: -MONTHLY }); }
    const v = units * P(sym).get(d).ac; curve.push({ d, v });
    if (v > maxV) { maxV = v; pk = d; } if (v / maxV - 1 < mdd) { mdd = v / maxV - 1; ddWin = [pk, d]; }
    const x = S.get(d);
    if (sym === 'TQQQ') {
      inDays++; peak = Math.max(peak ?? x.c, x.c);
      if (x.c < peak * 0.98) { pending = cash; peak = null; }
    } else if (wantIn(x)) { pending = 'TQQQ'; peak = null; }
  }
  return finish(curve, flows, invested, { trades, inMarket: inDays / days.length, mdd, ddWin });
}

/**
 * 假设 12/13（用户 2026-10-24 修订版）：
 *   进攻（三条同时满足，"支撑位附近"按用户要求忽略）：QQQ 收盘 < 120 日线、KDJ J < 0、收盘 < 布林下轨
 *     → 卖出所有 Put；当前总资产的 80% 买 TQQQ、20% 买 1 年期 TQQQ Call（行权价 = 股价×102%）
 *   防守（三条同时满足，"压力位附近"忽略；已去掉 K<D）：持仓中，QQQ 收盘较进场以来最高收盘回撤 ≥2%、J > 100、收盘 > 布林上轨
 *     → 清仓 TQQQ 和 Call；当前总资产的 20% 买 3 个月 TQQQ Put（行权价 = 股价×98%），其余国库券
 *   期权每次最多占总资产 20%（凯利公式无胜率赔率输入，按上限 20%）。
 *   未写明、按最小假设处理：进攻期 Call 到期 → 整体按 80/20 重新建仓（展期）；Put 到期 → 结算入国库券，不展期；
 *   起点 2010-04-01 持国库券，等第一个进攻信号。
 * dca=true（假设 13）：每月首个交易日 3000 HKD 进国库券，等策略下一次动作时一起部署。
 */
export function simH12(D, end, { dca = false, ivMult = 3, spread = OPT_SPREAD, log = null, defenseNeedsPeak = true } = {}) {
  const { days, bill } = calendar(D, end);
  const S = D.sig.QQQ, T = D.px.TQQQ;
  let pk = null, ddWin = null, state = 'cash', cash = INIT, tq = 0, call = null, put = null, peak = null, invested = INIT, pending = null, trades = 0, optSpent = 0, optBack = 0, maxV = 0, mdd = 0;
  const flows = [{ d: days[0], amt: -INIT }], curve = [], counts = { attack: 0, defense: 0, attackCond: 0, defenseCond: 0 };
  const sigma = d => Math.max(0.3, ivMult * D.vxn(d) / 100), r = d => D.rf(d) / 100;
  const optVal = (o, Sx, d, vd) => o ? o.n * bs(o.type, Sx, o.K, (Date.parse(o.exp) - Date.parse(d)) / (365 * 864e5), r(d), sigma(vd)) : 0;
  const sellOpt = (o, Sx, d, vd) => { if (!o) return 0; const v = optVal(o, Sx, d, vd) * (1 - spread); optBack += v; log?.push({ d, act: 'sell ' + o.type, v: Math.round(v) }); return v; };
  const buyOpt = (type, budget, Sx, kRatio, days_, d, vd) => {
    const K = Sx * kRatio, exp = addDays(d, days_), unit = bs(type, Sx, K, days_ / 365, r(d), sigma(vd)) * (1 + spread);
    log?.push({ d, act: 'buy ' + type, v: Math.round(budget), pctOfS: +(unit / Sx * 100).toFixed(1) });
    optSpent += budget; return { type, K, exp, n: budget / unit };
  };
  const goAttack = (d, vd, why) => {
    const Sx = T.get(d).ao;
    cash += sellOpt(put, Sx, d, vd); put = null;
    cash += sellOpt(call, Sx, d, vd); call = null;
    cash += tq * Sx * (1 - COST); tq = 0;
    const E = cash;
    call = buyOpt('c', 0.2 * E, Sx, 1.02, 365, d, vd);
    tq = 0.8 * E * (1 - COST) / Sx; cash = 0; trades++;
    if (state !== 'attack') peak = null; // 新一轮进场：从这里重新计"进场以来最高收盘"；展期不重置
    state = 'attack'; log?.push({ d, act: why });
  };
  const goDefense = (d, vd) => {
    const Sx = T.get(d).ao;
    cash += tq * Sx * (1 - COST); tq = 0;
    cash += sellOpt(call, Sx, d, vd); call = null;
    put = buyOpt('p', 0.2 * cash, Sx, 0.98, 91, d, vd); cash *= 0.8; state = 'defense'; peak = null; trades++; log?.push({ d, act: 'defense' });
  };
  for (let i = 0; i < days.length; i++) {
    const d = days[i], prev = i ? days[i - 1] : d, Sx = T.get(d).ao;
    if (i > 0) cash *= bill.get(d).ac / bill.get(prev).ac;
    if (dca && i > 0 && d.slice(0, 7) !== prev.slice(0, 7)) { cash += MONTHLY; invested += MONTHLY; flows.push({ d, amt: -MONTHLY }); }
    if (put && put.exp <= d) { const v = put.n * Math.max(put.K - Sx, 0); cash += v; optBack += v; put = null; }
    if (call && call.exp <= d) { const v = call.n * Math.max(Sx - call.K, 0); cash += v; optBack += v; call = null; if (state === 'attack' && !pending) goAttack(d, prev, 'roll'); }
    if (pending === 'attack') goAttack(d, prev, 'attack'); else if (pending === 'defense') goDefense(d, prev);
    pending = null;
    const c = T.get(d).ac, v = cash + tq * c + optVal(call, c, d, d) + optVal(put, c, d, d);
    curve.push({ d, v }); if (v > maxV) { maxV = v; pk = d; } if (v / maxV - 1 < mdd) { mdd = v / maxV - 1; ddWin = [pk, d]; }
    const x = S.get(d);
    if (state === 'attack') peak = Math.max(peak ?? x.c, x.c);
    const attack = x.c < x.s120 && x.J < 0 && x.c < x.lo;
    const ddOK = !defenseNeedsPeak || (peak != null && x.c <= peak * 0.98);
    const defense = state === 'attack' && ddOK && x.J > 100 && x.c > x.up;
    if (attack) counts.attackCond++; if (x.J > 100 && x.c > x.up) counts.defenseCond++;
    if (attack && state !== 'attack') { pending = 'attack'; counts.attack++; }
    else if (defense) { pending = 'defense'; counts.defense++; }
  }
  return finish(curve, flows, invested, { trades, mdd, ddWin, counts, optSpent, optBack, state });
}

function finish(curve, flows, invested, extra) {
  const final = curve.at(-1).v, yrs = (Date.parse(curve.at(-1).d) - Date.parse(curve[0].d)) / (365.25 * 864e5);
  const ann = flows.length > 1 ? xirr([...flows, { d: curve.at(-1).d, amt: final }]) : (final / INIT) ** (1 / yrs) - 1;
  return { end: curve.at(-1).d, final, invested, gain: final - invested, ret: final / invested - 1, ann, ...extra };
}

/** 汇总表用：每个假设的一次性版 / 定投版，结构与 summary-2010 的 settle() 一致 */
export async function hypoRows(end) {
  const D = await loadAll();
  const pair = (a, b) => ({ end: a.end, lump: { final: a.final, gain: a.gain, ret: a.ret, ann: a.ann }, dca: { final: b.final, invested: b.invested, gain: b.gain, ret: b.ret, ann: b.ann } });
  return [
    ['假设10/11 TQQQ 跌破120日线买+进场高点回撤2%卖（国库券）', pair(simH10(D, end), simH10(D, end, { dca: true }))],
    ['假设12/13 TQQQ 80%+LEAPS Call 20% / 防守 Put（用户修订版）', pair(simH12(D, end), simH12(D, end, { dca: true }))],
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const D = await loadAll();
  const end = '2026-10-21';
  const pct = x => `${(x * 100).toFixed(1)}%`, usd = x => `$${Math.round(x).toLocaleString('en-US')}`;
  const show = (n, r) => console.log(`${n.padEnd(30)} 期末 ${usd(r.final).padStart(11)}  总收益 ${usd(r.gain).padStart(11)}  总收益率 ${pct(r.ret).padStart(8)}  年化 ${pct(r.ann).padStart(6)}  最大回撤 ${pct(r.mdd)}（${r.ddWin?.join('→')}）  交易 ${r.trades} 次${r.inMarket != null ? `  持TQQQ时间 ${pct(r.inMarket)}` : ''}${r.counts ? `  进攻触发 ${r.counts.attack} 次 防守触发 ${r.counts.defense} 次（满足"J>100且升穿上轨"的天数 ${r.counts.defenseCond}）  期权买入 ${usd(r.optSpent)} 收回 ${usd(r.optBack)}  末状态 ${r.state}` : ''}`);
  show('H10', simH10(D, end)); show('H11 +定投', simH10(D, end, { dca: true }));
  const log = []; const r12 = simH12(D, end, { log }); show('H12', r12); show('H13 +增资', simH12(D, end, { dca: true }));
  console.log('\nH12 动作记录：'); for (const l of log) console.log(' ', l.d, l.act, l.v != null ? '$' + l.v.toLocaleString() : '', l.pctOfS ? `期权价=${l.pctOfS}%×股价` : '');
  console.log('\nH12 敏感性（一次性）：');
  for (const iv of [2.5, 3, 3.5]) for (const sp of [0.03, 0.08]) { const x = simH12(D, end, { ivMult: iv, spread: sp }); console.log(`  IV=${iv}×VXN 价差=${sp * 100}%  年化 ${pct(x.ann)}  期末 ${usd(x.final)}`); }
}
