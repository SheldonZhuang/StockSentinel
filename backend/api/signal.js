import cfg from '../config/signal.config.js';

const {
  SIGNAL, FINAL_SIGNAL, RATE_REACTIVE_ADJUSTMENT_BP, BALANCE_SHEET_PAUSE_THRESHOLD_PCT,
  FISCAL_TTM_CHANGE_THRESHOLD_PCT,
  EPU_PERCENTILE_TIGHT, EPU_PERCENTILE_LOOSE,
  AI_MARKET_REL_RETURN_THRESHOLD_PCT, AI_SEMI_IP_YOY_LOOSE_PCT, AI_SEMI_IP_YOY_TIGHT_PCT,
  AI_MODEL_USAGE_DECLINE_THRESHOLD_PCT, AI_CAPEX_YOY_TIGHT_PCT,
  SAHM_TRIGGER_THRESHOLD, ZERO_RATE_FLOOR_PCT, OIL_SHOCK_PCT,
} = cfg;

/**
 * 根据 FRED 原始数据判定货币信号位
 * @param {object} macroData - fetchMacroData() 返回的对象
 * @returns {'loose'|'neutral'|'tight'}
 */
export function calcMonetarySignal(macroData) {
  const { rateSignal, balanceSheetSignal } = deriveSubSignals(macroData);

  // 宽松：利率暂停/降息 AND 资产负债表不收缩
  if (rateSignal === 'loose' && balanceSheetSignal !== 'tight') {
    return SIGNAL.LOOSE;
  }

  // 收紧：应对式加息(>=50bp) OR QT收缩
  if (rateSignal === 'tight' || balanceSheetSignal === 'tight') {
    return SIGNAL.TIGHT;
  }

  // 其余（预防式加息<50bp 等混合情况）
  return SIGNAL.NEUTRAL;
}

/**
 * 分解利率和资产负债表子信号
 */
export function deriveSubSignals(macroData) {
  const { currentRate, prevRate, currentBalanceSheet, prevBalanceSheet } = macroData;

  // 利率方向判断：按调整幅度绝对值统一处理，加息/降息对称
  let rateSignal;
  if (currentRate === null || prevRate === null) {
    rateSignal = 'neutral';
  } else {
    const rateDiffBp = Math.round((currentRate - prevRate) * 100); // 转换为 bp，正=加息，负=降息
    if (Math.abs(rateDiffBp) >= RATE_REACTIVE_ADJUSTMENT_BP) {
      rateSignal = 'tight'; // 应对式加息 或 应对式降息
    } else {
      rateSignal = 'loose'; // 暂停、预防式加息/降息（幅度<50bp，含加息减缓）
    }
  }

  const balanceSheetSignal = deriveBalanceSheetStatus(currentBalanceSheet, prevBalanceSheet);

  return { rateSignal, balanceSheetSignal };
}

/**
 * 资产负债表方向判断：QE 扩张(loose) / 暂停·持平(neutral) / QT 收缩(tight)
 * @returns {'loose'|'neutral'|'tight'}
 */
export function deriveBalanceSheetStatus(current, prev) {
  if (current === null || prev === null) return 'neutral';

  const changePct = ((current - prev) / prev) * 100;
  if (changePct > BALANCE_SHEET_PAUSE_THRESHOLD_PCT) return 'loose'; // QE 扩张
  if (changePct < -BALANCE_SHEET_PAUSE_THRESHOLD_PCT) return 'tight'; // QT 收缩
  return 'neutral'; // 暂停
}

/**
 * 衰退防守锁定判定：萨姆锁 / 应对式调整锁 复用同一套逻辑
 * 解锁优先于触发：零利率区间(<=0.25%) 或 当天发生非零小幅调整(<50bp，不限方向) 即解锁；
 * rateDiffBp===0（无议息决议日 或 决议暂停）不触发小幅调整解锁，避免锁定被普通日子误解除
 * @returns {boolean}
 */
export function calcLockActive({ triggerToday, rateDiffBp, currentRate, prevLockActive }) {
  const zeroFloorUnlock = currentRate !== null && currentRate !== undefined
    && currentRate <= ZERO_RATE_FLOOR_PCT;
  const smallAdjustmentUnlock = rateDiffBp !== null && rateDiffBp !== undefined && rateDiffBp !== 0
    && Math.abs(rateDiffBp) < RATE_REACTIVE_ADJUSTMENT_BP;
  if (zeroFloorUnlock || smallAdjustmentUnlock) return false;
  return !!prevLockActive || !!triggerToday;
}

/**
 * 财政信号（政策原则"大市场小政府"）：
 * TTM赤字同比扩大超阈值 → 收紧（政府扩张，加税加费预期，损害市场经济）；
 * 收窄超阈值 → 宽松（政府收缩，减税降费空间）
 * @param {object} policyData - fetchPolicyData() 返回的对象
 */
