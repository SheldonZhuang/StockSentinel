// R3 CAPE仓位缩放评估（2026-07-19 路线图末三项之三）：执行层改动、不动信号——
// attack/neutral 期的目标仓位按 CAPE 30年滚动分位缩放（任务书档：<50分位→100%、50-80→85%、
// 80-90→70%、>90→55%，另做参数敏感性），叠加在：
//   ① dca-schemes 的 E7（85%TQQQ月度再平衡+信号防守，一次性投入）→ 0.85×scale
//   ② dca-schemes 的 S5a（月度，存量+新钱都择时）→ 目标权重=scale（simulateS5.targetWeightOf）
//   ③ s5-daily 的 S5a 日度 T+0（"2022年-59.4%"口径来源）→ 同②（simulateS5Daily.targetOf）
// 动机：估值高位少拿杠杆，改善"2022型快熊滞后期硬吃"（2021年CAPE处>90分位）。
// 决策标准（任务书）：S5全期XIRR降幅≤1pp 的前提下最差年/回撤显著改善才值得。
// 运行：node backend/backtest/cape-scaling.mjs（repo 根或 backend 目录均可）
// 只读复用既有导出，不修改任何脚本默认行为（targetWeightOf/targetOf 默认 null=逐位一致）。
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { runReplay, VARIANTS_DEFAULT } from './run-backtest.js';
import { monthlyCloseMap } from './execution-layer.mjs';
import { synthDailyCustom, statsFromNav, navPathFromWeights, loadQqqBars } from './tqqq-schemes.mjs';
import { simulateS5, dcaStats } from './dca-schemes.mjs';
import { loadDailyData, runDailyReplay } from './daily-replay.mjs';
import { buildS5Days, simulateS5Daily, dailyPathExtremes } from './s5-daily.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.join(__dirname, '../.env') });

// ---------- 纯函数（backend/tests/r-series.test.js 覆盖） ----------

/** 参数档：[分位上界(不含), 目标仓位倍率] 升序；P0=任务书默认；P3a/b/c=P3的阈值/力度敏感性 */
export const CAPE_BANDS = {
  'P0任务书(1/.85/.70/.55)': [[50, 1], [80, 0.85], [90, 0.70], [Infinity, 0.55]],
  'P1温和(1/.90/.80/.70)': [[50, 1], [80, 0.90], [90, 0.80], [Infinity, 0.70]],
  'P2激进(1/.85/.60/.40)': [[50, 1], [80, 0.85], [90, 0.60], [Infinity, 0.40]],
  'P3仅顶档(>90→.55)': [[90, 1], [Infinity, 0.55]],
  'P3a敏感(>85→.55)': [[85, 1], [Infinity, 0.55]],
  'P3b敏感(>90→.70)': [[90, 1], [Infinity, 0.70]],
  'P3c敏感(>90→.40)': [[90, 1], [Infinity, 0.40]],
};

/**
 * CAPE 30年分位 → 目标仓位倍率。pct=null（数据缺失）→ 1（fail-open满仓，调用方统计并如实报告）
 */
export function capeScaleOf(pct, bands) {
  if (pct === null || pct === undefined) return 1;
  for (const [upTo, scale] of bands) if (pct < upTo) return scale;
  return bands[bands.length - 1][1];
}

// ---------- 主流程 ----------

const f1 = v => (v === null || v === undefined || isNaN(v) ? '—' : v.toFixed(1));
const money = v => {
  const usd = v * 1000;
  return usd >= 1e6 ? `$${(usd / 1e6).toFixed(2)}M` : `$${Math.round(usd / 1000)}k`;
};

