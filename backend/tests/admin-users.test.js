// 用户管理（123号）测试：真实 sql.js 临时库覆盖存储层（迁移/统计/订阅判定/日志），
// supertest 覆盖管理路由（requireAdmin 门禁/编辑语义/到期降级联查）
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

const tmpDb = path.join(os.tmpdir(), `stock-sentinel-users-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_EMAIL = 'admin@test.com';

const storage = await import('../utils/storage.js');
const { default: adminRouter } = await import('../api/admin.js');
const { rateLimit } = await import('../api/public.js');
const { recordCall, flushCallLogs } = await import('../utils/usage-log.js');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);

function tokenFor(user) {
  return jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

let admin, alice, bob;

beforeAll(async () => {
  admin = await storage.createUser('admin@test.com', 'x');
  alice = await storage.createUser('alice@test.com', 'x');
  bob = await storage.createUser('bob@test.com', 'x');
});

afterAll(() => {
  try { fs.unlinkSync(tmpDb); } catch { /* 已清理 */ }
});

describe('isSubscriptionActive 单一口径', () => {
  it('未订阅 false；订阅无到期 true；到期未来 true；已过期 false', () => {
    expect(storage.isSubscriptionActive({ is_subscribed: 0 })).toBe(false);
    expect(storage.isSubscriptionActive({ is_subscribed: 1, subscription_expires_at: null })).toBe(true);
    expect(storage.isSubscriptionActive({ is_subscribed: 1, subscription_expires_at: '2099-01-01 00:00:00' })).toBe(true);
    expect(storage.isSubscriptionActive({ is_subscribed: 1, subscription_expires_at: '2020-01-01 00:00:00' })).toBe(false);
  });
});

describe('调用明细：缓冲落库与聚合', () => {
  it('recordCall + flush 后可按用户/端点聚合', async () => {
    recordCall({ userId: alice.id, channel: 'web', endpoint: '/api/signal', status: 200 });
    recordCall({ userId: alice.id, channel: 'v1', endpoint: '/v1/signal', status: 200 });
    recordCall({ userId: alice.id, channel: 'v1', endpoint: '/v1/signal', status: 429 });
    recordCall({ channel: 'v1', endpoint: '/v1/signal', status: 200 }); // 匿名，不归属用户
    await flushCallLogs();

    const detail = await storage.getUserUsageDetail(alice.id, { days: 30 });
    expect(detail.total).toBe(3);
    expect(detail.endpoints.find(e => e.endpoint === '/v1/signal').count).toBe(2);

    const chFiltered = await storage.getUserUsageDetail(alice.id, { days: 30, channel: 'web' });
    expect(chFiltered.total).toBe(1);

    const global = await storage.getEndpointStats(30);
    const v1sig = global.find(e => e.endpoint === '/v1/signal' && e.channel === 'v1');
    expect(v1sig.count).toBe(3); // 含匿名流量
  });

  it('pruneCallLogs 清理保留期外明细', async () => {
    await storage.insertCallLogs([{ ts: '2020-01-01 00:00:00', channel: 'v1', endpoint: '/v1/old', status: 200 }]);
    await storage.pruneCallLogs('2021-01-01 00:00:00');
    const global = await storage.getEndpointStats(30);
    expect(global.find(e => e.endpoint === '/v1/old')).toBeUndefined();
  });
});

describe('GET /api/admin/users', () => {
  it('非管理员 403', async () => {
    const res = await request(app).get('/api/admin/users')
      .set('Authorization', `Bearer ${tokenFor(alice)}`);
    expect(res.status).toBe(403);
  });

  it('管理员可见列表+统计字段', async () => {
    const res = await request(app).get('/api/admin/users')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    const a = res.body.users.find(u => u.email === 'alice@test.com');
    expect(a.total_30d).toBe(3);
    expect(a.subscription_active).toBe(0);
    expect(a).toHaveProperty('last_call_at');
    expect(a).toHaveProperty('api_total_alltime');
  });

  it('搜索按邮箱过滤', async () => {
    const res = await request(app).get('/api/admin/users?search=bob')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.body.total).toBe(1);
    expect(res.body.users[0].email).toBe('bob@test.com');
  });
});

describe('PATCH /api/admin/users/:id', () => {
  it('设置未来到期时间即视为订阅用户', async () => {
    const res = await request(app).patch(`/api/admin/users/${alice.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ subscriptionExpiresAt: '2099-01-01T00:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.user.isSubscribed).toBe(true);
    const row = await storage.getUserById(alice.id);
    expect(storage.isSubscriptionActive(row)).toBe(true);
  });

  it('禁用用户：disabled 落库且 token_min_iat 被 bump（存量 JWT 失效）', async () => {
    const res = await request(app).patch(`/api/admin/users/${bob.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ disabled: true });
    expect(res.status).toBe(200);
    const row = await storage.getUserById(bob.id);
    expect(row.disabled).toBe(1);
    expect(row.token_min_iat).toBeGreaterThan(0);
  });

  it('不存在的用户 404；非法到期时间 400', async () => {
    const r1 = await request(app).patch('/api/admin/users/99999')
      .set('Authorization', `Bearer ${tokenFor(admin)}`).send({ disabled: true });
    expect(r1.status).toBe(404);
    const r2 = await request(app).patch(`/api/admin/users/${alice.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ subscriptionExpiresAt: 'not-a-date' });
    expect(r2.status).toBe(400);
  });
});

