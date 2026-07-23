// capex 指引自动检测（2026-07-21 用户拍板"优先自动获取，减少人工干预"）：
// 每日 cron 检查四大云厂商的新 8-K 业绩发布（item 2.02）→ 拉 EX-99 新闻稿 →
// 截取 capex 相关段落 → LLM 判断是否含前瞻指引及方向 → 存档供前端参考展示；
// 判定为"明确下修"(cut/high) 时自动录入 N3 事件（capex_guidance）并邮件通知订阅用户。
//
// 2026-07-23 补源（113号，GOOGL Q2实证新闻稿单源不够）：GOOGL/MSFT/AMZN 惯例在
// 电话会口头给指引，新闻稿检测不到 → 每次财报同时用 OpenRouter web 插件检索
// 电话会实录/PPT/主流财经媒体报道（与新闻稿同等高度的必需源，2026-07-23 用户拍板），
// 补齐 fy_guidance/forward_guidance/来源URL；任一源失败即不落档、窗口内重试。
// 同时生成单公司财报快报：单季 capex 及同比、TTM capex 及同比（EDGAR 历史序列 +
// 新季度值，FMP 优先、新闻稿 LLM 提取兜底）。
//
// N3 自动录入（2026-07-23 用户拍板放开 web 源）：新闻稿 cut/high，或 web 源 cut/high
// 且有佐证——管理层原话（实录/PPT/公告）或 ≥2 个独立来源方向一致。佐证门槛防的是
// 单条媒体标题党/LLM幻觉误触发全员减仓邮件（误报下修的代价不对称）；
// 未达佐证门槛的 web 下修只醒目日志+展示，请人工核实。
import axios from 'axios';
import chainCfg from '../config/ai-chain.config.js';
import {
  fetchCapexSeriesForSymbol,
  fetchCapexFromFmp,
  quarterKey,
  shiftQuarterKey,
} from './fetch-ai-chain.js';
import {
  getProcessedGuidanceAccessions,
  saveGuidanceRecord,
  setAdminSignal,
  getActiveAdminSignal,
  getAlertSubscribers,
} from '../utils/storage.js';
import { sendSignalAlert } from '../utils/mailer.js';

const EDGAR_HEADERS = {
  'User-Agent': 'StockSentinel admin@stocksentinel.app',
  'Accept-Encoding': 'gzip, deflate',
};
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GUIDANCE_MODEL = () => process.env.AI_REPORT_MODEL || 'deepseek/deepseek-chat-v3-0324';
const LOOKBACK_DAYS = 10; // 只看最近10天的申报（每日跑，窗口重叠防漏）

