// 研究笔记评估的标准答案集（129号阶段4）。
// 范围：8 家 × 各自最近 2 个"正式版"财季（有 10-Q/10-K 或 TSM 的季度合并财报）。
// 每份 10 个关键事实，全部由程序从一手来源取，不经 LLM：
//   - 数值类：XBRL 指标表（metrics.js）；TSM 没有季度 XBRL，从季度新闻稿的固定格式表格取，并与 XBRL 口径无关地单独标注
//   - 指引类：本季新闻稿里管理层对下一季的收入指引，按逐字正则取原文；新闻稿不给数字指引的公司（MSFT、GOOGL）
//     金标是"未披露"——用来测"未披露"误报率（模型若编出一个指引数字即算错）
// 文字类事实（指引句）存原文，供用户在打分表里确认（用户 2026-10-21 定：数值从 XBRL 自动取，文字类人工确认）。
// 金标一旦生成就冻结成 JSON 入库（research/eval/notes-gold.json）：评估不随代码变化重新出题，
// 防止"为了数字好看改标准答案"。重新生成要显式跑 --regen 并在 git diff 里可见。
import fs from 'fs';
import path from 'path';
import { all } from '../db.js';
import { filingsDir } from '../db.js';
import { buildMetricTable } from '../metrics.js';

// 每份笔记的 10 个事实：前 7 个通用，后 3 个按公司取最能代表其 AI 产业链位置的分部 / 产品线 / 资本开支
const COMMON = [
  ['revenue', '营业收入'],
  ['revenue_yoy', '营业收入同比'],
  ['gross_margin', '毛利率'],
  ['operating_income', '营业利润'],
  ['net_income', '净利润'],
  ['eps_diluted', '稀释每股收益'],
  ['capex', '资本开支'],
];
const COMPANY_FACTS = {
  MSFT: ['segment:msft:IntelligentCloudMember', 'segment:msft:ProductivityAndBusinessProcessesMember'],
  GOOGL: ['segment:goog:GoogleCloudMember', 'segment:goog:GoogleServicesMember'],
  AMZN: ['segment:amzn:AmazonWebServicesSegmentMember', 'segment:amzn:NorthAmericaSegmentMember'],
  META: ['segment:meta:FamilyOfAppsMember', 'segment:meta:RealityLabsMember'],
  NVDA: ['product:nvda:DataCenterMember', 'segment:nvda:ComputeAndNetworkingSegmentMember'],
  AMD: ['segment:amd:DataCenterMember', 'segment:amd:ClientAndGamingMember'],
  AVGO: ['segment:avgo:SemiconductorSolutionsMember', 'segment:avgo:InfrastructureSoftwareMember'],
};

// 下一季收入指引（逐字）。只认前瞻句式，排除"Q2 consolidated revenue grew…"这类实际值
const GUIDANCE_RE = [
  /Revenue is expected to be \$[\d.]+ billion, plus or minus \d+%/,
  /AMD expects revenue to be approximately \$[\d.]+ billion, plus or minus \$[\d.]+ (?:million|billion)/,
  /Net sales are expected to be between \$[\d.]+ billion and \$[\d.]+ billion/,
  /total revenue to be in the range of \$[\d.]+[-–][\d.]+ billion/,
  /Revenue is expected to be between US\$[\d.]+ billion and US\$[\d.]+ billion/,
  /Q[1-4] consolidated revenue (?:growth )?is forecasted to[^.]{0,60}\$[\d.]+ billion/,
  /(?:Q[1-4]|quarter) revenue guidance of approximately \$[\d.]+ billion/,
];

function readText(accession, document) {
  return fs.readFileSync(path.join(filingsDir(), accession, `${document}.txt`), 'utf8');
}

/** TSM 季度新闻稿：表格 "Net sales\n1,494,243 | 989,918 | 50.9 | …"（新台币百万）与正文里的毛利率、美元收入 */
export function tsmFactsFromRelease(text) {
  const row = name => {
    const m = new RegExp(`^${name}\\n([\\d,]+) \\| ([\\d,]+) \\| (-?[\\d.]+)`, 'm').exec(text);
    return m ? { cur: Number(m[1].replace(/,/g, '')) * 1e6, py: Number(m[2].replace(/,/g, '')) * 1e6, yoy: Number(m[3]) } : null;
  };
  const sales = row('Net sales');
  const op = row('Income from operations');
  const ni = row('Net income');
  // "EPS (NT$)\n27.25b"：数字后面紧跟脚注字母
  const eps = /^EPS \(NT\$\)\n(\d+\.\d+)/m.exec(text);
  const gm = /Gross margin for the quarter was ([\d.]+)%/.exec(text);
  const usd = /revenue was \$([\d.]+) billion/.exec(text);
  const usdYoy = /revenue was \$[\d.]+ billion, which increased ([\d.]+)% year-over-year/.exec(text);
  return { sales, op, ni, eps: eps ? Number(eps[1]) : null, gm: gm ? Number(gm[1]) : null, usd: usd ? Number(usd[1]) * 1e9 : null, usdYoy: usdYoy ? Number(usdYoy[1]) : null };
}

