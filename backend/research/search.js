// 研究检索（129号阶段2）：关键词 BM25（进程内倒排索引）+ 元数据过滤。
// 选型：sql.js 内置 FTS4（无 FTS5，实测），没有 bm25() 排序，单次查询带 JOIN 约 600ms；
// 7.9K 块的规模下，JS 内存倒排索引构建约 1 秒、单查毫秒级，且排序可控、可测。
// 中文问题先经 query.js 归一成"英文检索词 + 过滤条件"，这里只处理英文。
import { all } from './db.js';

const STOP = new Set(('a an and are as at be by for from has have in is it its of on or that the this to was were will with '
  + 'our we us you your which what how much many did does do than then also into over such per other these those their '
  + 'compared year years quarter quarters ended ending three six nine twelve months month period fiscal').split(' '));

/** 轻量词干：去复数/动词后缀（porter 的子集，够财报英文用；"revenues"→"revenue"、"expenditures"→"expenditure"） */
export function stem(w) {
  if (w.length <= 4 || /\d/.test(w)) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 6) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 5) return w.slice(0, -2);
  return w;
}

export function tokenize(text) {
  const out = [];
  for (const m of String(text).toLowerCase().matchAll(/[a-z][a-z0-9&'-]*|\d+(?:\.\d+)?/g)) {
    const w = m[0].replace(/'s$|'/g, '');
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

const K1 = 1.2;
const B = 0.75;

/**
 * 构建索引（纯函数，输入块数组）。postings: term → Int32Array 交替存 [docIdx, tf, ...]
 */
export function buildIndex(docs) {
  const lists = new Map();
  const lens = new Float32Array(docs.length);
  let total = 0;
  docs.forEach((d, i) => {
    const toks = tokenize(d.text);
    lens[i] = toks.length;
    total += toks.length;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, n] of tf) {
      let l = lists.get(t);
      if (!l) lists.set(t, (l = []));
      l.push(i, n);
    }
  });
  const postings = new Map();
  for (const [t, l] of lists) postings.set(t, Int32Array.from(l));
  return { docs, postings, lens, avgLen: total / Math.max(1, docs.length) };
}

/**
 * BM25 检索。filter(doc) 为 false 的块不参与排序；boost(doc) 返回乘数（如话题标签命中加权）。
 * 查询词去重；短语（"capital expenditure"）以相邻词组形式出现在 terms 里，按单词计分。
 */
export function searchIndex(index, query, { k = 5, filter, boost } = {}) {
  const terms = [...new Set(tokenize(query))];
  const N = index.docs.length;
  const scores = new Map();
  for (const t of terms) {
    const p = index.postings.get(t);
    if (!p) continue;
    const df = p.length / 2;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (let j = 0; j < p.length; j += 2) {
      const i = p[j];
      const tf = p[j + 1];
      const s = idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * index.lens[i] / index.avgLen));
      scores.set(i, (scores.get(i) || 0) + s);
    }
  }
  const hits = [];
  for (const [i, s] of scores) {
    const d = index.docs[i];
    if (filter && !filter(d)) continue;
    hits.push({ doc: d, score: s * (boost ? boost(d) : 1) });
  }
  hits.sort((a, b) => b.score - a.score || a.doc.id - b.doc.id); // 同分按 id，结果可复现
  return hits.slice(0, k);
}

// ---- 进程内单例：首次检索时从 research.db 构建，新申报入库后 invalidate ----
let cached = null;

export function invalidateSearchIndex() {
  cached = null;
}

function loadIndex() {
  if (cached) return cached;
  const docs = all(`SELECT c.id, c.accession, c.ticker, c.form_type, c.filing_date, c.period_end, c.section, c.item,
                           c.char_start, c.char_end, c.topics, c.source_url, c.text, f.fiscal_year, f.fiscal_quarter, f.document
                    FROM chunks c JOIN filings f USING(accession)`);
  cached = buildIndex(docs);
  return cached;
}

/**
 * 对外检索接口。filters: { tickers?, fiscalYear?, fiscalQuarter?, sections?, topics? }
 * topics 不做硬过滤（标签是正则打的，会漏），只给命中块 1.5 倍加权。
 * 返回块的出处字段，正文截断为 snippet（调用方需要全文时按 char 区间读缓存）。
 */
export function search(query, filters = {}, k = 5) {
  const index = loadIndex();
  const tickers = filters.tickers?.length ? new Set(filters.tickers) : null;
  const sections = filters.sections?.length ? new Set(filters.sections) : null;
  const filter = d => (!tickers || tickers.has(d.ticker))
    && (filters.fiscalYear == null || d.fiscal_year === filters.fiscalYear)
    && (filters.fiscalQuarter == null || d.fiscal_quarter === filters.fiscalQuarter)
    && (!sections || sections.has(d.section));
  const topics = filters.topics || [];
  const boost = topics.length ? d => (topics.some(t => d.topics.includes(t)) ? 1.5 : 1) : undefined;
  return searchIndex(index, query, { k, filter, boost }).map(({ doc, score }) => ({
    score: Math.round(score * 1000) / 1000,
    chunkId: doc.id,
    ticker: doc.ticker,
    formType: doc.form_type,
    fiscalLabel: `FY${doc.fiscal_year}Q${doc.fiscal_quarter}`,
    periodEnd: doc.period_end,
    filingDate: doc.filing_date,
    accession: doc.accession,
    section: doc.section,
    charStart: doc.char_start,
    charEnd: doc.char_end,
    sourceUrl: doc.source_url,
    text: doc.text,
  }));
}
