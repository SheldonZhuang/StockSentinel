// 研究文档采集 CLI（129号阶段1）：回填或增量更新 research.db。
//   node scripts/research-ingest.mjs                 # 8 家全部（已处理的申报跳过，不重复下载）
//   node scripts/research-ingest.mjs MSFT NVDA       # 指定公司
//   node scripts/research-ingest.mjs --as-of=2026-10-21
// research.db 与主库独立，可以在 server.js 运行时执行（但不要与服务内的采集同时跑：两个进程各持一份内存库，
// 后落盘者覆盖前者）。
import 'dotenv/config';
import { runIngest } from '../research/ingest.js';

const args = process.argv.slice(2);
const asOf = args.find(a => a.startsWith('--as-of='))?.slice(8);
const tickers = args.filter(a => !a.startsWith('--'));

const t0 = Date.now();
const summary = await runIngest({ tickers, asOf, trigger: 'backfill' });
console.log(JSON.stringify(summary, null, 2));
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