// web 检索用公司全名（裸 ticker 检索命中率低）
const COMPANY_NAMES = { MSFT: 'Microsoft', AMZN: 'Amazon', GOOGL: 'Alphabet (Google)', META: 'Meta Platforms' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 四家最近的业绩 8-K（item 2.02），过滤已处理的 accession */
export async function findNewEarningsFilings(processedAccessions) {
  const out = [];
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  for (const [symbol, { cik }] of Object.entries(chainCfg.HYPERSCALER_CIK)) {
    try {
      const res = await axios.get(
        `https://data.sec.gov/submissions/CIK${cik}.json`,
        { headers: EDGAR_HEADERS, timeout: 20000 }
      );
      const r = res.data.filings.recent;
      for (let i = 0; i < r.form.length; i++) {
        if (r.filingDate[i] < since) break; // recent 按日期降序，越界即止
        if (r.form[i] !== '8-K' || !(r.items[i] || '').includes('2.02')) continue;
        if (processedAccessions.has(r.accessionNumber[i])) continue;
        out.push({ symbol, cik, accession: r.accessionNumber[i], filingDate: r.filingDate[i] });
      }
    } catch (err) {
      console.warn(`[guidance] submissions(${symbol}) failed:`, err.message);
    }
    await sleep(150);
  }
  return out;
}

/** 拉 8-K 的 EX-99 新闻稿正文（去 HTML 标签）；找不到 exhibit 返回 null */
export async function fetchPressReleaseText(cik, accession) {
  const acc = accession.replace(/-/g, '');
  const cikNum = String(Number(cik)); // 目录路径用无前导零
  const idx = await axios.get(
    `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/index.json`,
    { headers: EDGAR_HEADERS, timeout: 20000 }
  );
  const files = (idx.data.directory?.item || []).map(x => x.name).filter(n => n.endsWith('.htm'));
  // EX-99 命名各家不一（googexhibit991/ex99x1/pressrelease...），匹配常见模式
  const ex99 = files.find(n => /ex.{0,3}99|exhibit.?99|press/i.test(n));
  if (!ex99) return null;
  const doc = await axios.get(
    `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${ex99}`,
    { headers: EDGAR_HEADERS, timeout: 30000 }
  );
  return String(doc.data)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#58;/g, ' ')
    .replace(/\s+/g, ' ');
}

/** 截取 capex 相关段落（关键词 ±600 字符，合并去重），无相关内容返回 null */
export function extractCapexParagraphs(text, maxLen = 4000) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const spans = [];
  for (const kw of ['capital expenditure', 'capex']) {
    let i = lower.indexOf(kw);
    while (i >= 0) {
      spans.push([Math.max(0, i - 600), Math.min(text.length, i + 600)]);
      i = lower.indexOf(kw, i + 1);
    }
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [spans[0]];
  for (const [s, e] of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.map(([s, e]) => text.slice(s, e)).join('\n...\n').slice(0, maxLen);
}

// LLM 回复 → JSON（截取首尾大括号，方向不合法返回 null）
function parseGuidanceJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  try {
    const j = JSON.parse(text.slice(s, e + 1));
    if (!['raise', 'maintain', 'cut', 'none'].includes(j.direction)) return null;
    return j;
  } catch {
    return null;
  }
}

/**
 * LLM 判断新闻稿段落是否含前瞻 capex 指引；失败/无 key 返回 null（增值功能不砸主链路）
 * @returns {{hasGuidance, direction: 'raise'|'maintain'|'cut'|'none', quote, confidence,
 *            fyGuidance, forwardGuidance, qtrCapexUsdMillions}|null}
 */
export async function analyzeGuidance(symbol, paragraphs) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || !paragraphs) return null;
  try {
    const res = await axios.post(OPENROUTER_CHAT_URL, {
      model: GUIDANCE_MODEL(),
      messages: [
        { role: 'system', content: '你是严谨的财报分析师。只依据给定文本判断，不推测文本之外的内容。输出严格的JSON。' },
        { role: 'user', content: `以下是 ${symbol} 财报新闻稿中与资本开支(capex)相关的段落。判断其中是否包含**前瞻性**的资本开支指引（对未来季度/年度capex的预期表述，历史数字和自由现金流定义不算），并提取本次财报季度的实际capex数值（现金流量表中 purchases of property and equipment，取最近一个完整季度的单季值，注意表格可能并列多个季度——取最新季）。\n\n${paragraphs}\n\n输出JSON（无其他文字）：{"hasGuidance": bool, "direction": "raise"|"maintain"|"cut"|"none", "quote": "指引原文英文摘录(无指引则空串)", "confidence": "high"|"low", "fyGuidance": "本财年capex指引摘要(如'FY2026 $72B'，无则空串)", "forwardGuidance": "对之后年度capex的表述摘要(无则空串)", "qtrCapexUsdMillions": 最新单季capex数值(百万美元,正数;文本中无法确定则null)}。direction判断标准：明确高于此前指引或大幅同比增长计划=raise；重申此前水平=maintain；明确低于此前指引或表述将削减/放缓=cut；无前瞻指引=none。` },
      ],
      temperature: 0,
      // 必设：不设时 OpenRouter 按模型最大值(65536)预扣余额，免费额度账户直接 402
      max_tokens: 600,
    }, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 60000 });
    return parseGuidanceJson(res.data?.choices?.[0]?.message?.content || '');
  } catch (err) {
    console.warn(`[guidance] LLM analyze(${symbol}) failed:`, err.message);
    return null;
  }
}

