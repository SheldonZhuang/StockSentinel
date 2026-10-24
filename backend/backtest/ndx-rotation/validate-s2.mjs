// 用 QQQ 实际持仓核验 S2 的"第一大权重"排序：
//   (a) 招股书披露的 12/31 指数前五大权重（1999–2024），
//   (b) 年报 9/30 全持仓（1999–2025），
//   (c) N-PORT 季末持仓（2019Q3–2026Q2）。
// 对每个日期：用 s2-rank 的市值法算第一名，与实际第一名对比；同时检查 GOOG/GOOGL/META（未进入计算排序）是否曾排第一。
import fs from "fs";
import path from 'path';
import { readJSON, writeJSON, OUT } from './lib.mjs';
import { rankAt as rankCap } from './s2-rank.mjs';
import { rankIdxAt } from './s2-rank-idx.mjs';
// idx 模式在快照日本身必然与快照一致（同源），所以只对 cap 模式做逐点核验；idx 模式用 '去掉当日快照' 的留一法核验
const MODE = process.argv[2] === 'idx' ? 'idx' : 'cap';
const rankAt = MODE === 'idx' ? async d => (await rankIdxAt(d, true)).rows.map(r => ({ tk: r.tk, cap: r.w })) : rankCap;

const N2T = [[/microsoft/i, 'MSFT'], [/cisco/i, 'CSCO'], [/intel/i, 'INTC'], [/oracle/i, 'ORCL'], [/apple/i, 'AAPL'], [/qualcomm/i, 'QCOM'],
  [/amgen/i, 'AMGN'], [/amazon/i, 'AMZN'], [/nvidia/i, 'NVDA'], [/broadcom/i, 'AVGO'], [/tesla/i, 'TSLA'], [/google|alphabet/i, 'GOOGL'],
  [/facebook|meta platforms/i, 'META'], [/ebay/i, 'EBAY'], [/micron/i, 'MU'], [/nextel/i, 'NXTL'], [/gilead/i, 'GILD'], [/research in motion/i, 'RIMM']];
const t = n => (N2T.find(([re]) => re.test(n)) || [, n])[1];
const checks = [];

// (a) 12/31 前五（文本中年份标注：2002-01 的招股书把 2001 年写成了 2000 年，按文件年份-1 纠正）
const FD = path.join(OUT, '../qqq_filings');
const seen = new Set();
for (const f of fs.readdirSync(FD).filter(f => /485BPOS/.test(f)).sort()) {
  const txt = fs.readFileSync(path.join(FD, f), 'utf8').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
  const l = (txt.match(/five largest companies represented in the Index as of December 31, [0-9]{4},? were as follows:[^%]*%\)[^%]*%\)/i) || [])[0];
  if (!l) continue;
  const y = +f.slice(0, 4) - 1; // 招股书发布年份 - 1 = 披露的年末（2002-01 那份把 2001 误写成 2000）
  if (seen.has(y)) continue; seen.add(y);
  const top = l.match(/follows: ([^(]+)\(([0-9.]+)%\)/);
  const second = l.match(/%\),?\s*([^(]+)\(([0-9.]+)%\)/);
  checks.push({ src: 'prospectus Dec-31 top5', date: `${y}-12-31`, actual: t(top[1]), actualPct: +top[2], actual2: t(second[1]), actual2Pct: +second[2] });
}
// (b) 9/30 全持仓
const H = readJSON(path.join(OUT, 'qqq_holdings_sep30.json'));
for (const [d, { rows }] of Object.entries(H)) { const tot = rows.reduce((a, b) => a + b.value, 0); checks.push({ src: 'QQQ annual report Sep-30', date: d, actual: t(rows[0].name), actualPct: +(100 * rows[0].value / tot).toFixed(2), actual2: t(rows[1].name), actual2Pct: +(100 * rows[1].value / tot).toFixed(2) }); }
// (c) N-PORT
const NP = readJSON(path.join(OUT, 'qqq_nport_top.json'));
for (const [d, items] of Object.entries(NP)) { checks.push({ src: 'QQQ N-PORT', date: d, actual: t(items[0].name), actualPct: items[0].pct, actual2: t(items[1].name), actual2Pct: items[1].pct }); }

checks.sort((a, b) => a.date.localeCompare(b.date));
let agree = 0, n = 0;
for (const c of checks) {
  if (c.date < '1999-12-31' || c.date > new Date().toISOString().slice(0, 10)) continue;
  const r = await rankAt(c.date);
  c.model = r[0]?.tk; c.model2 = r[1]?.tk; c.modelGap = r[1] ? +(100 * (r[0].cap / r[1].cap - 1)).toFixed(1) : null;
  c.match = c.model === c.actual;
  n++; if (c.match) agree++;
}
const multiClassTop = checks.filter(c => ['GOOGL', 'META'].includes(c.actual));
writeJSON(path.join(OUT, `s2_validation_${MODE}.json`), { agree, n, checks, multiClassTop });
for (const c of checks) if (c.model) console.log(c.date, c.src.padEnd(26), 'actual', `${c.actual} ${c.actualPct}% / ${c.actual2} ${c.actual2Pct}%`.padEnd(32), 'model', `${c.model} (+${c.modelGap}% vs ${c.model2})`, c.match ? '' : '  <-- MISMATCH');
console.log(`agreement ${agree}/${n}; multi-class names ever #1 in actual data: ${multiClassTop.length ? multiClassTop.map(c => c.date).join(',') : 'never'}`);
