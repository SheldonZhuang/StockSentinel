import { getDailyCloses, getQuote } from './market-data.js';

/**
 * 拉取股票数据：价格历史百分位 + 当前 P/E 和 P/S
 * 行情走 market-data 三层回退（Yahoo→Tiingo→TwelveData）；备用源无估值字段时 PE/PS 为 null
 * @param {string} symbol
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 * @returns {object}
 */
export async function fetchStockData(symbol, startDate, endDate) {
  const [bars, quote] = await Promise.all([
    getDailyCloses(symbol, startDate, endDate),
    getQuote(symbol),
  ]);

  const closes = (bars || []).map(b => b.close);
  const currentPrice = quote?.price ?? closes[closes.length - 1] ?? null;

  const percentile = calcPricePercentile(currentPrice, closes);

  return {
    symbol: symbol.toUpperCase(),
    currentPrice,
    pricePercentile: percentile,
    startDate,
    endDate,
    dataPointCount: closes.length,
    currentPE: quote?.trailingPE ?? null,
    currentPS: quote?.priceToSales ?? null, // 真实P/S来自FMP ratios-ttm；ETF/指数无财报为null属正常
    trailingPE: quote?.trailingPE ?? null,
    forwardPE: quote?.forwardPE ?? null,
    shortName: quote?.shortName ?? symbol,
  };
}

/**
 * 计算当前价格在历史价格序列中的百分位（0-100）
 */
export function calcPricePercentile(currentPrice, closePrices) {
  if (!currentPrice || closePrices.length === 0) return null;
  const below = closePrices.filter(p => p <= currentPrice).length;
  return Math.round((below / closePrices.length) * 100);
}
