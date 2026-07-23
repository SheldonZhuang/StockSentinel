import axios from 'axios';
import chainCfg from '../config/ai-chain.config.js';
import { calcRelativeReturn } from './fetch-policy.js';
import { getDailyCloses } from './market-data.js';
import { todayET, daysAgoET } from '../utils/datetime.js';

const {
  STAGE_KEYS,
  STAGE_BASKETS,
  BENCH_SYMBOL,
  AI_CHAIN_WINDOW_DAYS,
  MIN_STAGES_FOR_RANKING,
  HYPERSCALER_CIK,
  OPENROUTER_RANKINGS_URL,
  USAGE_RECENT_DAYS,
  USAGE_PRIOR_DAYS,
  USAGE_FETCH_DAYS,
} = chainCfg;

// SEC EDGAR 官方 XBRL 数据：无需key，限速10次/秒；
// SEC 公平访问政策要求 User-Agent 为"名称 邮箱"裸格式——带括号或版本号会被WAF拒绝(403)
const EDGAR_HEADERS = {
  'User-Agent': 'StockSentinel admin@stocksentinel.app',
  'Accept-Encoding': 'gzip, deflate',
};
const edgarUrl = (cik, concept) => `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`;

const NULL_USAGE = { modelUsageTrendPct: null, modelUsageLatestTokens: null, modelUsageAsOf: null };
const NULL_CAPEX = {
  capexYoY: null, capexTtm: null, capexPrevTtm: null,
  capexQtrYoY: null, capexQtrSum: null, capexQtrPrevYearSum: null, capexQtrEnd: null,
  capexQtrPrevQtrYoY: null,
};
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

// 季度末日期 → 日历季度桶（如 '2026Q1'）。四大家季度末都是日历季（3/6/9/12月末），
// 但精确日期可能差1-2天，按桶对齐而非按日期对齐
// （fetch-guidance 的单公司快报计算复用同一套桶运算，导出）
export const quarterKey = date => {
  const [y, m] = date.split('-').map(Number);
  return `${y}Q${Math.ceil(m / 3)}`;
};

// 季度桶键运算：'2026Q1' ± n 季（跨年自动进退位）
export const shiftQuarterKey = (key, n) => {
  const [y, q] = key.split('Q').map(Number);
  const total = y * 4 + (q - 1) + n;
  return `${Math.floor(total / 4)}Q${(total % 4) + 1}`;
};

/**
 * 单公司季度序列 → 通过口径校验的有效序列；不合格返回 null
 * 口径与 TTM 同比一致：完整8季 + 最新季在400天内（防换XBRL标签后旧数据冻结污染加总）
 */
function qualifiedCapexQuarters(quarters, staleBeforeMs) {
  const valid = (quarters || []).filter(q => !isNaN(parseFloat(q.capitalExpenditure)));
  if (valid.length < 8) return null;
  const latestEnd = valid[0].date;
  if (latestEnd && new Date(latestEnd).getTime() < staleBeforeMs) return null;
  return valid;
}

// 前8季是否为严格连续日历季（TTM 位置切片 slice(0,4)/slice(4,8) 假定连续；
// deriveQuarterlyCapex 在 YTD 链断裂时会静默跳季，中段缺口会把错季拼进 prevTtm 产出
// 看似合理的错误同比。calcCapexQuarterYoY 用桶查找不受影响，故校验只在 TTM 口径生效）
function isFirst8Consecutive(valid) {
  const k0 = quarterKey(valid[0].date);
  for (let i = 1; i < 8; i++) {
    if (quarterKey(valid[i].date) !== shiftQuarterKey(k0, -i)) return false;
  }
  return true;
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
  const staleBeforeMs = Date.now() - 400 * 86400000; // 最新季度需在400天内，防某公司换XBRL标签后旧数据冻结
  for (const quarters of Object.values(quartersBySymbol || {})) {
    const valid = qualifiedCapexQuarters(quarters, staleBeforeMs);
    if (!valid || !isFirst8Consecutive(valid)) continue;
    const values = valid.map(q => parseFloat(q.capitalExpenditure));
    qualified++;
    ttm += Math.abs(values.slice(0, 4).reduce((a, b) => a + b, 0));
    prevTtm += Math.abs(values.slice(4, 8).reduce((a, b) => a + b, 0));
  }
  if (qualified === 0 || prevTtm === 0) {
    return { capexYoY: null, capexTtm: null, capexPrevTtm: null };
  }
  return {
    capexYoY: (ttm / prevTtm - 1) * 100,
    capexTtm: ttm,
    capexPrevTtm: prevTtm,
  };
}

