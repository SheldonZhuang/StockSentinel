// 开放API /v1/*：面向 AI 客户端（MCP/GPT Actions）与第三方开发者
// 鉴权：X-API-Key 请求头（或 ?api_key=）；无 key 走按 IP 的试用额度
// 限流：内存计数按 UTC 日重置（进程重启即重置——MVP 取舍，接入计费后换持久化）
import express from 'express';
import cors from 'cors';
import { asyncRoute } from '../utils/async-route.js';
import { buildSignalPayload, buildAiChainPayload } from './payloads.js';
import { fetchStockData } from './fetch-stocks.js';
import { getSnapshotHistory, getApiKeyRecord, getLatestDailyReport, loadApiUsage, upsertApiUsage } from '../utils/storage.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// 公开API对所有来源开放（区别于内部 /api/* 的白名单CORS）
router.use(cors({ origin: '*' }));

// 每日请求额度（UTC日）：keyless 试用 / free / pro
const TIER_DAILY_LIMITS = { keyless: 25, free: 250, pro: 10000 };

const usage = new Map(); // identifier → { day, count }

// 用量持久化：进程重启不清零（限流公平性 + 计费对账底账）。
// 写路径批量化：内存实时计数，60秒脏刷盘，避免每请求整库 persist
let usageLoadedDay = null;
let usageDirty = false;

async function ensureUsageLoaded(day) {
  if (usageLoadedDay === day) return;
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

async function resolveTier(req) {
  const key = req.get('X-API-Key') || req.query.api_key;
  if (!key) return { id: `ip:${req.ip}`, tier: 'keyless' };

  const cached = keyCache.get(key);
  let record = cached && Date.now() - cached.at < KEY_CACHE_TTL_MS ? cached.record : undefined;
  if (record === undefined) {
    record = await getApiKeyRecord(key).catch(() => null);
    keyCache.set(key, { record, at: Date.now() });
  }
  if (!record) return null; // 无效或已禁用的 key
  return { id: `key:${key}`, tier: record.tier in TIER_DAILY_LIMITS ? record.tier : 'free' };
}

async function rateLimit(req, res, next) {
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
