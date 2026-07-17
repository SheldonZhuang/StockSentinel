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
  calcLockActive,
  detectSignalChanges,
  applyYieldCurveVeto,
  applyDowngradeHold,
} from './api/signal.js';
import signalCfg from './config/signal.config.js';
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
  getAllWatchlistSymbols,
  getLatestDailyReport,
} from './utils/storage.js';
import { sendSignalAlert } from './utils/mailer.js';
import { prewarmFundamentals } from './api/fundamentals.js';
import { normalizeSymbol } from './api/market-data.js';
import { todayET } from './utils/datetime.js';
import { asyncRoute } from './utils/async-route.js';
import { buildSignalPayload, buildAiChainPayload } from './api/payloads.js';
import publicRouter from './api/public.js';
import mcpRouter from './api/mcp.js';
import { generateDailyReport } from './api/daily-report.js';
import { backupDatabase } from './utils/backup.js';

const app = express();
const PORT = process.env.PORT || 3001;

// 部署在 Railway：只信任最外层一跳代理，使 req.ip 取到真实客户端 IP（而非代理层 IP，
// 否则所有匿名用户塌缩进同一个 keyless 桶，任一人 25 次即耗尽全网免费额度）。
// 不用 true（信任全链）——那样 X-Forwarded-For 可被客户端完全伪造以刷额度。
app.set('trust proxy', 1);

const allowedOrigins = [
  'http://localhost:5173',
  'https://stock-sentinel-eight.vercel.app',
];

// 白名单 CORS 只挂内部 /api/*：全局挂载会先于 /v1、/mcp 处理 OPTIONS 预检
// （cors 默认 preflightContinue:false 直接 204 终结），非白名单来源永远到不了
// 路由级 cors({origin:'*'})，浏览器端第三方集成全部被误拦
app.use('/api', cors({
  origin: allowedOrigins,
}));
app.use(express.json({ limit: '256kb' })); // 限制请求体，防超大 JSON 打满内存

// --- 路由 ---
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/watchlist', watchlistRouter);
// 开放API（面向AI客户端/第三方开发者）：独立CORS+key限流，见 docs/openapi.yaml
app.use('/v1', publicRouter);
// 远程 MCP 端点（Streamable HTTP）：claude.ai/Smithery 等 URL 型客户端直连，见 backend/api/mcp.js
app.use('/mcp', mcpRouter);

// GET /api/signal — 当前宏观信号 + 各信号位明细
app.get('/api/signal', asyncRoute(async (req, res) => {
  const payload = await buildSignalPayload();
  if (!payload) return res.json({ status: 'loading', message: 'No data yet, cron will run soon' });
  res.json(payload);
}));

// GET /api/signal/history
app.get('/api/signal/history', asyncRoute(async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 90, 365));
  const history = await getSnapshotHistory(limit);
  res.json(history);
}));

// GET /api/bottleneck — 当前AI产业链最卡脖子环节（公开只读，手动优先否则自动识别）
app.get('/api/bottleneck', asyncRoute(async (req, res) => {
  const bottleneck = await getEffectiveBottleneck();
  res.json(bottleneck);
}));

// GET /api/ai-chain — AI产业链环节排名 + 卡点 + 泡沫监测（公开只读）
// GET /api/daily-report — AI日报（内部，前端展示用）
app.get('/api/daily-report', asyncRoute(async (req, res) => {
  const report = await getLatestDailyReport();
  if (!report) return res.json({ status: 'none' });
  res.json({ date: report.date, zh: report.content_zh, en: report.content_en });
}));

app.get('/api/ai-chain', asyncRoute(async (req, res) => {
  res.json(await buildAiChainPayload());
}));

// GET /api/user/me — 当前用户信息 + 是否是 admin + 邮件提醒开关状态
app.get('/api/user/me', requireAuth, asyncRoute(async (req, res) => {
  const isAdmin = req.user.email === process.env.ADMIN_EMAIL;
  const user = await getUserById(req.user.id);
  res.json({
    id: req.user.id,
    email: req.user.email,
    isAdmin,
    emailAlerts: !!user?.email_alerts,
  });
}));

