// 准确率成绩单（2026-07-18）：把"美股进攻/防守节点判断准确率"定义成可度量指标，
// 输出 ①成绩单（召回/精确/月度混淆矩阵/踏空成本） ②错误清单逐一归因 ③针对性改进变体对照（--variants）
// 用法：node backtest/accuracy-report.mjs             → ①+②
//       node backtest/accuracy-report.mjs --variants  → 追加 ③（X系变体，默认全关，不动 VARIANTS_DEFAULT）
// 只读复用 run-backtest.js 的数据加载与重放；FRED 本地缓存可用，重复运行不打爆限流
import { basename } from 'path';
import { loadData, runReplay, evaluate, VARIANTS_DEFAULT } from './run-backtest.js';

// ---------- 纯函数（backend/tests/accuracy-report.test.js 覆盖） ----------

/** 连续 defense 片段切分：end = 恢复非防守的月份（不含该月），在续段 end=null */
export function episodesOf(timeline) {
  const eps = [];
  let cur = null;
  for (const t of timeline) {
    if (t.final === 'defense') {
      if (!cur) cur = { start: t.month, months: [] };
      cur.months.push(t);
    } else if (cur) {
      cur.end = t.month;
      eps.push(cur);
      cur = null;
    }
  }
  if (cur) { cur.end = null; eps.push(cur); }
  return eps;
}

/**
 * 未来 h 个月内（不含当月）月末价最大回撤（%）：min(spx[i+1..i+h]) / spx[i] − 1
 * 数组末端不足 h 个月时用可得部分；无任何未来有效点 → null（该月不参与混淆矩阵）
 */
export function futureDrawdownPct(spxValues, i, horizonMonths) {
  const base = spxValues[i];
  if (base === null || base === undefined || isNaN(base)) return null;
  const fut = spxValues.slice(i + 1, i + 1 + horizonMonths).filter(v => v !== null && v !== undefined && !isNaN(v));
  if (!fut.length) return null;
  return (Math.min(...fut) / base - 1) * 100;
}

/** 混淆矩阵统计：pairs = [{actual:boolean, predicted:boolean}] */
export function confusionStats(pairs) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const { actual, predicted } of pairs) {
    if (actual && predicted) tp++;
    else if (!actual && predicted) fp++;
    else if (actual && !predicted) fn++;
    else tn++;
  }
  const total = tp + fp + fn + tn;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? 2 * precision * recall / (precision + recall) : null;
  return { tp, fp, fn, tn, total, accuracy: total ? (tp + tn) / total : null, precision, recall, f1 };
}

/**
 * 月度混淆矩阵配对：actual = 未来 horizon 月内回撤 ≤ −thresholdPct；predicted = 当月档位为 defense。
 * 末尾不足 horizon 个月的月份剔除（真实标签未知，不能硬贴）；spx 缺失月剔除
 */
export function buildConfusionPairs(timeline, horizonMonths, thresholdPct) {
  const spxValues = timeline.map(t => t.spx);
  const pairs = [];
  for (let i = 0; i < timeline.length - horizonMonths; i++) {
    if (spxValues[i] === null || spxValues[i] === undefined) continue;
    const dd = futureDrawdownPct(spxValues, i, horizonMonths);
    if (dd === null) continue;
    pairs.push({ month: timeline[i].month, actual: dd <= -thresholdPct, predicted: timeline[i].final === 'defense' });
  }
  return pairs;
}

/** >15% 危机的 [顶部月, 底部月] 区间（片段重叠口径判定用） */
export function crisisSpansOf(crisisRows, minDrawdownPct = 15) {
  return crisisRows
    .filter(c => c.drawdownPct !== null && c.drawdownPct <= -minDrawdownPct && c.peakDate !== '数据缺失')
    .map(c => ({ name: c.name, start: c.peakDate.slice(0, 7), end: c.troughDate.slice(0, 7) }));
}

