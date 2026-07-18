// 定投方案对比（2026-07-18 用户94号任务）："定投能不能救TQQQ"
// 每月月末定投固定金额（C=1，报告按每月$1000折算），2000-01~2026-06 全期与 2010-01 起两窗口：
//   1) 定投+长持 QQQ（100%，不卖出）
//   2) 定投+长持 合成TQQQ（100%，不卖出）
//   3) 定投 TQQQ95% + 信号动态对冲：TQQQ 永不卖出；neutral/reduce/defense 档月末把 SQQQ 调回组合5%
//      （TQQQ不可卖 → SQQQ补足以"当月定投现金"为上限，超额侧卖SQQQ买TQQQ）；attack 档清SQQQ全归TQQQ；
//      新定投资金按 95/5 目标比例入场。另测"季度调整"变体（SQQQ 仅季末月调回5%）。
// 指标：XIRR（资金加权，月度现金流二分求解）、市值/投入倍数、市值最大回撤、
//   最大浮亏（某时点市值/累计投入的最低值——定投特有）、TWR口径最差单年与 2008/2020/2022。
// 运行：node backend/backtest/dca-schemes.mjs（repo 根或 backend 目录均可）
// 只读复用 run-backtest.js / execution-layer.mjs / tqqq-schemes.mjs 导出，不改线上代码与既有脚本默认行为。
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { loadData, runReplay, VARIANTS_DEFAULT } from './run-backtest.js';
import { monthlyCloseMap } from './execution-layer.mjs';
import { synthDailyCustom, statsFromNav, navPathFromWeights, loadQqqBars } from './tqqq-schemes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

// ---------- 纯函数（backend/tests/dca-schemes.test.js 覆盖） ----------

/**
 * 月度现金流 XIRR（资金加权收益率）：解 Σ amount_k/(1+r)^{i_k}=0 的月利率 r，返回年化%。
 * 约定：投入为负、期末市值为正；i 为月索引。二分法，负→正无解时返回 null。
 * @param {Array<{i:number, amount:number}>} cashflows
 */
export function xirrMonthly(cashflows) {
  if (!cashflows || cashflows.length < 2) return null;
  const npv = r => cashflows.reduce((s, c) => s + c.amount / Math.pow(1 + r, c.i), 0);
  // 下界 −50%/月（年化−99.98%）：再低会使 (1+r)^{-i} 在长现金流序列上浮点上溢（0.01^300 下溢为0）
  let lo = -0.5, hi = 1.0;
  let flo = npv(lo), fhi = npv(hi);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (fm === 0) { lo = mid; hi = mid; break; }
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (Math.pow(1 + (lo + hi) / 2, 12) - 1) * 100;
}

/**
 * 定投+买入持有（不卖出）：每月末投入 C 买入。
 * TWR（时间加权）净值用于年度归因：r_t=(V_t−C)/V_{t−1}−1（月末入金当月不产生收益），
 * 买持标的下 TWR 恒等于标的自身价格路径。
 * @returns {{points:Array<{month,value,invested}>, twr:Array<{month,nav}>}}
 */
export function simulateDcaBuyHold(months, pxMap, C = 1) {
  let units = 0, prevV = null;
  const points = [], twr = [];
  months.forEach((m, i) => {
    const p = pxMap.get(m.month);
    if (p === undefined || !(p > 0)) throw new Error(`定投标的缺 ${m.month} 月末价`);
    units += C / p;
    const v = units * p;
    twr.push({ month: m.month, nav: i === 0 ? 1 : twr[i - 1].nav * ((v - C) / prevV) });
    prevV = v;
    points.push({ month: m.month, value: v, invested: (i + 1) * C });
  });
  return { points, twr };
}

/**
 * 定投 TQQQ95% + 信号动态对冲（方案3）：
 *  - TQQQ 永不卖出；月末（或仅季末，rebalanceQuarterly）把 SQQQ 调回组合的 hedgePct：
 *    超额侧卖 SQQQ 所得买 TQQQ；不足侧买 SQQQ 以当月定投现金为上限（TQQQ不可卖 → 5%目标在组合远大于
 *    月投后不可达，实际对冲权重见 avgHedgeWeightPct——这是"永不卖出"约束的诚实后果）
 *  - attack 档：清仓 SQQQ 全归 TQQQ；非调整月新资金按 (1−hedgePct)/hedgePct 比例入场
 * @returns {{points, twr, avgHedgeWeightPct:number}}
 */
