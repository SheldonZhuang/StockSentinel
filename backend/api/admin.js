import express from 'express';
import { requireAdmin } from './auth.js';
import crypto from 'crypto';
import {
  setAdminSignal,
  getActiveAdminSignal,
  getAdminSignalHistory,
  setBottleneck,
  createApiKey,
  listApiKeys,
  setApiKeyDisabled,
  setApiKeyUser,
  getSnapshotHistory,
  getLatestSnapshot,
  getAlertSubscribers,
  listUsersWithStats,
  updateUserAdmin,
  getUserUsageDetail,
  getEndpointStats,
  getUserById,
  revokeUserTokens,
} from '../utils/storage.js';
import { sendSignalAlert } from '../utils/mailer.js';
import { fetchFederalRegister } from './fetch-federal-register.js';
import { fetchAiSupplyNews } from './fetch-rss.js';
import chainCfg from '../config/ai-chain.config.js';
import { asyncRoute } from '../utils/async-route.js';
import { invalidateKeyCache } from './public.js';
import { flushCallLogs } from '../utils/usage-log.js';
import { getCapeState } from '../utils/cape.js';

const router = express.Router();
const VALID_SIGNALS = ['loose', 'neutral', 'tight'];
const VALID_TYPES = ['fiscal', 'administrative', 'ai_supply', 'capex_guidance'];
const VALID_LOCK_TYPES = ['sahmLock', 'reactiveAdjustmentLock'];
const LOCK_CLEAR_SIGNAL = 'cleared';
// 'auto' 为哨兵值：清除手动设定，回到按环节排名自动识别
const VALID_STAGES = [...chainCfg.STAGE_KEYS, 'auto'];

/**
 * 归一化 expiresAt 为 UTC 'YYYY-MM-DD HH:MM:SS'（与 SQLite datetime('now') 同格式才能字符串比较；
 * datetime-local 的 'T' 分隔本地时间串直接入库会导致过期判定漂移最多一整天）
 * 空值 → null（永不过期）；无法解析 → undefined（调用方拒绝）
 */
function normalizeExpiresAt(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input !== 'string') return undefined;
  const d = new Date(input);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// GET /api/admin/signals — 当前财政/行政/AI供需信号位
router.get('/signals', requireAdmin, asyncRoute(async (req, res) => {
  const [fiscal, administrative, aiSupply] = await Promise.all([
    getActiveAdminSignal('fiscal'),
    getActiveAdminSignal('administrative'),
    getActiveAdminSignal('ai_supply'),
  ]);
  res.json({
    fiscal: fiscal?.signal || 'neutral',
    fiscalMeta: fiscal || null,
    administrative: administrative?.signal || 'neutral',
    administrativeMeta: administrative || null,
    aiSupply: aiSupply?.signal || 'neutral',
    aiSupplyMeta: aiSupply || null,
  });
}));

// POST /api/admin/signals — 设定信号位
router.post('/signals', requireAdmin, asyncRoute(async (req, res) => {
  const { type, signal, expiresAt, note } = req.body;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }
  // 'auto' 为清除哨兵（2026-07-30）：撤销该类型当前 override 回到自动判定——
  // 这也是误报 N3 事件（capex_guidance）唯一的手动清除路径（文档承诺"手动清除"须真实存在）
  if (signal === 'auto') {
    await setAdminSignal(type, 'auto', null, note || null, req.user.email);
    return res.json({ ok: true, type, signal: 'auto', cleared: true });
  }
  // capex_guidance 是事件型输入（N3 指引下修）：只有 tight 一个合法档位——
  // 事件存在即 capex 子信号收紧，"宽松的指引"不构成事件（数据口径自会体现）
  if (type === 'capex_guidance' && signal !== 'tight') {
    return res.status(400).json({ error: 'capex_guidance only accepts signal=tight (the event itself means downgrade) or auto (clear)' });
  }
  if (!VALID_SIGNALS.includes(signal)) {
    return res.status(400).json({ error: `signal must be one of: ${VALID_SIGNALS.join(', ')}` });
  }
  const normalizedExpiresAt = normalizeExpiresAt(expiresAt);
  if (normalizedExpiresAt === undefined) {
    return res.status(400).json({ error: 'expiresAt must be a valid datetime string' });
  }

  await setAdminSignal(type, signal, normalizedExpiresAt, note || null, req.user.email);

  // N3 指引下修事件（2026-07-21 用户拍板）：这是"未来capex缩减+AI供过于求"的前瞻信号，
  // 录入即向订阅用户发示警邮件（不等次日 cron）——用户明确要求"立即通知我，在网页上和邮件里"。
  // 网页侧由 payloads 实时重算生效（capexGuidanceDowngrade 横幅）；邮件失败不影响录入结果。
  if (type === 'capex_guidance') {
    try {
      const subscribers = await getAlertSubscribers();
      if (subscribers.length) {
        await sendSignalAlert(subscribers, {
          finalSignal: 'reduce', // 单维收紧对应档位语义；实际生效档以 /v1/signal 实时值为准
          changes: [{ kind: 'capexGuidance', note: note || null }],
          details: {},
        });
      }
    } catch (err) {
      console.warn('[admin] capex guidance alert email failed:', err.message);
    }
  }

  res.json({ ok: true, type, signal, expiresAt: normalizedExpiresAt });
}));

