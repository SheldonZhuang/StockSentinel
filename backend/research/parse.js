// 申报文件 HTML → 纯文本 + 章节切分（129号，纯函数，无 IO）。
// 出处约定：char_range 指向本模块 htmlToText() 的输出（落盘为 data/filings/<accession>/<doc>.txt），
// 同一份 HTML 反复解析结果逐字节相同，所以字符区间可复现、可核对。
import { MIN_SECTION_CHARS } from '../config/research.config.js';

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: '—', ndash: '–', hellip: '…', bull: '•',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (code === 160) return ' ';
      if (code === 8217 || code === 8216) return "'";
      if (code === 8220 || code === 8221) return '"';
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * iXBRL / HTML → 纯文本：块级元素断行、表格单元格以 " | " 分隔、合并空白、去空行。
 * 去掉 ix:header（隐藏的 XBRL 上下文，正文不可见）与 script/style。
 */
export function htmlToText(html) {
  let h = String(html || '');
  h = h.replace(/<ix:header>[\s\S]*?<\/ix:header>/gi, ' ')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table|section|ul|ol|title)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  h = decodeEntities(h);
  return h.split('\n')
    .map(l => l.replace(/[ \t\r\f\v ​]+/g, ' ').replace(/(\s*\|\s*)+$/, '').replace(/^(\s*\|\s*)+/, '').trim())
    .filter(Boolean)
    .join('\n');
}

// "Item 7." / "ITEM 1A. RISK FACTORS" / "Item 5. Operating and Financial Review"
const ITEM_RE = /^item\s+(\d{1,2}[a-d]?)\s*[.:—–-]?\s*(.*)$/i;
const PART_RE = /^part\s+(i{1,3}|iv)\b/i;

// 章节标题关键词 → 规范章节名。按标题文本判定（各家 Item 编号含义随表格类型不同：
// 10-Q 的 Item 2 是 MD&A、10-K 的是 Properties，20-F 的 Item 5 是经营回顾）
const SECTION_BY_TITLE = [
  [/management'?s discussion and analysis|operating and financial review/i, 'mdna'],
  [/risk factors|key information/i, 'risk_factors'],
  [/financial statements(?! and exhibits)|financial information$/i, 'financial_statements'],
  [/quantitative and qualitative disclosures? about market risk/i, 'market_risk'],
  [/^business$|^business\b(?! combination)|information on the company/i, 'business'],
  [/legal proceedings/i, 'legal'],
  [/controls and procedures/i, 'controls'],
  [/unregistered sales|purchases of equity securities/i, 'equity'],
  [/^exhibits?\b|exhibits?,? (and )?financial statement/i, 'exhibits'],
];

function sectionForTitle(title) {
  for (const [re, name] of SECTION_BY_TITLE) if (re.test(title)) return name;
  return 'other';
}

/**
 * 定期报告（10-Q / 10-K / 20-F）按 Item 标题切章节。
 * 难点：目录（TOC）和每页页眉都会重复出现 "PART I / Item 1"——
 *   规则一：标题行必须带标题文字（"Item 2. Management's ..."），裸 "Item 2" 页眉不算；
 *   规则二：同一 Part 内连续出现的同号 Item 视为翻页页眉（MSFT 每页都印 "PART I / Item 1 / 本页小标题"），
 *           并入前一个标题，不另起章节；
 *   规则三：同一章节名出现多次时取正文最长的一段（目录段只有一行，必然最短）；
 *   规则四：财报附页（F-pages）常排在最后一个 Item（Exhibits）之后，以其后第一个审计报告标题为界，
 *           切出 financial_statements（10-K 的 Item 8 常只写"见 F 页"，20-F 的 Item 18 同理）。
 * 有些发行人把 "Item 1A." 与标题分两行写，向下看一行补标题。
 * @returns {Array<{section, item, title, start, end}>} start/end 为 text 中的字符区间
 */
export function splitSections(text, formType) {
  if (!/^(10-Q|10-K|20-F)/.test(formType)) {
    return text.length ? [{ section: 'press_release', item: null, title: null, start: 0, end: text.length }] : [];
  }
  const lines = text.split('\n');
  const heads = [];
  let off = 0;
  let part = '';
  const auditReports = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pm = line.length <= 80 && PART_RE.exec(line);
    if (pm) part = pm[1].toUpperCase();
    if (/^report of independent registered public accounting firm/i.test(line)) auditReports.push(off);
    const m = line.length <= 200 && ITEM_RE.exec(line);
    if (m) {
      // AMZN 表格式标题 "Item 1. | Business"：去掉开头的单元格分隔符
      let title = m[2].replace(/^\|\s*/, '').trim();
      // 标题另起一行只认 "Item 1." 这种带标点的写法；不带标点的 "Item 1" 是 MSFT 的翻页页眉，
      // 下一行是本页小标题（如 "Note About Forward-Looking Statements"），不能当章节标题
      const hasPunct = /^item\s+\d{1,2}[a-d]?\s*[.:—–-]/i.test(line);
      if (!title && hasPunct && lines[i + 1] && lines[i + 1].length <= 160 && !ITEM_RE.test(lines[i + 1]) && !PART_RE.test(lines[i + 1])) {
        title = lines[i + 1].trim();
      }
      // 规则一：没有标题文字、标题是页码，或是封面勾选框残片（"o Item 18 o"）的，视为页眉或目录
      if (title && /[a-z]{4}/i.test(title) && !/^\d+$/.test(title) && !/\bitem\s+\d/i.test(title)) {
        const item = m[1].toUpperCase();
        const last = heads[heads.length - 1];
        if (!(last && last.item === item && last.part === part)) {
          heads.push({ item, part, title: title.replace(/\s*\|.*$/, ''), start: off });
        }
      }
    }
    off += line.length + 1;
  }
  // 目录识别：正文的第一个标题是"同一 Part 下第二次出现的首个 Item"（第一次在目录里）。
  // 目录最后一项（如 META 的 "Item 6. Exhibits"）若不丢弃，会把目录到正文之间的整段前言吞进去
  const firstItem = heads[0];
  const bodyIdx = firstItem
    ? heads.findIndex((h, i) => i > 0 && h.item === firstItem.item && h.part === firstItem.part)
    : -1;
  const body = bodyIdx > 0 ? heads.slice(bodyIdx) : heads;
  const raw = body.map((h, i) => ({
    section: sectionForTitle(h.title),
    item: h.item,
    title: h.title,
    start: h.start,
    end: i + 1 < body.length ? body[i + 1].start : text.length,
  }));
  // 规则四：Exhibits 之后的财报附页（取 Exhibits 之后的第一个审计报告标题）
  const ex = raw.find(s => s.section === 'exhibits');
  const auditAt = ex ? auditReports.find(p => p > ex.start && p < ex.end) : undefined;
  if (auditAt !== undefined) {
    raw.push({ section: 'financial_statements', item: null, title: 'Financial statements (F-pages)', start: auditAt, end: ex.end });
    ex.end = auditAt;
  }
  // 规则三：每个章节名保留最长的一段（other 不合并，可能是不同 Item）
  const best = new Map();
  const others = [];
  for (const s of raw) {
    if (s.section === 'other') { others.push(s); continue; }
    const prev = best.get(s.section);
    if (!prev || s.end - s.start > prev.end - prev.start) best.set(s.section, s);
  }
  return [...best.values(), ...others.filter(s => s.end - s.start >= MIN_SECTION_CHARS)]
    .sort((a, b) => a.start - b.start);
}

