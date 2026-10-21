// 研究 Agent / AI 日报 / 指引检测共用的模型选择（用户 2026-10-21 定："能用 Claude 就用，不能用就用 Grok 最新版"）。
// 候选顺序：
//   1) OpenRouter 上最新的 Claude Opus / Fable（本机所在区域实测 403，云端区域可能可用）；
//   2) Claude 网关（本机 Claude Code 用的 OpenAI 兼容网关）上最新的 Opus / Fable——只在配置了
//      CLAUDE_GATEWAY_URL + CLAUDE_GATEWAY_KEY 的实例上启用（不隐式读取 ANTHROPIC_* 环境变量：那是 Claude Code
//      自己的凭据，服务进程用不用它要显式决定）；
//   3) OpenRouter 上最新的 Grok。
// DeepSeek / GLM 永久弃用（BANNED），任何路径都不放行。
// "最新"不写死：OpenRouter 按 /models 的 created 取；网关按 /v1/models 的版本号取。每个候选先发 max_tokens=5 的探测，
// 403/404/503/区域受限就换下一个；结果缓存 24 小时。
import axios from 'axios';

const OR_BASE = 'https://openrouter.ai/api/v1';
const CACHE_MS = 24 * 3600 * 1000;

export const BANNED = /^(?:openrouter:|gateway:)?(deepseek|z-ai|thudm|zhipu)\//i;

// 网关不返回价格：按 Anthropic 官方价估算记账（与 OpenRouter 上同型号一致），预算上限照样生效
const GATEWAY_PRICES = { opus: { in: 4, out: 20 }, fable: { in: 10, out: 50 } };

/** 模型 id → 调用信息。网关模型用 "gateway:" 前缀与 OpenRouter id 区分 */
export function providerFor(id) {
  if (id.startsWith('gateway:')) {
    return { provider: 'gateway', url: `${String(process.env.CLAUDE_GATEWAY_URL || '').replace(/\/$/, '')}/v1/chat/completions`, key: process.env.CLAUDE_GATEWAY_KEY, model: id.slice(8) };
  }
  return { provider: 'openrouter', url: `${OR_BASE}/chat/completions`, key: process.env.OPENROUTER_API_KEY, model: id };
}

const FAMILIES = [
  { family: 'claude-opus', re: /^anthropic\/claude-opus-[\d.]+$/ },
  { family: 'claude-fable', re: /^anthropic\/claude-fable-[\d.]+$/ },
];
const GROK = /^x-ai\/grok-[\d.]+$/;

const latestOf = (models, re) => models
  .filter(x => re.test(x.id) && (x.supported_parameters || []).includes('tools'))
  .sort((a, b) => (b.created || 0) - (a.created || 0))[0];
const orPrice = m => ({ in: Number(m.pricing?.prompt) * 1e6, out: Number(m.pricing?.completion) * 1e6 });

/** 网关模型 id 的版本号："claude-opus-5-5" → [5,5]；带日期后缀的旧型号排后 */
function gatewayVersion(id) {
  const m = /^claude-(opus|fable)-(\d+)(?:-(\d+))?$/.exec(id);
  return m ? [Number(m[2]), Number(m[3] || 0)] : null;
}

/**
 * 候选列表（纯函数，便于测试）。
 * @param orModels OpenRouter /models 的 data
 * @param gwIds 网关 /v1/models 的 id 列表（未配置网关时为 null）
 */
export function buildCandidates(orModels, gwIds) {
  const out = [];
  for (const f of FAMILIES) {
    const m = latestOf(orModels, f.re);
    if (m) out.push({ id: m.id, family: f.family, provider: 'openrouter', price: orPrice(m) });
  }
  if (gwIds) {
    for (const fam of ['opus', 'fable']) {
      const best = gwIds.filter(id => id.startsWith(`claude-${fam}-`) && gatewayVersion(id))
        .sort((a, b) => { const [x1, x2] = gatewayVersion(a); const [y1, y2] = gatewayVersion(b); return y1 - x1 || y2 - x2; })[0];
      if (best) out.push({ id: `gateway:${best}`, family: `claude-${fam}`, provider: 'gateway', price: GATEWAY_PRICES[fam] });
    }
  }
  const g = latestOf(orModels, GROK);
  if (g) out.push({ id: g.id, family: 'grok', provider: 'openrouter', price: orPrice(g) });
  return out.filter(c => !BANNED.test(c.id));
}

