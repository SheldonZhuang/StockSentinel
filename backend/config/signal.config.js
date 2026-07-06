// 决策树规则、利率/资产负债表阈值
export default {
  // 利率判定：单次调整 >= 50bp 视为应对式加息（防守信号）
  RATE_REACTIVE_HIKE_BP: 50,

  // 资产负债表变化阈值：变化幅度 < 0.25% 视为"暂停"（不收缩也不扩张）
  BALANCE_SHEET_PAUSE_THRESHOLD_PCT: 0.25,

  // FRED 回溯窗口
  RATE_LOOKBACK_DAYS: 100,
  BALANCE_SHEET_LOOKBACK_DAYS: 90,

  // FRED 系列 ID
  FRED_SERIES: {
    RATE: 'DFEDTARU',
    BALANCE_SHEET: 'WALCL',
    CORE_PCE: 'PCEPILFE',
    TRIMMED_MEAN_PCE: 'PCETRIM6M680SFRBDAL',
    UNEMPLOYMENT: 'UNRATE',
  },

  // 信号档位常量
  SIGNAL: {
    LOOSE: 'loose',
    NEUTRAL: 'neutral',
    TIGHT: 'tight',
  },

  // 最终信号档位常量
  FINAL_SIGNAL: {
    ATTACK: 'attack',
    NEUTRAL: 'neutral',
    DEFENSE: 'defense',
  },
};
