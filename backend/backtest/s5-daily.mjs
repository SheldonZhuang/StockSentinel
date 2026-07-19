// S5 日度粒度精化（96号）：把用户选中的 S5a（defense清仓TQQQ→出defense买回、新钱月末定投）
// 从月度采样搬到日度档位时间线上执行，测真实执行时点下的 XIRR/浮亏/往返，并量化：
//   ① 日度信号翻转更多是否让 S5 往返显著变多变贵（V4 30天降档确认的保护作用）
//   ② 执行时点敏感性：信号日收盘（T+0）vs 次日收盘（T+1，用户收邮件次日交易的真实预期）
//   ③ 2022 快熊：日度首防 2022-03-23（vs 月度 5 月末）对 S5 2022 年收益的改善
// 运行：node backend/backtest/s5-daily.mjs（repo 根或 backend 目录均可）
// 只读复用 daily-replay / run-backtest / dca-schemes / tqqq-schemes 导出，不改任何既有脚本默认行为。
// 口径：信号=日度重放（O1 油价水平护栏已默认，与线上一致）；TQQQ=合成日线（同 dca-schemes 参数
// beta3/ffr-2/费率0.86%，Tiingo QQQ 总回报驱动）；XIRR=月度现金流资金加权（与月度 S5a 同口径可比）；
// 浮亏/回撤给"日度盯市"与"月末采样"双口径——月度成绩单的 -8.8% 浮亏本身有月末采样美化。
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { loadDailyData, runDailyReplay } from './daily-replay.mjs';
import { runReplay, VARIANTS_DEFAULT } from './run-backtest.js';
import { simulateS5, dcaStats } from './dca-schemes.mjs';
import { synthDailyCustom, statsFromNav, loadQqqBars } from './tqqq-schemes.mjs';
import { monthlyCloseMap } from './execution-layer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.join(__dirname, '../.env') });

const S5_START = '2000-01-01';
const S5_END = '2026-06-30';

// ---------- 纯函数（backend/tests/s5-daily.test.js 覆盖） ----------

const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * 日度档位时间线 → S5 输入天序列。px 用"最近可得收盘"承接（合成TQQQ与SPY交易日历一致，
 * 缺日仅防御性兜底）；isMonthEnd = 该月最后一个交易日（月末定投执行日）
 * @param {Array} recs - daily-replay 记录（date/final/sahmLockActive/reactiveLockActive/metrics.rate）
 * @param {Array<{date,close}>} tqqqBars - 合成TQQQ日线（升序）
 * @param {string} tierKey - 'final'（生效档）或 'rawFinal'（无V4迟滞对照）
 * @param {Array<{date,close}>|null} qqqBars - QQQ(1x)日线（N2 reduce期买QQQ用），可缺省
 */
export function buildS5Days(recs, tqqqBars, tierKey = 'final', qqqBars = null) {
  const days = [];
  let pi = -1, qi = -1;
  recs.forEach((r, i) => {
    while (pi + 1 < tqqqBars.length && tqqqBars[pi + 1].date <= r.date) pi++;
    if (pi < 0) throw new Error(`合成TQQQ 无 ${r.date} 前的收盘`);
    if (qqqBars) while (qi + 1 < qqqBars.length && qqqBars[qi + 1].date <= r.date) qi++;
    const isMonthEnd = i === recs.length - 1 || recs[i + 1].date.slice(0, 7) !== r.date.slice(0, 7);
    days.push({
      date: r.date, px: tqqqBars[pi].close, tier: r[tierKey],
      pxQqq: qqqBars && qi >= 0 ? qqqBars[qi].close : null,
      rate: r.metrics.rate ?? 0, isMonthEnd,
      trigger: r.sahmLockActive ? '萨姆锁' : r.reactiveLockActive ? '应对式锁' : '决策树共振',
    });
  });
  return days;
}

