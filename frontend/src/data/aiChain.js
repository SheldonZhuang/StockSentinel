// AI产业链资金流向地图（静态数据，管理员手动维护更新）
//
// tickers 说明：
// - 未上市公司用公司名展示（如 'Anthropic'、'OpenAI'），不是股票代码，不可用于行情/自选股接口
// - 可交易标的篮子须与 backend/config/ai-chain.config.js 的 STAGE_BASKETS 保持同步（后端用它做环节相对强弱排名）
// - memory 环节：SKHY = SK海力士 NASDAQ ADR（2026-07-10上市），005930.KS = 三星电子（KRX，Yahoo源）
// - 同一代码可能出现在多个环节（如 'GOOGL' 同时在 model 和 cloud，因为 Google 既做AI大模型也做云服务），这是有意为之，不是重复错误
export const AI_CHAIN_STAGES = [
  {
    key: 'model',
    tickers: ['Anthropic', 'OpenAI', 'Google Gemini'],
  },
  {
    key: 'cloud',
    tickers: ['MSFT', 'AMZN', 'GOOGL', 'META', 'NBIS'],
  },
  {
    key: 'chip',
    tickers: ['NVDA', 'AMD', 'AVGO', 'ARM', 'INTC'],
  },
  {
    key: 'memory',
    tickers: ['SKHY', '005930.KS', 'MU', 'SNDK'],
  },
  {
    key: 'optical',
    tickers: ['LITE', 'COHR', 'GLW', 'MRVL', 'AAOI', 'SIVEF'],
  },
  {
    key: 'packaging',
    tickers: ['AMAT', 'LRCX', 'TSM', 'KLAC'],
  },
  {
    key: 'power',
    tickers: ['BE'],
  },
];
