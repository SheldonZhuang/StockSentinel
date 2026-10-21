// 模型选择（用户 2026-10-21："能用 Claude 就用，不能用就用 Grok 最新版"；DeepSeek / GLM 永久弃用）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const { buildCandidates, resolveModel, resolveOpenRouterModel, providerFor, BANNED, _resetModelCache } = await import('../research/models.js');

const m = (id, created, tools = true, prompt = '0.000004', completion = '0.00002') => ({ id, created, supported_parameters: tools ? ['tools'] : [], pricing: { prompt, completion } });
const OR = [
  m('anthropic/claude-opus-5', 100), m('anthropic/claude-opus-5.5', 200), m('anthropic/claude-opus-5.5:batch', 201),
  m('anthropic/claude-fable-5.1', 150, true, '0.00001', '0.00005'),
  m('x-ai/grok-4.6', 180, true, '0.000002', '0.000006'), m('x-ai/grok-4.7', 190, true, '0.000002', '0.000006'),
  m('x-ai/grok-4.20-multi-agent', 300, false), m('deepseek/deepseek-v3.2', 999),
];
const GW = ['claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'];
const region403 = Object.assign(new Error('403'), { response: { status: 403, data: { error: { message: 'This model is not available in your region.' } } } });
const gw503 = Object.assign(new Error('503'), { response: { status: 503, data: { error: { message: '当前没有可用的服务渠道' } } } });

beforeEach(() => {
  axios.get.mockReset();
  axios.post.mockReset();
  _resetModelCache();
  process.env.OPENROUTER_API_KEY = 'k';
  delete process.env.RESEARCH_MODEL;
  delete process.env.CLAUDE_GATEWAY_URL;
  delete process.env.CLAUDE_GATEWAY_KEY;
});

function mockLists() {
  axios.get.mockImplementation(async url => (url.includes('openrouter') ? { data: { data: OR } } : { data: { data: GW.map(id => ({ id })) } }));
}

describe('buildCandidates', () => {
  it('顺序：OpenRouter Claude（Opus、Fable 最新）→ 网关 Claude（Opus、Fable 最新）→ Grok 最新；排除 batch / 无工具 / 弃用模型', () => {
    expect(buildCandidates(OR, GW).map(c => c.id)).toEqual([
      'anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.1', 'gateway:claude-opus-5-5', 'gateway:claude-fable-5-1', 'x-ai/grok-4.7',
    ]);
    expect(buildCandidates(OR, null).map(c => c.id)).toEqual(['anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.1', 'x-ai/grok-4.7']);
    expect(buildCandidates(OR, GW).find(c => c.id === 'anthropic/claude-opus-5.5').price).toEqual({ in: 4, out: 20 });
  });
});

describe('providerFor', () => {
  it('gateway: 前缀走网关的 OpenAI 兼容接口，其余走 OpenRouter', () => {
    process.env.CLAUDE_GATEWAY_URL = 'https://gw.example/';
    process.env.CLAUDE_GATEWAY_KEY = 'g';
    expect(providerFor('gateway:claude-opus-5-5')).toMatchObject({ provider: 'gateway', url: 'https://gw.example/v1/chat/completions', key: 'g', model: 'claude-opus-5-5' });
    expect(providerFor('x-ai/grok-4.7')).toMatchObject({ provider: 'openrouter', key: 'k', model: 'x-ai/grok-4.7' });
  });
});

describe('resolveModel', () => {
  it('OpenRouter Claude 区域受限、没配网关 → Grok', async () => {
    mockLists();
    axios.post.mockImplementation(async (url, body) => { if (body.model.startsWith('anthropic/')) throw region403; return { data: {} }; });
    const r = await resolveModel();
    expect(r.id).toBe('x-ai/grok-4.7');
    expect(r.tried.map(t => t.id)).toEqual(['anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.1']);
  });

  it('配了网关 → 网关 Opus 优先于 Grok；网关 Fable 503 不影响', async () => {
    process.env.CLAUDE_GATEWAY_URL = 'https://gw.example';
    process.env.CLAUDE_GATEWAY_KEY = 'g';
    mockLists();
    axios.post.mockImplementation(async (url, body) => {
      if (body.model.startsWith('anthropic/')) throw region403;
      if (body.model === 'claude-fable-5-1') throw gw503;
      return { data: {} };
    });
    const r = await resolveModel();
    expect(r).toMatchObject({ id: 'gateway:claude-opus-5-5', provider: 'gateway' });
  });

  it('prefer=grok（预算紧）→ 直接 Grok；resolveOpenRouterModel 不选网关', async () => {
    process.env.CLAUDE_GATEWAY_URL = 'https://gw.example';
    process.env.CLAUDE_GATEWAY_KEY = 'g';
    mockLists();
    axios.post.mockImplementation(async (url, body) => { if (body.model.startsWith('anthropic/')) throw region403; return { data: {} }; });
    expect((await resolveModel({ prefer: 'grok' })).id).toBe('x-ai/grok-4.7');
    expect((await resolveOpenRouterModel()).provider).toBe('openrouter');
  });

  it('OpenRouter Claude 可用（如云端区域）→ 最新 Opus', async () => {
    mockLists();
    axios.post.mockResolvedValue({ data: {} });
    expect((await resolveModel()).id).toBe('anthropic/claude-opus-5.5');
  });

  it('网络错误不当成"不可用"，直接抛出；全部不可用时报错列原因', async () => {
    mockLists();
    axios.post.mockRejectedValue(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }));
    await expect(resolveModel()).rejects.toThrow('ECONNRESET');
    _resetModelCache();
    axios.post.mockRejectedValue(region403);
    await expect(resolveModel()).rejects.toThrow(/no model available.*claude-opus-5.5.*grok-4.7/);
  });

  it('DeepSeek / GLM：不进候选；RESEARCH_MODEL 指定也拒绝', async () => {
    expect(BANNED.test('deepseek/deepseek-v3.2')).toBe(true);
    expect(BANNED.test('z-ai/glm-5.3-prime')).toBe(true);
    expect(BANNED.test('x-ai/grok-4.7')).toBe(false);
    process.env.RESEARCH_MODEL = 'deepseek/deepseek-v3.2';
    mockLists();
    await expect(resolveModel()).rejects.toThrow(/not allowed/);
  });
});
