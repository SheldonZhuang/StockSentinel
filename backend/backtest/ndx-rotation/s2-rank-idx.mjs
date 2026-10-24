// S2 敏感性版本：用 QQQ 实际持仓推出的"指数股数"排序（比纯市值更接近真实指数权重，NDX 的修正市值加权/封顶会让两者不同）。
// 快照：9/30 年报全持仓(1999–2025)、12/31 招股书前五大权重(1999–2024)、N-PORT 季末持仓(2019Q3–)。
// 每个快照给出各股相对指数股数 s_i ∝ 持仓市值_i / 价格_i(快照日)。参考日 d 的权重 ∝ s_i × 拆股调整 × 价格_i(d)。
// 选快照规则：d 之后 16 天内有快照（即该次调整之后的季末持仓，反映调整后股数）就用它；否则用 d 之前最近的快照（股数沿用）。
// 说明：调整后的指数股数在当时就公开（Nasdaq 公告 / QQQ 每日持仓），用季末报表只是数据获取上的替代，不构成信息前视。
import fs from 'fs';
import path from 'path';
import { readJSON, OUT } from './lib.mjs';
import { series, rowOnOrBefore } from './prices.mjs';

const N2T = [[/microsoft/i, 'MSFT'], [/cisco/i, 'CSCO'], [/intel/i, 'INTC'], [/oracle/i, 'ORCL'], [/apple/i, 'AAPL'], [/qualcomm/i, 'QCOM'],
  [/amgen/i, 'AMGN'], [/amazon/i, 'AMZN'], [/nvidia/i, 'NVDA'], [/broadcom/i, 'AVGO'], [/tesla/i, 'TSLA'], [/(google|alphabet).*class c/i, 'GOOG'],
  [/google|alphabet/i, 'GOOGL'], [/facebook|meta platforms/i, 'META'], [/ebay/i, 'EBAY'], [/micron/i, 'MU'], [/nextel/i, 'NXTL'], [/gilead/i, 'GILD'],
  [/research in motion/i, 'RIMM'], [/comcast/i, 'CMCSA'], [/dell/i, 'DELL']];
const toT = n => (N2T.find(([re]) => re.test(n)) || [])[1] || null;

async function buildSnapshots() {
  const snaps = [];
  const H = readJSON(path.join(OUT, 'qqq_holdings_sep30.json'));
  for (const [d, { rows }] of Object.entries(H)) snaps.push({ date: d, src: 'QQQ Sep-30 schedule', items: rows.slice(0, 15).map(r => ({ tk: toT(r.name), value: r.value })) });
  const NP = readJSON(path.join(OUT, 'qqq_nport_top.json'));
  for (const [d, items] of Object.entries(NP)) snaps.push({ date: d, src: 'QQQ N-PORT', items: items.map(r => ({ tk: toT(r.name + ' ' + r.title), value: r.val })) });
  const FD = path.join(OUT, '../qqq_filings'), seen = new Set();
  for (const f of fs.readdirSync(FD).filter(f => /485BPOS/.test(f)).sort()) {
    const txt = fs.readFileSync(path.join(FD, f), 'utf8').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
    const l = (txt.match(/five largest companies represented in the Index as of December 31, [0-9]{4},? were as follows:.{0,500}?%\)\s*\./i) || [])[0];
    const y = +f.slice(0, 4) - 1; if (!l || seen.has(y)) continue; seen.add(y);
    // "follows: A (6.84%), B (6.10%), ... and E (3.59%)." → 按 "%)" 切段，每段末尾是 "名称 (数字"
    const items = l.slice(l.indexOf('follows:') + 8).split('%)').map(seg => seg.match(/^[\s,]*(?:and\s+)?(.+?)\s*\(([0-9.]+)\s*$/)).filter(Boolean)
      .map(m => ({ tk: toT(m[1]), pct: +m[2] * (y >= 2014 && /google|alphabet/i.test(m[1]) ? 0.5 : 1) })); // 2014 后招股书给的是 Alphabet 两条股票线合计，单条约一半
    snaps.push({ date: `${y}-12-31`, src: 'prospectus Dec-31 top5', items });
  }
  // 统一成相对指数股数：s = value(或 pct) / 快照日未复权收盘价
  for (const s of snaps) {
    s.date = s.date; const out = [];
    for (const it of s.items) {
      if (!it.tk) continue;
      const px = await rowOnOrBefore(it.tk, s.date, 5); if (!px) continue;
      out.push({ tk: it.tk, s: (it.value ?? it.pct) / px.c, pxDate: px.d });
    }
    s.shares = out;
  }
  return snaps.filter(s => s.shares.length >= 2).sort((a, b) => a.date.localeCompare(b.date));
}
let SNAPS;
async function splitBetween(tk, a, b) { // 返回从 a 日口径换到 b 日口径的股数乘数
  const s = await series(tk); let f = 1;
  const [lo, hi, inv] = a <= b ? [a, b, false] : [b, a, true];
  for (const r of s.rows) if (r.d > lo && r.d <= hi && r.sf && r.sf !== 1) f *= r.sf;
  return inv ? 1 / f : f;
}
export async function rankIdxAt(d, leaveOut = false) {
  SNAPS ??= await buildSnapshots();
  // leaveOut：核验时不许用 d 当天及之后的快照（只用之前的快照外推），检验股数沿用的误差
  const after = leaveOut ? null : SNAPS.find(s => s.date >= d && (Date.parse(s.date) - Date.parse(d)) / 864e5 <= 16);
  const snap = after || SNAPS.filter(s => s.date < d && (!leaveOut || (Date.parse(d) - Date.parse(s.date)) / 864e5 > 20)).at(-1);
  if (!snap) return { rows: [], snap: null };
  const rows = [];
  for (const it of snap.shares) {
    const px = await rowOnOrBefore(it.tk, d, 4); if (!px) continue;
    rows.push({ tk: it.tk, w: it.s * (await splitBetween(it.tk, it.pxDate, px.d)) * px.c });
  }
  rows.sort((a, b) => b.w - a.w);
  return { rows, snap: `${snap.src} ${snap.date}` };
}
