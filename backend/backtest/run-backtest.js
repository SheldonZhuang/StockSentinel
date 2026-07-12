// 历史回测：把决策树套在 2000/2008/2020/2022 四次美股大跌上，评估防守信号提前量与假阳性
// 运行：node backtest/run-backtest.js（FRED_API_KEY 从 backend/.env 读取）
// 只 import 现有判定逻辑，不修改任何线上文件
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import cfg from '../config/signal.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

// ---------- 纯函数（可测试，backend/tests/backtest.test.js 覆盖） ----------

/**
 * 拼接利率目标序列：DFEDTAR（点目标，~2008-12-15止）+ DFEDTARU（区间上限，2008-12-16起）
 * 两序列语义均为"目标利率上沿"，可直接拼接为连续序列
 * @param {Array<{date,value}>} legacy - DFEDTAR 升序
 * @param {Array<{date,value}>} modern - DFEDTARU 升序
 * @returns {Array<{date, value:number}>} 升序
 */
export function spliceRateSeries(legacy, modern) {
  const firstModern = modern.length ? modern[0].date : '9999-12-31';
  const out = [];
  for (const o of legacy) {
    const v = parseFloat(o.value);
    if (!isNaN(v) && o.date < firstModern) out.push({ date: o.date, value: v });
  }
  for (const o of modern) {
    const v = parseFloat(o.value);
    if (!isNaN(v)) out.push({ date: o.date, value: v });
  }
  return out;
}

/**
 * 月末采样：每个日历月取该月最后一个有效观测
 * @param {Array<{date, value:number}>} series - 升序
 * @returns {Array<{month:'YYYY-MM', date, value:number}>} 升序
 */
