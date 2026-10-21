// 研究管线（129号阶段5）：开关、到期判定（初版 / 正式版 / 不重复 / 失败重试上限）、一轮流程（模拟采集与写稿）
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'research-pipeline-'));
process.env.RESEARCH_DB_PATH = path.join(tmp, 'research.db');

const { runIngest, updateWiki, generateNote, sendAdminNotice } = vi.hoisted(() => ({
  runIngest: vi.fn(), updateWiki: vi.fn(), generateNote: vi.fn(), sendAdminNotice: vi.fn().mockResolvedValue({}),
}));
vi.mock('../research/ingest.js', () => ({ runIngest }));
vi.mock('../research/wiki.js', async importOriginal => ({ ...(await importOriginal()), updateWiki }));
vi.mock('../research/agent.js', async importOriginal => ({ ...(await importOriginal()), generateNote }));
vi.mock('../utils/mailer.js', () => ({ sendAdminNotice }));

const db = await import('../research/db.js');
const { researchEnabled, researchTickers, noteDue, runResearchPipeline } = await import('../research/pipeline.js');
await db.getResearchDb();
afterAll(() => { db._closeResearchDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

const filing = (acc, kind, form, fy, fq) => db.run(`INSERT INTO filings (accession, ticker, cik, form_type, doc_kind, filing_date, fiscal_year, fiscal_quarter, status, fetched_at)
  VALUES (?, 'NVDA', '1', ?, ?, '2026-08-26', ?, ?, 'parsed', 'x')`, [acc, form, kind, fy, fq]);
const note = (fl, stage, status, day = new Date().toISOString().slice(0, 10)) => db.run(`INSERT INTO research_notes (ticker, fiscal_label, period_end, version, stage, based_on, status, created_at)
  VALUES ('NVDA', ?, '2026-07-26', 1, ?, '[]', ?, ?)`, [fl, stage, status, `${day} 00:00:00`]);

beforeEach(() => {
  for (const t of ['filings', 'research_notes']) db.run(`DELETE FROM ${t}`);
  runIngest.mockReset().mockResolvedValue({ newFilings: 0 });
  updateWiki.mockReset().mockResolvedValue({ processed: 0 });
  generateNote.mockReset().mockResolvedValue({ status: 'ok', model: 'x-ai/grok-4.7', cost_usd: 0.1 });
});

describe('开关与范围', () => {
  it('默认关；primary 开；replica 需显式允许', () => {
    expect(researchEnabled({})).toBe(false);
    expect(researchEnabled({ RESEARCH_ENABLED: '1' })).toBe(true);
    expect(researchEnabled({ RESEARCH_ENABLED: '1', INSTANCE_ROLE: 'replica' })).toBe(false);
    expect(researchEnabled({ RESEARCH_ENABLED: '1', INSTANCE_ROLE: 'replica', RESEARCH_ON_REPLICA: '1' })).toBe(true);
  });
  it('RESEARCH_TICKERS 限定公司，未知代码忽略', () => {
    expect(researchTickers({ RESEARCH_TICKERS: 'nvda, msft,XYZ' })).toEqual(['NVDA', 'MSFT']);
    expect(researchTickers({})).toHaveLength(8);
  });
});

describe('noteDue', () => {
  it('只有 8-K → 初版；10-Q 到了 → 正式版；已有可用笔记 → 不再生成', () => {
    filing('k8', 'earnings_release', '8-K', 2027, 2);
    expect(noteDue('NVDA')).toMatchObject({ fiscalLabel: 'FY2027Q2', stage: 'preliminary' });
    note('FY2027Q2', 'preliminary', 'ok');
    expect(noteDue('NVDA')).toBe(null);
    filing('q10', 'periodic', '10-Q', 2027, 2);
    expect(noteDue('NVDA')).toMatchObject({ stage: 'final' });
    note('FY2027Q2', 'final', 'needs_review');
    expect(noteDue('NVDA')).toBe(null);
  });
  it('失败的当天最多重试 3 次；前一天的失败不计', () => {
    filing('q10', 'periodic', '10-Q', 2027, 2);
    note('FY2027Q2', 'final', 'failed', '2026-01-01');
    for (let i = 0; i < 2; i++) note('FY2027Q2', 'final', 'failed');
    expect(noteDue('NVDA')).not.toBe(null);
    note('FY2027Q2', 'final', 'failed');
    expect(noteDue('NVDA')).toBe(null);
  });
});

describe('runResearchPipeline', () => {
  it('采集 → Wiki → 为到期的季度生成笔记（日常池）', async () => {
    process.env.RESEARCH_TICKERS = 'NVDA';
    filing('q10', 'periodic', '10-Q', 2027, 2);
    const s = await runResearchPipeline({ log: () => {} });
    expect(runIngest).toHaveBeenCalledWith(expect.objectContaining({ tickers: ['NVDA'] }));
    expect(updateWiki).toHaveBeenCalledWith(expect.objectContaining({ pool: 'research' }));
    expect(generateNote).toHaveBeenCalledWith(expect.objectContaining({ ticker: 'NVDA', fiscalLabel: 'FY2027Q2', pool: 'research' }));
    expect(s.notes).toEqual([expect.objectContaining({ stage: 'final', status: 'ok' })]);
    delete process.env.RESEARCH_TICKERS;
  });

  it('采集抛错 → 不抛给 cron，告警管理员', async () => {
    runIngest.mockRejectedValue(new Error('EDGAR down'));
    const s = await runResearchPipeline({ log: () => {} });
    expect(s.error).toBe('EDGAR down');
    expect(sendAdminNotice).toHaveBeenCalled();
  });
});
