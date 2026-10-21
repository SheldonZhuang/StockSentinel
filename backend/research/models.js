// 研究 Agent 的模型选择（129号阶段5，用户 2026-10-21 定）：
//   优先：OpenRouter 上 Claude Opus 或 Fable 的最新模型；
//   备选：OpenRouter 上 Grok 的最新模型；
//   放弃 DeepSeek、GLM 这类模型。（本机 Claude Code 子代理是第二备选，但只能在本机跑，服务端调不到，见 docs）
// "最新"不写死：按 OpenRouter /models 的 created 时间取每个家族最新的、支持工具调用的模型，价格也从同一接口取，
// 新版本发布后自动跟上（用户 CLAUDE.md：模型分工跟最新型号走）。
// 区域限制：OpenRouter 对部分地区拒绝 Anthropic 模型（本机实测 403 "not available in your region"），
// 所以每个候选先发一条 max_tokens=5 的探测请求，403/区域受限就换下一个；结果缓存 24 小时。
import axios from 'axios';

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CACHE_MS = 24 * 3600 * 1000;

// 候选家族，按用户给的优先级。排除 :batch（不能走 chat 接口）、多智能体版与代码专用版
export const FAMILIES = [
  { family: 'claude-opus', re: /^anthropic\/claude-opus-[\d.]+$/ },
  { family: 'claude-fable', re: /^anthropic\/claude-fable-[\d.]+$/ },
  { family: 'grok', re: /^x-ai\/grok-[\d.]+$/ },
];
// 明确不用的（用户 2026-10-21）：即使通过 RESEARCH_MODEL 指定也拒绝
export const BANNED = /^(deepseek|z-ai|thudm|zhipu)\//i;

/** 从 /models 列表里选每个家族最新的可用候选（纯函数） */
export function pickLatest(models) {
  const out = [];
  for (const f of FAMILIES) {
    const m = models
      .filter(x => f.re.test(x.id) && (x.supported_parameters || []).includes('tools'))
      .sort((a, b) => (b.created || 0) - (a.created || 0))[0];
    if (m) out.push({ family: f.family, id: m.id, price: { in: Number(m.pricing?.prompt) * 1e6, out: Number(m.pricing?.completion) * 1e6 } });
  }
  return out;
}

/** 探测：能正常返回即可用；403 / 区域受限 / 404 视为不可用；其他错误（网络、5xx）抛出，由调用方决定 */
export async function probe(id, apiKey) {
  try {
    await axios.post(CHAT_URL, { model: id, max_tokens: 5, messages: [{ role: 'user', content: 'ok' }] },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 30000 });
    return { ok: true };
  } catch (err) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.error?.message || err.message;
    if (status === 403 || status === 404 || /region/i.test(msg)) return { ok: false, reason: `${status} ${msg}` };
    throw err;
  }
}

let cache = null;

/**
 * 选定当前用的模型。返回 { id, family, price, tried: [{id, reason}] }。
 * RESEARCH_MODEL 可显式指定（仍受 BANNED 约束，价格从 /models 取）。
 */
export async function resolveModel({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  const list = (await axios.get(MODELS_URL, { timeout: 30000 })).data?.data || [];
  const pinned = process.env.RESEARCH_MODEL;
  const candidates = pinned
    ? list.filter(m => m.id === pinned).map(m => ({ family: 'pinned', id: m.id, price: { in: Number(m.pricing?.prompt) * 1e6, out: Number(m.pricing?.completion) * 1e6 } }))
    : pickLatest(list);
  if (pinned && BANNED.test(pinned)) throw new Error(`RESEARCH_MODEL ${pinned} is not allowed (DeepSeek / GLM dropped 2026-10-21)`);
  const tried = [];
  for (const c of candidates) {
    const p = await probe(c.id, apiKey);
    if (p.ok) {
      const value = { ...c, tried };
      cache = { at: Date.now(), value };
      console.log(`[research-model] using ${c.id} ($${c.price.in}/$${c.price.out} per M)${tried.length ? `; skipped ${tried.map(t => t.id).join(', ')}` : ''}`);
      return value;
    }
    tried.push({ id: c.id, reason: p.reason });
  }
  throw new Error(`no research model available: ${tried.map(t => `${t.id} (${t.reason})`).join('; ') || 'no candidates'}`);
}

export function _resetModelCache() {
  cache = null;
}
