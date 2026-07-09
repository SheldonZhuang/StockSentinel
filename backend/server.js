import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

import authRouter from './api/auth.js';
import adminRouter from './api/admin.js';
import watchlistRouter from './api/watchlist.js';
import { requireAuth } from './api/auth.js';

import { fetchMacroData } from './api/fetch-macro.js';
import { fetchPolicyData } from './api/fetch-policy.js';
import {
  calcMonetarySignal,
  calcFinalSignal,
  calcFiscalSignal,
  calcAdminSignal,
  calcAiSupplySignal,
  deriveAiSupplySubSignals,
} from './api/signal.js';
import {
  getLatestSnapshot,
  saveSignalSnapshot,
  getSnapshotHistory,
  getAlertSubscribers,
  getBottleneck,
  getAllOverrides,
} from './utils/storage.js';
import { sendSignalAlert } from './utils/mailer.js';
import { todayET } from './utils/datetime.js';

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  'http://localhost:5173',
  'https://stock-sentinel-eight.vercel.app',
];

app.use(cors({
  origin: allowedOrigins,
}));
app.use(express.json());

// --- 路由 ---
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/watchlist', watchlistRouter);

// GET /api/signal — 当前宏观信号 + 各信号位明细
app.get('/api/signal', async (req, res) => {
  const snapshot = await getLatestSnapshot();
  if (!snapshot) return res.json({ status: 'loading', message: 'No data yet, cron will run soon' });

  const { fiscal: fiscalOverride, administrative: adminOverride, aiSupply: aiSupplyOverride } = await getAllOverrides();

  // 生效值 = 手动覆盖优先，否则自动判定；旧快照没有 *_auto_signal 时兜底到当时存的生效值
  const fiscalSignal = fiscalOverride?.signal || snapshot.fiscal_auto_signal || snapshot.fiscal_signal;
  const adminSignal = adminOverride?.signal || snapshot.admin_auto_signal || snapshot.admin_signal;
  const aiSupplySignal = aiSupplyOverride?.signal || snapshot.ai_supply_auto_signal || snapshot.ai_supply_signal;

  res.json({
    // 读取时实时重算，避免 override 在 cron 之后变化导致与快照不一致
    finalSignal: calcFinalSignal(snapshot.monetary_signal, fiscalSignal, adminSignal, aiSupplySignal),
    monetarySignal: snapshot.monetary_signal,
    fiscalSignal,
    fiscalSignalSource: fiscalOverride ? 'override' : 'auto',
    adminSignal,
    adminSignalSource: adminOverride ? 'override' : 'auto',
    aiSupplySignal,
    aiSupplySignalSource: aiSupplyOverride ? 'override' : 'auto',
    indicators: {
      rate: snapshot.fred_rate,
      ratePrev: snapshot.fred_rate_prev,
      rateDecisionDate: snapshot.rate_decision_date,
      balanceSheet: snapshot.fred_balance_sheet,
      balanceSheetPrev: snapshot.fred_balance_sheet_prev,
      balanceSheetPeriodDate: snapshot.balance_sheet_period_date,
      balanceSheetReleaseDate: snapshot.balance_sheet_release_date,
      balanceSheetStatus: snapshot.balance_sheet_status,
      corePce: snapshot.fred_core_pce,
      corePcePrev: snapshot.fred_core_pce_prev,
      corePcePeriodDate: snapshot.core_pce_period_date,
      corePceReleaseDate: snapshot.core_pce_release_date,
      trimmedPce1m: snapshot.fred_trimmed_pce_1m,
      trimmedPce1mPrev: snapshot.fred_trimmed_pce_1m_prev,
      trimmedPce1mPeriodDate: snapshot.trimmed_pce_1m_period_date,
      trimmedPce1mReleaseDate: snapshot.trimmed_pce_1m_release_date,
      trimmedPce: snapshot.fred_trimmed_pce,
      trimmedPcePrev: snapshot.fred_trimmed_pce_prev,
      trimmedPcePeriodDate: snapshot.trimmed_pce_period_date,
      trimmedPceReleaseDate: snapshot.trimmed_pce_release_date,
      trimmedPce12m: snapshot.fred_trimmed_pce_12m,
      trimmedPce12mPrev: snapshot.fred_trimmed_pce_12m_prev,
      trimmedPce12mPeriodDate: snapshot.trimmed_pce_12m_period_date,
      trimmedPce12mReleaseDate: snapshot.trimmed_pce_12m_release_date,
      unemployment: snapshot.fred_unemployment,
      unemploymentPrev: snapshot.fred_unemployment_prev,
      unemploymentPeriodDate: snapshot.unemployment_period_date,
      unemploymentReleaseDate: snapshot.unemployment_release_date,
      fiscalDeficitTtm: snapshot.fiscal_deficit_ttm,
      fiscalDeficitTtmPrev: snapshot.fiscal_deficit_ttm_prev,
      fiscalDeficitChangePct: snapshot.fiscal_deficit_change_pct,
      fiscalPeriodDate: snapshot.fiscal_period_date,
      fiscalReleaseDate: snapshot.fiscal_release_date,
      epuTrade: snapshot.epu_trade,
      epuTradePercentile: snapshot.epu_trade_percentile,
      epuTradePeriodDate: snapshot.epu_trade_period_date,
      smhSpyRelReturnPct: snapshot.smh_spy_rel_return_pct,
      semiIpYoy: snapshot.semi_ip_yoy,
      semiIpPeriodDate: snapshot.semi_ip_period_date,
      semiIpReleaseDate: snapshot.semi_ip_release_date,
      aiMarketSignal: snapshot.ai_market_signal,
      aiFundamentalSignal: snapshot.ai_fundamental_signal,
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

  // 财政/行政/AI供需自动判定（内部各维度独立容错，永不 throw）
  const policyData = await fetchPolicyData();
  const fiscalAuto = calcFiscalSignal(policyData);
  const adminAuto = calcAdminSignal(policyData);
  const aiSupplyAuto = calcAiSupplySignal(policyData);
  const { marketSignal, fundamentalSignal } = deriveAiSupplySubSignals(policyData);

  const { fiscal: fiscalOverride, administrative: adminOverride, aiSupply: aiSupplyOverride } = await getAllOverrides();

  // 生效值 = 手动覆盖优先，否则自动判定（判定函数保证返回信号串）
  const fiscal = fiscalOverride?.signal || fiscalAuto;
  const admin = adminOverride?.signal || adminAuto;
  const aiSupply = aiSupplyOverride?.signal || aiSupplyAuto;
  const finalSignal = calcFinalSignal(monetary, fiscal, admin, aiSupply);

  const today = todayET();
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
    fredCorePcePrev: macroData.prevCorePce,
    fredTrimmedPcePrev: macroData.prevTrimmedPce,
    fredUnemploymentPrev: macroData.prevUnemployment,
    fredTrimmedPce1m: macroData.trimmedPce1m,
    fredTrimmedPce1mPrev: macroData.prevTrimmedPce1m,
    trimmedPce1mPeriodDate: macroData.trimmedPce1mPeriodDate,
    trimmedPce1mReleaseDate: macroData.trimmedPce1mReleaseDate,
    fredTrimmedPce12m: macroData.trimmedPce12m,
    fredTrimmedPce12mPrev: macroData.prevTrimmedPce12m,
    trimmedPce12mPeriodDate: macroData.trimmedPce12mPeriodDate,
    trimmedPce12mReleaseDate: macroData.trimmedPce12mReleaseDate,
    rateDecisionDate: macroData.rateDecisionDate,
    balanceSheetPeriodDate: macroData.balanceSheetPeriodDate,
    balanceSheetReleaseDate: macroData.balanceSheetReleaseDate,
    balanceSheetStatus: macroData.balanceSheetStatus,
    corePcePeriodDate: macroData.corePcePeriodDate,
    corePceReleaseDate: macroData.corePceReleaseDate,
    trimmedPcePeriodDate: macroData.trimmedPcePeriodDate,
    trimmedPceReleaseDate: macroData.trimmedPceReleaseDate,
    unemploymentPeriodDate: macroData.unemploymentPeriodDate,
    unemploymentReleaseDate: macroData.unemploymentReleaseDate,
    fiscalAutoSignal: fiscalAuto,
    fiscalDeficitTtm: policyData.deficitTtm,
    fiscalDeficitTtmPrev: policyData.deficitTtmPrev,
    fiscalDeficitChangePct: policyData.deficitTtmChangePct,
    fiscalPeriodDate: policyData.fiscalPeriodDate,
    fiscalReleaseDate: policyData.fiscalReleaseDate,
    adminAutoSignal: adminAuto,
    epuTrade: policyData.epuTrade,
    epuTradePercentile: policyData.epuTradePercentile,
    epuTradePeriodDate: policyData.epuTradePeriodDate,
    aiSupplyAutoSignal: aiSupplyAuto,
    aiMarketSignal: marketSignal,
    aiFundamentalSignal: fundamentalSignal,
    smhSpyRelReturnPct: policyData.smhSpyRelReturnPct,
    semiIpYoy: policyData.semiIpYoy,
    semiIpPeriodDate: policyData.semiIpPeriodDate,
    semiIpReleaseDate: policyData.semiIpReleaseDate,
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
