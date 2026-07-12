import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/stock-sentinel.db');

let db = null;
let dbInitPromise = null;

async function getDb() {
  if (db) return db;
  // 缓存初始化 Promise：并发首次调用共享同一次初始化，避免双 Database 实例互相覆盖落盘数据
  dbInitPromise ??= initDb();
  return dbInitPromise;
}

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    // 老库也要先补建缺失的表（全部 CREATE TABLE IF NOT EXISTS，幂等），再补列
    initSchema();
    migrateSchema();
  } else {
    db = new SQL.Database();
    initSchema();
    persist();
  }
  return db;
}

// signal_snapshots 新增列（早于此列表创建的 .db 文件缺这些列，需要 ALTER TABLE 补齐）
const SIGNAL_SNAPSHOT_NEW_COLUMNS = [
  'rate_decision_date TEXT',
  'balance_sheet_period_date TEXT',
  'balance_sheet_release_date TEXT',
  'balance_sheet_status TEXT',
  'core_pce_period_date TEXT',
  'core_pce_release_date TEXT',
  'trimmed_pce_period_date TEXT',
  'trimmed_pce_release_date TEXT',
  'unemployment_period_date TEXT',
  'unemployment_release_date TEXT',
  'fred_core_pce_prev REAL',
  'fred_trimmed_pce_prev REAL',
  'fred_unemployment_prev REAL',
  'fred_trimmed_pce_1m REAL',
  'fred_trimmed_pce_1m_prev REAL',
  'trimmed_pce_1m_period_date TEXT',
  'trimmed_pce_1m_release_date TEXT',
  'fred_trimmed_pce_12m REAL',
  'fred_trimmed_pce_12m_prev REAL',
  'trimmed_pce_12m_period_date TEXT',
  'trimmed_pce_12m_release_date TEXT',
  'fiscal_auto_signal TEXT',
  'fiscal_deficit_ttm REAL',
  'fiscal_deficit_ttm_prev REAL',
  'fiscal_deficit_change_pct REAL',
  'fiscal_period_date TEXT',
  'fiscal_release_date TEXT',
  'admin_auto_signal TEXT',
  'epu_trade REAL',
  'epu_trade_percentile REAL',
  'epu_trade_period_date TEXT',
  'ai_supply_auto_signal TEXT',
  'ai_market_signal TEXT',
  'ai_fundamental_signal TEXT',
  'smh_spy_rel_return_pct REAL',
  'semi_ip_yoy REAL',
  'semi_ip_period_date TEXT',
  'semi_ip_release_date TEXT',
  'model_usage_trend_pct REAL',
  'capex_yoy REAL',
  'ai_bubble_warning INTEGER',
  'sahm_value REAL',
  'sahm_period_date TEXT',
  'sahm_release_date TEXT',
  'sahm_lock_active INTEGER',
  'reactive_adjustment_lock_active INTEGER',
  'reactive_adjustment_lock_trigger_bp REAL',
  'fiscal_stale INTEGER',
  'admin_stale INTEGER',
  'ai_supply_stale INTEGER',
  'epu_daily REAL',
  'epu_daily_percentile REAL',
  'epu_daily_period_date TEXT',
];

function migrateSchema() {
  const existingCols = new Set(
    all('PRAGMA table_info(signal_snapshots)').map((c) => c.name)
  );
  let changed = false;
  for (const colDef of SIGNAL_SNAPSHOT_NEW_COLUMNS) {
    const colName = colDef.split(' ')[0];
    if (!existingCols.has(colName)) {
      db.run(`ALTER TABLE signal_snapshots ADD COLUMN ${colDef}`);
      changed = true;
    }
  }
  if (changed) persist();
}

