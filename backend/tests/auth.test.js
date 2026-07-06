import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock storage 模块（避免真实 SQLite I/O）
vi.mock('../utils/storage.js', () => ({
  createUser: vi.fn(),
  getUserByEmail: vi.fn(),
}));

import request from 'supertest';
import express from 'express';
import authRouter from '../api/auth.js';
import * as storage from '../utils/storage.js';
import bcrypt from 'bcryptjs';

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret';
  vi.clearAllMocks();
});

describe('POST /api/auth/register', () => {
  it('成功注册返回 token', async () => {
    storage.getUserByEmail.mockResolvedValue(null);
    storage.createUser.mockResolvedValue({ id: 1, email: 'test@example.com' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.email).toBe('test@example.com');
  });

  it('重复邮箱返回 409', async () => {
    storage.getUserByEmail.mockResolvedValue({ id: 1, email: 'test@example.com' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', password: 'password123' });

    expect(res.status).toBe(409);
  });

  it('密码少于8位返回 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', password: 'short' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('正确密码返回 token', async () => {
    const hash = await bcrypt.hash('password123', 10);
    storage.getUserByEmail.mockResolvedValue({ id: 1, email: 'test@example.com', password_hash: hash });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@example.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('错误密码返回 401', async () => {
    const hash = await bcrypt.hash('correctpassword', 10);
    storage.getUserByEmail.mockResolvedValue({ id: 1, email: 'test@example.com', password_hash: hash });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@example.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
  });

  it('不存在的邮箱返回 401', async () => {
    storage.getUserByEmail.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'notexist@example.com', password: 'password123' });

    expect(res.status).toBe(401);
  });
});
