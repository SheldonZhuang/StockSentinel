// 研究 Agent 独立库 research.db（129号）。
// 为什么不进主库：utils/storage.js 每次写入都全量 db.export() 落盘（O(库大小)），主库 430KB 时无感；
// 8 家 × 8 季的切块正文有几十 MB，放进主库会拖慢全站每一次写入（登录、埋点、快照）。
// 也不进 GitHub 备份：内容全部可从 EDGAR 重新拉取，丢了重跑 backfill 即可。
// 落盘策略：写操作只改内存，调用方在一份申报处理完后显式 flush()（批量落盘，不逐行导出）。
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function researchDbPath() {
  return process.env.RESEARCH_DB_PATH
    || (process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'research.db')
      : path.join(__dirname, '../data/research.db'));
}

/** 原文缓存目录：<dir>/<accession>/<document>（HTML 原件）与 .txt（htmlToText 输出，char_range 的基准） */
export function filingsDir() {
  return process.env.RESEARCH_FILINGS_DIR || path.join(path.dirname(researchDbPath()), 'filings');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS filings (
  accession TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  cik TEXT NOT NULL,
  form_type TEXT NOT NULL,           -- 10-Q / 10-K / 8-K / 20-F / 6-K（含 /A 修正案原样保留）
  doc_kind TEXT NOT NULL,            -- periodic / annual / earnings_release / ifrs_financials
  filing_date TEXT NOT NULL,
  report_date TEXT,                  -- 报告期末（EDGAR reportDate；8-K 为事件日，按期末推算后写 period_end）
  period_end TEXT,                   -- 本文件对应的财季期末（8-K/6-K 新闻稿取最近已结束季度）
  fiscal_year INTEGER,
  fiscal_quarter INTEGER,            -- 1-4；年报记 4
  primary_doc TEXT,
  document TEXT,                     -- 实际解析的文件（10-Q 主文档 / 8-K 的 EX-99.1）
  document_url TEXT,
  index_url TEXT,
  status TEXT NOT NULL,              -- parsed / failed / skipped
  error TEXT,
  sha256 TEXT,
  text_chars INTEGER,
  section_count INTEGER,
  chunk_count INTEGER,
  fetched_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_filings_ticker_period ON filings(ticker, period_end);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accession TEXT NOT NULL,
  ticker TEXT NOT NULL,
  form_type TEXT NOT NULL,
  filing_date TEXT NOT NULL,
  period_end TEXT,
  section TEXT NOT NULL,             -- mdna / risk_factors / financial_statements / business / press_release ...
  item TEXT,
  seq INTEGER NOT NULL,              -- 章节内序号
  char_start INTEGER NOT NULL,       -- 在 <accession>/<document>.txt 中的字符区间 [start, end)
  char_end INTEGER NOT NULL,
  topics TEXT NOT NULL DEFAULT '',   -- 逗号分隔：segment_revenue,capex,guidance
  source_url TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_accession ON chunks(accession);
CREATE INDEX IF NOT EXISTS idx_chunks_ticker_section ON chunks(ticker, section);

CREATE TABLE IF NOT EXISTS dq_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  ticker TEXT,
  period_end TEXT,
  accession TEXT,
  kind TEXT NOT NULL,                -- missing_quarter / pending_quarter / duplicate / parse_failed / empty_section / missing_section
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dq_run ON dq_issues(run_id);

-- XBRL 数值事实（companyfacts，研究窗口内的 10-Q/10-K/20-F；同一 概念+单位+期间 保留最新申报的值）
CREATE TABLE IF NOT EXISTS xbrl_facts (
  ticker TEXT NOT NULL,
  taxonomy TEXT NOT NULL,
  concept TEXT NOT NULL,
  unit TEXT NOT NULL,
  period_start TEXT NOT NULL DEFAULT '', -- 时点类（资产负债表）为空串（主键里 NULL 互不相等，会让去重失效）
  period_end TEXT NOT NULL,
  value REAL NOT NULL,
  fy INTEGER, fp TEXT, form TEXT,
  accession TEXT NOT NULL,
  filed TEXT NOT NULL,
  PRIMARY KEY (ticker, taxonomy, concept, unit, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_xbrl_concept ON xbrl_facts(ticker, concept);

-- Inline XBRL 事实（定期报告原件里的 ix:nonFraction，含维度：分部/产品线/地区）
CREATE TABLE IF NOT EXISTS ixbrl_facts (
  accession TEXT NOT NULL,
  ticker TEXT NOT NULL,
  concept TEXT NOT NULL,             -- 带前缀，如 us-gaap:Revenues
  dims TEXT NOT NULL DEFAULT '',     -- "axis=member;..."，无维度为空串
  period_start TEXT NOT NULL DEFAULT '',
  period_end TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT,
  decimals TEXT,
  filing_date TEXT NOT NULL,
  PRIMARY KEY (accession, concept, dims, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_ixbrl_ticker ON ixbrl_facts(ticker, concept, period_end);

-- 研究笔记：每家公司每财季可有多个版本（8-K 初版 → 10-Q 正式版 → 手动重跑）
CREATE TABLE IF NOT EXISTS research_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  fiscal_label TEXT NOT NULL,        -- FY2026Q4
  period_end TEXT NOT NULL,
  version INTEGER NOT NULL,
  stage TEXT NOT NULL,               -- preliminary（只有 8-K）/ final（已有 10-Q/10-K）
  based_on TEXT NOT NULL,            -- JSON：依据的 accession 列表
  status TEXT NOT NULL,              -- ok / needs_review / failed
  model TEXT,
  note_json TEXT,
  note_md TEXT,
  check_report TEXT,                 -- JSON：自检结果（每条 claim 是否通过）
  tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, latency_ms INTEGER, llm_calls INTEGER,
  error TEXT,
  eval_run TEXT,                     -- 评估生成的笔记：评估轮次 id；线上笔记为 NULL
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_ticker ON research_notes(ticker, fiscal_label, version);

-- LLM 调用账本：每次调用一行（成功失败都记），预算上限按 pool 汇总
CREATE TABLE IF NOT EXISTS llm_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool TEXT NOT NULL,                -- research / backfill / ask / eval
  purpose TEXT NOT NULL,             -- wiki_extract / note / ask ...
  ticker TEXT,
  ref TEXT,                          -- accession 或笔记 id
  model TEXT NOT NULL,
  tokens_in INTEGER, tokens_out INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  ok INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL           -- UTC
);
CREATE INDEX IF NOT EXISTS idx_llm_pool_time ON llm_runs(pool, created_at);

-- 公司 Wiki：长期知识条目，每条都链回原文（chunk + 字符区间 + 逐字引文）。
-- 冲突（同键不同值）两条都保留：旧条 superseded_by 指向新条，conflict=1
CREATE TABLE IF NOT EXISTS wiki_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  category TEXT NOT NULL,            -- segment / metric_definition / guidance / event
  entry_key TEXT NOT NULL,           -- 归一化键（小写、去多余空白）
  title TEXT NOT NULL,
  value TEXT NOT NULL,
  target_period TEXT,                -- 指引针对的期间（如 FY2027Q1），其他类别可空
  accession TEXT NOT NULL,
  chunk_id INTEGER NOT NULL,
  char_start INTEGER NOT NULL,       -- 引文在 <accession>/<document>.txt 中的区间
  char_end INTEGER NOT NULL,
  quote TEXT NOT NULL,
  source_url TEXT NOT NULL,
  filing_date TEXT NOT NULL,
  fiscal_label TEXT,                 -- 来源申报所属财季
  conflict INTEGER NOT NULL DEFAULT 0,
  superseded_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_ticker ON wiki_entries(ticker, category, entry_key);

-- 每份申报的 Wiki 处理记录（增量：处理过的不再花钱）
CREATE TABLE IF NOT EXISTS wiki_runs (
  accession TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  status TEXT NOT NULL,              -- done / failed / budget
  proposed INTEGER, accepted INTEGER, rejected INTEGER,
  error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  run_id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,             -- backfill / watch / manual
  started_at TEXT NOT NULL,
  finished_at TEXT,
  new_filings INTEGER DEFAULT 0,
  skipped_existing INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  requests INTEGER DEFAULT 0,
  dq_count INTEGER DEFAULT 0,
  error TEXT
);
`;

let db = null;
let initPromise = null;

export async function getResearchDb() {
  if (db) return db;
  initPromise ??= (async () => {
    const SQL = await initSqlJs();
    const p = researchDbPath();
    db = fs.existsSync(p) ? new SQL.Database(fs.readFileSync(p)) : new SQL.Database();
    db.run(SCHEMA);
    // 增量列（老库补列；新库 CREATE TABLE 已含，迁移幂等）
    const cols = all('PRAGMA table_info(research_notes)').map(c => c.name);
    if (!cols.includes('eval_run')) db.run('ALTER TABLE research_notes ADD COLUMN eval_run TEXT');
    return db;
  })();
  return initPromise;
}

/** 原子落盘（临时文件 + rename，同主库做法） */
export function flush() {
  if (!db) return;
  const p = researchDbPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  // Windows 上目标文件正被别的进程读取时 rename 会 EPERM / EBUSY（2026-10-21 评估轮：deepseek 落盘时撞上本机 Opus 子代理
  // 正在 readFileSync 同一个库，GOOGL 一份笔记因此记为失败）。读取只占几毫秒，短暂退避重试即可
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, p);
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt >= 20) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1)); // 同步等待，flush 是同步接口
    }
  }
}

/** 测试用：丢弃内存库（不删文件） */
export function _closeResearchDb() {
  try { db?.close(); } catch { /* 已关闭 */ }
  db = null;
  initPromise = null;
}

export function all(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

export function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

export function run(sql, params = []) {
  db.run(sql, params);
}

/** 事务包裹：任一语句失败整体回滚，避免一份申报只写了一半的块 */
export function tx(fn) {
  db.run('BEGIN');
  try {
    const r = fn();
    db.run('COMMIT');
    return r;
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}
