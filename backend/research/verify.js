// 研究笔记自检（129号阶段3，纯函数）：逐条核对每个陈述的出处与数字。
// 规则（阶段0 定的硬规则）：
//   1) 每个陈述至少一个证据：metric（指标表 id）或 quote（块 id + 逐字引文）；
//   2) 引文必须逐字出现在所引的块里（容忍空白差异），并且该块属于本公司；
//   3) 陈述文字里出现的每个数字，必须出现在它引用的证据里（引文原文，或指标表该行的格式化值/变化率）——
//      LLM 不能自己写数字；
//   4) 禁止买卖建议、目标价、股价预测（扫词）。
// 不通过的陈述标 failed 并给出原因；Agent 把失败清单回喂模型重试一次，仍失败标"待人工核对"。
import { locateQuote } from './wiki.js';
import { fmt } from './metrics.js';

// 买卖建议 / 目标价 / 股价预测（中英）。研究笔记里出现即不通过
const ADVICE = /(建议(买入|卖出|增持|减持|持有)|买入评级|卖出评级|目标价|price target|\b(buy|sell|overweight|underweight|outperform|underperform) rating|\bwe recommend\b|股价(将|会)(上涨|下跌)|stock (will|should) (rise|fall))/i;

// 数字抽取：$90.0 billion / 90,007 / 17.7% / 2.46 / FY2026Q4 里的年份季度不算（是标签）
const NUM = /\d[\d,]*(?:\.\d+)?/g;
// 年份只认"像年份"的：后面不能跟小数点、千分位、量级单位、百分号或区间连字符——
// 否则"2006.1亿美元"（AMZN 营收）会被当成年份 2006 删掉、剩下 ".1"，"1970-2020亿美元"整段消失（2026-10-21 deepseek 评估轮发现）
const LABEL = /\bFY\d{4}(?:Q[1-4])?\b|(?<![\d.,$])(?:19|20)\d{2}\s*[-–至到]\s*(?:19|20)\d{2}(?=\s*年)|(?<![\d.,$])(?:19|20)\d{2}(?![\d.,]|\s*(?:万亿|千亿|百亿|十亿|亿|千万|百万|万|%|billion|million|trillion|bn|mn|[BMKT]\b)|\s*[-–~至到]\s*\$?\d)|\bQ[1-4]\b|第[一二三四]季度|\b(?:10-[QK]|8-K|6-K|20-F)\b/gi;

/** 陈述里需要核对的数字（去掉财年/季度标签、年份；去掉千分位） */
export function numbersIn(text) {
  const stripped = String(text).replace(LABEL, ' ');
  return [...stripped.matchAll(NUM)].map(m => m[0].replace(/,/g, '')).filter(n => n !== '0' && !/^\d$/.test(n));
}

// ---- 带单位的数量比对（2026-10-21 首次真实运行发现：笔记写"900.1亿美元"、出处是 $90.01B，
//      只比裸数字会把单位换算误判成"数字找不到"，MSFT 笔记 17 条里 9 条是这种假失败） ----
const UNIT = {
  万亿: 1e12, 千亿: 1e11, 百亿: 1e10, 十亿: 1e9, 亿: 1e8, 千万: 1e7, 百万: 1e6, 万: 1e4,
  trillion: 1e12, billion: 1e9, bn: 1e9, million: 1e6, mn: 1e6, thousand: 1e3, t: 1e12, b: 1e9, m: 1e6, k: 1e3,
};
const QTY = /(\d[\d,]*(?:\.\d+)?)\s*(万亿|千亿|百亿|十亿|亿|千万|百万|万|trillion|billion|million|thousand|bn|mn|[TBMK](?![A-Za-z])|%)?/gi;

/**
 * 文本里的数量：{ v: 换算后的绝对值, tol: 按显示精度的舍入容差, pct: 是否百分比, scaled: 是否带了量级单位 }。
 * 财年/季度/年份标签与个位数不算（"第四季度""3 个分部"不是需要核对的数字）。
 */