/**
 * 日度 S5a 状态机（与月度 simulateS5 基准参数同语义，粒度换日）：
 *  - 档位进入 defense：当日收盘（execLagDays=0）或次日收盘（=1）卖出全部 TQQQ 入储备（计FFR日息）
 *  - 退出 defense（到任意非defense档，同 S5a buybackOnReduce）：同滞后规则全额买回储备
 *  - 新钱：每月最后一个交易日投入 C——当日档位 attack/neutral → 买入并顺带部署储备
 *    （买回待执行时不抢跑，储备留给买回日）；reduce/defense → 入储备
 *  - targetOf（R3 CAPE仓位缩放，2026-07-19 评估，默认null=行为逐位一致）：(month)=>目标TQQQ权重。
 *    动作日（买回执行日/月末买入日）把TQQQ再平衡到 target×组合——超配侧卖回储备，
 *    不足侧从储备补足；非动作日不交易（与月度 simulateS5.targetWeightOf 同语义）
 *  - newMoneyMode（B系新钱规则，2026-07-19 评估，存量规则不动）：reduce 月末新钱去向——
 *    'reserve'（现行S5a）入储备 | 'always'（N1）照买TQQQ | 'qqq'（N2）买QQQ(1x)，
 *    恢复 neutral/attack 当日QQQ换TQQQ、进defense随存量一起清仓 | 'half'（N3）半额TQQQ半额储备。
 *    注：targetOf 的再平衡只作用于 TQQQ+储备（N2 的QQQ腿不参与），'qqq'+targetOf 组合未定义、不评估
 * @returns {{dailyPoints, monthPoints, episodes, yearFactors, trades, missedMonthEnds}}
 *  episodes: [{signalDate,trigger,sellDate,sellPx,buyDate,buyPx,tqqqChangePct,waitDays}]
 */
