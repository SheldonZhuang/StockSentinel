// 研究 Agent 工具的命令行入口（129号阶段4）：让"外部代理"（本机 Claude Code 子代理，跑 Opus 5.5）
// 用与 OpenRouter 路径完全相同的工具和自检来写笔记，做强模型对比。区别只在"谁当 LLM"。
//
//   node scripts/research-tool.mjs prompt  <TICKER> <FYxxxxQn>                 → 打印系统提示 + 用户提示（含指标表）
//   node scripts/research-tool.mjs call    <TICKER> <FYxxxxQn> <tool> '<json>' → 执行一个工具（search_filings / get_prior_guidance / read_wiki / get_market_context）
//   node scripts/research-tool.mjs submit  <TICKER> <FYxxxxQn> <draft.json> [--eval-run=<id>] [--model=<label>] [--retry]
//        → 自检（与 OpenRouter 路径同一套 verify）；不过的打印失败清单（退出码 2），带 --retry 时直接入库
//
// 被检索过的块记在 <runDir>/<TICKER>-<FY>.seen.json，submit 时用于自检（与进程内 ctx.seen 同语义）。
// 只读 research.db（submit 入库除外）。外部代理的 token/成本不经 OpenRouter，记为 null，延迟按 prompt→submit 计。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getResearchDb, get } from '../research/db.js';
import { quarterFilings, runTool, loadMarketContext, systemPromptText, userPromptText, saveExternalNote } from '../research/agent.js';
import { buildMetricTable } from '../research/metrics.js';
import { verifyDraft } from '../research/verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.join(__dirname, '../data/_external_runs');
fs.mkdirSync(runDir, { recursive: true });

const [cmd, tickerRaw, fiscalLabel, ...rest] = process.argv.slice(2);
const ticker = String(tickerRaw || '').toUpperCase();
const opt = k => rest.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const state = path.join(runDir, `${ticker}-${fiscalLabel}.seen.json`);
const load = () => (fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : { startedAt: Date.now(), seen: {}, tools: 0 });
const save = s => fs.writeFileSync(state, JSON.stringify(s));

await getResearchDb();
// import 子命令不针对单一公司季度
const q = cmd === 'import' ? null : quarterFilings(ticker, fiscalLabel);
const { fy, fq, filings, stage } = q || {};
const table = stage === 'final' ? buildMetricTable(ticker, fy, fq) : null;
const prevLabel = !q ? null : fq === 1 ? `FY${fy - 1}Q4` : `FY${fy}Q${fq - 1}`;

if (cmd === 'prompt') {
  save({ startedAt: Date.now(), seen: {}, tools: 0 });
  console.log(`=== SYSTEM ===\n${systemPromptText()}\n\n=== USER ===\n${userPromptText(ticker, fiscalLabel, stage, table, filings)}`);
} else if (cmd === 'call') {
  const [tool, json] = rest.filter(a => !a.startsWith('--'));
  const s = load();
  const ctx = { ticker, fiscalLabel, prevLabel, seen: new Map(Object.entries(s.seen).map(([k, v]) => [Number(k), v])), marketContext: tool === 'get_market_context' ? await loadMarketContext(ticker) : null };
  const out = await runTool(tool, JSON.parse(json || '{}'), ctx);
  s.seen = Object.fromEntries(ctx.seen);
  s.tools++;
  save(s);
  console.log(out);
} else if (cmd === 'submit') {
  const [file] = rest.filter(a => !a.startsWith('--'));
  const draft = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = load();
  const metricsById = new Map((table?.metrics || []).map(m => [m.id, m]));
  const loadChunk = id => get('SELECT * FROM chunks WHERE id = ? AND ticker = ?', [id, ticker]);
  const asOf = filings.map(f => f.filing_date).sort().at(-1);
  const verifyCtx = { ticker, metricsById, chunksById: new Map(Object.entries(s.seen).map(([k, v]) => [Number(k), v])), loadChunk, asOf };
  const check = verifyDraft(draft, verifyCtx);
  const failures = check.report.filter(x => !x.ok).map(x => `- [${x.section} #${x.index}] "${x.text}": ${x.reasons.join('; ')}`);
  if (!check.summary.ok) failures.push(`- [summary]: ${check.summary.reasons.join('; ')}`);
  if (failures.length && !rest.includes('--retry')) {
    console.log(`SELF-CHECK FAILED (${check.passed} passed, ${check.failed} failed):\n${failures.join('\n')}\n\nFix them and submit again with --retry (only one retry).`);
    process.exit(2);
  }
  // 不在这里写库：多个外部代理并行时，每个 submit 是独立进程、各持一份 research.db 内存副本，
  // 同时落盘会互相覆盖。改为写一个"已交稿"文件，由 import 子命令在单进程里顺序入库
  const out = { ticker, fiscalLabel, draft, model: opt('model') || 'external', evalRunId: opt('eval-run') || null,
    latencyMs: Date.now() - s.startedAt, toolCalls: s.tools, seen: s.seen, retried: rest.includes('--retry') };
  fs.writeFileSync(path.join(runDir, `${ticker}-${fiscalLabel}.submitted.json`), JSON.stringify(out));
  console.log(JSON.stringify({ submitted: true, passed: check.passed, failed: check.failed, latency_ms: out.latencyMs }));
} else if (cmd === 'import') {
  // 单进程顺序入库全部已交稿（node scripts/research-tool.mjs import - -）
  const files = fs.readdirSync(runDir).filter(f => f.endsWith('.submitted.json'));
  for (const f of files) {
    const o = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8'));
    const q = quarterFilings(o.ticker, o.fiscalLabel);
    const t = q.stage === 'final' ? buildMetricTable(o.ticker, q.fy, q.fq) : null;
    const loadChunkFor = id => get('SELECT * FROM chunks WHERE id = ? AND ticker = ?', [id, o.ticker]);
    const verifyCtx = {
      ticker: o.ticker, metricsById: new Map((t?.metrics || []).map(m => [m.id, m])),
      chunksById: new Map(Object.entries(o.seen).map(([k, v]) => [Number(k), v])), loadChunk: loadChunkFor,
      asOf: q.filings.map(x => x.filing_date).sort().at(-1),
    };
    const row = saveExternalNote({
      ticker: o.ticker, fiscalLabel: o.fiscalLabel, table: t, filings: q.filings, stage: q.stage, draft: o.draft,
      check: verifyDraft(o.draft, verifyCtx), model: o.model, evalRunId: o.evalRunId, latencyMs: o.latencyMs, toolCalls: o.toolCalls, verifyCtx,
    });
    console.log(JSON.stringify({ file: f, id: row.id, status: row.status }));
  }
} else {
  console.error('usage: research-tool.mjs prompt|call|submit TICKER FYxxxxQn ...');
  process.exit(1);
}
