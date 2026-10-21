// 生成研究笔记（129号阶段3）：node scripts/research-note.mjs MSFT FY2026Q4 [--model=deepseek/deepseek-v3.2] [--pool=research]
// 结果入 research.db 的 research_notes，并把 Markdown / JSON 打到 stdout（--out=<目录> 时写文件）
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { generateNote } from '../research/agent.js';

const args = process.argv.slice(2);
const opt = k => args.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const [ticker, fiscalLabel] = args.filter(a => !a.startsWith('--'));
if (!ticker || !fiscalLabel) { console.error('usage: research-note.mjs TICKER FY2026Q4'); process.exit(1); }
const row = await generateNote({ ticker: ticker.toUpperCase(), fiscalLabel, model: opt('model'), pool: opt('pool') || 'research' });
console.log(JSON.stringify({ id: row.id, status: row.status, version: row.version, stage: row.stage, model: row.model, tokens_in: row.tokens_in, tokens_out: row.tokens_out, cost_usd: row.cost_usd, latency_ms: row.latency_ms, llm_calls: row.llm_calls, error: row.error }));
if (opt('out') && row.note_md) {
  fs.mkdirSync(opt('out'), { recursive: true });
  const base = path.join(opt('out'), `${row.ticker}-${row.fiscal_label}-v${row.version}`);
  fs.writeFileSync(`${base}.md`, row.note_md);
  fs.writeFileSync(`${base}.json`, JSON.stringify(JSON.parse(row.note_json), null, 2));
  console.log(`written ${base}.md / .json`);
}