export function simulateDcaHedged(months, px, C = 1, { hedgePct = 0.05, rebalanceQuarterly = false } = {}) {
  let tqqqU = 0, sqqqU = 0, prevV = null, hedgeWSum = 0;
  const points = [], twr = [];
  months.forEach((m, i) => {
    const pT = px.tqqq.get(m.month), pS = px.sqqq.get(m.month);
    if (pT === undefined || pS === undefined) throw new Error(`合成TQQQ/SQQQ 缺 ${m.month} 月末价`);
    let cash = C;
    const isRebalanceMonth = !rebalanceQuarterly || ['03', '06', '09', '12'].includes(m.month.slice(5));
    if (m.final === 'attack') {
      cash += sqqqU * pS; sqqqU = 0; // 清SQQQ全归TQQQ
    } else if (isRebalanceMonth) {
      const target = hedgePct * (tqqqU * pT + sqqqU * pS + C);
      const sqqqV = sqqqU * pS;
      if (sqqqV > target) { cash += sqqqV - target; sqqqU = target / pS; }
      else { const buy = Math.min(target - sqqqV, cash); sqqqU += buy / pS; cash -= buy; }
    } else {
      const buy = Math.min(hedgePct * C, cash); // 非调整月：新资金按 95/5 入场
      sqqqU += buy / pS; cash -= buy;
    }
    tqqqU += cash / pT; // 其余全部进TQQQ
    const v = tqqqU * pT + sqqqU * pS;
    hedgeWSum += v > 0 ? (sqqqU * pS) / v : 0;
    twr.push({ month: m.month, nav: i === 0 ? 1 : twr[i - 1].nav * ((v - C) / prevV) });
    prevV = v;
    points.push({ month: m.month, value: v, invested: (i + 1) * C });
  });
  return { points, twr, avgHedgeWeightPct: (hedgeWSum / months.length) * 100 };
}

/**
 * 信号择时定投（94号续 S4/S4q/S5/S6 统一状态机）：每月 C 入场，TQQQ 存量默认永不卖出。
 *  - 档位∈buyTiers（默认 attack/neutral）：当月 C + 按 deployMode 释放的现金储备 → 买TQQQ
 *  - 档位∈{reduce,defense}：当月 C 进现金储备（按上月FFR月化计息），不买入
 *  - deployMode: 'lump'=恢复当月一次性全额部署（S4）；'staged3'=恢复后分3个月匀速部署，
 *    中途再遇 reduce/defense 则暂停、下次恢复重新按剩余储备三等分（S4q）
 *  - sellOnDefense（S5 超规格，超出用户规则仅供对照）：defense 月把存量 TQQQ 也清入储备；
 *    次月只要非 defense 即一次性买回全部储备（新资金仍按 buyTiers 规则走）
 *  - reserveToSpy（S6 对照，用户已否）：reduce/defense 月新资金买 SPY 持有不转换，无现金储备
 * @returns {{points, twr, diag:{missedMonths,maxWaitMonths,avgWaitMonths,maxDeployPct}}}
 */
