// 归因分析（2026-07-17）：W5采纳前基线(V3+V4)在2010-01起跑输买入持有2.3pp/年的逐段分解
// 用法：node backtest/attribution.mjs（复用 run-backtest.js 的数据加载与重放，FRED 缓存可用）
// 注意：固定在 trendReentry:false（旧基线）上归因——本脚本的结论正是 W5 采纳依据，需保持可复现
// 输出：①2010后每段全面防守片段明细（起止/触发/段内策略vs买入持有/真假阳性/V4尾巴）
//      ②V4迟滞每次延迟降档的时点与单月代价 ③三桶分解（假阳性段/真危机段时机损耗/V4迟滞）
import { loadData, runReplay, simulateNav, VARIANTS_DEFAULT } from './run-backtest.js';

const SUB_START = '2010-01';
const ATTRIB_VARIANTS = { ...VARIANTS_DEFAULT, trendReentry: false }; // W5采纳前的旧基线

function episodesOf(timeline) {
  const eps = [];
  let cur = null;
  for (const t of timeline) {
    if (t.final === 'defense') {
      if (!cur) cur = { start: t.month, months: [] };
      cur.months.push(t);
    } else if (cur) {
      cur.end = t.month; // 恢复非防守的月份（不含）
      eps.push(cur);
      cur = null;
    }
  }
  if (cur) { cur.end = null; eps.push(cur); }
  return eps;
}

function triggerLabel(t) {
  const locks = [t.sahmLockActive && '萨姆锁', t.reactiveLockActive && '应对锁'].filter(Boolean);
  const dims = [t.monetary === 'tight' && '货币', t.fiscal === 'tight' && '财政', t.admin === 'tight' && '行政'].filter(Boolean);
  if (locks.length) return locks.join('+') + (dims.length >= 2 ? `(+树:${dims.join('+')})` : '');
  return dims.join('+') || '?';
}