function persist() {
  if (!db) return;
  const data = db.export();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  // 先写临时文件再原子改名：进程在写入中途被杀不会留下截断的 db 文件
  const tmpPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, Buffer.from(data));
  fs.renameSync(tmpPath, DB_PATH);
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email_alerts INTEGER DEFAULT 1,
      is_subscribed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS signal_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      monetary_signal TEXT NOT NULL,
      fiscal_signal TEXT NOT NULL,
      admin_signal TEXT NOT NULL,
      ai_supply_signal TEXT NOT NULL DEFAULT 'neutral',
      final_signal TEXT NOT NULL,
      fred_rate REAL,
      fred_rate_prev REAL,
      fred_balance_sheet REAL,
      fred_balance_sheet_prev REAL,
      fred_core_pce REAL,
      fred_trimmed_pce REAL,
      fred_unemployment REAL,
      rate_decision_date TEXT,
      balance_sheet_period_date TEXT,
      balance_sheet_release_date TEXT,
      balance_sheet_status TEXT,
      core_pce_period_date TEXT,
      core_pce_release_date TEXT,
      trimmed_pce_period_date TEXT,
      trimmed_pce_release_date TEXT,
      unemployment_period_date TEXT,
      unemployment_release_date TEXT,
      fred_core_pce_prev REAL,
      fred_trimmed_pce_prev REAL,
      fred_unemployment_prev REAL,
      fred_trimmed_pce_1m REAL,
      fred_trimmed_pce_1m_prev REAL,
      trimmed_pce_1m_period_date TEXT,
      trimmed_pce_1m_release_date TEXT,
      fred_trimmed_pce_12m REAL,
      fred_trimmed_pce_12m_prev REAL,
      trimmed_pce_12m_period_date TEXT,
      trimmed_pce_12m_release_date TEXT,
      fiscal_auto_signal TEXT,
      fiscal_deficit_ttm REAL,
      fiscal_deficit_ttm_prev REAL,
      fiscal_deficit_change_pct REAL,
      fiscal_period_date TEXT,
      fiscal_release_date TEXT,
      admin_auto_signal TEXT,
      epu_trade REAL,
      epu_trade_percentile REAL,
      epu_trade_period_date TEXT,
      ai_supply_auto_signal TEXT,
      ai_market_signal TEXT,
      ai_fundamental_signal TEXT,
      smh_spy_rel_return_pct REAL,
      semi_ip_yoy REAL,
      semi_ip_period_date TEXT,
      semi_ip_release_date TEXT,
      model_usage_trend_pct REAL,
      capex_yoy REAL,
      ai_bubble_warning INTEGER,
      sahm_value REAL,
      sahm_period_date TEXT,
      sahm_release_date TEXT,
      sahm_lock_active INTEGER,
      reactive_adjustment_lock_active INTEGER,
      reactive_adjustment_lock_trigger_bp REAL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      added_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, symbol),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS admin_signal_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      signal TEXT NOT NULL,
      expires_at TEXT,
      note TEXT,
      set_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS alert_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      enabled INTEGER DEFAULT 1,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ai_chain_bottleneck (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stage TEXT NOT NULL,
      note TEXT,
      set_by TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ai_chain_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      auto_bottleneck TEXT,
      stage_metrics TEXT,
      model_usage_trend_pct REAL,
      model_usage_latest_tokens REAL,
      model_usage_as_of TEXT,
      capex_yoy REAL,
      capex_ttm REAL,
      capex_prev_ttm REAL,
      bubble_warning INTEGER DEFAULT 0,
      bubble_reasons TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

// --- 通用查询工具 ---

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
  persist();
}

// --- Users ---

export async function createUser(email, passwordHash) {
  await getDb();
  run(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)',
    [email, passwordHash]
  );
  run(
    'INSERT INTO alert_subscriptions (user_id, enabled) SELECT id, 1 FROM users WHERE email = ?',
    [email]
  );
  return getUserByEmail(email);
}

export async function getUserByEmail(email) {
  await getDb();
  return get('SELECT * FROM users WHERE email = ?', [email]);
}

export async function getUserById(id) {
  await getDb();
  return get('SELECT * FROM users WHERE id = ?', [id]);
}

export async function updateUserAlerts(userId, enabled) {
  await getDb();
  run('UPDATE users SET email_alerts = ? WHERE id = ?', [enabled ? 1 : 0, userId]);
}

// --- Signal Snapshots ---

