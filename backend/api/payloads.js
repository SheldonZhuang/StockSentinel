// 信号/产业链响应组装（共享层）：内部 /api/* 与开放 /v1/* 复用同一实现，避免两套口径漂移
import chainCfg from '../config/ai-chain.config.js';
import {
  getLatestSnapshot,
  getAllOverrides,
  getEffectiveBottleneck,
  getLatestAiChainSnapshot,
} from '../utils/storage.js';
import { calcFinalSignal, deriveSubSignals, applyYieldCurveVeto, applyTrendReentry } from './signal.js';

/**
 * 当前信号完整载荷（读取时实时重算决策树+锁强制，与快照解耦以反映最新 override）
 * @returns {object|null} 无快照时 null
 */
export async function buildSignalPayload() {
  const snapshot = await getLatestSnapshot();
  if (!snapshot) return null;

  const overrides = await getAllOverrides();
  const { fiscal: fiscalOverride, administrative: adminOverride, aiSupply: aiSupplyOverride } = overrides;

  // 生效值 = 手动覆盖优先，否则自动判定；旧快照没有 *_auto_signal 时兜底到当时存的生效值
  const fiscalSignal = fiscalOverride?.signal || snapshot.fiscal_auto_signal || snapshot.fiscal_signal;
  const adminSignal = adminOverride?.signal || snapshot.admin_auto_signal || snapshot.admin_signal;
  const aiSupplySignal = aiSupplyOverride?.signal || snapshot.ai_supply_auto_signal || snapshot.ai_supply_signal;

  const rawSahmLockActive = !!snapshot.sahm_lock_active;
  const rawReactiveLockActive = !!snapshot.reactive_adjustment_lock_active;
  const sahmLockOverridden = !!overrides.sahmLockClear;
  const reactiveAdjustmentLockOverridden = !!overrides.reactiveAdjustmentLockClear;
  const sahmLockActive = sahmLockOverridden ? false : rawSahmLockActive;
  const reactiveAdjustmentLockActive = reactiveAdjustmentLockOverridden ? false : rawReactiveLockActive;

  const decisionTreeSignal = applyYieldCurveVeto(
    calcFinalSignal(aiSupplySignal, snapshot.monetary_signal, fiscalSignal, adminSignal),
    snapshot.yield_curve_inverted_days ?? null
  );
  const lockActiveNow = sahmLockActive || reactiveAdjustmentLockActive;
  const candidateSignal = applyTrendReentry(
    lockActiveNow ? 'defense' : decisionTreeSignal,
    {
      sahmLockActive,
      reactiveLockActive: reactiveAdjustmentLockActive,
      spxAboveSma10: snapshot.spx_above_sma10 == null ? null : !!snapshot.spx_above_sma10,
    }
  );
  // 降档迟滞（V4）：无任何手动覆盖时，快照的 final_signal 已是 cron 应用迟滞后的生效档，直接信任
  //（实时重算的 candidate 在降档等待期内会比生效档更宽松，不能直接展示）；
  // 存在覆盖时管理员操作需即时生效，用重算值，不做迟滞
  const anyOverride = !!(fiscalOverride || adminOverride || aiSupplyOverride
    || sahmLockOverridden || reactiveAdjustmentLockOverridden);
  const finalSignal = anyOverride ? candidateSignal : (snapshot.final_signal || candidateSignal);

  return {
    finalSignal,
    // 顺序遵循策略主线：长线看供需（AI供需），短线看政策（货币/财政/行政）
    aiSupplySignal,
    aiSupplySignalSource: aiSupplyOverride ? 'override' : 'auto',
    monetarySignal: snapshot.monetary_signal,
    fiscalSignal,
    fiscalSignalSource: fiscalOverride ? 'override' : 'auto',
    adminSignal,
    adminSignalSource: adminOverride ? 'override' : 'auto',
    // stale = 当日数据源故障，该维度沿用上一次有效判定
    staleFlags: {
      fiscal: !!snapshot.fiscal_stale,
      administrative: !!snapshot.admin_stale,
      aiSupply: !!snapshot.ai_supply_stale,
    },
    indicators: {
      rate: snapshot.fred_rate,
      ratePrev: snapshot.fred_rate_prev,
      rateDecisionDate: snapshot.rate_decision_date,
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
      creditSpread: snapshot.credit_spread,
      creditSpreadPercentile: snapshot.credit_spread_percentile,
      creditSpread90dWidenBp: snapshot.credit_spread_90d_widen_bp,
      creditSpreadPeriodDate: snapshot.credit_spread_period_date,
      yieldCurveSpread: snapshot.yield_curve_spread,
      yieldCurveInvertedDays: snapshot.yield_curve_inverted_days,
      yieldCurvePeriodDate: snapshot.yield_curve_period_date,
      fiscalOutlaysTtm: snapshot.fiscal_outlays_ttm,
      fiscalOutlaysChangePct: snapshot.fiscal_outlays_change_pct,
      fiscalPeriodDate: snapshot.fiscal_period_date,
      fiscalReleaseDate: snapshot.fiscal_release_date,
      fiscalAutoSignal: snapshot.fiscal_auto_signal,
      epuTrade: snapshot.epu_trade,
      epuTradePercentile: snapshot.epu_trade_percentile,
      epuTradePeriodDate: snapshot.epu_trade_period_date,
      epuDaily: snapshot.epu_daily,
      epuDailyPercentile: snapshot.epu_daily_percentile,
      epuDailyPeriodDate: snapshot.epu_daily_period_date,
      oilWti: snapshot.oil_wti,
      oilChange30dPct: snapshot.oil_change_30d_pct,
      oilPeriodDate: snapshot.oil_period_date,
      oilSource: snapshot.oil_source,
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
      sahmValue: snapshot.sahm_value,
      sahmPeriodDate: snapshot.sahm_period_date,
      sahmReleaseDate: snapshot.sahm_release_date,
      sahmLockActive,
      reactiveAdjustmentLockActive,
      reactiveAdjustmentLockTriggerBp: reactiveAdjustmentLockActive ? snapshot.reactive_adjustment_lock_trigger_bp : null,
      sahmLockOverridden,
      reactiveAdjustmentLockOverridden,
      sahmLockSince: snapshot.sahm_lock_since ?? null,
      reactiveAdjustmentLockSince: snapshot.reactive_adjustment_lock_since ?? null,
      // 降档等待中：非 null 表示决策树已给出更宽松档、正处确认期（自该日起满30天生效）
      finalDowngradePendingSince: snapshot.final_downgrade_pending_since ?? null,
      // 趋势状态（W5 趋势再入场）：最新收盘 vs 10个月末收盘SMA
      spxClose: snapshot.spx_close ?? null,
      spxMa10m: snapshot.spx_ma10m ?? null,
      spxAboveSma10: snapshot.spx_above_sma10 == null ? null : !!snapshot.spx_above_sma10,
    },
    dataDate: snapshot.date,
    createdAt: snapshot.created_at,
  };
}

/**
 * AI 产业链载荷（环节排名 + 卡点 + 泡沫监测）
 */
export async function buildAiChainPayload() {
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

  return {
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
  };
}