async function main() {
  const D = await loadData();
  const timeline = runReplay(D, ATTRIB_VARIANTS);
  const byMonth = new Map(timeline.map(t => [t.month, t]));
  const idxOf = new Map(timeline.map((t, i) => [t.month, i]));

  // ---- ①防守片段明细（2010-01 起） ----
  const eps = episodesOf(timeline).filter(e => e.start >= SUB_START);
  const rows = [];
  for (const e of eps) {
    const i0 = idxOf.get(e.start);
    // 段收益：从片段起始月到恢复月（含），曝险由上月档位决定 → 恰好覆盖全部防守曝险月
    const endIdx = e.end ? idxOf.get(e.end) : timeline.length - 1;
    const seg = timeline.slice(i0, endIdx + 1).filter(t => t.spx !== null);
    const strat = simulateNav(seg, D.rateMap);
    const bh = simulateNav(seg, D.rateMap, { buyHold: true });
    // 真/假阳性（与 evaluate 同口径）：起始月起13个采样点内最低价 vs 起始价，跌幅>15%为真
    const horizon = timeline.slice(i0, i0 + 13).map(t => t.spx).filter(v => v != null && !isNaN(v));
    const startPx = byMonth.get(e.start)?.spx;
    const maxDD = startPx && horizon.length ? (Math.min(...horizon) / startPx - 1) * 100 : null;
    const isTrue = maxDD !== null && maxDD <= -15;
    const v4Tail = e.months.filter(t => t.rawFinal !== 'defense').length;
    rows.push({
      起止: `${e.start}~${e.end ?? '在续'}`, 月数: e.months.length,
      触发: triggerLabel(e.months[0]),
      末月触发: triggerLabel(e.months[e.months.length - 1]),
      段策略: strat ? strat.totalPct.toFixed(1) + '%' : '—',
      段买持: bh ? bh.totalPct.toFixed(1) + '%' : '—',
      差pp: strat && bh ? (strat.totalPct - bh.totalPct).toFixed(1) : '—',
      '12月内最大回撤': maxDD !== null ? maxDD.toFixed(1) + '%' : '—',
      判定: isTrue ? '真阳性' : '假阳性',
      V4尾巴月: v4Tail,
    });
    e.isTrue = isTrue;
  }
  console.log('\n===== ① 2010-01起 全面防守片段逐段归因 =====');
  console.table(rows);

  // ---- ② V4迟滞延迟降档事件（2010起，final=defense 但 rawFinal 更宽松的月份） ----
  console.log('\n===== ② V4迟滞延迟降档（defense被多扛的月份，2010起） =====');
  const v4rows = [];
  for (let i = 0; i < timeline.length - 1; i++) {
    const t = timeline[i], n = timeline[i + 1];
    if (t.month < SUB_START || t.final !== 'defense' || t.rawFinal === 'defense') continue;
    if (t.spx === null || n.spx === null) continue;
    const ret = (n.spx / t.spx - 1) * 100;
    const cash = ((D.rateMap.get(t.month) ?? 0) / 12);
    v4rows.push({
      月份: t.month, 原始档: t.rawFinal, 生效档: t.final,
      次月SPY: ret.toFixed(1) + '%', 现金: cash.toFixed(2) + '%',
      单月代价pp: (cash - ret).toFixed(1),
    });
  }
  console.table(v4rows);
  const v4Total = v4rows.reduce((a, r) => a + parseFloat(r.单月代价pp), 0);
  console.log(`V4迟滞2010起合计单月代价（算术和）：${v4Total.toFixed(1)}pp，共${v4rows.length}个月`);

  // ---- ③ 三桶分解：2010起 策略CAGR−买持CAGR 的对数精确分解 ----
  // 策略与买持仅在"防守曝险月"分道（reduce按满仓），故 log(navS)−log(navB) = Σ防守曝险月 [ln现金−lnSPY]
  const sub = timeline.filter(t => t.month >= SUB_START && t.spx !== null);
  const years = (sub.length - 1) / 12;
  const buckets = { V4迟滞: 0, 假阳性段: 0, 真危机段: 0 };
  const epOf = m => eps.find(e => e.start <= m && (e.end === null || m < e.end));
  for (let i = 1; i < sub.length; i++) {
    const p = sub[i - 1];
    if (p.final !== 'defense') continue;
    const ret = sub[i].spx / p.spx;
    const cash = 1 + ((D.rateMap.get(p.month) ?? 0) / 100) / 12;
    const d = Math.log(cash) - Math.log(ret);
    const ep = epOf(p.month);
    if (p.rawFinal !== 'defense') buckets.V4迟滞 += d;
    else if (ep && ep.isTrue) buckets.真危机段 += d;
    else buckets.假阳性段 += d;
  }
  const stratSim = simulateNav(sub, D.rateMap);
  const bhSim = simulateNav(sub, D.rateMap, { buyHold: true });
  const totalLog = Object.values(buckets).reduce((a, b) => a + b, 0);
  console.log('\n===== ③ 三桶分解（2010起，对数收益差 → pp/年） =====');
  console.log(`2010起 策略年化 ${stratSim.cagrPct.toFixed(1)}% vs 买持 ${bhSim.cagrPct.toFixed(1)}%（算术差 ${(stratSim.cagrPct - bhSim.cagrPct).toFixed(1)}pp/年）`);
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`  ${k}: ${(v / years * 100).toFixed(2)}pp/年（占总差 ${(v / totalLog * 100).toFixed(0)}%）`);
  }
  console.log(`  合计(对数口径): ${(totalLog / years * 100).toFixed(2)}pp/年`);

  // 真危机段细分：崩盘期(信号→段内最低月)贡献 vs 反弹期(最低月→恢复)贡献
  console.log('\n===== ③b 真阳性段内部：护住的下跌 vs 错过的反弹 =====');
  for (const e of eps.filter(e => e.isTrue)) {
    const i0 = idxOf.get(e.start);
    const endIdx = e.end ? idxOf.get(e.end) : timeline.length - 1;
    const seg = timeline.slice(i0, endIdx + 1).filter(t => t.spx !== null);
    let low = seg[0], lowIdx = 0;
    seg.forEach((t, i) => { if (t.spx < low.spx) { low = t; lowIdx = i; } });
    const part = (a, b) => {
      let s = 0;
      for (let i = a + 1; i <= b; i++) {
        const p = seg[i - 1];
        if (p.final !== 'defense') continue;
        const cash = 1 + ((D.rateMap.get(p.month) ?? 0) / 100) / 12;
        s += Math.log(cash) - Math.log(seg[i].spx / p.spx);
      }
      return s * 100;
    };
    console.log(`  ${e.start}~${e.end ?? '在续'}: 下跌期(→${low.month}) ${part(0, lowIdx).toFixed(1)}pp | 反弹期(${low.month}→) ${part(lowIdx, seg.length - 1).toFixed(1)}pp`);
  }
}

main().catch(e => { console.error('[attribution] failed:', e.message); process.exit(1); });
