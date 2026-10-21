// 研究笔记评估打分（129号阶段4）：对事实、数字比对、未披露误报、捏造指引、汇总指标
import { describe, it, expect } from 'vitest';
import { scoreNote, aggregate } from '../research/eval/notes-eval.js';
import { tsmFactsFromRelease } from '../research/eval/gold.js';

const gold = {
  ticker: 'NVDA', fiscalLabel: 'FY2027Q2',
  facts: [
    { id: 'revenue', label: '营业收入', kind: 'number', value: 96221e6, unit: 'USD' },
    { id: 'revenue_yoy', label: '营业收入同比', kind: 'number', value: 105.9, unit: '%' },
    { id: 'gross_margin', label: '毛利率', kind: 'number', value: 75.0, unit: '%' },
    { id: 'capex', label: '资本开支', kind: 'number', value: 2677e6, unit: 'USD' },
    { id: 'product:nvda:DataCenterMember', label: '产品线收入：Data Center', kind: 'number', value: 89022e6, unit: 'USD' },
    { id: 'next_q_revenue_guidance', label: '下一季收入指引', kind: 'guidance', value: 'Revenue is expected to be $108.0 billion, plus or minus 2%', numbers: [108.0, 2] },
  ],
};
const metric = id => ({ type: 'metric', metric: id });
const claim = (text, evidence, status = 'verified') => ({ text, evidence, status });

describe('scoreNote', () => {
  it('提到且数字对 / 提到但数字错 / 没提到 分别计', () => {
    const note = {
      summary: '', not_disclosed: ['资本开支明细'],
      highlights: [
        claim('营收962.2亿美元，同比增长105.9%', [metric('revenue')]),
        claim('毛利率76.0%', [metric('gross_margin')]), // 错
        claim('数据中心收入890.2亿美元', [metric('product:nvda:DataCenterMember')]),
      ],
      guidance_check: [claim('管理层指引下一季度收入为1080亿美元±2%', [{ type: 'text', quote: 'x' }])],
      changes: [], risks: [claim('出口管制风险', [], 'needs_review')],
    };
    const s = scoreNote(note, gold);
    const by = id => s.facts.find(f => f.id === id);
    expect(by('revenue')).toMatchObject({ mentioned: true, correct: true });
    expect(by('revenue_yoy')).toMatchObject({ mentioned: true, correct: true });
    expect(by('gross_margin')).toMatchObject({ mentioned: true, correct: false });
    expect(by('product:nvda:DataCenterMember')).toMatchObject({ mentioned: true, correct: true });
    expect(by('next_q_revenue_guidance')).toMatchObject({ mentioned: true, correct: true });
    // 资本开支没提到，且被列进"未披露" → 误报
    expect(by('capex')).toMatchObject({ mentioned: false, correct: null, falseNotDisclosed: true });
    expect(s).toMatchObject({ claims: 5, withSource: 4, sourceVerified: 4 });
  });

  it('金标"未披露"的指引：笔记编出数字 → 捏造；只说未提供 → 不算', () => {
    const g = { ticker: 'MSFT', fiscalLabel: 'FY2026Q4', facts: [{ id: 'next_q_revenue_guidance', label: '下一季收入指引', kind: 'not_disclosed' }] };
    const fab = scoreNote({ summary: '', highlights: [], guidance_check: [claim('管理层预计下一季度收入约950亿美元', [metric('revenue')])], changes: [], risks: [] }, g);
    expect(fab.facts[0].fabricated).toBe(true);
    const honest = scoreNote({ summary: '', highlights: [], guidance_check: [claim('财报新闻稿未提供下一季度收入指引', [{ type: 'text', quote: 'x' }])], changes: [], risks: [] }, g);
    expect(honest.facts[0].fabricated).toBe(false);
  });

  it('生成失败 → failed', () => expect(scoreNote(null, gold).failed).toBe(true));
});

describe('aggregate', () => {
  it('准确率只在"提到的"事实上算；覆盖率 / 出处 / 失败率 / 延迟成本', () => {
    const a = scoreNote({ summary: '', highlights: [claim('营收962.2亿美元', [metric('revenue')]), claim('毛利率76%', [metric('gross_margin')], 'needs_review')], guidance_check: [], changes: [], risks: [] }, gold);
    const m = aggregate([a, scoreNote(null, gold)], [{ latency_ms: 100000, cost_usd: 0.02 }, { latency_ms: 300000, cost_usd: 0.04 }]);
    expect(m).toMatchObject({ notes: 2, failureRate: 0.5, numericAccuracy: 0.5, sourceCoverage: 1, sourceAccuracy: 0.5, costPerNoteUsd: 0.03, costTotalUsd: 0.06 });
    expect(m.factCoverage).toBeCloseTo(2 / 6, 3);
    expect(m.latencyP95s).toBe(300);
  });
});

describe('tsmFactsFromRelease', () => {
  it('表格行 + 正文毛利率 / 美元收入；EPS 带脚注字母', () => {
    const t = 'In US dollars, third quarter revenue was $46.72 billion, which increased 41.2% year-over-year and increased 16.2% from the previous quarter.\nGross margin for the quarter was 66.4%, operating margin was 58.7%.\nNet sales\n1,494,243 | 989,918 | 50.9 | 1,270,381 | 17.6\nIncome from operations\n876,445 | 500,685 | 75.0 | 766,603 | 14.3\nNet income\n763,064 | 452,302 | 68.7 | 706,562 | 8.0\nEPS (NT$)\n29.43b\n17.44c';
    expect(tsmFactsFromRelease(t)).toEqual({
      sales: { cur: 1494243e6, py: 989918e6, yoy: 50.9 }, op: { cur: 876445e6, py: 500685e6, yoy: 75.0 }, ni: { cur: 763064e6, py: 452302e6, yoy: 68.7 },
      eps: 29.43, gm: 66.4, usd: 46.72e9, usdYoy: 41.2,
    });
  });
});
