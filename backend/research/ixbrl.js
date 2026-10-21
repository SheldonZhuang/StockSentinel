// Inline XBRL 解析（129号阶段3）：从缓存的 10-Q / 10-K 原件里读 ix:nonFraction 事实与 context 维度。
// 为什么不只用 companyfacts：companyfacts 只有不带维度的事实，分部收入（Intelligent Cloud、Data Center…）
// 全是带维度的（StatementBusinessSegmentsAxis / ProductOrServiceAxis），阶段2 检索最难答的正是这类题。
// 出处：每条事实 = accession + 概念名 + 维度 + 期间，可在 SEC 的 iXBRL 查看器里逐条定位。
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { all, run, tx } from './db.js';
import { filingsDir } from './db.js';

const attr = (s, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(s);
  return m ? m[1] : null;
};

/**
 * 解析 inline XBRL（纯函数）。
 * 数值规则（iXBRL 1.1）：显示文本去掉千分位 → × 10^scale；sign="-" 取负。ixt:fixed-zero / "—" 视为 0。
 * @returns {Array<{concept, dims, start, end, value, unit, decimals}>}  dims 为 "axis=member;..."（按轴排序），无维度为 ''
 */
export function parseInlineXbrl(html) {
  const contexts = new Map();
  for (const m of html.matchAll(/<xbrli:context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/xbrli:context>/g)) {
    const body = m[2];
    const dims = [...body.matchAll(/<xbrldi:explicitMember\b[^>]*dimension="([^"]+)"[^>]*>\s*([^<\s]+)\s*<\/xbrldi:explicitMember>/g)]
      .map(d => `${d[1]}=${d[2]}`).sort().join(';');
    const typed = /<xbrldi:typedMember/.test(body);
    const start = /<xbrli:startDate>\s*([\d-]+)/.exec(body)?.[1] || '';
    const end = /<xbrli:endDate>\s*([\d-]+)/.exec(body)?.[1] || /<xbrli:instant>\s*([\d-]+)/.exec(body)?.[1] || '';
    if (!typed) contexts.set(m[1], { dims, start, end });
  }
  const units = new Map();
  for (const m of html.matchAll(/<xbrli:unit\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/xbrli:unit>/g)) {
    const measures = [...m[2].matchAll(/<xbrli:measure>\s*([^<\s]+)\s*<\/xbrli:measure>/g)].map(x => x[1].replace(/^iso4217:|^xbrli:/, ''));
    units.set(m[1], /divide/.test(m[2]) ? measures.join('/') : measures[0]);
  }
  const out = [];
  const seen = new Set();
  // 事实可能嵌套（ix:nonFraction 里套 span），取标签内全部文本
  for (const m of html.matchAll(/<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction>/g)) {
    const a = m[1];
    const ctx = contexts.get(attr(a, 'contextRef'));
    const concept = attr(a, 'name');
    if (!ctx || !concept || !ctx.end) continue;
    const text = m[2].replace(/<[^>]+>/g, '').replace(/&#160;|&nbsp;/g, ' ').trim();
    let num;
    if (/fixed-zero/.test(attr(a, 'format') || '') || /^[-—–]$/.test(text)) num = 0;
    else {
      const cleaned = text.replace(/[,\s]/g, '');
      if (!/^\d+(\.\d+)?$/.test(cleaned)) continue;
      num = Number(cleaned);
    }
    const scale = Number(attr(a, 'scale') || 0);
    let value = num * 10 ** scale;
    if (attr(a, 'sign') === '-') value = -value;
    // 浮点误差：按 scale 取整到合理精度
    value = Math.round(value * 1e6) / 1e6;
    const key = `${concept}|${ctx.dims}|${ctx.start}|${ctx.end}`;
    if (seen.has(key)) continue; // 同一事实在正文多处出现（表格 + 附注），取首个
    seen.add(key);
    out.push({
      concept, dims: ctx.dims, start: ctx.start, end: ctx.end, value,
      unit: units.get(attr(a, 'unitRef')) || attr(a, 'unitRef') || '', decimals: attr(a, 'decimals'),
    });
  }
  return out;
}

/** 解析一份已缓存的定期报告并整体替换其事实（返回条数）；没有缓存或不是定期报告返回 0 */
export function indexFilingIxbrl(filing) {
  if (!['10-Q', '10-K'].includes(filing.form_type) || !filing.document) return 0;
  const p = path.join(filingsDir(), filing.accession, `${filing.document}.gz`);
  if (!fs.existsSync(p)) return 0;
  const facts = parseInlineXbrl(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
  tx(() => {
    run('DELETE FROM ixbrl_facts WHERE accession = ?', [filing.accession]);
    for (const f of facts) {
      run(`INSERT INTO ixbrl_facts (accession, ticker, concept, dims, period_start, period_end, value, unit, decimals, filing_date)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [filing.accession, filing.ticker, f.concept, f.dims, f.start, f.end, f.value, f.unit, f.decimals, filing.filing_date]);
    }
  });
  return facts.length;
}

/** 所有已解析、尚未建 iXBRL 索引的定期报告补建索引 */
export function indexAllIxbrl() {
  const todo = all(`SELECT f.* FROM filings f WHERE f.status = 'parsed' AND f.form_type IN ('10-Q','10-K')
                    AND NOT EXISTS (SELECT 1 FROM ixbrl_facts x WHERE x.accession = f.accession)`);
  let n = 0;
  for (const f of todo) n += indexFilingIxbrl(f);
  return { filings: todo.length, facts: n };
}
