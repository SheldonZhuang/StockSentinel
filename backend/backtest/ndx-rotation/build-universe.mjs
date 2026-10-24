// S1 股票池：每年最后一个交易日的 NDX 时点成员 + 该年全年总回报（adjClose）。
//   2007+：thuningxu 快照（2026-05-18 后叠加 unliftedq 变更）；
//   2006：QQQ 2006-09-30 持仓 ∪ thu 2007-02-01 首行（标记为近似）；
//   1999–2005：QQQ 9/30(Y) 持仓 ∪ 9/30(Y+1) 持仓（超集），两次都在 = 核心成员；只在一侧的标记出来，冠军若落在非核心名单需人工判定。
// 每个 QQQ 持仓名 → 代码映射都用 "持仓市值/股数 ≈ Tiingo 9/30 未复权收盘价(±4%)" 核验；
// 核验不过/无价格的名字记为数据缺口，并用 QQQ 9/30→次年 9/30 权重变化估算其区间涨幅（仅作筛查）。
import path from 'path';
import { fileURLToPath } from 'url';
import { readJSON, writeJSON, OUT } from './lib.mjs';
import { normName, NAME_TO_TICKER } from './name-map.mjs';
import { membersAt } from './membership.mjs';
import { rowOnOrBefore, series } from './prices.mjs';
import { tradingDays } from './calendar.mjs';

// 同一公司改名后的代码（价格序列连续、同一法人）；收购/合并产生的新代码不算
export const ALIASES = { FB: 'META', PCLN: 'BKNG', HANS: 'MNST', KFT: 'MDLZ', CTRP: 'TCOM', WFMI: 'WFM', FISV: 'FI', GOOG: 'GOOGL',
  ERTS: 'EA', WLTW: 'WTW', VIAB: 'PARA', SYMC: 'GEN', NLOK: 'GEN', DISCA: 'WBD' };

let DAYS;
export async function lastTradingDay(y) { DAYS ??= await tradingDays(); return DAYS.filter(d => d.startsWith(String(y))).at(-1); }

/** 代码 t 在 d0、d1 两日都有价格时返回 {sym, a0, a1}；先试 t，再试别名 */
export async function pricePair(t, d0, d1) {
  for (const sym of [t, ALIASES[t]].filter(Boolean)) {
    const r0 = await rowOnOrBefore(sym, d0, 5), r1 = await rowOnOrBefore(sym, d1, 5);
    if (r0 && r1 && r0.ac > 0 && r1.ac > 0) return { sym, a0: r0.ac, a1: r1.ac, d0: r0.d, d1: r1.d };
  }
  return null;
}

/** 把 QQQ 某个 9/30 持仓表映射成代码；返回 [{name, ticker|null, weight, impliedPx, check}] */
export async function mapHoldings(date) {
  const H = readJSON(path.join(OUT, 'qqq_holdings_sep30.json'));
  const rows = H[date].rows, tot = rows.reduce((a, b) => a + b.value, 0);
  const out = [];
  for (const r of rows) {
    const key = normName(r.name), cands = (NAME_TO_TICKER[key] || '').split('|').filter(Boolean);
    const px = r.value / r.shares;
    let hit = null, note = cands.length ? '' : 'unmapped';
    for (const c of cands) {
      for (const sym of [c, ALIASES[c]].filter(Boolean)) {
        const row = await rowOnOrBefore(sym, date, 4);
        if (!row) { note ||= `${sym}:no-price`; continue; }
        // Tiingo 的 close 对部分退市代码按"之后的拆股"做了回溯调整：乘回之后各次 splitFactor 才是当日真实成交价
        const s = await series(sym); let later = 1;
        for (let k = row.i + 1; k < s.rows.length; k++) if (s.rows[k].sf && s.rows[k].sf !== 1) later *= s.rows[k].sf;
        const raw = row.c, dev = Math.min(Math.abs(raw / px - 1), Math.abs(raw * later / px - 1)) * Math.sign(raw / px - 1 || 1);
        if (Math.abs(dev) <= 0.04) { hit = sym; note = `ok(${(dev * 100).toFixed(1)}%)`; break; }
        note = `${sym}:px ${row.c} vs ${px.toFixed(2)}`;
      }
      if (hit) break;
    }
    if (!hit && FORCE_MAP[key]) { hit = FORCE_MAP[key]; note += ' → forced'; }
    out.push({ name: r.name, key, ticker: hit, cands, weight: r.value / tot, impliedPx: +px.toFixed(4), check: note });
  }
  return out;
}

