// 研究笔记的指标表（129号阶段3）：全部由代码从 Inline XBRL 确定性算出，LLM 只能按 id 引用，不能自己写数字。
// 每个值带出处：accession + XBRL 概念 + 维度 + 期间；推算值（Q4 = 全年 − 9M，毛利率 = 毛利 / 收入…）标 derived 并写明算式。
// 本季 / 上季 / 去年同期一律从"本期申报"里取——10-Q 自带去年同期列，与本季同一份文件同一口径；
// 上季从上一份定期报告取（重述后数字以最新申报为准，与 SEC 口径一致）。
import fs from 'fs';
import path from 'path';
import { all, filingsDir } from './db.js';
import { tsmMetricTable } from './guidance.js';

const DAY = 86400000;
const span = f => (Date.parse(f.period_end) - Date.parse(f.period_start)) / DAY + 1;
const near = (a, b, tol = 7) => Math.abs(Date.parse(a) - Date.parse(b)) <= tol * DAY;

// 基础指标：按优先级尝试的 XBRL 概念（各家科目不同，如 AMZN capex 用 PaymentsToAcquireProductiveAssets）
export const BASE_METRICS = {
  revenue: { label: '营业收入', concepts: ['us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', 'us-gaap:Revenues'], kind: 'flow' },
  cost_of_revenue: { label: '营业成本', concepts: ['us-gaap:CostOfRevenue', 'us-gaap:CostOfGoodsAndServicesSold'], kind: 'flow' },
  gross_profit: { label: '毛利', concepts: ['us-gaap:GrossProfit'], kind: 'flow' },
  rnd: { label: '研发费用', concepts: ['us-gaap:ResearchAndDevelopmentExpense'], kind: 'flow' },
  operating_income: { label: '营业利润', concepts: ['us-gaap:OperatingIncomeLoss'], kind: 'flow' },
  // AVGO 的 10-Q 只用 ProfitLoss（含少数股东，AVGO 无少数股东，二者相等）；NetIncomeLoss 只在旧年报里
  net_income: { label: '净利润', concepts: ['us-gaap:NetIncomeLoss', 'us-gaap:ProfitLoss'], kind: 'flow' },
  eps_diluted: { label: '稀释每股收益', concepts: ['us-gaap:EarningsPerShareDiluted'], kind: 'flow', unit: 'USD/share' },
  operating_cash_flow: { label: '经营活动现金流', concepts: ['us-gaap:NetCashProvidedByUsedInOperatingActivities'], kind: 'flow' },
  capex: { label: '资本开支（购置物业与设备）', concepts: ['us-gaap:PaymentsToAcquirePropertyPlantAndEquipment', 'us-gaap:PaymentsToAcquireProductiveAssets'], kind: 'flow' },
};

// 分部 / 产品线收入：按维度轴取（每家公司在 10-Q 里报告的成员不同，按实际出现的成员列出）
const SEGMENT_AXES = ['us-gaap:StatementBusinessSegmentsAxis', 'srt:ProductOrServiceAxis'];
const REVENUE_CONCEPTS = BASE_METRICS.revenue.concepts;

