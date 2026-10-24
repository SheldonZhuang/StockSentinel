// S1「去年冠军」：Y 年首个交易日开盘，全仓买入 Y-1 年总回报最高的 NDX 成员（成员=Y-1 年末时点名单，
// 回报 = Y-2 年末 adjClose → Y-1 年末 adjClose），持有到 Y+1 年首个交易日开盘换仓。
// 依赖 build-universe.mjs 产出的 out/universe.json；OVERRIDES 记录需人工判定的年份（附理由），会在报告中列出。
import path from 'path';
import { readJSON, writeJSON, OUT } from './lib.mjs';
import { tradingDays } from './calendar.mjs';
import { holdLeg, buyHold, stats, yearlyReturns } from './engine.mjs';

const U = readJSON(path.join(OUT, 'universe.json'));
if (!U) throw new Error('run build-universe.mjs first');
// 需人工判定的年份（附理由）；数据核对完成后在此登记，报告会逐条列出
const OVERRIDES = {};
const days = await tradingDays();
const firstDay = y => days.find(d => d.startsWith(String(y)));
const lastY = +days.at(-1).slice(0, 4);

// 模式 survivor：只允许"价格序列一直延续到最新交易日"的名字（=只用今天还活着的代码），用来量化幸存者偏差
const MODE = ['survivor', 'today'].includes(process.argv[2]) ? process.argv[2] : 'pit'; // pit=时点成分（主结果）；survivor=时点成分里只留今天仍在交易的；today=今天的成分股回看
const { series } = await import('./prices.mjs');
const alive = async sym => (await series(sym)).rows.at(-1)?.d >= days.at(-8);
const picks = [];
let curve = [], value = 1;
for (let Y = 2000; Y <= lastY; Y++) {
  const prev = U.years[Y - 1];
  let pool = prev.all;
  if (MODE === 'survivor') { const keep = []; for (const r of pool) if (await alive(r.sym)) keep.push(r); pool = keep; }
  if (MODE === 'today') { // 朴素做法（任务明确禁止作为主结果）：用今天的成分股回看所有年份，只用于对照
    const { membersAt } = await import('./membership.mjs'); const { pricePair } = await import('./build-universe.mjs');
    pool = [];
    for (const t of membersAt(days.at(-1))) { const p = await pricePair(t, prev.dStart, prev.dEnd); if (p) pool.push({ sym: p.sym, ret: p.a1 / p.a0 - 1, core: true }); }
    pool.sort((a, b) => b.ret - a.ret);
  }
  let pick = pool[0];
  if (OVERRIDES[Y] && MODE === 'pit') pick = { ...(prev.all.find(r => r.sym === OVERRIDES[Y].sym) || {}), sym: OVERRIDES[Y].sym, override: OVERRIDES[Y].reason };
  const buyD = firstDay(Y), sellD = Y < lastY ? firstDay(Y + 1) : null;
  const leg = await holdLeg(pick.sym, buyD, sellD, days);
  // 换仓日（上一段的卖出日 = 本段的买入日）已由上一段记过收盘净值：本段首日不覆盖它。
  // 2026-10-23 修：此前覆盖写入，换仓日的净值被新股票的开盘→收盘涨跌"顶替"，期末值与各段乘积不一致
  for (const p of leg.daily) if (!curve.length || curve.at(-1).d !== p.d) curve.push({ d: p.d, v: value * p.v });
  value *= leg.mult;
  picks.push({ year: Y, sym: pick.sym, name: pick.name || null, priorYearRet: pick.ret, holdRet: leg.mult - 1, buyD, sellD: sellD || `${days.at(-1)} (open, mark-to-market)`,
    event: leg.event, core: pick.core, runnerUp: pool[1] ? `${pool[1].sym} ${(pool[1].ret * 100).toFixed(0)}%` : null,
    universe: `${prev.method}; priced ${prev.nPriced}/${prev.nMembers}, gaps ${prev.gaps.length}`, override: pick.override || null });
}
const s1 = stats(curve);
const qqq = stats(await buyHold('QQQ', firstDay(2000), days));
const spy = stats(await buyHold('SPY', firstDay(2000), days));
const worst = picks.reduce((a, b) => (b.holdRet < a.holdRet ? b : a));
writeJSON(path.join(OUT, `s1_result_${MODE}.json`), { stats: s1, picks, worst, qqq, spy });
const pct = x => (x * 100).toFixed(1) + '%';
console.log('Year Pick  PriorYr  HoldYr  note');
for (const p of picks) console.log(p.year, p.sym.padEnd(5), pct(p.priorYearRet).padStart(8), pct(p.holdRet).padStart(8), p.event || '', p.override ? `[override: ${p.override}]` : '', p.core === false ? '[non-core member]' : '');
for (const [k, s] of [['S1[' + MODE + ']', s1], ['QQQ', qqq], ['SPY', spy]]) console.log(k, 'final $' + s.final.toFixed(0), 'total', pct(s.totalRet), 'CAGR', pct(s.cagr), 'MDD', pct(s.mdd), s.mddWindow?.peakD, '→', s.mddWindow?.d);
console.log('worst S1 year', worst.year, worst.sym, pct(worst.holdRet));
