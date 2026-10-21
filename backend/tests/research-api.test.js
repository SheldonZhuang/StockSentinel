// /v1/research 端点与 ask 额度（129号阶段5）：keyless 不开放 ask、free 每日 5 次、拒答买卖建议、笔记 404/命中
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { askCompany, getNote, listNotes } = vi.hoisted(() => ({ askCompany: vi.fn(), getNote: vi.fn(), listNotes: vi.fn() }));
vi.mock('../research/ask.js', () => ({ askCompany, getNote, listNotes }));
vi.mock('../utils/storage.js', async importOriginal => ({
  ...(await importOriginal()),
  getApiKeyRecord: vi.fn(async key => (key.startsWith('free-key-') ? { id: key.length, tier: 'free', user_id: null } : null)),
  loadApiUsage: vi.fn(async () => []),
  upsertApiUsage: vi.fn(async () => {}),
}));
vi.mock('../utils/usage-log.js', () => ({ callLogger: () => (req, res, next) => next(), recordCall: () => {} }));

const { default: router, takeAskQuota } = await import('../api/public.js');
const app = express();
app.use(express.json());
app.use('/v1', router);

beforeEach(() => {
  askCompany.mockReset().mockResolvedValue({ ticker: 'NVDA', question: 'q', answer: [{ text: 'a', sources: [] }], unverified: 0 });
  getNote.mockReset();
  listNotes.mockReset().mockResolvedValue([{ ticker: 'NVDA', fiscal_label: 'FY2027Q2' }]);
});

describe('/v1/research/notes', () => {
  it('列表、命中、不存在 404；省略季度取最新', async () => {
    expect((await request(app).get('/v1/research/notes')).body.notes).toHaveLength(1);
    getNote.mockResolvedValueOnce({ ticker: 'NVDA', fiscal_period: 'FY2027Q2' });
    const ok = await request(app).get('/v1/research/notes/NVDA/FY2027Q2');
    expect(ok.status).toBe(200);
    expect(ok.body.disclaimer).toMatch(/not investment advice/i);
    expect(getNote).toHaveBeenLastCalledWith('NVDA', 'FY2027Q2');
    getNote.mockResolvedValueOnce(null);
    expect((await request(app).get('/v1/research/notes/NVDA')).status).toBe(404);
    expect(getNote).toHaveBeenLastCalledWith('NVDA', undefined);
  });
});

describe('/v1/research/ask', () => {
  it('不带 key → 403（keyless 不开放）', async () => {
    const r = await request(app).post('/v1/research/ask').send({ ticker: 'NVDA', question: '数据中心收入多少' });
    expect(r.status).toBe(403);
    expect(askCompany).not.toHaveBeenCalled();
  });

  it('free key：前 5 次放行，第 6 次 429', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/v1/research/ask').set('X-API-Key', 'free-key-123456').send({ ticker: 'NVDA', question: `q${i}` });
      expect(r.status).toBe(200);
    }
    const r = await request(app).post('/v1/research/ask').set('X-API-Key', 'free-key-123456').send({ ticker: 'NVDA', question: 'q6' });
    expect(r.status).toBe(429);
    expect(askCompany).toHaveBeenCalledTimes(5);
  });

  it('额度函数：pro 50 次；不同调用方各自计数', () => {
    expect(takeAskQuota({ keyId: 1, tier: 'pro', identifier: 'p' })).toBe(null);
    expect(takeAskQuota({ keyId: null, identifier: 'ip:1' })).toMatchObject({ status: 403 });
  });

  it('拒答（买卖建议）→ 400（另一个 key，额度独立计数）', async () => {
    askCompany.mockResolvedValueOnce({ refused: '不提供买卖建议' });
    expect((await request(app).post('/v1/research/ask').set('X-API-Key', 'free-key-second-0001').send({ ticker: 'NVDA', question: '该不该买' })).status).toBe(400);
  });
});
