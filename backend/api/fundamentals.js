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
 * 从 units.USD 事实数组求 TTM 营收（纯函数）。
 * 关键背景：SEC 2021 年废除 Item 302 后 10-K 只报全年，Q4 单季事实普遍缺失——
 * "直接取最近4个季度事实求和"会混入去年同期季度导致 TTM 系统性失真（NVDA 实证偏差>10%）。
 * 算法（按优先级）：
 *   ① 最近4个季度严格连续（相邻 start≈上季end+1天，容差7天）→ 直接求和
 *   ② 标准TTM = 最新年报 + 年报后各季度 − 去年同期对应季度（对应期按 end≈-365天匹配，容差10天）
 *   ③ 仅有新鲜年报（20-F 外国发行人只报年度）→ 年报值
 * 最新报告期距今超过400天（数据陈旧）→ null
 * @param {Array<{start, end, val, form}>} facts
 * @param {string} today - YYYY-MM-DD（可注入便于测试）
 */
export function sumTtmRevenue(facts, today = new Date().toISOString().slice(0, 10)) {
  const nowMs = new Date(today + 'T00:00:00Z').getTime();
  const ms = d => new Date(d + 'T00:00:00Z').getTime();
  const withDuration = (facts || [])
    .filter(f => f.start && f.end && f.val != null && !isNaN(f.val))
    .map(f => ({ ...f, days: (ms(f.end) - ms(f.start)) / DAY_MS }));

  // 同一报告期可能被多次披露（原报+重述），按 end 去重取最新披露
  const dedupe = arr => {
    const byEnd = new Map();
    for (const f of arr) byEnd.set(f.end, f);
    return [...byEnd.values()].sort((a, b) => (a.end < b.end ? 1 : -1));
  };

  const quarters = dedupe(withDuration.filter(f => f.days >= 80 && f.days <= 100)); // 降序
  const annuals = dedupe(withDuration.filter(f => f.days >= 350 && f.days <= 380));
  const fresh = end => nowMs - ms(end) <= 400 * DAY_MS;

  // ① 4季严格连续
  if (quarters.length >= 4 && fresh(quarters[0].end)) {
    const four = quarters.slice(0, 4);
    const contiguous = four.every((q, i) =>
      i === 3 || Math.abs(ms(four[i + 1].end) + DAY_MS - ms(q.start)) <= 7 * DAY_MS);
    if (contiguous) return four.reduce((sum, f) => sum + f.val, 0);
  }

  // ② 年报 + 年报后季度 − 去年同期季度
  if (annuals.length) {
    const annual = annuals[0];
    const postQ = quarters.filter(q => ms(q.end) > ms(annual.end)).sort((a, b) => (a.end < b.end ? -1 : 1));
    const latestEnd = postQ.length ? postQ[postQ.length - 1].end : annual.end;
    if (fresh(latestEnd)) {
      let ttm = annual.val;
      let ok = true;
      for (const q of postQ) {
        const target = ms(q.end) - 365 * DAY_MS;
        const yearAgo = quarters.find(p => Math.abs(ms(p.end) - target) <= 10 * DAY_MS);
        if (!yearAgo) { ok = false; break; } // 缺同期无法校正，退回③
        ttm += q.val - yearAgo.val;
      }
      if (ok && postQ.length) return ttm;
      // ③ 仅年报（无年报后季度，或同期缺失）——年报本身需新鲜
      if (fresh(annual.end)) return annual.val;
    }
  }
  return null;
}

async function fetchRevenueTtm(cik) {
  for (const [taxonomy, concept] of REVENUE_CONCEPTS) {
    try {
      const res = await edgarGet(conceptUrl(cik, taxonomy, concept));
      const ttm = sumTtmRevenue(res.data?.units?.USD);
      if (ttm) return ttm;
    } catch (err) {
      // 404 = 该科目不存在，属正常，试下一个；其它（超时/5xx/断网）向上抛，
      // 让 getFundamentals 区分"真无财报"与"拉取失败"，避免把瞬时故障负缓存24小时
      if (err?.response?.status !== 404) throw err;
    }
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

// symbol → {revenue, shares, at}：缓存基本面而非最终P/S，价格用调用时实时价现算
// （null 结果也缓存，ETF/无财报标的不反复打EDGAR）
const fundamentalsCache = new Map();

async function getFundamentals(symbol) {
  const cached = fundamentalsCache.get(symbol);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  const entry = { revenue: null, shares: null, at: Date.now() };
  try {
    const cik = await tickerToCik(symbol);
    if (cik) {
      entry.revenue = await fetchRevenueTtm(cik);
      entry.shares = entry.revenue ? await fetchSharesOutstanding(cik) : null;
    }
    // 只有确定拉通（含"确认无财报"）才缓存：null 缓存本意是给 ETF/无财报标的，
    // 不能把瞬时网络故障也钉死 24 小时（否则故障日 watchlist 全 P/S=null 且当天不再重试）
    fundamentalsCache.set(symbol, entry);
  } catch (err) {
    console.warn(`[fundamentals] EDGAR(${symbol}) failed (not cached, will retry):`, err?.message || String(err).slice(0, 120));
    // 不写缓存 → 下次访问重试；返回本次的空 entry 供当次请求降级
  }
  return entry;
}

/**
 * EDGAR 计算真实 P/S；拿不到（ETF/指数/无XBRL）→ null，全程静默不抛。
 * 已知口径边界：ADS:普通股 ≠ 1:1 的美元报账外国发行人（如 AZN 为 1:0.5）会失真——
 * XBRL 无法可靠取得 ADS 比例；以 KRW/TWD 等本币报账的（SKHY/TSM）units.USD 缺失自然为 null（安全）。
 */
export async function getPsFromEdgar(symbol, price) {
  if (!symbol || /^\^/.test(symbol) || price == null || !price) return null;
  const { revenue, shares } = await getFundamentals(symbol);
  if (!revenue || !shares) return null;
  const ps = (price * shares) / revenue;
  return ps > 0 && ps < 10000 ? ps : null;
}

/** 每日 cron 预热：把 EDGAR 串行队列的成本移出用户请求路径 */
export async function prewarmFundamentals(symbols) {
  for (const s of symbols || []) {
    if (/^\^/.test(s)) continue;
    await getFundamentals(s).catch(() => {});
  }
}

export function clearFundamentalsCache() {
  fundamentalsCache.clear();
  cikMap = null;
  cikMapAt = 0;
}