export async function saveSignalSnapshot(data) {
  await getDb();
  run(`
    INSERT INTO signal_snapshots
    (date, monetary_signal, fiscal_signal, admin_signal, ai_supply_signal, final_signal,
     fred_rate, fred_rate_prev, fred_balance_sheet, fred_balance_sheet_prev,
     fred_core_pce, fred_trimmed_pce, fred_unemployment,
     rate_decision_date, balance_sheet_period_date, balance_sheet_release_date, balance_sheet_status,
     core_pce_period_date, core_pce_release_date, trimmed_pce_period_date, trimmed_pce_release_date,
     unemployment_period_date, unemployment_release_date,
     fred_core_pce_prev, fred_trimmed_pce_prev, fred_unemployment_prev,
     fred_trimmed_pce_1m, fred_trimmed_pce_1m_prev, trimmed_pce_1m_period_date, trimmed_pce_1m_release_date,
     fred_trimmed_pce_12m, fred_trimmed_pce_12m_prev, trimmed_pce_12m_period_date, trimmed_pce_12m_release_date,
     fiscal_auto_signal, fiscal_deficit_ttm, fiscal_deficit_ttm_prev, fiscal_deficit_change_pct,
     fiscal_period_date, fiscal_release_date,
     admin_auto_signal, epu_trade, epu_trade_percentile, epu_trade_period_date,
     ai_supply_auto_signal, ai_market_signal, ai_fundamental_signal,
     smh_spy_rel_return_pct, semi_ip_yoy, semi_ip_period_date, semi_ip_release_date,
     model_usage_trend_pct, capex_yoy, ai_bubble_warning,
     sahm_value, sahm_period_date, sahm_release_date,
     sahm_lock_active, reactive_adjustment_lock_active, reactive_adjustment_lock_trigger_bp,
     fiscal_stale, admin_stale, ai_supply_stale,
     epu_daily, epu_daily_percentile, epu_daily_period_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.date, data.monetarySignal, data.fiscalSignal, data.adminSignal, data.aiSupplySignal || 'neutral', data.finalSignal,
    data.fredRate, data.fredRatePrev, data.fredBalanceSheet, data.fredBalanceSheetPrev,
    data.fredCorePce, data.fredTrimmedPce, data.fredUnemployment,
    data.rateDecisionDate, data.balanceSheetPeriodDate, data.balanceSheetReleaseDate, data.balanceSheetStatus,
    data.corePcePeriodDate, data.corePceReleaseDate, data.trimmedPcePeriodDate, data.trimmedPceReleaseDate,
    data.unemploymentPeriodDate, data.unemploymentReleaseDate,
    data.fredCorePcePrev, data.fredTrimmedPcePrev, data.fredUnemploymentPrev,
    data.fredTrimmedPce1m, data.fredTrimmedPce1mPrev, data.trimmedPce1mPeriodDate, data.trimmedPce1mReleaseDate,
    data.fredTrimmedPce12m, data.fredTrimmedPce12mPrev, data.trimmedPce12mPeriodDate, data.trimmedPce12mReleaseDate,
    data.fiscalAutoSignal, data.fiscalDeficitTtm, data.fiscalDeficitTtmPrev, data.fiscalDeficitChangePct,
    data.fiscalPeriodDate, data.fiscalReleaseDate,
    data.adminAutoSignal, data.epuTrade, data.epuTradePercentile, data.epuTradePeriodDate,
    data.aiSupplyAutoSignal, data.aiMarketSignal, data.aiFundamentalSignal,
    data.smhSpyRelReturnPct, data.semiIpYoy, data.semiIpPeriodDate, data.semiIpReleaseDate,
    data.modelUsageTrendPct, data.capexYoY, data.aiBubbleWarning,
    data.sahmValue, data.sahmPeriodDate, data.sahmReleaseDate,
    data.sahmLockActive, data.reactiveAdjustmentLockActive, data.reactiveAdjustmentLockTriggerBp,
    data.fiscalStale ? 1 : 0, data.adminStale ? 1 : 0, data.aiSupplyStale ? 1 : 0,
    data.epuDaily, data.epuDailyPercentile, data.epuDailyPeriodDate,
  ]);
}

export async function getLatestSnapshot() {
  await getDb();
  return get('SELECT * FROM signal_snapshots ORDER BY date DESC, id DESC LIMIT 1');
}

export async function getSnapshotHistory(limit = 90) {
  await getDb();
  // 每天只取最新一条（服务重启会当天多次快照，时间轴按日展示即可）
  return all(`
    SELECT * FROM signal_snapshots
    WHERE id IN (SELECT MAX(id) FROM signal_snapshots GROUP BY date)
    ORDER BY date DESC LIMIT ?
  `, [limit]);
}

// --- Admin Signal Overrides ---

export async function setAdminSignal(type, signal, expiresAt, note, setBy) {
  await getDb();
  run(`
    INSERT INTO admin_signal_overrides (type, signal, expires_at, note, set_by)
    VALUES (?, ?, ?, ?, ?)
  `, [type, signal, expiresAt || null, note || null, setBy || null]);
}

export async function getActiveAdminSignal(type) {
  await getDb();
  return get(`
    SELECT * FROM admin_signal_overrides
    WHERE type = ?
    AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY created_at DESC, id DESC LIMIT 1
  `, [type]);
}

export async function getAdminSignalHistory(limit = 50) {
  await getDb();
  return all(`
    SELECT * FROM admin_signal_overrides ORDER BY created_at DESC LIMIT ?
  `, [limit]);
}

export async function getAllOverrides() {
  const [fiscal, administrative, aiSupply, sahmLockClear, reactiveAdjustmentLockClear] = await Promise.all([
    getActiveAdminSignal('fiscal'),
    getActiveAdminSignal('administrative'),
    getActiveAdminSignal('ai_supply'),
    getActiveAdminSignal('sahmLock'),
    getActiveAdminSignal('reactiveAdjustmentLock'),
  ]);
  return { fiscal, administrative, aiSupply, sahmLockClear, reactiveAdjustmentLockClear };
}

// --- Watchlist ---

export async function getWatchlist(userId) {
  await getDb();
  return all('SELECT * FROM watchlist WHERE user_id = ? ORDER BY added_at DESC', [userId]);
}

export async function addToWatchlist(userId, symbol) {
  await getDb();
  run('INSERT OR IGNORE INTO watchlist (user_id, symbol) VALUES (?, ?)', [userId, symbol.toUpperCase()]);
}

export async function removeFromWatchlist(userId, symbol) {
  await getDb();
  run('DELETE FROM watchlist WHERE user_id = ? AND symbol = ?', [userId, symbol.toUpperCase()]);
}

// --- Alert Subscribers ---

export async function getAlertSubscribers() {
  await getDb();
  return all(`
    SELECT u.email, u.id FROM users u
    JOIN alert_subscriptions a ON a.user_id = u.id
    WHERE a.enabled = 1 AND u.email_alerts = 1
  `);
}

// --- AI Chain Bottleneck ---

export async function getBottleneck() {
  await getDb();
  return get('SELECT * FROM ai_chain_bottleneck ORDER BY id DESC LIMIT 1');
}

export async function setBottleneck(stage, note, setBy) {
  await getDb();
  run(
    'INSERT INTO ai_chain_bottleneck (stage, note, set_by) VALUES (?, ?, ?)',
    [stage, note || null, setBy || null]
  );
}

/**
 * 生效卡点：最新手动设定行 stage 不是 'auto' 哨兵 → 手动；否则用最新链快照的自动识别结果
 * @returns {{stage: string|null, source: 'manual'|'auto', note: string|null}}
 */
export async function getEffectiveBottleneck() {
  await getDb();
  const manual = await getBottleneck();
  if (manual && manual.stage !== 'auto') {
    return { stage: manual.stage, source: 'manual', note: manual.note || null };
  }
  const snap = await getLatestAiChainSnapshot();
  return { stage: snap?.auto_bottleneck || null, source: 'auto', note: null };
}

// --- AI Chain Snapshots ---

export async function saveAiChainSnapshot(data) {
  await getDb();
  run(`
    INSERT INTO ai_chain_snapshots
    (date, auto_bottleneck, stage_metrics,
     model_usage_trend_pct, model_usage_latest_tokens, model_usage_as_of,
     capex_yoy, capex_ttm, capex_prev_ttm, bubble_warning, bubble_reasons)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.date, data.autoBottleneck, data.stageMetrics,
    data.modelUsageTrendPct, data.modelUsageLatestTokens, data.modelUsageAsOf,
    data.capexYoY, data.capexTtm, data.capexPrevTtm,
    data.bubbleWarning ? 1 : 0, data.bubbleReasons,
  ]);
}

export async function getLatestAiChainSnapshot() {
  await getDb();
  return get('SELECT * FROM ai_chain_snapshots ORDER BY date DESC, id DESC LIMIT 1');
}

export { getDb, persist };
