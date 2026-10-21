// 研究 Agent 阶段2（129号）：XBRL 事实去重与单季推算、LLM 账本与预算硬上限
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'research-xbrl-'));
process.env.RESEARCH_DB_PATH = path.join(tmp, 'research.db');
process.env.OPENROUTER_API_KEY = 'test-key';

vi.mock('axios');
const { edgarGet } = vi.hoisted(() => ({ edgarGet: vi.fn() }));
vi.mock('../utils/edgar-client.js', async importOriginal => ({ ...(await importOriginal()), edgarGet }));
const { sendAdminNotice } = vi.hoisted(() => ({ sendAdminNotice: vi.fn().mockResolvedValue({ sent: 1 }) }));
vi.mock('../utils/mailer.js', () => ({ sendAdminNotice }));
// 默认模型选择走 OpenRouter /models + 探测；这里固定成表里有价的模型，只测记账与预算
vi.mock('../research/models.js', async importOriginal => ({ ...(await importOriginal()), resolveModel: async () => ({ id: 'x-ai/grok-4.7', price: { in: 2, out: 6 } }) }));

const db = await import('../research/db.js');
const { flattenCompanyFacts, refreshXbrlFacts, queryFact } = await import('../research/xbrl.js');
const llm = await import('../research/llm.js');
await db.getResearchDb();