export function simulateS5Daily(days, C = 1, { execLagDays = 0, targetOf = null, newMoneyMode = 'reserve' } = {}) {
  let tqqqU = 0, qqqU = 0, reserve = 0, invested = 0, prevV = null;
  let openEp = null;   // 已卖出、待买回的往返
  const pending = [];  // 待执行动作 {execIdx, type:'sell'|'buyback'|'convert', signalDate, trigger}
  const episodes = [], dailyPoints = [], monthPoints = [];
  const yearFactors = new Map();
  let sells = 0, buys = 0, missedMonthEnds = 0;
  const isBuy = t => t === 'attack' || t === 'neutral';
  // R3：动作日再平衡到目标权重（w=1 时买入分支 = 全额部署，与默认路径数值等价）
  const rebalanceToTarget = (d) => {
    const w = Math.min(1, Math.max(0, targetOf(d.date.slice(0, 7)) ?? 1));
    const total = tqqqU * d.px + reserve;
    const desired = w * total, cur = tqqqU * d.px;
    if (cur < desired - 1e-9) {
      const buy = Math.min(reserve, desired - cur);
      if (buy > 0) { tqqqU += buy / d.px; reserve -= buy; buys++; }
    } else if (cur > desired + 1e-9) {
      const sell = cur - desired;
      tqqqU -= sell / d.px; reserve += sell; sells++;
    }
  };

  days.forEach((d, i) => {
    if (i > 0) reserve *= 1 + ((days[i - 1].rate ?? 0) / 100) / 252;
    // 信号转换检测（今日 vs 昨日档位）→ 按执行滞后排程
    if (i > 0) {
      const t = d.tier, pt = days[i - 1].tier;
      if (t === 'defense' && pt !== 'defense') {
        pending.push({ execIdx: i + execLagDays, type: 'sell', signalDate: d.date, trigger: d.trigger });
      } else if (t !== 'defense' && pt === 'defense') {
        pending.push({ execIdx: i + execLagDays, type: 'buyback', signalDate: d.date });
      } else if (newMoneyMode === 'qqq' && isBuy(t) && !isBuy(pt) && pt !== 'defense') {
        pending.push({ execIdx: i + execLagDays, type: 'convert' }); // N2：reduce恢复买入档，QQQ换TQQQ
      }
    }
    // 到期执行（T+0=信号当日收盘；T+1=次日收盘）
    for (let k = 0; k < pending.length; k++) {
      const a = pending[k];
      if (a.execIdx > i) continue;
      pending.splice(k--, 1);
      if (a.type === 'sell') {
        const proceeds = tqqqU * d.px + (qqqU > 0 && d.pxQqq ? qqqU * d.pxQqq : 0);
        if (proceeds > 0) {
          reserve += proceeds; tqqqU = 0; qqqU = 0; sells++;
          openEp = { signalDate: a.signalDate, trigger: a.trigger, sellDate: d.date, sellPx: d.px };
        }
      } else if (a.type === 'convert') {
        if (qqqU > 0 && d.pxQqq) { tqqqU += (qqqU * d.pxQqq) / d.px; qqqU = 0; buys++; }
      } else {
        if (targetOf) rebalanceToTarget(d);
        else if (reserve > 0) { tqqqU += reserve / d.px; reserve = 0; buys++; }
        if (openEp) {
          episodes.push({
            ...openEp, buyDate: d.date, buyPx: d.px,
            tqqqChangePct: (d.px / openEp.sellPx - 1) * 100,
            waitDays: dayDiff(openEp.sellDate, d.date),
          });
          openEp = null;
        }
      }
    }
    // 月末新钱（用户按当日档位操作；买回待执行时储备不抢跑，留给买回日）
    let contribution = 0;
    if (d.isMonthEnd) {
      invested += C;
      contribution = C;
      const isBuyTier = isBuy(d.tier);
      const buybackQueued = openEp !== null || pending.some(a => a.type === 'buyback');
      if (isBuyTier && !buybackQueued) {
        if (targetOf) { reserve += C; rebalanceToTarget(d); }
        else { const amt = C + reserve; tqqqU += amt / d.px; reserve = 0; buys++; }
      } else if (d.tier === 'reduce' && newMoneyMode === 'always') {
        tqqqU += C / d.px; buys++;                         // N1：reduce 新钱照买TQQQ
      } else if (d.tier === 'reduce' && newMoneyMode === 'qqq' && d.pxQqq) {
        qqqU += C / d.pxQqq; buys++;                       // N2：reduce 新钱买QQQ(1x)
      } else if (d.tier === 'reduce' && newMoneyMode === 'half') {
        tqqqU += (C / 2) / d.px; reserve += C / 2; buys++; // N3：半额TQQQ半额储备
      } else {
        reserve += C;
        if (!isBuyTier) missedMonthEnds++;                 // defense/现行reduce：新钱闲置月
      }
    }
    const v = tqqqU * d.px + (qqqU > 0 && d.pxQqq ? qqqU * d.pxQqq : 0) + reserve;
    if (prevV !== null && prevV > 0) {
      const y = d.date.slice(0, 4);
      yearFactors.set(y, (yearFactors.get(y) ?? 1) * ((v - contribution) / prevV));
    }
    prevV = v;
    dailyPoints.push({ date: d.date, value: v, invested });
    if (d.isMonthEnd) monthPoints.push({ month: d.date.slice(0, 7), value: v, invested });
  });
  if (openEp) { // 样本末未买回的开放往返
    const last = days[days.length - 1];
    episodes.push({
      ...openEp, buyDate: null, buyPx: last.px,
      tqqqChangePct: (last.px / openEp.sellPx - 1) * 100,
      waitDays: dayDiff(openEp.sellDate, last.date),
    });
  }
  return { dailyPoints, monthPoints, episodes, yearFactors, trades: { sells, buys }, missedMonthEnds };
}

