// S2 排名：指数股票线市值 = 流通股（filed<=参考日的最新申报，按拆股调整到参考日）× 参考日未复权收盘价
import path from 'path';
import { readJSON, OUT } from './lib.mjs';
import { series, rowOnOrBefore } from './prices.mjs';
const cover = readJSON(path.join(OUT, 'shares_cover.json'));
const dei = readJSON(path.join(OUT, 'shares_dei.json'));
const XBRL_FROM = '2009-10-01'; // 之后用 dei（各家 2009Q3 起都有）
export const CANDS = ['MSFT', 'CSCO', 'INTC', 'ORCL', 'AAPL', 'QCOM', 'AMGN', 'AMZN', 'NVDA', 'AVGO', 'TSLA', 'EBAY', 'DELL'];

function sharesAsOf(tk, d) {
  const useDei = d >= XBRL_FROM;
  const pts = useDei ? (dei[tk] || []).map(p => ({ filed: p.filed, val: p.val })) : (cover[tk] || []).filter(p => p.val);
  // 剔除单位错报的离群点（如 QCOM 2011-04/2011-11 dei 值放大了 1000 倍）：与前后相邻值都相差 >60% 的点丢弃
  const srt = pts.slice().sort((a, b) => a.filed.localeCompare(b.filed));
  const clean = srt.filter((p, i) => { const a = srt[i - 1]?.val, b = srt[i + 1]?.val; const off = x => x && Math.abs(p.val / x - 1) > 0.6; return !((a ? off(a) : true) && (b ? off(b) : true) && (a || b)); });
  const ok = clean.filter(p => p.filed <= d);
  return ok.at(-1) || null;
}
async function splitAdj(tk, from, to) { // (from, to] 区间内的拆股乘数
  const s = await series(tk); let f = 1;
  for (const r of s.rows) if (r.d > from && r.d <= to && r.sf && r.sf !== 1) f *= r.sf;
  return f;
}
export async function rankAt(d) {
  const rows = [];
  for (const tk of CANDS) {
    const sh = sharesAsOf(tk, d); if (!sh) continue;
    if (d < '2009-10-01' && (Date.parse(d) - Date.parse(sh.filed)) / 864e5 > 400) continue; // 太旧（已退市或无申报）
    const px = await rowOnOrBefore(tk, d, 4); if (!px) continue;
    const adj = await splitAdj(tk, sh.filed, px.d);
    rows.push({ tk, cap: sh.val * adj * px.c, shares: sh.val * adj, px: px.c, filed: sh.filed });
  }
  return rows.sort((a, b) => b.cap - a.cap);
}

