import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createUser, getUserByEmail } from '../utils/storage.js';
import { asyncRoute } from '../utils/async-route.js';
import { ipRateLimit } from '../utils/ip-rate-limit.js';

const router = express.Router();
const SALT_ROUNDS = 10;

// 固定 dummy hash：登录时对不存在的用户也跑一次等价 bcrypt.compare，消除"邮箱是否注册"的时序差
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-safety', SALT_ROUNDS);

// bcrypt 是 CPU 密集操作，注册/登录不限流会被匿名高频请求打满 CPU 拖垮信号主链路
const authLimiter = ipRateLimit({ max: 20 });
router.use(['/register', '/login'], authLimiter);

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// POST /api/auth/register
router.post('/register', asyncRoute(async (req, res) => {
  const { email, password } = req.body;
  // 必须校验类型：非字符串 password 会让 bcrypt.hash 抛错
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

  const existing = await getUserByEmail(email);
  if (existing) return res.status(409).json({ error: 'email already registered' });

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await createUser(email, hash);
  const token = signToken(user);
  res.json({ token, user: { id: user.id, email: user.email } });
}));

// POST /api/auth/login
router.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body;
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

// --- JWT 中间件 ---
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

// --- 可选管理员中间件 ---
export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.email !== process.env.ADMIN_EMAIL) {
      return res.status(403).json({ error: 'admin only' });
    }
    next();
  });
}

export default router;
