// 历史回测：把决策树套在 2000/2008/2020/2022 四次美股大跌上，评估防守信号提前量与假阳性
// 运行：node backtest/run-backtest.js（FRED_API_KEY 从 backend/.env 读取）
//       node backtest/run-backtest.js --eval  → 遍历规则变体组合打印对照表（不写报告文件）
// 只 import 现有判定逻辑，不修改任何线上文件
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import cfg from '../config/signal.config.js';
import { calcLockActive, applyDowngradeHold, calcFinalSignal, applyTrendReentry } from '../api/signal.js';
// M系评估用片段判定（循环引用安全：accuracy-report.mjs 反向 import 本文件，双方只在运行期调用
// 对方的顶层函数声明——ESM 函数声明在模块求值前已初始化，两个入口 argv 判定互斥不会双触发 main）
import { episodesOf, crisisSpansOf, episodeVerdict } from './accuracy-report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

// ---------- 规则变体开关（2026-07-17 评估定稿；W系第二轮同日采纳W5） ----------
// V3(最短锁存期)+V4(降档迟滞) 组合评估后采纳为基线（年化11.3→11.7%、08覆盖66.7→94.4%、
// 2020覆盖80→100%、假阳性20/26→17/19），默认开启并复用线上 calcLockActive/applyDowngradeHold；
// V1/V2/V5/V6 评估否决保持关闭。第二轮（2010起跑输买入持有2.3pp/年归因驱动）采纳 W5 趋势再入场，
// W1-W4 否决保持关闭（对照表可用 --eval 模式复现）。
export const VARIANTS_DEFAULT = {
  trendConfirm: false,        // V1 趋势确认层【否决：年化-1.0pp；2007-10月末价仍在10月SMA上方，拦不住该解锁，只剩复苏晚入场代价】
  cutLockDirUnlock: false,    // V2 降息锁方向约束【否决：年化-0.5pp；2001锁到2004-06、2025-10起锁死至今——分化解锁问题窄化重现】
  minLockMonths: 2,           // V3 最短锁存期【采纳】：锁触发后至少2个月才允许小幅调整解锁 = 线上 LOCK_MIN_AGE_DAYS(60天)÷30天标准月
  downgradeHysteresis: true,  // V4 档位迟滞【采纳】：降档需连续2个月更宽松才生效 = 线上 FINAL_DOWNGRADE_CONFIRM_DAYS(30天)确认期
  realRateCap: false,         // V5 实际利率封顶【否决：非对称进攻树只数tight票，货币loose→neutral不改变任何档位，结构性无影响】
  aiSemi: false,              // V6 AI维半导体代理【否决：年化-1.4pp；2019全年防守-12.2pp；2000科网同比+43~52%投宽松票，无提前示警】
  // ---- 2026-07-17 第二轮（W系，针对"2010起跑输买入持有2.3pp/年"归因：假阳性段-1.07pp/年、
  //      V4迟滞多扛月-0.90pp/年、真危机段0——2010后13段防守片段全部假阳性，见 backtest/attribution.mjs） ----
  defenseNeedsFinancial: false, // W1 防守共振须含金融维【否决：召回5/6→3/6，2020/2025全靠财政+行政共振示警，硬伤】
  epuTightPercentile: null,     // W2 行政tight阈值覆盖(如90)【否决：08覆盖94→89%打穿硬约束——丢的是2009-01迟滞尾巴月(SPY-8.6%)，08少亏58.1→46.0pp】
  fiscalConfirmOnly: false,     // W3 财政确认性信号【否决：同W1丢2020/2025召回(3/6)——财政票正是这两场的共振来源】
  hysteresisConfirmDays: null,  // W4a 迟滞确认期覆盖(天)【搁置：月度粒度下(0,30]天都等价"等1个采样月"，与30天不可分，只能线上日频评估】
  hysteresisLockOnly: false,    // W4b 迟滞只保护锁驱动defense降档【否决：同W2打穿08覆盖——2008-12树防守降档即时生效，丢2009-01护月】
  // W5 趋势再入场加速器【采纳 2026-07-17】：月末SPX≥10月SMA时决策树驱动的defense降级reduce（锁驱动不受影响
  // ——锁是确证的危机应对，不被趋势否决）。归因主力精准命中：2016-19"货币+EPU高位"假阳性群与
  // 2024-25萨姆锁段续命月全部压掉。全期11.7→12.2%、2010起12.3→12.9%（与买持差距2.3→1.7pp/年）、
  // 假阳性17/19→6/8、防守占比38%→25%、2008覆盖94%/少亏58.1pp不变；
  // 代价：2020首防提前111天→滞后9天（少亏14.8→12.6pp、覆盖仍100%）、2025少亏6.6→1.2pp
  trendReentry: true,
  // ---- 2026-07-18 第三轮（X系，准确率归因 backtest/accuracy-report.mjs 驱动）：采纳 X1+X3 ----
  // 效果：全期年化 12.2→12.4%、纯误报防守段 3→2（假阳性严格口径 6/8→5/7）、防守月 79→76；
  // 召回 5/6、2008覆盖 94.4%/少亏 58.1pp、回撤 -16.2% 全部不变——逐月 diff 仅 4 个月档位变化
  // 且全踩在上涨月（2004-08/09/10、2024-08）。同轮否决：X1b 全部锁过趋势门【砸掉2008顶前入场，
  // 08少亏 58.1→50.7pp】；X2 货币决议方向口径【年化-0.1pp、假阳性+1段；同时证明月度回测与线上
  // 决议口径差≤0.1pp/年，2022滞后148天与口径无关】；X4 萨姆确认2月【锁存延迟拖累2008-09入场，
  // 08覆盖 94.4→88.9% 打穿硬约束，而对2024误触发只延迟1个月（0.53/0.57连续两月≥0.5）】
  sahmLockTrendReentry: true,    // X1【采纳】萨姆锁驱动defense也过W5趋势门（应对式锁仍豁免）＝线上 applyTrendReentry
  defenseNeedsAdminOrLock: true, // X3【采纳】纯"货币+财政"双维共振降reduce（最窄口径）＝线上 calcFinalSignal 内置
  // ---- 2026-07-18 第四轮（M系，市场/估值第5维评估）：针对 2000滞后68天/2022滞后148天——
  // 现有四维全是宏观慢变量，抓不到预期驱动的顶。全部默认关，采纳由主会话定；对照表 --eval-m 复现。
  // 评估结论（硬约束=召回≥5/6·08覆盖≥90%·年化≥12.1%）：**没有任何变体移动2000/2022的首防月份**，
  // 滞后在此框架内不可安全压缩——两条结构性根因：①W5趋势门（12.35%基线的支柱）只允许趋势下方的
  // 树驱动defense，而"预警"按定义发生在趋势上方（M3f诊断：关W5后CAPE+货币共振确实让2000提前24天/
  // 2022提前187天，但年化10.41%、纯误报2→10段、实际少亏反而降低45.8→44.8pp/6.6→5.9pp——踏空成本
  // 超过躲掉的下跌）；②市场票只能在破位后触发，2000月末破位(2000-09)晚于应对锁(2000-05)四个月，
  // 2022破位月(02/04)与货币tight月(03/05)在月度采样上恰好错开（X2+M1修口径也只04：滞后148→116天，
  // 少亏反降6.6→6.4pp，年化9.00%砸穿）。各变体：M1 9.79%(-2.6pp，复苏期市场+财政共振：2009-02~06/
  // 2011-10~12/2015-08~09/2018-10~11/2020-05全是V型底右侧)；M1x与M1逐位一致（市+货纯双维从未出现）；
  // M2@10/15 11.00/11.07%(新增防守月全在2009复苏段)；M1b 12.26%过约束但对2000/2022零影响且复活
  // 2004-08假阳性段；M3c与基线逐位一致（确认票从未触发）；M3f 11.73%(2026-03/04新增纯误报段)
  m1TrendVote: false,        // M1 趋势票：月末SPX<10月SMA → 市场维tight（计入≥2共振；高于SMA→neutral不投loose）
  marketConfirmOnly: false,  // M1b 市场票仅确认票：自己不凑数，四维自身≥2共振被X3降档时+1票恢复defense
  marketMonetaryReduce: false, // M1x 市场+货币纯双维共振比照X3降reduce（验证与X3交互）
  m2DrawdownPct: null,       // M2 距52周高点票：月末收盘距52周最高收盘回撤≥该值(%)→市场维tight（如10/15）
  capeConfirmVote: false,    // M3c 席勒CAPE 30年滚动分位>90 → 仅确认票（M-1可见，multpl.com月度）
  capeFullVote: false,       // M3f CAPE独立票（诊断用：验证"2017-2021常态高位→假阳性泛滥"预期）
};
export const REAL_RATE_CAP_PCT = 1.5; // V5 阈值：实际利率超过此值即"高实际利率环境"，宽松票作废

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
 * TTM同比（联邦支出等正值月度序列，与线上 calcTtmChange 同口径）：values 按月升序
 * 取末尾24个月：后12月 vs 前12月，changePct>0 = 支出扩大（政府变大）
 */
export function ttmChangePct(monthlyValues) {
  if (monthlyValues.length < 24) return null;
  const last24 = monthlyValues.slice(-24);
  const prev = last24.slice(0, 12).reduce((a, b) => a + b, 0);
  const curr = last24.slice(12).reduce((a, b) => a + b, 0);
  if (prev === 0) return null;
  return (curr / prev - 1) * 100;
}

/**
 * 末端N期简单均线（V1 趋势确认层用：月末收盘10月SMA）
 * @param {number[]} values - 升序数值数组
 * @returns {number|null} 不足N期 → null（调用方跳过该规则）
 */
export function smaLast(values, n) {
  if (!Array.isArray(values) || values.length < n) return null;
  return values.slice(-n).reduce((a, b) => a + b, 0) / n;
}

/**
 * M2：距过去52周（lookbackDays 日历日）最高收盘的回撤（%，≤0）。
 * 窗口 = (asOfDate−lookbackDays, asOfDate]，含 asOfDate 当日；最新收盘=窗口内最后一根 bar。
 * 窗口内无 bar → null（调用方跳过该规则）
 * @param {Array<{date, close:number}>} bars - 日线升序
 */
export function rollingHighDrawdownPct(bars, asOfDate, lookbackDays = 365) {
  const startDate = new Date(new Date(`${asOfDate}T00:00:00Z`).getTime() - lookbackDays * 86400000)
    .toISOString().slice(0, 10);
  let last = null, high = null;
  for (const b of bars) {
    if (b.date > asOfDate) break;
    if (b.date <= startDate || !Number.isFinite(b.close)) continue;
    if (high === null || b.close > high) high = b.close;
    last = b.close;
  }
  if (last === null || !high) return null;
  return (last / high - 1) * 100;
}

/**
 * M3：解析 multpl.com Shiller PE 月度表（https://www.multpl.com/shiller-pe/table/by-month）。
 * 行格式：<td>Jul 1, 2026</td> <td> &#x2002; 41.10 </td>；当月行日期可能是月中（如 Jul 17）。
 * 同月多条时保留页面靠前（更新）的一条；返回按月升序
 * @returns {Array<{month:'YYYY-MM', value:number}>}
 */