/**
 * web 检索源（113号补源，2026-07-23 拍板升级为与新闻稿同等高度的必需源）：
 * 用 OpenRouter web 插件检索财报电话会实录/官方PPT/主流财经媒体报道
 * （CNBC/Reuters/Bloomberg等），判定 capex 指引方向并提取本财年/未来指引与来源URL。
 * 每次财报都调用（补齐新闻稿缺失字段）。失败/无 key 返回 null（调用方"不落档、窗口内重试"）。
 * @returns {{hasGuidance, direction, quote, confidence, fyGuidance, forwardGuidance,
 *            sources: string[], primarySource: bool}|null}
 */
export async function analyzeGuidanceFromWeb(symbol, filingDate) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const company = COMPANY_NAMES[symbol] || symbol;
  try {
    const res = await axios.post(OPENROUTER_CHAT_URL, {
      model: GUIDANCE_MODEL(),
      // OpenRouter web 插件：自动检索并把结果注入上下文，回答须给出可核查来源
      plugins: [{ id: 'web', max_results: 5 }],
      messages: [
        { role: 'system', content: '你是严谨的财报分析师。只依据检索到的可靠来源（财报电话会实录、CNBC/Reuters/Bloomberg等主流财经媒体）作答，找不到依据就如实说没有，绝不编造数字。输出严格的JSON。' },
        { role: 'user', content: `${company} (${symbol}) 于 ${filingDate} 前后发布了季度财报。请检索其财报电话会与媒体报道，判断管理层本次是否给出了**前瞻性**资本开支(capex)指引：本财年全年 capex 预期金额/区间、与此前指引相比的方向（上修/维持/下修）、以及对未来年度 capex 的表述。\n\n输出JSON（无其他文字）：{"hasGuidance": bool, "direction": "raise"|"maintain"|"cut"|"none", "quote": "管理层原话或媒体转述的英文摘录(无则空串)", "confidence": "high"|"low", "fyGuidance": "本财年capex指引摘要(如'FY2026 $195-205B, raised from $185B'，无则空串)", "forwardGuidance": "对之后年度capex的表述摘要(无则空串)", "sources": ["来源URL", ...], "primarySource": bool}。direction判断标准：明确高于此前指引=raise；重申此前水平=maintain；明确低于此前指引或将削减/放缓=cut；检索不到指引信息=none。confidence：多个可靠来源相互印证且有具体数字=high，否则=low。primarySource：quote 是否来自公司财报电话会实录/官方PPT/新闻公告等一手来源（管理层原话），而非仅媒体转述解读=true，否则=false。` },
      ],
      temperature: 0,
      max_tokens: 800,
    }, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 120000 });
    const j = parseGuidanceJson(res.data?.choices?.[0]?.message?.content || '');
    if (!j) return null;
    j.sources = Array.isArray(j.sources) ? j.sources.filter(u => typeof u === 'string').slice(0, 5) : [];
    j.primarySource = j.primarySource === true;
    return j;
  } catch (err) {
    console.warn(`[guidance] web analyze(${symbol}) failed:`, err.message);
    return null;
  }
}

/**
 * web 源下修是否达到 N3 自动录入的佐证门槛（2026-07-23 用户拍板放开 web 源自动录入）：
 * cut + 高置信，且（管理层原话一手来源 或 ≥2 个独立来源方向一致）。
 * 佐证门槛防单条媒体标题党/LLM幻觉——误报下修=全员减仓邮件，代价不对称，只对 cut 设防。
 */
export function webCutQualified(web) {
  return !!web && web.hasGuidance === true && web.direction === 'cut' && web.confidence === 'high'
    && (web.primarySource === true || (web.sources || []).length >= 2);
}

/** 申报日前最近一个已结束的日历季度末（四大家季度末都是日历季）：'2026-07-22' → '2026-06-30' */
export function latestCompletedQuarterEnd(filingDate) {
  const [y, m] = filingDate.split('-').map(Number);
  const q = Math.ceil(m / 3) - 1; // 上一个日历季（1季度申报的是去年4季）
  if (q === 0) return `${y - 1}-12-31`;
  return `${y}-${['03-31', '06-30', '09-30'][q - 1]}`;
}

