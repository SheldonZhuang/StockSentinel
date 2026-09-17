// Fed 官方声明源（127号，2026-09-17）：FOMC 决议结果在美东 14:00 由联邦储备委员会官网
// 直接发布，而 FRED 的 DFEDTARU 是日更序列——决议当天 21:00 的每日快照拉到的仍是决议前的
// 旧目标区间，新台阶要到决议后第 1-2 个观测日才入库。
//
// 危害（2026-09-16 实战）：9/16 加息 25bp 至 3.75-4.00%，当晚快照的 currentRate=prevRate=3.75
// → deriveSubSignals 判 rateDiffBp=0 → 「暂停→宽松」→ 货币维 loose（方向完全反了），
// 且页面显示「3.75% 0.00%（持平）」——决议日当天最需要信息的时刻，展示的正是决议前的状态。
// 原有的 decisionDataPending 护栏只做到"沿用上一快照基线"，那只是把错误锁在"暂停"上，
// 并不能得到正确的方向。
//
// 本模块把 Fed 自己的新闻稿当作决议结果的权威源：RSS 发现最新 FOMC 声明 → 抓正文 →
// 解析动词（raise/lower/maintain）与目标区间（3-3/4 to 4 percent）。判定层用其差值得出
// 真实方向与幅度（台阶生效日=决议次一工作日，与 DFEDTARU 口径一致），直到 FRED 台阶落地
// 后本模块的取值与序列一致、影响自然消失。
//
// 不变量：任何一步失败（无网络/HTML 改版/措辞变化）都返回 null，由调用方退回原有 FRED 逻辑
// ——本模块只做增量修正，绝不让新源成为判定链的单点故障。

const RSS_URL = 'https://www.federalreserve.gov/feeds/press_monetary.xml';
const REQUEST_TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (compatible; StockSentinel/1.0)';

// Fed 新闻稿用英文分数写法表示区间端点上/下界，如 "3-3/4 to 4 percent"、"3-1/2 to 3-3/4 percent"
const PCT = String.raw`\d+(?:-\d+\/\d+)?`; // "4" 或 "3-3/4"（Fed 正文中无内部空格）
// 关键：端点必须用 PCT 精确匹配。曾用 [\d\s\/-]+ 宽松匹配，字符类含空格导致
// "3-3/4" 被拆成 "3-3" 后正则走岔，整句匹配失败 → 解析恒为 null（实测踩到）
const FOMC_RE = new RegExp(
  String.raw`decided to (raise|lower|maintain)\s+the\s+target\s+range\s+for\s+the\s+federal\s+funds\s+rate\s+`
  // 幅度也可为分数（"by 1/4 percentage point"）或基点（"by 25 basis points"）——整体跳过，
  // 真实幅度由区间端点差值给（见 parseFomcStatement），不依赖这句措辞
  + String.raw`(?:by\s+[\d/.]+\s*(?:percentage\s+point|basis\s+point)s?\s+)?`
  + String.raw`(?:to|at)\s+(${PCT})\s+to\s+(${PCT})\s+percent`,
  'i'
);

/** 瞬时故障（无响应/超时/429/5xx）退避重试，4xx 立即返回 null */
async function getText(url, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 4000 * attempt));
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return await res.text();
      if (res.status < 500 && res.status !== 429) return null;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('request failed');
}

/** RSS 元素取值：兼容 CDATA 与纯文本两种写法 */
function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

/**
 * HTML → 纯文本（去脚本/样式/标签，还原常见实体，压缩空白）。
 *
 * 实体还原顺序很关键：`&nbsp;` 与 `&#160;` 先转成普通空格再压缩，避免 "federal&nbsp;funds"
 * 这类写法把关键短语粘连成 "federalfunds" 导致匹配失效。数值/区间端点里出现的
 * 连字符实体（"3&#45;3/4"）同样先还原再交给正则。
 */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&ndash;|&mdash;/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 英文分数写法的百分数 → 十进制小数（"3-3/4" → 3.75，"4" → 4，"3-1/2" → 3.5）
 * @returns {number|null}
 */
export function parseFractionPercent(token) {
  if (token == null) return null;
  const t = String(token).trim();
  const m = t.match(/^(\d+)(?:-(\d+)\/(\d+))?$/);
  if (!m) return null;
  const whole = parseInt(m[1], 10);
  if (!m[2]) return whole;
  const num = parseInt(m[2], 10);
  const den = parseInt(m[3], 10);
  if (!den) return null;
  return whole + num / den;
}

