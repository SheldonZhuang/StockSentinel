import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

import authRouter from './api/auth.js';
import adminRouter from './api/admin.js';
import watchlistRouter from './api/watchlist.js';
import { requireAuth } from './api/auth.js';

import { fetchMacroData } from './api/fetch-macro.js';
import { calcMonetarySignal, calcFinalSignal } from './api/signal.js';
import {
  getLatestSnapshot,
  saveSignalSnapshot,
  getSnapshotHistory,
  getActiveAdminSignal,
  getAlertSubscribers,
  getBottleneck,
} from './utils/storage.js';
import { sendSignalAlert } from './utils/mailer.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// --- 路由 ---
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/watchlist', watchlistRouter);

// GET /api/signal — 当前宏观信号 + 各信号位明细
app.get('/api/signal', async (req, res) => {
  const snapshot = await getLatestSnapshot();
  if (!snapshot) return res.json({ status: 'loading', message: 'No data yet, cron will run soon' });

  const [fiscalOverride, adminOverride, aiSupplyOverride] = await Promise.all([
    getActiveAdminSignal('fiscal'),
    getActiveAdminSignal('administrative'),
    getActiveAdminSignal('ai_supply'),
  ]);

  res.json({
    finalSignal: snapshot.final_signal,
    monetarySignal: snapshot.monetary_signal,
    fiscalSignal: fiscalOverride?.signal || snapshot.fiscal_signal,
    adminSignal: adminOverride?.signal || snapshot.admin_signal,
    aiSupplySignal: aiSupplyOverride?.signal || snapshot.ai_supply_signal,
    indicators: {
      rate: snapshot.fred_rate,
      ratePrev: snapshot.fred_rate_prev,
      balanceSheet: snapshot.fred_balance_sheet,
      balanceSheetPrev: snapshot.fred_balance_sheet_prev,
      corePce: snapshot.fred_core_pce,
      trimmedPce: snapshot.fred_trimmed_pce,
      unemployment: snapshot.fred_unemployment,
    },
    dataDate: snapshot.date,
    createdAt: snapshot.created_at,
  });
});

// GET /api/signal/history
app.get('/api/signal/history', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 90, 365);
  const history = await getSnapshotHistory(limit);
  res.json(history);
});

// GET /api/bottleneck — 当前AI产业链最卡脖子环节（公开只读）
app.get('/api/bottleneck', async (req, res) => {
  const bottleneck = await getBottleneck();
  res.json({ stage: bottleneck?.stage || null, note: bottleneck?.note || null });
});

// GET /api/user/me — 当前用户信息 + 是否是 admin
app.get('/api/user/me', requireAuth, async (req, res) => {
  const isAdmin = req.user.email === process.env.ADMIN_EMAIL;
  res.json({ id: req.user.id, email: req.user.email, isAdmin });
});

// --- cron 任务 ---
async function runDailyUpdate() {
  console.log('[cron] Starting daily signal update...');

  let macroData;
  try {
    macroData = await fetchMacroData();
  } catch (err) {
    console.error('[cron] FRED fetch failed:', err.message);
    return;
  }

  const monetary = calcMonetarySignal(macroData);

  const [fiscalOverride, adminOverride, aiSupplyOverride] = await Promise.all([
    getActiveAdminSignal('fiscal'),
    getActiveAdminSignal('administrative'),
    getActiveAdminSignal('ai_supply'),
  ]);

  const fiscal = fiscalOverride?.signal || 'neutral';
  const admin = adminOverride?.signal || 'neutral';
  const aiSupply = aiSupplyOverride?.signal || 'neutral';
  const finalSignal = calcFinalSignal(monetary, fiscal, admin, aiSupply);

  const today = new Date().toISOString().slice(0, 10);
  const prevSnapshot = await getLatestSnapshot();

  await saveSignalSnapshot({
    date: today,
    monetarySignal: monetary,
    fiscalSignal: fiscal,
    adminSignal: admin,
    aiSupplySignal: aiSupply,
    finalSignal,
    fredRate: macroData.currentRate,
    fredRatePrev: macroData.prevRate,
    fredBalanceSheet: macroData.currentBalanceSheet,
    fredBalanceSheetPrev: macroData.prevBalanceSheet,
    fredCorePce: macroData.corePce,
    fredTrimmedPce: macroData.trimmedPce,
    fredUnemployment: macroData.unemployment,
  });

  console.log(`[cron] Signal updated: monetary=${monetary}, fiscal=${fiscal}, admin=${admin}, aiSupply=${aiSupply} → final=${finalSignal}`);

  // 信号变更 → 发送邮件提醒
  if (prevSnapshot && prevSnapshot.final_signal !== finalSignal) {
    const subscribers = await getAlertSubscribers();
    if (subscribers.length > 0) {
      console.log(`[cron] Signal changed ${prevSnapshot.final_signal} → ${finalSignal}, alerting ${subscribers.length} users`);
      await sendSignalAlert(subscribers, prevSnapshot.final_signal, finalSignal);
    }
  }
}

// 每天 UTC 06:00 执行（美东01:00，北京14:00）
cron.schedule('0 6 * * *', runDailyUpdate, { timezone: 'UTC' });

// 启动时立即执行一次
runDailyUpdate().catch(err => console.error('[startup] initial update failed:', err));

app.listen(PORT, () => {
  console.log(`[server] Stock Sentinel backend running on http://localhost:${PORT}`);
});