export function simulateDcaTimed(months, px, rateMap, C = 1, {
  buyTiers = ['attack', 'neutral'],
  deployMode = 'lump',
  sellOnDefense = false,
  reserveToSpy = false,
} = {}) {
  let tqqqU = 0, spyU = 0, reserve = 0, prevTier = null, prevV = null;
  let tranche = 0, tranchesLeft = 0;
  let missedMonths = 0, curWait = 0, maxDeployPct = 0;
  const waits = [];
  const points = [], twr = [];
  months.forEach((m, i) => {
    if (i > 0) reserve *= 1 + ((rateMap.get(months[i - 1].month) ?? 0) / 100) / 12;
    const pT = px.tqqq.get(m.month), pSpy = px.spy.get(m.month);
    if (pT === undefined || (reserveToSpy && pSpy === undefined)) throw new Error(`标的缺 ${m.month} 月末价`);
    const f = m.final;
    const isBuy = buyTiers.includes(f);
    // S5：defense 清存量入储备
    if (sellOnDefense && f === 'defense' && tqqqU > 0) { reserve += tqqqU * pT; tqqqU = 0; }
    // 储备释放
    let deployR = 0;
    if (sellOnDefense && f !== 'defense' && prevTier === 'defense' && reserve > 0) {
      deployR = reserve; // S5：出 defense 即一次性买回（无论当月档位）
      tranchesLeft = 0;
    } else if (isBuy && reserve > 0) {
      if (deployMode === 'staged3') {
        if (!buyTiers.includes(prevTier ?? '')) { tranche = reserve / 3; tranchesLeft = 3; } // 新一轮恢复
        deployR = tranchesLeft <= 1 ? reserve : Math.min(tranche, reserve);
        tranchesLeft = Math.max(0, tranchesLeft - 1);
      } else {
        deployR = reserve;
      }
    }
    // 新资金去向
    let buyTqqq = deployR;
    if (isBuy) buyTqqq += C;
    else if (reserveToSpy) spyU += C / pSpy;
    else reserve += C;
    tqqqU += buyTqqq / pT;
    reserve -= deployR;
    const v = tqqqU * pT + spyU * (pSpy ?? 0) + reserve;
    if (deployR > 0 && v > 0) maxDeployPct = Math.max(maxDeployPct, (buyTqqq / v) * 100);
    // 等待期诊断（攒现金月＝错过买入的月）
    if (!isBuy && !reserveToSpy) { missedMonths++; curWait++; }
    else if (curWait > 0) { waits.push(curWait); curWait = 0; }
    twr.push({ month: m.month, nav: i === 0 ? 1 : twr[i - 1].nav * ((v - C) / prevV) });
    prevV = v;
    points.push({ month: m.month, value: v, invested: (i + 1) * C });
    prevTier = f;
  });
  if (curWait > 0) waits.push(curWait);
  return {
    points, twr,
    diag: {
      missedMonths,
      maxWaitMonths: waits.length ? Math.max(...waits) : 0,
      avgWaitMonths: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
      maxDeployPct,
    },
  };
}

/**
 * S5 精细化状态机（94号续·用户选中方案，存量也择时）：
 *  - defense 入场月：卖出存量 TQQQ 的 sellFraction（默认全部）进现金储备（计FFR利息）；防守期新钱也进储备
 *  - 退出 defense：buybackOnReduce=true（S5a/b/d）→ 到 reduce/neutral/attack 即触发买回；
 *    false（S5c/e）→ 只有恢复到 neutral/attack 才买回（reduce 继续观望）
 *  - staged=true（S5b/e）：买回与储备部署分3个月匀速（触发月起每个非defense月释放1/3，末期清尾；
 *    中途再入 defense 则取消未完成计划、按卖出规则重新防守）
 *  - reduce（非买回场景）：新钱攒现金、存量持有；neutral/attack：新钱+储备全部（或按期）买入
 *  - frictionPct：每笔买/卖单边摩擦（敏感性用，默认0）
 * @returns {{points,twr,diag,episodes,monthLog,trades:{buys,sells}}}
 *  episodes: [{sellMonth,sellPx,trigger,buyMonth,buyPx,tqqqChangePct,waitMonths}]（tqqqChangePct>0=假信号踏空）
 */
