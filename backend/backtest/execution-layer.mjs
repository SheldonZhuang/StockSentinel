// 进攻执行层回测（2026-07 用户新目标"年化≥SPY两倍/冲100%"评估）：
// 在既有信号时间线（V3+V4+W5 基线，runReplay 重放一次拿逐月档位）上叠加执行层变体——
// 换标的（QQQ/SMH）、加杠杆（2x 日度再平衡合成）、防守做空（-1xSPY）。
// 另算"完美预知月度择时"理论天花板，校准年化预期。
// 运行：node backend/backtest/execution-layer.mjs（repo 根或 backend 目录均可，.env 按绝对路径加载）
// 只读复用 run-backtest.js 的 loadData/runReplay/VARIANTS_DEFAULT，不修改任何线上代码与既有报告。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import { loadData, runReplay, VARIANTS_DEFAULT, sampleMonthEnd } from './run-backtest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') }); // run-backtest 的 dotenv/config 按 cwd 找，此处兜底绝对路径

// ---------- 纯函数（backend/tests/backtest.test.js 覆盖） ----------

/**
 * 日度再平衡杠杆合成（诚实口径，非"月收益×2"乐观近似）：
 * 每日净值 ×= 1 + leverage×日收益 − 日费用；
 * 日费用 = [ER + (leverage−1)×(联邦基金利率+borrowSpread)] / 100 / tradingDays
 * —— ER 收在全仓上，借贷成本只收在借入的 (leverage−1) 倍名义上。
 * 天然携带波动损耗（+10%再−10%：1x=−1%，2x≈−4%再扣费），与真实杠杆ETF(SSO/QLD)机制一致。
 * @param {Array<{date, close:number}>} bars - 升序日线（adjClose 总回报口径）
 * @param {(date:string)=>number} rateOfDate - 该日适用的联邦基金利率（年化%）
 * @returns {Array<{date, close:number}>} 合成净值序列（首日=1）
 */
export function synthLeveragedDaily(bars, rateOfDate, { leverage = 2, erPct = 0.95, borrowSpreadPct = 0.4, tradingDays = 252 } = {}) {
  const out = [];
  let nav = 1;
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      const r = bars[i].close / bars[i - 1].close - 1;
      const ffr = rateOfDate(bars[i].date) ?? 0;
      const feeDaily = (erPct + (leverage - 1) * (ffr + borrowSpreadPct)) / 100 / tradingDays;
      nav *= 1 + leverage * r - feeDaily;
      if (nav < 0) nav = 0; // 单日亏穿100%的理论爆仓保护（2x 需单日−50%，SPY史上未发生）
    }
    out.push({ date: bars[i].date, close: nav });
  }
  return out;
}

/** 日线 → 月末收盘 Map('YYYY-MM' → close)，复用 run-backtest 的 sampleMonthEnd 口径 */
export function monthlyCloseMap(bars) {
  return new Map(
    sampleMonthEnd(bars.map(b => ({ date: b.date, value: b.close }))).map(o => [o.month, o.value])
  );
}

/**
 * 执行层净值模拟：每月按上月档位持仓（月末调仓，与 simulateNav 同口径——月 i 的收益由 months[i-1].final 决定）。
 * @param {Array<{month, final}>} months - 升序档位时间线
 * @param {(final:string)=>Object<string,number>} weightsOf - 档位 → {资产:权重}（含 'cash'）
 * @param {(asset:string, m0:string, m1:string)=>number|null} assetRet - 资产 m0→m1 月收益
 * @param {Map<string,number>} rateMap - 月 → 联邦基金利率（年化%），现金按月化 r/12 计息
 * @returns {{totalPct,cagrPct,mddPct,years,yearly:Map<string,number>,yearMonths:Map<string,number>}|null}
 */