export function quantitiesIn(text) {
  const stripped = String(text).replace(LABEL, ' ');
  const out = [];
  for (const m of stripped.matchAll(QTY)) {
    const raw = m[1].replace(/,/g, '');
    const unit = m[2] || '';
    if (/^\d$/.test(raw) && !unit) continue;
    const dec = (raw.split('.')[1] || '').length;
    const mult = unit === '%' ? 1 : (UNIT[unit] ?? UNIT[unit.toLowerCase()] ?? 1);
    out.push({ v: Number(raw) * mult, tol: 0.5 * 10 ** -dec * mult, pct: unit === '%', scaled: mult !== 1, raw, end: m.index + m[0].length, start: m.index });
  }
  // 区间写法只在后一个数带单位："1970-2020亿美元""$61-64 billion""16-19%"——单位同样作用于前一个数
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i];
    const b = out[i + 1];
    const between = stripped.slice(a.end, b.start);
    if (!a.scaled && !a.pct && (b.scaled || b.pct) && /^\s*(?:-|–|—|~|至|到)\s*\$?\s*$/.test(between)) {
      const mult = b.pct ? 1 : b.v / Number(b.raw);
      const dec = (a.raw.split('.')[1] || '').length;
      Object.assign(a, { v: Number(a.raw) * mult, tol: 0.5 * 10 ** -dec * mult, pct: b.pct, scaled: b.scaled });
    }
  }
  return out.map(({ end, start, ...q }) => q);
}

/** 证据里可比的值：指标行给绝对值与变化率；引文给其中的数量，表格里不带单位的数按 1 / 百万 / 十亿 三种口径都试 */
function evidenceValues(evidence) {
  const vals = [];
  for (const e of evidence) {
    if (e.metricRow) {
      const m = e.metricRow;
      for (const k of ['current', 'prior_quarter', 'prior_year']) if (m[k] != null) vals.push({ v: Math.abs(m[k]), pct: m.unit === '%' });
      for (const k of ['qoq_pct', 'yoy_pct', 'qoq_pp', 'yoy_pp']) if (m[k] != null) vals.push({ v: Math.abs(m[k]), pct: true });
    } else if (e.quote) {
      for (const q of quantitiesIn(e.quote)) {
        if (q.pct) vals.push({ v: q.v, pct: true });
        else if (q.scaled) vals.push({ v: q.v, pct: false });
        else for (const s of [1, 1e6, 1e9]) vals.push({ v: q.v * s, pct: false });
      }
    }
  }
  return vals;
}

/** 陈述里的一个数量能否在证据里找到（同类：百分比对百分比，金额/数量对金额/数量；容差 = 陈述自身的显示精度） */
function quantityFound(q, vals) {
  // 不带 % 的裸数字（如比率表里的 67.2）也允许和百分比类证据比
  return vals.some(e => (q.pct ? e.pct : true) && Math.abs(Math.abs(q.v) - e.v) <= Math.max(q.tol, 1e-9));
}

/**
 * 核对一条陈述。
 * @param claim {{text, evidence: Array<{metric?: string} | {chunk_id: number, quote: string}>}}
 * @param ctx {{ticker, metricsById: Map, chunksById: Map}}
 * @returns {{ok: boolean, reasons: string[], evidence: Array}}  evidence 里补上已核对的出处（字符区间、链接）
 */