/**
 * 片段真假双口径：
 *  strict —— 起始月起 13 个采样点内最低月末价较起始月末价跌幅 >15%（evaluate 同口径）
 *  overlap —— 片段月份与任一 >15% 危机的 [顶部月, 底部月] 相交（"世界当时确实在危机里，只是信号晚了"）
 */
export function episodeVerdict(ep, timeline, idxOfMonth, crisisSpans) {
  const i0 = idxOfMonth.get(ep.start);
  const horizon = timeline.slice(i0, i0 + 13).map(t => t.spx).filter(v => v !== null && v !== undefined && !isNaN(v));
  const startPx = timeline[i0]?.spx;
  const maxDD12 = startPx && horizon.length ? (Math.min(...horizon) / startPx - 1) * 100 : null;
  const lastMonth = ep.months[ep.months.length - 1].month;
  const overlap = crisisSpans.find(s => ep.start <= s.end && lastMonth >= s.start) ?? null;
  return { maxDD12, strictTrue: maxDD12 !== null && maxDD12 <= -15, overlapCrisis: overlap?.name ?? null };
}

// ---------- 展示辅助 ----------

const f1d = v => v === null || v === undefined || isNaN(v) ? '—' : v.toFixed(1);
const pct = v => v === null ? '—' : (v * 100).toFixed(1) + '%';
const trigLabel = t => {
  const locks = [t.sahmLockActive && '萨姆锁', t.reactiveLockActive && '应对锁'].filter(Boolean);
  const dims = [t.monetary === 'tight' && '货币', t.fiscal === 'tight' && '财政', t.admin === 'tight' && '行政'].filter(Boolean);
  if (locks.length) return locks.join('+') + (dims.length >= 2 ? `(+树:${dims.join('+')})` : '');
  return dims.join('+') || '?';
};