export function calcFiscalSignal({ deficitTtmChangePct }) {
  if (deficitTtmChangePct === null || deficitTtmChangePct === undefined) return SIGNAL.NEUTRAL;
  if (deficitTtmChangePct > FISCAL_TTM_CHANGE_THRESHOLD_PCT) return SIGNAL.TIGHT;
  if (deficitTtmChangePct < -FISCAL_TTM_CHANGE_THRESHOLD_PCT) return SIGNAL.LOOSE;
  return SIGNAL.NEUTRAL;
}

/**
 * 行政子信号：百分位 → 档位（>80 收紧，<50 宽松）
 */
function epuPercentileSignal(percentile) {
  if (percentile === null || percentile === undefined) return null;
  if (percentile > EPU_PERCENTILE_TIGHT) return SIGNAL.TIGHT;
  if (percentile < EPU_PERCENTILE_LOOSE) return SIGNAL.LOOSE;
  return SIGNAL.NEUTRAL;
}

/**
 * 行政信号：油价事件层优先，其次EPU双代理一致才定档。
 * 油价事件（WTI 30天涨跌幅≥±20%）= 战争/地缘冲突的市场实时定价，精确到日：
 *   飙升 → 战争/供给冲击 → 立即收紧（经OR叠加，无条件——冲击不论来源都利空）；
 *   暴跌 → 需区分两种成因：战争结束/对抗降级（利好）vs 危机需求崩塌（利空，如2025-04关税战恐慌）。
 *   护栏：暴跌只在不确定性指数未处高位（日频EPU≤80分位，缺失时用月度）时判宽松；
 *   EPU同时高企说明是危机型暴跌 → 回落到EPU双代理判定，不误判宽松。
 * 注意：行政宽松只撤掉本维度否决票，进攻仍需四维全宽松且无锁。
 * EPU双代理：月度贸易专项 EPUTRADE（结构性）+ 日频EPU 7日均线（时效性）。
 * 两者都有数据时一致才定档，不一致→观望；单边缺失用可用侧；全缺→观望
 */
export function calcAdminSignal({ epuTradePercentile, epuDailyPercentile, oilChange30dPct }) {
  if (oilChange30dPct !== null && oilChange30dPct !== undefined) {
    if (oilChange30dPct >= OIL_SHOCK_PCT) return SIGNAL.TIGHT;
    const guardPct = epuDailyPercentile ?? epuTradePercentile; // 优先用更新鲜的日频做护栏
    const uncertaintyHigh = guardPct !== null && guardPct !== undefined && guardPct > EPU_PERCENTILE_TIGHT;
    if (oilChange30dPct <= -OIL_SHOCK_PCT && !uncertaintyHigh) return SIGNAL.LOOSE;
  }

  const tradeSignal = epuPercentileSignal(epuTradePercentile);
  const dailySignal = epuPercentileSignal(epuDailyPercentile);

  if (tradeSignal !== null && dailySignal !== null) {
    return tradeSignal === dailySignal ? tradeSignal : SIGNAL.NEUTRAL;
  }
  return tradeSignal ?? dailySignal ?? SIGNAL.NEUTRAL;
}

/**
 * AI供需子信号：市场（SMH-SPY相对收益）与基本面（半导体IP同比）
 */
export function deriveAiSupplySubSignals({ smhSpyRelReturnPct, semiIpYoy }) {
  let marketSignal = SIGNAL.NEUTRAL;
  if (smhSpyRelReturnPct !== null && smhSpyRelReturnPct !== undefined) {
    if (smhSpyRelReturnPct > AI_MARKET_REL_RETURN_THRESHOLD_PCT) marketSignal = SIGNAL.LOOSE;
    else if (smhSpyRelReturnPct < -AI_MARKET_REL_RETURN_THRESHOLD_PCT) marketSignal = SIGNAL.TIGHT;
  }

  let fundamentalSignal = SIGNAL.NEUTRAL;
  if (semiIpYoy !== null && semiIpYoy !== undefined) {
    if (semiIpYoy > AI_SEMI_IP_YOY_LOOSE_PCT) fundamentalSignal = SIGNAL.LOOSE;
    else if (semiIpYoy < AI_SEMI_IP_YOY_TIGHT_PCT) fundamentalSignal = SIGNAL.TIGHT;
  }

  return { marketSignal, fundamentalSignal };
}

/**
 * AI泡沫预警：模型调用量趋势跌破阈值 或 云厂商资本开支同比转负（用户框架："下降→尽快防守"）
 * 数据缺失(null)不触发预警（优雅降级）
 * @returns {{warning: boolean, reasons: string[]}}
 */
export function calcBubbleWarning({ modelUsageTrendPct, capexYoY } = {}) {
  const reasons = [];
  if (modelUsageTrendPct !== null && modelUsageTrendPct !== undefined
    && modelUsageTrendPct < AI_MODEL_USAGE_DECLINE_THRESHOLD_PCT) {
    reasons.push('modelUsage');
  }
  if (capexYoY !== null && capexYoY !== undefined && capexYoY < AI_CAPEX_YOY_TIGHT_PCT) {
    reasons.push('capex');
  }
  return { warning: reasons.length > 0, reasons };
}

