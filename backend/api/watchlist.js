import express from 'express';
import { requireAuth } from './auth.js';
import { getWatchlist, addToWatchlist, removeFromWatchlist } from '../utils/storage.js';
import { fetchStockData } from './fetch-stocks.js';
import { todayET, daysAgoET } from '../utils/datetime.js';
import { asyncRoute } from '../utils/async-route.js';

const router = express.Router();

const DEFAULT_END = () => todayET();
const DEFAULT_START = () => daysAgoET(3 * 365);
// symbol 允许字母数字与 . ^ -（BRK.B、^GSPC 等），拦住 / ? 等可改写外部 API 请求路径的字符
const SYMBOL_RE = /^[A-Z0-9.^-]{1,10}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/watchlist — 自选股清单 + 股票数据
router.get('/', requireAuth, asyncRoute(async (req, res) => {
  const items = await getWatchlist(req.user.id);
  const startDate = DATE_RE.test(req.query.start) ? req.query.start : DEFAULT_START();
  const endDate = DATE_RE.test(req.query.end) ? req.query.end : DEFAULT_END();

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
}));

// POST /api/watchlist
router.post('/', requireAuth, asyncRoute(async (req, res) => {
  const { symbol } = req.body;
  if (!symbol || typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) {
    return res.status(400).json({ error: 'symbol required' });
  }
  await addToWatchlist(req.user.id, symbol.toUpperCase());
  res.json({ ok: true, symbol: symbol.toUpperCase() });
}));

// DELETE /api/watchlist/:symbol
router.delete('/:symbol', requireAuth, asyncRoute(async (req, res) => {
  await removeFromWatchlist(req.user.id, req.params.symbol);
  res.json({ ok: true });
}));

export default router;
