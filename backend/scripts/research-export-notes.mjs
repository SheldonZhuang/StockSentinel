// 把评估笔记导出成 Markdown，方便人工打有用性分（129号阶段4）：
//   node scripts/research-export-notes.mjs [--out=../docs/research-agent-review]
// 每份笔记一个文件，文件名 = 公司-财季-模型；另生成 INDEX.md：打分表（与 research/eval/notes-usefulness.csv 同行序）。
// 只读 research.db。导出的是"最新一轮"各模型的笔记（与 docs 对比表同一批）。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getResearchDb, get } from '../research/db.js';
import { GOLD_PATH, USEFULNESS_PATH } from '../research/eval/notes-eval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv.find(a => a.startsWith('--out='))?.slice(6) || path.join(__dirname, '../../docs/research-agent-review');
const resultsDir = path.join(__dirname, '../research/eval/results');

await getResearchDb();
const gold = JSON.parse(fs.readFileSync(GOLD_PATH, 'utf8')).notes;
// 每个模型取最新一轮结果（改进前那轮不导出：用户只给最新的两个模型打分）
const runs = new Map();
for (const f of fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'))) {
  const r = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
  if (/改进前/.test(r.model)) continue;
  const prev = runs.get(r.model);
  if (!prev || (r.date + r.runId) > (prev.date + prev.runId)) runs.set(r.model, r);
}

fs.mkdirSync(out, { recursive: true });
const safe = s => s.replace(/[^A-Za-z0-9.-]+/g, '_');
const index = ['# 研究笔记人工评分', '', '每份笔记读完后，在 `backend/research/eval/notes-usefulness.csv` 对应行的 score 列填 1–5，comment 可选。',
  '评分标准（建议）：5 = 可直接用于研究，信息准确、重点抓得对；4 = 有用，小瑕疵；3 = 一般，要自己再查；2 = 用处不大；1 = 有误导。',
  '要点前标"🔴 待人工核对"的陈述没通过程序自检，请重点看。标"（程序生成）"的是程序从 XBRL 指标表补上的关键数字，不是模型写的。', '',
  '| 公司 | 财季 | 模型 | 自检 | 笔记 |', '|---|---|---|---|---|'];
let n = 0;
for (const [model, r] of runs) {
  r.noteIds.forEach((id, i) => {
    const g = gold[i];
    const row = id ? get('SELECT note_md, status FROM research_notes WHERE id = ?', [id]) : null;
    const file = `${g.ticker}-${g.fiscalLabel}-${safe(model)}.md`;
    // 程序补的陈述在 Markdown 里加标注（renderMarkdown 不区分来源，这里补上，打分时能看出哪些是模型写的）
    let md = row?.note_md || `# ${g.ticker} ${g.fiscalLabel}\n\n（生成失败，无笔记）`;
    const note = id ? JSON.parse(get('SELECT note_json FROM research_notes WHERE id = ?', [id])?.note_json || 'null') : null;
    for (const c of note?.highlights || []) if (c.generated) md = md.replace(`- ${c.text}`, `- ${c.text}（程序生成）`);
    fs.writeFileSync(path.join(out, file), `> 模型：${model}　评估轮：${r.runId}\n\n${md}`);
    index.push(`| ${g.ticker} | ${g.fiscalLabel} | ${model} | ${row?.status || 'failed'} | [打开](${file}) |`);
    n++;
  });
}
fs.writeFileSync(path.join(out, 'INDEX.md'), `${index.join('\n')}\n`);
console.log(`exported ${n} notes to ${out}; score sheet: ${USEFULNESS_PATH}`);
