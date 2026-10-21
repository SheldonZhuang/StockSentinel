// SEC EDGAR 统一访问层（129号）：此前 fundamentals / fetch-guidance / fetch-ai-chain 各有一份请求头，
// 只有 fundamentals 有真正的全局串行限速，三处都没有 HTTP 级重试。统一到这里：
//   - User-Agent：SEC 公平访问政策要求"名称 邮箱"裸格式——带括号或版本号会被 WAF 拒绝(403)
//   - 限速：SEC 上限 10 次/秒，进程内全局串行队列 + 最小间隔 120ms（并发调用方也不会齐发）
//   - 重试：仅瞬时故障（429 / 5xx / 网络超时与断连）指数退避，404/403 等确定性错误立即抛出
import axios from 'axios';

export const EDGAR_HEADERS = {
  'User-Agent': 'StockSentinel admin@stocksentinel.app',
  'Accept-Encoding': 'gzip, deflate',
};

const MIN_INTERVAL_MS = 120;
const RETRY_DELAYS_MS = [1000, 3000]; // 共 3 次尝试；429 时 SEC 建议放缓，退避足够长
const TRANSIENT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_NETWORK']);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 瞬时故障判定（纯函数，导出便于测试） */
export function isTransientEdgarError(err) {
  const status = err?.response?.status;
  if (status) return status === 429 || status >= 500;
  return TRANSIENT_CODES.has(err?.code);
}

let queue = Promise.resolve();

/**
 * 串行限速的 EDGAR GET。opts 透传 axios（timeout / responseType 等）。
 * 重试在队列内完成：退避期间不放行其他请求，避免 429 时其他调用方继续打满。
 */
export function edgarGet(url, opts = {}) {
  const { timeout = 20000, ...rest } = opts;
  const run = queue.then(async () => {
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await axios.get(url, { headers: EDGAR_HEADERS, timeout, ...rest });
        } catch (err) {
          if (attempt >= RETRY_DELAYS_MS.length || !isTransientEdgarError(err)) throw err;
          await sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    } finally {
      await sleep(MIN_INTERVAL_MS);
    }
  });
  queue = run.catch(() => {}); // 失败不阻塞后续请求
  return run;
}

// 公司代码 → 10位补零 CIK（www.sec.gov/files/company_tickers.json，24 小时缓存）
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const CIK_TTL_MS = 24 * 60 * 60 * 1000;
let cikMap = null;
let cikMapAt = 0;

export async function tickerToCik(symbol) {
  if (!cikMap || Date.now() - cikMapAt > CIK_TTL_MS) {
    const res = await edgarGet(TICKERS_URL);
    const m = new Map();
    for (const row of Object.values(res.data || {})) {
      if (row?.ticker) m.set(String(row.ticker).toUpperCase(), String(row.cik_str).padStart(10, '0'));
    }
    cikMap = m;
    cikMapAt = Date.now();
  }
  return cikMap.get(String(symbol).toUpperCase()) || null;
}

/** 测试用：清空 CIK 缓存 */
export function _resetCikCache() {
  cikMap = null;
  cikMapAt = 0;
}

export const submissionsUrl = cik => `https://data.sec.gov/submissions/CIK${cik}.json`;
export const companyFactsUrl = cik => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
/** 申报目录（路径用无前导零的 CIK、去横线的 accession） */
export const archiveBase = (cik, accession) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(accession).replace(/-/g, '')}`;
