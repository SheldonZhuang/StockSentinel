// 开放API /v1/*：面向 AI 客户端（MCP/GPT Actions）与第三方开发者
// 鉴权：X-API-Key 请求头（或 ?api_key=）；无 key 走按 IP 的试用额度
// 限流：内存计数按 UTC 日重置（进程重启即重置——MVP 取舍，接入计费后换持久化）
import express from 'express';
import cors from 'cors';
import { asyncRoute } from '../utils/async-route.js';
import { buildSignalPayload, buildAiChainPayload } from './payloads.js';
import { fetchStockData } from './fetch-stocks.js';
import { getSnapshotHistory, getApiKeyRecord, getLatestDailyReport, loadApiUsage, upsertApiUsage, pruneApiUsage } from '../utils/storage.js';
import { ipRateLimit } from '../utils/ip-rate-limit.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// 公开API对所有来源开放（区别于内部 /api/* 的白名单CORS）
router.use(cors({ origin: '*' }));

// 按 IP 保底限流：无效 key / keyless 走 401 路径不计日额度，需此闸防止匿名高频刷 DB 与烧配额
router.use(ipRateLimit({ max: 120 }));

// 每日请求额度（UTC日）：keyless 试用 / free / pro
const TIER_DAILY_LIMITS = { keyless: 25, free: 250, pro: 10000 };

const usage = new Map(); // identifier → { day, count }
const USAGE_MAX = 50_000; // 容量上限：keyless 条目是 `ip:x`，轮换 IPv6 可无限造新键，无上限会撑到 OOM

// 用量持久化：进程重启不清零（限流公平性 + 计费对账底账）。
// 写路径批量化：内存实时计数，60秒脏刷盘，避免每请求整库 persist
let usageLoadedDay = null;
let usageDirty = false;

async function ensureUsageLoaded(day) {
  if (usageLoadedDay === day) return;
  // 日切清理：昨日条目已失效，keyless 的 `ip:x` 键只增不删会随天数无界累积
  for (const [k, v] of usage) {
    if (v.day !== day) usage.delete(k);
  }
  try {
    const rows = await loadApiUsage(day);
    for (const r of rows) {
      const cur = usage.get(r.identifier);
      if (!cur || cur.day !== day || cur.count < r.count) {
        usage.set(r.identifier, { day, count: r.count });
      }
    }
  } catch (err) {
    console.warn('[public-api] usage load failed:', err.message);
  }
  usageLoadedDay = day;
  // 表侧同款清理（每日一次）：保留400天做计费对账，更早的 ip:x 底账只增不删会无界膨胀
  const cutoff = new Date(Date.parse(day) - 400 * 86400000).toISOString().slice(0, 10);
  pruneApiUsage(cutoff).catch(err => console.warn('[public-api] usage prune failed:', err.message));
}

const flushTimer = setInterval(async () => {
  if (!usageDirty) return;
  usageDirty = false;
  const day = new Date().toISOString().slice(0, 10);
  const entries = [...usage.entries()]
    .filter(([, v]) => v.day === day)
    .map(([identifier, v]) => ({ identifier, count: v.count }));
  if (!entries.length) return;
  try {
    await upsertApiUsage(day, entries);
  } catch (err) {
    usageDirty = true; // 下轮重试
    console.warn('[public-api] usage flush failed:', err.message);
  }
}, 60_000);
flushTimer.unref(); // 不阻塞进程退出
const keyCache = new Map(); // key → { record, at }
const KEY_CACHE_TTL_MS = 5 * 60 * 1000;
const KEY_CACHE_MAX = 5000; // 上限防投毒：轮换随机无效 key 会让缓存无界增长直至 OOM

// 管理员禁用 key 后调用，立即失效缓存——否则被盗刷的 key 在"禁用"后仍可用最长 5 分钟，
// 恰是应急止损最关键的时刻。按 id 反查不便，直接清空（缓存重建成本极低）。
export function invalidateKeyCache() {
  keyCache.clear();
}

async function resolveTier(req) {
  // 只认 X-API-Key 请求头：查询参数 ?api_key= 会泄漏到代理/平台日志、浏览器历史、Referer，
  // 等于把长期有效的付费密钥写进多处明文日志，已移除该支持
  const key = req.get('X-API-Key');
  if (!key) return { id: `ip:${req.ip}`, tier: 'keyless' };

  const cached = keyCache.get(key);
  let record = cached && Date.now() - cached.at < KEY_CACHE_TTL_MS ? cached.record : undefined;
  if (record === undefined) {
    record = await getApiKeyRecord(key).catch(() => null);
    // 容量上限：超限先清过期项，仍超则清空——防止轮换随机无效 key 撑爆内存
    if (keyCache.size >= KEY_CACHE_MAX) {
      const now = Date.now();
      for (const [k, v] of keyCache) {
        if (now - v.at >= KEY_CACHE_TTL_MS) keyCache.delete(k);
      }
      if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
    }
    keyCache.set(key, { record, at: Date.now() });
  }
  if (!record) return null; // 无效或已禁用的 key
  return { id: `key:${key}`, tier: record.tier in TIER_DAILY_LIMITS ? record.tier : 'free' };
}