afterAll(() => { db._closeResearchDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

const fact = (start, end, val, accn, filed, form = '10-Q') => ({ start, end, val, accn, filed, form, fy: 2026, fp: 'Q2' });
const FACTS = {
  facts: {
    dei: { EntityCommonStockSharesOutstanding: { units: { shares: [fact(null, '2026-06-30', 1, 'x', '2026-07-01')] } } },
    'us-gaap': {
      Capex: {
        units: {
          USD: [
            fact('2026-01-01', '2026-03-31', 30, 'q1', '2026-04-30'),
            fact('2026-01-01', '2026-06-30', 75, 'q2', '2026-07-30'), // 只有 6M YTD：单季 = 75 − 30
            fact('2026-01-01', '2026-06-30', 76, 'q2a', '2026-08-15'), // 同期间重述：保留最新申报
            fact('2026-01-01', '2026-06-30', 99, '8k', '2026-07-29', '8-K'), // 非定期报告不收
            fact('2023-01-01', '2023-03-31', 1, 'old', '2023-04-30'), // 早于窗口
          ],
        },
      },
      Empty: { units: { USD: {} } }, // 119号：EDGAR 空对象
      Revenue: { units: { USD: [fact('2026-04-01', '2026-06-30', 200, 'q2', '2026-07-30')] } },
    },
  },
};

describe('XBRL', () => {
  it('flattenCompanyFacts：跳过 dei/空对象/非定期报告/窗口外，同期间保留最新申报', () => {
    const rows = flattenCompanyFacts(FACTS, 'T', '2025-01-01');
    expect(rows.map(r => `${r.concept}:${r.value}`).sort()).toEqual(['Capex:30', 'Capex:76', 'Revenue:200']);
  });

  it('queryFact：有单季直接取；只有 YTD 时差分推算并标 derived；期末 ±7 天容差', async () => {
    edgarGet.mockResolvedValue({ data: FACTS });
    expect(await refreshXbrlFacts('T', '0000000001', '2025-01-01')).toBe(3);
    expect(queryFact('T', ['Revenue'], '2026-06-30').value).toBe(200);
    const capex = queryFact('T', ['Nope', 'Capex'], '2026-07-03');
    expect(capex.value).toBe(46);
    expect(capex.derived).toMatch(/6M YTD q2a − 3M YTD q1/);
    expect(queryFact('T', ['Capex'], '2026-09-30')).toBe(null);
  });
});

describe('LLM 账本与预算', () => {
  beforeEach(() => {
    db.run('DELETE FROM llm_runs');
    axios.post.mockReset();
    sendAdminNotice.mockClear();
  });
  const msgs = [{ role: 'user', content: 'x'.repeat(300) }];
  const ok = (cost = 0.001) => ({ data: { choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost } } });
  const seed = (pool, cost, ref = null, at = new Date().toISOString().replace('T', ' ').slice(0, 19)) =>
    db.run("INSERT INTO llm_runs (pool, purpose, ref, model, cost_usd, ok, created_at) VALUES (?, 'x', ?, 'm', ?, 1, ?)", [pool, ref, cost, at]);

  it('成功调用记账：token、成本（优先用 usage.cost）、耗时', async () => {
    axios.post.mockResolvedValue(ok(0.0042));
    const r = await llm.chat({ pool: 'research', purpose: 'test', ticker: 'MSFT', messages: msgs, maxTokens: 100 });
    expect(r).toMatchObject({ text: '{"a":1}', tokensIn: 100, tokensOut: 20, costUsd: 0.0042 });
    expect(axios.post.mock.calls[0][1]).toMatchObject({ max_tokens: 100, usage: { include: true } });
    expect(db.get('SELECT pool, ticker, tokens_in, cost_usd, ok FROM llm_runs')).toEqual({ pool: 'research', ticker: 'MSFT', tokens_in: 100, cost_usd: 0.0042, ok: 1 });
  });

  it('失败调用也记一行（ok=0）并抛出', async () => {
    axios.post.mockRejectedValue(Object.assign(new Error('402'), { response: { status: 402 } }));
    await expect(llm.chat({ pool: 'research', purpose: 't', messages: msgs, maxTokens: 100 })).rejects.toThrow('402');
    expect(db.get('SELECT ok, error FROM llm_runs')).toMatchObject({ ok: 0, error: '402' });
  });

  it('日额度用尽 → 不发请求、抛 BudgetExceededError、只告警一次', async () => {
    seed('research', 0.5);
    for (let i = 0; i < 2; i++) {
      await expect(llm.chat({ pool: 'research', purpose: 't', messages: msgs, maxTokens: 100 })).rejects.toBeInstanceOf(llm.BudgetExceededError);
    }
    expect(axios.post).not.toHaveBeenCalled();
    expect(sendAdminNotice).toHaveBeenCalledTimes(1);
  });

  it('ask 计入日常总额且有自己的月上限；backfill 与日常分开', () => {
    // 本月早些天 ask 已花 3（不占今天的日额度）：ask 月额度用尽，但普通 research 调用仍放行
    const now = new Date('2026-10-21T12:00:00Z');
    seed('ask', 3, null, '2026-10-05 00:00:00');
    expect(llm.checkBudget('ask', 0.001, { now })).toMatch(/ask_company/);
    expect(llm.checkBudget('research', 0.001, { now })).toBe(null);
    // 今天 ask 花 0.5：计入日常日额度 → research 也被拦
    seed('ask', 0.5, null, '2026-10-21 01:00:00');
    expect(llm.checkBudget('research', 0.001, { now })).toMatch(/日额度/);
    db.run('DELETE FROM llm_runs');
    // 日常月额度 5 包含 ask
    seed('ask', 2, null, '2026-10-03 00:00:00');
    seed('research', 2.9, null, '2026-10-04 00:00:00');
    expect(llm.checkBudget('research', 0.2, { now })).toMatch(/月额度/);
    db.run('DELETE FROM llm_runs');
    seed('backfill', 2.99);
    expect(llm.checkBudget('research', 0.001)).toBe(null);
    expect(llm.checkBudget('backfill', 0.02)).toMatch(/回填/);
  });

  it('月额度按 UTC 月汇总；eval 按轮次且必须带 evalRunId', () => {
    seed('research', 4.9, null, '2026-10-01 00:00:00');
    expect(llm.checkBudget('research', 0.2, { now: new Date('2026-10-21T00:00:00Z') })).toMatch(/月额度/);
    expect(llm.checkBudget('research', 0.2, { now: new Date('2026-11-01T00:00:00Z') })).toBe(null);
    expect(llm.checkBudget('eval', 1)).toMatch(/evalRunId/);
    seed('eval', 11.5, 'run1:x');
    expect(llm.checkBudget('eval', 1, { evalRunId: 'run1' })).toMatch(/run1/);
    expect(llm.checkBudget('eval', 1, { evalRunId: 'run2' })).toBe(null);
  });

  it('没有价格的模型、没有 maxTokens 一律拒绝', async () => {
    await expect(llm.chat({ pool: 'research', purpose: 't', model: 'x/unknown', messages: msgs, maxTokens: 10 })).rejects.toThrow(/price/);
    await expect(llm.chat({ pool: 'research', purpose: 't', messages: msgs })).rejects.toThrow(/maxTokens/);
    expect(axios.post).not.toHaveBeenCalled();
  });
});
