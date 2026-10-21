// 研究文档采集（129号阶段1）：EDGAR 申报 → 原文缓存 → 纯文本 → 章节 → 块（带出处）→ research.db。
// 增量：filings 表里已 parsed/skipped 的 accession 不再下载；failed 的最多重试 MAX_ATTEMPTS 次。
// 原文缓存：<filingsDir>/<accession>/<document>.gz（HTML 压缩原件，改进解析器时可离线重解析）
//          <filingsDir>/<accession>/<document>.txt（htmlToText 输出，chunks.char_start/end 的基准）
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import cfg from '../config/research.config.js';
import { edgarGet, submissionsUrl, archiveBase } from '../utils/edgar-client.js';
import { htmlToText, splitSections, chunkSection, tagTopics } from './parse.js';
import {
  classifyFiling, flattenRecent, periodForFiling, nominalQuarterEnds, findDocumentByType, fiscalLabel,
} from './filings.js';
import { getResearchDb, flush, all, get, run, tx, filingsDir } from './db.js';
import { refreshXbrlFacts } from './xbrl.js';
import { budgetStatus } from './llm.js';
import { indexAllIxbrl } from './ixbrl.js';

const MAX_ATTEMPTS = 3;
const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

let running = false;
export const isIngestRunning = () => running;

/** 某公司研究窗口内的财季（最近 N 个已结束名义季度，降序） */
export function expectedQuarters(fye, asOf, n = cfg.QUARTERS_TO_KEEP) {
  return nominalQuarterEnds(fye, asOf, n);
}

/**
 * 从 submissions 选出窗口内、研究范围内的申报（纯函数，便于测试）。
 * @returns {Array<row & {kind, periodEnd, fiscalYear, fiscalQuarter, label}>}
 */
export function selectFilings(submissions, company, asOf, n = cfg.QUARTERS_TO_KEEP) {
  const fye = submissions.fiscalYearEnd;
  const labels = new Set(expectedQuarters(fye, asOf, n).map(q => fiscalLabel(q.fiscalYear, q.fiscalQuarter)));
  const out = [];
  for (const row of flattenRecent(submissions.filings?.recent)) {
    if (row.filingDate > asOf) continue;
    const kind = classifyFiling(row, company);
    if (!kind) continue;
    const p = periodForFiling(row, kind, fye);
    if (!p) continue;
    const label = fiscalLabel(p.fiscalYear, p.fiscalQuarter);
    if (labels.has(label)) out.push({ ...row, kind, ...p, label });
  }
  return out;
}

/** 解析一份文档：纯文本 → 章节 → 块（纯函数）。ifrs_financials 整篇即财报 */
export function buildChunks(text, formType, kind) {
  let sections = splitSections(text, formType);
  if (kind === 'ifrs_financials') sections = sections.map(s => ({ ...s, section: 'financial_statements' }));
  const chunks = [];
  for (const sec of sections) {
    for (const c of chunkSection(text, sec, { target: cfg.CHUNK_TARGET_CHARS, max: cfg.CHUNK_MAX_CHARS })) {
      const body = text.slice(c.start, c.end);
      chunks.push({ ...c, item: sec.item, text: body, topics: tagTopics(body).join(',') });
    }
  }
  return { sections, chunks };
}

/** 单份申报的数据质量问题（纯函数）：解析为空 / 必需章节缺失 / 必需章节过短 */
export function filingIssues(formType, text, sections) {
  if (!text || text.length < 200) return [{ kind: 'parse_failed', detail: `text ${text?.length || 0} chars` }];
  const issues = [];
  for (const name of cfg.REQUIRED_SECTIONS[formType] || []) {
    const s = sections.find(x => x.section === name);
    if (!s) issues.push({ kind: 'missing_section', detail: name });
    else if (s.end - s.start < cfg.MIN_SECTION_CHARS) issues.push({ kind: 'empty_section', detail: `${name} ${s.end - s.start} chars` });
  }
  return issues;
}

/**
 * 覆盖矩阵与缺季/重复判定（纯函数）。
 * 缺文件时：期末 + 法定期限已过 → missing_quarter；否则 pending_quarter（还没到该交的时候）。
 */
