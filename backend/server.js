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
import { fetchAiChainData } from './api/fetch-ai-chain.js';
import chainCfg from './config/ai-chain.config.js';
import {
  calcMonetarySignal,
  calcFinalSignal,
  calcFiscalSignal,
  calcAdminSignal,
  calcAiSupplySignal,
  deriveAiSupplySubSignals,
  deriveSubSignals,
  calcBubbleWarning,
  detectSignalChanges,
} from './api/signal.js';
import {
  getLatestSnapshot,
  saveSignalSnapshot,
  getSnapshotHistory,
  getAlertSubscribers,
  getEffectiveBottleneck,
  saveAiChainSnapshot,
  getLatestAiChainSnapshot,
  getAllOverrides,
  getUserById,
  updateUserAlerts,
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
    finalSignal: calcFinalSignal(aiSupplySignal, snapshot.monetary_signal, fiscalSignal, adminSignal),
    // 顺序遵循策略主线：长线看供需（AI供需），短线看政策（货币/财政/行政）
    aiSupplySignal,
    aiSupplySignalSource: aiSupplyOverride ? 'override' : 'auto',
    monetarySignal: snapshot.monetary_signal,
    fiscalSignal,
    fiscalSignalSource: fiscalOverride ? 'override' : 'auto',
    adminSignal,
    adminSignalSource: adminOverride ? 'override' : 'auto',
    indicators: {
      rate: snapshot.fred_rate,
      ratePrev: snapshot.fred_rate_prev,
      rateDecisionDate: snapshot.rate_decision_date,
      // 利率子档位（暂停/降息→宽松，<50bp预防式→观望，≥50bp应对式→收紧），与其他判断指标的徽章统一
      rateSignal: deriveSubSignals({
        currentRate: snapshot.fred_rate,
        prevRate: snapshot.fred_rate_prev,
        currentBalanceSheet: snapshot.fred_balance_sheet,
        prevBalanceSheet: snapshot.fred_balance_sheet_prev,
      }).rateSignal,
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
      fiscalAutoSignal: snapshot.fiscal_auto_signal,
      epuTrade: snapshot.epu_trade,
      epuTradePercentile: snapshot.epu_trade_percentile,
      epuTradePeriodDate: snapshot.epu_trade_period_date,
      adminAutoSignal: snapshot.admin_auto_signal,
      smhSpyRelReturnPct: snapshot.smh_spy_rel_return_pct,
      semiIpYoy: snapshot.semi_ip_yoy,
      semiIpPeriodDate: snapshot.semi_ip_period_date,
      semiIpReleaseDate: snapshot.semi_ip_release_date,
      aiMarketSignal: snapshot.ai_market_signal,
      aiFundamentalSignal: snapshot.ai_fundamental_signal,
      modelUsageTrendPct: snapshot.model_usage_trend_pct,
      capexYoY: snapshot.capex_yoy,
      aiBubbleWarning: !!snapshot.ai_bubble_warning,
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

// GET /api/bottleneck — 当前AI产业链最卡脖子环节（公开只读，手动优先否则自动识别）
app.get('/api/bottleneck', async (req, res) => {
  const bottleneck = await getEffectiveBottleneck();
  res.json(bottleneck);
});

// GET /api/ai-chain — AI产业链环节排名 + 卡点 + 泡沫监测（公开只读）
app.get('/api/ai-chain', async (req, res) => {
  const [bottleneck, chainSnap, signalSnap] = await Promise.all([
    getEffectiveBottleneck(),
    getLatestAiChainSnapshot(),
    getLatestSnapshot(),
  ]);

  let stages = chainCfg.STAGE_KEYS.map(key => ({ key, relReturnPct: null, rank: null, validTickerCount: 0 }));
  if (chainSnap?.stage_metrics) {
    try {
      const saved = new Map(JSON.parse(chainSnap.stage_metrics).map(s => [s.key, s]));
      stages = stages.map(s => saved.get(s.key) || s);
    } catch (err) {
      console.warn('[api] failed to parse stage_metrics:', err.message);
    }
  }

  let bubbleReasons = [];
  try {
    bubbleReasons = chainSnap?.bubble_reasons ? JSON.parse(chainSnap.bubble_reasons) : [];
  } catch { /* 忽略脏数据 */ }

  res.json({
    bottleneck,
    stages,
    bubble: {
      modelUsageTrendPct: chainSnap?.model_usage_trend_pct ?? null,
      modelUsageLatestTokens: chainSnap?.model_usage_latest_tokens ?? null,
      modelUsageAsOf: chainSnap?.model_usage_as_of ?? null,
      capexYoY: chainSnap?.capex_yoy ?? null,
      capexTtm: chainSnap?.capex_ttm ?? null,
      semiIpYoy: signalSnap?.semi_ip_yoy ?? null,
      aiFundamentalSignal: signalSnap?.ai_fundamental_signal ?? null,
      warning: !!chainSnap?.bubble_warning,
      reasons: bubbleReasons,
    },
    dataDate: chainSnap?.date ?? null,
  });
});

// GET /api/user/me — 当前用户信息 + 是否是 admin + 邮件提醒开关状态
app.get('/api/user/me', requireAuth, async (req, res) => {
  const isAdmin = req.user.email === process.env.ADMIN_EMAIL;
  const user = await getUserById(req.user.id);
  res.json({
    id: req.user.id,
    email: req.user.email,
    isAdmin,
    emailAlerts: !!user?.email_alerts,
  });
});

// PATCH /api/user/alerts — 开关邮件示警
app.patch('/api/user/alerts', requireAuth, async (req, res) => {
  const enabled = !!req.body.enabled;
  await updateUserAlerts(req.user.id, enabled);
  res.json({ ok: true, emailAlerts: enabled });
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
  // AI产业链数据串行在 policy 之后拉取，避免与其他 Yahoo 调用并发触发限流
  const chainData = await fetchAiChainData();
  const bubble = calcBubbleWarning(chainData);

  const fiscalAuto = calcFiscalSignal(policyData);
  const adminAuto = calcAdminSignal(policyData);
  const aiSupplyAuto = calcAiSupplySignal(policyData, bubble);
  const { marketSignal, fundamentalSignal } = deriveAiSupplySubSignals(policyData);

  const { fiscal: fiscalOverride, administrative: adminOverride, aiSupply: aiSupplyOverride } = await getAllOverrides();

  // 生效值 = 手动覆盖优先，否则自动判定（判定函数保证返回信号串）
  const fiscal = fiscalOverride?.signal || fiscalAuto;
  const admin = adminOverride?.signal || adminAuto;
  const aiSupply = aiSupplyOverride?.signal || aiSupplyAuto;
  const finalSignal = calcFinalSignal(aiSupply, monetary, fiscal, admin);

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
    modelUsageTrendPct: chainData.modelUsageTrendPct,
    capexYoY: chainData.capexYoY,
    aiBubbleWarning: bubble.warning ? 1 : 0,
  });

  await saveAiChainSnapshot({
    date: today,
    autoBottleneck: chainData.autoBottleneck,
    stageMetrics: JSON.stringify(chainData.stages),
    modelUsageTrendPct: chainData.modelUsageTrendPct,
    modelUsageLatestTokens: chainData.modelUsageLatestTokens,
    modelUsageAsOf: chainData.modelUsageAsOf,
    capexYoY: chainData.capexYoY,
    capexTtm: chainData.capexTtm,
    capexPrevTtm: chainData.capexPrevTtm,
    bubbleWarning: bubble.warning,
    bubbleReasons: JSON.stringify(bubble.reasons),
  });

  console.log(`[cron] Signal updated: aiSupply=${aiSupply}, monetary=${monetary}, fiscal=${fiscal}, admin=${admin} → final=${finalSignal}`);

  // 示警：最终信号变化 / 任一维度转收紧 / 泡沫预警触发（用户策略：任一收紧=立即防守，必须果断）
  const changes = detectSignalChanges(prevSnapshot, {
    finalSignal,
    monetary,
    fiscal,
    admin,
    aiSupply,
    bubbleWarning: bubble.warning,
    bubbleReasons: bubble.reasons,
  });
  if (changes.length > 0) {
    const subscribers = await getAlertSubscribers();
    if (subscribers.length > 0) {
      console.log(`[cron] ${changes.length} alert-worthy change(s), alerting ${subscribers.length} users`);
      await sendSignalAlert(subscribers, {
        finalSignal,
        changes,
        details: {
          monetary, fiscal, admin, aiSupply,
          fiscalDeficitChangePct: policyData.deficitTtmChangePct,
          epuTradePercentile: policyData.epuTradePercentile,
          smhSpyRelReturnPct: policyData.smhSpyRelReturnPct,
          semiIpYoy: policyData.semiIpYoy,
          modelUsageTrendPct: chainData.modelUsageTrendPct,
          capexYoY: chainData.capexYoY,
          rateChangeBp: macroData.currentRate !== null && macroData.prevRate !== null
            ? Math.round((macroData.currentRate - macroData.prevRate) * 100)
            : null,
        },
      });
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
