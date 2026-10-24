// 串行（~1 次/秒）拉取全部候选代码的 Tiingo 日线，已缓存的跳过。代码来源：name-map 候选 + thu/unl 成分表 + 基准 + 改名别名。
import { tiingo } from './lib.mjs';
import { NAME_TO_TICKER } from './name-map.mjs';
import { thuSnapshots, unlIntervals } from './membership.mjs';
export const ALIASES = { FB: 'META', PCLN: 'BKNG', HANS: 'MNST', KFT: 'MDLZ', CTRP: 'TCOM', WFMI: 'WFM', FISV: 'FI', GOOG: 'GOOGL',
  SUNW: 'JAVA', ERTS: 'EA', MYL: 'VTRS', LLTC: 'ADI', KRFT: 'KHC', WLTW: 'WTW', VIAB: 'PARA', SYMC: 'GEN', NLOK: 'GEN', DISCA: 'WBD', BIIB: 'BIIB' };
const set = new Set(['QQQ', 'SPY']);
for (const v of Object.values(NAME_TO_TICKER)) v.split('|').forEach(t => set.add(t));
for (const s of thuSnapshots()) s.tickers.forEach(t => set.add(t));
for (const r of unlIntervals()) set.add(r.sym);
for (const [a, b] of Object.entries(ALIASES)) { set.add(a); set.add(b); }
// 先拉 S2 候选与基准（数量少、最关键），其余按字母序
const FIRST = ['QQQ', 'SPY', 'MSFT', 'CSCO', 'INTC', 'QCOM', 'ORCL', 'AAPL', 'GOOGL', 'GOOG', 'AMZN', 'NVDA', 'META', 'AVGO', 'TSLA', 'AMGN', 'DELL', 'EBAY', 'COMS'];
const list = [...new Set([...FIRST, ...[...set].filter(t => /^[A-Z.]+$/.test(t)).sort()])];
console.log('tickers', list.length);
let nf = [];
for (const t of list) { const r = await tiingo(t); if (r.notFound || !r.rows?.length) nf.push(t); }
console.log('no data:', nf.length, nf.join(' '));
