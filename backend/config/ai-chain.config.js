// AI产业链：环节篮子、卡点排名与泡沫监测数据源配置
// STAGE_BASKETS 需与 frontend/src/data/aiChain.js 的可交易标的保持同步
export default {
  // 链条顺序，同时是 admin 卡点设定的合法值来源
  STAGE_KEYS: ['model', 'cloud', 'chip', 'memory', 'packaging', 'power'],

  // 'model' 环节无纯正上市标的（Anthropic/OpenAI未上市），不参与价格排名，
  // 其健康度由 OpenRouter 模型调用量趋势代表
  STAGE_BASKETS: {
    cloud: ['MSFT', 'AMZN', 'GOOGL', 'META', 'NBIS'],
    chip: ['NVDA', 'AMD', 'AVGO', 'ARM', 'INTC'],
    memory: ['MU', 'SNDK', 'LITE', 'COHR', 'GLW', 'MRVL', 'AAOI'],
    packaging: ['AMAT', 'LRCX', 'TSM', 'KLAC'],
    power: ['BE'], // 用户指定只用 Bloom Energy（单一标的波动大，排名噪声已知晓）
  },
  BENCH_SYMBOL: 'SPY',

  // 卡点识别：30天窗口捕捉环节间轮动（90天的 AI_MARKET_WINDOW_DAYS 用于判断大周期，语义不同）
  AI_CHAIN_WINDOW_DAYS: 30,
  MIN_STAGES_FOR_RANKING: 3, // 有效环节少于3个时不给自动卡点结论

  // 云厂商资本开支监测（滚动4季度同比）
  HYPERSCALERS: ['MSFT', 'AMZN', 'GOOGL', 'META'],
  CAPEX_LOOKBACK_DAYS: 830, // 约9个季度含缓冲

  // OpenRouter 模型调用量（需 OPENROUTER_API_KEY，展示时须注明来源 openrouter.ai/rankings）
  OPENROUTER_RANKINGS_URL: 'https://openrouter.ai/api/v1/datasets/rankings-daily',
  USAGE_RECENT_DAYS: 7,   // 近期均值窗口
  USAGE_PRIOR_DAYS: 28,   // 对照均值窗口
  USAGE_FETCH_DAYS: 40,   // 拉取天数（7+28+缓冲）

  // Yahoo 顺序拉取间隔，避免突发并发触发429
  YAHOO_CALL_DELAY_MS: 350,
};
