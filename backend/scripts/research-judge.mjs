// 研究笔记有用性的 AI 盲评（129号阶段4，用户 2026-10-21 委托代打分）。
// 为什么要盲评 + 双评委：被评的三个模型里有 Opus（也就是代打分的这一方）、grok、deepseek，任何一个来评都是自评。
//   - 盲化：去掉模型名、运行信息（token/成本/耗时）与"（本机）"等字样，随机打乱后编号 N01..N48；
//   - 评委一：GLM-5.3-prime（2026-10-21 那一轮；之后 GLM 永久弃用，评分保留在 judge-glm.json）；
//   - 评委二：本机 Opus 子代理（同样只看盲化文本）；
//   - 结果写 research/eval/notes-usefulness-ai.csv，与用户自己的 notes-usefulness.csv 分开，表里单列"AI 盲评"。
// 有用性只评"对研究者有没有用"（重点、对比、指引核对、风险是否切题、可读性）；数字对不对由程序指标负责，不让评委重复判断。
//
//   node scripts/research-judge.mjs blind            生成盲化笔记 data/_judge/N01.md… 与映射 research/eval/judge-map.json
//   node scripts/research-judge.mjs glm              已停用（GLM 永久弃用）；历史评分在 research/eval/judge-glm.json
//   node scripts/research-judge.mjs aggregate        合并 GLM 与 Opus（research/eval/judge-opus.json）→ notes-usefulness-ai.csv + 一致性
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getResearchDb, get } from '../research/db.js';
import { renderMarkdown } from '../research/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evalDir = path.join(__dirname, '../research/eval');
const blindDir = path.join(__dirname, '../data/_judge');
const MAP = path.join(evalDir, 'judge-map.json');
const GLM_OUT = path.join(evalDir, 'judge-glm.json');
const OPUS_OUT = path.join(evalDir, 'judge-opus.json');
const AI_CSV = path.join(evalDir, 'notes-usefulness-ai.csv');

export const RUBRIC = `你是资深股票研究员，评估一份由程序与大模型自动生成的季度研究笔记"对研究者有多有用"。
只评有用性，不评数字真伪（数字已由程序逐条核对过）。按以下五项各打 1–5 分，再给总分 1–5（总分是你的整体判断，不是平均）：
1. 重点（focus）：抓住了本季最重要的变化吗（增长来源、利润率走向、资本开支、分部结构），还是罗列次要信息？
2. 对比（comparison）：有没有与上季、去年同期、管理层上季指引做有意义的对比，并说清方向？
3. 指引（guidance）：是否准确说明了本季是否达成上季指引、下季指引是什么；公司不给数字指引时是否如实说明而不编造？
4. 风险（risks）：风险点是否与本季业务切题、具体，而不是通用的免责套话？
5. 可读性（readability）：结构清楚、语言简洁、没有重复与无意义的句子？
总分标准：5 = 可直接用于研究；4 = 有用，小瑕疵；3 = 一般，要自己再查不少；2 = 用处不大；1 = 有误导。
只输出 JSON：{"focus":n,"comparison":n,"guidance":n,"risks":n,"readability":n,"overall":n,"reason":"一句话中文理由"}`;

// 盲化：去掉运行行（含模型名、token、成本）与模型名残留
export function blindMarkdown(md) {
  return md
    .replace(/\n---\n运行：[^\n]*\n/, '\n---\n')
    .replace(/claude[-\w.]*|deepseek[-\w./]*|grok[-\w.]*|x-ai\/[-\w.]*|anthropic\/[-\w.]*|（本机）/gi, '')
    .replace(/，v\d+）/, '）');
}

// 确定性洗牌（固定种子，盲化可复现）
function shuffle(arr, seed = 20261021) {
  const a = [...arr];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function latestRuns() {
  const dir = path.join(evalDir, 'results');
  const runs = new Map();
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (/改进前/.test(r.model)) continue;
    const prev = runs.get(r.model);
    if (!prev || (r.date + r.runId) > (prev.date + prev.runId)) runs.set(r.model, r);
  }
  return runs;
}

const cmd = process.argv[2];
await getResearchDb();