/** 日度盯市极值：市值最大回撤 + 最大浮亏（市值/累计投入的最低值） */
export function dailyPathExtremes(points) {
  let peak = -Infinity, mdd = 0, minVsInv = Infinity;
  for (const p of points) {
    if (p.value > peak) peak = p.value;
    if (peak > 0) mdd = Math.min(mdd, p.value / peak - 1);
    if (p.invested > 0) minVsInv = Math.min(minVsInv, p.value / p.invested - 1);
  }
  return {
    valueMddPct: mdd * 100,
    minValueToInvestedPct: minVsInv === Infinity ? null : minVsInv * 100,
  };
}

// ---------- 主流程 ----------

const f1 = v => (v === null || v === undefined || isNaN(v) ? '—' : v.toFixed(1));
const money = v => {
  const usd = v * 1000;
  return usd >= 1e6 ? `$${(usd / 1e6).toFixed(2)}M` : `$${Math.round(usd / 1000)}k`;
};
const compEp = arr => (arr.reduce((a, e) => a * (1 + e.tqqqChangePct / 100), 1) - 1) * 100;

function statsRow(name, run) {
  const s = dcaStats(run.monthPoints.map(p => ({ month: p.month, value: p.value, invested: p.invested })));
  const ext = dailyPathExtremes(run.dailyPoints);
  const falseEp = run.episodes.filter(e => e.tqqqChangePct > 0);
  const trueEp = run.episodes.filter(e => e.tqqqChangePct <= 0);
  const y = yr => run.yearFactors.has(yr) ? (run.yearFactors.get(yr) - 1) * 100 : null;
  return {
    row: {
      方案: name,
      期末市值: money(s.endValue),
      XIRR: f1(s.xirrPct) + '%',
      '最大浮亏(日度盯市)': f1(ext.minValueToInvestedPct) + '%',
      '最大浮亏(月末口径)': f1(s.minValueToInvestedPct) + '%',
      市值回撤: f1(ext.valueMddPct) + '%',
      往返: run.episodes.length,
      假信号: `${falseEp.length}次/踏空${f1(compEp(falseEp))}%`,
      真信号: `${trueEp.length}次/躲掉${f1(compEp(trueEp))}%`,
      '2008年': f1(y('2008')) + '%', '2020年': f1(y('2020')) + '%', '2022年': f1(y('2022')) + '%',
    },
    s, ext, falseEp, trueEp,
  };
}

