// AI产业链资金流向地图（静态数据，管理员手动维护更新）
//
// tickers 说明：
// - 未上市公司用公司名展示（如 'Anthropic'、'OpenAI'），不是股票代码，不可用于行情/自选股接口
// - 已上市公司用交易所代码，海外代码带交易所后缀（如 '005930.KS' = 三星电子, 韩国交易所）
// - 同一代码可能出现在多个环节（如 'GOOGL' 同时在 model 和 cloud，因为 Google 既做AI大模型也做云服务），这是有意为之，不是重复错误
export const AI_CHAIN_STAGES = [
  {
    key: 'model',
    tickers: ['Anthropic', 'OpenAI', 'GOOGL'],
  },
  {
    key: 'cloud',
    tickers: ['GOOGL', 'AMZN', 'MSFT', 'META', 'NBIS'],
  },
  {
    key: 'chip',
    tickers: ['NVDA', 'AVGO', 'AMD', 'INTC'],
  },
  {
    key: 'memory',
    tickers: ['005930.KS', '000660.KS', 'MU', 'COHR', 'LITE'],
  },
  {
    key: 'packaging',
    tickers: ['TSM', 'LRCX', 'AMAT', 'KLAC'],
  },
  {
    key: 'power',
    tickers: ['BE'],
  },
];