// PATCH /api/user/alerts — 开关邮件示警
app.patch('/api/user/alerts', requireAuth, asyncRoute(async (req, res) => {
  const enabled = !!req.body.enabled;
  await updateUserAlerts(req.user.id, enabled);
  res.json({ ok: true, emailAlerts: enabled });
}));

/**
 * 根据当天 macroData 和前一条快照，计算两个锁的 effective 状态（应用管理员清锁 override 后）
 * @returns {{sahmValue, rateDiffBp, sahmLockActive, reactiveAdjustmentLockActive, reactiveAdjustmentLockTriggerBp,
 *            sahmLockOverridden, reactiveAdjustmentLockOverridden}}
 */
function computeLocks(macroData, prevSnapshot, overrides) {
  const { currentRate, prevRate, sahmValue, rateSteps } = macroData;
  // 利率变动基线优先用上一快照：FRED 序列相邻观测差只在变动次日非零，
  // 当天 cron 恰好缺跑就永久漏检；快照差跨任意天数仍能捕捉调整事件（首次运行退回序列前值）
  const baselineRate = prevSnapshot?.fred_rate ?? prevRate;
  const endpointDiffBp = currentRate !== null && baselineRate !== null && baselineRate !== undefined
    ? Math.round((currentRate - baselineRate) * 100)
    : null;

  // 调整事件判定优先用 FRED 序列在 (上次快照日, 今天] 内的逐笔台阶：
  // 端点差会把停机窗口内两次渐进 25bp 聚合成一次假 50bp"应对式"触发；
  // 台阶扫描保留每次调整的真实幅度（取窗口内幅度最大的一笔）。
  // 首跑（无快照）只看最近一笔台阶（与旧行为等价）；
  // 序列回看窗口覆盖不到快照日或无台阶时，退回端点差兜底。
  const sinceDate = prevSnapshot?.date ?? null;
  const allSteps = rateSteps || [];
  const stepsSince = sinceDate ? allSteps.filter(s => s.date > sinceDate) : allSteps.slice(0, 1);
  const rateDiffBp = stepsSince.length
    ? stepsSince.reduce((a, b) => (Math.abs(b.diffBp) > Math.abs(a.diffBp) ? b : a)).diffBp
    : endpointDiffBp;

  const prevSahmLockActive = prevSnapshot ? !!prevSnapshot.sahm_lock_active : false;
  const prevReactiveLockActive = prevSnapshot ? !!prevSnapshot.reactive_adjustment_lock_active : false;
  const prevTriggerBp = prevSnapshot ? prevSnapshot.reactive_adjustment_lock_trigger_bp : null;
  // 锁存起始日（V3 最短锁存期用）：旧快照无此列时为 null → calcLockActive fail-open 兼容旧行为
  const prevSahmLockSince = prevSnapshot?.sahm_lock_since ?? null;
  const prevReactiveLockSince = prevSnapshot?.reactive_adjustment_lock_since ?? null;
  const today = todayET();
  const ageDays = since => (since ? Math.floor((Date.parse(today) - Date.parse(since)) / 86400000) : null);

  const sahmTrigger = sahmValue !== null && sahmValue !== undefined
    && sahmValue >= signalCfg.SAHM_TRIGGER_THRESHOLD;
  const reactiveTrigger = rateDiffBp !== null && Math.abs(rateDiffBp) >= signalCfg.RATE_REACTIVE_ADJUSTMENT_BP;

  const rawSahmLockActive = calcLockActive({
    triggerToday: sahmTrigger, rateDiffBp, currentRate, prevLockActive: prevSahmLockActive,
    lockAgeDays: prevSahmLockActive ? ageDays(prevSahmLockSince) : null,
  });
  const rawReactiveLockActive = calcLockActive({
    triggerToday: reactiveTrigger, rateDiffBp, currentRate, prevLockActive: prevReactiveLockActive,
    lockAgeDays: prevReactiveLockActive ? ageDays(prevReactiveLockSince) : null,
  });

  // 锁存起始日演进：新激活 → 今天；持续激活 → 沿用（旧快照缺列则从今天起算）；解除 → 清空
  const sahmLockSince = rawSahmLockActive
    ? (prevSahmLockActive ? (prevSahmLockSince ?? today) : today)
    : null;
  const reactiveAdjustmentLockSince = rawReactiveLockActive
    ? (prevReactiveLockActive ? (prevReactiveLockSince ?? today) : today)
    : null;

  let reactiveAdjustmentLockTriggerBp = null;
  if (reactiveTrigger) {
    reactiveAdjustmentLockTriggerBp = rateDiffBp;
  } else if (rawReactiveLockActive) {
    reactiveAdjustmentLockTriggerBp = prevTriggerBp;
  }

  const sahmLockOverridden = !!overrides.sahmLockClear;
  const reactiveAdjustmentLockOverridden = !!overrides.reactiveAdjustmentLockClear;

  return {
    sahmValue,
    rateDiffBp,
    sahmLockActive: sahmLockOverridden ? false : rawSahmLockActive,
    reactiveAdjustmentLockActive: reactiveAdjustmentLockOverridden ? false : rawReactiveLockActive,
    reactiveAdjustmentLockTriggerBp: reactiveAdjustmentLockOverridden ? null : reactiveAdjustmentLockTriggerBp,
    sahmLockOverridden,
    reactiveAdjustmentLockOverridden,
    // 锁存起始日按 raw 状态记录（override 清锁不清起始日——override 撤销后锁龄延续）
    sahmLockSince,
    reactiveAdjustmentLockSince,
  };
}

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

  const today = todayET();
  const prevSnapshot = await getLatestSnapshot();

  // AI供需现金流三件套：调用量+capex（chainData）+ 半导体产出（policyData）合成一个维度
  const aiSupplyInputs = {
    modelUsageTrendPct: chainData.modelUsageTrendPct,
    capexYoY: chainData.capexYoY,
    semiIpYoy: policyData.semiIpYoy,
  };

  const fiscalAuto = calcFiscalSignal(policyData);
  const adminAuto = calcAdminSignal(policyData);
  const aiSupplyAuto = calcAiSupplySignal(aiSupplyInputs);
  const aiSubSignals = deriveAiSupplySubSignals(aiSupplyInputs);

  // 数据源故障降级保护（stale-keep）：指标全为 null 说明是拉取失败而非"数据显示中性"，
  // 沿用上一快照的自动信号，避免故障日产生虚假的"转中性/解除防守"信号变更与误发告警
  const fiscalStale = policyData.outlaysChangePct == null && !!prevSnapshot?.fiscal_auto_signal;
  // 行政 stale：EPU双路全黑，且油价拿不到或未触发事件层（即没有任何一路能给出数据驱动结论）
  const oilInconclusive = policyData.oilChange30dPct == null
    || Math.abs(policyData.oilChange30dPct) < signalCfg.OIL_SHOCK_PCT;
  const adminStale = policyData.epuTradePercentile == null && policyData.epuDailyPercentile == null
    && oilInconclusive && !!prevSnapshot?.admin_auto_signal;
  // AI供需 stale：三件套全 null（调用量/capex/半导体产出通道全故障）时沿用上一快照
  const aiDataMissing = aiSupplyInputs.modelUsageTrendPct == null
    && aiSupplyInputs.capexYoY == null && aiSupplyInputs.semiIpYoy == null;
  const aiSupplyStale = aiDataMissing && !!prevSnapshot?.ai_supply_auto_signal;
  const fiscalAutoEff = fiscalStale ? prevSnapshot.fiscal_auto_signal : fiscalAuto;
  const adminAutoEff = adminStale ? prevSnapshot.admin_auto_signal : adminAuto;
  const aiSupplyAutoEff = aiSupplyStale ? prevSnapshot.ai_supply_auto_signal : aiSupplyAuto;

  const overrides = await getAllOverrides();
  const { fiscal: fiscalOverride, administrative: adminOverride, aiSupply: aiSupplyOverride } = overrides;

  // 生效值 = 手动覆盖优先，否则自动判定（判定函数保证返回信号串）
  const fiscal = fiscalOverride?.signal || fiscalAutoEff;
  const admin = adminOverride?.signal || adminAutoEff;
  const aiSupply = aiSupplyOverride?.signal || aiSupplyAutoEff;
  const decisionTreeSignal = applyYieldCurveVeto(
    calcFinalSignal(aiSupply, monetary, fiscal, admin),
    macroData.yieldCurveInvertedDays
  );

  const locks = computeLocks(macroData, prevSnapshot, overrides);
  const rawFinalSignal = (locks.sahmLockActive || locks.reactiveAdjustmentLockActive) ? 'defense' : decisionTreeSignal;
  // 降档迟滞（V4）：升档即时，降档需持续满确认期才生效（含锁解除后的回落）
  const hold = applyDowngradeHold(
    rawFinalSignal,
    prevSnapshot?.final_signal ?? null,
    prevSnapshot?.final_downgrade_pending_since ?? null,
    today
  );
  const finalSignal = hold.signal;

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
    creditSpread: macroData.creditSpread,
    creditSpreadPercentile: macroData.creditSpreadPercentile,
    creditSpread90dWidenBp: macroData.creditSpread90dWidenBp,
    creditSpreadPeriodDate: macroData.creditSpreadPeriodDate,
    yieldCurveSpread: macroData.yieldCurveSpread,
    yieldCurveInvertedDays: macroData.yieldCurveInvertedDays,
    yieldCurvePeriodDate: macroData.yieldCurvePeriodDate,
    fredCorePce: macroData.corePce,
    fredTrimmedPce: macroData.trimmedPce,
    fredUnemployment: macroData.unemployment,
    sahmValue: macroData.sahmValue,
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
    sahmPeriodDate: macroData.sahmPeriodDate,
    sahmReleaseDate: macroData.sahmReleaseDate,
    fiscalAutoSignal: fiscalAutoEff,
    fiscalOutlaysTtm: policyData.outlaysTtm,
    fiscalOutlaysTtmPrev: policyData.outlaysTtmPrev,
    fiscalOutlaysChangePct: policyData.outlaysChangePct,
    fiscalPeriodDate: policyData.fiscalPeriodDate,
    fiscalReleaseDate: policyData.fiscalReleaseDate,
    adminAutoSignal: adminAutoEff,
    epuTrade: policyData.epuTrade,
    epuTradePercentile: policyData.epuTradePercentile,
    epuTradePeriodDate: policyData.epuTradePeriodDate,
    epuDaily: policyData.epuDaily,
    epuDailyPercentile: policyData.epuDailyPercentile,
    epuDailyPeriodDate: policyData.epuDailyPeriodDate,
    oilWti: policyData.oilWti,
    oilChange30dPct: policyData.oilChange30dPct,
    oilPeriodDate: policyData.oilPeriodDate,
    oilSource: policyData.oilSource,
    aiSupplyAutoSignal: aiSupplyAutoEff,
    aiMarketSignal: aiSubSignals.usageSignal,   // 复用列：调用量子信号（原市场代理已移除）
    aiFundamentalSignal: aiSubSignals.semiSignal, // 复用列：半导体产出子信号
    smhSpyRelReturnPct: null,                   // 已移除SMH-SPY股价代理
    semiIpYoy: policyData.semiIpYoy,
    semiIpPeriodDate: policyData.semiIpPeriodDate,
    semiIpReleaseDate: policyData.semiIpReleaseDate,
    modelUsageTrendPct: chainData.modelUsageTrendPct,
    capexYoY: chainData.capexYoY,
    aiBubbleWarning: aiSupplyAutoEff === 'tight' ? 1 : 0, // 复用列：AI供需=收紧(供过于求)标记（stale日沿用上次判定，与 ai_supply_signal 同口径）
    sahmLockActive: locks.sahmLockActive ? 1 : 0,
    reactiveAdjustmentLockActive: locks.reactiveAdjustmentLockActive ? 1 : 0,
    reactiveAdjustmentLockTriggerBp: locks.reactiveAdjustmentLockTriggerBp,
    sahmLockSince: locks.sahmLockSince,
    reactiveAdjustmentLockSince: locks.reactiveAdjustmentLockSince,
    finalDowngradePendingSince: hold.pendingSince,
    fiscalStale,
    adminStale,
    aiSupplyStale,
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
    bubbleWarning: aiSupplyAutoEff === 'tight',
    bubbleReasons: JSON.stringify(
      [aiSubSignals.usageSignal === 'tight' && 'usage',
       aiSubSignals.capexSignal === 'tight' && 'capex',
       aiSubSignals.semiSignal === 'tight' && 'semiIp'].filter(Boolean)
    ),
  });

  console.log(`[cron] Signal updated: aiSupply=${aiSupply}, monetary=${monetary}, fiscal=${fiscal}, admin=${admin} → final=${finalSignal}`);

  // 预热自选股 EDGAR 基本面（24h缓存）：串行队列约每标的1~3秒，
  // 移到 cron 里跑，用户打开自选股页面时命中缓存不再叠加冷加载延时
  try {
    const symbols = await getAllWatchlistSymbols();
    await prewarmFundamentals(symbols.map(normalizeSymbol));
    console.log(`[cron] fundamentals prewarmed for ${symbols.length} watchlist symbols`);
  } catch (err) {
    console.warn('[cron] fundamentals prewarm failed:', err.message);
  }

  // AI 日报（增值内容，失败静默）：基于刚保存的快照生成中英双语解读
  await generateDailyReport(await buildSignalPayload().catch(() => null));

  // 数据库备份到 GitHub 私有仓库（收费产品数据兜底；未配环境变量则跳过）
  await backupDatabase();

  // 示警：最终信号变化 / 任一维度转收紧（用户策略：任一收紧=立即防守，必须果断）
  // AI供需转收紧(供过于求)已由 dimTight 捕获，不再单列泡沫预警
  const changes = detectSignalChanges(prevSnapshot, {
    finalSignal,
    monetary,
    fiscal,
    admin,
    aiSupply,
    sahmLockActive: locks.sahmLockActive,
    reactiveAdjustmentLockActive: locks.reactiveAdjustmentLockActive,
    reactiveAdjustmentLockTriggerBp: locks.reactiveAdjustmentLockTriggerBp,
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
          fiscalOutlaysChangePct: policyData.outlaysChangePct,
          epuTradePercentile: policyData.epuTradePercentile,
          epuDailyPercentile: policyData.epuDailyPercentile,
          oilChange30dPct: policyData.oilChange30dPct,
          semiIpYoy: policyData.semiIpYoy,
          modelUsageTrendPct: chainData.modelUsageTrendPct,
          capexYoY: chainData.capexYoY,
          rateChangeBp: locks.rateDiffBp,
          sahmValue: macroData.sahmValue,
        },
      });
    }
  }
}

// 统一错误中间件：asyncRoute 捕获的异常在此收口为 500，而不是 unhandledRejection 崩溃进程
app.use((err, req, res, next) => {
  console.error(`[api] ${req.method} ${req.path} failed:`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal server error' });
});

// 每天 UTC 06:00 执行（美东01:00夏令时02:00，北京14:00）；cron 回调兜底 catch，防止未处理 rejection 终止进程
cron.schedule('0 6 * * *', () => runDailyUpdate().catch(err => console.error('[cron] daily update failed:', err)), { timezone: 'UTC' });

// 启动时立即执行一次
runDailyUpdate().catch(err => console.error('[startup] initial update failed:', err));

app.listen(PORT, () => {
  console.log(`[server] Stock Sentinel backend running on http://localhost:${PORT}`);
});
