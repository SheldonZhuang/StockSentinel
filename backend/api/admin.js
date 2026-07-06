import express from 'express';
import { requireAdmin } from './auth.js';
import {
  setAdminSignal,
  getActiveAdminSignal,
  getAdminSignalHistory,
} from '../utils/storage.js';
import { fetchFederalRegister } from './fetch-federal-register.js';

const router = express.Router();
const VALID_SIGNALS = ['loose', 'neutral', 'tight'];
const VALID_TYPES = ['fiscal', 'administrative'];

// GET /api/admin/signals — 当前财政/行政信号位
router.get('/signals', requireAdmin, async (req, res) => {
  const [fiscal, administrative] = await Promise.all([
    getActiveAdminSignal('fiscal'),
    getActiveAdminSignal('administrative'),
  ]);
  res.json({
    fiscal: fiscal?.signal || 'neutral',
    fiscalMeta: fiscal || null,
    administrative: administrative?.signal || 'neutral',
    administrativeMeta: administrative || null,
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

// GET /api/admin/reference?category=fiscal|administrative
router.get('/reference', requireAdmin, async (req, res) => {
  const category = req.query.category === 'administrative' ? 'administrative' : 'fiscal';
  const docs = await fetchFederalRegister(category, 20).catch(err => {
    console.warn('[admin] Federal Register fetch failed:', err.message);
    return [];
  });
  res.json(docs);
});

export default router;