export function coverageIssues({ ticker, filer, fye, filingRows, asOf }) {
  const issues = [];
  const quarters = expectedQuarters(fye, asOf);
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  for (const q of quarters) {
    const label = fiscalLabel(q.fiscalYear, q.fiscalQuarter);
    const exp = cfg.EXPECTED_DOCS[filer][q.fiscalQuarter === 4 ? 'q4' : 'quarter'];
    const inQ = filingRows.filter(f => f.fiscal_year === q.fiscalYear && f.fiscal_quarter === q.fiscalQuarter);
    for (const kind of exp) {
      const got = inQ.filter(f => f.doc_kind === kind && f.status === 'parsed');
      if (got.length > 1) {
        issues.push({ ticker, period_end: q.periodEnd, kind: 'duplicate', detail: `${label} ${kind} ×${got.length}: ${got.map(g => g.accession).join(', ')}` });
      }
      if (got.length) continue;
      const deadlineKey = kind === 'annual' && filer === 'foreign' ? 'annual_foreign' : kind;
      const due = Date.parse(`${q.periodEnd}T00:00:00Z`) + cfg.DOC_DEADLINE_DAYS[deadlineKey] * 86400000;
      const failed = inQ.find(f => f.doc_kind === kind && f.status === 'failed');
      issues.push({
        ticker,
        period_end: q.periodEnd,
        accession: failed?.accession || null,
        kind: asOfMs > due ? 'missing_quarter' : 'pending_quarter',
        detail: `${label} ${kind}${failed ? ` (failed: ${failed.error})` : ''}`,
      });
    }
  }
  return issues;
}

function writeCache(accession, document, html, text) {
  const dir = path.join(filingsDir(), accession);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${document}.gz`), zlib.gzipSync(html));
  fs.writeFileSync(path.join(dir, `${document}.txt`), text);
}

function readCachedHtml(accession, document) {
  const p = path.join(filingsDir(), accession, `${document}.gz`);
  return fs.existsSync(p) ? zlib.gunzipSync(fs.readFileSync(p)).toString('utf8') : null;
}

/** 处理一份申报：定位文档 → 下载（有缓存则跳过）→ 解析 → 事务写入；返回本份的数据质量问题 */
async function processFiling(f, company, ticker, ctx) {
  const base = archiveBase(company.cik, f.accession);
  const indexUrl = `${base}/${f.accession}-index.htm`;
  const prev = get('SELECT attempts FROM filings WHERE accession = ?', [f.accession]);
  const attempts = (prev?.attempts || 0) + 1;
  let document = null;
  try {
    // 定期报告解析主文档；8-K / 6-K 解析 EX-99.1（新闻稿或季度合并财报）
    if (f.kind === 'periodic' || f.kind === 'annual') {
      document = f.primaryDocument;
    } else {
      ctx.requests++;
      const idx = await edgarGet(indexUrl, { responseType: 'text' });
      document = findDocumentByType(idx.data, 'EX-99.1');
      if (!document) throw new Error('EX-99.1 not found in filing index');
    }
    let html = readCachedHtml(f.accession, document);
    if (html == null) {
      ctx.requests++;
      const res = await edgarGet(`${base}/${document}`, { responseType: 'text', timeout: 60000 });
      html = String(res.data);
    }
    const text = htmlToText(html);
    const { sections, chunks } = buildChunks(text, f.form, f.kind);
    writeCache(f.accession, document, html, text);
    const url = `${base}/${document}`;
    tx(() => {
      run('DELETE FROM chunks WHERE accession = ?', [f.accession]);
      for (const c of chunks) {
        run(`INSERT INTO chunks (accession, ticker, form_type, filing_date, period_end, section, item, seq,
               char_start, char_end, topics, source_url, text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [f.accession, ticker, f.form, f.filingDate, f.periodEnd, c.section, c.item || null, c.seq,
          c.start, c.end, c.topics, url, c.text]);
      }
      upsertFiling(f, company, ticker, {
        document, url, indexUrl, attempts, status: 'parsed', error: null,
        sha256: crypto.createHash('sha256').update(html).digest('hex'),
        textChars: text.length, sectionCount: sections.length, chunkCount: chunks.length,
      });
    });
    return filingIssues(f.form, text, sections).map(i => ({ ...i, ticker, period_end: f.periodEnd, accession: f.accession }));
  } catch (err) {
    upsertFiling(f, company, ticker, {
      document, url: document ? `${base}/${document}` : null, indexUrl, attempts, status: 'failed',
      error: String(err.message || err).slice(0, 300),
    });
    ctx.failed++;
    return [{ ticker, period_end: f.periodEnd, accession: f.accession, kind: 'parse_failed', detail: String(err.message || err).slice(0, 300) }];
  }
}