/**
 * 单公司财报快报统计（纯函数）：EDGAR 历史序列 + 新季度值 → 单季/TTM 额度与同比。
 * newQtr 为 null 时按 EDGAR 已有最新季计算（qtrEnd 如实标注是哪一季）。
 * 缺任一对比期 → 对应字段 null，绝不拿错季凑数。
 * @param {Array<{date, capitalExpenditure}>|null} edgarQuarters - 降序
 * @param {{date, value}|null} newQtr - 新季度（value 为正数 USD）
 * @returns {{qtrEnd, qtrCapex, qtrCapexYoY, ttmCapex, ttmCapexYoY}}
 */
export function computeCapexStats(edgarQuarters, newQtr) {
  const NULL_STATS = { qtrEnd: null, qtrCapex: null, qtrCapexYoY: null, ttmCapex: null, ttmCapexYoY: null };
  const byBucket = new Map();
  for (const q of edgarQuarters || []) {
    const v = Math.abs(parseFloat(q.capitalExpenditure));
    if (isNaN(v)) continue;
    const key = quarterKey(q.date);
    if (!byBucket.has(key)) byBucket.set(key, { date: q.date, value: v }); // 降序首个为准
  }
  if (newQtr?.value > 0) {
    // 新季值只增不改：EDGAR 已有该季（10-Q 已出）时以官方 XBRL 为准
    const key = quarterKey(newQtr.date);
    if (!byBucket.has(key)) byBucket.set(key, { date: newQtr.date, value: newQtr.value });
  }
  if (!byBucket.size) return NULL_STATS;

  const latestKey = [...byBucket.keys()].sort().pop();
  const latest = byBucket.get(latestKey);
  const at = n => byBucket.get(shiftQuarterKey(latestKey, n))?.value ?? null;

  const prevYearQtr = at(-4);
  // TTM：最新4个连续季桶；上年TTM：再前4桶。任一缺失 → null
  const sumRange = (from, to) => {
    let s = 0;
    for (let n = from; n <= to; n++) {
      const v = at(n);
      if (v == null) return null;
      s += v;
    }
    return s;
  };
  const ttm = sumRange(-3, 0);
  const prevTtm = sumRange(-7, -4);
  return {
    qtrEnd: latest.date,
    qtrCapex: latest.value,
    qtrCapexYoY: prevYearQtr ? (latest.value / prevYearQtr - 1) * 100 : null,
    ttmCapex: ttm,
    ttmCapexYoY: ttm != null && prevTtm ? (ttm / prevTtm - 1) * 100 : null,
  };
}

/**
 * 财报后单公司 capex 快报：EDGAR 历史序列 + 新季度值（FMP 优先，新闻稿 LLM 提取兜底）。
 * LLM 值须过理智带（与去年同季比 [0.2x, 5x]，防表格取错列/幻觉）；FMP 为结构化源直接信任。
 * 任何一步失败只降级为 null 字段，不 throw（快报是展示增值，不砸指引主链路）。
 */
export async function buildCapexSnapshot(symbol, filingDate, llmQtrUsdMillions) {
  let edgar = null;
  try {
    edgar = await fetchCapexSeriesForSymbol(symbol);
  } catch (err) {
    console.warn(`[guidance] capex series(${symbol}) failed:`, err.message);
  }
  const expectedEnd = latestCompletedQuarterEnd(filingDate);
  const expectedKey = quarterKey(expectedEnd);
  const edgarHasIt = (edgar || []).some(q => quarterKey(q.date) === expectedKey);

  let newQtr = null;
  if (!edgarHasIt) {
    // FMP 通常财报后数小时内更新现金流量表，是新季值的首选结构化源
    const fmp = await fetchCapexFromFmp(symbol).catch(() => null);
    const hit = (fmp || []).find(q => quarterKey(q.date) === expectedKey);
    if (hit) {
      newQtr = { date: hit.date, value: Math.abs(hit.capitalExpenditure) };
    } else if (llmQtrUsdMillions > 0) {
      const value = llmQtrUsdMillions * 1e6;
      const prevYear = (edgar || []).find(q => quarterKey(q.date) === shiftQuarterKey(expectedKey, -4));
      const ratio = prevYear ? value / Math.abs(parseFloat(prevYear.capitalExpenditure)) : null;
      if (ratio != null && ratio >= 0.2 && ratio <= 5) {
        newQtr = { date: expectedEnd, value };
      } else {
        console.warn(`[guidance] ${symbol} LLM qtr capex ${llmQtrUsdMillions}M rejected (yoy ratio ${ratio == null ? 'no anchor' : ratio.toFixed(2)})`);
      }
    }
  }
  return computeCapexStats(edgar, newQtr);
}

