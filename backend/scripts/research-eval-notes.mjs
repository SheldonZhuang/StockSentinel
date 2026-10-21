// 研究笔记离线评估（129号阶段4）：npm run eval:research -- --models=x-ai/grok-4.7  （不给 --models 时用线上同一套自动选择）
//   --models=   逗号分隔，至少一个；每个模型生成 16 份笔记（8 家 × 最近 2 个正式版财季）后打分
//   --regen-gold 重新生成金标（默认冻结，用已入库的 research/eval/notes-gold.json）
//   --concurrency=4  同时生成的笔记数
//   --score-only=<runId> 不调用 LLM，只给已生成的某轮重新打分
// 结果：research/eval/results/<runId>.json，并更新 docs/research-agent.md 的"阶段 4 评估结果"一节（带日期与 git commit）。
// 预算：每个模型一轮走 eval 池，单轮上限 $12（research/llm.js BUDGETS.eval）；只在本机跑。
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import cfg from '../config/research.config.js';
import { getResearchDb, all, get } from '../research/db.js';
import { buildGoldSet } from '../research/eval/gold.js';
import { GOLD_PATH, USEFULNESS_PATH, USEFULNESS_AI_PATH, scoreNote, aggregate, readUsefulness } from '../research/eval/notes-eval.js';
import { generateNote } from '../research/agent.js';
import { PRICES } from '../research/llm.js';
import { resolveModel } from '../research/models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = k => args.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const flag = k => args.includes(`--${k}`);

await getResearchDb();
const commit = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch { return 'unknown'; } })();
const dirty = (() => { try { return !!execSync('git status --porcelain -- research scripts', { cwd: path.join(__dirname, '..') }).toString().trim(); } catch { return false; } })();
const today = new Date().toISOString().slice(0, 10);

// ---- 金标：冻结 ----
let gold;
if (flag('regen-gold') || !fs.existsSync(GOLD_PATH)) {
  gold = buildGoldSet(Object.keys(cfg.RESEARCH_COMPANIES));
  fs.writeFileSync(GOLD_PATH, JSON.stringify({ generated: today, commit, notes: gold }, null, 1));
  console.log(`gold set written: ${gold.length} notes, ${gold.reduce((n, g) => n + g.facts.length, 0)} facts`);
} else {
  gold = JSON.parse(fs.readFileSync(GOLD_PATH, 'utf8')).notes;
}

// ---- 有用性打分表模板（用户填 score 列）----
if (!fs.existsSync(USEFULNESS_PATH)) {
  fs.writeFileSync(USEFULNESS_PATH, 'ticker,fiscal_label,model,score(1-5),comment\n');
}

