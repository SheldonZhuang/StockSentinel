import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB 路径优先级：显式 DB_PATH > Railway 持久卷（挂载后自动注入 RAILWAY_VOLUME_MOUNT_PATH，
// 数据落卷后重部署不再丢库，GitHub 备份降级为二级兜底）> 本地 data 目录。
// 注意：挂卷后首次启动卷是空的，server.js 的 restoreDatabaseIfMissing 会从 GitHub 备份
// 拉回历史数据落到卷上，完成一次性迁移；此后卷成为主存储。
export const DB_PATH = process.env.DB_PATH
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'stock-sentinel.db')
    : path.join(__dirname, '../data/stock-sentinel.db'));

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
    // 新库同样补列：CREATE TABLE 与 SIGNAL_SNAPSHOT_NEW_COLUMNS 双源一旦不同步，
    // 否则 saveSignalSnapshot 的 INSERT 会因缺列在全新环境必然失败（迁移幂等，多跑无害）
    migrateSchema();
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
  'oil_wti REAL',
  'oil_change_30d_pct REAL',
  'oil_period_date TEXT',
  'oil_source TEXT',
  'fiscal_outlays_ttm REAL',
  'fiscal_outlays_ttm_prev REAL',
  'fiscal_outlays_change_pct REAL',
  'credit_spread REAL',
  'credit_spread_percentile REAL',
  'credit_spread_90d_widen_bp REAL',
  'credit_spread_period_date TEXT',
  'yield_curve_spread REAL',
  'yield_curve_inverted_days INTEGER',
  'yield_curve_period_date TEXT',
  'sahm_lock_since TEXT',
  'reactive_adjustment_lock_since TEXT',
  'final_downgrade_pending_since TEXT',
  'spx_close REAL',
  'spx_ma10m REAL',
  'spx_above_sma10 INTEGER',
  'oil_level_low INTEGER',
  'capex_qtr_yoy REAL',
  'capex_qtr_end TEXT',
  'capex_signal TEXT',
  'capex_qtr_prev_qtr_yoy REAL',
];

// ai_chain_snapshots 的增量列（与 signal_snapshots 同机制：CREATE TABLE 管新库，ALTER 管存量库）
const AI_CHAIN_SNAPSHOT_NEW_COLUMNS = [
  'capex_qtr_yoy REAL',
  'capex_qtr_sum REAL',
  'capex_qtr_prev_year_sum REAL',
  'capex_qtr_end TEXT',
];

// capex_guidance_records 的增量列（113号补源：web检索指引 + 单公司财报快报）
// 注意：新列须同时进 CREATE TABLE 与此列表（新库缺列是历史高危bug，见第二轮专家复查）
const GUIDANCE_RECORD_NEW_COLUMNS = [
  'source TEXT',            // 指引来源：press_release | web | null(未检测到)
  'fy_guidance TEXT',       // 本财年capex指引摘要（如 "FY2026 $195-205B, raised from $185B"）
  'forward_guidance TEXT',  // 对之后年度capex的表述摘要
  'sources TEXT',           // web来源URL列表（JSON数组字符串）
  'qtr_end TEXT',           // 快报对应季度末
  'qtr_capex REAL',         // 单季capex（USD）
  'qtr_capex_yoy REAL',     // 单季同比 %
  'ttm_capex REAL',         // 滚动4季capex（USD）
  'ttm_capex_yoy REAL',     // 滚动4季同比 %
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
  const existingChainCols = new Set(
    all('PRAGMA table_info(ai_chain_snapshots)').map((c) => c.name)
  );
  for (const colDef of AI_CHAIN_SNAPSHOT_NEW_COLUMNS) {
    const colName = colDef.split(' ')[0];
    if (!existingChainCols.has(colName)) {
      db.run(`ALTER TABLE ai_chain_snapshots ADD COLUMN ${colDef}`);
      changed = true;
    }
  }
  const existingGuidanceCols = new Set(
    all('PRAGMA table_info(capex_guidance_records)').map((c) => c.name)
  );
  for (const colDef of GUIDANCE_RECORD_NEW_COLUMNS) {
    const colName = colDef.split(' ')[0];
    if (!existingGuidanceCols.has(colName)) {
      db.run(`ALTER TABLE capex_guidance_records ADD COLUMN ${colDef}`);
      changed = true;
    }
  }
  if (changed) persist();
}

