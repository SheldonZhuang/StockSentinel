import express from 'express';
import { requireAdmin } from './auth.js';
import {
  setAdminSignal,
  getActiveAdminSignal,
  getAdminSignalHistory,
  setBottleneck,
} from '../utils/storage.js';
import { fetchFederalRegister } from './fetch-federal-register.js';
import { fetchAiSupplyNews } from './fetch-rss.js';
import chainCfg from '../config/ai-chain.config.js';
import { asyncRoute } from '../utils/async-route.js';

const router = express.Router();
const VALID_SIGNALS = ['loose', 'neutral', 'tight'];
const VALID_TYPES = ['fiscal', 'administrative', 'ai_supply'];
const VALID_LOCK_TYPES = ['sahmLock', 'reactiveAdjustmentLock'];
const LOCK_CLEAR_SIGNAL = 'cleared';
// 'auto' 为哨兵值：清除手动设定，回到按环节排名自动识别
const VALID_STAGES = [...chainCfg.STAGE_KEYS, 'auto'];

/**
 * 归一化 expiresAt 为 UTC 'YYYY-MM-DD HH:MM:SS'（与 SQLite datetime('now') 同格式才能字符串比较；
 * datetime-local 的 'T' 分隔本地时间串直接入库会导致过期判定漂移最多一整天）
 * 空值 → null（永不过期）；无法解析 → undefined（调用方拒绝）
 */
function normalizeExpiresAt(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input !== 'string') return undefined;
  const d = new Date(input);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// GET /api/admin/signals — 当前财政/行政/AI供需信号位
router.get('/signals', requireAdmin, asyncRoute(async (req, res) => {
  const [fiscal, administrative, aiSupply] = await Promise.all([
    getActiveAdminSignal('fiscal'),
    getActiveAdminSignal('administrative'),
    getActiveAdminSignal('ai_supply'),
  ]);
  res.json({
    fiscal: fiscal?.signal || 'neutral',
    fiscalMeta: fiscal || null,
    administrative: administrative?.signal || 'neutral',
    administrativeMeta: administrative || null,
    aiSupply: aiSupply?.signal || 'neutral',
    aiSupplyMeta: aiSupply || null,
  });
}));

// POST /api/admin/signals — 设定信号位
router.post('/signals', requireAdmin, asyncRoute(async (req, res) => {
  const { type, signal, expiresAt, note } = req.body;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }
  if (!VALID_SIGNALS.includes(signal)) {
    return res.status(400).json({ error: `signal must be one of: ${VALID_SIGNALS.join(', ')}` });
  }
  const normalizedExpiresAt = normalizeExpiresAt(expiresAt);
  if (normalizedExpiresAt === undefined) {
    return res.status(400).json({ error: 'expiresAt must be a valid datetime string' });
  }

  await setAdminSignal(type, signal, normalizedExpiresAt, note || null, req.user.email);
  res.json({ ok: true, type, signal, expiresAt: normalizedExpiresAt });
}));

// POST /api/admin/lock-override — 应急清除萨姆锁/应对式调整锁（FRED数据异常误触发时用）
router.post('/lock-override', requireAdmin, asyncRoute(async (req, res) => {
  const { type, expiresAt, note } = req.body;

  if (!VALID_LOCK_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_LOCK_TYPES.join(', ')}` });
  }
  const normalizedExpiresAt = normalizeExpiresAt(expiresAt);
  if (normalizedExpiresAt === undefined) {
    return res.status(400).json({ error: 'expiresAt must be a valid datetime string' });
  }

  await setAdminSignal(type, LOCK_CLEAR_SIGNAL, normalizedExpiresAt, note || null, req.user.email);
  res.json({ ok: true, type, expiresAt: normalizedExpiresAt });
}));

// GET /api/admin/signal-history
router.get('/signal-history', requireAdmin, asyncRoute(async (req, res) => {
  const history = await getAdminSignalHistory(100);
  res.json(history);
}));

// GET /api/admin/reference?category=fiscal|administrative|ai_supply
router.get('/reference', requireAdmin, asyncRoute(async (req, res) => {
  const category = ['administrative', 'ai_supply'].includes(req.query.category) ? req.query.category : 'fiscal';
  const fetcher = category === 'ai_supply'
    ? () => fetchAiSupplyNews(20)                 // 英伟达官方新闻+博客 + TrendForce
    : () => fetchFederalRegister(category, 20);   // Federal Register 关键词检索
  const docs = await fetcher().catch(err => {
    console.warn(`[admin] reference(${category}) fetch failed:`, err.message);
    return [];
  });
  res.json(docs);
}));

// POST /api/admin/bottleneck — 设定当前AI产业链最卡脖子环节
router.post('/bottleneck', requireAdmin, asyncRoute(async (req, res) => {
  const { stage, note } = req.body;
  if (!VALID_STAGES.includes(stage)) {
    return res.status(400).json({ error: `stage must be one of: ${VALID_STAGES.join(', ')}` });
  }
  await setBottleneck(stage, note || null, req.user.email);
  res.json({ ok: true, stage, note: note || null });
}));

export default router;