/** 正式版财季（降序）：境内公司 = 有 10-Q/10-K；TSM = 有季度合并财报 */
function finalQuarters(ticker) {
  return all(`SELECT DISTINCT fiscal_year fy, fiscal_quarter fq FROM filings WHERE ticker = ? AND status = 'parsed'
              AND doc_kind IN ('periodic','annual','ifrs_financials') ORDER BY fy DESC, fq DESC`, [ticker]);
}

function releaseOf(ticker, fy, fq) {
  return all(`SELECT accession, document, document_url FROM filings WHERE ticker = ? AND fiscal_year = ? AND fiscal_quarter = ?
              AND doc_kind = 'earnings_release' AND status = 'parsed' ORDER BY filing_date DESC`, [ticker, fy, fq])[0] || null;
}

/** 生成一份笔记的金标：[{ id, label, kind: 'number'|'guidance'|'not_disclosed', value, unit, tol, source }] */
export function goldFor(ticker, fy, fq) {
  const facts = [];
  const rel = releaseOf(ticker, fy, fq);
  if (ticker === 'TSM') {
    if (!rel) return null;
    const t = tsmFactsFromRelease(readText(rel.accession, rel.document));
    const src = { type: 'press_release', accession: rel.accession, url: rel.document_url };
    const add = (id, label, value, unit) => value != null && facts.push({ id, label, kind: 'number', value, unit, source: src });
    add('revenue', '营业收入（新台币）', t.sales?.cur, 'TWD');
    add('revenue_yoy', '营业收入同比（新台币）', t.sales?.yoy, '%');
    add('revenue_usd', '营业收入（美元）', t.usd, 'USD');
    add('revenue_usd_yoy', '营业收入同比（美元）', t.usdYoy, '%');
    add('gross_margin', '毛利率', t.gm, '%');
    add('operating_income', '营业利润（新台币）', t.op?.cur, 'TWD');
    add('net_income', '净利润（新台币）', t.ni?.cur, 'TWD');
    add('net_income_yoy', '净利润同比', t.ni?.yoy, '%');
    add('eps_diluted', '稀释每股收益（新台币）', t.eps, 'TWD/share');
  } else {
    const table = buildMetricTable(ticker, fy, fq);
    if (!table) return null;
    const m = id => table.metrics.find(x => x.id === id);
    for (const [id, label] of COMMON) {
      const base = id === 'revenue_yoy' ? m('revenue') : m(id);
      if (!base || base.current == null) continue;
      const value = id === 'revenue_yoy' ? base.yoy_pct : base.current;
      if (value == null) continue;
      facts.push({ id, label, kind: 'number', value, unit: id === 'revenue_yoy' ? '%' : base.unit, source: base.source });
    }
    for (const id of COMPANY_FACTS[ticker] || []) {
      const r = m(id);
      if (r?.current != null) facts.push({ id, label: r.label, kind: 'number', value: r.current, unit: r.unit, source: r.source });
    }
  }
  // 第 10 个：下一季收入指引（文字）
  if (rel) {
    const text = readText(rel.accession, rel.document);
    const hit = GUIDANCE_RE.map(r => r.exec(text)?.[0]).find(Boolean);
    facts.push(hit
      ? { id: 'next_q_revenue_guidance', label: '下一季收入指引', kind: 'guidance', value: hit, numbers: (hit.match(/\d[\d.]*/g) || []).map(Number), source: { type: 'press_release', accession: rel.accession, url: rel.document_url } }
      : { id: 'next_q_revenue_guidance', label: '下一季收入指引', kind: 'not_disclosed', value: '财报新闻稿未给出数字指引', source: { type: 'press_release', accession: rel.accession, url: rel.document_url } });
  }
  return { ticker, fiscalLabel: `FY${fy}Q${fq}`, facts: facts.slice(0, 10) };
}

/** 8 家 × 最近 2 个正式版财季 */
export function buildGoldSet(tickers) {
  const out = [];
  for (const t of tickers) for (const q of finalQuarters(t).slice(0, 2)) {
    const g = goldFor(t, q.fy, q.fq);
    if (g) out.push(g);
  }
  return out;
}
