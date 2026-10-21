// 公司 Wiki 增量更新（129号阶段2）：node scripts/research-wiki.mjs [TICKER ...] [--pool=backfill|research]
// 各公司并行（同一公司内按申报日升序，保证"新旧"冲突判断正确）；单进程运行——research.db 是进程内内存库，
// 多进程同时写会互相覆盖。已处理的申报不再调用 LLM，可以随时中断后重跑续上。
import 'dotenv/config';
import cfg from '../config/research.config.js';
import { updateWiki } from '../research/wiki.js';
import { ledgerSummary } from '../research/llm.js';

const args = process.argv.slice(2);
const pool = args.find(a => a.startsWith('--pool='))?.slice(7) || 'research';
const tickers = args.filter(a => !a.startsWith('--')).map(t => t.toUpperCase());
const list = tickers.length ? tickers : Object.keys(cfg.RESEARCH_COMPANIES);

const t0 = Date.now();
const results = await Promise.all(list.map(t => updateWiki({ tickers: [t], pool }).then(s => [t, s])));
for (const [t, s] of results) console.log(t, JSON.stringify(s));
console.table(ledgerSummary().filter(r => r.purpose === 'wiki_extract'));
console.log(`elapsed ${((Date.now() - t0) / 60000).toFixed(1)} min`);