function printScorecard(D, timeline, summary) {
  const { crisisRows } = summary;
  console.log('\n════════ ① 成绩单：防守节点判断准确率（2000-01~至今，基线 V3+V4+W5+X1+X3，2026-07-18 定稿） ════════');

  // -- 召回 --
  console.log('\n--- 召回率：6场已知危机的捕获情况 ---');
  console.table(crisisRows.map(c => ({
    危机: c.name,
    最大回撤: f1d(c.drawdownPct) + '%',
    首次防守: c.firstDefMonth ?? '未触发',
    时机: c.leadDays === null ? '—' : c.leadDays > 0 ? `提前${c.leadDays}天` : `滞后${-c.leadDays}天`,
    '踏空/已回落': c.missedKind === 'preTop' ? `信号后再涨+${f1d(c.missedPct)}%见顶` : c.missedKind === 'postTop' ? `已回落${f1d(c.missedPct)}%` : '—',
    防守覆盖: c.coveragePct === null ? '—' : f1d(c.coveragePct) + '%',
    相对买持少亏: c.savedPct === null ? '—' : (c.savedPct >= 0 ? '+' : '') + f1d(c.savedPct) + 'pp',
    触发: c.lockTypes,
  })));
  const bigCrises = crisisRows.filter(c => c.drawdownPct !== null && c.drawdownPct <= -15);
  const caughtBig = bigCrises.filter(c => c.firstDefMonth).length;
  console.log(`召回率：清单口径 ${crisisRows.filter(c => c.firstDefMonth).length}/${crisisRows.length}（用户6场清单）；`
    + `>15%危机线口径 ${caughtBig}/${bigCrises.length} = ${(caughtBig / bigCrises.length * 100).toFixed(1)}%`
    + `（2026美伊战争最大回撤-8.9%未达危机线，系统全程"减仓观望"应对，见②归因）`);

  // -- 片段精确率 --
  const eps = episodesOf(timeline);
  const idxOf = new Map(timeline.map((t, i) => [t.month, i]));
  const spans = crisisSpansOf(crisisRows);
  const verdicts = eps.map(e => ({ ep: e, v: episodeVerdict(e, timeline, idxOf, spans) }));
  const strictTP = verdicts.filter(x => x.v.strictTrue).length;
  const overlapTP = verdicts.filter(x => x.v.overlapCrisis).length;
  console.log('\n--- 精确率：全部防守片段的真假判定（双口径） ---');
  console.table(verdicts.map(({ ep, v }) => ({
    片段: `${ep.start}~${ep.end ?? '在续'}`, 月数: ep.months.length,
    触发: trigLabel(ep.months[0]),
    '信号起12月内最大回撤': f1d(v.maxDD12) + '%',
    '严格口径(>15%跟随)': v.strictTrue ? '真' : '假',
    危机重叠口径: v.overlapCrisis ? `真(${v.overlapCrisis.slice(0, 7)})` : '纯误报',
  })));
  console.log(`精确率：严格口径 ${strictTP}/${eps.length} = ${(strictTP / eps.length * 100).toFixed(1)}%`
    + `（信号发出后又跌>15%才算真——晚到的正确信号也记假）；`
    + `危机重叠口径 ${overlapTP}/${eps.length} = ${(overlapTP / eps.length * 100).toFixed(1)}%`
    + `（防守期间世界确实处于>15%危机中）；纯误报 ${eps.length - overlapTP} 段`);

  // -- 月度混淆矩阵 --
  console.log('\n--- 月度混淆矩阵：真实标签"该防守"=未来h月内回撤超阈值 vs 系统档位=defense ---');
  const matrixDefs = [
    ['未来1月 跌>5%', 1, 5], ['未来3月 跌>10%', 3, 10], ['未来6月 跌>15%', 6, 15], ['未来6月 跌>10%', 6, 10],
  ];
  console.table(matrixDefs.map(([label, h, th]) => {
    const s = confusionStats(buildConfusionPairs(timeline, h, th));
    return {
      口径: label, 该防守月: s.tp + s.fn, 防守命中TP: s.tp, 误报FP: s.fp, 漏报FN: s.fn, 正确观望TN: s.tn,
      准确率: pct(s.accuracy), 精确率: pct(s.precision), 召回率: pct(s.recall), F1: s.f1 === null ? '—' : s.f1.toFixed(2),
    };
  }));

  // -- 踏空成本与躲跌收益 --
  let defDown = 0, defRets = [], nonDefRets = [];
  for (let i = 1; i < timeline.length; i++) {
    const a = timeline[i - 1], b = timeline[i];
    if (a.spx === null || b.spx === null) continue;
    const ret = (b.spx / a.spx - 1) * 100;
    if (a.final === 'defense') { defRets.push(ret); if (ret < 0) defDown++; }
    else nonDefRets.push(ret);
  }
  const avg = arr => arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null;
  console.log('\n--- 踏空成本与躲跌收益 ---');
  console.log(`防守曝险月 ${defRets.length} 个：其中市场实际下跌 ${defDown} 个月（${(defDown / defRets.length * 100).toFixed(1)}%——即防守月里${(100 - defDown / defRets.length * 100).toFixed(1)}%的月份在踏空上涨）`);
  console.log(`防守月均SPY收益 ${f1d(avg(defRets))}% vs 非防守月均 ${f1d(avg(nonDefRets))}%（防守月均为${avg(defRets) < 0 ? '负' : '正'}，方向选择${avg(defRets) < avg(nonDefRets) ? '正确' : '存疑'}）`);

  // -- 进攻端如实说明 --
  const attackMonths = timeline.filter(t => t.final === 'attack').length;
  console.log('\n--- 进攻端（如实说明） ---');
  console.log(`attack 档历史出现 ${attackMonths} 次：AI供需维历史数据缺席（AI主题2015年前不存在），回放中恒为观望，`
    + `进攻档（需AI宽松+政策三维零收紧）结构性无法触发——进攻节点准确率无法回测度量，属数据边界而非规则缺陷。`);
  console.log(`只能度量"非防守=可持仓"的判断质量：非防守月均收益 ${f1d(avg(nonDefRets))}%/月（年化约${f1d((Math.pow(1 + avg(nonDefRets) / 100, 12) - 1) * 100)}%），见上方混淆矩阵TN列。`);
  return { verdicts, eps };
}

