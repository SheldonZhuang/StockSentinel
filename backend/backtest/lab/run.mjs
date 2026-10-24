// 策略实验室第一批：合成校验 → 候选策略全期 / 样本内(2000–2009) / 样本外(2010–) → 参数稳健性网格。
// 用法（backend/ 下）：NDX_OFFLINE=1 node backtest/lab/run.mjs [--grid]
// 成本：单边 5bp；执行：收盘出信号、次日收盘成交。合成段：TQQQ/QLD←QQQ、SOXL←SOXX、TLT/IEF←VUSTX、EFA←VGTSX、AGG←VBMFX。
import { loadPanel } from './data.mjs';
import { backtest, stats } from './engine.mjs';
import * as S from './strategies.mjs';
import { tiingo } from '../ndx-rotation/lib.mjs';

const pct = (x, d = 1) => (x == null || !isFinite(x) ? '   —' : `${(x * 100).toFixed(d)}%`);
const usd = x => `$${Math.round(x).toLocaleString('en-US')}`;

// ---------- 1. 合成校验：真实 TQQQ/SOXL 上市后的重叠期，合成 vs 真实 ----------
async function validateSynth(sym) {
  const real = (await tiingo(sym)).rows;
  const P = await loadPanel([sym], { extend: true });   // 上市后是真实数据
  const { LEVERED } = await import('./data.mjs');
  const { base, L, er } = LEVERED[sym];
  const B = await loadPanel([base], { from: real[1].d, extend: false });
  let syn = 1, act = 1; const d0 = B.dates[0];
  const realMap = new Map(real.map((r, i) => [r.d, i ? r.ac / real[i - 1].ac - 1 : 0]));
  let n = 0, se = 0;
  for (let i = 1; i < B.dates.length; i++) {
    const d = B.dates[i]; if (!realMap.has(d)) continue;
    const rs = L * B.ret[base][i] - (L - 1) * B.rf[i] - er / 100 / 252, ra = realMap.get(d);
    syn *= 1 + rs; act *= 1 + ra; se += (rs - ra) ** 2; n++;
  }
  const yrs = n / 252;
  console.log(`  ${sym}: ${d0} 起 ${n} 天  真实年化 ${pct(act ** (1 / yrs) - 1)}  合成年化 ${pct(syn ** (1 / yrs) - 1)}  日跟踪误差 ${(Math.sqrt(se / n) * 1e4).toFixed(1)}bp  (${P.meta[sym].synthUntil ? '面板已回补至 ' + P.meta[sym].first : ''})`);
}