describe('订阅到期自动降级（resolveTier 经 rateLimit 观测）', () => {
  function mockReqRes(key) {
    const headers = { 'x-api-key': key };
    const req = { get: (h) => headers[h.toLowerCase()], ip: '1.2.3.4' };
    const res = {
      headers: {}, statusCode: null, body: null,
      set(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
    return { req, res };
  }

  it('pro key 绑定已过期订阅用户 → 按 free 配额（X-RateLimit-Limit=250）', async () => {
    const expired = await storage.createUser('expired@test.com', 'x');
    await storage.updateUserAdmin(expired.id, { subscribed: true, subscriptionExpiresAt: '2020-01-01 00:00:00' });
    const { key } = await storage.createApiKey('sk_ss_' + 'e'.repeat(48), 'expired pro', 'pro', expired.id);

    const { req, res } = mockReqRes(key);
    await rateLimit(req, res, () => {});
    expect(res.headers['X-RateLimit-Limit']).toBe('250');
  });

  it('pro key 绑定有效订阅用户 → pro 配额（10000）', async () => {
    const active = await storage.createUser('active@test.com', 'x');
    await storage.updateUserAdmin(active.id, { subscribed: true, subscriptionExpiresAt: '2099-01-01 00:00:00' });
    const { key } = await storage.createApiKey('sk_ss_' + 'a'.repeat(48), 'active pro', 'pro', active.id);

    const { req, res } = mockReqRes(key);
    await rateLimit(req, res, () => {});
    expect(res.headers['X-RateLimit-Limit']).toBe('10000');
  });

  it('无归属用户的 pro key 行为不变（10000）', async () => {
    const { key } = await storage.createApiKey('sk_ss_' + 'n'.repeat(48), 'legacy pro', 'pro');
    const { req, res } = mockReqRes(key);
    await rateLimit(req, res, () => {});
    expect(res.headers['X-RateLimit-Limit']).toBe('10000');
  });

  it('禁用用户名下的 key 返回 401', async () => {
    const banned = await storage.createUser('banned@test.com', 'x');
    const { key } = await storage.createApiKey('sk_ss_' + 'b'.repeat(48), 'banned key', 'pro', banned.id);
    await storage.updateUserAdmin(banned.id, { disabled: true });
    const { invalidateKeyCache } = await import('../api/public.js');
    invalidateKeyCache();

    const { req, res } = mockReqRes(key);
    let nextCalled = false;
    await rateLimit(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
