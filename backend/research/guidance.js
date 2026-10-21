// 指引对照由程序计算（129号阶段5）。
// 背景：阶段4 盲评时评委发现，deepseek 写了"营业费用 76 亿，略高于指引 77 亿"，比较方向写反了，自检却放行了——
// 自检只核对"数字在出处里"，不核对"比较方向"。所以"高于 / 低于 / 落在指引区间内"这类结论改由程序算：
//   1) 从上季财报新闻稿里按逐字句式取"本季收入指引"（与评估金标同一套句式）；
//   2) 用本季指标表的实际营收比对，得出结论；
//   3) 生成"程序生成"陈述放进 guidance_check，模型只负责解释原因，不再写比较结论。
// TSM：季度数字只在 6-K 新闻稿里（没有季度 XBRL），这里也负责把新闻稿表格解析成与境内公司同结构的指标表，
// 避免模型自己做新台币单位换算（阶段4 deepseek 把 1,270,381 百万写成"1,270.38亿"，少了 10 倍）。
import fs from 'fs';
import path from 'path';
import { all, filingsDir } from './db.js';
import { locateQuote } from './wiki.js';

// 下一季收入指引句式（逐字）。单位统一换算成美元
const PATTERNS = [
  // NVDA: Revenue is expected to be $108.0 billion, plus or minus 2%
  { re: /Revenue is expected to be \$([\d.]+) billion, plus or minus (\d+(?:\.\d+)?)%/, f: m => { const c = +m[1] * 1e9; const t = +m[2] / 100; return { mid: c, low: c * (1 - t), high: c * (1 + t), disp: `约$${m[1]}B（上下${m[2]}%）` }; } },
  // AMD: AMD expects revenue to be approximately $13 billion, plus or minus $300 million
  { re: /expects revenue to be approximately \$([\d.]+) billion, plus or minus \$([\d.]+) (million|billion)/, f: m => { const c = +m[1] * 1e9; const d = +m[2] * (m[3] === 'billion' ? 1e9 : 1e6); return { mid: c, low: c - d, high: c + d, disp: `约$${m[1]}B（上下$${m[2]} ${m[3]}）` }; } },
  // AMZN: Net sales are expected to be between $197.0 billion and $202.0 billion
  { re: /Net sales are expected to be between \$([\d.]+) billion and \$([\d.]+) billion/, f: m => ({ low: +m[1] * 1e9, high: +m[2] * 1e9, disp: `$${m[1]}B至$${m[2]}B` }) },
  // META: total revenue to be in the range of $61-64 billion
  { re: /total revenue to be in the range of \$([\d.]+)[-–]([\d.]+) billion/, f: m => ({ low: +m[1] * 1e9, high: +m[2] * 1e9, disp: `$${m[1]}B至$${m[2]}B` }) },
  // TSM: Revenue is expected to be between US$52.3 billion and US$54.3 billion
  { re: /Revenue is expected to be between US\$([\d.]+) billion and US\$([\d.]+) billion/, f: m => ({ low: +m[1] * 1e9, high: +m[2] * 1e9, disp: `US$${m[1]}B至US$${m[2]}B` }) },
  // AVGO: Q4 consolidated revenue growth is forecasted to increase 93% year-over-year to $34.8 billion / revenue guidance of approximately $29.4 billion
  { re: /consolidated revenue (?:growth )?is forecasted to[^.]{0,60}?\$([\d.]+) billion/, f: m => ({ mid: +m[1] * 1e9, point: true, disp: `约$${m[1]}B` }) },
  { re: /revenue guidance of approximately \$([\d.]+) billion/, f: m => ({ mid: +m[1] * 1e9, point: true, disp: `约$${m[1]}B` }) },
];

/** 点值指引（"约 $X"）按 ±1% 判断"符合"——管理层给的是约数，0.5% 以内的偏差不应判成高于/低于 */
const POINT_TOLERANCE = 0.01;