/** 决议日次一工作日（与 DFEDTARU 生效口径一致）；周五决议 → 下周一，周末顺延 */
export function nextBusinessDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/**
 * 'YYYY-MM-DD' —— 把 RFC822 pubDate 转成美东日历日（决议措辞用 ET 记日期）。
 * 注意不能用 Intl 'en-CA'：在部分 Node/ICU 组合下 en-CA 输出 '9/16/2026' 而非 ISO
 * （实测本机 Node 25 如此），会让日期比较全部失真——手动拼装，不依赖 locale 格式。
 */
export function etDateOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * 从 FOMC 声明正文解析决议结果。
 * 命中句式（2023 年以来稳定，含 2026-07/09 两份实测）：
 *   "The Committee decided to raise|lower|maintain the target range for the federal funds rate
 *    [by 1/4 percentage point] to 3-3/4 to 4 percent | at 3-1/2 to 3-3/4 percent"
 * @param {string} html - 声明页 HTML（或纯文本）
 * @param {string} statementDate - 声明发布日 'YYYY-MM-DD'（ET）
 * @returns {{action:'raise'|'lower'|'maintain', lower:number, upper:number,
 *            decisionDate:string, effectiveDate:string, stepBp:number}|null}
 */
export function parseFomcStatement(html, statementDate) {
  const text = htmlToText(html);
  const m = text.match(FOMC_RE);
  if (!m) return null;
  const action = m[1].toLowerCase();
  const lower = parseFractionPercent(m[2]);
  const upper = parseFractionPercent(m[3]);
  if (lower === null || upper === null || upper < lower || upper - lower <= 0) return null;
  return {
    action,
    lower,
    upper,
    decisionDate: statementDate,
    // 台阶生效日：与 DFEDTARU 口径一致（决议次一工作日）；按兵不动则无台阶，取决议日
    effectiveDate: action === 'maintain' ? statementDate : nextBusinessDay(statementDate),
    // 声明本身只给"决定"的措辞，真实幅度由区间端点差值给出（25bp/50bp/或按兵不动的0），
    // 调用方再与 FRED 上一档对比确认（见 applyFedDecisionOverride 的 stepBp 推导）
    rangeWidthBp: Math.round((upper - lower) * 100),
  };
}

/**
 * 拉取 Fed 货币政策 RSS（已按 pubDate 降序返回）并解析出条目
 * @returns {Promise<Array<{title:string, link:string, pubDate:string, date:string}>>}
 */
export async function fetchFedMonetaryItems() {
  const xml = await getText(RSS_URL);
  if (!xml) return [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  return items.map(it => {
    const pubDate = tagText(it, 'pubDate');
    return {
      title: tagText(it, 'title') || '',
      link: tagText(it, 'link') || '',
      pubDate,
      date: pubDate ? etDateOf(pubDate) : null,
    };
  }).filter(it => it.link && it.date);
}

/**
 * 取最近一次 FOMC 声明（含决议结果）。
 * 只认标题为 "Federal Reserve issues FOMC statement" 且链接为 /pressreleases/monetary*a.htm
 * 的条目——同日还会发布经济预测摘要（monetary...b.htm）与会议纪要，标题不同不会误取。
 * @param {{items?:Array, fetchHtml?:Function, today:string, windowDays?:number}} opts
 * @returns {Promise<object|null>} parseFomcStatement 的结果（含 link），或 null
 */
export async function fetchLatestFedDecision({ items, fetchHtml, today, windowDays = 10 } = {}) {
  try {
    const list = items || await fetchFedMonetaryItems();
    const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - windowDays * 86400000)
      .toISOString().slice(0, 10);
    const candidate = list.find(it =>
      /^Federal Reserve issues FOMC statement$/i.test(it.title)
      && /\/pressreleases\/monetary\d{8}a\.htm$/i.test(it.link)
      && it.date <= today && it.date >= cutoff
    );
    if (!candidate) return null;
    const html = fetchHtml ? await fetchHtml(candidate.link) : await getText(candidate.link);
    if (!html) return null;
    const parsed = parseFomcStatement(html, candidate.date);
    if (!parsed) return null;
    return { ...parsed, link: candidate.link, pubDate: candidate.pubDate };
  } catch (err) {
    console.warn('[fetch-fed-rate] Fed statement fetch failed (falling back to FRED):', err.message);
    return null;
  }
}