/** 探测：返回 { ok } 或 { ok:false, reason }；网络错误、超时抛出（不当成"不可用"） */
export async function probe(id) {
  const p = providerFor(id);
  try {
    await axios.post(p.url, { model: p.model, max_tokens: 5, messages: [{ role: 'user', content: 'ok' }] },
      { headers: { Authorization: `Bearer ${p.key}` }, timeout: 30000 });
    return { ok: true };
  } catch (err) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.error?.message || err.message;
    if ([401, 403, 404, 503].includes(status) || /region|not available|no available channel|没有可用/i.test(msg)) return { ok: false, reason: `${status} ${String(msg).slice(0, 80)}` };
    throw err;
  }
}

let cache = null;

/**
 * 选当前用哪个模型：{ id, family, provider, price, tried }。
 * prefer：'claude'（默认，按顺序）或 'grok'（预算紧时只要 Grok，见 llm.js 的超额降级）。
 */
export async function resolveModel({ force = false, prefer = 'claude' } = {}) {
  const key = `${prefer}`;
  if (!force && cache?.[key] && Date.now() - cache[key].at < CACHE_MS) return cache[key].value;
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
  const orModels = (await axios.get(`${OR_BASE}/models`, { timeout: 30000 })).data?.data || [];
  let gwIds = null;
  if (process.env.CLAUDE_GATEWAY_URL && process.env.CLAUDE_GATEWAY_KEY) {
    try {
      const r = await axios.get(`${String(process.env.CLAUDE_GATEWAY_URL).replace(/\/$/, '')}/v1/models`,
        { headers: { Authorization: `Bearer ${process.env.CLAUDE_GATEWAY_KEY}` }, timeout: 30000 });
      gwIds = (r.data?.data || []).map(m => m.id);
    } catch (err) {
      console.warn('[research-model] gateway model list failed:', err.message);
    }
  }
  let candidates = buildCandidates(orModels, gwIds);
  const pinned = process.env.RESEARCH_MODEL;
  if (pinned) {
    if (BANNED.test(pinned)) throw new Error(`RESEARCH_MODEL ${pinned} is not allowed (DeepSeek / GLM permanently dropped 2026-10-21)`);
    candidates = candidates.filter(c => c.id === pinned);
  }
  if (prefer === 'grok') candidates = candidates.filter(c => c.family === 'grok');
  const tried = [];
  for (const c of candidates) {
    const p = await probe(c.id);
    if (p.ok) {
      const value = { ...c, tried };
      cache = { ...(cache || {}), [key]: { at: Date.now(), value } };
      console.log(`[research-model] using ${c.id} via ${c.provider} ($${c.price.in}/$${c.price.out} per M)${tried.length ? `; skipped ${tried.map(t => t.id).join(', ')}` : ''}`);
      return value;
    }
    tried.push({ id: c.id, reason: p.reason });
  }
  throw new Error(`no model available: ${tried.map(t => `${t.id} (${t.reason})`).join('; ') || 'no candidates'}`);
}

/** 只在 OpenRouter 上选（需要 OpenRouter 专有功能时用，如 web 检索插件）：Claude 优先、不行就 Grok */
export async function resolveOpenRouterModel() {
  const r = await resolveModel();
  if (r.provider === 'openrouter') return r;
  const rest = await resolveModel({ prefer: 'grok' });
  return rest;
}

export function _resetModelCache() {
  cache = null;
}
