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

const START = '2010-04-01', INIT = 10000, MONTHLY = 3000 / 7.8, COST = 0.0005, OPT_SPREAD = 0.03;

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

function xirr(flows) {
  const t0 = Date.parse(flows[0].d);
  const f = r => flows.reduce((s, c) => s + c.amt / (1 + r) ** ((Date.parse(c.d) - t0) / (365.25 * 864e5)), 0);
  let lo = -0.99, hi = 5; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; f(m) > 0 ? (lo = m) : (hi = m); }
  return (lo + hi) / 2;
}
const ncdf = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function bs(type, S, K, T, r, s) {
  if (T <= 0) return Math.max(type === 'c' ? S - K : K - S, 0);
  const d1 = (Math.log(S / K) + (r + s * s / 2) * T) / (s * Math.sqrt(T)), d2 = d1 - s * Math.sqrt(T);
  return type === 'c' ? S * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2) : K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1);
}
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

export async function loadAll() {
  const rf = await riskFree(), vxn = await vxnSeries();
  const px = {};
  for (const t of ['TQQQ', 'TMF', 'QQQ', 'ONEQ']) px[t] = new Map((await tiingo(t)).rows.map(r => [r.d, r]));
  const sigONEQ = indicators(await ohlc('ONEQ'));
  const sigQQQ = indicators((await tiingo('QQQ')).rows.map(r => ({ d: r.d, c: r.ac })));
  return { rf, vxn, px, sig: { ONEQ: sigONEQ, QQQ: sigQQQ } };
}

function calendar(D, end) {
  const days = [...D.px.TQQQ.keys()].filter(d => d >= START && d <= end && D.px.TMF.has(d) && D.px.ONEQ.has(d) && D.px.QQQ.has(d)).sort();
  const bill = new Map(); let b = 1;
  days.forEach((d, i) => { if (i) b *= 1 + D.rf(d) / 100 / 252; bill.set(d, { ao: b, ac: b }); });
  return { days, bill };
}
const prevSigDay = (sig, d) => { let best = null; for (const k of sig.keys()) if (k < d && (!best || k > best)) best = k; return best; };

/**
 * 假设 10/11：100% TQQQ 或 100% 现金腿（TMF 或国库券），入场 = 均线条件，离场 = 自入场以来信号最高收盘回撤 2%。
 * rule='literal'：用户原文"空仓时收盘低于 120 日线就买入"；rule='trend'：反过来，收盘高于 120 日线才买（顺势对照）
 */
export function simH10(D, end, { signal = 'ONEQ', cash = 'TMF', rule = 'literal', dca = false } = {}) {
  const { days, bill } = calendar(D, end);
  const S = D.sig[signal], P = s => (s === 'BILL' ? bill : D.px[s]);
  const wantIn = x => (rule === 'literal' ? x.c < x.s120 : x.c > x.s120);
  let sym, units, invested = INIT, peak = null, pending = null, trades = 0, inDays = 0, maxV = 0, mdd = 0;
  const flows = [{ d: days[0], amt: -INIT }], curve = [];
  const s0 = S.get(prevSigDay(S, days[0]));
  sym = wantIn(s0) ? 'TQQQ' : cash; units = INIT * (1 - COST) / P(sym).get(days[0]).ao; trades++;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (i > 0 && pending) { let v = units * P(sym).get(d).ao * (1 - COST) * (1 - COST); sym = pending; units = v / P(sym).get(d).ao; pending = null; trades++; }
    if (dca && i > 0 && d.slice(0, 7) !== days[i - 1].slice(0, 7)) { units += MONTHLY * (1 - COST) / P(sym).get(d).ao; invested += MONTHLY; flows.push({ d, amt: -MONTHLY }); }
    const v = units * P(sym).get(d).ac; curve.push({ d, v });
    maxV = Math.max(maxV, v); mdd = Math.min(mdd, v / maxV - 1);
    const x = S.get(d);
    if (sym === 'TQQQ') {
      inDays++; peak = Math.max(peak ?? x.c, x.c);
      if (x.c < peak * 0.98) { pending = cash; peak = null; }
    } else if (wantIn(x)) { pending = 'TQQQ'; peak = null; }
  }
  return finish(curve, flows, invested, { trades, inMarket: inDays / days.length, mdd });
}

