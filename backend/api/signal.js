import cfg from '../config/signal.config.js';

const { SIGNAL, FINAL_SIGNAL, RATE_REACTIVE_HIKE_BP, BALANCE_SHEET_PAUSE_THRESHOLD_PCT } = cfg;

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

  // 资产负债表方向判断
  let balanceSheetSignal;
  if (currentBalanceSheet === null || prevBalanceSheet === null) {
    balanceSheetSignal = 'neutral';
  } else {
    const changePct = ((currentBalanceSheet - prevBalanceSheet) / prevBalanceSheet) * 100;
    if (changePct > BALANCE_SHEET_PAUSE_THRESHOLD_PCT) {
      balanceSheetSignal = 'loose'; // QE 扩张
    } else if (changePct < -BALANCE_SHEET_PAUSE_THRESHOLD_PCT) {
      balanceSheetSignal = 'tight'; // QT 收缩
    } else {
      balanceSheetSignal = 'neutral'; // 暂停
    }
  }

  return { rateSignal, balanceSheetSignal };
}

/**
 * 决策树：三个信号位 → 最终进攻/中性/防守
 * 进攻 = AND（三全宽松）
 * 防守 = OR（任一收紧）
 * 中性 = 其余
 */
export function calcFinalSignal(monetary, fiscal, admin) {
  // 防守：任一收紧
  if (monetary === SIGNAL.TIGHT || fiscal === SIGNAL.TIGHT || admin === SIGNAL.TIGHT) {
    return FINAL_SIGNAL.DEFENSE;
  }

  // 进攻：三全宽松
  if (monetary === SIGNAL.LOOSE && fiscal === SIGNAL.LOOSE && admin === SIGNAL.LOOSE) {
    return FINAL_SIGNAL.ATTACK;
  }

  // 中性
  return FINAL_SIGNAL.NEUTRAL;
}