/**
 * AI供需信号：两个子信号都有数据时要求一致才定档（不一致 → 观望）；
 * 只有一边有数据时直接采用该边（数据缺失 ≠ 意见分歧）；全缺失 → 观望；
 * 泡沫预警触发时强制收紧（管理员 override 仍最优先，在 server 层应用）
 */
export function calcAiSupplySignal(policyData, bubble = null) {
  if (bubble?.warning) return SIGNAL.TIGHT;

  const { smhSpyRelReturnPct, semiIpYoy } = policyData;
  const { marketSignal, fundamentalSignal } = deriveAiSupplySubSignals(policyData);
  const hasMarket = smhSpyRelReturnPct !== null && smhSpyRelReturnPct !== undefined;
  const hasFundamental = semiIpYoy !== null && semiIpYoy !== undefined;

  if (hasMarket && hasFundamental) {
    return marketSignal === fundamentalSignal ? marketSignal : SIGNAL.NEUTRAL;
  }
  if (hasMarket) return marketSignal;
  if (hasFundamental) return fundamentalSignal;
  return SIGNAL.NEUTRAL;
}

/**
 * 示警变化检测：对比前一快照与本次结果，找出所有值得提醒的事件
 * 用户策略"防守信号出现任意一项就立即防守"→ 不止最终信号变化，任一维度转收紧、泡沫预警触发都要示警
 * @param {object|null} prevSnapshot - 上一条 signal_snapshots 行（下划线列名），无历史时为 null
 * @param {object} current - { finalSignal, monetary, fiscal, admin, aiSupply, bubbleWarning, bubbleReasons }
 * @returns {Array<{kind, ...}>} 空数组 = 无需示警
 */
export function detectSignalChanges(prevSnapshot, current) {
  if (!prevSnapshot) return []; // 首次运行无对比基准，不示警

  const changes = [];

  if (prevSnapshot.final_signal !== current.finalSignal) {
    changes.push({ kind: 'final', from: prevSnapshot.final_signal, to: current.finalSignal });
  }

  const dims = [
    // 顺序遵循策略主线"长线看供需，短线看政策"：AI供需 → 货币 → 财政 → 行政
    ['aiSupply', prevSnapshot.ai_supply_signal, current.aiSupply],
    ['monetary', prevSnapshot.monetary_signal, current.monetary],
    ['fiscal', prevSnapshot.fiscal_signal, current.fiscal],
    ['admin', prevSnapshot.admin_signal, current.admin],
  ];
  for (const [dim, prev, now] of dims) {
    if (prev !== SIGNAL.TIGHT && now === SIGNAL.TIGHT) {
      changes.push({ kind: 'dimTight', dim, from: prev, to: now });
    }
  }

  if (!prevSnapshot.ai_bubble_warning && current.bubbleWarning) {
    changes.push({ kind: 'bubble', reasons: current.bubbleReasons || [] });
  }

  if (!prevSnapshot.sahm_lock_active && current.sahmLockActive) {
    changes.push({ kind: 'sahmLockOn' });
  } else if (prevSnapshot.sahm_lock_active && !current.sahmLockActive) {
    changes.push({ kind: 'sahmLockOff' });
  }

  if (!prevSnapshot.reactive_adjustment_lock_active && current.reactiveAdjustmentLockActive) {
    changes.push({ kind: 'reactiveAdjustmentLockOn', bp: current.reactiveAdjustmentLockTriggerBp ?? null });
  } else if (prevSnapshot.reactive_adjustment_lock_active && !current.reactiveAdjustmentLockActive) {
    changes.push({ kind: 'reactiveAdjustmentLockOff' });
  }

  return changes;
}

/**
 * 决策树：四个信号位 → 最终信号（防守分级，2026-07-12 回测调优后用户拍板）
 * 参数顺序遵循策略主线"长线看供需，短线看政策"：AI供需 → 货币 → 财政 → 行政
 * 进攻 = AND（四全宽松）
 * 全面防守 = 双维以上收紧（多维共振，历史上与真实危机高度重合；锁激活在 server 层强制）
 * 减仓观望 = 仅单维收紧（回测显示单维收紧多为噪声，全仓防守代价过高）
 * 观望 = 其余
 */
export function calcFinalSignal(aiSupply, monetary, fiscal, admin) {
  const tightCount = [aiSupply, monetary, fiscal, admin].filter(s => s === SIGNAL.TIGHT).length;

  if (tightCount >= 2) return FINAL_SIGNAL.DEFENSE;
  if (tightCount === 1) return FINAL_SIGNAL.REDUCE;

  // 进攻：四全宽松
  if (
    aiSupply === SIGNAL.LOOSE &&
    monetary === SIGNAL.LOOSE &&
    fiscal === SIGNAL.LOOSE &&
    admin === SIGNAL.LOOSE
  ) {
    return FINAL_SIGNAL.ATTACK;
  }

  // 观望
  return FINAL_SIGNAL.NEUTRAL;
}