/**
 * 假设 12/13：进攻 = 80% TQQQ + 20% 1 年期 Call（行权价 102%）；防守 = 清仓股票与 Call，20% 买 3 个月 Put（行权价 98%），其余国库券。
 * mode='usable'：可执行版条件（见 attack/defense 注释）；mode='strict'：所有条件同一天同时满足（字面）。
 * dca=true（假设 13）：每月首个交易日 3000 HKD 进现金，等策略下一次动作（进攻建仓 / Call 展期）时一起部署。
 */
export function simH12(D, end, { mode = 'usable', dca = false, ivMult = 3, spread = OPT_SPREAD, log = null } = {}) {
  const { days } = calendar(D, end);
  const S = D.sig.ONEQ, T = D.px.TQQQ;
  const sig = (x, d) => {
    // 超跌：收盘跌破 120 日线，且 KDJ J<0 或跌破布林下轨（"支撑位附近"无法量化，未用）
    const attack = mode === 'strict' ? x.c < x.s120 && x.J < 0 && x.c < x.lo : x.c < x.s120 && (x.J < 0 || x.c < x.lo);
    // 超买转弱：strict = 回撤 2% 且 J>100 且 K<D 且升穿上轨（J=K+2(K−D)，K<D 时 J<K≤100，此条件数学上不可能同时成立）
    // usable = 近 10 日内出现过超买（J>100 或收盘升穿上轨），今天 K<D 且收盘较近 20 日最高回撤 ≥2%
    let defense;
    if (mode === 'strict') defense = x.c <= x.hi20 * 0.98 && x.J > 100 && x.K < x.D && x.c > x.up;
    else {
      const idx = sigDays.indexOf(d), recent = sigDays.slice(Math.max(0, idx - 9), idx + 1).map(k => S.get(k));
      defense = recent.some(y => y.J > 100 || y.c > y.up) && x.K < x.D && x.c <= x.hi20 * 0.98;
    }
    return { attack, defense };
  };
  const sigDays = [...S.keys()].sort();
  let state = 'cash', cash = INIT, tq = 0, call = null, put = null, invested = INIT, pending = null, trades = 0, optSpent = 0, optBack = 0, maxV = 0, mdd = 0;
  const flows = [{ d: days[0], amt: -INIT }], curve = [], counts = { attack: 0, defense: 0 };
  const sigma = d => Math.max(0.3, ivMult * D.vxn(d) / 100), r = d => D.rf(d) / 100;
  const optVal = (o, Sx, d, vd) => o ? o.n * bs(o.type, Sx, o.K, (Date.parse(o.exp) - Date.parse(d)) / (365 * 864e5), r(d), sigma(vd)) : 0;
  const sellOpt = (o, Sx, d, vd) => { if (!o) return 0; const v = optVal(o, Sx, d, vd) * (1 - spread); optBack += v; log?.push({ d, act: 'sell ' + o.type, v: Math.round(v) }); return v; };
  const buyOpt = (type, budget, Sx, kRatio, days_, d, vd) => {
    const K = Sx * kRatio, exp = addDays(d, days_), unit = bs(type, Sx, K, days_ / 365, r(d), sigma(vd)) * (1 + spread);
    log?.push({ d, act: 'buy ' + type, v: Math.round(budget), pctOfS: +(unit / Sx * 100).toFixed(1) });
    optSpent += budget; return { type, K, exp, n: budget / unit };
  };
  const goAttack = (d, vd) => {
    const Sx = T.get(d).ao;
    cash += sellOpt(put, Sx, d, vd); put = null;
    cash += sellOpt(call, Sx, d, vd); call = null;
    cash += tq * Sx * (1 - COST); tq = 0;
    const E = cash;
    call = buyOpt('c', 0.2 * E, Sx, 1.02, 365, d, vd);
    tq = 0.8 * E * (1 - COST) / Sx; cash = 0; state = 'attack'; trades++;
  };
  const goDefense = (d, vd) => {
    const Sx = T.get(d).ao;
    cash += tq * Sx * (1 - COST); tq = 0;
    cash += sellOpt(call, Sx, d, vd); call = null;
    put = buyOpt('p', 0.2 * cash, Sx, 0.98, 91, d, vd); cash *= 0.8; state = 'defense'; trades++;
  };
  for (let i = 0; i < days.length; i++) {
    const d = days[i], prev = i ? days[i - 1] : prevSigDay(S, d), Sx = T.get(d).ao;
    if (i > 0) cash *= 1 + D.rf(d) / 100 / 252;
    if (dca && i > 0 && d.slice(0, 7) !== days[i - 1].slice(0, 7)) { cash += MONTHLY; invested += MONTHLY; flows.push({ d, amt: -MONTHLY }); }
    // 到期：Put 到期按内在价值结算、不展期；Call 到期结算，若仍在进攻则整体按 80/20 重新建仓（展期）
    if (put && put.exp <= d) { cash += put.n * Math.max(put.K - Sx, 0); optBack += put.n * Math.max(put.K - Sx, 0); put = null; }
    if (call && call.exp <= d) { const v = call.n * Math.max(Sx - call.K, 0); cash += v; optBack += v; call = null; if (state === 'attack') goAttack(d, prev); }
    if (pending === 'attack') goAttack(d, prev); else if (pending === 'defense') goDefense(d, prev);
    pending = null;
    const c = T.get(d).ac, v = cash + tq * c + optVal(call, c, d, d) + optVal(put, c, d, d);
    curve.push({ d, v }); maxV = Math.max(maxV, v); mdd = Math.min(mdd, v / maxV - 1);
    const x = S.get(d), s = sig(x, d);
    if (s.attack) counts.attack++; if (s.defense) counts.defense++;
    if (s.attack && state !== 'attack') pending = 'attack';
    else if (s.defense && state === 'attack') pending = 'defense';
  }
  return finish(curve, flows, invested, { trades, mdd, counts, optSpent, optBack, state });
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
    ['假设10/11 TQQQ 跌破120日线买+回撤2%卖（现金=TMF）', pair(simH10(D, end), simH10(D, end, { dca: true }))],
    ['假设10/11 变体：现金=国库券', pair(simH10(D, end, { cash: 'BILL' }), simH10(D, end, { cash: 'BILL', dca: true }))],
    ['假设10/11 变体：信号用QQQ', pair(simH10(D, end, { signal: 'QQQ' }), simH10(D, end, { signal: 'QQQ', dca: true }))],
    ['假设10/11 变体：站上120日线才买（顺势）', pair(simH10(D, end, { rule: 'trend' }), simH10(D, end, { rule: 'trend', dca: true }))],
    ['假设12/13 TQQQ+LEAPS Call/短期Put（可执行版条件）', pair(simH12(D, end), simH12(D, end, { dca: true }))],
    ['假设12/13 字面条件（全部同时满足）', pair(simH12(D, end, { mode: 'strict' }), simH12(D, end, { mode: 'strict', dca: true }))],
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const D = await loadAll();
  const end = '2026-10-21';
  const pct = x => `${(x * 100).toFixed(1)}%`, usd = x => `$${Math.round(x).toLocaleString('en-US')}`;
  const show = (n, r) => console.log(`${n.padEnd(40)} 期末 ${usd(r.final).padStart(11)}  总收益 ${usd(r.gain).padStart(11)}  总收益率 ${pct(r.ret).padStart(8)}  年化 ${pct(r.ann).padStart(6)}  最大回撤 ${pct(r.mdd)}  交易 ${r.trades} 次${r.inMarket != null ? `  持TQQQ时间 ${pct(r.inMarket)}` : ''}${r.counts ? `  进攻信号日 ${r.counts.attack} 防守信号日 ${r.counts.defense}  期权花费 ${usd(r.optSpent)} 收回 ${usd(r.optBack)}  末状态 ${r.state}` : ''}`);
  for (const [n, o] of [['H10 字面（ONEQ信号，现金TMF）', {}], ['H10 现金=国库券', { cash: 'BILL' }], ['H10 信号=QQQ', { signal: 'QQQ' }], ['H10 顺势（站上才买）', { rule: 'trend' }]]) { show(n, simH10(D, end, o)); show(n.replace('H10', 'H11') + ' +定投', simH10(D, end, { ...o, dca: true })); }
  for (const [n, o] of [['H12 可执行版', {}], ['H12 字面全条件', { mode: 'strict' }]]) { show(n, simH12(D, end, o)); show(n.replace('H12', 'H13') + ' +增资', simH12(D, end, { ...o, dca: true })); }
}