function printAttribution(D, timeline, summary, verdicts) {
  console.log('\n════════ ② 错误清单逐一归因 ════════');
  const m = mo => timeline.find(t => t.month === mo);
  const showWindow = (s, e, note) => {
    console.log(`\n${note}`);
    console.table(timeline.filter(t => t.month >= s && t.month <= e).map(t => ({
      月份: t.month, 档位: t.final, 货币: t.monetary, 财政: t.fiscal, 行政: t.admin,
      'Δ利率bp': t.rateDiffBp ?? '—', 财政实际同比: f1d(t.metrics?.fiscalPct) + '%',
      EPU分位: f1d(t.metrics?.epuPct), 油价环比: f1d(t.metrics?.oilPct) + '%',
      萨姆: t.metrics?.sahm ?? '—',
      锁: [t.sahmLockActive && '萨姆', t.reactiveLockActive && '应对'].filter(Boolean).join('+') || '—',
    })));
  };

  // A. 纯误报段
  const pureFps = verdicts.filter(x => !x.v.overlapCrisis);
  console.log(`\n【A】${pureFps.length}段纯误报（危机重叠口径下真正的假阳性）：`);
  for (const { ep, v } of pureFps) {
    const t0 = ep.months[0];
    console.log(`  ${ep.start}~${ep.end ?? '在续'}（${ep.months.length}月）触发=${trigLabel(t0)}｜`
      + `当月值：Δ利率${t0.rateDiffBp}bp 财政${f1d(t0.metrics?.fiscalPct)}% EPU${f1d(t0.metrics?.epuPct)}分位 萨姆${t0.metrics?.sahm ?? '—'}｜12月内最大回撤${f1d(v.maxDD12)}%`);
  }
  showWindow('2004-07', '2004-10', 'A1. 2004-08~10【X3采纳后已消除】：采纳前是"货币+财政"两维共振防守段——加息周期(+25bp/月)判货币tight + 财政TTM同比5.4%擦线过+5%阈值的纯噪声（EPU仅6.7分位，世界毫无危险，12月内回撤0.0%）。X3(2026-07-18)将纯"货币+财政"共振降级reduce，下表为采纳后档位：');
  showWindow('2018-10', '2019-03', 'A2. 2018-12~19-02【保留】：2018-12月末信号，而2018Q4已盘中跌-19.4%且12-24见底——货币(12月加息)+行政(贸易战EPU高位)共振。人肉复盘当时同样会判危险（世界确实危险），错在信号滞后到底部才发出，只吃到反弹踏空。含行政维的共振不在X3口径内，如实保留：');
  showWindow('2024-07', '2025-01', 'A3. 2024年萨姆锁段【X1采纳后 4月→3月】（详见【D】）：');

  // B. 漏掉的2026美伊战争
  const c26 = summary.crisisRows.find(r => r.name.includes('2026'));
  showWindow('2025-11', '2026-06', `【B】2026美伊战争（顶${c26.peakDate}→底${c26.troughDate}，最大回撤${f1d(c26.drawdownPct)}%）未触发defense——全程reduce（行政维EPU高位单维收紧）。差的第二票：货币在降息周期（Δ利率≤0，按规则=宽松，方向没错）；财政实际同比在±5%带内；油价未见±20%冲击。-8.9%未达>15%危机线，系统"减仓观望"是设计内的正确分级应对；它进6场清单是因为用户把已知事件都列入，不代表系统该全防：`);

  // C. 滞后的2000与2022
  const c00 = summary.crisisRows.find(r => r.name.includes('2000'));
  const c22 = summary.crisisRows.find(r => r.name.includes('2022'));
  showWindow('2000-01', '2000-05', `【C1】2000滞后${-c00.leadDays}天（顶${c00.peakDate}→首防${c00.firstDefMonth}，期间已回落${f1d(c00.missedPct)}%）。2000-02起货币单维tight=reduce已减仓；第二票缺席：EPU处低分位（贸易政策平静）、财政中性。5月+50bp应对锁才凑成defense。月度口径无解——没有第二个维度在顶部前收紧：`);
  showWindow('2021-12', '2022-05', `【C2】2022滞后${-c22.leadDays}天（顶${c22.peakDate}→首防${c22.firstDefMonth}，期间已回落${f1d(c22.missedPct)}%）。顶部在首次加息(2022-03)前2.5个月——货币维按定义还在宽松，财政/行政也全宽松，四维无一收紧，结构性抓不到"预期驱动的顶"。2022-04月度差分0bp判宽松是口径伪影（线上决议方向口径会保持tight），但即使修正也只是单维reduce，首防月不变（--variants X2 实测验证）：`);

  // D. 2024-08萨姆锁
  const seg24 = timeline.filter(t => t.month >= '2024-08' && t.month <= '2025-02');
  const defCount24 = seg24.filter(t => t.final === 'defense').length;
  const oldBase = runReplay(D, {
    ...VARIANTS_DEFAULT, trendReentry: false, sahmLockTrendReentry: false, defenseNeedsAdminOrLock: false,
  });
  const defCount24Old = oldBase.filter(t => t.month >= '2024-08' && t.month <= '2025-12' && t.final === 'defense').length;
  console.log(`\n【D】2024-08萨姆锁误触发：W5前(V3+V4旧基线)该段防守 ${defCount24Old} 个月（归因记录的最大单段元凶-17.3pp），`
    + `W5后剩4个月，X1采纳后剩 ${defCount24} 个月。`);
  console.log(`  萨姆值（当前修订版，asOf=M-1可见）：2024-06=0.43 → 07=0.53 → 08=0.57 → 09=0.50 → 10=0.43。`
    + `实时初值2024-07同样≥0.5——不是数据修订问题，是规则如实执行：萨姆规则自1970年以来首次假阳性`
    + `（移民扩张劳动供给推高失业率，而非需求崩塌）。叠加2024-09美联储-50bp"校准式降息"又触发应对锁续命，`
    + `直到2024-11小幅降息(-25bp)满足锁存期后解锁+V4迟滞1个月尾巴。`);
  console.log(`  X1已采纳（2026-07-18）：萨姆锁驱动defense也过10月SMA趋势门（2024-08~11市场全程在SMA上方，`
    + `而2001/2008/2020真触发时均已跌破趋势线），2024-08已降级reduce。剩余3个月(09~11)由-50bp应对锁+V4尾巴`
    + `驱动——应对锁豁免趋势门是保2007-09顶前入场的代价（X1b实测：应对锁也过门则08少亏58.1→50.7pp），`
    + `2007-09与2024-09在特征空间完全同构（50bp降息+市场新高），不可安全消除，属100%准确率的结构性反例。`);
}

