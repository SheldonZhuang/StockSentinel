// 研究检索（129号阶段2）：分词/词干、BM25 排序与过滤、中文问题解析
import { describe, it, expect } from 'vitest';
import { tokenize, stem, buildIndex, searchIndex } from '../research/search.js';
import { parseQuestion, parsePeriod } from '../research/query.js';

describe('tokenize / stem', () => {
  it('小写、去停用词、复数与动词后缀归一', () => {
    expect(tokenize('Revenues increased for the Quarter')).toEqual(['revenue', 'increas']);
    expect(stem('expenditures')).toBe('expenditure');
    expect(stem('companies')).toBe('company');
    expect(stem('2026')).toBe('2026');
    expect(tokenize("NVIDIA's Data Center $89.0 billion")).toEqual(['nvidia', 'data', 'center', '89.0', 'billion']);
  });
});

describe('BM25', () => {
  const docs = [
    { id: 1, ticker: 'A', text: 'Data Center revenue was $89.0 billion, up 117% from a year ago.' },
    { id: 2, ticker: 'A', text: 'Gaming revenue was $4.3 billion. Revenue revenue revenue.' },
    { id: 3, ticker: 'B', text: 'Data Center segment revenue was $6.7 billion.' },
    { id: 4, ticker: 'A', text: 'Risk factors: export controls may affect our data center business.' },
  ];
  const idx = buildIndex(docs);

  it('多词命中排前；稀有词权重更高；长度归一（短块同等命中排前）', () => {
    const hits = searchIndex(idx, 'data center revenue', { k: 4 });
    // 1 与 3 都命中三词，3 更短 → BM25 长度归一后排第一；4 只命中两词
    expect(hits.map(h => h.doc.id).slice(0, 2)).toEqual([3, 1]);
    expect(hits.map(h => h.doc.id)).toContain(4);
    // 稀有词 export 只在 4 里：单独查它时 4 排第一
    expect(searchIndex(idx, 'export revenue')[0].doc.id).toBe(4);
  });

  it('filter 生效；boost 改变排序', () => {
    expect(searchIndex(idx, 'data center revenue', { filter: d => d.ticker === 'B' }).map(h => h.doc.id)).toEqual([3]);
    const boosted = searchIndex(idx, 'data center revenue', { boost: d => (d.id === 4 ? 10 : 1) });
    expect(boosted[0].doc.id).toBe(4);
  });

  it('同分按 id 排序，结果可复现；无命中返回空', () => {
    const a = searchIndex(idx, 'billion', { k: 4 }).map(h => h.doc.id);
    expect(searchIndex(idx, 'billion', { k: 4 }).map(h => h.doc.id)).toEqual(a);
    expect(searchIndex(idx, 'zzzz')).toEqual([]);
  });
});

describe('parsePeriod / parseQuestion', () => {
  it.each([
    ['微软2026财年第一季度资本开支', { fiscalYear: 2026, fiscalQuarter: 1 }],
    ['谷歌2026年第二季度', { fiscalYear: 2026, fiscalQuarter: 2 }],
    ['NVDA FY2027Q2 revenue', { fiscalYear: 2027, fiscalQuarter: 2 }],
    ['2026 Q3 指引', { fiscalYear: 2026, fiscalQuarter: 3 }],
    ['微软2026财年全年资本开支', { fiscalYear: 2026, fiscalQuarter: 4 }],
    ['微软2026财年收入', { fiscalYear: 2026 }],
    ['最近的资本开支', {}],
  ])('%s', (q, want) => expect(parsePeriod(q)).toEqual(want));

  it('"X 季度财报给出的 Y 季度指引" 取第一个季度（财报所在季）', () => {
    expect(parsePeriod('英伟达2027财年第二季度财报给出的第三季度收入指引')).toEqual({ fiscalYear: 2027, fiscalQuarter: 2 });
  });

  it('公司名转过滤条件，术语转英文检索词与话题，英文专名保留', () => {
    const p = parseQuestion('微软2026财年第一季度Azure收入增长多少');
    expect(p.tickers).toEqual(['MSFT']);
    expect(p.terms).toContain('revenue');
    expect(p.terms).toContain('Azure');
    expect(p.terms).not.toMatch(/microsoft/i);
    const c = parseQuestion('亚马逊资本开支');
    expect(c).toMatchObject({ tickers: ['AMZN'], topics: ['capex'] });
    expect(parseQuestion('英伟达的风险因素').sections).toEqual(['risk_factors']);
    expect(parseQuestion('台积电3纳米占比').terms).toMatch(/nanometer 3/);
  });
});