/** 在一份新闻稿正文里找下一季收入指引（纯函数） */
export function parseRevenueGuidance(text) {
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    const g = p.f(m);
    if (g.point) { g.low = g.mid * (1 - POINT_TOLERANCE); g.high = g.mid * (1 + POINT_TOLERANCE); }
    g.mid ??= (g.low + g.high) / 2;
    return { ...g, quote: m[0] };
  }
  return null;
}

/** 实际值 vs 指引区间 → above / within / below（纯函数） */
export function verdictFor(actual, g) {
  if (actual > g.high) return 'above';
  if (actual < g.low) return 'below';
  return 'within';
}

/**
 * TSM 新闻稿 → 指标表（与 buildMetricTable 返回结构一致，纯函数）。
 * 表格单位"NT$ million"：金额 ×1e6 存为新台币元；美元营收取正文"revenue was $46.72 billion"。
 * 只有本季与去年同期、上季三列（表头 3Q26 | 3Q25 | YoY | 2Q26 | QoQ）。
 */
export function tsmMetricTable(text, { fiscalLabel, priorQuarter, priorYear, periodEnd, source }) {
  const row = name => {
    const m = new RegExp(`^${name}\\n([\\d,]+) \\| ([\\d,]+) \\| (-?[\\d.]+) \\| ([\\d,]+) \\| (-?[\\d.]+)`, 'm').exec(text);
    if (!m) return null;
    const n = s => Number(s.replace(/,/g, '')) * 1e6;
    return { current: n(m[1]), prior_year: n(m[2]), yoy_pct: Number(m[3]), prior_quarter: n(m[4]), qoq_pct: Number(m[5]) };
  };
  const src = { type: 'text', accession: source.accession, url: source.url, derived: '新闻稿表格（单位：新台币百万元）' };
  const metrics = [];
  const push = (id, label, unit, r) => r && metrics.push({ id, label, unit, ...r, source: src });
  push('revenue', '营业收入（新台币）', 'TWD', row('Net sales'));
  push('gross_profit', '毛利（新台币）', 'TWD', row('Gross profit'));
  push('operating_income', '营业利润（新台币）', 'TWD', row('Income from operations'));
  push('net_income', '净利润（新台币）', 'TWD', row('Net income'));
  const eps = /^EPS \(NT\$\)\n(\d+\.\d+)[a-z]?\n(\d+\.\d+)[a-z]?\n(-?[\d.]+) \| (\d+\.\d+)[a-z]?\n(-?[\d.]+)/m.exec(text);
  if (eps) push('eps_diluted', '稀释每股收益（新台币）', 'TWD/share', { current: +eps[1], prior_year: +eps[2], yoy_pct: +eps[3], prior_quarter: +eps[4], qoq_pct: +eps[5] });
  const usd = /revenue was \$([\d.]+) billion, which increased ([\d.]+)% year-over-year and (increased|decreased) ([\d.]+)% from the previous quarter/.exec(text);
  if (usd) {
    metrics.push({ id: 'revenue_usd', label: '营业收入（美元）', unit: 'USD', current: +usd[1] * 1e9, prior_quarter: null, prior_year: null,
      yoy_pct: +usd[2], qoq_pct: (usd[3] === 'decreased' ? -1 : 1) * +usd[4], source: { ...src, derived: '新闻稿正文美元收入' } });
  }
  const gm = /Gross margin for the quarter was ([\d.]+)%, operating margin was ([\d.]+)%, and net profit margin was ([\d.]+)%/.exec(text);
  if (gm) {
    const ratio = (id, label, v) => metrics.push({ id, label, unit: '%', current: v, prior_quarter: null, prior_year: null, qoq_pp: null, yoy_pp: null, source: { ...src, derived: '新闻稿正文' } });
    ratio('gross_margin', '毛利率', +gm[1]);
    ratio('operating_margin', '营业利润率', +gm[2]);
    ratio('net_margin', '净利率', +gm[3]);
  }
  return { ticker: 'TSM', fiscalLabel, periodEnd, source: { ...source, form: '6-K' }, priorQuarter, priorYear, metrics, unresolved: [] };
}

