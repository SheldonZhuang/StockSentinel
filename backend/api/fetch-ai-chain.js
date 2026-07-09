import axios from 'axios';
import yahooFinance from 'yahoo-finance2';
import chainCfg from '../config/ai-chain.config.js';
import { calcRelativeReturn } from './fetch-policy.js';
import { todayET, daysAgoET } from '../utils/datetime.js';

const {
  STAGE_KEYS,
  STAGE_BASKETS,
  BENCH_SYMBOL,
  AI_CHAIN_WINDOW_DAYS,
  MIN_STAGES_FOR_RANKING,
  HYPERSCALERS,
  CAPEX_LOOKBACK_DAYS,
  OPENROUTER_RANKINGS_URL,
  USAGE_RECENT_DAYS,
  USAGE_PRIOR_DAYS,
  USAGE_FETCH_DAYS,
} = chainCfg;

const NULL_USAGE = { modelUsageTrendPct: null, modelUsageLatestTokens: null, modelUsageAsOf: null };
const NULL_CAPEX = { capexYoY: null, capexTtm: null, capexPrevTtm: null };
const NULL_RANKING = {
  stages: STAGE_KEYS.map(key => ({ key, relReturnPct: null, rank: null, validTickerCount: 0 })),
  autoBottleneck: null,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 运行时读取，便于测试将间隔置0
const throttle = () => sleep(chainCfg.YAHOO_CALL_DELAY_MS);

/**
 * OpenRouter rankings-daily 行数据（含 'other' 行）→ 按日汇总 token 总量（升序）
 * @param {Array<{date, model_permaslug, total_tokens}>} rows - total_tokens 为字符串
 * @returns {Array<{date, tokens}>}
 */
export function aggregateDailyTokens(rows) {
  const byDate = new Map();
  for (const row of rows || []) {
    const t = parseFloat(row.total_tokens);
    if (!row.date || isNaN(t)) continue;
    byDate.set(row.date, (byDate.get(row.date) || 0) + t);
  }
  return [...byDate.entries()]
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 调用量趋势：近 recentDays 日均量 vs 之前 priorDays 日均量
 * 最新一天若是"今天"(UTC)视为不完整数据丢弃；完整天数不足 recent+prior → 全 null
 * @returns {{modelUsageTrendPct, modelUsageLatestTokens, modelUsageAsOf}}
 */
export function calcUsageTrend(dailyTotals, recentDays = USAGE_RECENT_DAYS, priorDays = USAGE_PRIOR_DAYS, todayUtc = new Date().toISOString().slice(0, 10)) {
  let totals = dailyTotals || [];
  if (totals.length && totals[totals.length - 1].date >= todayUtc) {
    totals = totals.slice(0, -1);
  }
  if (totals.length < recentDays + priorDays) return { ...NULL_USAGE };

  const recent = totals.slice(-recentDays);
  const prior = totals.slice(-(recentDays + priorDays), -recentDays);
  const avg = arr => arr.reduce((a, b) => a + b.tokens, 0) / arr.length;
  const priorAvg = avg(prior);
  if (priorAvg === 0) return { ...NULL_USAGE };

  return {
    modelUsageTrendPct: (avg(recent) / priorAvg - 1) * 100,
    modelUsageLatestTokens: recent[recent.length - 1].tokens,
    modelUsageAsOf: recent[recent.length - 1].date,
  };
}

/**
 * 云厂商滚动4季资本开支同比。capex 为现金流出（负值），用绝对值口径比较；
 * 不足8个季度的公司从两期中同时剔除，保证同比口径一致
 * @param {Object<string, Array<{date, capitalExpenditure}>>} quartersBySymbol - 各公司季度数据（降序）
 * @returns {{capexYoY, capexTtm, capexPrevTtm}}
 */
export function calcCapexYoY(quartersBySymbol) {
  let ttm = 0;
  let prevTtm = 0;
  let qualified = 0;
  for (const quarters of Object.values(quartersBySymbol || {})) {
    const values = (quarters || [])
      .map(q => parseFloat(q.capitalExpenditure))
      .filter(v => !isNaN(v));
    if (values.length < 8) continue;
    qualified++;
    ttm += Math.abs(values.slice(0, 4).reduce((a, b) => a + b, 0));
    prevTtm += Math.abs(values.slice(4, 8).reduce((a, b) => a + b, 0));
  }
  if (qualified === 0 || prevTtm === 0) return { ...NULL_CAPEX };
  return {
    capexYoY: (ttm / prevTtm - 1) * 100,
    capexTtm: ttm,
    capexPrevTtm: prevTtm,
  };
}

/**
 * 各环节篮子相对SPY收益：等权平均，无效标的剔除，全无效 → null
 * @param {Object<string, string[]>} stageBaskets
 * @param {Map<string, Array|null>} barsBySymbol
 * @param {Array} benchBars
 * @returns {Array<{key, relReturnPct, validTickerCount}>}
 */
export function calcStageRelReturns(stageBaskets, barsBySymbol, benchBars) {
  return Object.entries(stageBaskets).map(([key, tickers]) => {
    const rets = tickers
      .map(sym => calcRelativeReturn(barsBySymbol.get(sym), benchBars))
      .filter(v => v !== null);
    return {
      key,
      relReturnPct: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null,
      validTickerCount: rets.length,
    };
  });
}

/**
 * 环节排名：相对收益降序，第1名 = 市场隐含卡点；有效环节不足 minStages → 不给结论
 * @returns {{stages: Array<{key, relReturnPct, rank, validTickerCount}>, autoBottleneck: string|null}}
 */
export function rankStages(stageMetrics, minStages = MIN_STAGES_FOR_RANKING) {
  const valid = stageMetrics
    .filter(s => s.relReturnPct !== null)
    .sort((a, b) => b.relReturnPct - a.relReturnPct);
  const rankByKey = new Map(valid.map((s, i) => [s.key, i + 1]));

  const stages = stageMetrics.map(s => ({ ...s, rank: rankByKey.get(s.key) ?? null }));
  const autoBottleneck = valid.length >= minStages ? valid[0].key : null;
  return { stages, autoBottleneck };
}

/**
 * 顺序拉取多只标的的日线（每次间隔 YAHOO_CALL_DELAY_MS，避免突发429），单标的失败 → null
 * @returns {Map<string, Array|null>}
 */
async function fetchBarsSequential(symbols, period1, period2) {
  const bars = new Map();
  for (const sym of symbols) {
    try {
      bars.set(sym, await yahooFinance.historical(sym, { period1, period2 }));
    } catch (err) {
      console.warn(`[fetch-ai-chain] historical(${sym}) failed:`, err.message);
      bars.set(sym, null);
    }
    await throttle();
  }
  return bars;
}

/**
 * 环节排名：SPY 只拉一次，五个篮子标的顺序拉取
 */
export async function fetchStageRanking() {
  const period1 = daysAgoET(AI_CHAIN_WINDOW_DAYS);
  const period2 = todayET();

  let benchBars;
  try {
    benchBars = await yahooFinance.historical(BENCH_SYMBOL, { period1, period2 });
  } catch (err) {
    console.warn(`[fetch-ai-chain] bench ${BENCH_SYMBOL} fetch failed:`, err.message);
    return { ...NULL_RANKING };
  }
  await throttle();

  const allTickers = Object.values(STAGE_BASKETS).flat();
  const barsBySymbol = await fetchBarsSequential(allTickers, period1, period2);

  const metrics = calcStageRelReturns(STAGE_BASKETS, barsBySymbol, benchBars);
  const { stages: ranked, autoBottleneck } = rankStages(metrics);

  // 补上不参与排名的 model 环节，保持 STAGE_KEYS 完整顺序
  const byKey = new Map(ranked.map(s => [s.key, s]));
  const stages = STAGE_KEYS.map(key => byKey.get(key) || { key, relReturnPct: null, rank: null, validTickerCount: 0 });
  return { stages, autoBottleneck };
}

/**
 * OpenRouter 模型调用量趋势。无 key → null（预警不触发），解析异常 → null
 * 数据来源须注明：Source: OpenRouter (openrouter.ai/rankings)
 */
export async function fetchModelUsage() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn('[fetch-ai-chain] OPENROUTER_API_KEY not set, model usage metrics unavailable');
    return { ...NULL_USAGE };
  }

  const endDate = new Date().toISOString().slice(0, 10); // OpenRouter 按 UTC 日历日统计
  const startDate = new Date(Date.now() - USAGE_FETCH_DAYS * 86400000).toISOString().slice(0, 10);
  const res = await axios.get(OPENROUTER_RANKINGS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    params: { start_date: startDate, end_date: endDate },
    timeout: 20000,
  });
  const rows = res.data?.data;
  if (!Array.isArray(rows)) {
    console.warn('[fetch-ai-chain] unexpected OpenRouter response shape');
    return { ...NULL_USAGE };
  }
  return calcUsageTrend(aggregateDailyTokens(rows));
}