if (cmd === 'blind') {
  const gold = JSON.parse(fs.readFileSync(path.join(evalDir, 'notes-gold.json'), 'utf8')).notes;
  const items = [];
  for (const [model, r] of latestRuns()) {
    r.noteIds.forEach((id, i) => {
      if (!id) return;
      const row = get('SELECT note_json FROM research_notes WHERE id = ?', [id]);
      const note = JSON.parse(row.note_json);
      // 不加"（程序生成）"标注：只有走 OpenRouter 路径的笔记（deepseek / grok）才有程序补全，
      // 标出来等于告诉评委"没有标注的是本机 Opus"，盲评就不盲了
      items.push({ noteId: id, model, ticker: gold[i].ticker, fiscalLabel: gold[i].fiscalLabel, md: blindMarkdown(renderMarkdown(note)) });
    });
  }
  const shuffled = shuffle(items);
  fs.rmSync(blindDir, { recursive: true, force: true });
  fs.mkdirSync(blindDir, { recursive: true });
  const map = shuffled.map((it, k) => {
    const code = `N${String(k + 1).padStart(2, '0')}`;
    fs.writeFileSync(path.join(blindDir, `${code}.md`), it.md);
    return { code, noteId: it.noteId, model: it.model, ticker: it.ticker, fiscalLabel: it.fiscalLabel };
  });
  fs.writeFileSync(MAP, JSON.stringify(map, null, 1));
  // 自检：盲化文本里不能残留模型名
  const leak = map.filter(m => /claude|deepseek|grok|opus|x-ai/i.test(fs.readFileSync(path.join(blindDir, `${m.code}.md`), 'utf8')));
  console.log(`blinded ${map.length} notes → ${blindDir}; leaks: ${leak.length ? leak.map(l => l.code).join(',') : 'none'}`);
} else if (cmd === 'glm') {
  // 用户 2026-10-21：GLM 永久弃用。那一轮（2026-10-21）的 GLM 评分已存 judge-glm.json，aggregate 继续读取；不再调用 GLM
  console.error('GLM judge retired (2026-10-21). Existing scores in research/eval/judge-glm.json are kept for aggregate.');
  process.exit(1);
} else if (cmd === 'aggregate') {
  const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  const glm = JSON.parse(fs.readFileSync(GLM_OUT, 'utf8'));
  // Opus 评委分两个子代理各评 24 份（judge-opus-a / -b），这里合并成 judge-opus.json
  const opus = {};
  // -c 是 11 份"读取被截断"笔记的分段重评（N26 等，均为 deepseek / grok 的长笔记），后写覆盖 -b 里按残缺文本打的分
  for (const f of ['judge-opus-a.json', 'judge-opus-b.json', 'judge-opus-c.json']) {
    const p = path.join(evalDir, f);
    if (fs.existsSync(p)) Object.assign(opus, JSON.parse(fs.readFileSync(p, 'utf8')));
  }
  fs.writeFileSync(OPUS_OUT, JSON.stringify(opus, null, 1));
  const rows = ['ticker,fiscal_label,model,score(1-5),comment'];
  const byModel = {};
  let both = 0;
  let within1 = 0;
  let exact = 0;
  for (const m of map) {
    const a = Number(glm[m.code]?.overall);
    const b = Number(opus[m.code]?.overall);
    const scores = [a, b].filter(x => x >= 1 && x <= 5);
    if (!scores.length) continue;
    if (scores.length === 2) { both++; if (Math.abs(a - b) <= 1) within1++; if (a === b) exact++; }
    const avg = scores.reduce((x, y) => x + y, 0) / scores.length;
    (byModel[m.model] ||= { glm: [], opus: [], avg: [] });
    if (a) byModel[m.model].glm.push(a);
    if (b) byModel[m.model].opus.push(b);
    byModel[m.model].avg.push(avg);
    const why = [glm[m.code]?.reason && `GLM:${glm[m.code].reason}`, opus[m.code]?.reason && `Opus:${opus[m.code].reason}`].filter(Boolean).join(' / ').replace(/[,\n]/g, '；');
    rows.push(`${m.ticker},${m.fiscalLabel},${m.model},${Math.round(avg * 10) / 10},${why}`);
  }
  fs.writeFileSync(AI_CSV, `${rows.join('\n')}\n`);
  const mean = a => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null);
  for (const [model, s] of Object.entries(byModel)) console.log(model.padEnd(32), 'GLM', mean(s.glm), 'Opus', mean(s.opus), 'avg', mean(s.avg), `n=${s.avg.length}`);
  console.log(`agreement: exact ${exact}/${both}, within ±1 ${within1}/${both}`);
} else {
  console.error('usage: research-judge.mjs blind|glm|aggregate');
  process.exit(1);
}
