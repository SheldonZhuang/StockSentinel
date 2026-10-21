// 研究采集管理路由（129号）：requireAdmin 门禁 + 状态结构
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'research-admin-test-'));
process.env.DB_PATH = path.join(tmp, 'main.db');
process.env.RESEARCH_DB_PATH = path.join(tmp, 'research.db');
process.env.RESEARCH_FILINGS_DIR = path.join(tmp, 'filings');
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_EMAIL = 'admin@test.com';

// 手动触发会在后台跑采集：mock 掉 EDGAR，避免测试联网
vi.mock('../utils/edgar-client.js', async importOriginal => ({
  ...(await importOriginal()),
  edgarGet: vi.fn().mockRejectedValue(new Error('offline')),
}));

const storage = await import('../utils/storage.js');
const { default: adminRouter } = await import('../api/admin.js');
const ingest = await import('../research/ingest.js');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);

const admin = await storage.createUser('admin@test.com', 'x');
const alice = await storage.createUser('alice@test.com', 'x');
const tokenFor = u => jwt.sign({ id: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: '1h' });

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('/api/admin/research', () => {
  it('非管理员 403，未登录 401', async () => {
    await request(app).get('/api/admin/research/status').expect(401);
    await request(app).get('/api/admin/research/status').set('Authorization', `Bearer ${tokenFor(alice)}`).expect(403);
    await request(app).post('/api/admin/research/ingest').set('Authorization', `Bearer ${tokenFor(alice)}`).expect(403);
  });

  it('管理员：空库返回结构；手动触发 202，跑完后状态里有本次运行与失败记录', async () => {
    const auth = { Authorization: `Bearer ${tokenFor(admin)}` };
    const empty = await request(app).get('/api/admin/research/status').set(auth).expect(200);
    expect(empty.body).toMatchObject({ running: false, lastRun: null, coverage: [], issues: [] });

    await request(app).post('/api/admin/research/ingest').set(auth).send({ tickers: ['MSFT'] }).expect(202);
    await vi.waitFor(() => expect(ingest.isIngestRunning()).toBe(false));
    const st = await request(app).get('/api/admin/research/status').set(auth).expect(200);
    expect(st.body.lastRun).toMatchObject({ trigger: 'manual' });
    expect(st.body.issues.some(i => i.ticker === 'MSFT' && i.detail.includes('offline'))).toBe(true);
  });
});
