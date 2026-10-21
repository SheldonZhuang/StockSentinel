// 指引对照由程序计算 + TSM 新闻稿指标表（129号阶段5）
import { describe, it, expect } from 'vitest';
import { parseRevenueGuidance, verdictFor, tsmMetricTable } from '../research/guidance.js';

describe('parseRevenueGuidance', () => {
  it.each([
    ['Revenue is expected to be $108.0 billion, plus or minus 2%.', { mid: 108e9, low: 105.84e9, high: 110.16e9, disp: '约$108.0B（上下2%）' }],
    ['AMD expects revenue to be approximately $13 billion, plus or minus $300 million.', { mid: 13e9, low: 12.7e9, high: 13.3e9, disp: '约$13B（上下$300 million）' }],
    ['Net sales are expected to be between $197.0 billion and $202.0 billion', { low: 197e9, high: 202e9, disp: '$197.0B至$202.0B' }],
    ['total revenue to be in the range of $61-64 billion', { low: 61e9, high: 64e9, disp: '$61B至$64B' }],
    ['Revenue is expected to be between US$52.3 billion and US$54.3 billion;', { low: 52.3e9, high: 54.3e9, disp: 'US$52.3B至US$54.3B' }],
    ['Q4 consolidated revenue growth is forecasted to increase 93% year-over-year to $34.8 billion', { mid: 34.8e9, point: true, disp: '约$34.8B' }],
  ])('%s', (text, want) => {
    const g = parseRevenueGuidance(text);
    for (const [k, v] of Object.entries(want)) {
      if (typeof v === 'number') expect(g[k]).toBeCloseTo(v, -3);
      else expect(g[k]).toBe(v);
    }
    expect(text).toContain(g.quote);
  });

  it('实际结果句（"Q2 consolidated revenue grew…"）不是指引；没有指引返回 null', () => {
    expect(parseRevenueGuidance('Q2 consolidated revenue grew 48% year-over-year to a record $22.2 billion')).toBe(null);
    expect(parseRevenueGuidance('Microsoft will provide forward-looking guidance on its earnings call.')).toBe(null);
  });
});

describe('verdictFor', () => {
  // 阶段4 盲评抓到的方向错误：76 亿 vs 77 亿被写成"略高于"
  it('方向由程序判：高于上限 / 区间内 / 低于下限', () => {
    const g = { low: 105.84e9, high: 110.16e9 };
    expect(verdictFor(111e9, g)).toBe('above');
    expect(verdictFor(108e9, g)).toBe('within');
    expect(verdictFor(7.6e9, { low: 7.7e9, high: 7.7e9 })).toBe('below');
  });
});

describe('tsmMetricTable', () => {
  const text = `In US dollars, third quarter revenue was $46.72 billion, which increased 41.2% year-over-year and increased 16.2% from the previous quarter.
Gross margin for the quarter was 66.4%, operating margin was 58.7%, and net profit margin was 51.1%.
Net sales
1,494,243 | 989,918 | 50.9 | 1,270,381 | 17.6
Gross profit
992,379 | 588,543 | 68.6 | 860,311 | 15.4
Income from operations
876,445 | 500,685 | 75.0 | 766,603 | 14.3
Net income
763,064 | 452,302 | 68.7 | 706,562 | 8.0
EPS (NT$)
29.43b
17.44c
68.7 | 27.25b
8.0`;
  const t = tsmMetricTable(text, { fiscalLabel: 'FY2026Q3', priorQuarter: 'FY2026Q2', priorYear: 'FY2025Q3', periodEnd: '2026-09-30', source: { accession: 'a', url: 'u' } });
  const m = id => t.metrics.find(x => x.id === id);

  it('新台币百万元 → 元（程序换算，不交给模型）；本季 / 上季 / 去年同期 / 变化率齐全', () => {
    expect(m('revenue')).toMatchObject({ unit: 'TWD', current: 1494243e6, prior_quarter: 1270381e6, prior_year: 989918e6, yoy_pct: 50.9, qoq_pct: 17.6 });
    expect(m('net_income').current).toBe(763064e6);
    expect(m('eps_diluted')).toMatchObject({ current: 29.43, prior_quarter: 27.25, prior_year: 17.44, yoy_pct: 68.7 });
  });

  it('美元营收与利润率取自正文', () => {
    expect(m('revenue_usd')).toMatchObject({ current: 46.72e9, yoy_pct: 41.2, qoq_pct: 16.2 });
    expect(m('gross_margin').current).toBe(66.4);
    expect(m('operating_margin').current).toBe(58.7);
  });
});
