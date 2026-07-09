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

const router = express.Router();
const VALID_SIGNALS = ['loose', 'neutral', 'tight'];
const VALID_TYPES = ['fiscal', 'administrative', 'ai_supply'];
// 'auto' 为哨兵值：清除手动设定，回到按环节排名自动识别
const VALID_STAGES = [...chainCfg.STAGE_KEYS, 'auto'];

// GET /api/admin/signals — 当前财政/行政/AI供需信号位
router.get('/signals', requireAdmin, async (req, res) => {
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
});

// POST /api/admin/signals — 设定信号位
router.post('/signals', requireAdmin, async (req, res) => {
  const { type, signal, expiresAt, note } = req.body;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }
  if (!VALID_SIGNALS.includes(signal)) {
    return res.status(400).json({ error: `signal must be one of: ${VALID_SIGNALS.join(', ')}` });
  }

  await setAdminSignal(type, signal, expiresAt || null, note || null, req.user.email);
  res.json({ ok: true, type, signal, expiresAt });
});

// GET /api/admin/signal-history
router.get('/signal-history', requireAdmin, async (req, res) => {
  const history = await getAdminSignalHistory(100);
  res.json(history);
});

// GET /api/admin/reference?category=fiscal|administrative|ai_supply
router.get('/reference', requireAdmin, async (req, res) => {
  const category = ['administrative', 'ai_supply'].includes(req.query.category) ? req.query.category : 'fiscal';
  const fetcher = category === 'ai_supply'
    ? () => fetchAiSupplyNews(20)                 // 英伟达官方新闻+博客 + TrendForce
    : () => fetchFederalRegister(category, 20);   // Federal Register 关键词检索
  const docs = await fetcher().catch(err => {
    console.warn(`[admin] reference(${category}) fetch failed:`, err.message);
    return [];
  });
  res.json(docs);
});

// POST /api/admin/bottleneck — 设定当前AI产业链最卡脖子环节
router.post('/bottleneck', requireAdmin, async (req, res) => {
  const { stage, note } = req.body;
  if (!VALID_STAGES.includes(stage)) {
    return res.status(400).json({ error: `stage must be one of: ${VALID_STAGES.join(', ')}` });
  }
  await setBottleneck(stage, note || null, req.user.email);
  res.json({ ok: true, stage, note: note || null });
});

export default router;
