import cfg from '../config/signal.config.js';

const {
  SIGNAL, FINAL_SIGNAL, RATE_REACTIVE_HIKE_BP, BALANCE_SHEET_PAUSE_THRESHOLD_PCT,
  FISCAL_TTM_CHANGE_THRESHOLD_PCT,
  EPU_PERCENTILE_TIGHT, EPU_PERCENTILE_LOOSE,
  AI_MARKET_REL_RETURN_THRESHOLD_PCT, AI_SEMI_IP_YOY_LOOSE_PCT, AI_SEMI_IP_YOY_TIGHT_PCT,
  AI_MODEL_USAGE_DECLINE_THRESHOLD_PCT, AI_CAPEX_YOY_TIGHT_PCT,
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

  // 利率方向判断
  let rateSignal;
  if (currentRate === null || prevRate === null) {
    rateSignal = 'neutral';
  } else {
    const rateDiffBp = Math.round((currentRate - prevRate) * 100); // 转换为 bp
    if (rateDiffBp >= RATE_REACTIVE_HIKE_BP) {
      rateSignal = 'tight'; // 应对式加息
    } else if (rateDiffBp < 0) {
      rateSignal = 'loose'; // 降息
    } else {
      // rateDiffBp 在 0~49bp：0=暂停(loose)，1-49=预防式加息(neutral)
      rateSignal = rateDiffBp === 0 ? 'loose' : 'neutral';
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
 * 财政信号：TTM赤字同比扩大超阈值 → 宽松（财政扩张），收窄超阈值 → 收紧
 * @param {object} policyData - fetchPolicyData() 返回的对象
 */
export function calcFiscalSignal({ deficitTtmChangePct }) {
  if (deficitTtmChangePct === null || deficitTtmChangePct === undefined) return SIGNAL.NEUTRAL;
  if (deficitTtmChangePct > FISCAL_TTM_CHANGE_THRESHOLD_PCT) return SIGNAL.LOOSE;
  if (deficitTtmChangePct < -FISCAL_TTM_CHANGE_THRESHOLD_PCT) return SIGNAL.TIGHT;
  return SIGNAL.NEUTRAL;
}

/**
 * 行政信号：贸易政策不确定性指数近10年百分位 >80 → 收紧，<50 → 宽松
 */
export function calcAdminSignal({ epuTradePercentile }) {
  if (epuTradePercentile === null || epuTradePercentile === undefined) return SIGNAL.NEUTRAL;
  if (epuTradePercentile > EPU_PERCENTILE_TIGHT) return SIGNAL.TIGHT;
  if (epuTradePercentile < EPU_PERCENTILE_LOOSE) return SIGNAL.LOOSE;
  return SIGNAL.NEUTRAL;
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
    ['monetary', prevSnapshot.monetary_signal, current.monetary],
    ['fiscal', prevSnapshot.fiscal_signal, current.fiscal],
    ['admin', prevSnapshot.admin_signal, current.admin],
    ['aiSupply', prevSnapshot.ai_supply_signal, current.aiSupply],
  ];
  for (const [dim, prev, now] of dims) {
    if (prev !== SIGNAL.TIGHT && now === SIGNAL.TIGHT) {
      changes.push({ kind: 'dimTight', dim, from: prev, to: now });
    }
  }

  if (!prevSnapshot.ai_bubble_warning && current.bubbleWarning) {
    changes.push({ kind: 'bubble', reasons: current.bubbleReasons || [] });
  }

  return changes;
}

/**
 * 决策树：四个信号位 → 最终进攻/观望/防守
 * 进攻 = AND（四全宽松）
 * 防守 = OR（任一收紧）
 * 观望 = 其余
 */
export function calcFinalSignal(monetary, fiscal, admin, aiSupply) {
  // 防守：任一收紧
  if (
    monetary === SIGNAL.TIGHT ||
    fiscal === SIGNAL.TIGHT ||
    admin === SIGNAL.TIGHT ||
    aiSupply === SIGNAL.TIGHT
  ) {
    return FINAL_SIGNAL.DEFENSE;
  }

  // 进攻：四全宽松
  if (
    monetary === SIGNAL.LOOSE &&
    fiscal === SIGNAL.LOOSE &&
    admin === SIGNAL.LOOSE &&
    aiSupply === SIGNAL.LOOSE
  ) {
    return FINAL_SIGNAL.ATTACK;
  }

  // 观望
  return FINAL_SIGNAL.NEUTRAL;
}
