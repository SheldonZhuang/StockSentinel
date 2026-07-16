// 决策树规则、利率/资产负债表阈值
export default {
  // 利率判定：单次调整幅度(绝对值) >= 50bp 视为应对式加息/应对式降息（防守信号），方向不限
  RATE_REACTIVE_ADJUSTMENT_BP: 50,

  // 实际利率门控（修复"渐进加息被判宽松"）：实际利率 = 名义利率上限 − 12月截尾均值PCE同比。
  // 当实际利率 > 此阈值，说明货币立场已明显紧缩（如2004-06连续25bp累计+425bp、2023加息到5.5%），
  // 即便当期无≥50bp应对式调整，利率子信号也不得输出loose（封顶neutral）——
  // 区分"政策冲量步长小"与"政策立场水平已高"。中性实际利率约0.5%，取1.0%为明显紧缩线。
  REAL_RATE_RESTRICTIVE_PCT: 1.0,

  // 零利率区间上限：利率目标上限降至此值以下视为"降到底"，是应对式调整锁/萨姆锁的解锁条件之一
  ZERO_RATE_FLOOR_PCT: 0.25,

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
    SAHM: 'SAHMREALTIME',           // 萨姆规则实时值（圣路易斯联储官方计算）
    FISCAL_OUTLAYS: 'MTSO133FMS',   // 联邦月度支出（百万美元）——"大市场小政府"原则的直接度量：
                                    // 支出=政府规模；赤字混入收入端，减税型赤字会被误判收紧（2017实证）
    EPU_TRADE: 'EPUTRADE',          // 贸易政策不确定性指数（月度，贸易专项，结构性）
    EPU_DAILY: 'USEPUINDXD',        // 经济政策不确定性指数（日频，新闻编制，时效性——政策转向数天内可见）
    OIL_WTI: 'DCOILWTICO',          // WTI原油现货价（日频）——战争/地缘冲击的市场实时定价代理
    SEMI_IP: 'IPG3344S',            // 半导体及电子元件工业产出指数（月度）
  },

  // 萨姆规则：值 >= 阈值 视为经济进入衰退初期，触发衰退防守锁
  SAHM_TRIGGER_THRESHOLD: 0.5,

  // 财政信号：滚动12月(TTM)联邦支出 vs 一年前TTM，变化超过阈值(%)才判定方向
  // 政策原则"大市场小政府"：支出扩大 > 阈值 → tight（政府变大），收缩 > 阈值 → loose（政府瘦身）
  // 回测依据(2026-07-13)：赤字口径把2017减税型赤字误判收紧压制牛市；支出口径 2018+2.1%中性/
  // 2020+41%强收紧/2024-5.6%宽松，与原则和市场事实同构
  FISCAL_TTM_CHANGE_THRESHOLD_PCT: 5,
  FISCAL_LOOKBACK_DAYS: 800, // 需要约25个月观测（12+12+缓冲）

  // 行政信号：双代理一致才定档（与AI供需同模式）——
  // 月度 EPUTRADE（贸易专项）与 日频EPU 7日均线（全政策、日级响应）各取近10年百分位
  EPU_PERCENTILE_TIGHT: 80,  // >80 分位 → tight（政策高压）
  EPU_PERCENTILE_LOOSE: 50,  // <50 分位 → loose（政策环境平静）
  EPU_LOOKBACK_DAYS: 3660,   // 10年
  EPU_DAILY_MA_DAYS: 7,      // 日频指数噪声大，取7日均线再算百分位

  // 行政信号·油价事件层（优先于EPU百分位）：WTI 30天涨跌幅是战争新闻的市场实时定价，
  // 开战/冲突升级当天油价即跳涨，停战/和谈喊话当天即跳水——精确到日，不等指数编制
  // +20%以上 → 战争/供给冲击 → 行政立即收紧（经OR强制防守）；
  // -20%以上 → 战争结束/对抗降级 → 行政立即宽松（若其余三维宽松且无锁，进攻随即成立）
  OIL_SHOCK_WINDOW_DAYS: 30,
  OIL_SHOCK_PCT: 20,
  OIL_LOOKBACK_DAYS: 60,     // 拉60天日线保证能找到30天前的交易日观测

  // AI供需信号：市场代理（SMH vs SPY 相对收益）+ 基本面代理（半导体IP同比），两者一致才定档
  AI_MARKET_SYMBOLS: { SEMI: 'SMH', BENCH: 'SPY' },
  AI_MARKET_WINDOW_DAYS: 90,               // 相对收益回看窗口（日历日）
  AI_MARKET_REL_RETURN_THRESHOLD_PCT: 8,   // 相对收益 >+8% → loose，<-8% → tight
  AI_MARKET_OVERHEAT_PCT: 25,              // 相对收益 >+25% → 过热(拥挤≠健康)，截断为neutral不投宽松票
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

  // 最终信号档位常量（防守分级 2026-07-12 用户拍板）：
  // attack=四维全宽松；reduce=仅单维收紧（减仓观望）；defense=双维以上收紧或锁激活（全面防守）
  FINAL_SIGNAL: {
    ATTACK: 'attack',
    NEUTRAL: 'neutral',
    REDUCE: 'reduce',
    DEFENSE: 'defense',
  },
};
