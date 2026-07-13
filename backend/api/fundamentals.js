// 真实 P/S 计算（SEC EDGAR 官方 XBRL，无需key）：P/S = 股价 × 流通股本 ÷ TTM营收
// 背景：FMP 免费层 ratios 只覆盖少数大盘股(其余402)，Yahoo quoteSummary 端点对本机限流，
// EDGAR 是权威、免费且畅通的兜底。ETF/指数无财报 → null 属正常
import axios from 'axios';

// SEC 公平访问政策要求 User-Agent 为"名称 邮箱"裸格式——带括号或版本号会被WAF拒绝(403)
const EDGAR_HEADERS = {
  'User-Agent': 'StockSentinel admin@stocksentinel.app',
  'Accept-Encoding': 'gzip, deflate',
};
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const conceptUrl = (cik, taxonomy, concept) =>
  `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${concept}.json`;

// 各公司营收科目命名不一（与 AMZN capex 科目同类问题），按常见度依次尝试；
// 外国发行人（NBIS/SKHY等20-F filer）用 IFRS 分类账，最后回退 ifrs-full
const REVENUE_CONCEPTS = [
  ['us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax'],
  ['us-gaap', 'Revenues'],
  ['us-gaap', 'RevenueFromContractWithCustomerIncludingAssessedTax'],
  ['us-gaap', 'SalesRevenueNet'],
  ['ifrs-full', 'RevenueFromContractsWithCustomers'],
  ['ifrs-full', 'Revenue'],
];

const DAY_MS = 86400000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 财报数据按季更新，24小时缓存足够

// SEC 限速 10次/秒：全局串行队列 + 最小间隔，watchlist 并发拉取时不齐发
let edgarQueue = Promise.resolve();
function edgarGet(url) {
  const run = edgarQueue.then(async () => {
    const res = await axios.get(url, { headers: EDGAR_HEADERS, timeout: 15000 });
    await new Promise(r => setTimeout(r, 120));
    return res;
  });
  // 队列继续推进（失败不阻塞后续请求）
  edgarQueue = run.catch(() => {});
  return run;
}

let cikMap = null;
let cikMapAt = 0;
async function tickerToCik(symbol) {
  if (!cikMap || Date.now() - cikMapAt > CACHE_TTL_MS) {
    const res = await edgarGet(TICKERS_URL);
    cikMap = new Map();
    for (const row of Object.values(res.data || {})) {
      if (row?.ticker) cikMap.set(String(row.ticker).toUpperCase(), String(row.cik_str).padStart(10, '0'));
    }
    cikMapAt = Date.now();
  }
  return cikMap.get(String(symbol).toUpperCase()) || null;
}

/**
 * 从 units.USD 事实数组求 TTM 营收（纯函数）：
 * 优先季度口径（duration 80~100天）最近4季求和；不足4季时退回最近年报口径
 * （duration 350~380天，覆盖 20-F 外国发行人只报年度的情形）。
 * 最新报告期距今超过400天（数据陈旧）→ null
 * @param {Array<{start, end, val, form}>} facts
 * @param {string} today - YYYY-MM-DD（可注入便于测试）
 */
export function sumTtmRevenue(facts, today = new Date().toISOString().slice(0, 10)) {
  const nowMs = new Date(today + 'T00:00:00Z').getTime();
  const withDuration = (facts || [])
    .filter(f => f.start && f.end && f.val != null && !isNaN(f.val))
    .map(f => ({ ...f, days: (new Date(f.end) - new Date(f.start)) / DAY_MS }));

  // 同一报告期可能被多次披露（原报+重述），按 end 去重取最新披露
  const dedupe = arr => {
    const byEnd = new Map();
    for (const f of arr) byEnd.set(f.end, f);
    return [...byEnd.values()].sort((a, b) => (a.end < b.end ? 1 : -1));
  };

  const quarters = dedupe(withDuration.filter(f => f.days >= 80 && f.days <= 100));
  if (quarters.length >= 4 && nowMs - new Date(quarters[0].end).getTime() <= 400 * DAY_MS) {
    return quarters.slice(0, 4).reduce((s, f) => s + f.val, 0);
  }

  const annuals = dedupe(withDuration.filter(f => f.days >= 350 && f.days <= 380));
  if (annuals.length && nowMs - new Date(annuals[0].end).getTime() <= 400 * DAY_MS) {
    return annuals[0].val;
  }
  return null;
}

async function fetchRevenueTtm(cik) {
  for (const [taxonomy, concept] of REVENUE_CONCEPTS) {
    try {
      const res = await edgarGet(conceptUrl(cik, taxonomy, concept));
      const ttm = sumTtmRevenue(res.data?.units?.USD);
      if (ttm) return ttm;
    } catch { /* 科目不存在(404)属正常，试下一个 */ }
  }
  return null;
}

async function fetchSharesOutstanding(cik) {
  try {
    const res = await edgarGet(conceptUrl(cik, 'dei', 'EntityCommonStockSharesOutstanding'));
    const facts = res.data?.units?.shares || [];
    const latest = facts
      .filter(f => f.val != null && !isNaN(f.val) && f.val > 0)
      .sort((a, b) => ((a.end || '') < (b.end || '') ? 1 : -1))[0];
    return latest?.val ?? null;
  } catch {
    return null;
  }
}

const psCache = new Map(); // symbol → {value, at}（null 结果也缓存，ETF/无财报标的不反复打EDGAR）

/**
 * EDGAR 计算真实 P/S；拿不到（ETF/指数/外国发行人无XBRL）→ null，全程静默不抛
 */
export async function getPsFromEdgar(symbol, price) {
  if (!symbol || /^\^/.test(symbol) || price == null || !price) return null;
  const cached = psCache.get(symbol);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let value = null;
  try {
    const cik = await tickerToCik(symbol);
    if (cik) {
      const [revenue, shares] = [await fetchRevenueTtm(cik), await fetchSharesOutstanding(cik)];
      if (revenue && shares) {
        const ps = (price * shares) / revenue;
        if (ps > 0 && ps < 10000) value = ps;
      }
    }
  } catch (err) {
    console.warn(`[fundamentals] EDGAR PS(${symbol}) failed:`, err.message);
  }
  psCache.set(symbol, { value, at: Date.now() });
  return value;
}

export function clearFundamentalsCache() {
  psCache.clear();
  cikMap = null;
  cikMapAt = 0;
}