/**
 * 云厂商季度资本开支（fundamentalsTimeSeries），顺序拉取，单公司失败 → 剔除
 */
export async function fetchHyperscalerCapex() {
  const period1 = daysAgoET(CAPEX_LOOKBACK_DAYS);
  const period2 = todayET();
  const quartersBySymbol = {};

  for (const sym of HYPERSCALERS) {
    try {
      const rows = await yahooFinance.fundamentalsTimeSeries(sym, {
        period1, period2, type: 'quarterly', module: 'cash-flow',
      });
      quartersBySymbol[sym] = (rows || [])
        .map(r => ({ date: r.date, capitalExpenditure: r.capitalExpenditure }))
        .sort((a, b) => (a.date < b.date ? 1 : -1)); // 降序：最新季度在前
    } catch (err) {
      console.warn(`[fetch-ai-chain] capex(${sym}) failed:`, err.message);
    }
    await throttle();
  }
  return calcCapexYoY(quartersBySymbol);
}

/**
 * AI产业链全量数据：环节排名 + 调用量趋势 + 资本开支同比
 * 各子域独立容错，永不 throw；Yahoo 子域串行执行避免429，OpenRouter 不同域可并行
 */
export async function fetchAiChainData() {
  const usagePromise = fetchModelUsage().catch(err => {
    console.warn('[fetch-ai-chain] model usage fetch failed:', err.message);
    return { ...NULL_USAGE };
  });

  const ranking = await fetchStageRanking().catch(err => {
    console.warn('[fetch-ai-chain] stage ranking failed:', err.message);
    return { ...NULL_RANKING };
  });
  const capex = await fetchHyperscalerCapex().catch(err => {
    console.warn('[fetch-ai-chain] capex fetch failed:', err.message);
    return { ...NULL_CAPEX };
  });
  const usage = await usagePromise;

  return { ...ranking, ...usage, ...capex };
}