export function simulateS5(months, px, rateMap, C = 1, {
  sellFraction = 1,
  buybackOnReduce = true,
  staged = false,
  frictionPct = 0,
} = {}) {
  const monthIdx = m => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  let tqqqU = 0, reserve = 0, prevTier = null, prevV = null;
  let tranche = 0, tranchesLeft = 0;
  let curEpisode = null;
  let missedMonths = 0, curWait = 0, maxDeployPct = 0, buys = 0, sells = 0;
  const waits = [], points = [], twr = [], episodes = [], monthLog = [];
  months.forEach((m, i) => {
    if (i > 0) reserve *= 1 + ((rateMap.get(months[i - 1].month) ?? 0) / 100) / 12;
    const pT = px.tqqq.get(m.month);
    if (pT === undefined) throw new Error(`合成TQQQ 缺 ${m.month} 月末价`);
    const f = m.final;
    const isBuyTier = f === 'attack' || f === 'neutral';
    const actions = [];
    // ---- defense 入场：卖出存量 ----
    if (f === 'defense' && prevTier !== 'defense' && tqqqU > 0 && sellFraction > 0) {
      const sellU = tqqqU * sellFraction;
      const proceeds = sellU * pT * (1 - frictionPct);
      reserve += proceeds; tqqqU -= sellU; sells++;
      tranchesLeft = 0; // 取消未完成的部署计划
      const trigger = m.sahmLockActive ? '萨姆锁' : m.reactiveLockActive ? '应对式锁' : '决策树共振';
      curEpisode = { sellMonth: m.month, sellPx: pT, trigger };
      actions.push(`卖出存量${sellFraction < 1 ? Math.round(sellFraction * 100) + '%' : ''}(${proceeds.toFixed(2)})`);
    }
    // ---- 部署（买回/常规）判定 ----
    let deployR = 0;
    const buybackNow = !!curEpisode && curEpisode.buyMonth === undefined && f !== 'defense'
      && (isBuyTier || (buybackOnReduce && f === 'reduce'));
    const normalDeploy = isBuyTier && reserve > 0;
    if (f !== 'defense' && reserve > 0 && (buybackNow || normalDeploy || (staged && tranchesLeft > 0))) {
      if (staged) {
        if ((buybackNow || normalDeploy) && tranchesLeft === 0) { tranche = reserve / 3; tranchesLeft = 3; }
        if (tranchesLeft > 0) {
          deployR = tranchesLeft === 1 ? reserve : Math.min(tranche, reserve);
          tranchesLeft--;
        }
      } else if (buybackNow || normalDeploy) {
        deployR = reserve;
      }
    }
    if (deployR > 0 && curEpisode && curEpisode.buyMonth === undefined) {
      curEpisode.buyMonth = m.month; curEpisode.buyPx = pT;
      curEpisode.tqqqChangePct = (pT / curEpisode.sellPx - 1) * 100;
      curEpisode.waitMonths = monthIdx(m.month) - monthIdx(curEpisode.sellMonth);
      episodes.push(curEpisode); curEpisode = null;
    }
    // ---- 新钱去向 + 执行买入 ----
    let buyAmt = deployR;
    if (isBuyTier) buyAmt += C; else reserve += C;
    if (buyAmt > 0) {
      tqqqU += buyAmt * (1 - frictionPct) / pT; buys++;
      reserve -= deployR;
      actions.push(deployR > 0 ? `部署储备+定投(${buyAmt.toFixed(2)})` : `定投买入(${buyAmt.toFixed(2)})`);
    } else {
      actions.push(f === 'defense' ? '持币防守(新钱入储备)' : '新钱入储备(观望)');
    }
    const v = tqqqU * pT + reserve;
    if (buyAmt > 0 && deployR > 0 && v > 0) maxDeployPct = Math.max(maxDeployPct, (buyAmt / v) * 100);
    if (!isBuyTier) { missedMonths++; curWait++; } else if (curWait > 0) { waits.push(curWait); curWait = 0; }
    twr.push({ month: m.month, nav: i === 0 ? 1 : twr[i - 1].nav * ((v - C) / prevV) });
    prevV = v;
    points.push({ month: m.month, value: v, invested: (i + 1) * C });
    monthLog.push({ month: m.month, tier: f, action: actions.join('+'), value: v, reserve });
    prevTier = f;
  });
  if (curWait > 0) waits.push(curWait);
  if (curEpisode) { // 样本末仍未买回的开放往返
    const lastPx = px.tqqq.get(months[months.length - 1].month);
    episodes.push({ ...curEpisode, buyMonth: null, buyPx: lastPx, tqqqChangePct: (lastPx / curEpisode.sellPx - 1) * 100, waitMonths: monthIdx(months[months.length - 1].month) - monthIdx(curEpisode.sellMonth) });
  }
  return {
    points, twr, episodes, monthLog,
    trades: { buys, sells },
    diag: {
      missedMonths,
      maxWaitMonths: waits.length ? Math.max(...waits) : 0,
      avgWaitMonths: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
      maxDeployPct,
    },
  };
}

/**
 * 定投路径统计：总投入/期末市值/倍数/XIRR/市值最大回撤/最大浮亏（min 市值÷累计投入 −1）
 */