/**
 * 录入 N3 收紧事件 + 订阅用户邮件（幂等：已有活动事件返回 false 不重复录）。
 * origin 写明来源（新闻稿/电话会检索+URL），供横幅与档案核查。
 */
async function createN3Event(f, quote, origin) {
  const existing = await getActiveAdminSignal('capex_guidance');
  if (existing) return false;
  const expires = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const note = `[自动检测] ${f.symbol} ${f.filingDate} ${origin}：${quote || 'capex指引下修'}`;
  await setAdminSignal('capex_guidance', 'tight', expires, note, 'auto-detector');
  try {
    const subscribers = await getAlertSubscribers();
    if (subscribers.length) {
      await sendSignalAlert(subscribers, {
        finalSignal: 'reduce',
        changes: [{ kind: 'capexGuidance', note }],
        details: {},
      });
    }
  } catch (err) {
    console.warn('[guidance] auto-event alert email failed:', err.message);
  }
  console.log(`[guidance] AUTO N3 EVENT: ${f.symbol} capex guidance cut (${origin}) → capex_guidance recorded + alerts sent`);
  return true;
}

/**
 * 主入口（每日 cron 调用）：检测→分析（新闻稿+web检索双源，互相补齐）→单公司快报→存档；
 * "明确下修+高置信"（新闻稿源，或 web 源达佐证门槛）自动录入 N3 + 邮件。
 * 全程容错不 throw。非财报季无新 8-K，开销仅为 4 次 submissions 查询。
 */
