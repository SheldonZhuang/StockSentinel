// 研究 Agent 阶段1（129号）：申报分类/财季归属/覆盖检查的纯函数 + runIngest 端到端
// （mock EDGAR，真实 sql.js 临时库与临时缓存目录：出处字段完整性、增量不重复下载、失败重试与数据质量记录）
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'research-test-'));
process.env.RESEARCH_DB_PATH = path.join(tmp, 'research.db');
process.env.RESEARCH_FILINGS_DIR = path.join(tmp, 'filings');

const { edgarGet } = vi.hoisted(() => ({ edgarGet: vi.fn() }));
vi.mock('../utils/edgar-client.js', async importOriginal => ({ ...(await importOriginal()), edgarGet }));

const {
  fiscalPeriodFor, quarterForRelease, nominalQuarterEnds, classifyFiling, findDocumentByType, periodForFiling,
} = await import('../research/filings.js');
const { selectFilings, coverageIssues, filingIssues, runIngest, getIngestStatus } = await import('../research/ingest.js');
const { RESEARCH_COMPANIES } = await import('../config/research.config.js');
const db = await import('../research/db.js');

afterAll(() => {
  db._closeResearchDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('财季归属', () => {
  it.each([
    ['2026-07-26', '0131', 2027, 2], // NVDA 52/53 周
    ['2026-01-25', '0131', 2026, 4],
    ['2026-03-31', '0630', 2026, 3], // MSFT
    ['2026-08-02', '1101', 2026, 3], // AVGO
    ['2025-12-27', '1226', 2025, 4], // AMD
    ['2026-09-30', '1231', 2026, 3],
  ])('%s fye=%s → FY%iQ%i', (p, fye, fy, fq) => {
    expect(fiscalPeriodFor(p, fye)).toEqual({ fiscalYear: fy, fiscalQuarter: fq });
  });

  it('新闻稿归属到申报日前最近一个已结束季度', () => {
    expect(quarterForRelease('2026-07-29', '0630')).toMatchObject({ fiscalYear: 2026, fiscalQuarter: 4 });
    expect(quarterForRelease('2026-08-26', '0131')).toMatchObject({ fiscalYear: 2027, fiscalQuarter: 2 });
    expect(quarterForRelease('2026-01-28', '0630')).toMatchObject({ periodEnd: '2025-12-31', fiscalYear: 2026, fiscalQuarter: 2 });
  });

  it('名义季末降序、数量正确', () => {
    const q = nominalQuarterEnds('0630', '2026-10-21', 8);
    expect(q).toHaveLength(8);
    expect(q[0]).toMatchObject({ periodEnd: '2026-09-30', fiscalYear: 2027, fiscalQuarter: 1 });
    expect(q[7]).toMatchObject({ periodEnd: '2024-12-31', fiscalYear: 2025, fiscalQuarter: 2 });
    expect(nominalQuarterEnds('1231', '2026-10-21', 1)).toHaveLength(1);
  });
});

describe('classifyFiling', () => {
  const dom = RESEARCH_COMPANIES.MSFT;
  const tsm = RESEARCH_COMPANIES.TSM;
  it('境内申报人：10-Q/10-K/8-K(2.02)，修正案与其他 8-K 不收', () => {
    expect(classifyFiling({ form: '10-Q' }, dom)).toBe('periodic');
    expect(classifyFiling({ form: '10-K' }, dom)).toBe('annual');
    expect(classifyFiling({ form: '8-K', items: '2.02,9.01' }, dom)).toBe('earnings_release');
    expect(classifyFiling({ form: '8-K', items: '5.02' }, dom)).toBe(null);
    expect(classifyFiling({ form: '10-K/A' }, dom)).toBe(null);
  });
  it('TSM：20-F 与两类 6-K，月营收/董事会决议 6-K 不收', () => {
    expect(classifyFiling({ form: '20-F' }, tsm)).toBe('annual');
    expect(classifyFiling({ form: '6-K', primaryDocument: 'tsm-20261015x6k.htm' }, tsm)).toBe('earnings_release');
    expect(classifyFiling({ form: '6-K', primaryDocument: 'tsm-fsx20260814x6k.htm' }, tsm)).toBe('ifrs_financials');
    expect(classifyFiling({ form: '6-K', primaryDocument: 'tsm-revenue20261008.htm' }, tsm)).toBe(null);
    expect(classifyFiling({ form: '6-K', primaryDocument: 'tsm-boardx20260811.htm' }, tsm)).toBe(null);
    expect(classifyFiling({ form: '10-Q' }, tsm)).toBe(null);
  });
  it('8-K 的 reportDate 是事件日，按申报日推算财季；定期报告用 reportDate', () => {
    expect(periodForFiling({ form: '8-K', filingDate: '2026-07-29', reportDate: '2026-07-29' }, 'earnings_release', '0630'))
      .toMatchObject({ fiscalYear: 2026, fiscalQuarter: 4 });
    expect(periodForFiling({ form: '10-Q', filingDate: '2026-08-27', reportDate: '2026-07-26' }, 'periodic', '0131'))
      .toEqual({ periodEnd: '2026-07-26', fiscalYear: 2027, fiscalQuarter: 2 });
  });
});

describe('findDocumentByType', () => {
  const idx = `<table><tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
    <tr><td>1</td><td>8-K</td><td><a href="/Archives/edgar/data/1/2/msft-8k.htm">msft-8k.htm</a></td><td>8-K</td><td>1</td></tr>
    <tr><td>2</td><td>EX-99.1</td><td><a href="/Archives/edgar/data/1/2/msft-ex99_1.htm">msft-ex99_1.htm</a></td><td>EX-99.1</td><td>2</td></tr></table>`;
  it('按 Type 列精确匹配', () => expect(findDocumentByType(idx, 'EX-99.1')).toBe('msft-ex99_1.htm'));
  it('精确类型不存在时退到同前缀', () => expect(findDocumentByType(idx.replace('<td>EX-99.1</td><td>2', '<td>EX-99.01</td><td>2'), 'EX-99.1')).toBe('msft-ex99_1.htm'));
  it('没有则 null', () => expect(findDocumentByType(idx, 'EX-99.2')).toBe(null));
});

describe('数据质量判定', () => {
  it('必需章节缺失 / 过短 / 解析为空', () => {
    expect(filingIssues('10-Q', '', [])).toEqual([{ kind: 'parse_failed', detail: 'text 0 chars' }]);
    const text = 'x'.repeat(5000);
    const issues = filingIssues('10-Q', text, [{ section: 'mdna', start: 0, end: 4000 }, { section: 'risk_factors', start: 4000, end: 4100 }]);
    expect(issues).toEqual([
      { kind: 'missing_section', detail: 'financial_statements' },
      { kind: 'empty_section', detail: 'risk_factors 100 chars' },
    ]);
  });

  it('缺季：过期限记 missing，未到期记 pending；同类两份记 duplicate', () => {
    const rows = [
      { accession: 'a1', doc_kind: 'earnings_release', status: 'parsed', fiscal_year: 2026, fiscal_quarter: 3 },
      { accession: 'a2', doc_kind: 'earnings_release', status: 'parsed', fiscal_year: 2026, fiscal_quarter: 3 },
      { accession: 'a3', doc_kind: 'periodic', status: 'failed', error: 'boom', fiscal_year: 2026, fiscal_quarter: 2 },
    ];
    const issues = coverageIssues({ ticker: 'X', filer: 'domestic', fye: '1231', filingRows: rows, asOf: '2026-10-21' });
    const k = issues.map(i => `${i.kind}:${i.detail.split(' ')[0]}:${i.detail.split(' ')[1]}`);
    expect(k).toContain('duplicate:FY2026Q3:earnings_release');
    expect(k).toContain('pending_quarter:FY2026Q3:periodic'); // 9/30 期末，10-Q 期限未到
    expect(k).toContain('missing_quarter:FY2026Q2:periodic');
    expect(issues.find(i => i.detail.startsWith('FY2026Q2 periodic')).detail).toContain('failed: boom');
    expect(k).toContain('missing_quarter:FY2026Q2:earnings_release');
  });
});

// ---- runIngest 端到端（mock EDGAR） ----
const SUB = {
  fiscalYearEnd: '1231',
  filings: {
    recent: {
      accessionNumber: ['0000000001-26-000002', '0000000001-26-000001', '0000000001-26-000003', '0000000001-26-000004'],
      form: ['10-Q', '8-K', '8-K', '10-Q/A'],
      filingDate: ['2026-08-01', '2026-07-28', '2026-07-01', '2026-08-05'],
      reportDate: ['2026-06-30', '2026-07-28', '2026-07-01', '2026-06-30'],
      items: ['', '2.02,9.01', '5.02', ''],
      primaryDocument: ['x-20260630.htm', 'x-8k.htm', 'x-8k2.htm', 'x-a.htm'],
    },
  },
};
const COMPANY_FACTS = { facts: { 'us-gaap': { Revenues: { units: { USD: [{ start: '2026-04-01', end: '2026-06-30', val: 50e9, accn: '0000000001-26-000002', filed: '2026-08-01', form: '10-Q', fy: 2026, fp: 'Q2' }] } } } } };
const filler = n => `<p>${'Lorem ipsum dolor sit amet. '.repeat(n)}</p>`;
const TENQ = `<html><body><p>PART I</p><p>Item 1. Financial Statements</p><p>Item 2. Management's Discussion and Analysis</p>
  <p>PART II</p><p>Item 1A. Risk Factors</p>
  <p>PART I</p><p>Item 1. Financial Statements</p>${filler(80)}
  <p>Item 2. Management's Discussion and Analysis of Financial Condition</p><p>Cloud segment revenue was $10 billion.</p>${filler(80)}
  <p>PART II</p><p>Item 1A. Risk Factors</p>${filler(80)}</body></html>`;
const INDEX = `<table><tr><td>2</td><td>EX-99.1</td><td><a href="/x/ex99.htm">ex99.htm</a></td><td>EX-99.1</td><td>1</td></tr></table>`;
const PRESS = `<html><body><p>X Corp reports Q2 results. Revenue $50 billion.</p>${filler(30)}</body></html>`;

function mockEdgar({ failDoc = false } = {}) {
  edgarGet.mockImplementation(async url => {
    if (url.includes('/submissions/')) return { data: SUB };
    if (url.includes('/companyfacts/')) return { data: COMPANY_FACTS };
    if (url.endsWith('-index.htm')) return { data: INDEX };
    if (url.endsWith('/ex99.htm')) return { data: PRESS };
    if (url.endsWith('/x-20260630.htm')) {
      if (failDoc) throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } });
      return { data: TENQ };
    }
    throw new Error(`unexpected url ${url}`);
  });
}