// POST /api/admin/lock-override — 应急清除萨姆锁/应对式调整锁（FRED数据异常误触发时用）
// body.cancel=true：撤销现存的清锁 override（锁恢复由 raw 状态决定）
router.post('/lock-override', requireAdmin, asyncRoute(async (req, res) => {
  const { type, expiresAt, note, cancel } = req.body;

  if (!VALID_LOCK_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_LOCK_TYPES.join(', ')}` });
  }
  if (cancel === true) {
    await setAdminSignal(type, 'auto', null, note || null, req.user.email);
    return res.json({ ok: true, type, cancelled: true });
  }
  const normalizedExpiresAt = normalizeExpiresAt(expiresAt);
  if (normalizedExpiresAt === undefined) {
    return res.status(400).json({ error: 'expiresAt must be a valid datetime string' });
  }

  await setAdminSignal(type, LOCK_CLEAR_SIGNAL, normalizedExpiresAt, note || null, req.user.email);
  res.json({ ok: true, type, expiresAt: normalizedExpiresAt });
}));

// GET /api/admin/signal-history
router.get('/signal-history', requireAdmin, asyncRoute(async (req, res) => {
  const history = await getAdminSignalHistory(100);
  res.json(history);
}));

// GET /api/admin/reference?category=fiscal|administrative|ai_supply
router.get('/reference', requireAdmin, asyncRoute(async (req, res) => {
  const category = ['administrative', 'ai_supply'].includes(req.query.category) ? req.query.category : 'fiscal';
  const fetcher = category === 'ai_supply'
    ? () => fetchAiSupplyNews(20)                 // 英伟达官方新闻+博客 + TrendForce
    : () => fetchFederalRegister(category, 20);   // Federal Register 关键词检索
  const docs = await fetcher().catch(err => {
    console.warn(`[admin] reference(${category}) fetch failed:`, err.message);
    return [];
  });
  res.json(docs);
}));

// POST /api/admin/bottleneck — 设定当前AI产业链最卡脖子环节
router.post('/bottleneck', requireAdmin, asyncRoute(async (req, res) => {
  const { stage, note } = req.body;
  if (!VALID_STAGES.includes(stage)) {
    return res.status(400).json({ error: `stage must be one of: ${VALID_STAGES.join(', ')}` });
  }
  await setBottleneck(stage, note || null, req.user.email);
  res.json({ ok: true, stage, note: note || null });
}));

// POST /api/admin/backup — 手动触发数据库备份（验证 GitHub 备份链路）
router.post('/backup', requireAdmin, asyncRoute(async (req, res) => {
  const { backupDatabase } = await import('../utils/backup.js');
  res.json(await backupDatabase());
}));

// --- 开放API密钥管理（变现基础）---

// GET /api/admin/api-keys — 全部密钥
router.get('/api-keys', requireAdmin, asyncRoute(async (req, res) => {
  res.json(await listApiKeys());
}));

// POST /api/admin/api-keys {name, tier, userId} — 签发新密钥（可选绑定归属用户）
router.post('/api-keys', requireAdmin, asyncRoute(async (req, res) => {
  const { name, tier, userId } = req.body || {};
  if (tier && !['free', 'pro'].includes(tier)) return res.status(400).json({ error: 'tier must be free|pro' });
  let ownerId = null;
  if (userId !== undefined && userId !== null && userId !== '') {
    ownerId = parseInt(userId);
    if (!Number.isInteger(ownerId) || !(await getUserById(ownerId))) {
      return res.status(400).json({ error: 'userId does not exist' });
    }
  }
  const key = 'sk_ss_' + crypto.randomBytes(24).toString('hex');
  const record = await createApiKey(key, typeof name === 'string' ? name.slice(0, 100) : null, tier || 'free', ownerId);
  res.json(record);
}));

// PATCH /api/admin/api-keys/:id {disabled?, userId?} — 启用/禁用、绑定/解绑归属用户
router.patch('/api-keys/:id', requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  if (req.body?.disabled !== undefined) {
    await setApiKeyDisabled(id, !!req.body.disabled);
  }
  if (req.body?.userId !== undefined) {
    let ownerId = null;
    if (req.body.userId !== null && req.body.userId !== '') {
      ownerId = parseInt(req.body.userId);
      if (!Number.isInteger(ownerId) || !(await getUserById(ownerId))) {
        return res.status(400).json({ error: 'userId does not exist' });
      }
    }
    await setApiKeyUser(id, ownerId);
  }
  invalidateKeyCache(); // 立即失效缓存，禁用/归属变更即时生效（否则最长 5 分钟仍按旧状态）
  res.json({ ok: true });
}));

// --- 用户管理（123号）---

// GET /api/admin/users?search=&page= — 用户列表+聚合统计
const USERS_PAGE_SIZE = 50;
router.get('/users', requireAdmin, asyncRoute(async (req, res) => {
  await flushCallLogs(); // 缓冲明细先落库，管理员看到的是实时数据（最多一批的开销，管理端低频可承受）
  const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 100) : '';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const { total, users } = await listUsersWithStats({
    search, limit: USERS_PAGE_SIZE, offset: (page - 1) * USERS_PAGE_SIZE,
  });
  res.json({ total, page, pageSize: USERS_PAGE_SIZE, users });
}));

// PATCH /api/admin/users/:id {disabled?, subscribed?, subscriptionExpiresAt?} — 编辑用户
router.patch('/users/:id', requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || !(await getUserById(id))) return res.status(404).json({ error: 'user not found' });
  const { disabled, subscribed, subscriptionExpiresAt } = req.body || {};
  const patch = {};
  if (disabled !== undefined) patch.disabled = !!disabled;
  if (subscribed !== undefined) patch.subscribed = !!subscribed;
  if (subscriptionExpiresAt !== undefined) {
    const normalized = normalizeExpiresAt(subscriptionExpiresAt);
    if (normalized === undefined) return res.status(400).json({ error: 'subscriptionExpiresAt must be a valid datetime string' });
    patch.subscriptionExpiresAt = normalized;
    // 设置了未来到期时间即视为订阅用户（激活 is_subscribed）；显式传 subscribed 时以显式值为准
    if (subscribed === undefined && normalized) patch.subscribed = true;
  }
  const user = await updateUserAdmin(id, patch);
  // 禁用即时生效：bump token_min_iat 杀掉存量 30 天 JWT；key 侧由 resolveTier 联查 owner_disabled，
  // 清 keyCache 让其即时生效（否则最长 5 分钟仍可用）
  if (patch.disabled === true) {
    await revokeUserTokens(id);
  }
  invalidateKeyCache(); // 订阅/禁用变更都影响 key 生效配额，统一即时失效
  res.json({ ok: true, user: {
    id: user.id, email: user.email, disabled: !!user.disabled,
    isSubscribed: !!user.is_subscribed, subscriptionExpiresAt: user.subscription_expires_at || null,
  }});
}));

// GET /api/admin/users/:id/usage?days=&channel= — 单用户用量详情（按日序列/端点TOP/明细分页）
router.get('/users/:id/usage', requireAdmin, asyncRoute(async (req, res) => {
  await flushCallLogs();
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const days = Math.max(1, Math.min(parseInt(req.query.days) || 30, 30));
  const channel = ['web', 'v1', 'mcp'].includes(req.query.channel) ? req.query.channel : null;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 100;
  const detail = await getUserUsageDetail(id, { days, channel, limit, offset: (page - 1) * limit });
  res.json({ ...detail, page, pageSize: limit });
}));

// GET /api/admin/endpoint-stats?days= — 全局功能热度（资源投放依据：哪些端点被谁在用）
router.get('/endpoint-stats', requireAdmin, asyncRoute(async (req, res) => {
  await flushCallLogs();
  const days = Math.max(1, Math.min(parseInt(req.query.days) || 30, 30));
  res.json(await getEndpointStats(days));
}));


/**
 * S5 执行状态（仅管理员，96号）：把当前信号翻译成 S5 策略（docs/s5-execution-playbook.md）
 * 的持仓状态与今日/本月动作。纯派生只读——S5 状态完全由档位序列决定：
 * defense=空仓（进入日卖出），非defense=持仓（退出defense日买回）。
 */
export function deriveS5State(rows) {
  // rows: getSnapshotHistory 输出（按日期倒序，每日一条）
  const asc = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const transitions = [];
  for (let i = 1; i < asc.length; i++) {
    const wasDef = asc[i - 1].final_signal === 'defense';
    const isDef = asc[i].final_signal === 'defense';
    if (!wasDef && isDef) transitions.push({ date: asc[i].date, kind: 'sell', from: asc[i - 1].final_signal, to: 'defense' });
    if (wasDef && !isDef) transitions.push({ date: asc[i].date, kind: 'buyback', from: 'defense', to: asc[i].final_signal });
  }
  const latest = asc[asc.length - 1] || null;
  const tier = latest?.final_signal ?? null;
  const state = tier === 'defense' ? 'in_cash' : 'in_market';
  // 今日动作：边界日给交易指令，非边界日给例行动作
  const last = transitions[transitions.length - 1];
  const boundaryToday = last && latest && last.date === latest.date;
  let todayAction;
  if (boundaryToday) todayAction = last.kind === 'sell' ? 'sell_all' : 'buyback_all';
  else if (tier === 'defense') todayAction = 'stay_cash';
  else if (tier === 'reduce') todayAction = 'hold_accumulate';   // 持有存量，本月定投进储备
  else todayAction = 'hold_deploy';                              // neutral/attack：定投+储备买入
  return { tier, state, todayAction, transitions: transitions.slice(-20), asOf: latest?.date ?? null };
}

// GET /api/admin/s5 — S5 执行台（仅管理员）
router.get('/s5', requireAdmin, asyncRoute(async (req, res) => {
  const [rows, latest, cape] = await Promise.all([
    getSnapshotHistory(365), getLatestSnapshot(), getCapeState(),
  ]);
  const s5 = deriveS5State(rows);
  // CAPE估值层（2026-07-19用户确认启用，P3档）：>90分位时attack/neutral期TQQQ目标仓位55%；
  // 数据不可用时fail-soft（layer=null，按100%显示并提示数据缺失——宁可不缩仓也不误缩）
  const capeLayer = cape
    ? { available: true, cape: cape.cape, percentile30y: cape.percentile30y, month: cape.month, active: cape.layerActive }
    : { available: false, cape: null, percentile30y: null, month: null, active: null };
  const targetWeightPct = s5.state === 'in_cash' ? 0 : (capeLayer.active === true ? 55 : 100);
  res.json({
    ...s5,
    downgradePendingSince: latest?.final_downgrade_pending_since ?? null,
    spxAboveSma10: latest?.spx_above_sma10 == null ? null : !!latest.spx_above_sma10,
    capeLayer,
    targetWeightPct,
    // 回测口径速览（日度S5a+CAPE层，docs/s5-execution-playbook.md）
    playbook: {
      xirrPct: 40.0, maxUnderwaterPct: -28.3, roundTrips26y: 9, falseSignals: 4,
      // 数字为 2026-08-04 重跑快照（趋势地板采纳后 40.1→40.0），重跑 cape-scaling/s5-daily 后须同步
      note: '日度口径含CAPE层；假信号是常态(4/9)，机械执行是前提；浮亏-28.3%来自危机中段的解锁窗往返',
    },
  });
}));

export default router;
