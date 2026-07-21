// capex 指引自动检测（2026-07-21 用户拍板"优先自动获取，减少人工干预"）：
// 每日 cron 检查四大云厂商的新 8-K 业绩发布（item 2.02）→ 拉 EX-99 新闻稿 →
// 截取 capex 相关段落 → LLM 判断是否含前瞻指引及方向 → 存档供前端参考展示；
// 判定为"明确下修"(cut/high) 时自动录入 N3 事件（capex_guidance）并邮件通知订阅用户。
//
// 已知局限（诚实声明）：新闻稿是唯一免费结构化源（FMP transcript 付费）。META 通常在新闻稿
// 给全年 capex 指引；GOOGL/MSFT/AMZN 多在电话会口头给（新闻稿检测不到）——检测结果为
// none 不代表"没有指引"，只代表"新闻稿中未给出"。电话会口头下修仍需人工录入兜底。
import axios from 'axios';
import chainCfg from '../config/ai-chain.config.js';
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

/**
 * LLM 判断段落是否含前瞻 capex 指引；失败/无 key 返回 null（增值功能不砸主链路）
 * @returns {{hasGuidance, direction: 'raise'|'maintain'|'cut'|'none', quote, confidence}|null}
 */
export async function analyzeGuidance(symbol, paragraphs) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || !paragraphs) return null;
  try {
    const res = await axios.post(OPENROUTER_CHAT_URL, {
      model: GUIDANCE_MODEL(),
      messages: [
        { role: 'system', content: '你是严谨的财报分析师。只依据给定文本判断，不推测文本之外的内容。输出严格的JSON。' },
        { role: 'user', content: `以下是 ${symbol} 财报新闻稿中与资本开支(capex)相关的段落。判断其中是否包含**前瞻性**的资本开支指引（对未来季度/年度capex的预期表述，历史数字和自由现金流定义不算）。\n\n${paragraphs}\n\n输出JSON（无其他文字）：{"hasGuidance": bool, "direction": "raise"|"maintain"|"cut"|"none", "quote": "指引原文英文摘录(无指引则空串)", "confidence": "high"|"low"}。direction判断标准：明确高于此前指引或大幅同比增长计划=raise；重申此前水平=maintain；明确低于此前指引或表述将削减/放缓=cut；无前瞻指引=none。` },
      ],
      temperature: 0,
      // 必设：不设时 OpenRouter 按模型最大值(65536)预扣余额，免费额度账户直接 402
      max_tokens: 500,
    }, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 60000 });
    const text = res.data?.choices?.[0]?.message?.content || '';
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e < 0) return null;
    const j = JSON.parse(text.slice(s, e + 1));
    if (!['raise', 'maintain', 'cut', 'none'].includes(j.direction)) return null;
    return j;
  } catch (err) {
    console.warn(`[guidance] LLM analyze(${symbol}) failed:`, err.message);
    return null;
  }
}

/**
 * 主入口（每日 cron 调用）：检测→分析→存档；明确下修自动录入 N3 + 邮件。
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
    };
    try {
      const text = await fetchPressReleaseText(f.cik, f.accession);
      const paragraphs = extractCapexParagraphs(text);
      const analysis = paragraphs ? await analyzeGuidance(f.symbol, paragraphs) : null;
      if (analysis?.hasGuidance) {
        record.direction = analysis.direction;
        record.quote = (analysis.quote || '').slice(0, 500);
        record.confidence = analysis.confidence;
      }

      // 明确下修 + 高置信 → 自动录入 N3（幂等：已有活动事件不重复录）
      if (analysis?.direction === 'cut' && analysis.confidence === 'high') {
        const existing = await getActiveAdminSignal('capex_guidance');
        if (!existing) {
          const expires = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
          const note = `[自动检测] ${f.symbol} ${f.filingDate} 业绩新闻稿：${record.quote || 'capex指引下修'}`;
          await setAdminSignal('capex_guidance', 'tight', expires, note, 'auto-detector');
          record.autoEventCreated = 1;
          autoEvents++;
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
          console.log(`[guidance] AUTO N3 EVENT: ${f.symbol} capex guidance cut detected → capex_guidance recorded + alerts sent`);
        }
      }
    } catch (err) {
      console.warn(`[guidance] process(${f.symbol} ${f.accession}) failed:`, err.message);
    }
    await saveGuidanceRecord(record).catch(err => console.warn('[guidance] save failed:', err.message));
    console.log(`[guidance] ${f.symbol} ${f.filingDate}: direction=${record.direction}${record.confidence ? '/' + record.confidence : ''}`);
  }
  return { checked: filings.length, autoEvents };
}
