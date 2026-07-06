import yahooFinance from 'yahoo-finance2';

/**
 * 拉取股票数据：价格历史百分位 + 当前 P/E 和 P/S
 * @param {string} symbol
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 * @returns {object}
 */
export async function fetchStockData(symbol, startDate, endDate) {
  const [historical, quote] = await Promise.all([
    yahooFinance.historical(symbol, { period1: startDate, period2: endDate }).catch(() => []),
    yahooFinance.quote(symbol).catch(() => null),
  ]);

  const closes = historical.map(h => h.close).filter(v => v !== null && v !== undefined);
  const currentPrice = quote?.regularMarketPrice ?? closes[closes.length - 1] ?? null;

  const percentile = calcPricePercentile(currentPrice, closes);

  return {
    symbol: symbol.toUpperCase(),
    currentPrice,
    pricePercentile: percentile,
    startDate,
    endDate,
    dataPointCount: closes.length,
    currentPE: quote?.trailingPE ?? null,
    currentPS: quote?.priceToBook ?? null, // yahoo-finance2 用 priceToBook 近似 P/S
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