export function dcaStats(points) {
  if (!points || points.length < 2) return null;
  const flows = [];
  let prevInv = 0;
  points.forEach((p, i) => {
    const d = p.invested - prevInv;
    prevInv = p.invested;
    if (d) flows.push({ i, amount: -d });
  });
  flows.push({ i: points.length - 1, amount: points[points.length - 1].value });
  let peak = -Infinity, mdd = 0, minVsInv = Infinity;
  for (const p of points) {
    peak = Math.max(peak, p.value);
    if (peak > 0) mdd = Math.min(mdd, p.value / peak - 1);
    minVsInv = Math.min(minVsInv, p.value / p.invested - 1);
  }
  const last = points[points.length - 1];
  return {
    totalInvested: last.invested,
    endValue: last.value,
    multiple: last.value / last.invested,
    xirrPct: xirrMonthly(flows),
    valueMddPct: mdd * 100,
    minValueToInvestedPct: minVsInv * 100,
  };
}

// ---------- 主流程 ----------

const f1 = v => (v === null || v === undefined || isNaN(v) ? '—' : v.toFixed(1));
const money = v => {
  const usd = v * 1000; // C=$1000 折算
  return usd >= 1e6 ? `$${(usd / 1e6).toFixed(2)}M` : `$${Math.round(usd / 1000)}k`;
};

