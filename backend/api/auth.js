import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createUser, getUserByEmail } from '../utils/storage.js';
import { asyncRoute } from '../utils/async-route.js';

const router = express.Router();
const SALT_ROUNDS = 10;

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
  if (!user) return res.status(401).json({ error: 'invalid credentials' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'invalid credentials' });

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
    req.user = jwt.verify(token, process.env.JWT_SECRET);
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