/** 公司的财报新闻稿（按申报日升序） */
function releases(ticker) {
  return all(`SELECT accession, document, document_url, fiscal_year, fiscal_quarter, filing_date FROM filings
              WHERE ticker = ? AND doc_kind = 'earnings_release' AND status = 'parsed' ORDER BY filing_date`, [ticker]);
}

/**
 * 本季对照上季指引的结论（程序算）+ 本季给出的下季指引。
 * @param table 本季指标表，用其中的 revenue（TSM 用 revenue_usd：指引是美元口径）作为实际值
 * @returns {{ prior: object|null, next: object|null }}
 */
export function guidanceFacts(ticker, fiscalYear, fiscalQuarter, table) {
  const seq = releases(ticker);
  const idx = seq.findIndex(r => r.fiscal_year === fiscalYear && r.fiscal_quarter === fiscalQuarter);
  const cur = idx >= 0 ? seq[idx] : null;
  const prev = idx > 0 ? seq[idx - 1] : null;
  const read = r => (r ? fs.readFileSync(path.join(filingsDir(), r.accession, `${r.document}.txt`), 'utf8') : '');
  const src = r => ({ accession: r.accession, url: r.document_url });
  const actualRow = table?.metrics.find(m => m.id === (ticker === 'TSM' ? 'revenue_usd' : 'revenue'));
  let prior = null;
  if (prev) {
    const g = parseRevenueGuidance(read(prev));
    if (g) {
      const actual = actualRow?.current ?? null;
      prior = { ...g, actual, verdict: actual == null ? null : verdictFor(actual, g), source: src(prev), fromFiscalLabel: `FY${prev.fiscal_year}Q${prev.fiscal_quarter}` };
    }
  }
  let next = null;
  if (cur) {
    const g = parseRevenueGuidance(read(cur));
    if (g) next = { ...g, source: src(cur) };
  }
  return { prior, next };
}

const B = v => `$${(v / 1e9).toFixed(2)}B`;

/** 指引原文所在的块（同一申报内逐字定位），陈述引用 chunk_id——与模型陈述走同一套自检 */
function chunkFor(source, quote) {
  for (const c of all('SELECT * FROM chunks WHERE accession = ? ORDER BY seq', [source.accession])) {
    if (locateQuote(c.text, quote)) return c;
  }
  return null;
}

/**
 * 程序生成的指引对照陈述（中文）：比较结论由 verdictFor 算出，数字来自指引原文与指标表，不经 LLM。
 * 返回陈述数组 + 涉及的块（调用方把块加入自检的 chunksById）
 */
export function guidanceClaims(gf, { ticker } = {}) {
  const revenueMetric = ticker === 'TSM' ? 'revenue_usd' : 'revenue';
  const chunks = [];
  const quoteEv = g => {
    const c = chunkFor(g.source, g.quote);
    if (!c) return [];
    chunks.push(c);
    return [{ chunk_id: c.id, quote: g.quote }];
  };
  const claims = [];
  if (gf.prior) {
    const p = gf.prior;
    const range = p.disp;
    const v = { above: '高于指引区间上限', below: '低于指引区间下限', within: '落在指引区间内' }[p.verdict];
    claims.push({
      text: p.actual == null
        ? `上季（${p.fromFiscalLabel}）给出的本季收入指引为${range}；本季实际收入未从数据表取得，不作对照。`
        : `上季（${p.fromFiscalLabel}）给出的本季收入指引为${range}，本季实际收入${B(p.actual)}，${v}${p.point ? '（指引为约数，按约数的合理浮动判断）' : ''}。`,
      evidence: [...quoteEv(p), ...(p.actual != null ? [{ metric: revenueMetric }] : [])],
      generated: true,
    });
  }
  claims.push(gf.next
    ? { text: `管理层对下一季的收入指引为${gf.next.disp}。`, evidence: quoteEv(gf.next), generated: true }
    : { text: '本季财报新闻稿未给出下一季的数字收入指引。', evidence: [], generated: true, noEvidenceOk: true });
  return { claims, chunks };
}
