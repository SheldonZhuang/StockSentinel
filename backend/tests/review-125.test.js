// 125号第九轮审查修复的回归测试：usage-log 有界重插/单飞/端点归一、
// alert 过滤 disabled、self-disable 403、订阅时间范围校验、/v1/openapi.yaml 自发现
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

const tmpDb = path.join(os.tmpdir(), `stock-sentinel-r9-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_EMAIL = 'admin@r9.test';

const storage = await import('../utils/storage.js');
const { normalizeEndpoint, recordCall, flushCallLogs } = await import('../utils/usage-log.js');
const { default: adminRouter } = await import('../api/admin.js');
const { default: publicRouter } = await import('../api/public.js');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);
app.use('/v1', publicRouter);

function tokenFor(user) {
  return jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

let admin, victim;
beforeAll(async () => {
  admin = await storage.createUser('admin@r9.test', 'x');
  victim = await storage.createUser('victim@r9.test', 'x');
});

afterAll(() => {
  try { fs.unlinkSync(tmpDb); } catch { /* 已清理 */ }
});

describe('normalizeEndpoint（审查#2：端点值域封闭）', () => {
  it('404 归并哨兵；动态段归一；正常路径原样', () => {
    expect(normalizeEndpoint('/api/junk/random-12345', 404)).toBe('_unmatched');
    expect(normalizeEndpoint('/v1/stock/NVDA', 200)).toBe('/v1/stock/:symbol');
    expect(normalizeEndpoint('/api/watchlist/TSLA', 200)).toBe('/api/watchlist/:symbol');
    expect(normalizeEndpoint('/api/admin/users/42', 200)).toBe('/api/admin/users/:id');
    expect(normalizeEndpoint('/api/admin/users/42/usage', 200)).toBe('/api/admin/users/:id/usage');
    expect(normalizeEndpoint('/api/signal', 200)).toBe('/api/signal');
    // 动态段归一优先于 404 哨兵（不存在的标的也计入该端点热度）
    expect(normalizeEndpoint('/v1/stock/NOSUCH', 404)).toBe('/v1/stock/:symbol');
  });

  it('超长路径截断到 120', () => {
    expect(normalizeEndpoint('/api/' + 'x'.repeat(300), 200).length).toBe(120);
  });
});

describe('flushCallLogs（审查#1/#6：有界重插与单飞）', () => {
  it('落库失败时重插不超过缓冲上限，且不抛出', async () => {
    const spy = vi.spyOn(storage, 'insertCallLogs');
    // 模拟持续失败
    spy.mockRejectedValue(new Error('disk full'));
    for (let i = 0; i < 100; i++) recordCall({ channel: 'v1', endpoint: '/v1/signal', status: 200 });
    await expect(flushCallLogs()).resolves.toBeUndefined();
    await expect(flushCallLogs()).resolves.toBeUndefined(); // 重插后再失败一轮也不增长爆炸
    spy.mockRestore();
    // 恢复后一次成功刷盘清空缓冲
    await flushCallLogs();
    const stats = await storage.getEndpointStats(1);
    expect(stats.find(e => e.endpoint === '/v1/signal')?.count).toBeGreaterThan(0);
  });

  it('并发调用共享同一次 flush（单飞）', async () => {
    recordCall({ channel: 'v1', endpoint: '/v1/singleflight', status: 200 });
    const [a, b] = [flushCallLogs(), flushCallLogs()];
    expect(a).toBe(b); // 同一个 Promise
    await a;
  });
});

describe('getAlertSubscribers 过滤禁用用户（125号用户拍板：禁用=封禁停邮）', () => {
  it('禁用后不再出现在订阅名单', async () => {
    const before = await storage.getAlertSubscribers();
    expect(before.some(s => s.email === 'victim@r9.test')).toBe(true);
    await storage.updateUserAdmin(victim.id, { disabled: true });
    const after = await storage.getAlertSubscribers();
    expect(after.some(s => s.email === 'victim@r9.test')).toBe(false);
    await storage.updateUserAdmin(victim.id, { disabled: false }); // 还原
  });
});

describe('PATCH /api/admin/users/:id 防护（审查#9/#10）', () => {
  it('管理员禁用自己返回 403（自锁防护）', async () => {
    const res = await request(app).patch(`/api/admin/users/${admin.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ disabled: true });
    expect(res.status).toBe(403);
    const row = await storage.getUserById(admin.id);
    expect(row.disabled || 0).toBe(0);
  });

  it('订阅到期时间超出 2000-2100 合理范围返回 400（垃圾值防降级）', async () => {
    const res = await request(app).patch(`/api/admin/users/${victim.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ subscriptionExpiresAt: '123' }); // new Date('123') = 公元123年
    expect(res.status).toBe(400);
    const ok = await request(app).patch(`/api/admin/users/${victim.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ subscriptionExpiresAt: '2027-01-01T00:00:00Z' });
    expect(ok.status).toBe(200);
  });
});

describe('GET /v1/openapi.yaml（125号 GEO 自发现）', () => {
  it('返回 YAML 规范且免日配额（无 X-RateLimit 头）', async () => {
    const res = await request(app).get('/v1/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('yaml');
    expect(res.text).toContain('openapi: 3.0.3');
    expect(res.text).toContain('llms.txt'); // GEO 互链已写入 info
    expect(res.headers['x-ratelimit-limit']).toBeUndefined(); // 发现流程不计量
  });
});