export function simulateExecution(months, weightsOf, assetRet, rateMap) {
  if (months.length < 2) return null;
  let nav = 1, peak = 1, mdd = 0;
  const yearFactors = new Map(), yearMonths = new Map();
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1], cur = months[i];
    const w = weightsOf(prev.final);
    let ret = 0;
    for (const [asset, weight] of Object.entries(w)) {
      if (!weight) continue;
      const r = asset === 'cash'
        ? ((rateMap.get(prev.month) ?? 0) / 100) / 12
        : assetRet(asset, prev.month, cur.month);
      if (r === null || r === undefined || isNaN(r)) {
        throw new Error(`资产 ${asset} 缺 ${prev.month}→${cur.month} 月收益（样本窗口应从资产起始月裁剪）`);
      }
      ret += weight * r;
    }
    nav *= 1 + ret;
    peak = Math.max(peak, nav);
    mdd = Math.min(mdd, nav / peak - 1);
    const y = cur.month.slice(0, 4);
    yearFactors.set(y, (yearFactors.get(y) ?? 1) * (1 + ret));
    yearMonths.set(y, (yearMonths.get(y) ?? 0) + 1);
  }
  const years = (months.length - 1) / 12;
  return {
    totalPct: (nav - 1) * 100,
    cagrPct: (Math.pow(nav, 1 / years) - 1) * 100,
    mddPct: mdd * 100,
    years,
    yearly: new Map([...yearFactors].map(([y, f]) => [y, (f - 1) * 100])),
    yearMonths,
  };
}

/**
 * 完美预知月度择时天花板：每月事先知道结果，取 max(风险资产月收益, 现金月收益) 复利。
 * 这是"该资产/现金二元月度择时系统"的数学上限——需要100%预测准确率才能达到。
 */
export function perfectForesightCagr(months, retOf, rateMap) {
  if (months.length < 2) return null;
  let nav = 1, cashMonths = 0;
  for (let i = 1; i < months.length; i++) {
    const r = retOf(months[i - 1].month, months[i].month);
    const cash = ((rateMap.get(months[i - 1].month) ?? 0) / 100) / 12;
    if (cash > r) cashMonths++;
    nav *= 1 + Math.max(r, cash);
  }
  const years = (months.length - 1) / 12;
  return { cagrPct: (Math.pow(nav, 1 / years) - 1) * 100, cashMonths, totalMonths: months.length - 1 };
}

// ---------- 数据拉取：QQQ/SMH 日线 adjClose（Tiingo，本地缓存 45 天陈旧护栏） ----------

async function fetchTiingoDaily(ticker, cacheName) {
  const cacheFile = path.join(__dirname, cacheName);
  const today = new Date().toISOString().slice(0, 10);
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const last = cached.bars?.length ? cached.bars[cached.bars.length - 1].date : null;
    if (last && (Date.parse(today) - Date.parse(last)) / 86400000 <= 45) return cached.bars;
  }
  const token = process.env.TIINGO_API_KEY;
  if (!token) throw new Error('TIINGO_API_KEY not set（backend/.env）');
  const res = await axios.get(`https://api.tiingo.com/tiingo/daily/${ticker}/prices`, {
    params: { startDate: '1997-01-01', token },
    timeout: 60000,
  });
  const bars = (res.data || [])
    .map(r => ({ date: String(r.date).slice(0, 10), close: r.adjClose ?? r.close }))
    .filter(b => !isNaN(b.close));
  if (bars.length < 1000) throw new Error(`${ticker} 拉取不完整（${bars.length} bars），不写缓存`);
  fs.writeFileSync(cacheFile, JSON.stringify({ source: `Tiingo ${ticker.toUpperCase()} 总回报（adjClose）`, fetchedAt: today, bars }));
  return bars;
}

// ---------- 变体定义 ----------

const W = w => () => w; // 档位无关的固定权重
const VARIANT_WEIGHTS = {
  // E0 基线对照：defense→现金，其余→SPY（= run-backtest 仅defense离场口径，全期12.2%）
  E0: f => (f === 'defense' ? { cash: 1 } : { spy: 1 }),
  // E1 换标的：neutral/attack→QQQ
  E1: f => (f === 'defense' ? { cash: 1 } : f === 'reduce' ? { spy: 1 } : { qqq: 1 }),
  // E2 温和杠杆：neutral/attack→2xSPY（日度再平衡合成）
  E2: f => (f === 'defense' ? { cash: 1 } : f === 'reduce' ? { spy: 1 } : { spy2x: 1 }),
  // E3 激进：neutral/attack→2xQQQ
  E3: f => (f === 'defense' ? { cash: 1 } : f === 'reduce' ? { spy: 1 } : { qqq2x: 1 }),
  // E4 梯度（SPY系）：reduce→0.5xSPY+0.5现金；neutral→1.5x（=50% SPY + 50% 2xSPY 月末再平衡）；attack→2x
  E4: f => (f === 'defense' ? { cash: 1 }
    : f === 'reduce' ? { spy: 0.5, cash: 0.5 }
    : f === 'attack' ? { spy2x: 1 }
    : { spy: 0.5, spy2x: 0.5 }),
  // E5 防守做空：同E0但defense→-1xSPY（做空月收益 = −SPY月收益 + 卖空所得计息FFR − 借券费0.4%/年）
  E5: f => (f === 'defense' ? { spyShort: 1 } : { spy: 1 }),
  // E6 AI集中：neutral/attack→SMH（2000-06 起样本，另报同窗口 E0 对照）
  E6: f => (f === 'defense' ? { cash: 1 } : f === 'reduce' ? { spy: 1 } : { smh: 1 }),
};
const VARIANT_DESC = {
  E0: 'E0 基线(defense→现金,余SPY)',
  E1: 'E1 换标的(neutral/attack→QQQ)',
  E2: 'E2 温和杠杆(→2xSPY)',
  E3: 'E3 激进(→2xQQQ)',
  E4: 'E4 梯度(0.5x/1.5x/2x SPY系)',
  E5: 'E5 防守做空(defense→-1xSPY)',
  E6: 'E6 AI集中(→SMH)',
};