export function parseMultplCape(html) {
  const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const re = /<td>([A-Z][a-z]{2}) \d{1,2}, (\d{4})<\/td>\s*<td[^>]*>(?:&[#\w]+;|\s)*([\d.]+)/g;
  const byMonth = new Map();
  let m;
  while ((m = re.exec(html)) !== null) {
    const mm = MONTHS[m[1]];
    const v = parseFloat(m[3]);
    if (!mm || isNaN(v)) continue;
    const month = `${m[2]}-${mm}`;
    if (!byMonth.has(month)) byMonth.set(month, v); // 页面倒序，先见=最新
  }
  return [...byMonth.entries()]
    .map(([month, value]) => ({ month, value }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

/**
 * W4a：确认期可参数化的降档迟滞（逻辑与线上 applyDowngradeHold 逐位一致，仅确认天数可覆盖）。
 * 升档/持平即时生效并清空等待；降档需候选档持续满 confirmDays 天。
 * 注意：月度重放的合成日历步长为30天，任何 confirmDays∈(0,30] 都等价于"等1个采样月"——
 * 14天与30天在月度粒度下不可区分，差异只在线上日频运行中体现
 * @returns {{signal: string, pendingSince: string|null}}
 */
export function applyDowngradeHoldWithDays(candidate, prevEffective, pendingSince, today, confirmDays) {
  const severity = s => ({ defense: 3, reduce: 2, neutral: 1, attack: 0 })[s] ?? 1;
  if (!prevEffective || severity(candidate) >= severity(prevEffective)) {
    return { signal: candidate, pendingSince: null };
  }
  const since = pendingSince || today;
  const ageDays = Math.floor((Date.parse(today) - Date.parse(since)) / 86400000);
  if (ageDays >= confirmDays) return { signal: candidate, pendingSince: null };
  return { signal: prevEffective, pendingSince: since };
}

/**
 * 单月重放：复用线上阈值判定四维 + 锁 + 最终信号（AI供需历史无意义 → neutral；V6 变体例外）
 * @param {object} m - 当月指标 {rate, prevRate, walcl, prevWalcl, fiscalChangePct, epuPercentile, sahm,
 *   oilChangePct, spxBelowSma10, realRatePct, semiYoy, dd52wPct, capePercentile}
 *   dd52wPct = 月末收盘距52周最高收盘回撤%（M2用）；capePercentile = CAPE 30年滚动分位（M3用，M-1可见）
 *   walcl/prevWalcl = 采样时点可得的最新两条 WALCL 周度观测（lastTwoWeeklyAsOf，与线上 fetch-macro 同口径）
 * @param {object} prevState - {sahmLockActive, reactiveLockActive, reactiveLockDir, sahmLockAge, reactiveLockAge}
 * @param {object} variants - 变体开关（缺省全关 = 基线，与既有行为逐位一致）
 */
export function replayMonth(m, prevState, variants = {}) {
  const S = cfg.SIGNAL;
  // 货币方向规则（与线上 deriveSubSignals 同口径）：任何加息→tight；降息/暂停→loose。
  // 单次|Δ|≥50bp 另触发应对式利率锁（下方）。资产负债表 ±0.25%
  let rateSignal = S.NEUTRAL;
  let rateDiffBp = null;
  if (m.rate !== null && m.prevRate !== null) {
    rateDiffBp = Math.round((m.rate - m.prevRate) * 100);
    rateSignal = rateDiffBp > 0 ? S.TIGHT : S.LOOSE; // 加息→收紧；降息/暂停→宽松
    // X2 货币决议方向近似（默认关，accuracy-report.mjs --variants 评估用）：月度差分把
    // "本月无利率变动"一律判宽松，而线上按"最近一次FOMC决议方向"判定——无会议月应沿用上次方向。
    // diff=0 时沿用上月 rateSignal 是决议方向口径的紧缩上界（暂停决议在线上也判宽松，此处无法区分无会议/暂停）
    if (variants.monetaryCarryDir && rateDiffBp === 0 && prevState.rateSignal
      && prevState.rateSignal !== S.NEUTRAL) rateSignal = prevState.rateSignal;
  }
  let bsSignal = S.NEUTRAL; // WALCL 2002-12 前缺失 → neutral
  if (m.walcl !== null && m.prevWalcl !== null && m.prevWalcl !== 0) {
    const chg = (m.walcl - m.prevWalcl) / m.prevWalcl * 100;
    bsSignal = chg > cfg.BALANCE_SHEET_PAUSE_THRESHOLD_PCT ? S.LOOSE
      : chg < -cfg.BALANCE_SHEET_PAUSE_THRESHOLD_PCT ? S.TIGHT : S.NEUTRAL;
  }
  // QT只拦截宽松不定罪收紧（与线上 calcMonetarySignal 同口径）
  let monetary = rateSignal === S.TIGHT ? S.TIGHT
    : (rateSignal === S.LOOSE && bsSignal !== S.TIGHT) ? S.LOOSE : S.NEUTRAL;
  // V5 实际利率封顶：政策利率−核心PCE同比 > +1.5%（高实际利率=环境本身偏紧）时 loose 封顶 neutral（tight不变）
  if (variants.realRateCap && monetary === S.LOOSE
    && m.realRatePct !== null && m.realRatePct !== undefined
    && m.realRatePct > REAL_RATE_CAP_PCT) monetary = S.NEUTRAL;

  // 财政：实际支出同比（名义TTM同比 − 同期TTM通胀），与线上 fetchFiscalData 同口径。
  // 剔除通胀让阈值围绕零漂移，消除名义支出自然增速导致的"预挂收紧"
  const fiscal = m.fiscalChangePct === null ? S.NEUTRAL
    : m.fiscalChangePct > cfg.FISCAL_TTM_CHANGE_THRESHOLD_PCT ? S.TIGHT
    : m.fiscalChangePct < -cfg.FISCAL_TTM_CHANGE_THRESHOLD_PCT ? S.LOOSE : S.NEUTRAL;

  // 行政：油价事件层（月环比±20%≈30天窗口）优先，其次 EPUTRADE 前视安全10年百分位。
  // 飙升/暴跌侧对称护栏（与线上 calcAdminSignal 同口径）：仅EPU高位时飙升判战争冲击tight，
  // EPU平静时的油价大涨=需求复苏(V型底右侧最佳买点)不误判防守
  // W2：行政tight阈值可覆盖（80→如90分位），油价护栏的 epuHigh 同步用覆盖值保持口径一致
  const epuTightTh = variants.epuTightPercentile ?? cfg.EPU_PERCENTILE_TIGHT;
  const epuHigh = m.epuPercentile !== null && m.epuPercentile > epuTightTh;
  const oilEvent = m.oilChangePct !== null && m.oilChangePct !== undefined
    ? (m.oilChangePct >= cfg.OIL_SHOCK_PCT && epuHigh ? S.TIGHT
      : (m.oilChangePct <= -cfg.OIL_SHOCK_PCT && m.epuPercentile !== null && !epuHigh) ? S.LOOSE : null)
    : null;
  const admin = oilEvent !== null ? oilEvent
    : m.epuPercentile === null ? S.NEUTRAL
    : m.epuPercentile > epuTightTh ? S.TIGHT
    : m.epuPercentile < cfg.EPU_PERCENTILE_LOOSE ? S.LOOSE : S.NEUTRAL;

  // V6：AI维用半导体产出同比（IPG3344S，1972年起全程可得）做唯一子信号回放，阈值与线上 semi 子信号一致；
  // 基线（变体关）保持历史上无AI维度 → neutral
  let aiSupply = S.NEUTRAL;
  if (variants.aiSemi && m.semiYoy !== null && m.semiYoy !== undefined) {
    aiSupply = m.semiYoy > cfg.AI_SEMI_IP_YOY_LOOSE_PCT ? S.LOOSE
      : m.semiYoy < cfg.AI_SEMI_IP_YOY_TIGHT_PCT ? S.TIGHT : S.NEUTRAL;
  }

  // 锁：复用线上 calcLockActive（单一来源）——触发锁存；零利率≤0.25% 或 非零<50bp 小幅调整解锁。
  // V3 最短锁存期（默认开，2026-07-17采纳）：月度锁龄×30天喂给 lockAgeDays，
  // 2个月锁存 ⇔ 线上 LOCK_MIN_AGE_DAYS=60天（零利率解锁在线上实现里天然豁免）；
  // minLockMonths=0（旧基线回退）时传 null 走 fail-open，与 2026-07-16 前行为逐位一致
  const sahmHigh = m.sahm !== null && m.sahm >= cfg.SAHM_TRIGGER_THRESHOLD;
  const sahmHighStreak = sahmHigh ? (prevState.sahmHighStreak ?? 0) + 1 : 0;
  // X4 萨姆锁确认期（默认关=1个月即触发，与旧行为逐位一致）：连续 N 个月 ≥0.5 才触发锁
  const sahmTrigger = sahmHigh && sahmHighStreak >= (variants.sahmConfirmMonths || 1);
  const reactiveTrigger = rateDiffBp !== null && Math.abs(rateDiffBp) >= cfg.RATE_REACTIVE_ADJUSTMENT_BP;

  // V1 趋势否决（已否决，--eval 可复现）：SPX月末收盘<10月SMA 期间全部解锁路径被否决，锁保持
  const trendVeto = !!variants.trendConfirm && m.spxBelowSma10 === true;
  const minLock = variants.minLockMonths || 0;
  const lockAgeDaysOf = prevAgeMonths => (minLock > 0 ? (prevAgeMonths ?? 0) * 30 : null);

  let sahmLockActive = calcLockActive({
    triggerToday: sahmTrigger, rateDiffBp, currentRate: m.rate,
    prevLockActive: !!prevState.sahmLockActive, lockAgeDays: lockAgeDaysOf(prevState.sahmLockAge),
  });
  if (trendVeto) sahmLockActive = !!(prevState.sahmLockActive || sahmTrigger);

  // V2 方向约束（已否决，--eval 可复现）：降息触发的应对式锁遇另一次小幅降息时，
  // rateDiffBp 以 0 传入压制 calcLockActive 的小幅调整解锁路径（语义=该次降息不解锁）
  const cutLockCutBlocked = !!variants.cutLockDirUnlock
    && prevState.reactiveLockDir === 'cut' && rateDiffBp !== null && rateDiffBp < 0;
  let reactiveLockActive = calcLockActive({
    triggerToday: reactiveTrigger, rateDiffBp: cutLockCutBlocked ? 0 : rateDiffBp, currentRate: m.rate,
    prevLockActive: !!prevState.reactiveLockActive, lockAgeDays: lockAgeDaysOf(prevState.reactiveLockAge),
  });
  if (trendVeto) reactiveLockActive = !!(prevState.reactiveLockActive || reactiveTrigger);
  // V2+V1 组合：降息触发的锁在趋势收复（月末收盘≥10月SMA）时解除
  if (variants.cutLockDirUnlock && variants.trendConfirm
    && prevState.reactiveLockActive && prevState.reactiveLockDir === 'cut'
    && m.spxBelowSma10 === false && !reactiveTrigger) reactiveLockActive = false;

  // 锁触发方向与锁龄（V2/V3 状态；基线下计算无副作用）
  const reactiveLockDir = !reactiveLockActive ? null
    : reactiveTrigger ? (rateDiffBp > 0 ? 'hike' : 'cut')
    : (prevState.reactiveLockDir ?? null);
  const sahmLockAge = sahmLockActive ? (prevState.sahmLockActive ? (prevState.sahmLockAge ?? 0) : 0) + 1 : 0;
  const reactiveLockAge = reactiveLockActive ? (prevState.reactiveLockActive ? (prevState.reactiveLockAge ?? 0) : 0) + 1 : 0;

  // 决策树（防守分级 + 非对称进攻）：复用线上 calcFinalSignal 单一来源——双维以上收紧=全面防守
  //（X3 最窄口径内置：恰两维tight且为"货币+财政"的纯政策共振降reduce，AI参与的共振保持defense）；
  // 单维收紧=减仓观望；进攻=AI供需宽松且政策三维不收紧；锁强制全面防守（下方覆盖）。
  // 注：AI供需在历史回测中恒为neutral（AI主题2015前不存在，V6变体例外），故进攻档回测触发0次——
  // 属AI主题年轻的固有限制，非规则错误；实盘中AI供需有数据、进攻档是活的。
  const tightCount = [aiSupply, monetary, fiscal, admin].filter(x => x === S.TIGHT).length;
  let final = calcFinalSignal(aiSupply, monetary, fiscal, admin);
  // X3 回退开关：defenseNeedsAdminOrLock=false 时恢复 2026-07-18 采纳前行为（纯货币+财政仍defense），
  // --eval/--variants 的历史对照表可复现
  if (!variants.defenseNeedsAdminOrLock && final === 'reduce'
    && tightCount === 2 && monetary === S.TIGHT && fiscal === S.TIGHT) final = 'defense';
  // W3（否决保留）：财政降为确认性信号——tight不计入防守共振票（防守票只数 AI/货币/行政），仍计减仓票
  if (variants.fiscalConfirmOnly && final === 'defense'
    && [aiSupply, monetary, admin].filter(x => x === S.TIGHT).length < 2) final = 'reduce';
  // W1（否决保留）：防守共振须含金融维——决策树defense要求货币tight在票内，纯政策组合只到reduce；
  // 锁不在此限（下方锁强制defense会覆盖）
  if (variants.defenseNeedsFinancial && final === 'defense' && monetary !== S.TIGHT) final = 'reduce';
  // ---- M系（2026-07-18 第5维评估：市场/估值票，全部默认关）----
  // 市场维=单一维度：M1（跌破10月SMA）与 M2（距52周高点回撤超阈值）同开时 OR 合并为一票，不重复计票。
  // 注意与 W5 的交互：M1 触发必在 SMA 之下，W5 趋势门天然不冲突；M2 可能在 SMA 上方触发
  //（深回撤后修复期），此时树驱动 defense 会被下方 W5 门即时降回 reduce——如实保留该交互
  const marketTight = (!!variants.m1TrendVote && m.spxBelowSma10 === true)
    || (variants.m2DrawdownPct != null && m.dd52wPct !== null && m.dd52wPct !== undefined
      && m.dd52wPct <= -variants.m2DrawdownPct);
  // M3：CAPE 30年滚动分位>90 → 估值票（confirm/full 两形态）
  const capeTight = (!!variants.capeConfirmVote || !!variants.capeFullVote)
    && m.capePercentile !== null && m.capePercentile !== undefined && m.capePercentile > 90;
  const extraVotes = (marketTight && !variants.marketConfirmOnly ? 1 : 0)
    + (capeTight && !!variants.capeFullVote ? 1 : 0);
  if (extraVotes > 0) {
    const totalVotes = tightCount + extraVotes;
    // M1x：恰"市场+货币"两票的纯双维共振比照 X3 降级 reduce（验证市场维参与的共振是否都该defense）
    const pureMarketMonetary = !!variants.marketMonetaryReduce && totalVotes === 2
      && marketTight && tightCount === 1 && monetary === S.TIGHT && !(capeTight && variants.capeFullVote);
    if (totalVotes >= 2 && !pureMarketMonetary) final = 'defense'; // 市场/估值参与的共振=defense（含解除X3降档）
    else if (final === 'neutral' || final === 'attack') final = 'reduce'; // 单票（市场/估值独tight）=减仓观望
  }
  // 确认票（M1b / M3c）：自己不凑数；四维自身已≥2共振但被X3降档为reduce时 +1 票恢复 defense
  const confirmVotes = (marketTight && !!variants.marketConfirmOnly ? 1 : 0)
    + (capeTight && !!variants.capeConfirmVote && !variants.capeFullVote ? 1 : 0);
  if (confirmVotes > 0 && final === 'reduce' && tightCount === 2
    && monetary === S.TIGHT && fiscal === S.TIGHT) final = 'defense';
  // V1 ②：趋势之下不进攻——attack 降级 neutral
  if (variants.trendConfirm && m.spxBelowSma10 === true && final === 'attack') final = 'neutral';
  if (sahmLockActive || reactiveLockActive) final = 'defense';
  // W5 趋势再入场 + X1 萨姆锁过趋势门（2026-07-18 采纳）：复用线上 applyTrendReentry——
  // 月末SPX≥10月SMA时，决策树驱动与萨姆锁驱动的defense降级reduce；应对式锁豁免（确证的危机应对，
  // X1b实测应对式锁过门会砸掉2007-09顶前入场）。sahmLockTrendReentry=false 回退到X1采纳前
  //（萨姆锁也豁免）；lockTrendReentry(X1b，否决) 让应对式锁也过门，仅 --variants 对照评估用
  if (variants.trendReentry && final === 'defense' && m.spxBelowSma10 === false) {
    if (variants.lockTrendReentry) final = 'reduce';
    else if (!sahmLockActive || variants.sahmLockTrendReentry) {
      final = applyTrendReentry(final, { sahmLockActive, reactiveLockActive, spxAboveSma10: true });
    }
  }

  return { monetary, fiscal, admin, aiSupply, final, sahmLockActive, reactiveLockActive, reactiveLockDir, sahmLockAge, reactiveLockAge, rateDiffBp, rateSignal, sahmHighStreak };
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
const addDaysISO = (date, n) => new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

/** 该日历月最后一天（YYYY-MM-DD），月末采样的 asOf 时点 */
export function lastDayOfMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/**
 * 取 asOfDate 时点可得的最后两条周度观测（与线上 fetch-macro 用最新两条 WALCL 周度观测环比同口径）。
 * 发布滞后：WALCL 周三数据次日（周四）才发布 → 仅"观测日期+1 ≤ asOfDate"的观测可见
 * @param {Array<{date, value:number}>} series - 升序
 * @returns {{curr:number|null, prev:number|null}}
 */
export function lastTwoWeeklyAsOf(series, asOfDate) {
  let curr = null, prev = null;
  for (const o of series) {
    if (addDaysISO(o.date, 1) > asOfDate) break;
    prev = curr;
    curr = o.value;
  }
  return { curr, prev };
}

/**
 * missedPct 双语义（按 leadDays 正负拆分，报告图例同步）：
 *  - 提前捕获（leadDays>0）：missedPct = peak/sigPx − 1（正值）——信号发出后市场又涨了 X% 才见顶（防守的踏空成本）
 *  - 滞后捕获（leadDays≤0）：missedPct = sigPx/peak − 1（负值）——信号发出时已从顶部回落 X%（错过的部分）
 */
export function calcMissedPct(sigPx, peakClose, leadDays) {
  if (sigPx === null || sigPx === undefined || !peakClose || leadDays === null) {
    return { missedPct: null, missedKind: null };
  }
  return leadDays > 0
    ? { missedPct: (peakClose / sigPx - 1) * 100, missedKind: 'preTop' }
    : { missedPct: (sigPx / peakClose - 1) * 100, missedKind: 'postTop' };
}

/**
 * 危机实际曝险路径统计：从首次防守信号月到危机底部月逐月复利——
 * defense 月按现金（联邦基金利率月化，与全期模拟同口径），非 defense 月按 SPY 月收益。
 * 防守片段中途解除（如 2008：2007-10 即恢复非防守；2020：2019-12 已恢复）会如实体现在路径里，
 * 不再假设"从首次防守一路防守到底部"（旧口径 trough/sigPx−1 属造假式高估）。
 * @returns {{pathRetPct, buyHoldRetPct, savedPct, coveragePct}|null}
 *  savedPct = 路径收益 − 同期买入持有收益（百分点，正=相对买入持有少亏）
 *  coveragePct = 曝险决策月（信号月起、底部月前一月止）中 defense 月占比
 */
export function crisisPathStats(timeline, rateMap, firstDefMonth, troughMonth) {
  const seg = timeline.filter(t => t.month >= firstDefMonth && t.month <= troughMonth && t.spx !== null);
  if (seg.length < 2) return null;
  let navS = 1, navB = 1, defCount = 0;
  for (let i = 1; i < seg.length; i++) {
    const ret = seg[i].spx / seg[i - 1].spx;
    navB *= ret;
    if (seg[i - 1].final === 'defense') {
      defCount++;
      navS *= 1 + ((rateMap.get(seg[i - 1].month) ?? 0) / 100) / 12;
    } else {
      navS *= ret;
    }
  }
  const decisions = seg.length - 1;
  return {
    pathRetPct: (navS - 1) * 100,
    buyHoldRetPct: (navB - 1) * 100,
    savedPct: (navS - navB) * 100,
    coveragePct: (defCount / decisions) * 100,
  };
}

/**
 * 净值模拟（全期/区间通用纯函数）：曝险由上月档位决定——
 * defense → 全现金（联邦基金利率月化计息）；reduce → reduceWeight×SPY + (1−reduceWeight)×现金；
 * 其余（attack/neutral）→ 满仓 SPY。buyHold=true 忽略档位恒满仓。
 * @param {Array<{month, spx:number, final}>} months - 升序、spx 非空
 * @returns {{totalPct, cagrPct, mddPct, years}|null}
 */
export function simulateNav(months, rateMap, { reduceWeight = 1, buyHold = false } = {}) {
  if (months.length < 2) return null;
  let nav = 1, peak = 1, mdd = 0;
  for (let i = 1; i < months.length; i++) {
    const ret = months[i].spx / months[i - 1].spx;
    const cash = 1 + ((rateMap.get(months[i - 1].month) ?? 0) / 100) / 12;
    const f = months[i - 1].final;
    nav *= buyHold ? ret
      : f === 'defense' ? cash
      : f === 'reduce' ? reduceWeight * ret + (1 - reduceWeight) * cash
      : ret;
    peak = Math.max(peak, nav);
    mdd = Math.min(mdd, nav / peak - 1);
  }
  const years = (months.length - 1) / 12;
  return { totalPct: (nav - 1) * 100, cagrPct: (Math.pow(nav, 1 / years) - 1) * 100, mddPct: mdd * 100, years };
}

// ---------- 数据拉取 ----------

// FRED 本地文件缓存（fred-cache.json，24h TTL，已加 .gitignore）：
// --eval 模式反复跑变体组合会重复请求同一批序列，无缓存易触发 FRED 429
const FRED_CACHE = path.join(__dirname, 'fred-cache.json');
const FRED_CACHE_TTL_MS = 24 * 3600 * 1000;
let fredCache = null;

async function fredSeries(id, apiKey, extra = '') {
  if (fredCache === null) {
    try { fredCache = JSON.parse(fs.readFileSync(FRED_CACHE, 'utf8')); } catch { fredCache = {}; }
  }
  const cacheKey = `${id}|1987-01-01|${extra}`;
  const hit = fredCache[cacheKey];
  if (hit && Date.now() - hit.at < FRED_CACHE_TTL_MS) return hit.obs;

  // 1987-01-01 起（原 1997）：保证 EPUTRADE（FRED 可回溯到 1985）在 2000-01 起的每个月
  // 都有足额 120 个月观测供 slice(-120) 十年百分位窗口用，消除 2000-2006 小窗百分位噪声；
  // 其余序列提前起点无害——多拉的数据只占内存，判定逻辑仍从 2000-01 重放
  const url = `${FRED_BASE}?series_id=${id}&observation_start=1987-01-01&api_key=${apiKey}&file_type=json&sort_order=asc&limit=100000${extra}`;
  const res = await axios.get(url, { timeout: 30000 });
  const obs = (res.data.observations || [])
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .filter(o => !isNaN(o.value));
  fredCache[cacheKey] = { at: Date.now(), obs };
  fs.writeFileSync(FRED_CACHE, JSON.stringify(fredCache));
  return obs;
}

const SPX_CACHE = path.join(__dirname, 'spx-cache.json');

// M3：席勒CAPE（multpl.com 月度表，1871年起）。Shiller ie_data.xls 需二进制xls解析器（未装依赖），
// multpl.com 同源转载且可直接正则解析。缓存 cape-cache.json；拉取失败用缓存兜底；两者皆无 → 空数组，
// M3 系列变体如实跳过（fail-soft，不阻塞 M1/M2 评估）
const CAPE_CACHE = path.join(__dirname, 'cape-cache.json');

async function fetchCape() {
  try {
    const res = await axios.get('https://www.multpl.com/shiller-pe/table/by-month', {
      timeout: 30000, responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    const capeM = parseMultplCape(res.data);
    if (capeM.length > 1500) { // 1871年起应有~1800条，低于1500视为页面改版/截断
      fs.writeFileSync(CAPE_CACHE, JSON.stringify({ at: Date.now(), capeM }));
      return { capeM, capeSource: 'multpl.com Shiller PE 月度（1871起）' };
    }
    console.warn(`[backtest] multpl CAPE 解析仅得 ${capeM.length} 条，疑似页面改版，转用缓存`);
  } catch (e) {
    console.warn('[backtest] multpl CAPE failed:', e.message);
  }
  if (fs.existsSync(CAPE_CACHE)) {
    const cached = JSON.parse(fs.readFileSync(CAPE_CACHE, 'utf8'));
    return { capeM: cached.capeM, capeSource: 'multpl.com Shiller PE（本地缓存）' };
  }
  return { capeM: [], capeSource: 'CAPE 数据不可得（M3 跳过）' };
}

async function fetchSpx() {
  const result = await fetchSpxLive();
  // 成功拉到全历史 → 仅 Tiingo 总回报口径允许写缓存（stooq/Yahoo 价格指数不含股息，
  // 若覆盖缓存，下次兜底会静默用低口径数据系统性低估买入持有约1.9%/年）
  const coversHistory = result.bars.length && result.bars[0].date <= '1998-01-01';
  if (coversHistory) {
    if (result.source.startsWith('Tiingo')) fs.writeFileSync(SPX_CACHE, JSON.stringify(result));
    return result;
  }
  if (fs.existsSync(SPX_CACHE)) {
    const cached = JSON.parse(fs.readFileSync(SPX_CACHE, 'utf8'));
    // 陈旧护栏：最后一根 bar 距今超过45天 → 拒绝静默使用，明确报错要求恢复实时拉取
    const lastBarDate = cached.bars.length ? cached.bars[cached.bars.length - 1].date : null;
    if (!lastBarDate || dayDiff(lastBarDate, new Date().toISOString().slice(0, 10)) > 45) {
      throw new Error(`spx-cache.json 最后一根bar(${lastBarDate ?? '无'})距今超过45天，缓存已陈旧——请修复 Tiingo 拉取后重跑，不静默使用降级数据`);
    }
    console.warn(`[backtest] live sources incomplete, using cached ${cached.source} (${cached.bars.length} bars)`);
    return { ...cached, source: `${cached.source}（本地缓存）` };
  }
  return result;
}

async function fetchSpxLive() {
  // 首选 Tiingo SPY adjClose（唯一的总回报口径：含股息复权）——策略回测衡量"投资者实际到手收益"，
  // 必须用总回报；指数序列(^SPX/^GSPC)按定义是价格指数、不含股息，会系统性低估约1.9%/年
  try {
    const token = process.env.TIINGO_API_KEY;
    if (token) {
      const res = await axios.get('https://api.tiingo.com/tiingo/daily/spy/prices', {
        params: { startDate: '1997-01-01', token },
        timeout: 60000,
      });
      const bars = (res.data || [])
        .map(r => ({ date: String(r.date).slice(0, 10), close: r.adjClose ?? r.close }))
        .filter(b => !isNaN(b.close));
      if (bars.length > 1000) return { bars, source: 'Tiingo SPY 总回报（adjClose，含股息复权）' };
    }
  } catch (e) {
    console.warn('[backtest] tiingo failed:', e.message);
  }
  // 降级1：stooq ^spx 日线 CSV（无需key，但对部分IP有JS盾）——价格指数，不含股息（口径次优）
  try {
    const res = await axios.get('https://stooq.com/q/d/l/?s=^spx&i=d', { timeout: 30000, responseType: 'text' });
    const lines = res.data.trim().split('\n').slice(1);
    const bars = lines.map(l => {
      const [date, , , , close] = l.split(',');
      return { date, close: parseFloat(close) };
    }).filter(b => b.date >= '1997-01-01' && !isNaN(b.close));
    if (bars.length > 1000) return { bars, source: 'stooq ^spx（价格指数，不含股息）' };
  } catch (e) {
    console.warn('[backtest] stooq failed:', e.message);
  }
  // 降级2：Yahoo ^GSPC 全历史——价格指数，不含股息
  try {
    const { default: yahooFinance } = await import('yahoo-finance2');
    const raw = await yahooFinance.historical('^GSPC', { period1: '1997-01-01', period2: new Date().toISOString().slice(0, 10) });
    const bars = (raw || [])
      .map(b => ({ date: b.date instanceof Date ? b.date.toISOString().slice(0, 10) : String(b.date).slice(0, 10), close: b.close }))
      .filter(b => !isNaN(b.close));
    if (bars.length > 1000) return { bars, source: 'Yahoo ^GSPC（价格指数，不含股息）' };
  } catch (e) {
    console.warn('[backtest] yahoo failed:', e.message);
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
  { name: '2025 关税战', searchStart: '2024-12-01', searchEnd: '2025-12-31', peakWindow: ['2024-12-01', '2025-03-31'] },
  { name: '2026 美伊战争', searchStart: '2025-11-01', searchEnd: '2026-07-31', peakWindow: ['2025-11-01', '2026-02-28'] },
];

// 大规模上涨期：检验"该赚钱时策略有没有挡路"（防守分级合理性的另一半）
const BULL_RUNS = [
  { name: '2003-07 复苏牛', start: '2003-04', end: '2007-10' },
  { name: '2009-11 QE牛', start: '2009-04', end: '2011-04' },
  { name: '2012-15 慢牛', start: '2012-01', end: '2015-05' },
  { name: '2016-18 特朗普牛', start: '2016-07', end: '2018-01' },
  { name: '2020-21 疫后牛', start: '2020-05', end: '2021-12' },
  { name: '2023-24 AI牛', start: '2023-01', end: '2024-12' },
  { name: '2025 关税战后反弹', start: '2025-05', end: '2025-12' },
  { name: '2026 战后反弹', start: '2026-04', end: '2026-07' },
];

/** 拉取全部序列并做月末采样，返回重放所需的数据包（与变体无关，--eval 模式只拉一次） */
export async function loadData() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED_API_KEY not set');

  console.log('[backtest] fetching FRED series...');
  const [dfedtar, dfedtaru, walcl, fiscal, epu, sahm, oil, pcepi, corePceYoy, semiYoy] = await Promise.all([
    fredSeries('DFEDTAR', apiKey),
    fredSeries('DFEDTARU', apiKey),
    fredSeries('WALCL', apiKey),
    fredSeries('MTSO133FMS', apiKey),
    fredSeries('EPUTRADE', apiKey),
    fredSeries('SAHMREALTIME', apiKey),
    fredSeries('DCOILWTICO', apiKey),
    fredSeries('PCEPI', apiKey),                    // PCE价格指数，财政支出通胀平减用
    fredSeries('PCEPILFE', apiKey, '&units=pc1'),   // V5：核心PCE同比（%）
    fredSeries('IPG3344S', apiKey, '&units=pc1'),   // V6：半导体及电子元件产出同比（%），1972年起
  ]);
  console.log('[backtest] fetching SPX...');
  const { bars: spx, source: spxSource } = await fetchSpx();
  const { capeM, capeSource } = await fetchCape(); // M3：失败fail-soft为空数组

  const rateM = sampleMonthEnd(spliceRateSeries(dfedtar, dfedtaru));
  // WALCL 不做月末采样：与线上 fetch-macro 同口径——每个采样时点取可得的最新两条周度观测环比（见循环内）
  const fiscalM = sampleMonthEnd(fiscal); // 月度序列，月末采样=原值
  const epuM = sampleMonthEnd(epu);
  const sahmM = sampleMonthEnd(sahm);
  const oilM = sampleMonthEnd(oil);
  const pcepiM = sampleMonthEnd(pcepi);
  const spxM = sampleMonthEnd(spx.map(b => ({ date: b.date, value: b.close })));

  const byMonth = arr => new Map(arr.map(o => [o.month, o.value]));
  return {
    spx, spxSource, walcl, fiscalM, epuM, pcepiM, spxM,
    capeM, capeSource, // M3：月度CAPE（升序，1871起；不可得时空数组）
    rateM,
    rateMap: byMonth(rateM), sahmMap: byMonth(sahmM), oilMap: byMonth(oilM), spxMap: byMonth(spxM),
    corePceYoyMap: byMonth(sampleMonthEnd(corePceYoy)), // V5
    semiYoyMap: byMonth(sampleMonthEnd(semiYoy)),       // V6
    // 月→该月真实月末交易日，用于危机提前量按真实日期计算（而非硬编码 "-28"）
    spxDateMap: new Map(spxM.map(o => [o.month, o.date])),
    spxIdxMap: new Map(spxM.map((o, i) => [o.month, i])), // V1：SMA窗口定位
  };
}

const prevMonthOf = m => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};

/** 逐月重放（变体开关注入 replayMonth / 迟滞状态机），返回 timeline */
export function runReplay(D, variants = VARIANTS_DEFAULT) {
  // 重放：2000-01 起（此前13年做 EPU/财政窗口热身）。
  // 未收官月份剔除：当前系统年月只有半个月数据，纳入会用不完整月收益污染统计（月中重跑时尤甚）
  const nowMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const months = D.rateM.map(o => o.month).filter(m => m >= '2000-01' && m < nowMonth);
  const timeline = [];
  let state = { sahmLockActive: false, reactiveLockActive: false, reactiveLockDir: null, sahmLockAge: 0, reactiveLockAge: 0 };
  // V4 迟滞状态（默认开）：复用线上 applyDowngradeHold（日频，FINAL_DOWNGRADE_CONFIRM_DAYS=30天确认期）。
  // 月度重放按"标准月=30天"合成日历喂入 → 30天确认期 ⇔ 1个标准月等待 ⇔ 评估口径
  // "降档需连续2个月更宽松才生效"。不用真实月末日期：2月只有28天，会让确认期偶尔跨到第3个月，偏离评估口径
  let hyst = { effective: null, pendingSince: null };
  // W4b：当前生效defense是否为锁驱动（锁月刷新；树defense月刷为false；迟滞扛住的月份维持原值）
  let hystLockDriven = false;
  let monthIdx = 0;
  // 首月利率变动用 1999-12 播种，避免首月恒 null
  let prevRate = D.rateMap.get('1999-12') ?? null;
  // 月度指标发布滞后建模：MTSDS133FMS 次月中旬发布、SAHMREALTIME 次月初随非农、EPUTRADE 月后编制，
  // M 月末决策时只能看到 M-1 月的观测（利率/WALCL/油价为日频/周频实时序列，不移位）

  for (const month of months) {
    const rate = D.rateMap.get(month) ?? null;
    // WALCL：月末采样时取 asOf 时点可得的最新两条周度观测（与线上 fetch-macro 最新两条周度环比同口径；
    // 旧版月末对月末差分把4-5周变化摊成一次比较，同一个±0.25%阈值下判定明显偏松）。
    // 周三数据次日（周四）发布 → lastTwoWeeklyAsOf 只放行"观测日+1 ≤ 采样日"的观测
    const { curr: walclV, prev: prevWalcl } = lastTwoWeeklyAsOf(D.walcl, lastDayOfMonth(month));

    const asOf = prevMonthOf(month); // 发布滞后：只用 M-1 月及更早的月度观测
    // 财政：截至 M-1 月的月度值序列 → 实际同比（名义TTM同比 − 同期TTM通胀）
    const fiscalHist = D.fiscalM.filter(o => o.month <= asOf).map(o => o.value);
    const nominalFiscalPct = ttmChangePct(fiscalHist);
    // 同期通胀：PCEPI 近12月均值 vs 前12月均值同比（与支出TTM窗口对齐）。
    // PCEPI 用 M-2：BEA 发布日在月末边界上（M-1 月数据常在 M 月末尾才出），M-1 口径有前视嫌疑
    const pcepiAsOf = prevMonthOf(asOf);
    const pcepiHist = D.pcepiM.filter(o => o.month <= pcepiAsOf).map(o => o.value);
    let fiscalInflationPct = null;
    if (pcepiHist.length >= 24) {
      const last24 = pcepiHist.slice(-24);
      const avgCur = last24.slice(12).reduce((a, b) => a + b, 0) / 12;
      const avgPrev = last24.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
      if (avgPrev !== 0) fiscalInflationPct = (avgCur / avgPrev - 1) * 100;
    }
    const realFiscalPct = (nominalFiscalPct !== null && fiscalInflationPct !== null)
      ? nominalFiscalPct - fiscalInflationPct
      : nominalFiscalPct;
    // 行政：EPU 截至 M-1 月近10年（120个月）窗口百分位 —— 无前视且建模发布滞后
    const epuHist = D.epuM.filter(o => o.month <= asOf).slice(-120);
    const epuLatest = epuHist.length && epuHist[epuHist.length - 1].month === asOf ? epuHist[epuHist.length - 1].value : null;

    // V1：截至当月的最近10个月末收盘均值（含当月）；前10个月 SMA 不足时为 null（跳过该规则）
    let spxBelowSma10 = null;
    const spxIdx = D.spxIdxMap.get(month);
    if (spxIdx !== undefined) {
      const sma = smaLast(D.spxM.slice(0, spxIdx + 1).map(o => o.value), 10);
      if (sma !== null) spxBelowSma10 = D.spxM[spxIdx].value < sma;
    }
    // V5：实际利率 = 政策利率（月末目标上沿，实时可见）− 核心PCE同比（M-1可见）
    const corePce = D.corePceYoyMap.get(asOf) ?? null;
    const realRatePct = (rate !== null && corePce !== null) ? rate - corePce : null;

    // M2：月末收盘距过去52周最高收盘回撤（SPY日线实时可见，无发布滞后）
    const dd52wPct = rollingHighDrawdownPct(D.spx, D.spxDateMap.get(month) ?? lastDayOfMonth(month), 365);
    // M3：CAPE 30年滚动（360月）分位，发布滞后建模为 M-1 可见（multpl 月度值用月初价格+滞后盈利，
    // 月末决策时上月值早已可得）；窗口不足360月 → null（1871年起的数据2000-01后恒足额）
    let capePercentile = null;
    if (D.capeM && D.capeM.length) {
      const capeHist = D.capeM.filter(o => o.month <= asOf).slice(-360);
      if (capeHist.length >= 360 && capeHist[capeHist.length - 1].month === asOf) {
        capePercentile = percentileAsOf(capeHist[capeHist.length - 1].value, capeHist.map(o => o.value));
      }
    }

    // 指标值提出到局部量（accuracy-report.mjs 错误归因需要透出到 timeline.metrics）
    const epuPctVal = epuLatest !== null ? percentileAsOf(epuLatest, epuHist.map(o => o.value)) : null;
    const oilPrev = timeline.length ? D.oilMap.get(timeline[timeline.length - 1].month) : null;
    const oilCur = D.oilMap.get(month);
    const oilPctVal = oilCur != null && oilPrev != null && oilPrev !== 0 ? (oilCur - oilPrev) / oilPrev * 100 : null;
    const sahmVal = D.sahmMap.get(asOf) ?? null;

    const r = replayMonth({
      rate, prevRate,
      walcl: walclV, prevWalcl,
      fiscalChangePct: realFiscalPct,
      epuPercentile: epuPctVal,
      oilChangePct: oilPctVal,
      sahm: sahmVal,
      spxBelowSma10,
      realRatePct,
      dd52wPct, capePercentile, // M2/M3
      semiYoy: D.semiYoyMap.get(prevMonthOf(asOf)) ?? null, // V6：IP 发布滞后建模为 M-2 可见
    }, state, variants);
    state = {
      sahmLockActive: r.sahmLockActive, reactiveLockActive: r.reactiveLockActive,
      reactiveLockDir: r.reactiveLockDir, sahmLockAge: r.sahmLockAge, reactiveLockAge: r.reactiveLockAge,
      rateSignal: r.rateSignal, sahmHighStreak: r.sahmHighStreak, // X2/X4 变体状态（基线下计算无副作用）
    };
    prevRate = rate;
    let final = r.final;
    if (variants.downgradeHysteresis) { // V4：降档需连续2个月确认，升档即时（复用线上 applyDowngradeHold）
      const synthToday = addDaysISO('2000-01-01', monthIdx * 30); // 标准月=30天 合成日历（见 hyst 注释）
      // W4b：生效档为"决策树驱动的defense"（非锁）且候选更宽松 → 绕过迟滞立即降档；
      // 锁驱动defense的降档及其余降档（reduce→neutral等）仍走确认期
      const treeDefenseDowngrade = !!variants.hysteresisLockOnly
        && hyst.effective === 'defense' && !hystLockDriven && r.final !== 'defense';
      const h = treeDefenseDowngrade ? { signal: r.final, pendingSince: null }
        : variants.hysteresisConfirmDays // W4a：确认期覆盖（月度粒度下(0,30]天均等价1个采样月）
          ? applyDowngradeHoldWithDays(r.final, hyst.effective, hyst.pendingSince, synthToday, variants.hysteresisConfirmDays)
          : applyDowngradeHold(r.final, hyst.effective, hyst.pendingSince, synthToday);
      hyst = { effective: h.signal, pendingSince: h.pendingSince };
      final = h.signal;
      if (r.final === 'defense') hystLockDriven = !!(r.sahmLockActive || r.reactiveLockActive);
      else if (final !== 'defense') hystLockDriven = false;
    }
    monthIdx++;
    timeline.push({
      month, spx: D.spxMap.get(month) ?? null, spxDate: D.spxDateMap.get(month) ?? null, ...r, rawFinal: r.final, final,
      // 指标透出（accuracy-report.mjs 错误归因用）：当月各维底层值与阈值差距可追溯
      metrics: { rate, fiscalPct: realFiscalPct, epuPct: epuPctVal, oilPct: oilPctVal, sahm: sahmVal, spxBelowSma10, dd52wPct, capePct: capePercentile },
    });
  }
  return timeline;
}

/** 危机/牛市/全期统计（与变体无关的评估口径），返回 summary */
export function evaluate(D, timeline) {
  const { spx, spxSource, rateMap, spxMap } = D;
  const crisisRows = CRISES.map(c => {
    const { peak } = findPeakTrough(spx, ...c.peakWindow);
    if (!peak) {
      return { name: c.name, peakDate: '数据缺失', troughDate: '—', drawdownPct: null, firstDefMonth: null, leadDays: null, missedPct: null, missedKind: null, savedPct: null, coveragePct: null, pathRetPct: null, buyHoldRetPct: null, recoverMonth: null, lockTypes: '—' };
    }
    const { trough } = findPeakTrough(spx, peak.date, c.searchEnd);
    const drawdownPct = (trough.close / peak.close - 1) * 100;

    // 首次防守：危机搜索期开始起第一个 defense 月
    const defMonths = timeline.filter(t => t.month >= c.searchStart.slice(0, 7) && t.month <= c.searchEnd.slice(0, 7));
    const firstDef = defMonths.find(t => t.final === 'defense');
    // 用该月真实月末交易日（timeline 已带 spxDate），而非硬编码 "-28"（后者系统性多算0-3天提前量）
    const firstDefDate = firstDef ? (firstDef.spxDate ?? `${firstDef.month}-28`) : null;
    const leadDays = firstDefDate ? dayDiff(firstDefDate, peak.date) : null; // 正=提前于顶部

    // 防守发出时点价格（用当月SPX月末价）
    const sigPx = firstDef?.spx ?? null;
    // missedPct 双语义（calcMissedPct）：提前捕获=信号→顶部再涨+X%（踏空成本）；滞后捕获=顶部→信号已回落−X%
    const { missedPct, missedKind } = calcMissedPct(sigPx, peak.close, leadDays);
    // savedPct 按实际曝险路径（crisisPathStats）：信号月→底部月逐月复利，defense月吃现金、
    // 非defense月吃SPY，与同期买入持有之差（百分点）。防守中途解除如实计入，不再假设一路防守到底
    const path = firstDef ? crisisPathStats(timeline, rateMap, firstDef.month, trough.date.slice(0, 7)) : null;

    // 恢复非防守
    const afterDef = firstDef ? timeline.filter(t => t.month > firstDef.month) : [];
    const recover = afterDef.find(t => t.final !== 'defense');

    return {
      name: c.name,
      peakDate: peak.date, troughDate: trough.date, drawdownPct,
      firstDefMonth: firstDef?.month ?? null, leadDays, missedPct, missedKind,
      savedPct: path?.savedPct ?? null,
      coveragePct: path?.coveragePct ?? null,
      pathRetPct: path?.pathRetPct ?? null,
      buyHoldRetPct: path?.buyHoldRetPct ?? null,
      recoverMonth: recover?.month ?? null,
      lockTypes: firstDef ? [firstDef.sahmLockActive && '萨姆锁', firstDef.reactiveLockActive && '应对式锁'].filter(Boolean).join('+') || '决策树' : '—',
    };
  });

  // 防守期 vs 非防守期月度收益
  let defRet = [], reduceRet = [], nonDefRet = [];
  for (let i = 1; i < timeline.length; i++) {
    const a = timeline[i - 1], b = timeline[i];
    if (a.spx === null || b.spx === null) continue;
    const ret = (b.spx / a.spx - 1) * 100;
    (a.final === 'defense' ? defRet : a.final === 'reduce' ? reduceRet : nonDefRet).push(ret);
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
    // 信号后12个月（含信号月自身共13个采样点），只取有效 spx，缺失月不参与 min（旧代码用 Infinity 会污染）
    const horizon = timeline.filter(t => t.month >= ep.start).slice(0, 13)
      .map(t => t.spx).filter(v => v !== null && v !== undefined && !isNaN(v));
    if (!horizon.length) continue;
    const minPx = Math.min(...horizon);
    if ((minPx / startPx - 1) * 100 > -15) falsePositives++;
  }

  // ---- 牛市检验：各上涨期的档位占比 + "仅全面防守离场"策略捕获率 ----
  const inWindow = (t, w) => t.month >= w.start && t.month <= w.end;
  const bullRows = BULL_RUNS.map(w => {
    const months = timeline.filter(t => inWindow(t, w) && t.spx !== null);
    if (months.length < 2) return { name: w.name, months: 0 };
    const tiers = { attack: 0, neutral: 0, reduce: 0, defense: 0 };
    for (const t of months) tiers[t.final] = (tiers[t.final] || 0) + 1;
    const buyHold = (months[months.length - 1].spx / months[0].spx - 1) * 100;
    // 曝险规则：上月为全面防守→本月全现金（联邦基金利率月化计息，与全期模拟同口径——
    // 旧版 nav*=1 零利息与全期模拟不一致）；其余满仓（reduce=减仓由用户执行层决定，这里按持有计）
    const sim = simulateNav(months, rateMap);
    const strat = sim.totalPct;
    return {
      name: w.name, months: months.length, tiers,
      buyHold, strat,
      capture: buyHold > 0 ? (strat / buyHold) * 100 : null,
    };
  });

  // ---- 全期策略模拟（simulateNav 统一口径）：防守月计现金利息（联邦基金利率月化）----
  // 防守期与高利率期高度重合（2000/2007/2022-23），忽略现金利息会系统性低估策略收益。
  const withPx = timeline.filter(t => t.spx !== null);
  const bhSim = simulateNav(withPx, rateMap, { buyHold: true });
  const stratSim = simulateNav(withPx, rateMap);                          // 仅全面防守离场（reduce 月照常满仓）
  const reduceHalfSim = simulateNav(withPx, rateMap, { reduceWeight: 0.5 }); // 敏感性：照档位建议执行 reduce=50%仓
  // 子样本稳健性：2010-01 起（避开2000泡沫顶起点）同一套规则重放的后半段
  const sub2010 = withPx.filter(t => t.month >= '2010-01');
  const sub2010Strat = simulateNav(sub2010, rateMap);
  const sub2010BuyHold = simulateNav(sub2010, rateMap, { buyHold: true });
  const overall = {
    years: bhSim.years,
    buyHoldTotal: bhSim.totalPct, buyHoldCagr: bhSim.cagrPct, buyHoldMdd: bhSim.mddPct,
    stratTotal: stratSim.totalPct, stratCagr: stratSim.cagrPct, stratMdd: stratSim.mddPct,
    reduceHalfTotal: reduceHalfSim.totalPct, reduceHalfCagr: reduceHalfSim.cagrPct, reduceHalfMdd: reduceHalfSim.mddPct,
    sub2010Years: sub2010Strat?.years ?? null,
    sub2010StratCagr: sub2010Strat?.cagrPct ?? null, sub2010StratMdd: sub2010Strat?.mddPct ?? null,
    sub2010BuyHoldCagr: sub2010BuyHold?.cagrPct ?? null, sub2010BuyHoldMdd: sub2010BuyHold?.mddPct ?? null,
  };

  return {
    spxSource,
    bullRows,
    overall,
    monthsCovered: timeline.length,
    crisisRows,
    avgDefenseRet: avg(defRet), avgReduceRet: avg(reduceRet), avgNonDefenseRet: avg(nonDefRet),
    defMonths: defRet.length, reduceMonths: reduceRet.length, nonDefMonths: nonDefRet.length,
    episodes: episodes.length, falsePositives,
    // 各维度收紧月数（诊断哪个维度在拉响警报）
    dimTight: {
      monetary: timeline.filter(t => t.monetary === 'tight').length,
      fiscal: timeline.filter(t => t.fiscal === 'tight').length,
      admin: timeline.filter(t => t.admin === 'tight').length,
      lockMonths: timeline.filter(t => t.sahmLockActive || t.reactiveLockActive).length,
    },
  };
}

async function main() {
  const D = await loadData();

  if (process.argv.includes('--eval-m')) return runEvalM(D); // 仅M系（第5维）对照表
  if (process.argv.includes('--eval')) return runEval(D);

  const timeline = runReplay(D, VARIANTS_DEFAULT);
  const summary = evaluate(D, timeline);
  const { crisisRows, bullRows } = summary;

  fs.writeFileSync(path.join(__dirname, 'backtest-raw.json'), JSON.stringify({ summary, timeline }, null, 2));
  writeReport(summary, timeline);
  console.log('[backtest] done. report → docs/backtest-report.md');
  console.table(crisisRows);
  console.table(bullRows.map(b => ({
    区间: b.name, 月数: b.months,
    进攻: b.tiers?.attack ?? 0, 观望: b.tiers?.neutral ?? 0, 减仓: b.tiers?.reduce ?? 0, 防守: b.tiers?.defense ?? 0,
    买入持有: b.buyHold?.toFixed(1) + '%', 策略: b.strat?.toFixed(1) + '%', 捕获率: b.capture?.toFixed(0) + '%',
  })));
  console.log(`全期(${summary.overall.years.toFixed(1)}年) 买入持有 年化${summary.overall.buyHoldCagr.toFixed(1)}% 最大回撤${summary.overall.buyHoldMdd.toFixed(0)}% | 策略(仅defense离场) 年化${summary.overall.stratCagr.toFixed(1)}% 最大回撤${summary.overall.stratMdd.toFixed(0)}% | reduce=50%仓 年化${summary.overall.reduceHalfCagr.toFixed(1)}% 最大回撤${summary.overall.reduceHalfMdd.toFixed(0)}%`);
  console.log(`2010-01起子样本(${summary.overall.sub2010Years?.toFixed(1)}年) 策略 年化${summary.overall.sub2010StratCagr?.toFixed(1)}% vs 买入持有 年化${summary.overall.sub2010BuyHoldCagr?.toFixed(1)}%`);
  console.log(`防守期均月收益 ${summary.avgDefenseRet?.toFixed(2)}% (${summary.defMonths}月) vs 非防守 ${summary.avgNonDefenseRet?.toFixed(2)}% (${summary.nonDefMonths}月)`);
  console.log(`防守片段 ${summary.episodes} 段，其中假阳性（未伴随>15%回撤）${summary.falsePositives} 段`);
}

// ---------- 变体评估模式（--eval）：数据只拉一次，遍历组合打印对照表，不写报告文件 ----------

const VARIANT_DEFS = [
  ['V1趋势确认', { trendConfirm: true }],
  ['V2降息锁方向', { cutLockDirUnlock: true }],
  ['V3锁存2月', { minLockMonths: 2 }],
  ['V4降档迟滞', { downgradeHysteresis: true }],
  ['V5实际利率封顶', { realRateCap: true }],
  ['V6AI半导体', { aiSemi: true }],
];

function evalRow(name, D, timeline) {
  const s = evaluate(D, timeline);
  const total = s.defMonths + s.reduceMonths + s.nonDefMonths;
  const c = key => s.crisisRows.find(r => r.name.startsWith(key));
  const c08 = c('2008'), c20 = c('2020');
  const f1 = v => v === null || v === undefined ? '—' : v.toFixed(1);
  return {
    组合: name,
    年化: s.overall.stratCagr, 回撤: s.overall.stratMdd,
    防守月: s.defMonths, 防守占比: total ? s.defMonths / total * 100 : 0,
    召回: `${s.crisisRows.filter(r => r.firstDefMonth).length}/${s.crisisRows.length}`,
    首次示警: s.crisisRows.map(r => r.firstDefMonth ?? '未触发').join(' '),
    '08少亏/覆盖': `${f1(c08?.savedPct)}pp/${f1(c08?.coveragePct)}%`,
    '20少亏/覆盖': `${f1(c20?.savedPct)}pp/${f1(c20?.coveragePct)}%`,
    恢复: s.crisisRows.map(r => r.recoverMonth ?? '—').join(' '),
    假阳性: `${s.falsePositives}/${s.episodes}`,
  };
}

const keyMonthDetail = (timeline, mo) => {
  const t = timeline.find(x => x.month === mo);
  if (!t) return `${mo}:无数据`;
  const locks = [t.sahmLockActive && '萨姆锁', t.reactiveLockActive && '应对锁'].filter(Boolean).join('+');
  return `${mo}=${t.final}${locks ? `(${locks})` : ''}`;
};

function runEval(D) {
  const baseTimeline = runReplay(D, {});
  const rows = [evalRow('基线(全关)', D, baseTimeline)];
  const timelines = new Map([['基线(全关)', baseTimeline]]);

  // 单变体
  for (const [name, v] of VARIANT_DEFS) {
    const tl = runReplay(D, v);
    timelines.set(name, tl);
    rows.push(evalRow(name, D, tl));
  }

  // 组合扫描：全部 2^6 组合（V2/V3 互为替代不同开），跳过空集与单变体（已列）
  const comboRows = [];
  for (let mask = 1; mask < (1 << VARIANT_DEFS.length); mask++) {
    const picked = VARIANT_DEFS.filter((_, i) => mask & (1 << i));
    if (picked.length < 2) continue;
    const names = picked.map(([n]) => n);
    if (names.includes('V2降息锁方向') && names.includes('V3锁存2月')) continue; // 互为替代
    const v = Object.assign({}, ...picked.map(([, p]) => p));
    const label = names.map(n => n.slice(0, 2)).join('+');
    const tl = runReplay(D, v);
    timelines.set(label, tl);
    comboRows.push(evalRow(label, D, tl));
  }
  comboRows.sort((a, b) => b.年化 - a.年化);

  const fmt = r => ({ ...r, 年化: r.年化.toFixed(2) + '%', 回撤: r.回撤.toFixed(1) + '%', 防守占比: r.防守占比.toFixed(0) + '%' });
  console.log('\n===== 基线 + 单变体 =====');
  console.table(rows.map(fmt));
  console.log('\n===== 组合（按年化排序，前15） =====');
  console.table(comboRows.slice(0, 15).map(fmt));
  console.log('\n===== 组合（按年化排序，后5） =====');
  console.table(comboRows.slice(-5).map(fmt));

  // 关键时点行为明细：2007-10 小幅降息解锁 / 2008-12 零利率解锁 / 2019-12 退出防守
  console.log('\n===== 关键时点明细（2007-10 / 2008-12 / 2019-12 ± 复苏入场） =====');
  const firstNonDefAfter = (tl, mo) => tl.find(x => x.month > mo && x.final !== 'defense')?.month ?? '—';
  for (const [name, tl] of timelines) {
    if (!rows.some(r => r.组合 === name) && !comboRows.slice(0, 8).some(r => r.组合 === name)) continue;
    const def23 = tl.filter(t => t.month >= '2023-01' && t.month <= '2023-12' && t.final === 'defense').length;
    console.log(`${name.padEnd(16)} ${keyMonthDetail(tl, '2007-10')}  ${keyMonthDetail(tl, '2008-12')}  ${keyMonthDetail(tl, '2019-12')}  | 复苏入场: 09年${firstNonDefAfter(tl, '2009-03')} 20年${firstNonDefAfter(tl, '2020-03')} 23年防守${def23}月`);
  }

  // V6 三个半导体下行周期的代价明细（vs 基线）
  console.log('\n===== V6 半导体下行周期代价（vs 基线） =====');
  const v6tl = timelines.get('V6AI半导体');
  for (const [ws, we] of [['2015-01', '2016-12'], ['2019-01', '2019-12'], ['2023-01', '2023-06']]) {
    const seg = tl => tl.filter(t => t.month >= ws && t.month <= we && t.spx !== null);
    const b = seg(baseTimeline), v = seg(v6tl);
    const simB = simulateNav(b, D.rateMap), simV = simulateNav(v, D.rateMap);
    const cnt = (tl, f) => tl.filter(t => t.final === f).length;
    const aiTight = v.filter(t => t.aiSupply === 'tight').length;
    console.log(`${ws}~${we}: AI维tight ${aiTight}月 | defense 基线${cnt(b, 'defense')}→V6 ${cnt(v, 'defense')}月, reduce ${cnt(b, 'reduce')}→${cnt(v, 'reduce')}月 | 区间策略收益 基线${simB.totalPct.toFixed(1)}% → V6 ${simV.totalPct.toFixed(1)}%（差${(simV.totalPct - simB.totalPct).toFixed(1)}pp）`);
  }
  // 2000 科网泡沫更早示警检验
  const firstDefIn = (tl, s, e) => tl.find(t => t.month >= s && t.month <= e && t.final === 'defense')?.month ?? '未触发';
  console.log(`2000科网泡沫首次防守: 基线 ${firstDefIn(baseTimeline, '1999-06', '2003-03')} → V6 ${firstDefIn(v6tl, '1999-06', '2003-03')}`);
  const aiTight2000 = v6tl.filter(t => t.month >= '2000-01' && t.month <= '2002-12' && t.aiSupply === 'tight').map(t => t.month);
  console.log(`2000-2002 AI维tight月份: ${aiTight2000.length ? aiTight2000[0] + '起共' + aiTight2000.length + '月' : '无'}`);

  runEvalW(D);
}

// ---------- W系变体评估（2026-07-17 第二轮）：以旧基线(V3+V4)为参照系逐项叠加 ----------
// 背景：2010起子样本跑输买入持有2.3pp/年，归因（backtest/attribution.mjs）：
// 假阳性防守段 -1.1pp/年(54%) + V4迟滞多扛月 -0.9pp/年(46%)，真危机段0——2010后13段防守全为假阳性

function evalRowW(name, D, timeline) {
  const s = evaluate(D, timeline);
  const total = s.defMonths + s.reduceMonths + s.nonDefMonths;
  const c = key => s.crisisRows.find(r => r.name.startsWith(key));
  const c08 = c('2008'), c20 = c('2020');
  const recall = s.crisisRows.filter(r => r.firstDefMonth).length;
  // 硬约束：召回≥5/6、2008覆盖≥90%、2020覆盖≥80%、全期年化≥11.4%（比现基线最多让0.3pp）
  const pass = recall >= 5 && (c08?.coveragePct ?? 0) >= 90 && (c20?.coveragePct ?? 0) >= 80
    && s.overall.stratCagr >= 11.4;
  return {
    组合: name,
    全期年化: s.overall.stratCagr, 全期回撤: s.overall.stratMdd,
    '2010起年化': s.overall.sub2010StratCagr, '2010起回撤': s.overall.sub2010StratMdd,
    召回: `${recall}/${s.crisisRows.length}`,
    '08少亏/覆盖': `${c08?.savedPct?.toFixed(1) ?? '—'}pp/${c08?.coveragePct?.toFixed(0) ?? '—'}%`,
    '20少亏/覆盖': `${c20?.savedPct?.toFixed(1) ?? '—'}pp/${c20?.coveragePct?.toFixed(0) ?? '—'}%`,
    假阳性: `${s.falsePositives}/${s.episodes}`,
    防守占比: total ? s.defMonths / total * 100 : 0,
    硬约束: pass ? '过' : '✗',
  };
}

export function runEvalW(D) {
  // W系对照表以"旧基线(V3+V4，W5/X1/X3关)"为参照系——W5于2026-07-17、X1+X3于2026-07-18采纳为默认，
  // 此处显式关掉再逐项叠加，保证采纳前的评估对照表随时可复现
  const run = patch => runReplay(D, {
    ...VARIANTS_DEFAULT, trendReentry: false, sahmLockTrendReentry: false, defenseNeedsAdminOrLock: false, ...patch,
  });
  const fmtW = r => ({
    ...r,
    全期年化: r.全期年化.toFixed(2) + '%', 全期回撤: r.全期回撤.toFixed(1) + '%',
    '2010起年化': r['2010起年化']?.toFixed(2) + '%', '2010起回撤': r['2010起回撤']?.toFixed(1) + '%',
    防守占比: r.防守占比.toFixed(0) + '%',
  });

  console.log('\n===== W系单变体（叠加于旧基线 V3锁存2月+V4降档迟滞；W5已采纳=现默认）=====');
  const W_SINGLES = [
    ['W1防守须含金融维', { defenseNeedsFinancial: true }],
    ['W2 EPU tight 90分位', { epuTightPercentile: 90 }],
    ['W2b EPU tight 85分位', { epuTightPercentile: 85 }],
    ['W3财政仅确认', { fiscalConfirmOnly: true }],
    ['W4a确认期14天', { hysteresisConfirmDays: 14 }],
    ['W4b迟滞限锁驱动', { hysteresisLockOnly: true }],
    ['W4c迟滞关(=V3only)', { downgradeHysteresis: false }],
    ['W5趋势再入场【采纳】', { trendReentry: true }],
  ];
  const singleRows = [
    evalRowW('现基线(V3+V4+W5+X1+X3)', D, runReplay(D, VARIANTS_DEFAULT)),
    evalRowW('旧基线(V3+V4)', D, run({})),
  ];
  for (const [name, patch] of W_SINGLES) singleRows.push(evalRowW(name, D, run(patch)));
  console.table(singleRows.map(fmtW));

  // 组合扫描：{W1,W2(90),W3,W5} 的全部子集 × 迟滞模式 {V4原样, W4b锁限, W4c关}
  const BOOLS = [
    ['W1', { defenseNeedsFinancial: true }],
    ['W2', { epuTightPercentile: 90 }],
    ['W3', { fiscalConfirmOnly: true }],
    ['W5', { trendReentry: true }],
  ];
  const HYST_MODES = [['', {}], ['+W4b', { hysteresisLockOnly: true }], ['+W4c', { downgradeHysteresis: false }]];
  const comboRows = [];
  for (let mask = 0; mask < (1 << BOOLS.length); mask++) {
    const picked = BOOLS.filter((_, i) => mask & (1 << i));
    for (const [suffix, hystPatch] of HYST_MODES) {
      if (!picked.length && !suffix) continue; // 基线已列
      const label = (picked.map(([n]) => n).join('+') || '仅') + suffix;
      comboRows.push(evalRowW(label, D, run(Object.assign({}, ...picked.map(([, p]) => p), hystPatch))));
    }
  }
  comboRows.sort((a, b) => (b['2010起年化'] ?? -99) - (a['2010起年化'] ?? -99));
  console.log('\n===== W系组合（按2010起年化排序；硬约束=召回≥5/6·08覆盖≥90·20覆盖≥80·全期年化≥11.4）=====');
  console.table(comboRows.map(fmtW));
  const pareto = comboRows.filter(r => r.硬约束 === '过');
  console.log(`硬约束内组合 ${pareto.length} 个；2010起买入持有年化对照：见基线行注（12.3% vs 14.6%基准）`);
  runEvalM(D);
}

// ---------- M系变体评估（2026-07-18 第四轮）：市场/估值第5维，目标压缩2000/2022滞后 ----------
// 背景：现基线2000滞后68天、2022滞后148天——四维全是宏观慢变量，抓不到预期驱动的顶。
// M1 趋势票（月末SPX<10月SMA）/ M2 距52周高点回撤票 / M3 CAPE 30年分位>90（确认票形态）。
// 单独跑：node backtest/run-backtest.js --eval-m

function pureFpOf(tl, s) {
  const eps = episodesOf(tl);
  const idxOf = new Map(tl.map((t, i) => [t.month, i]));
  const spans = crisisSpansOf(s.crisisRows);
  return { eps, pure: eps.filter(e => !episodeVerdict(e, tl, idxOf, spans).overlapCrisis) };
}

function evalRowM(name, D, tl, baseDefSet) {
  const s = evaluate(D, tl);
  const c = key => s.crisisRows.find(r => r.name.startsWith(key));
  const c00 = c('2000'), c08 = c('2008'), c22 = c('2022');
  const recall = s.crisisRows.filter(r => r.firstDefMonth).length;
  const { eps, pure } = pureFpOf(tl, s);
  const newDefMonths = baseDefSet
    ? tl.filter(t => t.final === 'defense' && !baseDefSet.has(t.month)).map(t => t.month)
    : [];
  const fmtLead = r => !r?.firstDefMonth ? '未触发'
    : `${r.firstDefMonth}(${r.leadDays >= 0 ? '提前' + r.leadDays : '滞后' + -r.leadDays}天${r.missedKind === 'postTop' ? ',已回落' + r.missedPct.toFixed(1) + '%' : ''})`;
  // 硬约束（任务书口径）：召回≥5/6、2008覆盖≥90%、年化≥12.1%
  const pass = recall >= 5 && (c08?.coveragePct ?? 0) >= 90 && s.overall.stratCagr >= 12.1;
  return {
    row: {
      组合: name,
      年化: s.overall.stratCagr.toFixed(2) + '%', 回撤: s.overall.stratMdd.toFixed(1) + '%',
      防守月: s.defMonths, 召回: `${recall}/6`,
      '2000首防': fmtLead(c00), '2022首防': fmtLead(c22),
      '08覆盖/少亏': `${c08?.coveragePct?.toFixed(1) ?? '—'}%/${c08?.savedPct?.toFixed(1) ?? '—'}pp`,
      '00/22少亏': `${c00?.savedPct?.toFixed(1) ?? '—'}/${c22?.savedPct?.toFixed(1) ?? '—'}pp`,
      纯误报段: pure.length, '假阳性(严格)': `${s.falsePositives}/${s.episodes}`,
      新增防守月: newDefMonths.length,
      硬约束: pass ? '过' : '✗',
    },
    detail: { s, eps, pure, newDefMonths },
  };
}

export function runEvalM(D) {
  console.log('\n═════ M系第5维评估（市场/估值票）——目标：压缩2000(滞后68天)/2022(滞后148天)，不引入新假阳性 ═════');
  console.log(`硬约束：召回≥5/6、08覆盖≥90%、年化≥12.1%（在此之内优先压缩滞后天数）｜CAPE数据源：${D.capeSource ?? '未加载'}`);
  const base = runReplay(D, VARIANTS_DEFAULT);
  const baseDefSet = new Set(base.filter(t => t.final === 'defense').map(t => t.month));
  const capeOk = !!(D.capeM && D.capeM.length);
  const M_DEFS = [
    ['M1 趋势票', { m1TrendVote: true }],
    ['M1b 趋势确认票', { m1TrendVote: true, marketConfirmOnly: true }],
    ['M1x 市+货双tight降级', { m1TrendVote: true, marketMonetaryReduce: true }],
    ['M2@10 52周高点回撤票', { m2DrawdownPct: 10 }],
    ['M2@15', { m2DrawdownPct: 15 }],
    ...(capeOk ? [
      ['M3c CAPE确认票', { capeConfirmVote: true }],
      ['M3f CAPE独立票(诊断)', { capeFullVote: true }],
    ] : []),
    ['M1+M2@10', { m1TrendVote: true, m2DrawdownPct: 10 }],
    ...(capeOk ? [
      ['M1+M3c', { m1TrendVote: true, capeConfirmVote: true }],
      ['M1+M3f', { m1TrendVote: true, capeFullVote: true }],
      ['M2@10+M3c', { m2DrawdownPct: 10, capeConfirmVote: true }],
      ['M1+M2@10+M3c', { m1TrendVote: true, m2DrawdownPct: 10, capeConfirmVote: true }],
    ] : []),
    // 诊断组合（结论证据链，非候选）：X2修货币口径伪影后市场票的2022上界；关W5看趋势门对预警的压制
    ['X2+M1(2022口径上界)', { monetaryCarryDir: true, m1TrendVote: true }],
    ['X2+M2@10', { monetaryCarryDir: true, m2DrawdownPct: 10 }],
    ['M1−W5(诊断)', { m1TrendVote: true, trendReentry: false }],
    ...(capeOk ? [['M3f−W5(诊断)', { capeFullVote: true, trendReentry: false }]] : []),
  ];
  const rows = [];
  const details = new Map();
  {
    const r = evalRowM('基线(V3+V4+W5+X1+X3)', D, base, null);
    rows.push(r.row);
    details.set('基线', { tl: base, ...r.detail });
  }
  for (const [name, patch] of M_DEFS) {
    const tl = runReplay(D, { ...VARIANTS_DEFAULT, ...patch });
    const r = evalRowM(name, D, tl, baseDefSet);
    rows.push(r.row);
    details.set(name, { tl, ...r.detail });
  }
  console.table(rows);
  if (!capeOk) console.log('M3 系列：CAPE 数据不可得（multpl拉取失败且无缓存），如实跳过');

  // FP高危月抽查：跌破趋势线但非>15%大危机的时点（M1/M2型指标在这些点必然投票，看共振后果）
  const SPOT = ['2010-06', '2011-08', '2011-09', '2015-09', '2015-12', '2016-01', '2018-12', '2019-01', '2023-10', '2025-04', '2025-05'];
  console.log('\n----- FP高危月抽查（2010-06/2011-08欧债/2015-08波动/2015-12加息/2018Q4/2023-10/2025-04关税）-----');
  const abbr = { defense: 'D', reduce: 'r', neutral: '·', attack: 'A' };
  console.table([...details.entries()].map(([name, d]) => {
    const o = { 组合: name };
    for (const mo of SPOT) o[mo] = abbr[d.tl.find(t => t.month === mo)?.final] ?? '?';
    return o;
  }));
  console.log('图例：D=全面防守 r=减仓观望 ·=观望');

  // 明细：纯误报段与相对基线新增的防守月
  console.log('\n----- 各变体纯误报段与新增防守月明细 -----');
  for (const [name, d] of details) {
    const pureStr = d.pure.map(e => `${e.start}~${e.end ?? '在续'}(${e.months.length}月)`).join(' ') || '无';
    if (name === '基线') { console.log(`基线 纯误报段: ${pureStr}`); continue; }
    console.log(`${name}\n  纯误报段: ${pureStr}\n  新增防守月(${d.newDefMonths.length}): ${d.newDefMonths.join(' ') || '无'}`);
  }
}

function writeReport(s, timeline) {
  const f = v => v === null || v === undefined ? '—' : (typeof v === 'number' ? v.toFixed(1) : v);
  const missedCell = c => c.missedKind === 'preTop' ? `信号后再涨+${f(c.missedPct)}%见顶`
    : c.missedKind === 'postTop' ? `已回落${f(c.missedPct)}%` : '—';
  const rows = s.crisisRows.map(c =>
    `| ${c.name} | ${c.peakDate} | ${c.troughDate} | ${f(c.drawdownPct)}% | ${c.firstDefMonth ?? '未触发'} | ${c.leadDays === null ? '—' : (c.leadDays >= 0 ? `提前${c.leadDays}天` : `滞后${-c.leadDays}天`)} | ${missedCell(c)} | ${c.savedPct === null ? '—' : `${c.savedPct >= 0 ? '+' : ''}${f(c.savedPct)}pp`} | ${c.coveragePct === null ? '—' : `${f(c.coveragePct)}%`} | ${c.recoverMonth ?? '—'} | ${c.lockTypes} |`
  ).join('\n');

  const md = `# 股哨兵决策树历史回测报告

生成时间：${new Date().toISOString().slice(0, 10)} ｜ 数据源：FRED（利率 DFEDTAR+DFEDTARU 拼接、WALCL、MTSO133FMS+PCEPI平减(实际支出口径)、EPUTRADE、SAHMREALTIME）｜ 标普500：${s.spxSource}

## 方法论

- **重放粒度**：月末采样，${s.monthsCovered} 个月（2000-01 起），逐月用与线上完全一致的阈值（\`signal.config.js\`）重算四维信号、萨姆锁/应对式调整锁与最终信号。未收官的当前日历月（月中重跑时只有半个月数据）从重放中剔除。
- **前视偏差规避 + 发布滞后建模**：月度指标（财政/萨姆/EPUTRADE）在 M 月末决策时只用 M-1 月及更早的观测（模拟真实发布时点：财政次月中旬、萨姆次月初、EPU月后编制）；财政平减用的 PCEPI 用 M-2 月及更早（BEA 发布日在月末边界上）；EPU 百分位只用截至当时的近120个月窗口（数据自1987年起拉取，2000-01 起每个月都有足额120个月观测）；锁状态按时间顺序锁存演进，不回看。残余局限：FRED 只存最新修订版而非当时 vintage（萨姆/EPU/财政/PCEPI 均受影响，见"局限"）。
- **利率序列**：DFEDTAR（2008-12-15止，点目标）与 DFEDTARU（其后，区间上限）拼接；月度变动 = 当月末 vs 上月末，≥50bp 判应对式收紧。注：线上系统 2026-07-17 起按"最近一次FOMC决议方向"判定货币维（加息决议→收紧保持到下次决议），月度差分是其近似。
- **资产负债表（WALCL）**：每个月末采样时取该时点可得的最新两条周度观测做环比（与线上 fetch-macro 同口径），±0.25% 阈值；WALCL 周三数据次日（周四）才发布，仅"发布日≤采样日"的观测参与。
- **最短锁存期 + 档位降档迟滞（2026-07-17 变体评估采纳，本报告默认启用）**：①任一锁触发后至少锁存2个月才允许小幅调整解锁（零利率解锁不受限）——复用线上 \`calcLockActive\`，月度锁龄×30天 对齐线上 \`LOCK_MIN_AGE_DAYS=60\` 天；②最终档位**降档**（向宽松）需连续2个月决策树给出更宽松档才生效，**升档**（向防守）即时——复用线上 \`applyDowngradeHold\`，标准月=30天 对齐线上 \`FINAL_DOWNGRADE_CONFIRM_DAYS=30\` 天确认期。与未启用的旧基线对比：年化 11.3%→11.7%、2008防守覆盖 66.7%→94.4%（少亏 35.5→58.1pp）、2020覆盖 80%→100%、假阳性 20/26→17/19；代价：2010起子样本年化 13.3%→12.3%、复苏入场平均晚约1个月。同轮评估否决：V1趋势确认（-1.0pp，2007-10月末价仍在10月SMA上方拦不住解锁）、V2降息锁方向约束（-0.5pp，2001锁到2004、2025-10起锁死）、V5实际利率封顶（非对称进攻树下结构性无影响）、V6半导体AI维（-1.4pp，见"结论"5）。对照表可用 \`node backtest/run-backtest.js --eval\` 复现。
- **趋势再入场加速器（2026-07-17 第二轮评估采纳 W5，本报告默认启用）**：月末 SPX ≥ 10月SMA（近10个月末收盘均值，含当月）时，**决策树驱动**的全面防守（defense）降级为减仓观望（reduce）；**锁驱动**的 defense 不受影响——锁是确证的危机应对，不被趋势否决。线上等价实现：日频最新收盘 vs 含当月的10个月末收盘SMA。动机来自 2010 起跑输买入持有 2.3pp/年 的归因（\`backtest/attribution.mjs\`）：2010 后 13 段防守片段全部假阳性，主力是 2016-19"货币tight+EPU常态高位"共振群与 2024-08 萨姆锁误触发后被财政+行政续命的 14 个月（单段 -17.3pp），而这些月份市场都在趋势上方。效果：全期年化 11.7→12.2%、2010起 12.3→12.9%、假阳性 17/19→6/8、全面防守占比 38%→25%、2008 覆盖 94.4%/少亏 58.1pp 不变；代价：2020 首防从提前111天变滞后9天（少亏 14.8→12.6pp、覆盖仍100%）、2025 少亏 6.6→1.2pp。同轮否决：W1防守须含金融维/W3财政仅确认（均丢 2020/2025 召回，5/6→3/6 硬伤）、W2 EPU阈值90分位/W4b迟滞限锁驱动（08覆盖 94→89% 打穿硬约束——都丢 2009-01 那个迟滞尾巴月，SPY 当月 -8.6%）、W4a确认期14天（月度粒度下与30天不可分，留待线上日频评估）。
- **萨姆锁趋势门 + 纯"货币+财政"共振降级（2026-07-18 第三轮准确率归因采纳 X1+X3，本报告默认启用）**：①X1——趋势再入场门扩展到**萨姆锁驱动**的防守（应对式锁仍豁免；X1b 对照实测应对式锁也过门会砸掉 2008 年顶前入场，08少亏 58.1→50.7pp，否决）；②X3——纯"货币+财政"双维共振（最窄口径：恰两维收紧且为货币+财政，AI 参与的共振不动）降级为减仓观望。两条均复用线上实现单一来源（\`applyTrendReentry\`/\`calcFinalSignal\`）。归因出处（\`node backtest/accuracy-report.mjs\` 可复现）：2004-08 假防守段=渐进加息25bp+财政TTM同比5.4%擦线过阈值的纯噪声（当时EPU仅6.7分位）；2024-08 萨姆锁=萨姆规则1970年来首次假阳性（移民推高失业率致失业率上升而非需求崩塌），触发时市场全程在10月SMA上方，而2001/2008/2020三次真触发时市场均已跌破趋势线。效果：全期年化 12.2→12.4%、纯误报防守段 3→2、防守月 79→76，召回 5/6、2008覆盖 94.4%/少亏 58.1pp、最大回撤 -16.2% 全部不变——逐月 diff 仅 2004-08/09/10、2024-08 四个月档位变化且全踩在上涨月。同轮否决：X2 货币决议方向口径（同时证明月度回测与线上决议口径的全期差异 ≤0.1pp/年，2022 滞后148天与口径无关，是"预期驱动的顶"在四维框架外）、X4 萨姆锁确认2月（08覆盖 94.4→88.9% 打穿硬约束，对2024只延迟1个月）。
- **AI供需维度**：历史上无意义，全程置为观望（neutral）——见"局限"。

## 危机明细

| 危机 | 市场顶部 | 市场底部 | 最大回撤 | 首次防守信号 | 相对顶部 | 踏空/回落 | 相对买入持有少亏 | 防守覆盖率 | 恢复非防守 | 触发来源 |
|---|---|---|---|---|---|---|---|---|---|---|
${rows}

> **"踏空/回落"双语义**：提前捕获行（信号早于顶部）显示"信号后再涨 +X% 见顶"=防守后市场又涨了这么多才见顶（踏空成本）；滞后捕获行显示"已回落 −X%"=信号发出时已从顶部跌掉的部分（错过的部分）。
> **"相对买入持有少亏"按实际曝险路径计算**：从首次防守信号月到危机底部月逐月复利——defense 月按现金（联邦基金利率月化，与全期模拟同口径），非 defense 月按 SPY 月收益；该值 = 路径收益 − 同期买入持有收益（百分点，正=少亏）。防守片段中途解除（如 2008：2007-10 即恢复；2020：2019-12 已恢复）如实计入，**不再假设从首次信号一路防守到底部**（旧口径按 底部价/信号价−1 计算，系统性高估保护效果）。路径终点为底部月的月末采样价。
> **"防守覆盖率"** = 首次信号月到底部月之间（曝险决策月口径）defense 月占比，反映保护的真实密度。
> 提前捕获的严格定义：首次防守信号发出日早于市场顶部日（leadDays > 0）。仅"窗口内出现过防守月"不计为提前捕获。

## 全期统计

- 全面防守期月均收益：**${f(s.avgDefenseRet)}%**（${s.defMonths} 个月）｜减仓观望期：**${f(s.avgReduceRet)}%**（${s.reduceMonths} 个月）｜其余：**${f(s.avgNonDefenseRet)}%**（${s.nonDefMonths} 个月）
- **全面防守占比：${(s.defMonths / (s.defMonths + s.reduceMonths + s.nonDefMonths) * 100).toFixed(0)}%**，减仓观望占比：${(s.reduceMonths / (s.defMonths + s.reduceMonths + s.nonDefMonths) * 100).toFixed(0)}%（防守分级后，单维收紧不再全仓防守）
- 全期（${s.overall.years.toFixed(1)}年）：买入持有 年化 ${f(s.overall.buyHoldCagr)}%、最大回撤 ${f(s.overall.buyHoldMdd)}%；策略（仅defense离场，defense月计现金利息）年化 ${f(s.overall.stratCagr)}%、最大回撤 ${f(s.overall.stratMdd)}%
- **敏感性（照档位建议执行）**："reduce=50%仓"策略（reduce 月 50% SPY + 50% 现金利息；defense 月全现金；其余满仓）：年化 ${f(s.overall.reduceHalfCagr)}%、最大回撤 ${f(s.overall.reduceHalfMdd)}%——与上行"仅defense离场"口径并列，反映严格按档位执行的真实预期
- **子样本稳健性（2010-01 起，${f(s.overall.sub2010Years)}年）**：策略年化 ${f(s.overall.sub2010StratCagr)}%（最大回撤 ${f(s.overall.sub2010StratMdd)}%）vs 买入持有年化 ${f(s.overall.sub2010BuyHoldCagr)}%（最大回撤 ${f(s.overall.sub2010BuyHoldMdd)}%）——策略的超额收益高度依赖起点包含 2000 年泡沫顶；后半段策略主要贡献是降回撤而非增收益
- 各维度收紧月数：货币 ${s.dimTight.monetary}、财政 ${s.dimTight.fiscal}、行政 ${s.dimTight.admin}；锁激活 ${s.dimTight.lockMonths} 个月
- 防守信号片段共 **${s.episodes}** 段，其中 **${s.falsePositives}** 段未伴随随后12个月内 >15% 的回撤（假阳性率 ${s.episodes ? (s.falsePositives / s.episodes * 100).toFixed(0) : '—'}%）

## 阈值敏感性简评

- **±50bp 应对式阈值（月度口径）**：加息/降息周期中相邻两次25bp会在月度差分中合并为50bp，使应对式锁在整个周期内长期锁存——这是防守占比偏高的主要来源之一。线上系统按快照差（日级）判定，比月度回测更精确。
- **财政 ±5%**：TTM 实际支出同比波动频繁越过阈值，贡献了大量单维收紧月份。
- **EPU >80 分位**：2018-2019 贸易战与 2025 关税周期长期处于高分位，行政维度在这些年份几乎常态收紧。
- **萨姆锁 0.5**：2001、2008-2009、2020 衰退期均如期触发，衰退识别可靠。

## 局限

1. **AI供需维度缺席**：四维只剩三维参与，历史上"进攻"档几乎不出现（进攻要求四全宽松），本报告聚焦防守端评估。
2. **WALCL 2002-12 前缺失**：2000 年危机的货币维度只有利率子信号。
3. **月度重放粒度**：线上按日运行且利率基线用快照差，月度差分会把相邻小幅调整合并成"应对式"，高估锁的锁存时长；提前/滞后天数有 ±30 天误差带。
4. **修订版 vs vintage**：SAHMREALTIME/EPUTRADE/MTS财政支出/PCEPI 用的都是 FRED 最新修订版而非当时可见的原始值（财政与 PCEPI 均有后续修订），与实时决策存在残余偏差。
5. **SPY 代理 SPX**：ETF 价格与指数走势一致，顶部/底部日期可能相差1个交易日以内。
6. **假阳性为保守上界**：假阳性判定用月末采样价，月中盘中出现过 >15% 但月末收复的回撤会被漏计，${s.episodes ? (s.falsePositives / s.episodes * 100).toFixed(0) : '—'}% 是保守上界。

## 结论与建议

> 本报告为**财政口径两次修正后**的结果：2026-07-12 方向反转（"大市场小政府"原则：政府扩张=收紧），2026-07-16 起指标从旧口径的名义赤字（MTSDS133FMS，TTM赤字同比）改为新口径的实际支出（MTSO133FMS 名义支出，经 PCEPI 平减）。历史对比：最早的赤字旧口径（赤字扩大=宽松）四次危机全部提前示警（56/254/236/189 天）但防守占比 83%、假阳性 23/24；新口径见下。

1. **捕获情况**：${s.crisisRows.filter(c => c.firstDefMonth).length}/${s.crisisRows.length} 场危机触发防守信号，其中 ${s.crisisRows.filter(c => c.leadDays !== null && c.leadDays > 0).length} 场为提前捕获（信号早于顶部）、${s.crisisRows.filter(c => c.leadDays !== null && c.leadDays <= 0).length} 场为滞后捕获（相对顶部：${s.crisisRows.map(c => c.leadDays === null ? '—' : (c.leadDays > 0 ? `提前${c.leadDays}天` : `滞后${-c.leadDays}天`)).join('、')}）。滞后捕获多由应对式利率锁在危机演进中接管。
2. **防守分级已生效（2026-07-12 用户拍板）**：单维收紧=减仓观望（部分仓位），双维共振或锁=全面防守（空仓/对冲）。全面防守占比 ${(s.defMonths / (s.defMonths + s.reduceMonths + s.nonDefMonths) * 100).toFixed(0)}%（分级前为 74%），大量单维噪声月份降级为减仓观望。
3. **精确率仍是主要代价**：${s.episodes ? (s.falsePositives / s.episodes * 100).toFixed(0) : '—'}% 的防守片段未跟随大回撤，防守期月均收益 ${f(s.avgDefenseRet)}%（${s.avgDefenseRet >= 0 ? '仍为正，说明防守期常有踏空成本' : '为负，防守有效规避了下跌'}；vs 非防守 ${f(s.avgNonDefenseRet)}%）。若严格按信号空仓执行会错过部分上涨月份。
4. **对执行层的建议（阈值调优方向，非代码错误）**：
   - 防守分级：单维收紧 → 减仓/观望；双维以上收紧或任一锁激活 → 全面防守。锁与多维共振在历史上与真实危机高度重合。
   - 财政/行政维度可考虑从"OR 即触发"降级为"确认性信号"（需与货币或供需共振才触发防守）。
   - 任何阈值修改后应重跑本回测（\`node backtest/run-backtest.js\`）对比防守占比与召回率的变化。
5. **半导体代理AI维假设已验证不成立（2026-07-17 评估否决）**：曾计划"AI供需维度用半导体IP同比代理回测2000年科网泡沫，检验供需维度能否比政策维度更早示警"。实测（IPG3344S 半导体产出同比，M-2可见性）：该指标为质量调整口径，2000年全年同比 +43~52%、泡沫破裂首年（2001上半年）仍 +12~45%，仅2001-11/12短暂转负2个月——泡沫期AI维投的是**宽松**票，首次防守时点（2000-05）无任何提前；而2019年半导体下行周期（同比负9个月）造成全年防守、区间收益 -12.2pp，全期年化 -1.4pp。半导体产出不是泡沫顶部的前瞻指标（2015-16下行撞上回调属巧合获益 +13.8pp，2023H1零影响）。
6. **2010起跑输归因与W5采纳（2026-07-17 第二轮）**：W5前基线2010起子样本跑输买入持有2.3pp/年，逐段归因（\`node backtest/attribution.mjs\` 可复现）分解为：**假阳性防守段 -1.07pp/年（54%）+ V4迟滞多扛月 -0.90pp/年（46%）+ 真危机段时机损耗 0**——2010后13段全面防守片段按"随后12月>15%回撤"口径**全部为假阳性**，最大单段是2024-08萨姆锁误触发后被财政+行政续命的14个月（-17.3pp）。W5趋势再入场采纳后差距收窄至约1.7pp/年，且全期年化不降反升。备选决策项：若愿把2008覆盖硬约束从≥90%松到≥85%，W2(EPU tight 90分位)+W4b(迟滞限锁驱动) 组合可达全期12.9%/2010起15.0%（反超买入持有0.4pp/年），代价是2008少亏 58.1→46.0pp（差额全在2009-01一个迟滞尾巴月）——留作用户决策项。
`;
  fs.writeFileSync(path.join(__dirname, '../../docs/backtest-report.md'), md);
}

// 直接运行时执行（被 import 时只导出纯函数）
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(err => { console.error('[backtest] failed:', err.message); process.exit(1); });
}
