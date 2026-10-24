// 一键复现（只读缓存，不联网）：NDX_OFFLINE=1 node backtest/ndx-rotation/run-all.mjs
// 首次运行或缓存不全时，先依次跑 fetch-qqq-filings / parse-qqq-holdings / fetch-nport / fetch-shares / fetch-cover-shares / fetch-prices。
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, NDX_OFFLINE: '1' };
for (const [f, ...args] of [['parse-qqq-holdings.mjs'], ['calendar.mjs'], ['build-universe.mjs'], ['gap-screen.mjs'],
  ['s1-last-year-winner.mjs'], ['s1-last-year-winner.mjs', 'survivor'], ['s1-last-year-winner.mjs', 'today'],
  ['s2-top-weight.mjs'], ['s2-top-weight.mjs', 'idx'], ['validate-s2.mjs'], ['validate-s2.mjs', 'idx']]) {
  console.log(`\n===== ${f} ${args.join(' ')} =====`);
  process.stdout.write(execFileSync(process.execPath, [path.join(HERE, f), ...args], { env, encoding: 'utf8', maxBuffer: 64 << 20 }));
}
