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
  getSnapshotHistory,
  getLatestSnapshot,
  getAlertSubscribers,
} from '../utils/storage.js';
import { sendSignalAlert } from '../utils/mailer.js';
import { fetchFederalRegister } from './fetch-federal-register.js';
import { fetchAiSupplyNews } from './fetch-rss.js';
import chainCfg from '../config/ai-chain.config.js';
import { asyncRoute } from '../utils/async-route.js';
import { invalidateKeyCache } from './public.js';
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
  // capex_guidance 是事件型输入（N3 指引下修）：只有 tight 一个合法档位——
  // 事件存在即 capex 子信号收紧，"宽松的指引"不构成事件（数据口径自会体现）
  if (type === 'capex_guidance' && signal !== 'tight') {
    return res.status(400).json({ error: 'capex_guidance only accepts signal=tight (the event itself means downgrade)' });
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
router.post('/lock-override', requireAdmin, asyncRoute(async (req, res) => {
  const { type, expiresAt, note } = req.body;

  if (!VALID_LOCK_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_LOCK_TYPES.join(', ')}` });
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

// POST /api/admin/api-keys {name, tier} — 签发新密钥
router.post('/api-keys', requireAdmin, asyncRoute(async (req, res) => {
  const { name, tier } = req.body || {};
  if (tier && !['free', 'pro'].includes(tier)) return res.status(400).json({ error: 'tier must be free|pro' });
  const key = 'sk_ss_' + crypto.randomBytes(24).toString('hex');
  const record = await createApiKey(key, typeof name === 'string' ? name.slice(0, 100) : null, tier || 'free');
  res.json(record);
}));

// PATCH /api/admin/api-keys/:id {disabled} — 启用/禁用
router.patch('/api-keys/:id', requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  await setApiKeyDisabled(id, !!req.body?.disabled);
  invalidateKeyCache(); // 立即失效缓存，禁用即时生效（否则最长 5 分钟仍可用）
  res.json({ ok: true });
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
      xirrPct: 40.1, maxUnderwaterPct: -28.3, roundTrips26y: 9, falseSignals: 4,
      note: '日度口径含CAPE层；假信号是常态(4/9)，机械执行是前提；浮亏-28.3%来自危机中段的解锁窗往返',
    },
  });
}));

export default router;