describe('runIngest', () => {
  beforeAll(() => {
    // 测试只放一家公司，避免依赖真实 8 家配置
    RESEARCH_COMPANIES.TESTCO = { cik: '0000000001', name: 'Test', filer: 'domestic' };
  });
  afterAll(() => { delete RESEARCH_COMPANIES.TESTCO; });
  beforeEach(() => { edgarGet.mockReset(); }); // 不能写成表达式：钩子返回函数会被 vitest 当清理函数调用

  it('首跑：只收 10-Q 与 8-K(2.02)，块的出处字段完整且 slice 与缓存文本一致', async () => {
    mockEdgar();
    const s = await runIngest({ tickers: ['TESTCO'], asOf: '2026-10-21', log: () => {} });
    expect(s.newFilings).toBe(2);
    expect(s.failed).toBe(0);
    const filings = db.all('SELECT * FROM filings ORDER BY accession');
    expect(filings.map(f => [f.form_type, f.doc_kind, f.status, f.fiscal_year, f.fiscal_quarter])).toEqual([
      ['8-K', 'earnings_release', 'parsed', 2026, 2],
      ['10-Q', 'periodic', 'parsed', 2026, 2],
    ]);
    expect(filings[0].document).toBe('ex99.htm');

    const chunks = db.all('SELECT c.*, f.document FROM chunks c JOIN filings f USING(accession)');
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      for (const k of ['accession', 'ticker', 'form_type', 'filing_date', 'period_end', 'section', 'source_url', 'text']) {
        expect(c[k], k).toBeTruthy();
      }
      expect(c.char_end).toBeGreaterThan(c.char_start);
      expect(c.source_url).toBe(`https://www.sec.gov/Archives/edgar/data/1/000000000126000${c.form_type === '8-K' ? '001' : '002'}/${c.document}`);
      const txt = fs.readFileSync(path.join(process.env.RESEARCH_FILINGS_DIR, c.accession, `${c.document}.txt`), 'utf8');
      expect(txt.slice(c.char_start, c.char_end)).toBe(c.text);
    }
    const secs = new Set(chunks.filter(c => c.form_type === '10-Q').map(c => c.section));
    expect([...secs].sort()).toEqual(['financial_statements', 'mdna', 'risk_factors']);
    expect(chunks.some(c => c.topics.includes('segment_revenue'))).toBe(true);
    expect(fs.existsSync(path.join(process.env.RESEARCH_FILINGS_DIR, '0000000001-26-000002', 'x-20260630.htm.gz'))).toBe(true);
    // 落盘了
    expect(fs.existsSync(process.env.RESEARCH_DB_PATH)).toBe(true);
    // XBRL 事实随首跑入库
    expect(s.xbrlFacts).toBe(1);
    expect(db.get('SELECT value FROM xbrl_facts WHERE ticker = ?', ['TESTCO']).value).toBe(50e9);
  });

  it('重跑：已处理的申报零下载（只请求 submissions）', async () => {
    mockEdgar();
    const s = await runIngest({ tickers: ['TESTCO'], asOf: '2026-10-21', log: () => {} });
    expect(s.newFilings).toBe(0);
    expect(s.skippedExisting).toBe(2);
    expect(edgarGet).toHaveBeenCalledTimes(1);
    expect(edgarGet.mock.calls[0][0]).toContain('/submissions/');
  });

  it('下载失败：记 failed + 数据质量问题，后续运行重试，最多 3 次', async () => {
    db.run("DELETE FROM chunks WHERE accession = '0000000001-26-000002'");
    db.run("DELETE FROM filings WHERE accession = '0000000001-26-000002'");
    // 原文缓存也要删：否则直接读缓存，不会走下载
    fs.rmSync(path.join(process.env.RESEARCH_FILINGS_DIR, '0000000001-26-000002'), { recursive: true, force: true });
    mockEdgar({ failDoc: true });
    for (let i = 1; i <= 4; i++) {
      const s = await runIngest({ tickers: ['TESTCO'], asOf: '2026-10-21', log: () => {} });
      expect(s.failed).toBe(i <= 3 ? 1 : 0);
    }
    const f = db.get("SELECT status, attempts, error FROM filings WHERE accession = '0000000001-26-000002'");
    expect(f).toMatchObject({ status: 'failed', attempts: 3 });
    expect(f.error).toContain('404');

    const st = await getIngestStatus();
    expect(st.lastRun.failed).toBe(0);
    // 失败到期后的覆盖检查：Q2 10-Q 期限已过 → missing_quarter，附失败原因
    expect(st.issues.find(i => i.kind === 'missing_quarter' && i.detail.startsWith('FY2026Q2 periodic')).detail).toContain('404');
    expect(st.coverage.length).toBe(2);
  });

  it('同进程内互斥', async () => {
    let release;
    edgarGet.mockImplementation(url => (url.includes('/companyfacts/')
      ? Promise.resolve({ data: COMPANY_FACTS })
      : new Promise(r => { release = () => r({ data: { fiscalYearEnd: '1231', filings: { recent: {} } } }); })));
    const first = runIngest({ tickers: ['TESTCO'], asOf: '2026-10-21', log: () => {} });
    await new Promise(r => setTimeout(r, 10));
    await expect(runIngest({ tickers: ['TESTCO'], log: () => {} })).resolves.toMatchObject({ skipped: true });
    release();
    await first;
  });
});