export async function processCapexGuidance() {
  const processed = await getProcessedGuidanceAccessions();
  const filings = await findNewEarningsFilings(new Set(processed));
  if (!filings.length) return { checked: 0 };

  let autoEvents = 0;
  for (const f of filings) {
    let record = {
      symbol: f.symbol, filingDate: f.filingDate, accession: f.accession,
      direction: 'none', quote: null, confidence: null, autoEventCreated: 0,
      source: null, fyGuidance: null, forwardGuidance: null, sources: null,
      qtrEnd: null, qtrCapex: null, qtrCapexYoY: null, ttmCapex: null, ttmCapexYoY: null,
    };
    // 抓取/LLM/web 任一失败时不存档也不标已处理——否则该财报被永久跳过，档案定格为
    // 不完整的结果（实测 2026-07-23：OpenRouter 余额耗尽 402 会走到这里；10天窗口内每日重试）。
    // N3 录入不受重试影响：新闻稿检出下修即刻录入，不等 web 补齐（防守动作不过夜；
    // 重试日因活动事件已存在而幂等跳过，档案 autoEventCreated 可能为 0 属可接受的展示误差）
    let retryNextRun = false;
    try {
      const text = await fetchPressReleaseText(f.cik, f.accession);
      const paragraphs = extractCapexParagraphs(text);
      const analysis = paragraphs ? await analyzeGuidance(f.symbol, paragraphs) : null;
      if (paragraphs && !analysis) retryNextRun = true;

      if (analysis?.hasGuidance) {
        record.direction = analysis.direction;
        record.quote = (analysis.quote || '').slice(0, 500);
        record.confidence = analysis.confidence;
        record.source = 'press_release';
        record.fyGuidance = (analysis.fyGuidance || '').slice(0, 300) || null;
        record.forwardGuidance = (analysis.forwardGuidance || '').slice(0, 300) || null;
      }
      // 新闻稿源明确下修+高置信 → 立即录 N3（不等 web，防守动作优先于字段补齐）
      const pressCut = analysis?.direction === 'cut' && analysis.confidence === 'high';
      if (pressCut && await createN3Event(f, record.quote, '业绩新闻稿')) {
        record.autoEventCreated = 1;
        autoEvents++;
      }

      // web 检索与新闻稿同等高度（每次财报都跑）：新闻稿没给的字段由电话会/PPT/媒体补齐
      let web = null;
      if (!retryNextRun) {
        web = await analyzeGuidanceFromWeb(f.symbol, f.filingDate);
        if (!web) retryNextRun = true;
      }

      if (!retryNextRun) {
        // 方向归集：新闻稿（公司原文）优先；web 补位。特例：web 达佐证门槛的下修
        // 覆盖新闻稿的非下修方向——电话会披露了新闻稿未提的下修正是本补源要抓的场景
        const webCut = webCutQualified(web);
        if (web.hasGuidance && (!analysis?.hasGuidance || (webCut && record.direction !== 'cut'))) {
          record.direction = web.direction;
          record.quote = (web.quote || '').slice(0, 500);
          record.confidence = web.confidence;
          record.source = 'web';
        }
        if (web.hasGuidance) {
          // 字段补齐：新闻稿缺什么补什么（两源都有时保留新闻稿口径）
          record.fyGuidance = record.fyGuidance || (web.fyGuidance || '').slice(0, 300) || null;
          record.forwardGuidance = record.forwardGuidance || (web.forwardGuidance || '').slice(0, 300) || null;
        }
        record.sources = web.sources.length ? JSON.stringify(web.sources).slice(0, 1000) : null;
        if (!analysis?.hasGuidance && !web.hasGuidance) {
          record.source = 'web'; // none + source=web：新闻稿和网络检索都未见指引（强否定）
        }

        // web 源达佐证门槛的下修 → 录 N3（2026-07-23 用户拍板放开；createN3Event 幂等去重）
        if (webCut && !pressCut) {
          const origin = `电话会/媒体检索(${web.sources.slice(0, 2).join('; ') || '来源见档案'})`;
          if (await createN3Event(f, record.quote, origin)) {
            record.autoEventCreated = 1;
            autoEvents++;
          }
        } else if (!pressCut && web.hasGuidance && web.direction === 'cut') {
          // 未达佐证门槛的 web 下修（单一媒体转述/低置信）：只醒目提示，请人工核实
          console.warn(`[guidance] ⚠️ WEB-DETECTED CUT (未达佐证门槛): ${f.symbol} ${f.filingDate} capex指引疑似下修——confidence=${web.confidence}, primarySource=${web.primarySource}, sources=${web.sources.length}。请人工核实后在管理面板录入 N3 事件。quote: ${record.quote}`);
        }
      }

      // 单公司财报快报（展示增值，失败只留 null 不重试——常规 XBRL 汇总链路照常兜底）
      if (!retryNextRun) {
        const snap = await buildCapexSnapshot(f.symbol, f.filingDate, analysis?.qtrCapexUsdMillions ?? null);
        Object.assign(record, {
          qtrEnd: snap.qtrEnd, qtrCapex: snap.qtrCapex, qtrCapexYoY: snap.qtrCapexYoY,
          ttmCapex: snap.ttmCapex, ttmCapexYoY: snap.ttmCapexYoY,
        });
      }
    } catch (err) {
      retryNextRun = true;
      console.warn(`[guidance] process(${f.symbol} ${f.accession}) failed:`, err.message);
    }
    if (retryNextRun) {
      console.warn(`[guidance] ${f.symbol} ${f.filingDate}: incomplete (fetch/LLM/web unavailable), NOT marked processed — will retry next run`);
      continue;
    }
    await saveGuidanceRecord(record).catch(err => console.warn('[guidance] save failed:', err.message));
    console.log(`[guidance] ${f.symbol} ${f.filingDate}: direction=${record.direction}${record.confidence ? '/' + record.confidence : ''}${record.source ? ' src=' + record.source : ''}${record.qtrCapex ? ` qtr=$${(record.qtrCapex / 1e9).toFixed(1)}B` : ''}`);
  }
  return { checked: filings.length, autoEvents };
}