function persist() {
  if (!db) return;
  const data = db.export();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  // 先写临时文件再原子改名：进程在写入中途被杀不会留下截断的 db 文件。
  // 临时文件名带 pid：本地开发双实例/nodemon 重启重叠时固定名会互相截断写入，
  // rename 后可能落下损坏文件（生产单容器不触发，属本地开发防护）
  const tmpPath = `${DB_PATH}.${process.pid}.tmp`;
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
      fiscal_stale INTEGER,
      admin_stale INTEGER,
      ai_supply_stale INTEGER,
      epu_daily REAL,
      epu_daily_percentile REAL,
      epu_daily_period_date TEXT,
      oil_wti REAL,
      oil_change_30d_pct REAL,
      oil_period_date TEXT,
      oil_source TEXT,
      fiscal_outlays_ttm REAL,
      fiscal_outlays_ttm_prev REAL,
      fiscal_outlays_change_pct REAL,
      credit_spread REAL,
      credit_spread_percentile REAL,
      credit_spread_90d_widen_bp REAL,
      credit_spread_period_date TEXT,
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
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      name TEXT,
      tier TEXT NOT NULL DEFAULT 'free',
      disabled INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS api_usage (
      day TEXT NOT NULL,
      identifier TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (day, identifier)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      content_zh TEXT,
      content_en TEXT,
      model TEXT,
      created_at TEXT DEFAULT (datetime('now'))
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
      capex_qtr_yoy REAL,
      capex_qtr_sum REAL,
      capex_qtr_prev_year_sum REAL,
      capex_qtr_end TEXT,
      bubble_warning INTEGER DEFAULT 0,
      bubble_reasons TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS capex_guidance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      filing_date TEXT,
      accession TEXT NOT NULL UNIQUE,
      direction TEXT,
      quote TEXT,
      confidence TEXT,
      auto_event_created INTEGER DEFAULT 0,
      source TEXT,
      fy_guidance TEXT,
      forward_guidance TEXT,
      sources TEXT,
      qtr_end TEXT,
      qtr_capex REAL,
      qtr_capex_yoy REAL,
      ttm_capex REAL,
      ttm_capex_yoy REAL,
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
  // sql.js 对 undefined 抛 "unknown type"——统一归一为 null（字段演进期新旧键名并存时的防护）
  db.run(sql, params.map(p => (p === undefined ? null : p)));
  persist();
}

// 用户侧写入监听（server 启动时注册为防抖 GitHub 备份）：
// 用户注册/自选股/override/API key 是收费产品核心资产，只靠每日 cron 备份
// 在非持久化文件系统上有最长24小时的丢失窗口；写后即时备份把窗口收窄到分钟级。
// 用回调而非直接 import backup.js，避免 storage↔backup 循环依赖。
let userWriteListener = null;
export function setUserWriteListener(fn) { userWriteListener = fn; }
function notifyUserWrite() { try { userWriteListener?.(); } catch { /* 备份钩子不砸写路径 */ } }

// --- Users ---

export async function createUser(email, passwordHash) {
  await getDb();
  // 两条写在同一事务：若分两次 run（各自 persist），第二条失败会留下无订阅行的用户，
  // getAlertSubscribers 的 INNER JOIN 将静默漏发该用户的所有信号告警
  db.run('BEGIN');
  try {
    db.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, passwordHash]);
    db.run(
      'INSERT INTO alert_subscriptions (user_id, enabled) SELECT id, 1 FROM users WHERE email = ?',
      [email]
    );
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
  persist();
  notifyUserWrite();
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
  notifyUserWrite();
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
     epu_daily, epu_daily_percentile, epu_daily_period_date,
     oil_wti, oil_change_30d_pct, oil_period_date, oil_source,
     fiscal_outlays_ttm, fiscal_outlays_ttm_prev, fiscal_outlays_change_pct,
     credit_spread, credit_spread_percentile, credit_spread_90d_widen_bp, credit_spread_period_date,
     yield_curve_spread, yield_curve_inverted_days, yield_curve_period_date,
     sahm_lock_since, reactive_adjustment_lock_since, final_downgrade_pending_since,
     spx_close, spx_ma10m, spx_above_sma10, oil_level_low,
     capex_qtr_yoy, capex_qtr_end, capex_signal, capex_qtr_prev_qtr_yoy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    data.oilWti, data.oilChange30dPct, data.oilPeriodDate, data.oilSource,
    data.fiscalOutlaysTtm, data.fiscalOutlaysTtmPrev, data.fiscalOutlaysChangePct,
    data.creditSpread, data.creditSpreadPercentile, data.creditSpread90dWidenBp, data.creditSpreadPeriodDate,
    data.yieldCurveSpread, data.yieldCurveInvertedDays, data.yieldCurvePeriodDate,
    data.sahmLockSince, data.reactiveAdjustmentLockSince, data.finalDowngradePendingSince,
    data.spxClose, data.spxMa10m, data.spxAboveSma10, data.oilLevelLow,
    data.capexQtrYoY, data.capexQtrEnd, data.capexSignal, data.capexQtrPrevQtrYoY,
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
  notifyUserWrite();
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
  const [fiscal, administrative, aiSupply, sahmLockClear, reactiveAdjustmentLockClear, capexGuidance] = await Promise.all([
    getActiveAdminSignal('fiscal'),
    getActiveAdminSignal('administrative'),
    getActiveAdminSignal('ai_supply'),
    getActiveAdminSignal('sahmLock'),
    getActiveAdminSignal('reactiveAdjustmentLock'),
    getActiveAdminSignal('capex_guidance'),
  ]);
  return { fiscal, administrative, aiSupply, sahmLockClear, reactiveAdjustmentLockClear, capexGuidance };
}