export async function rateLimit(req, res, next) {
  const resolved = await resolveTier(req);
  if (!resolved) {
    return res.status(401).json({ error: 'invalid_api_key', message: 'API key is invalid or disabled' });
  }
  const limit = TIER_DAILY_LIMITS[resolved.tier];
  const day = new Date().toISOString().slice(0, 10);
  await ensureUsageLoaded(day);
  const entry = usage.get(resolved.id);
  const count = entry && entry.day === day ? entry.count : 0;

  if (count >= limit) {
    res.set('X-RateLimit-Limit', String(limit));
    res.set('X-RateLimit-Remaining', '0');
    return res.status(429).json({
      error: 'rate_limited',
      message: `Daily limit of ${limit} requests reached (tier: ${resolved.tier}). Get an API key for higher limits.`,
    });
  }
  // 同日容量兜底（keyCache 同款策略）：新键且已到上限时清空重载，
  // 已持久化的计数从 DB 恢复，仅丢失 ≤60s 未刷盘增量——宁可短暂放宽也不 OOM
  if (!entry && usage.size >= USAGE_MAX) {
    usage.clear();
    usageLoadedDay = null;
    await ensureUsageLoaded(day);
  }
  usage.set(resolved.id, { day, count: count + 1 });
  usageDirty = true;
  res.set('X-RateLimit-Limit', String(limit));
  res.set('X-RateLimit-Remaining', String(limit - count - 1));
  next();
}

router.use((req, res, next) => { rateLimit(req, res, next).catch(next); });

// 所有响应统一附免责声明字段
const withDisclaimer = payload => ({
  ...payload,
  disclaimer: 'For research reference only. Not investment advice. 仅供研究参考，不构成投资建议。',
});

// GET /v1/signal — 当前进攻/防守信号（四档）+ 四维明细 + 全部参考指标
router.get('/signal', asyncRoute(async (req, res) => {
  const payload = await buildSignalPayload();
  if (!payload) return res.status(503).json({ error: 'warming_up', message: 'No snapshot yet, try again later' });
  res.json(withDisclaimer(payload));
}));

// GET /v1/signal/history?limit=90 — 信号历史（公开 track record）
router.get('/signal/history', asyncRoute(async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 90, 365));
  const rows = await getSnapshotHistory(limit);
  res.json(withDisclaimer({
    history: rows.map(r => ({
      date: r.date,
      finalSignal: r.final_signal,
      aiSupply: r.ai_supply_signal,
      monetary: r.monetary_signal,
      fiscal: r.fiscal_signal,
      administrative: r.admin_signal,
    })),
  }));
}));

// GET /v1/ai-chain — AI产业链环节排名 + 卡点 + 泡沫监测
router.get('/ai-chain', asyncRoute(async (req, res) => {
  res.json(withDisclaimer(await buildAiChainPayload()));
}));

// GET /v1/stock/:symbol?startDate=&endDate= — 个股价格百分位 + P/E + P/S
const SYMBOL_RE = /^[A-Z0-9.^=-]{1,12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
router.get('/stock/:symbol', asyncRoute(async (req, res) => {
  const { symbol } = req.params;
  if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: 'bad_symbol' });
  const endDate = DATE_RE.test(req.query.endDate) ? req.query.endDate : new Date().toISOString().slice(0, 10);
  const startDate = DATE_RE.test(req.query.startDate)
    ? req.query.startDate
    : new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);
  const data = await fetchStockData(symbol.toUpperCase(), startDate, endDate);
  res.json(withDisclaimer(data));
}));

// GET /v1/backtest/summary — 最近一次历史回测的核心结论（重跑 node backtest/run-backtest.js 更新）
router.get('/backtest/summary', asyncRoute(async (req, res) => {
  const p = path.join(__dirname, '../backtest/backtest-raw.json');
  if (!fs.existsSync(p)) {
    return res.status(404).json({ error: 'not_available', message: 'Backtest has not been run on this deployment' });
  }
  const { summary } = JSON.parse(fs.readFileSync(p, 'utf8'));
  res.json(withDisclaimer({ summary }));
}));

// GET /v1/daily-report — AI 生成的每日信号解读（中英双语）
router.get('/daily-report', asyncRoute(async (req, res) => {
  const report = await getLatestDailyReport();
  if (!report) return res.status(404).json({ error: 'not_available', message: 'No daily report generated yet' });
  res.json(withDisclaimer({
    date: report.date,
    zh: report.content_zh,
    en: report.content_en,
    model: report.model,
  }));
}));

export default router;