async function main() {
  const { D, DD } = await loadDailyData();
  const { rateMap } = D;
  console.log('[cape-scaling] 重放基线信号（月度+日度，信号本身不动）...');
  const timeline = runReplay(D, VARIANTS_DEFAULT).filter(t => t.spx !== null);
  const recs = runDailyReplay(DD).filter(r => r.date >= '2000-01-01' && r.date <= '2026-06-30');

  // CAPE 分位（timeline.metrics.capePct，M-1可见、30年滚动窗，runReplay 已建模）
  const capeMap = new Map(timeline.map(t => [t.month, t.metrics.capePct]));
  const nullMonths = timeline.filter(t => t.metrics.capePct === null || t.metrics.capePct === undefined).length;
  const bandCount = { '<50': 0, '50-80': 0, '80-90': 0, '>90': 0 };
  for (const t of timeline) {
    const p = t.metrics.capePct;
    if (p === null || p === undefined) continue;
    bandCount[p < 50 ? '<50' : p < 80 ? '50-80' : p < 90 ? '80-90' : '>90']++;
  }
  console.log(`CAPE分位覆盖：${timeline.length}个月中缺失${nullMonths}个月（缺失=不缩放满仓，fail-open）；` +
    `档位分布 <50:${bandCount['<50']} 50-80:${bandCount['50-80']} 80-90:${bandCount['80-90']} >90:${bandCount['>90']}`);
  const p2021 = timeline.filter(t => t.month >= '2021-01' && t.month <= '2021-12').map(t => t.metrics.capePct);
  console.log(`2021年CAPE分位逐月：${p2021.map(p => p?.toFixed(0) ?? '—').join(' ')}（任务书预期：>90分位 → 2x档只拿55%）`);

  const qqqBars = await loadQqqBars();
  const rateOfDate = d => rateMap.get(d.slice(0, 7)) ?? 0;
  const tqqqDaily = synthDailyCustom(qqqBars, rateOfDate, { beta: 3, ffrMult: -2, erPct: 0.86 });
  const px = { tqqq: monthlyCloseMap(tqqqDaily), spy: monthlyCloseMap(D.spx) };
  const assetRet = (asset, m0, m1) => {
    const a = px[asset].get(m0), b = px[asset].get(m1);
    return a && b ? b / a - 1 : null;
  };

  // ===== ① E7（一次性投入，85%TQQQ月度再平衡+信号防守）× CAPE =====
  const e7Of = scaleFn => (f, m) => {
    if (f === 'defense') return { cash: 1 };
    if (f === 'reduce') return { spy: 1 };
    const s = scaleFn ? scaleFn(m.metrics.capePct) : 1;
    return { tqqq: 0.85 * s, cash: 1 - 0.85 * s };
  };
  const e7Rows = [];
  const e7Base = statsFromNav(navPathFromWeights(timeline, e7Of(null), assetRet, rateMap));
  for (const [name, scaleFn] of [['E7基线(0.85恒定)', null],
    ...Object.entries(CAPE_BANDS).map(([n, b]) => [`E7×${n}`, p => capeScaleOf(p, b)])]) {
    const pts = navPathFromWeights(timeline, e7Of(scaleFn), assetRet, rateMap);
    const s = statsFromNav(pts);
    const s10 = statsFromNav(pts.filter(p => p.month >= '2010-01'));
    const fullYears = [...s.yearly].filter(([y]) => s.yearMonths.get(y) === 12);
    const worst = fullYears.reduce((a, b) => (b[1] < a[1] ? b : a), ['—', Infinity]);
    e7Rows.push({
      变体: name,
      全期年化: f1(s.cagrPct) + '%', 最大回撤: f1(s.mddPct) + '%',
      '2010起年化': f1(s10.cagrPct) + '%',
      最差单年: `${worst[0]} ${f1(worst[1])}%`,
      '2008年': f1(s.yearly.get('2008')) + '%', '2021年': f1(s.yearly.get('2021')) + '%',
      '2022年': f1(s.yearly.get('2022')) + '%',
      '年化差(vs基线)': f1(s.cagrPct - e7Base.cagrPct) + 'pp',
    });
  }
  console.log('\n===== ① E7 一次性投入 × CAPE缩放（月末按上月档位+上月CAPE分位调仓） =====');
  console.table(e7Rows);

  // ===== ② S5a 月度 × CAPE =====
  const s5Rows = [];
  let s5Base = null;
  for (const [name, scaleFn] of [['S5a基线(动作月满仓)', null],
    ...Object.entries(CAPE_BANDS).map(([n, b]) => [`S5a×${n}`, p => capeScaleOf(p, b)])]) {
    const targetWeightOf = scaleFn ? (month => scaleFn(capeMap.get(month) ?? null)) : null;
    const r = simulateS5(timeline, px, rateMap, 1, { targetWeightOf });
    const s = dcaStats(r.points);
    const tw = statsFromNav(r.twr);
    const fullYears = [...tw.yearly].filter(([y]) => tw.yearMonths.get(y) === 12);
    const worst = fullYears.reduce((a, b) => (b[1] < a[1] ? b : a), ['—', Infinity]);
    if (!s5Base) s5Base = s;
    s5Rows.push({
      变体: name,
      期末市值: money(s.endValue), XIRR: f1(s.xirrPct) + '%',
      'XIRR差(vs基线)': f1(s.xirrPct - s5Base.xirrPct) + 'pp',
      市值最大回撤: f1(s.valueMddPct) + '%', 最大浮亏: f1(s.minValueToInvestedPct) + '%',
      '最差单年(TWR)': `${worst[0]} ${f1(worst[1])}%`,
      '2008年': f1(tw.yearly.get('2008')) + '%', '2022年': f1(tw.yearly.get('2022')) + '%',
      交易: `买${r.trades.buys}/卖${r.trades.sells}`,
    });
  }
  console.log('\n===== ② S5a 月度定投 × CAPE缩放（存量+新钱择时；动作月再平衡到目标仓位） =====');
  console.table(s5Rows);

  // ===== ③ S5a 日度 T+0 × CAPE（"2022年-59.4%"口径） =====
  const days = buildS5Days(recs, tqqqDaily);
  const s5dRows = [];
  let s5dBase = null;
  for (const [name, scaleFn] of [['日度S5a T+0基线', null],
    ...Object.entries(CAPE_BANDS).map(([n, b]) => [`日度S5a×${n}`, p => capeScaleOf(p, b)])]) {
    const targetOf = scaleFn ? (month => scaleFn(capeMap.get(month) ?? null)) : null;
    const r = simulateS5Daily(days, 1, { targetOf });
    const s = dcaStats(r.monthPoints.map(p => ({ month: p.month, value: p.value, invested: p.invested })));
    const ext = dailyPathExtremes(r.dailyPoints);
    const y = yr => (r.yearFactors.has(yr) ? (r.yearFactors.get(yr) - 1) * 100 : null);
    const worstY = [...r.yearFactors].map(([yr, f]) => [yr, (f - 1) * 100])
      .filter(([yr]) => yr > '2000' && yr < '2026')
      .reduce((a, b) => (b[1] < a[1] ? b : a), ['—', Infinity]);
    if (!s5dBase) s5dBase = s;
    s5dRows.push({
      变体: name,
      期末市值: money(s.endValue), XIRR: f1(s.xirrPct) + '%',
      'XIRR差(vs基线)': f1(s.xirrPct - s5dBase.xirrPct) + 'pp',
      '最大浮亏(日度盯市)': f1(ext.minValueToInvestedPct) + '%',
      市值回撤: f1(ext.valueMddPct) + '%',
      最差单年: `${worstY[0]} ${f1(worstY[1])}%`,
      '2008年': f1(y('2008')) + '%', '2021年': f1(y('2021')) + '%', '2022年': f1(y('2022')) + '%',
      往返: r.episodes.length, 交易: `买${r.trades.buys}/卖${r.trades.sells}`,
    });
  }
  console.log('\n===== ③ S5a 日度 T+0 × CAPE缩放（2022年-59.4%基线口径；动作日再平衡到目标） =====');
  console.table(s5dRows);

  // ===== 决策标准检查 =====
  console.log('\n===== 决策标准（任务书）：S5全期XIRR降幅≤1pp 前提下最差年/回撤显著改善 =====');
  const num = r => parseFloat(r.XIRR);
  for (const rows of [s5Rows, s5dRows]) {
    const b = rows[0];
    for (const r of rows.slice(1)) {
      const drop = num(b) - num(r);
      console.log(`${r.变体}: XIRR ${b.XIRR}→${r.XIRR}（降${f1(drop)}pp${drop <= 1 ? '，≤1pp约束内' : '，>1pp 打穿约束'}）` +
        `｜2022 ${b['2022年']}→${r['2022年']}｜最差年 ${b['最差单年(TWR)'] ?? b.最差单年}→${r['最差单年(TWR)'] ?? r.最差单年}`);
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(err => { console.error('[cape-scaling] failed:', err); process.exit(1); });
}
