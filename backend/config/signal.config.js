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
    TRIMMED_MEAN_PCE_1M: 'PCETRIM1M158SFRBDAL',
    TRIMMED_MEAN_PCE: 'PCETRIM6M680SFRBDAL',
    TRIMMED_MEAN_PCE_12M: 'PCETRIM12M159SFRBDAL',
    UNEMPLOYMENT: 'UNRATE',
    FISCAL_DEFICIT: 'MTSDS133FMS',  // 联邦财政盈余/赤字（月度，百万美元，赤字为负）
    EPU_TRADE: 'EPUTRADE',          // 贸易政策不确定性指数（月度）
    SEMI_IP: 'IPG3344S',            // 半导体及电子元件工业产出指数（月度）
  },

  // 财政信号：滚动12月(TTM)赤字总额 vs 一年前TTM，变化超过阈值(%)才判定方向
  // 赤字扩大 > 阈值 → loose（财政扩张），收窄 > 阈值 → tight
  FISCAL_TTM_CHANGE_THRESHOLD_PCT: 5,
  FISCAL_LOOKBACK_DAYS: 800, // 需要约25个月观测（12+12+缓冲）

  // 行政信号：EPUTRADE 最新值在近10年观测中的百分位
  EPU_PERCENTILE_TIGHT: 80,  // >80 分位 → tight（贸易政策高压）
  EPU_PERCENTILE_LOOSE: 50,  // <50 分位 → loose（政策环境平静）
  EPU_LOOKBACK_DAYS: 3660,   // 10年

  // AI供需信号：市场代理（SMH vs SPY 相对收益）+ 基本面代理（半导体IP同比），两者一致才定档
  AI_MARKET_SYMBOLS: { SEMI: 'SMH', BENCH: 'SPY' },
  AI_MARKET_WINDOW_DAYS: 90,               // 相对收益回看窗口（日历日）
  AI_MARKET_REL_RETURN_THRESHOLD_PCT: 8,   // 相对收益 >+8% → loose，<-8% → tight
  AI_SEMI_IP_YOY_LOOSE_PCT: 5,             // 半导体IP同比 >+5% → loose
  AI_SEMI_IP_YOY_TIGHT_PCT: 0,             // 同比 <0% → tight
  AI_SEMI_IP_LOOKBACK_DAYS: 400,

  // AI泡沫预警（任一触发 → aiSupply 自动信号强制收紧）
  AI_MODEL_USAGE_DECLINE_THRESHOLD_PCT: -10, // 模型调用量 近7日均值 vs 前28日均值 低于该值 → 预警
  AI_CAPEX_YOY_TIGHT_PCT: 0,                 // 云厂商滚动4季资本开支同比 低于该值 → 预警

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