function upsertFiling(f, company, ticker, o) {
  run(`INSERT INTO filings (accession, ticker, cik, form_type, doc_kind, filing_date, report_date, period_end,
         fiscal_year, fiscal_quarter, primary_doc, document, document_url, index_url, status, error, sha256,
         text_chars, section_count, chunk_count, fetched_at, attempts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(accession) DO UPDATE SET status=excluded.status, error=excluded.error,
         document=excluded.document, document_url=excluded.document_url, sha256=excluded.sha256,
         text_chars=excluded.text_chars, section_count=excluded.section_count, chunk_count=excluded.chunk_count,
         fetched_at=excluded.fetched_at, attempts=excluded.attempts`,
  [f.accession, ticker, company.cik, f.form, f.kind, f.filingDate, f.reportDate, f.periodEnd,
    f.fiscalYear, f.fiscalQuarter, f.primaryDocument, o.document, o.url, o.indexUrl, o.status, o.error,
    o.sha256 || null, o.textChars ?? null, o.sectionCount ?? null, o.chunkCount ?? null, nowIso(), o.attempts]);
}

/**
 * 采集入口。同一进程内互斥（手动触发与日后的定时任务不会叠跑）。
 * @param {{tickers?: string[], asOf?: string, trigger?: string, log?: Function}} opts
 * @returns 本次运行摘要
 */