/**
 * 最新共同单季资本开支同比（拐点侦察兵，TTM 同比是趋势确认官）：
 * TTM 是4季滑动平均，单季刹车会被前三季存量稀释、滞后2-3个财报季才显形；
 * 单季同比是财报数据里最早的事实性拐点信号。
 *
 * 错季对齐：财报季中途四大家发布不同步（MSFT已出新季而AMZN未出），
 * 取所有合格公司都已披露的最近日历季度桶合计，与去年同季桶比较；
 * 缺任一期数据的公司从两期同时剔除，保证同比口径一致。
 * 单季用同比而非环比：capex 有明显季节性（普遍Q4冲高），环比噪声无判读价值。
 *
 * capexQtrPrevQtrYoY = 共同最新季的前一季的单季同比（同一套 EDGAR 数据回退一季重算，
 * 与主值同口径），供 N2"连续两季转负判收紧"用——从数据源直接算而非依赖快照历史，
 * 快照断档不影响连续性判定。
 * @param {Object<string, Array<{date, capitalExpenditure}>>} quartersBySymbol - 各公司季度数据（降序）
 * @returns {{capexQtrYoY, capexQtrSum, capexQtrPrevYearSum, capexQtrEnd, capexQtrPrevQtrYoY}}
 */
export function calcCapexQuarterYoY(quartersBySymbol) {
  const staleBeforeMs = Date.now() - 400 * 86400000;
  const NULL_QTR = {
    capexQtrYoY: null, capexQtrSum: null, capexQtrPrevYearSum: null, capexQtrEnd: null,
    capexQtrPrevQtrYoY: null,
  };

  // 各合格公司：季度桶 → {date, value}（降序首个为准，重复桶忽略旧值）
  const companies = [];
  for (const quarters of Object.values(quartersBySymbol || {})) {
    const valid = qualifiedCapexQuarters(quarters, staleBeforeMs);
    if (!valid) continue;
    const byBucket = new Map();
    for (const q of valid) {
      const key = quarterKey(q.date);
      if (!byBucket.has(key)) byBucket.set(key, { date: q.date, value: parseFloat(q.capitalExpenditure) });
    }
    companies.push({ byBucket, latestKey: quarterKey(valid[0].date) });
  }
  if (!companies.length) return { ...NULL_QTR };

  // 共同最新季 = 各公司最新季桶的最小值（YYYYQn 字符串比较即时间序）
  const commonKey = companies.map(c => c.latestKey).sort()[0];

  // 指定季度桶的四家合计同比；任一公司缺任一期 → 该公司两期同剔
  const yoyAtKey = key => {
    const prevYearKey = shiftQuarterKey(key, -4);
    let sum = 0;
    let prevSum = 0;
    let qtrEnd = null;
    for (const c of companies) {
      const cur = c.byBucket.get(key);
      const prev = c.byBucket.get(prevYearKey);
      if (!cur || !prev) continue;
      sum += Math.abs(cur.value);
      prevSum += Math.abs(prev.value);
      if (!qtrEnd || cur.date > qtrEnd) qtrEnd = cur.date;
    }
    if (prevSum === 0) return null;
    return { yoy: (sum / prevSum - 1) * 100, sum, prevSum, qtrEnd };
  };

  const current = yoyAtKey(commonKey);
  if (!current) return { ...NULL_QTR };
  const prevQtr = yoyAtKey(shiftQuarterKey(commonKey, -1));
  return {
    capexQtrYoY: current.yoy,
    capexQtrSum: current.sum,
    capexQtrPrevYearSum: current.prevSum,
    capexQtrEnd: current.qtrEnd,
    capexQtrPrevQtrYoY: prevQtr?.yoy ?? null,
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
 * 走 market-data 三层回退（Yahoo→Tiingo→TwelveData）
 * @returns {Map<string, Array|null>}
 */
async function fetchBarsSequential(symbols, period1, period2) {
  const bars = new Map();
  for (const sym of symbols) {
    try {
      bars.set(sym, await getDailyCloses(sym, period1, period2));
    } catch (err) {
      console.warn(`[fetch-ai-chain] closes(${sym}) failed:`, err.message);
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

  const benchBars = await getDailyCloses(BENCH_SYMBOL, period1, period2);
  if (!benchBars) {
    console.warn(`[fetch-ai-chain] bench ${BENCH_SYMBOL} unavailable from all providers`);
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
 * SEC XBRL facts → 离散季度 capex 序列（降序）
 * 现金流量表在 10-Q 中按财年累计(YTD)披露：同一财年起点下，相邻累计值相减得出单季值；
 * 10-K 全年值减去9个月累计得出 Q4；独立披露的单季 fact（时长60-120天）直接采用。
 * 同一季度末重复出现时取 filed 最新者（修正案 10-Q/A 的 fact 未必按申报顺序排在数组末尾，
 * SEC companyconcept API 不承诺按 filed 排序；显式比较 filed 才能确保采用修正值而非被旧值覆盖）
 * @param {Array<{start, end, val, form, filed}>} facts - units.USD 数组
 * @returns {Array<{date, capitalExpenditure}>} 按 date 降序
 */
export function deriveQuarterlyCapex(facts) {
  const seen = new Map();
  for (const f of facts || []) {
    if (!f.start || !f.end || typeof f.val !== 'number') continue;
    if (f.form && !f.form.startsWith('10-Q') && !f.form.startsWith('10-K')) continue;
    const k = `${f.start}|${f.end}`;
    const old = seen.get(k);
    if (!old || !f.filed || !old.filed || f.filed >= old.filed) seen.set(k, f);
  }

  const byStart = new Map();
  for (const f of seen.values()) {
    if (!byStart.has(f.start)) byStart.set(f.start, []);
    byStart.get(f.start).push(f);
  }

  const DAY = 86400000;
  const quarters = new Map(); // 季度末日期 → 单季值
  for (const [start, entries] of byStart) {
    entries.sort((a, b) => (a.end < b.end ? -1 : 1));
    let prevVal = 0;
    let prevEnd = start;
    for (const e of entries) {
      const days = (new Date(e.end) - new Date(prevEnd)) / DAY;
      // 相邻累计差覆盖 prevEnd→end 区间：只有约一个季度长时才是有效单季值
      // （链条缺季时区间会超长，自动跳过，不会把半年值当成单季）
      if (days >= 60 && days <= 120) quarters.set(e.end, e.val - prevVal);
      prevVal = e.val;
      prevEnd = e.end;
    }
  }

  return [...quarters.entries()]
    .map(([date, capitalExpenditure]) => ({ date, capitalExpenditure }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * 单公司季度 capex 序列（降序）：EDGAR 主源 + FMP 备源（2026-07-21 双源冗余）。
 * fetch-guidance 财报后单公司快报复用（新 8-K 检测时按公司取历史序列算同比/TTM）。
 * 两源都失败返回 null。
 */
export async function fetchCapexSeriesForSymbol(sym) {
  const { cik, concept } = HYPERSCALER_CIK[sym] || {};
  if (!cik) return null;
  try {
    const res = await axios.get(edgarUrl(cik, concept), {
      headers: EDGAR_HEADERS,
      timeout: 20000,
    });
    return deriveQuarterlyCapex(res.data?.units?.USD);
  } catch (err) {
    console.warn(`[fetch-ai-chain] EDGAR capex(${sym}) failed:`, err.message);
    // FMP capex 已是离散单季值（无需 YTD 差分），映射为同一 {date, capitalExpenditure} 形状；
    // 免费层250次/天，仅在 EDGAR 失败时按需调用不烧配额。备源也失败返回 null
    const fb = await fetchCapexFromFmp(sym).catch(() => null);
    if (fb?.length) {
      console.log(`[fetch-ai-chain] capex(${sym}) recovered from FMP fallback (${fb.length} quarters)`);
      return fb;
    }
    return null;
  }
}

/**
 * 云厂商季度资本开支：SEC EDGAR 官方财报数据（Yahoo 财报接口对数据中心IP限流，弃用）
 * 单公司失败 → 剔除（calcCapexYoY 只聚合有完整8季数据的公司）
 */
export async function fetchHyperscalerCapex() {
  const quartersBySymbol = {};

  for (const sym of Object.keys(HYPERSCALER_CIK)) {
    const series = await fetchCapexSeriesForSymbol(sym);
    if (series?.length) quartersBySymbol[sym] = series;
    await sleep(150); // EDGAR 限速10次/秒，保守间隔
  }
  return { ...calcCapexYoY(quartersBySymbol), ...calcCapexQuarterYoY(quartersBySymbol) };
}

// FMP 现金流量表备源：季度 capex（FMP 免费层可用；stable 接口，v3 对新 key 已关闭）
const FMP_CASHFLOW_URL = 'https://financialmodelingprep.com/stable/cash-flow-statement';
const fmpApiKey = () => process.env.FMP_API_KEY || process.env.financialmodelingprep_API_KEY;

export async function fetchCapexFromFmp(symbol) {
  const key = fmpApiKey();
  if (!key) return null;
  const res = await axios.get(FMP_CASHFLOW_URL, {
    params: { symbol, period: 'quarter', limit: 12, apikey: key },
    timeout: 20000,
  });
  const rows = Array.isArray(res.data) ? res.data : [];
  return rows
    .filter(r => r.date && typeof r.capitalExpenditure === 'number')
    .map(r => ({ date: r.date, capitalExpenditure: r.capitalExpenditure }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
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
