// 共享工具：磁盘缓存、Tiingo/TwelveData/EDGAR/通用 HTTP 抓取（全部串行限速，结果落盘只下一次）
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { edgarGet } from '../../utils/edgar-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA = path.resolve(HERE, '../../data/_ndx_rotation');
export const OUT = path.join(DATA, 'out');
for (const d of [DATA, OUT]) fs.mkdirSync(d, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const OFFLINE = process.env.NDX_OFFLINE === '1';

export function readJSON(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
export function writeJSON(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 1)); }

/** 通用缓存：文件存在直接读，否则调用 fetcher 并落盘。fetcher 返回字符串。 */
export async function cached(rel, fetcher) {
  const f = path.join(DATA, rel);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  if (OFFLINE) throw new Error('offline, missing cache: ' + rel);
  const txt = await fetcher();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, txt);
  return txt;
}

let lastHttp = 0;
export async function httpText(url, minGapMs = 1100) {
  const wait = lastHttp + minGapMs - Date.now(); if (wait > 0) await sleep(wait);
  lastHttp = Date.now();
  const r = await axios.get(url, { timeout: 60000, responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0 research-backtest' } });
  return r.data;
}

export const edgarText = (url) => edgarGet(url, { responseType: 'text', timeout: 60000 }).then(r => typeof r.data === 'string' ? r.data : JSON.stringify(r.data));

/** Tiingo 日线（含 adjOpen/adjClose）；404 记为 null 结果也落盘，避免重复请求。 */
let lastTiingo = 0;
export async function tiingo(ticker) {
  const rel = `tiingo/${ticker.replace(/[^A-Za-z0-9.-]/g, '_')}.json`;
  const txt = await cached(rel, async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const wait = lastTiingo + 1100 - Date.now(); if (wait > 0) await sleep(wait);
      lastTiingo = Date.now();
      try {
        const r = await axios.get(`https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}/prices`, {
          params: { startDate: '1998-12-01', token: process.env.TIINGO_API_KEY }, timeout: 60000 });
        return JSON.stringify({ ticker, fetched: new Date().toISOString(), rows: r.data.map(d => ({ d: d.date.slice(0, 10), o: d.open, c: d.close, ao: d.adjOpen, ac: d.adjClose, v: d.volume, sf: d.splitFactor, dv: d.divCash })) });
      } catch (e) {
        const s = e?.response?.status;
        if (s === 404) return JSON.stringify({ ticker, notFound: true, msg: String(e?.response?.data?.detail || '') });
        if (s === 429) { const msg = String(e?.response?.data?.detail || ''); if (/day|daily/i.test(msg) && !/hour/i.test(msg)) throw new Error('tiingo daily limit'); console.error(new Date().toISOString(), 'tiingo 429 (hourly), sleeping 10 min before', ticker); await sleep(600000); continue; }
        if (!s || s >= 500) { await sleep(5000 * (attempt + 1)); continue; }
        throw new Error(`tiingo ${ticker} HTTP ${s}`); // 不打印 URL（含 token）
      }
    }
    throw new Error('tiingo retries exhausted ' + ticker);
  });
  return JSON.parse(txt);
}

/** Tiingo 元数据（起止日期、名称） */
export async function tiingoMeta(ticker) {
  const rel = `tiingo_meta/${ticker.replace(/[^A-Za-z0-9.-]/g, '_')}.json`;
  return JSON.parse(await cached(rel, async () => {
    const wait = lastTiingo + 1100 - Date.now(); if (wait > 0) await sleep(wait);
    lastTiingo = Date.now();
    try {
      const r = await axios.get(`https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}`, { params: { token: process.env.TIINGO_API_KEY }, timeout: 30000 });
      return JSON.stringify(r.data);
    } catch (e) { if (e?.response?.status === 404) return JSON.stringify({ notFound: true }); throw new Error(`tiingo meta ${ticker} HTTP ${e?.response?.status}`); }
  }));
}
