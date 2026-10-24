// 模拟盘信号与下单计划（只读，不下单）：
//   1. 用实验室同一套策略代码在最新收盘上算每个入围策略的目标权重（与回测完全同源，避免"回测一套、实盘一套"）
//   2. 三个策略等权分账（每个 1/3 账户净值），合并成账户层目标持仓
//   3. 读 Alpaca Paper 账户当前持仓，输出调仓计划（股数、金额）。下单需用户确认后另行执行（--submit 尚未实现，故意的）
// 用法（backend/ 下）：node backtest/lab/paper.mjs
// 注意：回测里杠杆 ETF 上市前是合成数据；这里只用最新数据算信号，策略指标（200 日线、20 日波动、1/3/6 月动量）都在真实段内。
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
import { loadPanel } from './data.mjs';
import { backtest } from './engine.mjs';
import * as S from './strategies.mjs';
import { tiingo } from '../ndx-rotation/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(HERE, '../../../../_shared/.env') });

export const BOOK = {
  T5c: { name: 'UPRO 波动目标40% + SPY 200日线', mk: () => S.volTarget({ risk: 'UPRO', target: 0.4, lookback: 20, gate: { signal: 'SPY', n: 200, band: 0.02 } }) },
  M2c: { name: 'ADM 美股腿 UPRO + 波动目标40%', mk: () => S.adm({ hold: { SPY: 'UPRO' }, volTarget: 0.4 }) },
  M2a: { name: 'ADM 美股腿 SSO(2x)', mk: () => S.adm({ hold: { SPY: 'SSO' } }) },
};

/** 每个策略"当前应持有"的权重：跑回测到最新一天，取最后一笔已发出的目标并按漂移后的实际权重近似 */
export async function currentTargets({ refresh = true } = {}) {
  const syms = ['SPY', 'UPRO', 'SSO', 'TLT', 'EFA'];
  if (refresh) for (const s of syms) await tiingo(s, { refresh: true }); // 拉到最新收盘
  const P = await loadPanel(syms, { extend: true });
  const out = {};
  for (const [k, b] of Object.entries(BOOK)) {
    const r = backtest(P, b.mk(), { start: P.dates[260], lag: 0 }); // lag 0：今天收盘的信号就是明天要持有的
    const last = r.log.at(-1);
    out[k] = { name: b.name, asOf: P.dates.at(-1), since: last?.d, target: last?.w || {} };
  }
  return { asOf: P.dates.at(-1), targets: out };
}

async function alpaca(pathname) {
  const r = await axios.get(`https://paper-api.alpaca.markets${pathname}`, {
    headers: { 'APCA-API-KEY-ID': process.env.ALPACA_PAPER_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_PAPER_SECRET }, timeout: 20000 });
  return r.data;
}
async function lastTrade(sym) {
  const r = await axios.get(`https://data.alpaca.markets/v2/stocks/${sym}/trades/latest`, {
    params: { feed: 'iex' }, headers: { 'APCA-API-KEY-ID': process.env.ALPACA_PAPER_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_PAPER_SECRET }, timeout: 20000 });
  return r.data.trade.p;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.ALPACA_PAPER_KEY?.startsWith('PK')) throw new Error('ALPACA_PAPER_KEY missing or not a paper key');
  const { asOf, targets } = await currentTargets();
  console.log(`信号日期（最新收盘）：${asOf}`);
  const combined = {}, n = Object.keys(targets).length;
  for (const [k, t] of Object.entries(targets)) {
    const desc = Object.entries(t.target).map(([s, w]) => `${s} ${(w * 100).toFixed(0)}%`).join(' + ') || '现金';
    console.log(`  ${k} ${t.name.padEnd(28)} → ${desc}（自 ${t.since} 起）`);
    for (const [s, w] of Object.entries(t.target)) combined[s] = (combined[s] || 0) + w / n;
  }
  const acct = await alpaca('/v2/account');
  const pos = Object.fromEntries((await alpaca('/v2/positions')).map(p => [p.symbol, +p.qty]));
  const equity = +acct.equity;
  console.log(`\nAlpaca Paper：净值 $${equity.toLocaleString()}，现金 $${(+acct.cash).toLocaleString()}，持仓 ${Object.keys(pos).length} 个`);
  console.log('账户层目标（三策略各 1/3）与调仓计划：');
  const syms = new Set([...Object.keys(combined), ...Object.keys(pos)]);
  let cashW = 1; const plan = [];
  for (const s of syms) {
    const w = combined[s] || 0; cashW -= w;
    const px = await lastTrade(s);
    // 留 2% 现金缓冲：市价单成交价可能高于参考价，避免满仓买单因购买力不足被拒
    const want = Math.floor(equity * w * 0.98 / px), have = pos[s] || 0, d = want - have;
    plan.push({ s, d, px });
    console.log(`  ${s.padEnd(5)} 目标 ${(w * 100).toFixed(1).padStart(5)}%  价 $${px.toFixed(2).padStart(8)}  目标 ${String(want).padStart(5)} 股  现有 ${String(have).padStart(5)}  → ${d === 0 ? '不动' : (d > 0 ? '买 ' : '卖 ') + Math.abs(d) + ' 股（约 $' + Math.round(Math.abs(d) * px).toLocaleString() + '）'}`);
  }
  console.log(`  现金  目标 ${(cashW * 100).toFixed(1)}%`);
  if (!process.argv.includes('--submit')) { console.log('\n未下单（加 --submit --confirmed 才会提交到 Alpaca Paper）'); process.exit(0); }
  if (!process.argv.includes('--confirmed')) throw new Error('--submit 需要同时带 --confirmed（用户确认过本次调仓计划）');
  // 先卖后买；市价 day 单（休市时提交会排队到下一个开盘）；client_order_id 含信号日，同一天重复执行会被 Alpaca 拒绝（幂等）
  const fs = await import('fs');
  const logF = path.join(HERE, 'out/paper-orders.jsonl');
  const ordersPlan = plan.sort((a, b) => a.d - b.d);
  for (const o of ordersPlan) {
    if (o.d === 0) continue;
    const body = { symbol: o.s, qty: String(Math.abs(o.d)), side: o.d > 0 ? 'buy' : 'sell', type: 'market', time_in_force: 'day', client_order_id: `lab-${asOf}-${o.s}-${o.d > 0 ? 'b' : 's'}` };
    try {
      const r = await axios.post('https://paper-api.alpaca.markets/v2/orders', body, { headers: { 'APCA-API-KEY-ID': process.env.ALPACA_PAPER_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_PAPER_SECRET }, timeout: 20000 });
      console.log(`  已提交 ${body.side} ${body.qty} ${body.symbol} → ${r.data.status}（id ${r.data.id}）`);
      fs.appendFileSync(logF, JSON.stringify({ at: new Date().toISOString(), signalDate: asOf, refPx: o.px, ...body, id: r.data.id, status: r.data.status }) + '\n');
    } catch (e) {
      console.log(`  失败 ${body.side} ${body.qty} ${body.symbol}：${e?.response?.status} ${JSON.stringify(e?.response?.data || e.message).slice(0, 160)}`);
    }
  }
}
