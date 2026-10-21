// 研究 Agent 模型选择（129号阶段5，用户 2026-10-21 定：最新 Claude Opus/Fable 优先 → 最新 Grok；弃用 DeepSeek / GLM）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const { pickLatest, resolveModel, BANNED, _resetModelCache } = await import('../research/models.js');

const m = (id, created, tools = true, prompt = '0.000004', completion = '0.00002') => ({ id, created, supported_parameters: tools ? ['tools'] : [], pricing: { prompt, completion } });
const LIST = [
  m('anthropic/claude-opus-5', 100), m('anthropic/claude-opus-5.5', 200), m('anthropic/claude-opus-5.5:batch', 201),
  m('anthropic/claude-fable-5.1', 150, true, '0.00001', '0.00005'),
  m('x-ai/grok-4.6', 180, true, '0.000002', '0.000006'), m('x-ai/grok-4.7', 190, true, '0.000002', '0.000006'),
  m('x-ai/grok-4.20-multi-agent', 300, false), m('deepseek/deepseek-v3.2', 999),
];

beforeEach(() => {
  axios.get.mockReset();
  axios.post.mockReset();
  _resetModelCache();
  process.env.OPENROUTER_API_KEY = 'k';
  delete process.env.RESEARCH_MODEL;
});

describe('pickLatest', () => {
  it('按家族优先级取最新、支持工具调用、非 batch 的模型；价格换算成每百万 token', () => {
    expect(pickLatest(LIST)).toEqual([
      { family: 'claude-opus', id: 'anthropic/claude-opus-5.5', price: { in: 4, out: 20 } },
      { family: 'claude-fable', id: 'anthropic/claude-fable-5.1', price: { in: 10, out: 50 } },
      { family: 'grok', id: 'x-ai/grok-4.7', price: { in: 2, out: 6 } },
    ]);
  });
});

describe('resolveModel', () => {
  const region403 = Object.assign(new Error('403'), { response: { status: 403, data: { error: { message: 'This model is not available in your region.' } } } });

  it('Claude 区域受限 → 依次跳过，落到 Grok；结果缓存', async () => {
    axios.get.mockResolvedValue({ data: { data: LIST } });
    axios.post.mockImplementation(async (url, body) => {
      if (body.model.startsWith('anthropic/')) throw region403;
      return { data: {} };
    });
    const r = await resolveModel();
    expect(r.id).toBe('x-ai/grok-4.7');
    expect(r.tried.map(t => t.id)).toEqual(['anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.1']);
    await resolveModel();
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('Claude 可用（如云端所在区域）→ 用最新 Opus', async () => {
    axios.get.mockResolvedValue({ data: { data: LIST } });
    axios.post.mockResolvedValue({ data: {} });
    expect((await resolveModel()).id).toBe('anthropic/claude-opus-5.5');
  });

  it('网络错误不当成"不可用"，直接抛出', async () => {
    axios.get.mockResolvedValue({ data: { data: LIST } });
    axios.post.mockRejectedValue(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }));
    await expect(resolveModel()).rejects.toThrow('ECONNRESET');
  });

  it('全部不可用 → 报错列出原因', async () => {
    axios.get.mockResolvedValue({ data: { data: LIST } });
    axios.post.mockRejectedValue(region403);
    await expect(resolveModel()).rejects.toThrow(/no research model available.*claude-opus-5.5.*grok-4.7/);
  });

  it('RESEARCH_MODEL 指定已弃用的模型 → 拒绝', async () => {
    process.env.RESEARCH_MODEL = 'deepseek/deepseek-v3.2';
    axios.get.mockResolvedValue({ data: { data: LIST } });
    await expect(resolveModel()).rejects.toThrow(/not allowed/);
    expect(BANNED.test('z-ai/glm-5.3-prime')).toBe(true);
    expect(BANNED.test('x-ai/grok-4.7')).toBe(false);
  });
});