// ---------- ③ 针对性变体对照（--variants） ----------

function variantRow(name, D, variants) {
  const tl = runReplay(D, variants);
  const s = evaluate(D, tl);
  const c = key => s.crisisRows.find(r => r.name.startsWith(key));
  const c08 = c('2008');
  const recall = s.crisisRows.filter(r => r.firstDefMonth).length;
  const eps = episodesOf(tl);
  const idxOf = new Map(tl.map((t, i) => [t.month, i]));
  const spans = crisisSpansOf(s.crisisRows);
  const pure = eps.filter(e => !episodeVerdict(e, tl, idxOf, spans).overlapCrisis).length;
  const def24 = tl.filter(t => t.month >= '2024-08' && t.month <= '2025-06' && t.final === 'defense').length;
  const firstDef22 = tl.find(t => t.month >= '2021-06' && t.month <= '2023-01' && t.final === 'defense')?.month ?? '未触发';
  // 硬约束：召回≥5/6、2008覆盖≥90%、全期年化≥12.0%
  const pass = recall >= 5 && (c08?.coveragePct ?? 0) >= 90 && s.overall.stratCagr >= 12.0;
  return {
    组合: name,
    年化: s.overall.stratCagr.toFixed(2) + '%', 回撤: s.overall.stratMdd.toFixed(1) + '%',
    防守月: s.defMonths, 召回: `${recall}/6`,
    '08覆盖/少亏': `${f1d(c08?.coveragePct)}%/${f1d(c08?.savedPct)}pp`,
    '假阳性(严格)': `${s.falsePositives}/${s.episodes}`, 纯误报段: pure,
    '24段防守月': def24, '22首防': firstDef22,
    硬约束: pass ? '过' : '✗',
  };
}

