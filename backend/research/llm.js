// 研究 Agent 的 LLM 调用层（129号）：OpenRouter + 调用账本 + 预算硬上限。
// 股哨兵原有 LLM 调用（日报/指引）从不读 usage，成本不可见；研究 Agent 的每次调用都入 llm_runs 账本。
//
// 预算池（用户 2026-10-21 拍板，单位 USD）：
//   research：日常（Wiki 增量、笔记生成）每日 0.5 / 每月 5
//   ask：     ask_company 子池每月 3（同时计入 research 月度总额——ask 是日常 5 美元的一部分）
//   backfill：首次回填一次性 3（与日常分开，回填超支不挤占日常）
//   eval：    评估每轮 12（evalRunId 区分轮次），只在本机跑
// 判定在调用前做：已花 + 本次最坏情况（按 max_tokens 估算）> 上限 → 拒绝调用并告警（每池每天最多一封）。
import axios from 'axios';
import { all, get, run, flush } from './db.js';
import { sendAdminNotice } from '../utils/mailer.js';

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

// 默认模型不再写死：research/models.js 按用户定的优先级（OpenRouter 最新 Claude Opus/Fable → 最新 Grok）选，
// 区域受限自动换下一个。显式传 o.model 时（评估、对比）仍用指定模型
import { resolveModel, BANNED, providerFor } from './models.js';

// 每百万 token 美元价（OpenRouter 2026-10-21 实价）。返回的 usage.cost 优先；缺失时按此表估算。
// 表里没有的模型拒绝调用：不知道价格就无法守预算
// 用户 2026-10-21：只用 Claude Opus / Fable 与 Grok；DeepSeek、GLM 永久弃用（价格表里也不留）。
// 最新型号的价格由 research/models.js 从 OpenRouter /models 实时补进来，这里只是兜底
export const PRICES = {
  'anthropic/claude-opus-5.5': { in: 4, out: 20 },
  'anthropic/claude-fable-5.1': { in: 10, out: 50 },
  // OpenRouter 本机区域实测可用（2026-10-21；Anthropic 系列 403 区域受限）
  'x-ai/grok-4.7': { in: 2, out: 6 },
};

export const BUDGETS = {
  research: { daily: 0.5, monthly: 5 },
  ask: { monthly: 3 },
  backfill: { total: 3 },
  eval: { perRun: 12 },
};

export class BudgetExceededError extends Error {
  constructor(pool, detail) {
    super(`LLM budget exceeded (${pool}): ${detail}`);
    this.name = 'BudgetExceededError';
    this.pool = pool;
  }
}

export function estimateCost(model, tokensIn, tokensOut) {
  const p = PRICES[model];
  if (!p) return null;
  return (tokensIn * p.in + tokensOut * p.out) / 1e6;
}

const utcNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function spent(sql, params) {
  return get(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_runs WHERE ${sql}`, params).s;
}

/** 各池当前已花费（UTC 日/月口径） */
export function budgetStatus(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  return {
    researchToday: spent("pool IN ('research','ask') AND substr(created_at,1,10) = ?", [day]),
    researchMonth: spent("pool IN ('research','ask') AND substr(created_at,1,7) = ?", [month]),
    askMonth: spent("pool = 'ask' AND substr(created_at,1,7) = ?", [month]),
    backfillTotal: spent("pool = 'backfill'", []),
    budgets: BUDGETS,
  };
}

/** 预算判定（纯逻辑，导出便于测试）：返回 null 表示放行，否则返回拒绝原因 */
export function checkBudget(pool, worstCase, { evalRunId, now = new Date() } = {}) {
  const s = budgetStatus(now);
  const over = (used, cap, label) => (used + worstCase > cap ? `${label} 已用 $${used.toFixed(4)} + 本次最多 $${worstCase.toFixed(4)} > 上限 $${cap}` : null);
  if (pool === 'research' || pool === 'ask') {
    const r = over(s.researchToday, BUDGETS.research.daily, '日常日额度')
      || over(s.researchMonth, BUDGETS.research.monthly, '日常月额度');
    if (r) return r;
    if (pool === 'ask') return over(s.askMonth, BUDGETS.ask.monthly, 'ask_company 月额度');
    return null;
  }
  if (pool === 'backfill') return over(s.backfillTotal, BUDGETS.backfill.total, '回填总额度');
  if (pool === 'eval') {
    if (!evalRunId) return 'eval 调用必须带 evalRunId';
    return over(spent("pool = 'eval' AND ref LIKE ?", [`${evalRunId}%`]), BUDGETS.eval.perRun, `评估轮 ${evalRunId}`);
  }
  return `未知预算池 ${pool}`;
}

const alertedToday = new Set();
async function alertBudget(pool, reason) {
  const key = `${pool}|${new Date().toISOString().slice(0, 10)}`;
  if (alertedToday.has(key)) return;
  alertedToday.add(key);
  console.warn(`[research-llm] budget stop (${pool}): ${reason}`);
  await sendAdminNotice(process.env.ADMIN_EMAIL, {
    subject: `LLM 预算超限，${pool} 池已停止调用`,
    lines: [reason, '研究 Agent 的该类调用会被拒绝，直到下个计费周期（日/月）或调整上限（research/llm.js BUDGETS）。'],
  }).catch(() => {});
}

/**
 * 调一次 chat completion。
 * @param {{pool, purpose, ticker?, ref?, model?, messages, maxTokens, temperature?, evalRunId?, json?, tools?, toolChoice?}} o
 *   tools：OpenAI 格式的函数工具（研究 Agent 用）；有 tools 时不设 response_format
 * @returns {{text, message, toolCalls, tokensIn, tokensOut, costUsd, latencyMs, model}}
 * @throws BudgetExceededError（未发请求）；其他错误在记账后抛出
 */
export async function chat(o) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  let model = o.model;
  if (!model) {
    // 方案 B（用户 2026-10-21）：Claude 优先；本月日常预算用掉 80% 后，剩余调用自动改用 Grok（便宜 3–5 倍），
    // 到 100% 才停。只对日常池生效，评估池按显式指定的模型跑
    const bs = budgetStatus();
    const tight = (o.pool === 'research' || o.pool === 'ask') && bs.researchMonth >= BUDGETS.research.monthly * 0.8;
    const r = await resolveModel({ prefer: tight || o.preferGrok ? 'grok' : 'claude' });
    model = r.id;
    // /models 接口给的实价补进价格表（最新模型可能还没写进静态表）
    if (!PRICES[model] && r.price?.in >= 0) PRICES[model] = r.price;
  }
  // 用户 2026-10-21：DeepSeek / GLM 永久弃用，任何调用路径（含评估）都不放行
  if (BANNED.test(model)) throw new Error(`model ${model} is not allowed (DeepSeek / GLM permanently dropped 2026-10-21)`);
  if (!PRICES[model]) throw new Error(`model ${model} has no price entry; refusing to call without a budget estimate`);
  if (!o.maxTokens) throw new Error('maxTokens is required'); // 不设时 OpenRouter 按模型上限预扣，免费额度账户直接 402

  // 最坏情况：输入按字符/3 估 token（英文约 4 字符/token，偏保守），输出按 maxTokens
  const inChars = o.messages.reduce((n, m) => n + String(m.content ?? '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0)
    + (o.tools ? JSON.stringify(o.tools).length : 0);
  const worst = estimateCost(model, Math.ceil(inChars / 3), o.maxTokens);
  const reason = checkBudget(o.pool, worst, { evalRunId: o.evalRunId });
  if (reason) {
    await alertBudget(o.pool, reason);
    throw new BudgetExceededError(o.pool, reason);
  }

  const t0 = Date.now();
  const ref = o.pool === 'eval' ? `${o.evalRunId}:${o.ref || ''}` : (o.ref || null);
  try {
    const prov = providerFor(model); // OpenRouter，或 Claude 网关（gateway: 前缀，OpenAI 兼容接口）
    const res = await axios.post(prov.url, {
      model: prov.model,
      messages: o.messages,
      temperature: o.temperature ?? 0,
      max_tokens: o.maxTokens,
      ...(prov.provider === 'openrouter' ? { usage: { include: true } } : {}),
      ...(o.tools ? { tools: o.tools, tool_choice: o.toolChoice || 'auto' } : o.json ? { response_format: { type: 'json_object' } } : {}),
    }, { headers: { Authorization: `Bearer ${prov.key}` }, timeout: o.timeoutMs || 120000 });
    const u = res.data?.usage || {};
    const tokensIn = u.prompt_tokens ?? 0;
    const tokensOut = u.completion_tokens ?? 0;
    const costUsd = typeof u.cost === 'number' ? u.cost : estimateCost(model, tokensIn, tokensOut);
    const latencyMs = Date.now() - t0;
    record({ ...o, model, ref, tokensIn, tokensOut, costUsd, latencyMs, ok: 1 });
    const message = res.data?.choices?.[0]?.message || {};
    return { text: message.content ?? '', message, toolCalls: message.tool_calls || [], tokensIn, tokensOut, costUsd, latencyMs, model };
  } catch (err) {
    // 失败也记一行（成本 0：OpenRouter 对失败请求不计费；若已产生 usage 则无从得知，按 0 记并在 error 里留痕）
    record({ ...o, model, ref, tokensIn: null, tokensOut: null, costUsd: 0, latencyMs: Date.now() - t0, ok: 0, error: String(err.message || err).slice(0, 300) });
    throw err;
  }
}

function record(r) {
  run(`INSERT INTO llm_runs (pool, purpose, ticker, ref, model, tokens_in, tokens_out, cost_usd, latency_ms, ok, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  [r.pool, r.purpose, r.ticker || null, r.ref, r.model, r.tokensIn, r.tokensOut, r.costUsd || 0, r.latencyMs, r.ok, r.error || null, utcNow()]);
  flush(); // 账本每次落盘：进程崩溃不能让已花的钱从账上消失
}

/** 解析 LLM 的 JSON 输出（去代码围栏，截首尾大括号） */
export function parseJsonLoose(text) {
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('no JSON object in LLM output');
  return JSON.parse(cleaned.slice(s, e + 1));
}

/** 账本汇总（管理后台/文档用） */
export function ledgerSummary() {
  return all(`SELECT pool, purpose, model, COUNT(*) AS calls, SUM(ok) AS ok, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
                     ROUND(SUM(cost_usd), 4) AS cost_usd, CAST(AVG(latency_ms) AS INTEGER) AS avg_latency_ms
              FROM llm_runs GROUP BY pool, purpose, model ORDER BY pool, purpose`);
}
