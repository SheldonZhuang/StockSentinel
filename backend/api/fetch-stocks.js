import { getDailyCloses, getQuote, normalizeSymbol } from './market-data.js';
import { getPsFromEdgar } from './fundamentals.js';

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
  const lastClose = closes[closes.length - 1] ?? null;
  const currentPrice = quote?.price ?? lastClose;

  // 报价链无P/S（FMP免费层只盖大盘股、Yahoo summary端点限流）→ EDGAR XBRL 计算真实P/S
  const currentPS = quote?.priceToSales
    ?? await getPsFromEdgar(normalizeSymbol(symbol), currentPrice);

  // 百分位必须在同一价格序列内部比较：历史 bar 走分红复权收盘（adjClose），
  // 而 quote.price 是未复权实时价——两者混用会把高股息股的当前百分位系统性抬高。
  // 故用同序列的最后一根 close 参与排位；quote.price 仅用于展示与估值。
  const percentile = calcPricePercentile(lastClose, closes);

  return {
    symbol: symbol.toUpperCase(),
    currentPrice,
    pricePercentile: percentile,
    startDate,
    endDate,
    dataPointCount: closes.length,
    currentPE: quote?.trailingPE ?? null,
    currentPS, // FMP/EDGAR双路真实P/S；ETF/指数无财报为null属正常
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
