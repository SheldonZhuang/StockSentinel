import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createUser, getUserByEmail, getUserById, revokeUserTokens } from '../utils/storage.js';
import { asyncRoute } from '../utils/async-route.js';
import { ipRateLimit } from '../utils/ip-rate-limit.js';

const router = express.Router();
const SALT_ROUNDS = 10;

// 固定 dummy hash：登录时对不存在的用户也跑一次等价 bcrypt.compare，消除"邮箱是否注册"的时序差
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-safety', SALT_ROUNDS);

// bcrypt 是 CPU 密集操作，注册/登录不限流会被匿名高频请求打满 CPU 拖垮信号主链路。
// 双层串联（120号）：
//  ① 纯 IP 层（60/min）——ip|email 键每换一个邮箱就是一个全新的 20/min 桶，单 IP 旋转
//    随机邮箱可无限触发 bcrypt.hash 打满事件循环（CPU DoS）；纯 IP 层封顶单 IP 总量。
//    60/min 足够宽，Vercel 代理同出口 IP 的正常登录流量不会误触
//  ② IP+邮箱层（20/min，2026-07-30 M2）——暴力尝试单个账号时误伤面收敛到该账号，
//    不会封掉全站登录
const authIpLimiter = ipRateLimit({ max: 60 });
const authLimiter = ipRateLimit({
  max: 20,
  keyFn: req => `${req.ip}|${typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''}`,
});
router.use(['/register', '/login'], authIpLimiter, authLimiter);

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// 邮箱归一：去空白+小写。大小写不同的"重复"账号、ADMIN_EMAIL 大小写不一致锁死管理员
// 都源于未归一比较
const normalizeEmail = e => (typeof e === 'string' ? e.trim().toLowerCase() : e);
const adminEmail = () => normalizeEmail(process.env.ADMIN_EMAIL || '');

/**
 * 管理员账户种子（2026-07-30，H3）：配置 ADMIN_PASSWORD 时确保管理员账户存在。
 * 配合注册接口拒绝 ADMIN_EMAIL，堵住空库窗口的管理员邮箱抢注。
 * 未配置 ADMIN_PASSWORD 时不种子（沿用旧行为：管理员自行注册，日志提示风险）。
 */
export async function ensureAdminUser() {
  const email = adminEmail();
  const password = process.env.ADMIN_PASSWORD;
  if (!email) return;
  if (!password) {
    console.warn('[auth] ADMIN_PASSWORD not set — admin account not seeded; first registration of ADMIN_EMAIL becomes admin (set ADMIN_PASSWORD to close this window)');
    return;
  }
  const existing = await getUserByEmail(email);
  if (existing) return;
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  await createUser(email, hash);
  console.log('[auth] admin account seeded from ADMIN_EMAIL/ADMIN_PASSWORD');
}

// POST /api/auth/register
router.post('/register', asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  // 必须校验类型：非字符串 password 会让 bcrypt.hash 抛错
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  // ADMIN_PASSWORD 已配置时管理员账户由启动种子创建，公开注册一律拒绝该邮箱（防抢注）
  if (email === adminEmail() && process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'this email is reserved' });
  }

  const existing = await getUserByEmail(email);
  if (existing) return res.status(409).json({ error: 'email already registered' });

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  let user;
  try {
    user = await createUser(email, hash);
  } catch (err) {
    // 并发重复注册撞 UNIQUE 约束：返回 409 而非 500
    if (/UNIQUE/i.test(err.message)) return res.status(409).json({ error: 'email already registered' });
    throw err;
  }
  const token = signToken(user);
  res.json({ token, user: { id: user.id, email: user.email } });
}));

// POST /api/auth/login
router.post('/login', asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  const user = await getUserByEmail(email);
  // 对不存在的用户也跑一次 bcrypt.compare（对比 dummy hash），消除时序差导致的用户枚举
  const match = user
    ? await bcrypt.compare(password, user.password_hash)
    : (await bcrypt.compare(password, DUMMY_HASH), false);
  if (!user || !match) return res.status(401).json({ error: 'invalid credentials' });

  const token = signToken(user);
  res.json({ token, user: { id: user.id, email: user.email } });
}));

// GET /api/auth/me  (需要 JWT 中间件)
router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  res.json({ id: req.user.id, email: req.user.email });
}));

// POST /api/auth/logout-all — 吊销本账户所有既发 token（116号：JWT 30天有效期的止损开关，
// token 疑似泄漏时调用；之后所有旧 token 失效，需重新登录）
router.post('/logout-all', requireAuth, asyncRoute(async (req, res) => {
  await revokeUserTokens(req.user.id);
  res.json({ ok: true, message: 'all tokens revoked, please log in again' });
}));

// --- JWT 中间件 ---
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
  // 吊销检查（116号）：iat 早于用户 token_min_iat 的 token 已被 logout-all 作废。
  // sql.js 全内存查询，单次 get 开销微秒级，不构成每请求性能问题
  getUserById(decoded.id).then(user => {
    if (user?.token_min_iat && (decoded.iat ?? 0) < user.token_min_iat) {
      return res.status(401).json({ error: 'token revoked, please log in again' });
    }
    req.user = decoded;
    next();
  }).catch(next);
}

// --- 可选管理员中间件 ---
export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (normalizeEmail(req.user.email) !== adminEmail()) {
      return res.status(403).json({ error: 'admin only' });
    }
    next();
  });
}

export { normalizeEmail };

export default router;