async function main() {
  const { D, DD } = await loadDailyData();
  console.log('[s5-daily] 日度重放（O1默认）+ 月度重放对照 ...');
  const recsO1 = runDailyReplay(DD).filter(r => r.date >= S5_START && r.date <= S5_END);
  const recsNoO1 = runDailyReplay(DD, { oilGuard: null }).filter(r => r.date >= S5_START && r.date <= S5_END);
  const timelineM = runReplay(D, VARIANTS_DEFAULT).filter(t => t.spx !== null);

  const qqqBars = await loadQqqBars();
  const rateOfDate = d => D.rateMap.get(d.slice(0, 7)) ?? 0;
  const tqqqDaily = synthDailyCustom(qqqBars, rateOfDate, { beta: 3, ffrMult: -2, erPct: 0.86 });
  const pxM = { tqqq: monthlyCloseMap(tqqqDaily) };

  // ---- 月度 S5a 对照（应复现执行手册口径：XIRR 37.0%/浮亏-8.8%/7次往返/2022 -59.4%）----
  const mRun = simulateS5(timelineM, pxM, D.rateMap);
  const mStats = dcaStats(mRun.points);
  const mTw = statsFromNav(mRun.twr);
  const mFalse = mRun.episodes.filter(e => e.tqqqChangePct > 0);
  const mTrue = mRun.episodes.filter(e => e.tqqqChangePct <= 0);

  // ---- 日度 S5a 各口径 ----
  const runs = [
    ['日度S5a T+0(信号日收盘)', simulateS5Daily(buildS5Days(recsO1, tqqqDaily), 1)],
    ['日度S5a T+1(次日收盘=收邮件次日交易)', simulateS5Daily(buildS5Days(recsO1, tqqqDaily), 1, { execLagDays: 1 })],
    ['日度S5a T+0·O1护栏关(旧口径衔接)', simulateS5Daily(buildS5Days(recsNoO1, tqqqDaily), 1)],
    ['日度S5a T+0·无V4迟滞(rawFinal对照)', simulateS5Daily(buildS5Days(recsO1, tqqqDaily, 'rawFinal'), 1)],
  ];
  const rows = [{
    方案: '月度S5a(现执行手册口径)',
    期末市值: money(mStats.endValue), XIRR: f1(mStats.xirrPct) + '%',
    '最大浮亏(日度盯市)': '—(月度无日内)', '最大浮亏(月末口径)': f1(mStats.minValueToInvestedPct) + '%',
    市值回撤: f1(mStats.valueMddPct) + '%(月末)',
    往返: mRun.episodes.length,
    假信号: `${mFalse.length}次/踏空${f1(compEp(mFalse))}%`,
    真信号: `${mTrue.length}次/躲掉${f1(compEp(mTrue))}%`,
    '2008年': f1(mTw.yearly.get('2008')) + '%', '2020年': f1(mTw.yearly.get('2020')) + '%', '2022年': f1(mTw.yearly.get('2022')) + '%',
  }];
  const details = new Map();
  for (const [name, run] of runs) {
    const r = statsRow(name, run);
    rows.push(r.row);
    details.set(name, { run, ...r });
  }
  console.log(`\n═════ S5a 月度 vs 日度（每月末定投$1000，${timelineM[0].month}~${timelineM[timelineM.length - 1].month}）═════`);
  console.table(rows);

  // ---- 往返清单（T+0，执行手册新清单）----
  const t0 = details.get('日度S5a T+0(信号日收盘)');
  console.log('\n----- 日度 S5a T+0 全部往返清单（执行手册用；期间涨跌>0=假信号踏空） -----');
  console.table(t0.run.episodes.map(e => ({
    卖出日: e.sellDate, 触发: e.trigger,
    买回日: e.buyDate ?? '样本末未买回',
    持币天数: e.waitDays,
    '期间TQQQ涨跌': f1(e.tqqqChangePct) + '%',
    判定: e.tqqqChangePct > 0 ? '假信号(踏空)' : '真信号(躲掉)',
  })));
  console.log('月度S5a旧清单对照（卖出月→买回月）：');
  for (const e of mRun.episodes) {
    console.log(`  ${e.sellMonth} → ${e.buyMonth ?? '未买回'}（${e.waitMonths}个月，TQQQ ${f1(e.tqqqChangePct)}%，${e.tqqqChangePct > 0 ? '假' : '真'}）`);
  }

  // ---- 执行时点敏感性：T+0 vs T+1 逐笔滑点 ----
  const t1 = details.get('日度S5a T+1(次日收盘=收邮件次日交易)');
  console.log('\n----- 执行时点敏感性（T+1 相对 T+0 的逐笔执行价差；卖出为负=次日卖得更低） -----');
  const t1BySignal = new Map(t1.run.episodes.map(e => [e.signalDate, e]));
  const slips = [];
  for (const e0 of t0.run.episodes) {
    const e1 = t1BySignal.get(e0.signalDate);
    if (!e1) continue;
    slips.push({
      卖出日: e0.sellDate,
      卖出滑点: f1((e1.sellPx / e0.sellPx - 1) * 100) + '%',
      买回滑点: e0.buyDate && e1.buyDate ? f1((e1.buyPx / e0.buyPx - 1) * 100) + '%' : '—',
    });
  }
  console.table(slips);
  const num = s => parseFloat(s);
  const sellSlips = slips.map(s => num(s.卖出滑点)).filter(v => !isNaN(v));
  const buySlips = slips.map(s => num(s.买回滑点)).filter(v => !isNaN(v));
  const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  console.log(`卖出滑点均值 ${f1(avg(sellSlips))}%（负=危机日次日更低卖出）；买回滑点均值 ${f1(avg(buySlips))}%（正=反弹日次日更高买回）`);
  console.log(`T+0 XIRR ${t0.s.xirrPct.toFixed(1)}% vs T+1 ${t1.s.xirrPct.toFixed(1)}%（差 ${(t1.s.xirrPct - t0.s.xirrPct).toFixed(1)}pp）；期末 ${money(t0.s.endValue)} vs ${money(t1.s.endValue)}`);

  // ---- 2022 快熊专项 ----
  console.log('\n----- 2022 加息熊专项（月度S5a 2022年TWR vs 日度） -----');
  const y2022 = [['月度S5a', mTw.yearly.get('2022')]];
  for (const [name, d] of details) y2022.push([name, d.run.yearFactors.has('2022') ? (d.run.yearFactors.get('2022') - 1) * 100 : null]);
  for (const [n, v] of y2022) console.log(`  ${n}: 2022年 ${f1(v)}%`);
  console.log('2022年内日度往返（T+0）：');
  for (const e of t0.run.episodes.filter(e => e.sellDate >= '2021-10-01' && e.sellDate <= '2023-06-30')) {
    console.log(`  ${e.sellDate} 卖出（${e.trigger}）→ ${e.buyDate ?? '未买回'} 买回，TQQQ ${f1(e.tqqqChangePct)}%`);
  }
  console.log(`同期合成TQQQ 2022全年：${f1((() => { const a = pxM.tqqq.get('2021-12'), b = pxM.tqqq.get('2022-12'); return (b / a - 1) * 100; })())}%`);

  // ---- V4 迟滞保护量化 ----
  const rawD = details.get('日度S5a T+0·无V4迟滞(rawFinal对照)');
  console.log('\n----- V4 30天降档确认的保护作用（生效档 vs raw档跑S5） -----');
  console.log(`往返 ${t0.run.episodes.length} 次 vs 无迟滞 ${rawD.run.episodes.length} 次；` +
    `假信号 ${t0.falseEp.length} vs ${rawD.falseEp.length} 次（踏空 ${f1(compEp(t0.falseEp))}% vs ${f1(compEp(rawD.falseEp))}%）；` +
    `XIRR ${t0.s.xirrPct.toFixed(1)}% vs ${rawD.s.xirrPct.toFixed(1)}%；卖出笔数 ${t0.run.trades.sells} vs ${rawD.run.trades.sells}`);

  // ═════ A系传导（趋势条件化降档确认期，信号层评估见 daily-replay --eval-trendhold）═════
  // 信号层三档全部未过硬约束（年化 12.13→11.91/11.80/11.71，08覆盖 97.3→94.6/94.1/91.4——
  // 退出提前的日子集中在熊市反弹段），故此处只作为 S5 执行层参数评估传导效果
  console.log('\n═════ A系传导：趋势条件化确认期（30→T天，仅SPX≥10月SMA时）对 S5 的影响 ═════');
  const A_DEFS = [[14, 'A14'], [7, 'A7'], [0, 'A0']];
  const aRows = [t0.row];
  const aDetails = new Map();
  for (const [t, label] of A_DEFS) {
    const recsT = runDailyReplay(DD, { trendHoldDays: t }).filter(r => r.date >= S5_START && r.date <= S5_END);
    const run = simulateS5Daily(buildS5Days(recsT, tqqqDaily), 1);
    const r = statsRow(`${label} 趋势上${t}天`, run);
    aRows.push(r.row);
    aDetails.set(label, { run, recsT, ...r });
  }
  console.table(aRows);
  console.log('----- A14 逐笔买回日对照（vs 基线30天；负=提前） -----');
  const a14 = aDetails.get('A14');
  const a14BySell = new Map(a14.run.episodes.map(e => [e.sellDate, e]));
  for (const e0 of t0.run.episodes) {
    const e1 = a14BySell.get(e0.sellDate);
    if (!e1) { console.log(`  ${e0.sellDate}: 基线往返在A14下不存在（片段结构变化）`); continue; }
    const dd = e0.buyDate && e1.buyDate ? dayDiff(e1.buyDate, e0.buyDate) : null;
    console.log(`  ${e0.sellDate} → 买回 ${e0.buyDate ?? '—'} → ${e1.buyDate ?? '—'}` +
      `（${dd === null ? '—' : dd > 0 ? `提前${dd}天` : dd < 0 ? `推迟${-dd}天` : '不变'}；` +
      `期间TQQQ ${f1(e0.tqqqChangePct)}% → ${f1(e1.tqqqChangePct)}%）`);
  }
  const a14New = a14.run.episodes.filter(e => !t0.run.episodes.some(b => b.sellDate === e.sellDate));
  if (a14New.length) console.log(`  A14 新增往返：${a14New.map(e => `${e.sellDate}→${e.buyDate ?? '—'}(${f1(e.tqqqChangePct)}%)`).join('  ')}`);

  // ═════ B系：reduce期新钱规则（存量S5a规则不动）═════
  console.log('\n═════ B系：减仓期新钱去向（现行=攒现金 vs N1全买TQQQ / N2买QQQ / N3半额）═════');
  const B_DEFS = [
    ['现行(reduce攒现金)', 'reserve'],
    ['N1 reduce照买TQQQ', 'always'],
    ['N2 reduce买QQQ,恢复时换TQQQ', 'qqq'],
    ['N3 reduce半额TQQQ半额储备', 'half'],
  ];
  const daysWithQqq = buildS5Days(recsO1, tqqqDaily, 'final', qqqBars);
  const bRows = [];
  const bDetails = new Map();
  for (const [name, mode] of B_DEFS) {
    const run = simulateS5Daily(daysWithQqq, 1, { newMoneyMode: mode });
    const r = statsRow(name, run);
    r.row['闲置月(新钱攒现金)'] = `${run.missedMonthEnds}/${run.monthPoints.length}(${f1(run.missedMonthEnds / run.monthPoints.length * 100)}%)`;
    bRows.push(r.row);
    bDetails.set(mode, { run, ...r });
  }
  console.table(bRows);

  // ═════ A×B 最优组合 ═════
  // B 内按 XIRR 择优；A 未过信号层硬约束 → 组合仅作为执行层参数展示（信号层判定见 --eval-trendhold）
  let bestMode = 'reserve', bestX = -Infinity;
  for (const [, mode] of B_DEFS) {
    const x = bDetails.get(mode).s.xirrPct;
    if (x > bestX) { bestX = x; bestMode = mode; }
  }
  const bestModeName = B_DEFS.find(([, m]) => m === bestMode)[0];
  console.log(`\n═════ A×B 组合（B最优=${bestModeName}；A仅执行层参数）═════`);
  const comboRows = [bDetails.get(bestMode).row];
  for (const [t, label] of A_DEFS) {
    const daysT = buildS5Days(aDetails.get(label).recsT, tqqqDaily, 'final', qqqBars);
    const run = simulateS5Daily(daysT, 1, { newMoneyMode: bestMode });
    comboRows.push(statsRow(`${label}×${bestModeName}`, run).row);
  }
  console.table(comboRows);

  console.log(`
口径声明：日度信号=daily-replay（O1已默认，与线上一致）；月度S5a=dca-schemes原实现原样复跑；
XIRR均为月度现金流资金加权（可比）；日度新增"日度盯市"浮亏/回撤（月度口径存在月末采样美化）；
合成TQQQ为反事实推演（真实TQQQ 2010上市），未计摩擦与税——S5a摩擦敏感性见 dca-schemes（0.1%/笔 ≈ -0.2pp XIRR）。
A系（趋势条件化确认期）信号层评估：node backend/backtest/daily-replay.mjs --eval-trendhold（三档均未过硬约束）。`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(err => { console.error('[s5-daily] failed:', err); process.exit(1); });
}
