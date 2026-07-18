// 线上实盘信号成绩单：拉取生产 /v1/signal/history 的真实历史档位，对照 SPY 随后真实走势打分。
// 与历史回测互补——回测验证规则设计，本脚本验证线上系统的实盘表现（含数据源故障、stale降级等
// 回测模拟不了的真实运行状况）。用法：node backend/backtest/live-scorecard.mjs [--base <url>]
// 需要 backend/.env 的 TIINGO_API_KEY（拉 SPY 日线）。
import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 显式加载 backend/.env（脚本可能从 repo 根运行）
try {
  const envPath = path.join(__dirname, '..', '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* 已有环境变量则忽略 */ }

const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'https://stocksentinel-production-55ed.up.railway.app';

const TIER_ORDER = { attack: 0, neutral: 1, reduce: 2, defense: 3 };

/** 前向收益：从 dateIdx 起 n 个交易日的 SPY 涨跌幅（%），越界返回 null */
export function forwardReturnPct(closes, dateIdx, n) {
  if (dateIdx < 0 || dateIdx + n >= closes.length) return null;
  return (closes[dateIdx + n].close / closes[dateIdx].close - 1) * 100;
}

/** 按档位聚合前向收益（均值/命中率），horizon=交易日数 */
export function scoreByTier(rows, closes, horizon) {
  const idxByDate = new Map(closes.map((c, i) => [c.date, i]));
  const byTier = {};
  for (const r of rows) {
    // 信号日不一定是交易日：取信号日当天或之后第一个交易日为基准
    let idx = idxByDate.get(r.date);
    if (idx === undefined) {
      idx = closes.findIndex(c => c.date > r.date);
      if (idx === -1) continue;
    }
    const fwd = forwardReturnPct(closes, idx, horizon);
    if (fwd === null) continue;
    (byTier[r.finalSignal] ??= []).push(fwd);
  }
  const out = {};
  for (const [tier, arr] of Object.entries(byTier)) {
    out[tier] = {
      n: arr.length,
      avgPct: arr.reduce((a, b) => a + b, 0) / arr.length,
      downShare: arr.filter(v => v < 0).length / arr.length, // 防守档此值越高=判断越准
    };
  }
  return out;
}

/** 档位变化事件清单（何时升降档），用于人工复盘 */
export function tierTransitions(rows) {
  const asc = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const events = [];
  for (let i = 1; i < asc.length; i++) {
    if (asc[i].finalSignal !== asc[i - 1].finalSignal) {
      const dir = TIER_ORDER[asc[i].finalSignal] > TIER_ORDER[asc[i - 1].finalSignal] ? '升档(更防守)' : '降档(更宽松)';
      events.push({ date: asc[i].date, from: asc[i - 1].finalSignal, to: asc[i].finalSignal, dir });
    }
  }
  return events;
}

async function main() {
  const histRes = await axios.get(`${BASE}/v1/signal/history?limit=365`, { timeout: 30000 });
  const rows = histRes.data.history || [];
  if (!rows.length) throw new Error('生产历史为空');
  const firstDate = rows[rows.length - 1].date;
  const lastDate = rows[0].date;

  const token = process.env.TIINGO_API_KEY;
  if (!token) throw new Error('TIINGO_API_KEY not set');
  const spyRes = await axios.get(
    `https://api.tiingo.com/tiingo/daily/SPY/prices?startDate=${firstDate}&endDate=2099-01-01&token=${token}`,
    { timeout: 30000 }
  );
  const closes = spyRes.data.map(b => ({ date: b.date.slice(0, 10), close: b.adjClose })).sort((a, b) => (a.date < b.date ? -1 : 1));

  console.log(`\n=== 股哨兵线上实盘信号成绩单 ===`);
  console.log(`样本：${firstDate} ~ ${lastDate}（${rows.length} 个信号日）｜数据源：生产API + Tiingo SPY总回报\n`);

  const tierCount = {};
  for (const r of rows) tierCount[r.finalSignal] = (tierCount[r.finalSignal] || 0) + 1;
  console.log('档位分布：', Object.entries(tierCount).map(([t, n]) => `${t} ${n}天`).join(' / '));

  for (const h of [5, 21, 63]) {
    console.log(`\n—— 前向 ${h} 个交易日 SPY 表现（按信号日档位分组）——`);
    const s = scoreByTier(rows, closes, h);
    for (const tier of ['attack', 'neutral', 'reduce', 'defense']) {
      if (!s[tier]) continue;
      console.log(`  ${tier.padEnd(8)} n=${String(s[tier].n).padStart(3)}  前向均值 ${s[tier].avgPct.toFixed(2)}%  下跌占比 ${(s[tier].downShare * 100).toFixed(0)}%`);
    }
    console.log('  （判断准的形态：defense 组的前向均值应低于 neutral/attack 组，下跌占比应更高）');
  }

  const events = tierTransitions(rows);
  console.log(`\n—— 档位变化事件（${events.length} 次）——`);
  for (const e of events) console.log(`  ${e.date}  ${e.from} → ${e.to}  ${e.dir}`);
  if (!events.length) console.log('  （样本期内档位未变化）');

  console.log('\n注：实盘样本还短，前向63日组尾部样本会随时间补全；建议每月重跑一次归档对比。');
}

// 直接运行时执行；被测试 import 时只导出纯函数
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => { console.error('live-scorecard failed:', err.message); process.exit(1); });
}