export function verifyClaim(claim, ctx) {
  const reasons = [];
  const resolved = [];
  const text = String(claim?.text || '').trim();
  if (!text) return { ok: false, reasons: ['empty text'], evidence: [] };
  if (ADVICE.test(text)) reasons.push('含买卖建议/目标价/股价预测');
  const ev = Array.isArray(claim.evidence) ? claim.evidence : [];
  // noEvidenceOk：程序生成的"未给出数字指引"这类陈述，说的是"没有"，本身无数字、无可引原文
  if (!ev.length && !(claim.generated && claim.noEvidenceOk)) reasons.push('没有出处');
  const used = []; // 已核对的证据（指标行 / 引文原文），供数量比对
  for (const e of ev) {
    if (e && e.metric) {
      const m = ctx.metricsById.get(e.metric);
      if (!m) { reasons.push(`指标 ${e.metric} 不存在`); continue; }
      used.push({ metricRow: m });
      resolved.push({ type: 'metric', metric: m.id, label: m.label, value: fmt(m.current, m.unit), source: m.source });
    } else if (e && e.chunk_id != null) {
      const c = ctx.chunksById.get(Number(e.chunk_id));
      if (!c) { reasons.push(`块 ${e.chunk_id} 不存在`); continue; }
      if (c.ticker !== ctx.ticker) { reasons.push(`块 ${e.chunk_id} 属于 ${c.ticker}，不是 ${ctx.ticker}`); continue; }
      // 不许引用"本季之后才提交"的申报：笔记要能在本季申报落地的那一刻写出来（否则重跑旧季度会用到未来信息，
      // 评估也会偏乐观）。2026-10-21 Opus 试跑时它主动避开了一份后续 10-K，但核对器当时并不拦
      if (ctx.asOf && c.filing_date && c.filing_date > ctx.asOf) { reasons.push(`块 ${e.chunk_id} 来自 ${c.filing_date} 提交的申报，晚于本季最后一份申报 ${ctx.asOf}`); continue; }
      let loc = locateQuote(c.text, e.quote);
      // 模型常把块号记差一位（2026-10-21 MSFT：引文实际在块 39，标成 38）。只在同一申报的相邻块里找，
      // 找到就按真实块记出处——引文仍须逐字存在，不放宽核对
      let src = c;
      if (!loc) {
        for (const id of [c.id - 1, c.id + 1]) {
          const n = ctx.chunksById.get(id) || ctx.loadChunk?.(id);
          if (n && n.accession === c.accession && (loc = locateQuote(n.text, e.quote))) { src = n; break; }
        }
      }
      // 块号记错不止差一位（2026-10-21 网关 Opus：引文在块 5019，标成 5029）：再在本次运行模型实际看过的、
      // 同一申报的块里找。仍须逐字存在，且只认模型确实检索到过的块——不扩大到全库
      if (!loc) {
        for (const n of ctx.chunksById.values()) {
          if (n.id !== c.id && n.accession === c.accession && (loc = locateQuote(n.text, e.quote))) { src = n; break; }
        }
      }
      if (!loc) { reasons.push(`引文在块 ${e.chunk_id} 里找不到：${String(e.quote || '').slice(0, 60)}`); continue; }
      const cc = src;
      if (ctx.asOf && cc.filing_date && cc.filing_date > ctx.asOf) { reasons.push(`块 ${cc.id} 来自 ${cc.filing_date} 提交的申报，晚于本季最后一份申报 ${ctx.asOf}`); continue; }
      const quote = cc.text.slice(loc[0], loc[1]);
      used.push({ quote });
      resolved.push({
        type: 'text', chunk_id: cc.id, accession: cc.accession, form: cc.form_type, section: cc.section,
        char_range: [cc.char_start + loc[0], cc.char_start + loc[1]], quote, url: cc.source_url,
      });
    } else {
      reasons.push('出处格式不对（要么 metric，要么 chunk_id + quote）');
    }
  }
  const vals = evidenceValues(used);
  for (const q of quantitiesIn(text)) {
    if (!quantityFound(q, vals)) reasons.push(`数字 ${q.raw} 在所引出处里找不到`);
  }
  return { ok: reasons.length === 0, reasons, evidence: resolved };
}

/**
 * 去掉模型写进正文的出处标记："（chunk_id: 5062）""(metric: revenue)""（块 39）"。
 * 出处应只在 evidence 里；留在正文会让块号被当成"找不到的数字"（2026-10-21 NVDA v2：13 条里 11 条是这种假失败），
 * 也会让读者看到内部编号。只去标记本身，不改陈述内容
 */
export function stripCitationMarkers(text) {
  return String(text || '')
    .replace(/[（(]\s*(?:chunk(?:_id)?|metric|块|指标)\s*[:：=]?\s*[^()（）]*[)）]/gi, '')
    .replace(/\s+([，。；、,.;])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 核对整份笔记草稿的全部陈述；返回逐条结果与汇总 */
export function verifyDraft(draft, ctx) {
  const sections = ['highlights', 'guidance_check', 'changes', 'risks'];
  const report = [];
  for (const s of sections) {
    for (const [i, raw] of (draft?.[s] || []).entries()) {
      const claim = raw && typeof raw === 'object' ? { ...raw, text: stripCitationMarkers(raw.text) } : raw;
      const r = verifyClaim(claim, ctx);
      report.push({ section: s, index: i, text: claim?.text, ...r });
    }
  }
  // 摘要没有逐条出处：其中的数字必须在某条已通过核对的陈述里出现过；也不能含买卖建议
  const okVals = report.filter(r => r.ok).flatMap(r => quantitiesIn(r.text)).map(q => ({ v: Math.abs(q.v), pct: q.pct }));
  const sumReasons = [];
  if (ADVICE.test(String(draft?.summary || ''))) sumReasons.push('摘要含买卖建议/目标价/股价预测');
  for (const q of quantitiesIn(draft?.summary || '')) if (!quantityFound(q, okVals)) sumReasons.push(`摘要里的数字 ${q.raw} 不在任何已核对陈述中`);
  const summary = { ok: sumReasons.length === 0, reasons: sumReasons };
  const failed = report.filter(r => !r.ok).length + (summary.ok ? 0 : 1);
  return { report, summary, passed: report.filter(r => r.ok).length, failed };
}