export async function runIngest({ tickers, asOf, trigger = 'manual', log = console.log } = {}) {
  if (running) return { skipped: true, reason: 'already running' };
  running = true;
  await getResearchDb();
  const day = asOf || new Date().toISOString().slice(0, 10);
  const runId = `${nowIso().replace(/[-: ]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  const ctx = { requests: 0, failed: 0, newFilings: 0, skippedExisting: 0 };
  const issues = [];
  run('INSERT INTO ingest_runs (run_id, trigger, started_at) VALUES (?,?,?)', [runId, trigger, nowIso()]);
  let fatal = null;
  try {
    const list = (tickers?.length ? tickers : Object.keys(cfg.RESEARCH_COMPANIES)).map(t => t.toUpperCase());
    for (const ticker of list) {
      const company = cfg.RESEARCH_COMPANIES[ticker];
      if (!company) { issues.push({ ticker, kind: 'parse_failed', detail: 'ticker not in RESEARCH_COMPANIES' }); continue; }
      let sub;
      try {
        ctx.requests++;
        sub = (await edgarGet(submissionsUrl(company.cik))).data;
      } catch (err) {
        issues.push({ ticker, kind: 'parse_failed', detail: `submissions: ${err.message}` });
        log(`[research] ${ticker} submissions failed: ${err.message}`);
        continue;
      }
      let newForTicker = 0;
      for (const f of selectFilings(sub, company, day)) {
        const prev = get('SELECT status, attempts FROM filings WHERE accession = ?', [f.accession]);
        if (prev && (prev.status !== 'failed' || prev.attempts >= MAX_ATTEMPTS)) { ctx.skippedExisting++; continue; }
        issues.push(...await processFiling(f, company, ticker, ctx));
        ctx.newFilings++;
        newForTicker++;
        flush();
        log(`[research] ${ticker} ${f.label} ${f.form} ${f.accession} done`);
      }
      // XBRL 事实：有新申报或该公司还没有事实时才重拉（companyfacts 单家 1~5MB，增量运行不重复下载）。
      // 起点取窗口最早季度再往前 15 个月，保证最早一季也能算同比
      if (newForTicker || !get('SELECT 1 FROM xbrl_facts WHERE ticker = ? LIMIT 1', [ticker])) {
        const oldest = expectedQuarters(sub.fiscalYearEnd, day).at(-1).periodEnd;
        const since = new Date(Date.parse(oldest) - 456 * 86400000).toISOString().slice(0, 10);
        try {
          ctx.requests++;
          ctx.xbrlFacts = (ctx.xbrlFacts || 0) + await refreshXbrlFacts(ticker, company.cik, since);
          flush();
        } catch (err) {
          issues.push({ ticker, kind: 'parse_failed', detail: `companyfacts: ${err.message}` });
        }
      }
      // Inline XBRL（分部/产品线等带维度的事实）：对尚未建索引的定期报告补建，原件已在本地缓存，不发请求
      if (newForTicker || !get('SELECT 1 FROM ixbrl_facts WHERE ticker = ? LIMIT 1', [ticker])) {
        ctx.ixbrlFacts = (ctx.ixbrlFacts || 0) + indexAllIxbrl().facts;
        flush();
      }
      const rows = all('SELECT accession, doc_kind, status, error, fiscal_year, fiscal_quarter FROM filings WHERE ticker = ?', [ticker]);
      issues.push(...coverageIssues({ ticker, filer: company.filer, fye: sub.fiscalYearEnd, filingRows: rows, asOf: day }));
    }
  } catch (err) {
    fatal = err;
  } finally {
    // 失败也要把本次问题与摘要落库，管理后台才能看到
    try {
      tx(() => {
        for (const i of issues) {
          run('INSERT INTO dq_issues (run_id, ticker, period_end, accession, kind, detail, created_at) VALUES (?,?,?,?,?,?,?)',
            [runId, i.ticker || null, i.period_end || null, i.accession || null, i.kind, i.detail || null, nowIso()]);
        }
        run(`UPDATE ingest_runs SET finished_at=?, new_filings=?, skipped_existing=?, failed=?, requests=?, dq_count=?, error=?
             WHERE run_id=?`,
        [nowIso(), ctx.newFilings, ctx.skippedExisting, ctx.failed, ctx.requests, issues.length, fatal ? String(fatal.message) : null, runId]);
      });
      flush();
    } finally {
      running = false;
    }
  }
  if (fatal) throw fatal;
  const byKind = {};
  for (const i of issues) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
  return { runId, ...ctx, dq: byKind };
}

/** 管理后台用：最近一次运行摘要 + 覆盖矩阵 + 本次问题清单 */
export async function getIngestStatus() {
  await getResearchDb();
  const lastRun = get('SELECT * FROM ingest_runs ORDER BY rowid DESC LIMIT 1');
  const issues = lastRun ? all('SELECT ticker, period_end, accession, kind, detail FROM dq_issues WHERE run_id = ? ORDER BY ticker, period_end DESC', [lastRun.run_id]) : [];
  const coverage = all(`SELECT ticker, fiscal_year, fiscal_quarter, period_end, doc_kind, form_type, status, accession,
                               filing_date, document_url, chunk_count
                        FROM filings ORDER BY ticker, fiscal_year DESC, fiscal_quarter DESC, doc_kind`);
  const totals = get(`SELECT COUNT(*) AS filings, SUM(CASE WHEN status='parsed' THEN 1 ELSE 0 END) AS parsed,
                             (SELECT COUNT(*) FROM chunks) AS chunks FROM filings`);
  const wiki = all(`SELECT w.ticker, COUNT(DISTINCT w.accession) AS filings, SUM(w.status = 'done') AS done,
                           SUM(w.status IN ('failed','budget')) AS blocked,
                           (SELECT COUNT(*) FROM wiki_entries e WHERE e.ticker = w.ticker AND e.superseded_by IS NULL) AS entries,
                           (SELECT COUNT(*) FROM wiki_entries e WHERE e.ticker = w.ticker AND e.conflict = 1) AS conflicts
                    FROM wiki_runs w GROUP BY w.ticker ORDER BY w.ticker`);
  return { running, lastRun, totals, coverage, issues, wiki, budget: budgetStatus() };
}