/** 维度串 → 可读名："msft:IntelligentCloudMember" → "Intelligent Cloud" */
export function memberLabel(member) {
  return member.replace(/^[a-z-]+:/, '').replace(/Member$/, '').replace(/Segment$/, '')
    .replace(/ThreeSixFive/g, ' 365 ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

/**
 * 在一份申报的事实里找某概念、某维度、截至 periodEnd 的单季值。
 * 优先直接的 3 个月事实；没有时用 YTD 差分（本申报的 N 月 YTD − 上一份申报的 N−3 月 YTD）。
 */
function quarterValue(facts, prevFacts, concepts, dims, periodEnd) {
  for (const concept of concepts) {
    const cand = facts.filter(f => f.concept === concept && f.dims === dims && near(f.period_end, periodEnd) && f.period_start);
    const q = cand.find(f => span(f) >= 80 && span(f) <= 100);
    if (q) return { value: q.value, concept, dims, start: q.period_start, end: q.period_end, accession: q.accession };
    // YTD 差分：同起点、跨度短一个季度的事实在上一份申报里
    const ytd = cand.filter(f => span(f) >= 170).sort((a, b) => span(b) - span(a))[0];
    if (ytd && prevFacts) {
      const prev = prevFacts.find(f => f.concept === concept && f.dims === dims && f.period_start === ytd.period_start
        && span(f) >= span(ytd) - 100 && span(f) <= span(ytd) - 80);
      if (prev) {
        return {
          value: ytd.value - prev.value, concept, dims, start: prev.period_end, end: ytd.period_end, accession: ytd.accession,
          derived: `${Math.round(span(ytd) / 30.4)}M YTD (${ytd.accession}) − ${Math.round(span(prev) / 30.4)}M YTD (${prev.accession})`,
        };
      }
    }
  }
  return null;
}

function factsOf(accession) {
  return accession ? all('SELECT * FROM ixbrl_facts WHERE accession = ?', [accession]) : [];
}

/** 公司的定期报告序列（升序），每项带财季标签 */
function periodicFilings(ticker) {
  return all(`SELECT accession, form_type, fiscal_year, fiscal_quarter, period_end, filing_date, document_url
              FROM filings WHERE ticker = ? AND status = 'parsed' AND form_type IN ('10-Q','10-K')
              ORDER BY period_end`, [ticker]);
}

const pct = (a, b) => (a == null || b == null || b === 0 ? null : Math.round(((a - b) / Math.abs(b)) * 1000) / 10);

/**
 * 构建一个财季的指标表。
 * @returns {{ticker, fiscalLabel, periodEnd, source, metrics: Array<{id,label,unit,current,prior_quarter,prior_year,qoq_pct,yoy_pct, source}>}|null}
 *   没有该季定期报告（只有 8-K 初版）时返回 null
 */
export function buildMetricTable(ticker, fiscalYear, fiscalQuarter) {
  // TSM 没有季度 XBRL：从 6-K 财报新闻稿的固定格式表格解析（单位换算由程序做，不交给模型）
  if (ticker === 'TSM') return tsmTable(fiscalYear, fiscalQuarter);
  const seq = periodicFilings(ticker);
  const i = seq.findIndex(f => f.fiscal_year === fiscalYear && f.fiscal_quarter === fiscalQuarter);
  if (i < 0) return null;
  const cur = seq[i];
  const prev = seq[i - 1] || null;          // 上一季的定期报告（Q4 差分要用它的 9M YTD）
  const prev2 = seq[i - 2] || null;
  const yearAgo = seq.find(f => f.fiscal_year === fiscalYear - 1 && f.fiscal_quarter === fiscalQuarter) || null;
  const yearAgoPrev = yearAgo ? seq[seq.indexOf(yearAgo) - 1] || null : null;
  const fCur = factsOf(cur.accession);
  const fPrev = factsOf(prev?.accession);
  const fPrev2 = factsOf(prev2?.accession);
  const fYA = factsOf(yearAgo?.accession);
  const fYAPrev = factsOf(yearAgoPrev?.accession);
  const yaEnd = new Date(Date.parse(cur.period_end) - 364 * DAY).toISOString().slice(0, 10);

  const triple = (concepts, dims) => {
    const c = quarterValue(fCur, fPrev, concepts, dims, cur.period_end);
    const pq = prev ? quarterValue(fPrev, fPrev2, concepts, dims, prev.period_end) : null;
    // 去年同期：先在本期申报里找对比列（同口径）；没有（Q4 的 10-K 不列去年 Q4 单季）再用去年那份申报
    const ya = quarterValue(fCur, null, concepts, dims, yaEnd) || (yearAgo ? quarterValue(fYA, fYAPrev, concepts, dims, yearAgo.period_end) : null);
    return { c, pq, ya };
  };
  const row = (id, label, unit, t) => ({
    id, label, unit,
    current: t.c?.value ?? null,
    prior_quarter: t.pq?.value ?? null,
    prior_year: t.ya?.value ?? null,
    qoq_pct: pct(t.c?.value, t.pq?.value),
    yoy_pct: pct(t.c?.value, t.ya?.value),
    source: t.c ? { type: 'xbrl', accession: t.c.accession, concept: t.c.concept, dims: t.c.dims || null, period: `${t.c.start}..${t.c.end}`, derived: t.c.derived || null, url: cur.document_url } : null,
  });

  const metrics = [];
  const base = {};
  for (const [id, m] of Object.entries(BASE_METRICS)) {
    base[id] = triple(m.concepts, '');
    metrics.push(row(id, m.label, m.unit || 'USD', base[id]));
  }
  // 毛利缺失（MSFT/AMZN/META/GOOGL 不报 GrossProfit）：收入 − 营业成本
  const gp = metrics.find(m => m.id === 'gross_profit');
  if (gp.current == null) {
    const rev = base.revenue;
    const cor = base.cost_of_revenue;
    const sub = (a, b) => (a && b ? { value: a.value - b.value, accession: a.accession, start: a.start, end: a.end } : null);
    const t = { c: sub(rev.c, cor.c), pq: sub(rev.pq, cor.pq), ya: sub(rev.ya, cor.ya) };
    Object.assign(gp, row('gross_profit', '毛利', 'USD', t));
    if (gp.source) Object.assign(gp.source, { concept: null, derived: '营业收入 − 营业成本' });
  }
  // 比率与自由现金流
  const get = id => metrics.find(m => m.id === id);
  const ratio = (id, label, num, den) => {
    const r = k => (get(num)[k] != null && get(den)[k] ? Math.round((get(num)[k] / get(den)[k]) * 1000) / 10 : null);
    const m = { id, label, unit: '%', current: r('current'), prior_quarter: r('prior_quarter'), prior_year: r('prior_year') };
    m.qoq_pct = null; // 比率类不算变化率，给百分点差
    m.qoq_pp = m.current != null && m.prior_quarter != null ? Math.round((m.current - m.prior_quarter) * 10) / 10 : null;
    m.yoy_pp = m.current != null && m.prior_year != null ? Math.round((m.current - m.prior_year) * 10) / 10 : null;
    m.yoy_pct = null;
    m.source = get(num).source && get(den).source ? { type: 'derived', derived: `${get(num).label} / ${get(den).label}`, accession: cur.accession, url: cur.document_url } : null;
    return m;
  };
  metrics.push(ratio('gross_margin', '毛利率', 'gross_profit', 'revenue'));
  metrics.push(ratio('operating_margin', '营业利润率', 'operating_income', 'revenue'));
  const fcf = k => (get('operating_cash_flow')[k] != null && get('capex')[k] != null ? get('operating_cash_flow')[k] - get('capex')[k] : null);
  metrics.push({
    id: 'free_cash_flow', label: '自由现金流（经营现金流 − 资本开支）', unit: 'USD',
    current: fcf('current'), prior_quarter: fcf('prior_quarter'), prior_year: fcf('prior_year'),
    qoq_pct: pct(fcf('current'), fcf('prior_quarter')), yoy_pct: pct(fcf('current'), fcf('prior_year')),
    source: get('capex').source && get('operating_cash_flow').source ? { type: 'derived', derived: '经营活动现金流 − 资本开支（公司自己的 FCF 口径可能不同）', accession: cur.accession, url: cur.document_url } : null,
  });

  // 分部 / 产品线 / 地区收入：本期申报里出现的"单一业务维度"成员。
  // 允许的双维组合只有一种："合并口径轴=经营分部 + 分部轴=某分部"（NVDA、GOOGL 这样报分部）；
  // 其他多维组合（如 META "分部 + 产品"）跳过，避免同一笔收入在表里算两次。
  // （2026-10-21 NVDA 首份笔记把分部收入写成"未披露"，根因就是之前一律跳过双维）
  const OPERATING_SEGMENTS = 'srt:ConsolidationItemsAxis=us-gaap:OperatingSegmentsMember';
  const segDims = new Map(); // 维度串 → [轴, 成员]
  for (const f of fCur) {
    if (!REVENUE_CONCEPTS.includes(f.concept) || !f.dims) continue;
    if (!near(f.period_end, cur.period_end)) continue;
    const parts = f.dims.split(';');
    const rest = parts.length === 2 && parts.includes(OPERATING_SEGMENTS) ? parts.filter(p => p !== OPERATING_SEGMENTS) : parts;
    if (rest.length !== 1) continue;
    const [axis, member] = rest[0].split('=');
    if ([...SEGMENT_AXES, 'srt:StatementGeographicalAxis'].includes(axis)) segDims.set(f.dims, [axis, member]);
  }
  // 过滤：本季单季值算不出来的（成员改名导致 YTD 对不上，如 MSFT 10-K 把 Gaming 改成 XBOX）不进表，记入 unresolved；
  // 占总收入 < 0.5% 的"其他"类成员不进表（同比动辄上千 %，没有研究意义，只会误导）
  const unresolved = [];
  const totalRev = get('revenue').current;
  const KIND = { 'us-gaap:StatementBusinessSegmentsAxis': ['segment', '分部收入'], 'srt:ProductOrServiceAxis': ['product', '产品线收入'], 'srt:StatementGeographicalAxis': ['geo', '地区收入'] };
  for (const [dims, [axis, member]] of [...segDims].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [kind, kindLabel] = KIND[axis];
    const r = row(`${kind}:${member}`, `${kindLabel}：${memberLabel(member)}`, 'USD', triple(REVENUE_CONCEPTS, dims));
    if (r.current == null) { unresolved.push(member); continue; }
    if (totalRev && Math.abs(r.current) < totalRev * 0.005) continue;
    metrics.push(r);
  }

  return {
    ticker,
    fiscalLabel: `FY${fiscalYear}Q${fiscalQuarter}`,
    periodEnd: cur.period_end,
    source: { accession: cur.accession, form: cur.form_type, filingDate: cur.filing_date, url: cur.document_url },
    priorQuarter: prev ? `FY${prev.fiscal_year}Q${prev.fiscal_quarter}` : null,
    priorYear: `FY${fiscalYear - 1}Q${fiscalQuarter}`,
    metrics,
    unresolved, // 本季单季值无法确定的分部/产品线成员（笔记里写"未披露单季值"，不推测）
  };
}

function tsmTable(fiscalYear, fiscalQuarter) {
  const f = all(`SELECT accession, document, document_url, period_end, filing_date FROM filings WHERE ticker = 'TSM' AND doc_kind = 'earnings_release'
                 AND status = 'parsed' AND fiscal_year = ? AND fiscal_quarter = ? ORDER BY filing_date DESC`, [fiscalYear, fiscalQuarter])[0];
  if (!f) return null;
  const text = fs.readFileSync(path.join(filingsDir(), f.accession, `${f.document}.txt`), 'utf8');
  const prevQ = fiscalQuarter === 1 ? `FY${fiscalYear - 1}Q4` : `FY${fiscalYear}Q${fiscalQuarter - 1}`;
  const t = tsmMetricTable(text, {
    fiscalLabel: `FY${fiscalYear}Q${fiscalQuarter}`, priorQuarter: prevQ, priorYear: `FY${fiscalYear - 1}Q${fiscalQuarter}`,
    periodEnd: f.period_end, source: { accession: f.accession, filingDate: f.filing_date, url: f.document_url },
  });
  return t.metrics.length ? t : null;
}

/** 数字展示：金额按十亿/百万美元（新台币金额加 NT 前缀），百分比保留一位 */
export function fmt(v, unit) {
  if (v == null) return '未披露';
  if (unit === '%') return `${v.toFixed(1)}%`;
  if (unit === 'USD/share') return `$${v.toFixed(2)}`;
  if (unit === 'TWD/share') return `NT$${v.toFixed(2)}`;
  const a = Math.abs(v);
  // 新台币金额：按"亿元"写（与中文财经习惯一致；1 亿 = 1e8），程序换算，模型照抄
  if (unit === 'TWD') return `新台币${(v / 1e8).toFixed(2)}亿元`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toFixed(0)}`;
}