// ---------- 主流程 ----------

const f1 = v => (v === null || v === undefined ? '—' : v.toFixed(1));

async function main() {
  const D = await loadData();
  const { rateMap } = D;
  console.log('[execution-layer] 重放基线信号时间线（V3+V4+W5 默认档）...');
  const timeline = runReplay(D, VARIANTS_DEFAULT).filter(t => t.spx !== null);
  console.log(`[execution-layer] ${timeline.length} 个月（${timeline[0].month} ~ ${timeline[timeline.length - 1].month}）`);
  const tierCount = {};
  for (const t of timeline) tierCount[t.final] = (tierCount[t.final] ?? 0) + 1;
  console.log('[execution-layer] 档位分布:', JSON.stringify(tierCount));

  console.log('[execution-layer] 拉取 QQQ/SMH 日线（Tiingo，带缓存）...');
  const [qqqBars, smhBars] = [await fetchTiingoDaily('qqq', 'qqq-cache.json'), await fetchTiingoDaily('smh', 'smh-cache.json')];
  console.log(`[execution-layer] QQQ ${qqqBars[0].date}~${qqqBars[qqqBars.length - 1].date}（${qqqBars.length} bars）| SMH ${smhBars[0].date}~${smhBars[smhBars.length - 1].date}（${smhBars.length} bars）`);

  const rateOfDate = d => rateMap.get(d.slice(0, 7)) ?? 0;
  const px = {
    spy: monthlyCloseMap(D.spx),
    qqq: monthlyCloseMap(qqqBars),
    smh: monthlyCloseMap(smhBars),
    spy2x: monthlyCloseMap(synthLeveragedDaily(D.spx, rateOfDate)),
    qqq2x: monthlyCloseMap(synthLeveragedDaily(qqqBars, rateOfDate)),
  };
  const assetRet = (asset, m0, m1) => {
    if (asset === 'spyShort') {
      const r = assetRet('spy', m0, m1);
      if (r === null) return null;
      return -r + ((rateMap.get(m0) ?? 0) / 100) / 12 - (0.4 / 100) / 12;
    }
    const a = px[asset].get(m0), b = px[asset].get(m1);
    return a && b ? b / a - 1 : null;
  };

  // ===== 第一部分：完美预知择时天花板 =====
  const sub2010 = timeline.filter(t => t.month >= '2010-01');
  const spyRet = (m0, m1) => assetRet('spy', m0, m1);
  const spy2xRet = (m0, m1) => assetRet('spy2x', m0, m1);
  const bh = (months, asset) => simulateExecution(months, W({ [asset]: 1 }), assetRet, rateMap);
  const ceilRows = [];
  for (const [label, months] of [['全期 2000-01~' + timeline[timeline.length - 1].month, timeline], ['2010-01起', sub2010]]) {
    const p1 = perfectForesightCagr(months, spyRet, rateMap);
    const p2 = perfectForesightCagr(months, spy2xRet, rateMap);
    const spyBh = bh(months, 'spy');
    ceilRows.push({
      样本: label,
      'SPY买持年化': f1(spyBh.cagrPct) + '%',
      '完美预知(SPY/现金)': f1(p1.cagrPct) + '%',
      '完美预知+2x': f1(p2.cagrPct) + '%',
      '空仓月占比': (p1.cashMonths / p1.totalMonths * 100).toFixed(0) + '%',
    });
  }
  console.log('\n===== 第一部分：月度择时理论天花板（完美预知=100%预测准确率） =====');
  console.table(ceilRows);

  // ===== 第二部分：执行层变体 =====
  const smhStart = [...px.smh.keys()].sort()[0];
  const smhWindow = timeline.filter(t => t.month >= smhStart);
  const runs = [];
  const statsRow = (name, months, weightsOf, note = '') => {
    const full = simulateExecution(months, weightsOf, assetRet, rateMap);
    const sub = simulateExecution(months.filter(t => t.month >= '2010-01'), weightsOf, assetRet, rateMap);
    // 最差单年只在完整日历年（12个收益月）里取，避免首尾残年失真
    const fullYears = [...full.yearly].filter(([y]) => full.yearMonths.get(y) === 12);
    const worst = fullYears.reduce((a, b) => (b[1] < a[1] ? b : a), ['—', Infinity]);
    runs.push({ name, months, weightsOf, full });
    return {
      变体: name,
      样本起: months[0].month,
      全期年化: f1(full.cagrPct) + '%',
      最大回撤: f1(full.mddPct) + '%',
      '2010起年化': f1(sub?.cagrPct) + '%',
      最差单年: `${worst[0]} ${f1(worst[1])}%`,
      '2008年': f1(full.yearly.get('2008')) + '%',
      '2022年': f1(full.yearly.get('2022')) + '%',
      备注: note,
    };
  };
  const rows = [];
  for (const id of ['E0', 'E1', 'E2', 'E3', 'E4', 'E5']) {
    rows.push(statsRow(VARIANT_DESC[id], timeline, VARIANT_WEIGHTS[id]));
  }
  rows.push(statsRow(VARIANT_DESC.E6, smhWindow, VARIANT_WEIGHTS.E6, `SMH ${smhStart} 起`));
  rows.push(statsRow('E0 对照(同E6窗口)', smhWindow, VARIANT_WEIGHTS.E0, `SPY系 ${smhStart} 起`));
  console.log('\n===== 第二部分：进攻执行层变体（信号时间线相同，只换执行层；月末按上月档位调仓） =====');
  console.table(rows);

  // ===== 第三部分：收益来源分解（标的beta vs 择时贡献） =====
  console.log('\n===== 收益来源分解：各标的买入持有（同窗口） vs 执行层 =====');
  const bhRows = [];
  for (const [asset, label, months] of [
    ['spy', 'SPY 买入持有', timeline],
    ['qqq', 'QQQ 买入持有', timeline],
    ['spy2x', '2xSPY(日度再平衡,含费) 买入持有', timeline],
    ['qqq2x', '2xQQQ(日度再平衡,含费) 买入持有', timeline],
    ['smh', `SMH 买入持有（${smhStart}起）`, smhWindow],
  ]) {
    const s = bh(months, asset);
    bhRows.push({ 标的: label, 年化: f1(s.cagrPct) + '%', 最大回撤: f1(s.mddPct) + '%', '2008年': f1(s.yearly.get('2008')) + '%', '2022年': f1(s.yearly.get('2022')) + '%' });
  }
  console.table(bhRows);
  const cagrOf = name => runs.find(r => r.name === name)?.full.cagrPct;
  const bhFull = a => bh(timeline, a).cagrPct;
  const decomp = [
    ['E1(QQQ)', 'qqq'], ['E2(2xSPY)', 'spy2x'], ['E3(2xQQQ)', 'qqq2x'],
  ].map(([tag, asset]) => {
    const variant = runs.find(r => r.name.startsWith(tag.slice(0, 2)))?.full.cagrPct;
    const e0 = cagrOf(VARIANT_DESC.E0);
    const beta = bhFull(asset) - bhFull('spy');
    return {
      变体: tag,
      'E0年化': f1(e0) + '%',
      '变体年化': f1(variant) + '%',
      '总增量(vs E0)': f1(variant - e0) + 'pp',
      '标的beta增量(买持差)': f1(beta) + 'pp',
      '择时×执行交互': f1(variant - e0 - beta) + 'pp',
    };
  });
  console.table(decomp);
}

// 直接运行时执行（被 import / vitest 收集时只导出纯函数）
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(err => { console.error('[execution-layer] failed:', err.message); process.exit(1); });
}
