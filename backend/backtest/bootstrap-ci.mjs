// 回测置信区间（116号建议2，2026-07-30 用户拍板采纳）：
// 26.4 年只是历史的一条路径，年化 12.3% vs 8.5% 是点估计——用**循环块自助法**
// (circular block bootstrap, 块长12个月保留一年内的自相关) 对"策略收益、买入持有收益、
// 二者年化差"给出区间，防止对单一数字过度自信。
//
// 方法：从 backtest-raw.json 的 timeline 重建逐月配对收益 (r_strat, r_bh)——与
// run-backtest.js simulateNav 同口径（月 i 收益由 i-1 月末档位决定：defense 月按联邦基金
// 利率月化计息，其余月按 SPY 总回报）；重建值须先复现官方口径（容差内）才允许自助，
// 防公式漂移产出错误区间。配对整块重采样保留"档位-收益"的结构。
//
// 运行：node backtest/bootstrap-ci.mjs   （离线，只读 backtest-raw.json，结果写 bootstrap-ci.json）
// 固定随机种子，结果可复现。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'backtest-raw.json'), 'utf8'));
const { timeline, summary } = raw;

// ---- 1. 重建逐月配对收益 ----
const months = timeline.filter(t => t.spx !== null && t.spx !== undefined);
const pairs = []; // { bh, strat }
for (let i = 1; i < months.length; i++) {
  const prev = months[i - 1];
  const bh = months[i].spx / prev.spx - 1;
  const cashMonthly = (prev.metrics?.rate ?? 0) / 100 / 12;
  const strat = prev.final === 'defense' ? cashMonthly : bh;
  pairs.push({ bh, strat });
}
const nMonths = pairs.length;
const years = nMonths / 12;

const cagrOf = rets => (rets.reduce((nav, r) => nav * (1 + r), 1) ** (1 / (rets.length / 12)) - 1) * 100;
const pointStrat = cagrOf(pairs.map(p => p.strat));
const pointBh = cagrOf(pairs.map(p => p.bh));

// ---- 2. 复现守卫：重建口径必须与官方 summary 对上（±0.15pp），否则拒绝出区间 ----
const offStrat = summary.overall.stratCagr;
const offBh = summary.overall.buyHoldCagr;
if (Math.abs(pointStrat - offStrat) > 0.15 || Math.abs(pointBh - offBh) > 0.15) {
  console.error(`[bootstrap] 复现失败：重建 strat=${pointStrat.toFixed(2)}%/bh=${pointBh.toFixed(2)}% vs 官方 ${offStrat.toFixed(2)}%/${offBh.toFixed(2)}%——simulateNav 口径可能已变，先修口径再出区间`);
  process.exit(1);
}
console.log(`[bootstrap] 复现通过：strat ${pointStrat.toFixed(2)}% (官方 ${offStrat.toFixed(2)}%) / bh ${pointBh.toFixed(2)}% (官方 ${offBh.toFixed(2)}%)，${nMonths} 个月`);

// ---- 3. 循环块自助 ----
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260730);
const BLOCK = 12;
const B = 10000;
const nBlocks = Math.ceil(nMonths / BLOCK);

const stratCagrs = [], bhCagrs = [], diffs = [];
for (let b = 0; b < B; b++) {
  const sample = [];
  for (let k = 0; k < nBlocks; k++) {
    const start = Math.floor(rand() * nMonths); // 循环块：越界回绕
    for (let j = 0; j < BLOCK && sample.length < nMonths; j++) {
      sample.push(pairs[(start + j) % nMonths]);
    }
  }
  const s = cagrOf(sample.map(p => p.strat));
  const h = cagrOf(sample.map(p => p.bh));
  stratCagrs.push(s); bhCagrs.push(h); diffs.push(s - h);
}
const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const ci = arr => ({ p5: q(arr, 0.05), p50: q(arr, 0.5), p95: q(arr, 0.95) });

const result = {
  generatedAt: new Date().toISOString(),
  method: `circular block bootstrap, block=${BLOCK}m, B=${B}, seed=20260730, 配对重采样保留档位-收益结构`,
  months: nMonths,
  years: +years.toFixed(2),
  point: { stratCagrPct: +pointStrat.toFixed(2), buyHoldCagrPct: +pointBh.toFixed(2), diffPp: +(pointStrat - pointBh).toFixed(2) },
  ci90: {
    stratCagrPct: Object.fromEntries(Object.entries(ci(stratCagrs)).map(([k, v]) => [k, +v.toFixed(2)])),
    buyHoldCagrPct: Object.fromEntries(Object.entries(ci(bhCagrs)).map(([k, v]) => [k, +v.toFixed(2)])),
    diffPp: Object.fromEntries(Object.entries(ci(diffs)).map(([k, v]) => [k, +v.toFixed(2)])),
  },
  probDiffPositive: +(diffs.filter(d => d > 0).length / diffs.length).toFixed(3),
  note: '块自助保留12个月内自相关但打乱危机顺序；区间回答"这套档位序列的月度优势有多稳"，不回答"未来会不会有新型危机"。诚实提醒：优势集中于2000/2008两段大熊（已在报告披露），自助重采样会稀释单段贡献，diff下界偏保守。',
};
fs.writeFileSync(path.join(__dirname, 'bootstrap-ci.json'), JSON.stringify(result, null, 2) + '\n');
console.log('[bootstrap] 90% CI 年化差(策略−买持):', JSON.stringify(result.ci90.diffPp), 'P(diff>0)=', result.probDiffPositive);
console.log('[bootstrap] 策略年化 CI:', JSON.stringify(result.ci90.stratCagrPct), '买持 CI:', JSON.stringify(result.ci90.buyHoldCagrPct));
console.log('[bootstrap] 已写入 backtest/bootstrap-ci.json');
