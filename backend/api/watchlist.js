import express from 'express';
import { requireAuth } from './auth.js';
import { getWatchlist, addToWatchlist, removeFromWatchlist } from '../utils/storage.js';
import { fetchStockData } from './fetch-stocks.js';

const router = express.Router();

const DEFAULT_END = () => new Date().toISOString().slice(0, 10);
const DEFAULT_START = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 3);
  return d.toISOString().slice(0, 10);
};

// GET /api/watchlist — 自选股清单 + 股票数据
router.get('/', requireAuth, async (req, res) => {
  const items = await getWatchlist(req.user.id);
  const startDate = req.query.start || DEFAULT_START();
  const endDate = req.query.end || DEFAULT_END();

  const enriched = await Promise.allSettled(
    items.map(item => fetchStockData(item.symbol, startDate, endDate))
  );

  const result = items.map((item, i) => ({
    symbol: item.symbol,
    addedAt: item.added_at,
    ...(enriched[i].status === 'fulfilled'
      ? enriched[i].value
      : { error: enriched[i].reason?.message || 'fetch failed' }),
  }));

  res.json(result);
});

// POST /api/watchlist
router.post('/', requireAuth, async (req, res) => {
  const { symbol } = req.body;
  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'symbol required' });
  }
  await addToWatchlist(req.user.id, symbol.toUpperCase());
  res.json({ ok: true, symbol: symbol.toUpperCase() });
});

// DELETE /api/watchlist/:symbol
router.delete('/:symbol', requireAuth, async (req, res) => {
  await removeFromWatchlist(req.user.id, req.params.symbol);
  res.json({ ok: true });
});

export default router;
