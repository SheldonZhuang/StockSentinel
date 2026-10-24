// 解析 QQQ 信托年报/招股书里的 Schedule of Investments（每年 9/30 全持仓：名称、股数、市值）
// 输出 out/qqq_holdings_sep30.json：{ "2000-09-30": { src, rows:[{name, shares, value}] }, ... }
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DATA, OUT, readJSON, writeJSON } from './lib.mjs';

const ent = s => s.replace(/&nbsp;|&#160;|&#8195;|&#8194;|&#xa0;/gi, ' ').replace(/&amp;|&#38;/g, '&')
  .replace(/&#8217;|&#146;|&rsquo;/g, "'").replace(/&#8212;|&#151;/g, '-').replace(/&#[0-9]+;/g, ' ');

function toLines(raw) {
  let t = raw;
  if (/<td/i.test(t)) {
    // HTML：按 </tr> 切行、</td> 切单元格；表外段落按 </p> 切行（表内的 </p> 不切）
    t = t.replace(/\r?\n/g, ' ').split(/<\/tr>/i).map(chunk => {
      const k = chunk.search(/<tr[\s>]/i);
      const pre = k < 0 ? chunk : chunk.slice(0, k), row = k < 0 ? '' : chunk.slice(k);
      return pre.replace(/<\/p>|<\/div>|<br\s*\/?>/gi, '\n') + '\n' + row.replace(/<\/t[dh]>/gi, '\t');
    }).join('\n');
  }
  t = ent(t.replace(/<[^>\n]+>/g, ' '));
  // 保留 \t（HTML 单元格分隔）与双空格（纯文本列分隔），只压缩更长的空白
  return t.split('\n').map(l => l.replace(/ /g, ' ').replace(/ {3,}/g, '  ').trim());
}

const NUM = /^\$?\(?[0-9][0-9,]*\)?$/;
const DATE_RE = /((?:September|March) 3[01], (?:19|20)\d\d)/i;
const END_RE = /^Total (Investments|Common Stocks)|^Statements? of (Assets|Operations|Changes)|^Financial Highlights|^Notes to (the )?Financial/i;

export function parseSchedules(raw) {
  const lines = toLines(raw), out = {};
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/Schedule of Investments/i.test(l)) {
      const m = l.match(DATE_RE) || lines.slice(Math.max(0, i - 4), i + 8).join(' ').match(DATE_RE);
      if (m) { cur = new Date(m[1] + ' UTC').toISOString().slice(0, 10); out[cur] ??= new Map(); continue; }
    }
    if (!cur) continue;
    if (END_RE.test(l)) { cur = null; continue; }
    const cells = l.split('\t').map(c => c.trim()).filter(c => c && c !== '$');
    let name, sh, val;
    if (cells.length >= 3) {
      const nums = cells.filter(c => NUM.test(c.replace(/\s/g, '')));
      const txt = cells.filter(c => !NUM.test(c.replace(/\s/g, '')) && /[A-Za-z]/.test(c));
      if (nums.length >= 2 && txt.length >= 1) { name = txt[0]; sh = nums[0]; val = nums[1]; }
    } else {
      // 纯文本行："Name.......  14,998,245   $   828,653,036"
      const mm = l.match(/^(.+?)[ .]{2,}([0-9][0-9,]{2,}) +\$? *([0-9][0-9,]{4,})$/);
      if (mm) { name = mm[1]; sh = mm[2]; val = mm[3]; }
    }
    if (!name) continue;
    // 纯文本表里长公司名会折行："Brocade Communications Systems,\n  Inc.....  5,306,905  74,455,877"
    if (/^(Inc|Ltd|Corporation|Corp|Incorporated|Company|Co|plc|N\.?V|S\.?A)\b[ .,*]*$/i.test(name.replace(/\.{2,}.*$/, '').trim()) && i > 0) name = lines[i - 1] + ' ' + name;
    if (/Tracking Stock|Equity Securities|shares (sold|redeemed|repurchased)|subscriptions|redemptions/i.test(name)) continue;
    name = name.replace(/\.{2,}.*$/, '').replace(/\(\w\)/g, '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    if (/^total|^cost|^net assets|^shares|^common stocks|^\(cost/i.test(name)) continue;
    const shares = +sh.replace(/[^0-9]/g, ''), value = +val.replace(/[^0-9]/g, '');
    if (!(shares > 0 && value > 1000)) continue;
    if (!out[cur].has(name)) out[cur].set(name, { name, shares, value });
  }
  const res = {};
  if (process.env.NDX_DEBUG) for (const [d, m] of Object.entries(out)) console.error('dbg', d, m.size);
  for (const [d, m] of Object.entries(out)) if (m.size >= 50) res[d] = [...m.values()].sort((a, b) => b.value - a.value);
  return res;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const idx = readJSON(path.join(DATA, 'qqq_filings/index.json'));
  const all = {};
  for (const it of idx) {
    const s = parseSchedules(fs.readFileSync(path.join(DATA, it.file), 'utf8'));
    for (const [d, rows] of Object.entries(s)) {
      if (!/-09-30$/.test(d)) continue;
      if (!all[d] || rows.length > all[d].rows.length) all[d] = { src: it.file, rows };
    }
  }
  for (const k of Object.keys(all).sort()) {
    const r = all[k].rows, tot = r.reduce((a, b) => a + b.value, 0);
    console.log(k, r.length, all[k].src.slice(12, 40), 'top:', r.slice(0, 3).map(x => `${x.name} ${(100 * x.value / tot).toFixed(1)}%`).join(' | '));
  }
  writeJSON(path.join(OUT, 'qqq_holdings_sep30.json'), all);
}