// ---------- 2. 候选策略 ----------
const SECTORS = ['XLB', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLU', 'XLV', 'XLY'];
const candidates = [
  ['基准 SPY 买持', S.buyHold({ SPY: 1 })],
  ['基准 QQQ 买持', S.buyHold({ QQQ: 1 })],
  ['TQQQ 买持', S.buyHold({ TQQQ: 1 })],
  ['QLD 买持（2x）', S.buyHold({ QLD: 1 })],
  ['T1 TQQQ+QQQ200日线±2% 日检', S.smaFilter({ risk: 'TQQQ', signal: 'QQQ', n: 200, band: 0.02 })],
  ['T2 TQQQ+QQQ200日线 月检', S.smaFilter({ risk: 'TQQQ', signal: 'QQQ', n: 200, band: 0, freq: 'monthly' })],
  ['T3 QLD+QQQ200日线±2% 日检', S.smaFilter({ risk: 'QLD', signal: 'QQQ', n: 200, band: 0.02 })],
  ['T4 TQQQ 波动目标40%', S.volTarget({ risk: 'TQQQ', target: 0.4, lookback: 20 })],
  ['T5 TQQQ 波动目标40%+200日线', S.volTarget({ risk: 'TQQQ', target: 0.4, lookback: 20, gate: { signal: 'QQQ', n: 200, band: 0.02 } })],
  ['T6 TQQQ+200日线，空仓持TLT', S.smaFilter({ risk: 'TQQQ', signal: 'QQQ', n: 200, band: 0.02, off: 'TLT' })],
  ['M1 GEM 双动量', S.gem({ us: 'SPY', intl: 'EFA', bond: 'AGG' })],
  ['M2 ADM 加速双动量', S.adm({ us: 'SPY', intl: 'EFA', bond: 'TLT' })],
  ['M3 ADM 纳指版（QQQ/EFA/TLT）', S.adm({ us: 'QQQ', intl: 'EFA', bond: 'TLT' })],
  ['R1 行业趋势（9 个 SPDR）', S.sectorTrend({ syms: SECTORS })],
  ['P1 60/40 SPY/TLT 月再平衡', S.buyHold({ SPY: 0.6, TLT: 0.4 }, { rebalance: 'monthly' })],
];
const ALL = ['SPY', 'QQQ', 'TQQQ', 'QLD', 'TLT', 'AGG', 'EFA', ...SECTORS];

function row(name, st) {
  return `${name.padEnd(30)} ${pct(st.cagr).padStart(7)} ${pct(st.mdd).padStart(7)} ${st.sharpe.toFixed(2).padStart(5)} ${st.calmar.toFixed(2).padStart(5)} ${pct(st.worstYear).padStart(7)} ${st.tradesPerYear.toFixed(1).padStart(5)} ${pct(st.avgExposure, 0).padStart(5)}  ${usd(st.final).padStart(12)}`;
}
const HDR = `${'策略'.padEnd(28)}    年化    回撤  夏普 Calmar 最差年  次/年  仓位     期末($1万)`;

async function main() {
  console.log('== 1. 合成杠杆 ETF 校验（重叠期，真实 vs 合成）==');
  await validateSynth('TQQQ'); await validateSynth('QLD');

  const P = await loadPanel(ALL, { from: '1999-01-01', extend: true });
  console.log(`\n面板 ${P.dates[0]} → ${P.dates.at(-1)}，${P.dates.length} 个交易日；合成/替代段：` +
    Object.entries(P.meta).filter(([, m]) => m.synthUntil).map(([s, m]) => `${s}<${m.synthUntil}`).join(' '));
  // 预热 1 年（200 日线 / 12 月动量）后起算，所有策略同一起点
  const START = P.dates[260];
  const windows = [['全期', START, '9999'], ['样本内 2000–2009', START, '2009-12-31'], ['样本外 2010–至今', '2010-01-01', '9999'], ['2010-04-01 起（对照假设 8）', '2010-04-01', '9999']];
  const results = {};
  for (const [wName, a, b] of windows) {
    console.log(`\n== ${wName}（${a} 起）==\n${HDR}`);
    for (const [name, mk] of candidates) {
      // 每个窗口独立重跑：策略状态在 ctx.state（每次 backtest 新建）；样本外窗口的指标仍用起点前的数据预热
      const st = stats(backtest(P, mk, { start: a, end: b, costBps: 5 }));
      (results[name] ??= {})[wName] = st;
      console.log(row(name, st));
    }
  }
  return { P, results };
}

// ---------- 3. 参数稳健性网格（只看是否稳定，不用来挑最优）----------
async function grid(P) {
  console.log('\n== 参数网格：TQQQ + QQQ 均线过滤（日检），年化 / 回撤；左=样本内 2000–2009，右=样本外 2010– ==');
  const ns = [100, 150, 200, 250], bands = [0, 0.01, 0.02, 0.03, 0.05];
  console.log('n \\ band'.padEnd(10) + bands.map(b => `±${(b * 100).toFixed(0)}%`.padStart(26)).join(''));
  for (const n of ns) {
    let line = String(n).padEnd(10);
    for (const band of bands) {
      const mk = () => S.smaFilter({ risk: 'TQQQ', signal: 'QQQ', n, band });
      const a = stats(backtest(P, mk(), { start: P.dates[260], end: '2009-12-31' }));
      const b = stats(backtest(P, mk(), { start: '2010-01-01' }));
      line += `${pct(a.cagr, 0)}/${pct(a.mdd, 0)} | ${pct(b.cagr, 0)}/${pct(b.mdd, 0)}`.padStart(26);
    }
    console.log(line);
  }
  console.log('\n== 成本敏感性：T1 在单边 0 / 5 / 20 / 50bp ==');
  for (const c of [0, 5, 20, 50]) {
    const st = stats(backtest(P, S.smaFilter({ risk: 'TQQQ', signal: 'QQQ', n: 200, band: 0.02 }), { start: P.dates[260], costBps: c }));
    console.log(`  ${String(c).padStart(2)}bp  年化 ${pct(st.cagr)}  回撤 ${pct(st.mdd)}`);
  }
  console.log('\n== 执行滞后：T1 在 lag 0（理想同日收盘）/ 1 / 2 / 5 天 ==');
  for (const lag of [0, 1, 2, 5]) {
    const st = stats(backtest(P, S.smaFilter({ risk: 'TQQQ', signal: 'QQQ', n: 200, band: 0.02 }), { start: P.dates[260], lag }));
    console.log(`  lag ${lag}  年化 ${pct(st.cagr)}  回撤 ${pct(st.mdd)}`);
  }
}

const { P } = await main();
if (process.argv.includes('--grid')) await grid(P);