async function pMap(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const resultsDir = path.join(__dirname, '../research/eval/results');
fs.mkdirSync(resultsDir, { recursive: true });

async function runModel(model) {
  if (!PRICES[model]) throw new Error(`no price for ${model}`);
  const runId = `eval-${today}-${model.replace(/[^a-z0-9.]+/gi, '_')}-${commit}`;
  console.log(`\n== ${model} (${runId}) ==`);
  const rows = await pMap(gold, Number(opt('concurrency') || 4), async g => {
    try {
      const row = await generateNote({ ticker: g.ticker, fiscalLabel: g.fiscalLabel, pool: 'eval', model, evalRunId: runId, log: () => {} });
      console.log(`${g.ticker} ${g.fiscalLabel}: ${row.status} $${(row.cost_usd || 0).toFixed(4)} ${Math.round((row.latency_ms || 0) / 1000)}s`);
      return row;
    } catch (err) {
      console.log(`${g.ticker} ${g.fiscalLabel}: error ${err.message}`);
      return null;
    }
  });
  return finish(model, runId, rows);
}

function finish(model, runId, rows) {
  const scored = gold.map((g, i) => scoreNote(rows[i]?.note_json ? JSON.parse(rows[i].note_json) : null, g));
  const metrics = aggregate(scored, rows.filter(Boolean));
  const useful = readUsefulness().filter(u => u.model === model);
  metrics.usefulness = useful.length ? Math.round((useful.reduce((a, b) => a + b.score, 0) / useful.length) * 100) / 100 : null;
  metrics.usefulnessN = useful.length;
  const ai = readUsefulness(USEFULNESS_AI_PATH).filter(u => u.model === model);
  metrics.usefulnessAi = ai.length ? Math.round((ai.reduce((a, b) => a + b.score, 0) / ai.length) * 100) / 100 : null;
  metrics.usefulnessAiN = ai.length;
  const out = { runId, model, date: today, commit, dirty, metrics, perNote: scored, noteIds: rows.map(r => r?.id ?? null) };
  fs.writeFileSync(path.join(resultsDir, `${runId}.json`), JSON.stringify(out, null, 1));
  // 打分表补行（已有的不覆盖）
  const existing = fs.readFileSync(USEFULNESS_PATH, 'utf8');
  const add = gold.filter(g => !existing.includes(`${g.ticker},${g.fiscalLabel},${model},`)).map(g => `${g.ticker},${g.fiscalLabel},${model},,`);
  if (add.length) fs.appendFileSync(USEFULNESS_PATH, `${add.join('\n')}\n`);
  console.log(JSON.stringify(metrics));
  return out;
}

const runs = [];
if (opt('score-external')) {
  // 外部代理（本机 Claude Code 子代理）写的一轮：笔记已由 research-tool.mjs import 入库，按 eval_run 取出打分。
  // token / 成本不经 OpenRouter 账本，结果里如实为空
  const [runId, model] = opt('score-external').split('@');
  const rows = gold.map(g => get(`SELECT * FROM research_notes WHERE eval_run = ? AND ticker = ? AND fiscal_label = ? ORDER BY version DESC LIMIT 1`,
    [runId, g.ticker, g.fiscalLabel]));
  runs.push(finish(model || runId, runId, rows));
} else if (opt('score-only')) {
  const prev = JSON.parse(fs.readFileSync(path.join(resultsDir, `${opt('score-only')}.json`), 'utf8'));
  const rows = prev.noteIds.map(id => (id ? get('SELECT * FROM research_notes WHERE id = ?', [id]) : null));
  runs.push(finish(prev.model, prev.runId, rows));
} else {
  const models = (opt('models') || (await resolveModel()).id).split(',').filter(Boolean);
  for (const m of models) runs.push(await runModel(m));
}

// ---- 写进文档 ----
const docPath = path.join(__dirname, '../../docs/research-agent.md');
const all3 = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8')));
const latest = new Map();
for (const r of all3.sort((a, b) => (a.date + a.runId).localeCompare(b.date + b.runId))) latest.set(r.model, r);
const pct = x => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const table = [
  '| 模型 | 份数 | 失败率 | 数值准确率 | 事实覆盖率 | 出处覆盖率 | 出处准确率 | "未披露"误报率 | 捏造指引 | 有用性：用户 / AI 盲评(1–5) | P50 / P95 延迟 | 每份成本 | 本轮总成本 | 日期 / commit |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...[...latest.values()].map(r => {
    const m = r.metrics;
    return `| ${r.model} | ${m.notes} | ${pct(m.failureRate)} | ${pct(m.numericAccuracy)} | ${pct(m.factCoverage)} | ${pct(m.sourceCoverage)} | ${pct(m.sourceAccuracy)} | ${pct(m.falseNotDisclosedRate)} | ${m.fabricatedGuidance}/${m.notDisclosedFacts} | ${m.usefulness ?? '未打分'} / ${m.usefulnessAi ?? '—'}${m.usefulnessAiN ? `（${m.usefulnessAiN} 份）` : ''} | ${m.latencyP50s}s / ${m.latencyP95s}s | ${m.costPerNoteUsd == null ? '未经 OpenRouter 记账' : `$${m.costPerNoteUsd}`} | ${m.costTotalUsd == null ? '—' : `$${m.costTotalUsd}`} | ${r.date} / ${r.commit}${r.dirty ? '+未提交改动' : ''} |`;
  }),
].join('\n');
const START = '<!-- eval:notes:start -->';
const END = '<!-- eval:notes:end -->';
let doc = fs.readFileSync(docPath, 'utf8');
const block = `${START}\n${table}\n\n自动生成：\`npm run eval:research\`，逐份明细见 \`backend/research/eval/results/\`。\n${END}`;
doc = doc.includes(START) ? doc.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block) : `${doc.trimEnd()}\n\n${block}\n`;
fs.writeFileSync(docPath, doc);
console.log('\ndocs/research-agent.md updated');