export function runVariantEval(D) {
  console.log('\n════════ ③ X系变体对照（2026-07-18 采纳 X1+X3；硬约束=召回≥5/6·08覆盖≥90%·年化≥12.0%） ════════');
  const B = VARIANTS_DEFAULT; // 现基线已含 X1+X3
  const OLD = { ...B, sahmLockTrendReentry: false, defenseNeedsAdminOrLock: false }; // 采纳前旧基线
  const rows = [
    variantRow('现基线(V3+V4+W5+X1+X3)【已采纳】', D, B),
    variantRow('旧基线(V3+V4+W5)', D, OLD),
    variantRow('仅X1(旧基线+萨姆锁趋势门)', D, { ...OLD, sahmLockTrendReentry: true }),
    variantRow('仅X3(旧基线+防守须行政或锁)', D, { ...OLD, defenseNeedsAdminOrLock: true }),
    variantRow('X1b 全部锁过趋势门【否决】', D, { ...B, lockTrendReentry: true }),
    variantRow('X2 货币决议方向口径【否决】', D, { ...B, monetaryCarryDir: true }),
    variantRow('X4 萨姆确认2月【否决】', D, { ...B, sahmConfirmMonths: 2 }),
  ];
  console.table(rows);
  console.log('X1【采纳】: W5趋势门扩展到萨姆锁驱动defense（应对锁仍豁免）——2024-08误触发定向修正，线上 applyTrendReentry 同步');
  console.log('X3【采纳】: 纯"货币+财政"共振降reduce（最窄口径：恰两维tight且为货币+财政）——2004-08型假阳性定向修正，线上 calcFinalSignal 内置');
  console.log('X1b【否决】: 应对锁也过趋势门会砸掉2007-09顶前入场（08少亏58.1→50.7pp）——2007-09与2024-09特征同构，不可两全');
  console.log('X2【否决】: 月度差分0bp时沿用上月货币方向（决议方向口径上界）——实测全期差≤0.1pp/年且2022首防月不变，证明月度回测未系统性偏估线上');
  console.log('X4【否决】: 萨姆锁连续2月≥0.5——锁存延迟拖累2008-09入场（08覆盖94.4→88.9%打穿硬约束），对2024只延迟1个月');
}

async function main() {
  const D = await loadData();
  const timeline = runReplay(D, VARIANTS_DEFAULT);
  const summary = evaluate(D, timeline);
  const { verdicts } = printScorecard(D, timeline, summary);
  printAttribution(D, timeline, summary, verdicts);
  if (process.argv.includes('--variants')) runVariantEval(D);
}

// 直接运行时执行（被 import/测试加载时只导出纯函数，不触发数据拉取）
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  main().catch(e => { console.error('[accuracy-report] failed:', e.message); process.exit(1); });
}
