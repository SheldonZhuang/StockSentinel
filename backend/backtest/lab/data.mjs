// 策略实验室数据层：日线面板（Tiingo 复权总回报）+ 无风险利率 + 杠杆 ETF 合成回补。
// 价格缓存复用 ndx-rotation 的 Tiingo 落盘（backend/data/_ndx_rotation/tiingo，已 gitignore）；NDX_OFFLINE=1 时不联网。
// 合成口径（与 tqqq-schemes.mjs 一致）：L 倍日杠杆 nav ×= 1 + L·r − (L−1)·rf_d − ER_d；真实 ETF 上市后用真实数据并按首日拼接。
import axios from 'axios';
import { tiingo, cached } from '../ndx-rotation/lib.mjs';

/** 杠杆 ETF：合成用的底层、倍数、费率（%/年）。底层缺数据时用更早的替代（SOXX 2001 起 → 2000 段不可用） */
export const LEVERED = {
  TQQQ: { base: 'QQQ', L: 3, er: 0.86 },
  QLD: { base: 'QQQ', L: 2, er: 0.95 },
  SOXL: { base: 'SOXX', L: 3, er: 0.89 },
  UPRO: { base: 'SPY', L: 3, er: 0.91 },
  SSO: { base: 'SPY', L: 2, er: 0.89 },
};
/** 合成杠杆的融资利差（%/年，加在 rf 上、按借入的 L−1 倍计）：五只真实 ETF 上市后重叠期反解为 0.54–0.81%，取 0.6%
 *  （2026-10-24 校准；不加时合成年化比真实高 0.8–2.2pp） */
export const SWAP_SPREAD = 0.6;
/** 早期替代：ETF 上市前用同类共同基金的总回报拼接（只用收益率，不用价格水平） */
export const PROXY = { TLT: 'VUSTX', IEF: 'VUSTX', AGG: 'VBMFX', EFA: 'VGTSX', SPY: 'VFINX' };

/** FRED 日频 3 个月国库券（DTB3，%），缓存落盘；周末/缺值前值沿用 */
export async function riskFree() {
  const txt = await cached('fred/DTB3.json', async () => {
    const r = await axios.get('https://api.stlouisfed.org/fred/series/observations', {
      params: { series_id: 'DTB3', api_key: process.env.FRED_API_KEY, file_type: 'json', observation_start: '1998-01-01' }, timeout: 60000 });
    return JSON.stringify(r.data.observations.filter(o => o.value !== '.').map(o => [o.date, +o.value]));
  });
  const obs = JSON.parse(txt);
  return d => { // 二分取 d 当日或之前最近值
    let lo = 0, hi = obs.length - 1, a = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (obs[m][0] <= d) { a = m; lo = m + 1; } else hi = m - 1; }
    return obs[a][1];
  };
}

async function rawRows(t) {
  const r = await tiingo(t);
  if (r.notFound || !r.rows?.length) throw new Error(`no data for ${t}`);
  return r.rows;
}

/** 日收益序列 Map<date, r>（adjClose 口径），可选用替代基金/合成回补到真实上市之前 */
async function returnsOf(t, { extend, rf }) {
  const rows = await rawRows(t);
  const out = new Map();
  for (let i = 1; i < rows.length; i++) out.set(rows[i].d, rows[i].ac / rows[i - 1].ac - 1);
  if (!extend) return { ret: out, first: rows[0].d, synthFrom: null };
  const first = rows[0].d;
  let early = null;
  if (LEVERED[t]) {
    const { base, L, er } = LEVERED[t];
    const b = await returnsOf(base, { extend: true, rf });
    early = new Map([...b.ret].filter(([d]) => d <= first).map(([d, r]) => [d, L * r - (L - 1) * (rf(d) + SWAP_SPREAD) / 100 / 252 - er / 100 / 252]));
  } else if (PROXY[t]) {
    early = (await returnsOf(PROXY[t], { extend: false })).ret;
    early = new Map([...early].filter(([d]) => d <= first));
  }
  if (!early?.size) return { ret: out, first, synthFrom: null };
  return { ret: new Map([...early, ...out].sort((a, b) => (a[0] < b[0] ? -1 : 1))), first: [...early.keys()][0], synthFrom: first };
}

/**
 * 面板：共同交易日历上的总回报指数（起点 1）与日收益。
 * @param {string[]} syms
 * @param {{from?:string, to?:string, extend?:boolean}} opts extend=true 时杠杆 ETF 合成回补、债券/海外用共同基金回补
 * @returns {{dates:string[], px:Record<string,Float64Array>, ret:Record<string,Float64Array>, rf:Float64Array, meta}}
 */
export async function loadPanel(syms, { from = '1999-01-01', to = '9999-12-31', extend = true } = {}) {
  const rf = await riskFree();
  const series = {}, meta = {};
  for (const s of syms) {
    const r = await returnsOf(s, { extend, rf });
    series[s] = r.ret; meta[s] = { first: r.first, synthUntil: r.synthFrom };
  }
  // 共同日历：所有标的都有收益的日子（起点取最晚的首日）
  let dates = [...series[syms[0]].keys()].filter(d => d >= from && d <= to);
  for (const s of syms.slice(1)) dates = dates.filter(d => series[s].has(d));
  dates.sort();
  const n = dates.length, px = {}, ret = {};
  for (const s of syms) {
    const r = new Float64Array(n), p = new Float64Array(n);
    for (let i = 0; i < n; i++) { r[i] = i === 0 ? 0 : series[s].get(dates[i]); p[i] = i === 0 ? 1 : p[i - 1] * (1 + r[i]); }
    ret[s] = r; px[s] = p;
  }
  const rfd = Float64Array.from(dates, d => rf(d) / 100 / 252);
  // CASH：按 3 个月国库券逐日计息的虚拟资产，策略可显式持有或用于动量比较（第 0 日收益记 0，与其他资产一致）
  ret.CASH = Float64Array.from(rfd, (v, i) => (i === 0 ? 0 : v));
  px.CASH = new Float64Array(n); for (let i = 0; i < n; i++) px.CASH[i] = i === 0 ? 1 : px.CASH[i - 1] * (1 + ret.CASH[i]);
  return { dates, px, ret, rf: rfd, meta };
}
