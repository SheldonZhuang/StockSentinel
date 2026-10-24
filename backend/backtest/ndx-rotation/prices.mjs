// 价格工具：只读缓存（NDX_OFFLINE=1 时绝不联网）。adjClose = Tiingo 拆股+分红复权（总回报口径）。
import { tiingo } from './lib.mjs';
const mem = new Map();
export const MISSING = new Set(); // 离线模式下缓存里没有的代码
export async function series(t) {
  if (!mem.has(t)) {
    let r;
    try { r = await tiingo(t); } catch (e) { if (!/offline/.test(e.message)) throw e; MISSING.add(t); r = { notFound: true }; }
    const rows = r.notFound ? [] : r.rows || []; mem.set(t, { rows, idx: new Map(rows.map((x, i) => [x.d, i])) }); }
  return mem.get(t);
}
/** d 当日或之前最近一行（maxLagDays 内），否则 null */
export async function rowOnOrBefore(t, d, maxLagDays = 6) {
  const s = await series(t); if (!s.rows.length) return null;
  let lo = 0, hi = s.rows.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s.rows[m].d <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
  if (ans < 0) return null;
  const r = s.rows[ans];
  if ((Date.parse(d) - Date.parse(r.d)) / 864e5 > maxLagDays) return null;
  return { ...r, i: ans };
}
export async function rowOn(t, d) { const s = await series(t); const i = s.idx.get(d); return i == null ? null : { ...s.rows[i], i }; }
export async function lastRow(t) { const s = await series(t); return s.rows.at(-1) || null; }
