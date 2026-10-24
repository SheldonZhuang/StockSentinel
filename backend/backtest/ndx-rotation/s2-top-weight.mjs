// S2「每次调整后最大权重」：每个调整生效日（季度 + 特别），按 "指数股票线市值 = 流通股 × 参考日未复权收盘价" 排序取第一，
// 在生效后的首个交易日（新权重开始生效那天）开盘全仓买入，持有到下一次调整的同一时点；第一名没变就继续持有。
// 流通股：2009 年中以前 = 10-K/10-Q 封面股数（fetch-cover-shares.mjs），之后 = SEC dei:EntityCommonStockSharesOutstanding；
// 取 filed <= 参考日 的最新值，并用 Tiingo splitFactor 把股数调整到参考日口径（避免拆股前后错配）。
// GOOG/GOOGL、META 为多类别股，公司封面按类别带维度披露，dei 汇总值缺失 → 不进入计算排序，改用 QQQ 实际持仓数据核验它们从未排第一。
import path from 'path';
import { writeJSON, OUT } from './lib.mjs';
import { tradingDays, rebalanceCalendar } from './calendar.mjs';
import { rankAt as rankCap } from './s2-rank.mjs';
import { rankIdxAt } from './s2-rank-idx.mjs';
// 排名方式：cap = 流通股×价格（任务指定的主口径）；idx = QQQ 实际持仓推出的指数股数×价格（贴近真实指数权重，作敏感性对照）
const MODE = process.argv[2] === 'idx' ? 'idx' : 'cap';
const rankAt = MODE === 'idx' ? async d => (await rankIdxAt(d)).rows.map(r => ({ tk: r.tk, cap: r.w })) : rankCap;
import { holdLeg, stats, buyHold } from './engine.mjs';

const days = await tradingDays();
const cal = (await rebalanceCalendar(1999)).filter(c => c.inForce >= '2000-01-01' || c.eff === '1999-12-17');
// 起点：2000 年首个交易日按 1999-12 调整的排名买入；之后每个调整点重排
const startD = days.find(d => d >= '2000-01-01');
const points = [{ eff: '1999-12-17', inForce: startD, kind: 'start (Dec-1999 ranking, bought on first 2000 trading day)' },
  ...cal.filter(c => c.inForce > startD)];
const seq = [];
for (const p of points) {
  const r = await rankAt(p.eff);
  seq.push({ ...p, top: r[0]?.tk, second: r[1]?.tk, gapPct: r[1] ? r[0].cap / r[1].cap - 1 : null, top3: r.slice(0, 3).map(x => `${x.tk} $${(x.cap / 1e9).toFixed(0)}B`) });
}
// 合并连续相同持仓为持有段
const legs = [];
for (const s of seq) { if (!legs.length || legs.at(-1).sym !== s.top) legs.push({ sym: s.top, buyD: s.inForce, eff: s.eff, minGap: s.gapPct }); else legs.at(-1).minGap = Math.min(legs.at(-1).minGap, s.gapPct); }
let curve = [], value = 1;
for (let i = 0; i < legs.length; i++) {
  const L = legs[i], sellD = legs[i + 1]?.buyD || null;
  const leg = await holdLeg(L.sym, L.buyD, sellD, days);
  // 换仓日不覆盖上一段已记的净值（2026-10-23 修，同 s1-last-year-winner.mjs）
  for (const p of leg.daily) if (!curve.length || curve.at(-1).d !== p.d) curve.push({ d: p.d, v: value * p.v });
  value *= leg.mult; L.sellD = sellD || `${days.at(-1)} (open)`; L.ret = leg.mult - 1; L.event = leg.event;
}
const st = stats(curve);
const qqq = stats(await buyHold('QQQ', startD, days)), spy = stats(await buyHold('SPY', startD, days));
writeJSON(path.join(OUT, `s2_result_${MODE}.json`), { stats: st, legs, seq, qqq, spy });
const pct = x => (x * 100).toFixed(1) + '%';
for (const L of legs) console.log(L.buyD, '→', String(L.sellD).slice(0, 10), L.sym.padEnd(5), pct(L.ret).padStart(9), 'min lead over #2', pct(L.minGap), L.event || '');
console.log('S2[' + MODE + '] final $' + st.final.toFixed(0), 'total', pct(st.totalRet), 'CAGR', pct(st.cagr), 'MDD', pct(st.mdd), st.mddWindow?.peakD, '→', st.mddWindow?.d);
console.log('close calls (<5% lead):', seq.filter(s => s.gapPct < 0.05).map(s => `${s.eff} ${s.top}>${s.second} +${pct(s.gapPct)}`).join('; '));
