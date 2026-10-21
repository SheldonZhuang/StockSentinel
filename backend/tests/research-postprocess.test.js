// 研究笔记交稿后补全（129号阶段4 改进）：漏掉的关键指标程序补陈述、"未披露"里指标表有值的项删掉
import { describe, it, expect } from 'vitest';
import { completeDraft, metricSentence } from '../research/postprocess.js';
import { verifyDraft } from '../research/verify.js';

const table = {
  fiscalLabel: 'FY2027Q2',
  metrics: [
    { id: 'revenue', label: '营业收入', unit: 'USD', current: 96221e6, prior_quarter: 81615e6, prior_year: 46743e6, qoq_pct: 17.9, yoy_pct: 105.9 },
    { id: 'gross_margin', label: '毛利率', unit: '%', current: 75.0, prior_quarter: 74.9, prior_year: 72.4, qoq_pp: 0.1, yoy_pp: 2.6 },
    { id: 'capex', label: '资本开支（购置物业与设备）', unit: 'USD', current: 2677e6, prior_quarter: 1757e6, prior_year: 1895e6, qoq_pct: 52.4, yoy_pct: 41.3 },
    { id: 'eps_diluted', label: '稀释每股收益', unit: 'USD/share', current: 2.46, prior_quarter: 2.39, prior_year: 1.08, qoq_pct: 2.9, yoy_pct: 127.8 },
    { id: 'rnd', label: '研发费用', unit: 'USD', current: null },
    { id: 'segment:nvda:ComputeAndNetworkingSegmentMember', label: '分部收入：Compute And Networking', unit: 'USD', current: 88302e6, qoq_pct: 18.4, yoy_pct: 113.6 },
    { id: 'segment:nvda:GraphicsSegmentMember', label: '分部收入：Graphics', unit: 'USD', current: 7919e6, qoq_pct: 12.1, yoy_pct: 46.4 },
  ],
};
const draft = {
  summary: '业绩强劲。',
  highlights: [{ text: '营收962.2亿美元，同比增长105.9%', evidence: [{ metric: 'revenue' }] }],
  guidance_check: [], changes: [], risks: [],
  not_disclosed: ['资本开支明细', '稀释每股收益', '具体产品线毛利率', '研发项目具体进展'],
};

describe('completeDraft', () => {
  it('补上漏掉的关键指标与前两大分部；已覆盖的不重复；表里没值的不补', () => {
    const { draft: d, added } = completeDraft(draft, table);
    expect(added).toEqual(['gross_margin', 'eps_diluted', 'capex', 'segment:nvda:ComputeAndNetworkingSegmentMember', 'segment:nvda:GraphicsSegmentMember']);
    expect(d.highlights).toHaveLength(6);
    expect(d.highlights.slice(1).every(c => c.generated && c.evidence[0].metric)).toBe(true);
    expect(draft.highlights).toHaveLength(1); // 不改入参
  });

  it('"未披露"里指标表有值的删掉，真没有的保留', () => {
    const { draft: d, removedNotDisclosed } = completeDraft(draft, table);
    // "具体产品线毛利率"含"毛利率"关键词且指标表有毛利率 → 也删：笔记已有毛利率，再说毛利率未披露会误导
    expect(removedNotDisclosed).toEqual(['资本开支明细', '稀释每股收益', '具体产品线毛利率']);
    expect(d.not_disclosed).toEqual(['研发项目具体进展']);
  });

  it('补出的陈述必然通过自检（数字全部来自指标行）', () => {
    const { draft: d } = completeDraft(draft, table);
    const check = verifyDraft(d, { ticker: 'NVDA', metricsById: new Map(table.metrics.map(m => [m.id, m])), chunksById: new Map() });
    expect(check.report.filter(r => !r.ok)).toEqual([]);
  });

  it('无指标表（TSM / 只有 8-K 的初版）不动', () => {
    expect(completeDraft(draft, null).added).toEqual([]);
  });

  it('陈述文案：金额用增长率，比率用百分点', () => {
    expect(metricSentence(table.metrics[0], 'FY2027Q2')).toBe('FY2027Q2营业收入为$96.22B，环比增长17.9%，同比增长105.9%。');
    expect(metricSentence(table.metrics[1], 'FY2027Q2')).toBe('FY2027Q2毛利率为75.0%，环比增长0.1个百分点，同比增长2.6个百分点。');
  });
});