// 主题标签：分部收入/资本开支/指引不是独立章节，而是散在 MD&A、财报附注与新闻稿里的话题。
// 在块级打标签，检索阶段按标签过滤（segment_revenue 等是题目要求的"章节"）
const TOPIC_PATTERNS = {
  segment_revenue: /\bsegment(s)?\b[^.\n]{0,120}\b(revenue|net sales|operating income)|\b(revenue|net sales)\b[^.\n]{0,80}\bby (segment|market platform|platform|product line)/i,
  capex: /capital expenditures?|purchases of property(,)? (plant )?and equipment|additions to property|capex\b|capital budget/i,
  guidance: /\b(outlook|guidance|we expect|we anticipate|expected to be (approximately|between|in the range)|for the (fourth|first|second|third) quarter of (fiscal )?\d{4}, we expect)\b/i,
};

export function tagTopics(text) {
  return Object.entries(TOPIC_PATTERNS).filter(([, re]) => re.test(text)).map(([k]) => k);
}

/**
 * 章节 → 块：按段落（\n）边界累积到 target 字符，超长单段在句号处硬切到 max 以内。
 * 块不跨章节、不重叠；返回的 start/end 是整篇 text 中的绝对字符区间，text.slice(start,end) === 块正文。
 */
export function chunkSection(text, sec, { target = 2000, max = 3000 } = {}) {
  const chunks = [];
  let cs = sec.start;
  let pos = sec.start;
  const push = (s, e) => {
    // 去掉首尾空白，保证 slice 后无空白边界
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) chunks.push({ start: s, end: e });
  };
  while (pos < sec.end) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0 || nl > sec.end) nl = sec.end;
    const paraEnd = nl;
    if (paraEnd - cs > max) {
      // 当前累积 + 本段超上限：先把之前累积的切出去
      if (pos > cs) { push(cs, pos); cs = pos; }
      // 单段仍超长：在 max 以内最后一个句末处硬切
      while (paraEnd - cs > max) {
        const window = text.slice(cs, cs + max);
        const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('; '), window.lastIndexOf(' | '));
        const at = cut > target / 2 ? cs + cut + 2 : cs + max;
        push(cs, at);
        cs = at;
      }
    }
    pos = paraEnd + 1;
    if (pos - cs >= target) { push(cs, Math.min(pos, sec.end)); cs = pos; }
  }
  if (cs < sec.end) push(cs, sec.end);
  return chunks.map((c, i) => ({ ...c, section: sec.section, seq: i }));
}