// 2007 年前的非核心名单（只出现在一侧 9/30 持仓）的年末归属，由公司/交易所公告逐一确认，只登记会影响冠军的名字：
//   每年 12 月第三个周五后生效的年度重排 ⇒ 次年 9/30 才出现的名字，若在 12 月重排时加入，则当年年末已是成员。
export const YEAR_END_CONFIRMED = {
  2003: { LRCX: 'Lam Research 公告：2003-12-22 起纳入 NDX（investor.lamresearch.com 2003-12-16）' },
  2004: { ADSK: 'Autodesk 公告：2004-12-20 起纳入 NDX（investors.autodesk.com）' },
};
// 已证实年末【不是】成员的非核心名单
export const YEAR_END_EXCLUDED = {
  2005: { ISRG: '2006-02-01 才替换 Siebel 纳入 NDX（PRNewswire 2006-01-24，biospace.com 转载）' },
};
// 价格核验失败但代码身份唯一的映射（QQQ 持仓表该行数据本身有误）
const FORCE_MAP = { 'nvidia': 'NVDA', 'novellus system': 'NVLS', 'novellus systems': 'NVLS' };
async function main() {
  const H = readJSON(path.join(OUT, 'qqq_holdings_sep30.json'));
  const mapped = {};
  for (let y = 1999; y <= 2007; y++) mapped[y] = await mapHoldings(`${y}-09-30`);
  const years = {};
  for (let Y = 1999; Y <= 2025; Y++) {
    const dEnd = await lastTradingDay(Y), dStart = await lastTradingDay(Y - 1);
    let members = [], method;
    if (Y >= 2007) {
      method = 'thuningxu snapshot (Wikipedia changes, PIT)';
      members = membersAt(dEnd).map(t => ({ ticker: t, core: true }));
    } else {
      const A = mapped[Y], B = Y === 2006 ? null : mapped[Y + 1];
      const bKeys = new Set((B || []).map(x => x.key)), aKeys = new Set(A.map(x => x.key));
      const thuFirst = Y === 2006 ? new Set(membersAt('2007-02-01')) : null;
      method = Y === 2006 ? 'QQQ 2006-09-30 holdings ∪ thu 2007-02-01 (approx.)' : `QQQ ${Y}-09-30 ∪ ${Y + 1}-09-30 holdings (superset)`;
      const byKey = new Map();
      for (const x of A) byKey.set(x.key, { ...x, inA: true, inB: Y === 2006 ? (x.ticker ? thuFirst.has(x.ticker) : null) : bKeys.has(x.key) });
      if (B) for (const x of B) if (!aKeys.has(x.key)) byKey.set(x.key, { ...x, inA: false, inB: true });
      if (thuFirst) for (const t of thuFirst) if (![...byKey.values()].some(v => v.ticker === t || ALIASES[v.ticker] === t)) byKey.set('thu:' + t, { name: t, key: 'thu:' + t, ticker: t, inA: false, inB: true, check: 'thu-only' });
      members = [...byKey.values()].map(v => ({ ticker: v.ticker, name: v.name, core: !!(v.inA && v.inB) || !!YEAR_END_CONFIRMED[Y]?.[v.ticker], confirmed: YEAR_END_CONFIRMED[Y]?.[v.ticker] || null, inSepY: v.inA, inNext: v.inB, check: v.check, weightSepY: v.weight }));
    }
    members = members.filter(m => !YEAR_END_EXCLUDED[Y]?.[m.ticker]);
    const rets = [], gaps = [];
    for (const m of members) {
      if (!m.ticker) { gaps.push({ ...m, why: m.check }); continue; }
      const p = await pricePair(m.ticker, dStart, dEnd);
      if (!p) { gaps.push({ ...m, why: 'no full-year price (IPO in year, delisted, or not in Tiingo)' }); continue; }
      rets.push({ ...m, sym: p.sym, ret: p.a1 / p.a0 - 1 });
    }
    rets.sort((a, b) => b.ret - a.ret);
    years[Y] = { dStart, dEnd, method, nMembers: members.length, nPriced: rets.length, top: rets.slice(0, 8), all: rets, gaps };
    console.log(Y, method.slice(0, 30), 'members', members.length, 'priced', rets.length, 'gaps', gaps.length, '| top:', rets.slice(0, 3).map(r => `${r.sym}${r.core === false ? '(non-core)' : ''} ${(r.ret * 100).toFixed(0)}%`).join(', '));
  }
  writeJSON(path.join(OUT, 'universe.json'), { mapped, years });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