// --- Capex 指引自动检测记录 ---

export async function getProcessedGuidanceAccessions() {
  await getDb();
  // 113号自愈迁移：direction='none' 且 source 为空的记录是补源前旧代码落的档
  // （旧语义"新闻稿未给指引"，未经 web 检索）——视为未完成检测，不算已处理；
  // 10天窗口内的该类申报会被重新检测并覆盖（云端/本机各实例自动收敛，无需人工修库）
  return all(`
    SELECT accession FROM capex_guidance_records
    WHERE NOT (direction = 'none' AND source IS NULL)
  `).map(r => r.accession);
}

export async function saveGuidanceRecord(rec) {
  await getDb();
  // accession 冲突时整行覆盖（upsert）：同一申报重复检测幂等（每日窗口重叠），
  // 且 113号自愈迁移重跑旧 none 记录时能覆盖为补源后的完整结果
  run(`
    INSERT OR REPLACE INTO capex_guidance_records
      (symbol, filing_date, accession, direction, quote, confidence, auto_event_created,
       source, fy_guidance, forward_guidance, sources,
       qtr_end, qtr_capex, qtr_capex_yoy, ttm_capex, ttm_capex_yoy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [rec.symbol, rec.filingDate || null, rec.accession, rec.direction || 'none',
      rec.quote || null, rec.confidence || null, rec.autoEventCreated ? 1 : 0,
      rec.source || null, rec.fyGuidance || null, rec.forwardGuidance || null, rec.sources || null,
      rec.qtrEnd || null, rec.qtrCapex ?? null, rec.qtrCapexYoY ?? null,
      rec.ttmCapex ?? null, rec.ttmCapexYoY ?? null]);
}

/** 前端参考展示用：最近的指引记录（默认取含前瞻指引的，兜底取全部最近条） */
export async function getRecentGuidance(limit = 8) {
  await getDb();
  return all(`
    SELECT symbol, filing_date, direction, quote, confidence, auto_event_created,
           source, fy_guidance, forward_guidance, sources,
           qtr_end, qtr_capex, qtr_capex_yoy, ttm_capex, ttm_capex_yoy, created_at
    FROM capex_guidance_records
    ORDER BY filing_date DESC, id DESC LIMIT ?
  `, [limit]);
}

// --- Watchlist ---

export async function getWatchlist(userId) {
  await getDb();
  return all('SELECT * FROM watchlist WHERE user_id = ? ORDER BY added_at DESC', [userId]);
}

export async function addToWatchlist(userId, symbol) {
  await getDb();
  run('INSERT OR IGNORE INTO watchlist (user_id, symbol) VALUES (?, ?)', [userId, symbol.toUpperCase()]);
  notifyUserWrite();
}

export async function getAllWatchlistSymbols() {
  await getDb();
  return all('SELECT DISTINCT symbol FROM watchlist').map(r => r.symbol);
}

export async function removeFromWatchlist(userId, symbol) {
  await getDb();
  run('DELETE FROM watchlist WHERE user_id = ? AND symbol = ?', [userId, symbol.toUpperCase()]);
  notifyUserWrite();
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
  notifyUserWrite();
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
     capex_yoy, capex_ttm, capex_prev_ttm,
     capex_qtr_yoy, capex_qtr_sum, capex_qtr_prev_year_sum, capex_qtr_end,
     bubble_warning, bubble_reasons)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.date, data.autoBottleneck, data.stageMetrics,
    data.modelUsageTrendPct, data.modelUsageLatestTokens, data.modelUsageAsOf,
    data.capexYoY, data.capexTtm, data.capexPrevTtm,
    data.capexQtrYoY, data.capexQtrSum, data.capexQtrPrevYearSum, data.capexQtrEnd,
    data.bubbleWarning ? 1 : 0, data.bubbleReasons,
  ]);
}

export async function getLatestAiChainSnapshot() {
  await getDb();
  return get('SELECT * FROM ai_chain_snapshots ORDER BY date DESC, id DESC LIMIT 1');
}

// --- API Keys（开放API计费/限流基础）---

export async function createApiKey(key, name, tier) {
  await getDb();
  run('INSERT INTO api_keys (key, name, tier) VALUES (?, ?, ?)', [key, name || null, tier || 'free']);
  notifyUserWrite();
  return get('SELECT * FROM api_keys WHERE key = ?', [key]);
}

export async function getApiKeyRecord(key) {
  await getDb();
  return get('SELECT * FROM api_keys WHERE key = ? AND disabled = 0', [key]);
}

export async function listApiKeys() {
  await getDb();
  return all('SELECT id, key, name, tier, disabled, created_at FROM api_keys ORDER BY id DESC');
}

export async function setApiKeyDisabled(id, disabled) {
  await getDb();
  run('UPDATE api_keys SET disabled = ? WHERE id = ?', [disabled ? 1 : 0, id]);
  notifyUserWrite();
}

// --- 开放API用量（限流持久化 + 计费对账底账）---

export async function loadApiUsage(day) {
  await getDb();
  return all('SELECT identifier, count FROM api_usage WHERE day = ?', [day]);
}

/** 批量落盘当日计数（整表覆盖式 upsert，一次 persist） */
export async function upsertApiUsage(day, entries) {
  await getDb();
  for (const e of entries) {
    db.run(
      'INSERT INTO api_usage (day, identifier, count) VALUES (?, ?, ?) ON CONFLICT(day, identifier) DO UPDATE SET count = excluded.count',
      [day, e.identifier, e.count]
    );
  }
  persist();
}

/** 清理过期用量行（keyless 的 ip 条目逐日累积，不清理会无界增长）；每日日切时调用一次 */
export async function pruneApiUsage(beforeDay) {
  await getDb();
  db.run('DELETE FROM api_usage WHERE day < ?', [beforeDay]);
  persist();
}

// --- AI 日报 ---

export async function saveDailyReport(data) {
  await getDb();
  run('INSERT INTO daily_reports (date, content_zh, content_en, model) VALUES (?, ?, ?, ?)',
    [data.date, data.contentZh, data.contentEn, data.model]);
}

export async function getLatestDailyReport() {
  await getDb();
  return get('SELECT * FROM daily_reports ORDER BY date DESC, id DESC LIMIT 1');
}

export { getDb, persist };
