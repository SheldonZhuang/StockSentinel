// 公司 Wiki（129号阶段2）：引文逐字核对、冲突保留两条、增量、预算/余额不足即停
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'research-wiki-'));
process.env.RESEARCH_DB_PATH = path.join(tmp, 'research.db');

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock('../research/llm.js', async importOriginal => ({ ...(await importOriginal()), chat }));

const db = await import('../research/db.js');
const { locateQuote, acceptEntries, updateWiki, getWikiPage, pickChunks } = await import('../research/wiki.js');
const { BudgetExceededError } = await import('../research/llm.js');
await db.getResearchDb();

afterAll(() => { db._closeResearchDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

const TEXT = 'Outlook\nRevenue is expected to be $108.0 billion, plus or minus 2%.\nData Center | revenue grew 117%.';

function seedFiling(accession, filingDate, fq) {
  db.run(`INSERT INTO filings (accession, ticker, cik, form_type, doc_kind, filing_date, period_end, fiscal_year, fiscal_quarter,
          status, fetched_at) VALUES (?, 'NVDA', '1', '8-K', 'earnings_release', ?, '2026-07-26', 2027, ?, 'parsed', 'x')`, [accession, filingDate, fq]);
  db.run(`INSERT INTO chunks (accession, ticker, form_type, filing_date, section, seq, char_start, char_end, source_url, text)
          VALUES (?, 'NVDA', '8-K', ?, 'press_release', 0, 100, ?, 'https://sec.gov/x', ?)`, [accession, filingDate, 100 + TEXT.length, TEXT]);
  return db.get('SELECT * FROM chunks WHERE accession = ?', [accession]);
}
const filingRow = acc => db.get('SELECT * FROM filings WHERE accession = ?', [acc]);

beforeEach(() => {
  for (const t of ['wiki_entries', 'wiki_runs', 'chunks', 'filings']) db.run(`DELETE FROM ${t}`);
  chat.mockReset();
});

describe('locateQuote', () => {
  it('精确匹配；空白差异容忍（表格换行 vs 空格）；太短或不存在返回 null', () => {
    expect(locateQuote(TEXT, 'Revenue is expected to be $108.0 billion')).toEqual([8, 48]);
    const loc = locateQuote(TEXT, 'Outlook Revenue is expected');
    expect(TEXT.slice(...loc)).toBe('Outlook\nRevenue is expected');
    expect(locateQuote(TEXT, 'revenue')).toBe(null);
    expect(locateQuote(TEXT, 'Revenue is expected to be $109.0 billion')).toBe(null);
  });
});

describe('acceptEntries', () => {
  it('引文找不到/块不属于本申报/类别非法 → 拒绝；入库的字符区间是绝对区间', () => {
    const c = seedFiling('a1', '2026-08-26', 2);
    const r = acceptEntries(filingRow('a1'), new Map([[c.id, c]]), [
      { category: 'guidance', key: 'Q3 revenue', title: 'Q3 revenue', value: '$108.0B ±2%', target_period: 'FY2027Q3', chunk_id: c.id, quote: 'Revenue is expected to be $108.0 billion' },
      { category: 'guidance', key: 'Q3 GM', title: 'GM', value: '75%', chunk_id: c.id, quote: 'gross margin is expected to be 75%' },
      { category: 'segment', key: 'Gaming', title: 'Gaming', value: 'x', chunk_id: 9999, quote: 'Revenue is expected to be $108.0 billion' },
      { category: 'rumor', key: 'x', title: 'x', value: 'x', chunk_id: c.id, quote: 'Revenue is expected to be $108.0 billion' },
    ]);
    expect(r).toMatchObject({ accepted: 1, rejected: 3, conflicts: 0 });
    const e = db.get('SELECT * FROM wiki_entries');
    expect(e).toMatchObject({ entry_key: 'q3 revenue', target_period: 'FY2027Q3', char_start: 108, char_end: 148, fiscal_label: 'FY2027Q2', conflict: 0 });
    expect(e.quote).toBe('Revenue is expected to be $108.0 billion');
  });

  it('同键不同值：两条都保留，旧条 superseded_by → 新条，都标 conflict；同值不重复入库', () => {
    const c1 = seedFiling('a1', '2026-05-27', 1);
    const c2 = seedFiling('a2', '2026-08-26', 2);
    const e = (value, c) => ({ category: 'metric_definition', key: 'Data Center revenue', title: 'DC', value, chunk_id: c.id, quote: 'Data Center | revenue grew 117%' });
    acceptEntries(filingRow('a1'), new Map([[c1.id, c1]]), [e('compute and networking', c1)]);
    expect(acceptEntries(filingRow('a2'), new Map([[c2.id, c2]]), [e('compute and networking.', c2)]).rejected).toBe(1);
    // 同一句原文换个说法不算新知识（防模型同文不同述制造假冲突）
    expect(acceptEntries(filingRow('a2'), new Map([[c2.id, c2]]), [e('compute, networking and software', c2)]).rejected).toBe(1);
    // 新申报的另一句原文给出不同说法：口径类是"更新"——两条都保留（旧条指向新条），但不标冲突
    const r = acceptEntries(filingRow('a2'), new Map([[c2.id, c2]]), [{ ...e('compute, networking and software', c2), quote: 'Revenue is expected to be $108.0 billion' }]);
    expect(r).toMatchObject({ accepted: 1, conflicts: 0 });
    const page = getWikiPage('NVDA');
    expect(page.current).toHaveLength(1);
    expect(page.history).toHaveLength(1);
    expect(page.history[0].superseded_by).toBe(page.current[0].id);
    expect([page.current[0].conflict, page.history[0].conflict]).toEqual([0, 0]);
  });

  it('同一目标期间的指引数字变了（上修/下修）→ 真冲突，两条都保留并都标 conflict', () => {
    const c1 = seedFiling('g1', '2026-05-27', 1);
    const c2 = seedFiling('g2', '2026-08-26', 2);
    const g = (c, quote) => ({ category: 'guidance', key: 'Q3 revenue', title: 'Q3 revenue', value: quote, target_period: 'FY2027Q3', chunk_id: c.id, quote });
    acceptEntries(filingRow('g1'), new Map([[c1.id, c1]]), [g(c1, 'Revenue is expected to be $108.0 billion')]);
    c2.text = 'Outlook\nRevenue is expected to be $110.0 billion, plus or minus 2%.';
    const r = acceptEntries(filingRow('g2'), new Map([[c2.id, c2]]), [g(c2, 'Revenue is expected to be $110.0 billion')]);
    expect(r.conflicts).toBe(1);
    const rows = db.all("SELECT conflict, superseded_by FROM wiki_entries WHERE category = 'guidance' ORDER BY id");
    expect(rows.map(x => x.conflict)).toEqual([1, 1]);
    expect(rows[0].superseded_by).not.toBe(null);
  });

  it('isRealConflict：只认指引的数字变化', async () => {
    const { isRealConflict } = await import('../research/wiki.js');
    expect(isRealConflict('guidance', { quote: 'capex of approximately $75 billion in 2025' }, { quote: 'capex in 2025 to approximately $85 billion' })).toBe(true);
    expect(isRealConflict('guidance', { quote: 'range of $130-145 billion' }, { quote: 'expected to be in the range of $130-145 billion' })).toBe(false);
    expect(isRealConflict('segment', { quote: 'revenue $7,178 million' }, { quote: 'revenue $8,752 million' })).toBe(false);
  });
});

describe('updateWiki', () => {
  it('按申报日升序处理；处理过的不再调 LLM', async () => {
    const c2 = seedFiling('a2', '2026-08-26', 2);
    seedFiling('a1', '2026-05-27', 1);
    chat.mockImplementation(async ({ ref }) => ({
      text: JSON.stringify({ entries: ref === 'a2' ? [{ category: 'guidance', key: 'Q3 revenue', title: 't', value: 'v', target_period: 'FY2027Q3', chunk_id: c2.id, quote: 'Revenue is expected to be $108.0 billion' }] : [] }),
      costUsd: 0.002,
    }));
    const s = await updateWiki({ pool: 'backfill', log: () => {} });
    expect(chat.mock.calls.map(c => c[0].ref)).toEqual(['a1', 'a2']);
    expect(chat.mock.calls[0][0]).toMatchObject({ pool: 'backfill', purpose: 'wiki_extract', maxTokens: 6000 });
    expect(s).toMatchObject({ processed: 2, accepted: 1 });
    await updateWiki({ pool: 'backfill', log: () => {} });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('本地预算超限或账户余额不足（402）：立即停，标 budget，下次可续跑', async () => {
    seedFiling('a1', '2026-05-27', 1);
    seedFiling('a2', '2026-08-26', 2);
    chat.mockRejectedValueOnce(new BudgetExceededError('backfill', 'over'));
    let s = await updateWiki({ pool: 'backfill', log: () => {} });
    expect(s.stoppedByBudget).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
    chat.mockRejectedValueOnce(Object.assign(new Error('402'), { response: { status: 402 } }));
    s = await updateWiki({ pool: 'backfill', log: () => {} });
    expect(s.stoppedByBudget).toBe(true);
    expect(db.get("SELECT status FROM wiki_runs WHERE accession = 'a1'").status).toBe('budget');
  });

  it('pickChunks：新闻稿优先；定期报告取 MD&A/业务里带话题标签的块', () => {
    const chunks = [
      { id: 1, section: 'risk_factors', topics: 'guidance' },
      { id: 2, section: 'mdna', topics: '' },
      { id: 3, section: 'mdna', topics: 'capex' },
    ];
    expect(pickChunks(chunks).map(c => c.id)).toEqual([3, 2]);
    expect(pickChunks([...chunks, { id: 9, section: 'press_release', topics: '' }]).map(c => c.id)).toEqual([9]);
  });
});