async function main() {
  const D = await loadData();
  const { rateMap } = D;
  console.log('[dca-schemes] 重放基线信号时间线（V3+V4+W5 默认档）...');
  const timeline = runReplay(D, VARIANTS_DEFAULT).filter(t => t.spx !== null);
  console.log(`[dca-schemes] ${timeline.length} 个月（${timeline[0].month} ~ ${timeline[timeline.length - 1].month}）`);

  const qqqBars = await loadQqqBars();
  const rateOfDate = d => rateMap.get(d.slice(0, 7)) ?? 0;
  const px = {
    qqq: monthlyCloseMap(qqqBars),
    tqqq: monthlyCloseMap(synthDailyCustom(qqqBars, rateOfDate, { beta: 3, ffrMult: -2, erPct: 0.86 })),
    sqqq: monthlyCloseMap(synthDailyCustom(qqqBars, rateOfDate, { beta: -3, ffrMult: 4, erPct: 0.95 })),
    spy: monthlyCloseMap(D.spx),
  };

  const windows = [
    ['全期 2000-01起', timeline],
    ['2010-01起', timeline.filter(t => t.month >= '2010-01')],
  ];
  const SCHEMES = [
    ['1) 定投QQQ 100%买持', months => simulateDcaBuyHold(months, px.qqq)],
    ['2) 定投合成TQQQ 100%买持', months => simulateDcaBuyHold(months, px.tqqq)],
    ['3) 定投TQQQ95%+SQQQ5%月末调整', months => simulateDcaHedged(months, px)],
    ['3q) 同3但SQQQ季末才调整', months => simulateDcaHedged(months, px, 1, { rebalanceQuarterly: true })],
    ['4) S4 信号择时定投(reduce/defense攒现金,恢复月一次性部署)', months => simulateDcaTimed(months, px, rateMap)],
    ['4q) S4q 同4但恢复后分3个月匀速部署', months => simulateDcaTimed(months, px, rateMap, 1, { deployMode: 'staged3' })],
    ['5) S5 超规格对照(存量也择时:defense清仓TQQQ,出defense买回)※超出用户规则', months => simulateDcaTimed(months, px, rateMap, 1, { sellOnDefense: true })],
    ['6) S6 对照(reduce/defense新资金买SPY持有不转换)※用户已否', months => simulateDcaTimed(months, px, rateMap, 1, { reserveToSpy: true })],
  ];

  for (const [label, months] of windows) {
    console.log(`\n===== 定投对比：${label}（每月末定投$1000，共${months.length}个月=总投入${money(months.length)}） =====`);
    const diags = [];
    const rows = SCHEMES.map(([name, run]) => {
      const r = run(months);
      if (r.diag) diags.push([name, r.diag]);
      const s = dcaStats(r.points);
      const tw = statsFromNav(r.twr);
      const fullYears = [...tw.yearly].filter(([y]) => tw.yearMonths.get(y) === 12);
      const worst = fullYears.reduce((a, b) => (b[1] < a[1] ? b : a), ['—', Infinity]);
      return {
        方案: name,
        期末市值: money(s.endValue),
        'XIRR(资金加权)': f1(s.xirrPct) + '%',
        '市值/投入': s.multiple.toFixed(1) + 'x',
        市值最大回撤: f1(s.valueMddPct) + '%',
        '最大浮亏(vs已投本金)': f1(s.minValueToInvestedPct) + '%',
        '最差单年(TWR)': `${worst[0]} ${f1(worst[1])}%`,
        '2008年': f1(tw.yearly.get('2008')) + '%',
        '2020年': f1(tw.yearly.get('2020')) + '%',
        '2022年': f1(tw.yearly.get('2022')) + '%',
        SQQQ均权重: r.avgHedgeWeightPct !== undefined ? f1(r.avgHedgeWeightPct) + '%' : '—',
      };
    });
    console.table(rows);

    // 择时定投诊断：现金等待期与部署冲击
    console.log(`--- 择时定投诊断（${label}）---`);
    console.table(diags.map(([name, d]) => ({
      方案: name.split('(')[0].trim(),
      '攒现金月数(错过买入)': d.missedMonths,
      最长等待: d.maxWaitMonths + '个月',
      平均等待: f1(d.avgWaitMonths) + '个月',
      '单笔最大部署占当时组合': f1(d.maxDeployPct) + '%',
    })));
    // "择时的钱花在哪了"：攒现金月份（reduce/defense）里 TQQQ 的实际表现
    let up = 0, down = 0, sum = 0, cum = 1;
    for (let i = 0; i < months.length - 1; i++) {
      const f = months[i].final;
      if (f !== 'reduce' && f !== 'defense') continue;
      const r = px.tqqq.get(months[i + 1].month) / px.tqqq.get(months[i].month) - 1;
      if (r > 0) up++; else down++;
      sum += r; cum *= 1 + r;
    }
    console.log(`攒现金月份（reduce∪defense）的TQQQ实际表现：${up}个月上涨 vs ${down}个月下跌，` +
      `平均月收益 ${f1(sum / (up + down) * 100)}%，这些月份连乘 ${f1((cum - 1) * 100)}%` +
      `——S4把钱放现金错过的上涨与躲掉的下跌净额`);
  }

  // 对照行：同窗口一次性投入（时间加权CAGR，来自 tqqq-schemes 已有口径）
  const assetRet = (asset, m0, m1) => {
    const a = px[asset].get(m0), b = px[asset].get(m1);
    return a && b ? b / a - 1 : null;
  };
  const E7 = f => (f === 'defense' ? { cash: 1 } : f === 'reduce' ? { spy: 1 } : { tqqq: 0.85, cash: 0.15 });
  const e7Pts = navPathFromWeights(timeline, E7, assetRet, rateMap);
  const lumpPts = asset => timeline.map(t => ({ month: t.month, nav: px[asset].get(t.month) }));
  console.log('\n===== 对照：同窗口一次性投入的年化（时间加权CAGR） =====');
  console.table([['QQQ 买持', lumpPts('qqq')], ['合成TQQQ 买持', lumpPts('tqqq')], ['E7(85%TQQQ月度再平衡+信号防守)', e7Pts]].map(([name, pts]) => ({
    方案: name,
    '全期年化(2000起)': f1(statsFromNav(pts).cagrPct) + '%',
    '2010起年化': f1(statsFromNav(pts.filter(p => p.month >= '2010-01')).cagrPct) + '%',
  })));

  // 定投TQQQ的"归零段"细节：2000-01起定投在2002-09时点的处境
  const dcaT = simulateDcaBuyHold(timeline, px.tqqq);
  const atTrough = dcaT.points.reduce((a, b) => (b.value / b.invested < a.value / a.invested ? b : a));
  console.log(`\n定投TQQQ最深水下时点：${atTrough.month} —— 已投入 ${money(atTrough.invested)}，市值仅 ${money(atTrough.value)}（${(atTrough.value / atTrough.invested * 100).toFixed(1)}%），浮亏 ${f1((atTrough.value / atTrough.invested - 1) * 100)}%`);

  // ===== S5 精细化（94号续·用户选中）：第一部分 参数变体择优 =====
  const S5_VARIANTS = [
    ['S5a 基准(全卖/退defense即买回/一次性)', {}],
    ['S5b 买回与部署分3个月匀速', { staged: true }],
    ['S5c 只恢复到neutral/attack才买回', { buybackOnReduce: false }],
    ['S5d defense只卖一半存量', { sellFraction: 0.5 }],
    ['S5e =S5b+S5c', { staged: true, buybackOnReduce: false }],
  ];
  const compEp = arr => (arr.reduce((a, e) => a * (1 + e.tqqqChangePct / 100), 1) - 1) * 100;
  const s5Runs = new Map(); // `${label}|${name}` → run
  for (const [label, months] of windows) {
    console.log(`\n===== S5 变体择优：${label}（存量也择时；每月$1000） =====`);
    const rows = S5_VARIANTS.map(([name, opts]) => {
      const r = simulateS5(months, px, rateMap, 1, opts);
      s5Runs.set(`${label}|${name}`, r);
      const s = dcaStats(r.points);
      const tw = statsFromNav(r.twr);
      const falseEp = r.episodes.filter(e => e.tqqqChangePct > 0);
      const trueEp = r.episodes.filter(e => e.tqqqChangePct <= 0);
      return {
        变体: name,
        期末市值: money(s.endValue),
        XIRR: f1(s.xirrPct) + '%',
        市值最大回撤: f1(s.valueMddPct) + '%',
        最大浮亏: f1(s.minValueToInvestedPct) + '%',
        '2008年': f1(tw.yearly.get('2008')) + '%',
        '2020年': f1(tw.yearly.get('2020')) + '%',
        '2022年': f1(tw.yearly.get('2022')) + '%',
        往返次数: r.episodes.length,
        假信号往返: `${falseEp.length}次/合计踏空${f1(compEp(falseEp))}%`,
        真信号往返: `${trueEp.length}次/合计躲掉${f1(compEp(trueEp))}%`,
      };
    });
    console.table(rows);
  }
  // 最优变体（按全期XIRR）+ 摩擦敏感性
  const fullLabel = windows[0][0];
  let bestName = null, bestXirr = -Infinity;
  for (const [name] of S5_VARIANTS) {
    const x = dcaStats(s5Runs.get(`${fullLabel}|${name}`).points).xirrPct;
    if (x > bestXirr) { bestXirr = x; bestName = name; }
  }
  const bestOpts = S5_VARIANTS.find(([n]) => n === bestName)[1];
  console.log(`\n最优变体（按全期XIRR）：${bestName}`);
  for (const [label, months] of windows) {
    const fr = dcaStats(simulateS5(months, px, rateMap, 1, { ...bestOpts, frictionPct: 0.001 }).points);
    const base = dcaStats(s5Runs.get(`${label}|${bestName}`).points);
    console.log(`摩擦敏感性（每笔买卖双边0.1%）${label}：XIRR ${f1(base.xirrPct)}% → ${f1(fr.xirrPct)}%（差${f1(fr.xirrPct - base.xirrPct)}pp），期末 ${money(base.endValue)} → ${money(fr.endValue)}`);
  }

  // ===== 第二部分：最优变体 26 年操作实况（执行手册用） =====
  const best = s5Runs.get(`${fullLabel}|${bestName}`);
  const bestStats = dcaStats(best.points);
  console.log(`\n===== ${bestName} 全期操作实况（2000-01~${timeline[timeline.length - 1].month}） =====`);
  console.log('\n--- 1. 全部 defense 进出场清单（期间涨跌>0=假信号踏空，<0=躲掉的下跌） ---');
  console.table(best.episodes.map(e => ({
    卖出月: e.sellMonth, 触发: e.trigger,
    买回月: e.buyMonth ?? '样本末未买回',
    持币月数: e.waitMonths,
    '期间TQQQ涨跌': f1(e.tqqqChangePct) + '%',
    判定: e.tqqqChangePct > 0 ? '假信号(踏空)' : '真信号(躲掉)',
  })));
  const falseEp = best.episodes.filter(e => e.tqqqChangePct > 0);
  const trueEp = best.episodes.filter(e => e.tqqqChangePct <= 0);
  const avgHold = best.episodes.reduce((a, e) => a + e.waitMonths, 0) / (best.episodes.length || 1);
  const worstFalse = falseEp.reduce((a, e) => (e.tqqqChangePct > (a?.tqqqChangePct ?? -1) ? e : a), null);
  const bestTrue = trueEp.reduce((a, e) => (e.tqqqChangePct < (a?.tqqqChangePct ?? 1) ? e : a), null);
  console.log(`--- 2. 往返统计 ---
26年共卖出 ${best.trades.sells} 次；平均持币 ${f1(avgHold)} 个月，最长 ${Math.max(...best.episodes.map(e => e.waitMonths))} 个月；
假信号 ${falseEp.length}/${best.episodes.length}（${f1(falseEp.length / best.episodes.length * 100)}%），合计踏空 ${f1(compEp(falseEp))}%；真信号合计躲掉 ${f1(compEp(trueEp))}%；
最痛一次假信号：${worstFalse ? `${worstFalse.sellMonth}卖出→${worstFalse.buyMonth}买回，踏空 +${f1(worstFalse.tqqqChangePct)}%（${worstFalse.trigger}触发）` : '无'}；
最值一次真信号：${bestTrue ? `${bestTrue.sellMonth}卖出→${bestTrue.buyMonth ?? '未买回'}，躲掉 ${f1(bestTrue.tqqqChangePct)}%（${bestTrue.trigger}触发）` : '无'}`);
  console.log(`--- 3. 新钱等待统计（reduce∪defense攒现金） ---
攒现金月 ${best.diag.missedMonths}/${timeline.length}（${f1(best.diag.missedMonths / timeline.length * 100)}%）；最长等待 ${best.diag.maxWaitMonths} 个月，平均 ${f1(best.diag.avgWaitMonths)} 个月；单笔最大部署占当时组合 ${f1(best.diag.maxDeployPct)}%`);
  const deep = best.points.reduce((a, b) => (b.value / b.invested < a.value / a.invested ? b : a));
  const deepLog = best.monthLog.find(l => l.month === deep.month);
  console.log(`--- 4. 最深浮亏 ---
${deep.month}：已投 ${money(deep.invested)}，市值 ${money(deep.value)}（${(deep.value / deep.invested * 100).toFixed(1)}%，浮亏 ${f1((deep.value / deep.invested - 1) * 100)}%）；当月档位 ${deepLog.tier}，动作「${deepLog.action}」，其中现金储备 ${money(deepLog.reserve)}`);
  for (const [cName, from, to] of [['2008金融危机', '2007-06', '2009-09'], ['2020新冠', '2019-10', '2020-12'], ['2022加息熊', '2021-10', '2023-06']]) {
    console.log(`\n--- ${cName} 逐月操作流水 ---`);
    for (const l of best.monthLog.filter(l => l.month >= from && l.month <= to)) {
      console.log(`${l.month} [${l.tier.padEnd(7)}] ${l.action}｜组合 ${money(l.value)}（现金 ${money(l.reserve)}）`);
    }
  }
  const yearsSpan = (timeline.length - 1) / 12;
  console.log(`\n--- 5. 交易频率 ---
26年买入 ${best.trades.buys} 笔（含定投与买回）+ 卖出 ${best.trades.sells} 笔 = 共 ${best.trades.buys + best.trades.sells} 笔，年均 ${f1((best.trades.buys + best.trades.sells) / yearsSpan)} 笔`);

  console.log(`
口径声明：
- XIRR=资金加权（每月-$1000、期末+市值，月度复利年化），衡量定投者的真实资金收益；TWR=时间加权，
  仅用于年度归因（2008/2020/2022/最差单年），买持方案下等于标的自身年度涨跌；
- 方案3受"TQQQ永不卖出"约束：组合远大于月投后，SQQQ补足上限=当月定投现金，5%目标实际不可达
  （实际平均对冲权重见表）——这是方案自身设定的诚实后果，非建模选择；
- 合成TQQQ为反事实推演（真实TQQQ 2010上市），未计ETF交易摩擦与税；合成模型与局限同 tqqq-schemes.mjs。`);
}

// 直接运行时执行（被 import / vitest 收集时只导出纯函数）
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(err => { console.error('[dca-schemes] failed:', err); process.exit(1); });
}