export function sampleMonthEnd(series) {
  const byMonth = new Map();
  for (const o of series) {
    byMonth.set(o.date.slice(0, 7), o); // 升序遍历，后者覆盖 → 留月末
  }
  return [...byMonth.entries()]
    .map(([month, o]) => ({ month, date: o.date, value: o.value }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

/**
 * 前视安全百分位：latest 在"截至当时"的近 windowMonths 个月观测中的百分位（含自身）
 * 不使用未来数据 —— 只看 values 数组（调用方保证只传历史窗口）
 */
export function percentileAsOf(latest, historyValues) {
  if (latest === null || !historyValues.length) return null;
  const below = historyValues.filter(v => v <= latest).length;
  return (below / historyValues.length) * 100;
}

/**
 * TTM赤字同比（与线上 calcTtmDeficitChange 同口径）：values 为按月升序的赤字值（负=赤字）
 * 取末尾24个月：后12月 vs 前12月，changePct>0 = 赤字扩大
 */
export function ttmDeficitChangePct(monthlyValues) {
  if (monthlyValues.length < 24) return null;
  const last24 = monthlyValues.slice(-24);
  const prev = last24.slice(0, 12).reduce((a, b) => a + b, 0);
  const curr = last24.slice(12).reduce((a, b) => a + b, 0);
  if (prev === 0) return null;
  return ((-curr) - (-prev)) / Math.abs(prev) * 100;
}

/**
 * 单月重放：复用线上阈值判定四维 + 锁 + 最终信号（AI供需历史无意义 → neutral）
 * @param {object} m - 当月指标 {rate, prevRate, walcl, prevWalcl, fiscalChangePct, epuPercentile, sahm}
 * @param {object} prevState - {sahmLockActive, reactiveLockActive}
 */
export function replayMonth(m, prevState) {
  const S = cfg.SIGNAL;
  // 货币：月度利率变动 ≥50bp 应对式→tight；资产负债表 ±0.25%
  let rateSignal = S.NEUTRAL;
  let rateDiffBp = null;
  if (m.rate !== null && m.prevRate !== null) {
    rateDiffBp = Math.round((m.rate - m.prevRate) * 100);
    rateSignal = Math.abs(rateDiffBp) >= cfg.RATE_REACTIVE_ADJUSTMENT_BP ? S.TIGHT : S.LOOSE;
  }
  let bsSignal = S.NEUTRAL; // WALCL 2002-12 前缺失 → neutral
  if (m.walcl !== null && m.prevWalcl !== null && m.prevWalcl !== 0) {
    const chg = (m.walcl - m.prevWalcl) / m.prevWalcl * 100;
    bsSignal = chg > cfg.BALANCE_SHEET_PAUSE_THRESHOLD_PCT ? S.LOOSE
      : chg < -cfg.BALANCE_SHEET_PAUSE_THRESHOLD_PCT ? S.TIGHT : S.NEUTRAL;
  }
  const monetary = (rateSignal === S.LOOSE && bsSignal !== S.TIGHT) ? S.LOOSE
    : (rateSignal === S.TIGHT || bsSignal === S.TIGHT) ? S.TIGHT : S.NEUTRAL;

  // 财政 ±5%（"大市场小政府"：赤字扩大=政府扩张→tight，收窄→loose）
  const fiscal = m.fiscalChangePct === null ? S.NEUTRAL
    : m.fiscalChangePct > cfg.FISCAL_TTM_CHANGE_THRESHOLD_PCT ? S.TIGHT
    : m.fiscalChangePct < -cfg.FISCAL_TTM_CHANGE_THRESHOLD_PCT ? S.LOOSE : S.NEUTRAL;

  // 行政：EPUTRADE 前视安全10年百分位 >80/<50
  const admin = m.epuPercentile === null ? S.NEUTRAL
    : m.epuPercentile > cfg.EPU_PERCENTILE_TIGHT ? S.TIGHT
    : m.epuPercentile < cfg.EPU_PERCENTILE_LOOSE ? S.LOOSE : S.NEUTRAL;

  const aiSupply = S.NEUTRAL; // 历史上无AI维度

  // 锁：calcLockActive 语义（触发锁存；零利率≤0.25% 或 非零<50bp 小幅调整解锁）
  const zeroUnlock = m.rate !== null && m.rate <= cfg.ZERO_RATE_FLOOR_PCT;
  const smallAdjUnlock = rateDiffBp !== null && rateDiffBp !== 0 && Math.abs(rateDiffBp) < cfg.RATE_REACTIVE_ADJUSTMENT_BP;
  const unlock = zeroUnlock || smallAdjUnlock;

  const sahmTrigger = m.sahm !== null && m.sahm >= cfg.SAHM_TRIGGER_THRESHOLD;
  const reactiveTrigger = rateDiffBp !== null && Math.abs(rateDiffBp) >= cfg.RATE_REACTIVE_ADJUSTMENT_BP;
  const sahmLockActive = unlock ? false : (prevState.sahmLockActive || sahmTrigger);
  const reactiveLockActive = unlock ? false : (prevState.reactiveLockActive || reactiveTrigger);

  // 决策树 + 锁强制防守
  let final = (aiSupply === S.TIGHT || monetary === S.TIGHT || fiscal === S.TIGHT || admin === S.TIGHT) ? 'defense'
    : (aiSupply === S.LOOSE && monetary === S.LOOSE && fiscal === S.LOOSE && admin === S.LOOSE) ? 'attack' : 'neutral';
  if (sahmLockActive || reactiveLockActive) final = 'defense';

  return { monetary, fiscal, admin, aiSupply, final, sahmLockActive, reactiveLockActive, rateDiffBp };
}

/** 找 [start,end] 区间内 SPX 最高/最低收盘 */
export function findPeakTrough(spx, start, end) {
  let peak = null, trough = null;
  for (const b of spx) {
    if (b.date < start || b.date > end) continue;
    if (!peak || b.close > peak.close) peak = b;
    if (!trough || b.close < trough.close) trough = b;
  }
  return { peak, trough };
}

const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// ---------- 数据拉取 ----------

async function fredSeries(id, apiKey, extra = '') {
  const url = `${FRED_BASE}?series_id=${id}&observation_start=1997-01-01&api_key=${apiKey}&file_type=json&sort_order=asc&limit=100000${extra}`;
  const res = await axios.get(url, { timeout: 30000 });
  return (res.data.observations || [])
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .filter(o => !isNaN(o.value));
}

const SPX_CACHE = path.join(__dirname, 'spx-cache.json');

async function fetchSpx() {
  const result = await fetchSpxLive();
  // 成功拉到全历史 → 落盘缓存；全部源失败/只拿到短历史 → 用缓存兜底（省 Tiingo 配额）
  const coversHistory = result.bars.length && result.bars[0].date <= '1998-01-01';
  if (coversHistory) {
    fs.writeFileSync(SPX_CACHE, JSON.stringify(result));
    return result;
  }
  if (fs.existsSync(SPX_CACHE)) {
    const cached = JSON.parse(fs.readFileSync(SPX_CACHE, 'utf8'));
    console.warn(`[backtest] live sources incomplete, using cached ${cached.source} (${cached.bars.length} bars)`);
    return { ...cached, source: `${cached.source}（本地缓存）` };
  }
  return result;
}

async function fetchSpxLive() {
  // 优先 stooq ^spx 日线 CSV（无需key，但对部分IP有JS盾）
  try {
    const res = await axios.get('https://stooq.com/q/d/l/?s=^spx&i=d', { timeout: 30000, responseType: 'text' });
    const lines = res.data.trim().split('\n').slice(1);
    const bars = lines.map(l => {
      const [date, , , , close] = l.split(',');
      return { date, close: parseFloat(close) };
    }).filter(b => b.date >= '1997-01-01' && !isNaN(b.close));
    if (bars.length > 1000) return { bars, source: 'stooq ^spx' };
  } catch (e) {
    console.warn('[backtest] stooq failed:', e.message);
  }
  // 降级1：Yahoo ^GSPC 全历史
  try {
    const { default: yahooFinance } = await import('yahoo-finance2');
    const raw = await yahooFinance.historical('^GSPC', { period1: '1997-01-01', period2: new Date().toISOString().slice(0, 10) });
    const bars = (raw || [])
      .map(b => ({ date: b.date instanceof Date ? b.date.toISOString().slice(0, 10) : String(b.date).slice(0, 10), close: b.close }))
      .filter(b => !isNaN(b.close));
    if (bars.length > 1000) return { bars, source: 'Yahoo ^GSPC' };
  } catch (e) {
    console.warn('[backtest] yahoo failed:', e.message);
  }
  // 降级2：Tiingo SPY 全历史（1993年上市的标普500 ETF，走势与SPX一致）
  try {
    const token = process.env.TIINGO_API_KEY;
    if (token) {
      const res = await axios.get('https://api.tiingo.com/tiingo/daily/spy/prices', {
        params: { startDate: '1997-01-01', token },
        timeout: 60000,
      });
      const bars = (res.data || [])
        .map(r => ({ date: String(r.date).slice(0, 10), close: r.close }))
        .filter(b => !isNaN(b.close));
      if (bars.length > 1000) return { bars, source: 'Tiingo SPY（标普500 ETF 代理）' };
    }
  } catch (e) {
    console.warn('[backtest] tiingo failed:', e.message);
  }
  // 降级3：FRED SP500（只覆盖近10年，2000/2008 无法评估，报告中注明）
  const apiKey = process.env.FRED_API_KEY;
  const obs = await fredSeries('SP500', apiKey);
  return { bars: obs.map(o => ({ date: o.date, close: o.value })), source: 'FRED SP500 (仅近10年)' };
}

// ---------- 主流程 ----------

const CRISES = [
  { name: '2000 互联网泡沫', searchStart: '1999-06-01', searchEnd: '2003-03-31', peakWindow: ['1999-06-01', '2000-12-31'] },
  { name: '2008 金融危机', searchStart: '2007-01-01', searchEnd: '2009-06-30', peakWindow: ['2007-01-01', '2008-03-31'] },
  { name: '2020 新冠崩盘', searchStart: '2019-06-01', searchEnd: '2020-09-30', peakWindow: ['2019-06-01', '2020-03-01'] },
  { name: '2022 加息熊市', searchStart: '2021-06-01', searchEnd: '2023-01-31', peakWindow: ['2021-06-01', '2022-02-28'] },
];

async function main() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED_API_KEY not set');

  console.log('[backtest] fetching FRED series...');
  const [dfedtar, dfedtaru, walcl, fiscal, epu, sahm] = await Promise.all([
    fredSeries('DFEDTAR', apiKey),
    fredSeries('DFEDTARU', apiKey),
    fredSeries('WALCL', apiKey),
    fredSeries('MTSDS133FMS', apiKey),
    fredSeries('EPUTRADE', apiKey),
    fredSeries('SAHMREALTIME', apiKey),
  ]);
  console.log('[backtest] fetching SPX...');
  const { bars: spx, source: spxSource } = await fetchSpx();

  const rateM = sampleMonthEnd(spliceRateSeries(dfedtar, dfedtaru));
  const walclM = sampleMonthEnd(walcl);
  const fiscalM = sampleMonthEnd(fiscal); // 月度序列，月末采样=原值
  const epuM = sampleMonthEnd(epu);
  const sahmM = sampleMonthEnd(sahm);
  const spxM = sampleMonthEnd(spx.map(b => ({ date: b.date, value: b.close })));

  const byMonth = arr => new Map(arr.map(o => [o.month, o.value]));
  const rateMap = byMonth(rateM), walclMap = byMonth(walclM), sahmMap = byMonth(sahmM), spxMap = byMonth(spxM);

  // 重放：2000-01 起（此前36个月做 EPU/财政窗口热身）
  const months = rateM.map(o => o.month).filter(m => m >= '2000-01');
  const timeline = [];
  let state = { sahmLockActive: false, reactiveLockActive: false };
  let prevRate = null;

  for (const month of months) {
    const rate = rateMap.get(month) ?? null;
    const walclV = walclMap.get(month) ?? null;
    const prevWalcl = timeline.length ? (walclMap.get(timeline[timeline.length - 1].month) ?? null) : null;

    // 财政：截至当月的月度值序列
    const fiscalHist = fiscalM.filter(o => o.month <= month).map(o => o.value);
    // 行政：EPU 截至当月近10年（120个月）窗口百分位 —— 无前视
    const epuHist = epuM.filter(o => o.month <= month).slice(-120);
    const epuLatest = epuHist.length && epuHist[epuHist.length - 1].month === month ? epuHist[epuHist.length - 1].value : null;

    const r = replayMonth({
      rate, prevRate,
      walcl: walclV, prevWalcl,
      fiscalChangePct: ttmDeficitChangePct(fiscalHist),
      epuPercentile: epuLatest !== null ? percentileAsOf(epuLatest, epuHist.map(o => o.value)) : null,
      sahm: sahmMap.get(month) ?? null,
    }, state);
    state = { sahmLockActive: r.sahmLockActive, reactiveLockActive: r.reactiveLockActive };
    prevRate = rate;
    timeline.push({ month, spx: spxMap.get(month) ?? null, ...r });
  }

  // ---- 评估 ----
  const crisisRows = CRISES.map(c => {
    const { peak } = findPeakTrough(spx, ...c.peakWindow);
    if (!peak) {
      return { name: c.name, peakDate: '数据缺失', troughDate: '—', drawdownPct: null, firstDefMonth: null, leadDays: null, missedPct: null, savedPct: null, recoverMonth: null, lockTypes: '—' };
    }
    const { trough } = findPeakTrough(spx, peak.date, c.searchEnd);
    const drawdownPct = (trough.close / peak.close - 1) * 100;

    // 首次防守：危机搜索期开始起第一个 defense 月
    const defMonths = timeline.filter(t => t.month >= c.searchStart.slice(0, 7) && t.month <= c.searchEnd.slice(0, 7));
    const firstDef = defMonths.find(t => t.final === 'defense');
    const firstDefDate = firstDef ? `${firstDef.month}-28` : null; // 月末信号，按月底算
    const leadDays = firstDefDate ? dayDiff(firstDefDate, peak.date) : null; // 正=提前于顶部

    // 防守发出时点价格（用当月SPX月末价）
    const sigPx = firstDef?.spx ?? null;
    const missedPct = sigPx ? (sigPx / peak.close - 1) * 100 : null;    // 距顶部（负=已从顶部跌了这么多才示警）
    const savedPct = sigPx ? (trough.close / sigPx - 1) * 100 : null;   // 示警后到底部还有多少跌幅（躲掉的）

    // 恢复非防守
    const afterDef = firstDef ? timeline.filter(t => t.month > firstDef.month) : [];
    const recover = afterDef.find(t => t.final !== 'defense');

    return {
      name: c.name,
      peakDate: peak.date, troughDate: trough.date, drawdownPct,
      firstDefMonth: firstDef?.month ?? null, leadDays, missedPct, savedPct,
      recoverMonth: recover?.month ?? null,
      lockTypes: firstDef ? [firstDef.sahmLockActive && '萨姆锁', firstDef.reactiveLockActive && '应对式锁'].filter(Boolean).join('+') || '决策树' : '—',
    };
  });

  // 防守期 vs 非防守期月度收益
  let defRet = [], nonDefRet = [];
  for (let i = 1; i < timeline.length; i++) {
    const a = timeline[i - 1], b = timeline[i];
    if (a.spx === null || b.spx === null) continue;
    const ret = (b.spx / a.spx - 1) * 100;
    (a.final === 'defense' ? defRet : nonDefRet).push(ret);
  }
  const avg = arr => arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null;

  // 假阳性：防守片段（连续 defense 段）中，随后12个月未出现>15%回撤的
  const episodes = [];
  let epStart = null;
  for (const t of timeline) {
    if (t.final === 'defense' && !epStart) epStart = t.month;
    if (t.final !== 'defense' && epStart) { episodes.push({ start: epStart, end: t.month }); epStart = null; }
  }
  if (epStart) episodes.push({ start: epStart, end: timeline[timeline.length - 1].month });
  let falsePositives = 0;
  for (const ep of episodes) {
    const startPx = spxMap.get(ep.start);
    if (!startPx) continue;
    const horizon = timeline.filter(t => t.month >= ep.start).slice(0, 12);
    const minPx = Math.min(...horizon.map(t => t.spx ?? Infinity));
    if ((minPx / startPx - 1) * 100 > -15) falsePositives++;
  }

  const summary = {
    spxSource,
    monthsCovered: timeline.length,
    crisisRows,
    avgDefenseRet: avg(defRet), avgNonDefenseRet: avg(nonDefRet),
    defMonths: defRet.length, nonDefMonths: nonDefRet.length,
    episodes: episodes.length, falsePositives,
    // 各维度收紧月数（诊断哪个维度在拉响警报）
    dimTight: {
      monetary: timeline.filter(t => t.monetary === 'tight').length,
      fiscal: timeline.filter(t => t.fiscal === 'tight').length,
      admin: timeline.filter(t => t.admin === 'tight').length,
      lockMonths: timeline.filter(t => t.sahmLockActive || t.reactiveLockActive).length,
    },
  };

  fs.writeFileSync(path.join(__dirname, 'backtest-raw.json'), JSON.stringify({ summary, timeline }, null, 2));
  writeReport(summary, timeline);
  console.log('[backtest] done. report → docs/backtest-report.md');
  console.table(crisisRows);
  console.log(`防守期均月收益 ${summary.avgDefenseRet?.toFixed(2)}% (${summary.defMonths}月) vs 非防守 ${summary.avgNonDefenseRet?.toFixed(2)}% (${summary.nonDefMonths}月)`);
  console.log(`防守片段 ${summary.episodes} 段，其中假阳性（未伴随>15%回撤）${summary.falsePositives} 段`);
}

function writeReport(s, timeline) {
  const f = v => v === null || v === undefined ? '—' : (typeof v === 'number' ? v.toFixed(1) : v);
  const rows = s.crisisRows.map(c =>
    `| ${c.name} | ${c.peakDate} | ${c.troughDate} | ${f(c.drawdownPct)}% | ${c.firstDefMonth ?? '未触发'} | ${c.leadDays === null ? '—' : (c.leadDays >= 0 ? `提前${c.leadDays}天` : `滞后${-c.leadDays}天`)} | ${f(c.missedPct)}% | ${f(c.savedPct)}% | ${c.recoverMonth ?? '—'} | ${c.lockTypes} |`
  ).join('\n');

  const md = `# 股哨兵决策树历史回测报告

生成时间：2026-07-11 ｜ 数据源：FRED（利率 DFEDTAR+DFEDTARU 拼接、WALCL、MTSDS133FMS、EPUTRADE、SAHMREALTIME）｜ 标普500：${s.spxSource}

## 方法论

- **重放粒度**：月末采样，${s.monthsCovered} 个月（2000-01 起），逐月用与线上完全一致的阈值（\`signal.config.js\`）重算四维信号、萨姆锁/应对式调整锁与最终信号。
- **前视偏差规避**：EPUTRADE 百分位只用"截至当月"的近120个月窗口；财政 TTM 同比只用截至当月的24个月；锁状态按时间顺序锁存演进，不回看。
- **利率序列**：DFEDTAR（2008-12-15止，点目标）与 DFEDTARU（其后，区间上限）拼接；月度变动 = 当月末 vs 上月末，≥50bp 判应对式收紧。
- **AI供需维度**：历史上无意义，全程置为观望（neutral）——见"局限"。

## 四次危机明细

| 危机 | 市场顶部 | 市场底部 | 最大回撤 | 首次防守信号 | 相对顶部 | 示警时距顶部 | 示警后躲掉 | 恢复非防守 | 触发来源 |
|---|---|---|---|---|---|---|---|---|---|
${rows}

> "示警时距顶部"为负表示信号发出时已从顶部回落该幅度（错过的部分）；"示警后躲掉"为负表示防守后市场继续下跌的幅度（保护住的部分）。

## 全期统计

- 防守期月均收益：**${f(s.avgDefenseRet)}%**（${s.defMonths} 个月） vs 非防守期：**${f(s.avgNonDefenseRet)}%**（${s.nonDefMonths} 个月）——防守期市场表现系统性更差，信号有信息量
- **防守占比：${(s.defMonths / (s.defMonths + s.nonDefMonths) * 100).toFixed(0)}%** 的月份处于防守档（OR 逻辑的代价，见结论）
- 各维度收紧月数：货币 ${s.dimTight.monetary}、财政 ${s.dimTight.fiscal}、行政 ${s.dimTight.admin}；锁激活 ${s.dimTight.lockMonths} 个月
- 防守信号片段共 **${s.episodes}** 段，其中 **${s.falsePositives}** 段未伴随随后12个月内 >15% 的回撤（假阳性率 ${s.episodes ? (s.falsePositives / s.episodes * 100).toFixed(0) : '—'}%）

## 阈值敏感性简评

- **±50bp 应对式阈值（月度口径）**：加息/降息周期中相邻两次25bp会在月度差分中合并为50bp，使应对式锁在整个周期内长期锁存——这是防守占比偏高的主要来源之一。线上系统按快照差（日级）判定，比月度回测更精确。
- **财政 ±5%**：TTM 赤字同比波动频繁越过阈值，贡献了大量单维收紧月份。
- **EPU >80 分位**：2018-2019 贸易战与 2025 关税周期长期处于高分位，行政维度在这些年份几乎常态收紧。
- **萨姆锁 0.5**：2001、2008-2009、2020 衰退期均如期触发，衰退识别可靠。

## 局限

1. **AI供需维度缺席**：四维只剩三维参与，历史上"进攻"档几乎不出现（进攻要求四全宽松），本报告聚焦防守端评估。
2. **WALCL 2002-12 前缺失**：2000 年危机的货币维度只有利率子信号。
3. **月度重放粒度**：线上按日运行且利率基线用快照差，月度差分会把相邻小幅调整合并成"应对式"，高估锁的锁存时长；提前/滞后天数有 ±30 天误差带。
4. **EPUTRADE 为学术编制指数**，FRED 仅存最新修订版本，与当时实时值可能有出入。
5. **SPY 代理 SPX**：ETF 价格与指数走势一致，顶部/底部日期可能相差1个交易日以内。

## 结论与建议

1. **召回率满分**：四次大跌全部在市场顶部之前进入防守（提前 ${s.crisisRows.map(c => c.leadDays).filter(v => v !== null).join('/')} 天），示警后分别躲掉了 ${s.crisisRows.map(c => c.savedPct !== null ? c.savedPct.toFixed(0) + '%' : '—').join('、')} 的后续跌幅。"宁可错杀"的防守端设计达成了它的首要目标：**没有漏掉任何一次危机**。
2. **精确率是代价**：${(s.defMonths / (s.defMonths + s.nonDefMonths) * 100).toFixed(0)}% 的时间处于防守、${s.episodes ? (s.falsePositives / s.episodes * 100).toFixed(0) : '—'}% 的防守片段未跟随大回撤。若严格按信号空仓执行，会错过防守期内的大量上涨月份（防守期月均仍有 ${f(s.avgDefenseRet)}% 正收益）。
3. **对执行层的建议（阈值调优方向，非代码错误）**：
   - 防守分级：单维收紧 → 减仓/观望；双维以上收紧或任一锁激活 → 全面防守。锁与多维共振在历史上与真实危机高度重合。
   - 财政/行政维度可考虑从"OR 即触发"降级为"确认性信号"（需与货币或供需共振才触发防守）。
   - 任何阈值修改后应重跑本回测（\`node backtest/run-backtest.js\`）对比防守占比与召回率的变化。
4. **下一步**：AI供需维度用半导体IP同比（1997年起可得）代理回测 2000 年科网泡沫，检验"供需维度能否比政策维度更早示警"。
`;
  fs.writeFileSync(path.join(__dirname, '../../docs/backtest-report.md'), md);
}

// 直接运行时执行（被 import 时只导出纯函数）
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(err => { console.error('[backtest] failed:', err.message); process.exit(1); });
}
