// 席勒CAPE线上数据源（S5执行台CAPE估值层用，2026-07-19用户确认启用）：
// multpl.com 月度表（Shiller ie_data 同源转载），24h内存缓存 + 失败fail-soft返回null
// （CAPE层未知时S5面板显示"数据不可用"、目标仓位按100%显示——宁可不缩仓也不误缩）。
// 解析器与 backtest/run-backtest.js parseMultplCape 同一实现（复制而非import：
// server运行时不依赖backtest目录；两处已由同一fixture单测锁定一致性）。
import axios from 'axios';

const CAPE_URL = 'https://www.multpl.com/shiller-pe/table/by-month';
const CACHE_TTL_MS = 24 * 3600_000;
const PERCENTILE_WINDOW_MONTHS = 360; // 30年滚动分位（与回测 P3 档同口径）
const CAPE_HIGH_PERCENTILE = 90;      // >90分位 → CAPE层激活（TQQQ目标仓位55%）

let cache = null; // { at, data: {cape, percentile30y, month, layerActive} | null }

/** 解析 multpl 月度表 → 按月升序 [{month:'YYYY-MM', value}] */
export function parseMultplCape(html) {
  const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const re = /<td>([A-Z][a-z]{2}) \d{1,2}, (\d{4})<\/td>\s*<td[^>]*>(?:&[#\w]+;|\s)*([\d.]+)/g;
  const byMonth = new Map();
  let m;
  while ((m = re.exec(html)) !== null) {
    const mm = MONTHS[m[1]];
    const v = parseFloat(m[3]);
    if (!mm || isNaN(v)) continue;
    const month = `${m[2]}-${mm}`;
    if (!byMonth.has(month)) byMonth.set(month, v); // 页面倒序，先见=最新
  }
  return [...byMonth.entries()]
    .map(([month, value]) => ({ month, value }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

/** 最新值在末端N个月窗口内的百分位（0-100）；样本不足120个月 → null */
export function capePercentile30y(seriesAsc) {
  if (!Array.isArray(seriesAsc) || seriesAsc.length < 120) return null;
  const window = seriesAsc.slice(-PERCENTILE_WINDOW_MONTHS).map(o => o.value);
  const latest = window[window.length - 1];
  return Math.round((window.filter(v => v <= latest).length / window.length) * 1000) / 10;
}

/**
 * 当前CAPE状态（24h缓存，fail-soft null）
 * @returns {{cape, percentile30y, month, layerActive}|null}
 */
export async function getCapeState() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  try {
    const res = await axios.get(CAPE_URL, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (StockSentinel research)' },
    });
    const series = parseMultplCape(res.data);
    const pct = capePercentile30y(series);
    const latest = series[series.length - 1] ?? null;
    const data = latest && pct !== null
      ? { cape: latest.value, percentile30y: pct, month: latest.month, layerActive: pct > CAPE_HIGH_PERCENTILE }
      : null;
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    console.warn('[cape] fetch failed (fail-soft):', err.message);
    cache = { at: Date.now() - CACHE_TTL_MS + 3600_000, data: cache?.data ?? null }; // 失败1小时后可重试，沿用旧值
    return cache.data;
  }
}

/** 测试用 */
export function clearCapeCache() { cache = null; }
