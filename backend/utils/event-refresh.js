// 事件驱动即时刷新引擎（128号，2026-09-17）。
//
// 用户原则（原话）："参考指标里的所有参数，一经公布，则在我们网页上立即更新，然后决策系统立即同步更新。"
//
// 但"立即"不是对所有指标都成立，必须按发布节奏分两类（本引擎只服务第一类）：
//
//  A. **离散事件型**——发布时刻已知且结果一经公布即永久确定，不存在"晚点再看会变"：
//     FOMC 决议（美东 14:00）、劳工统计局/BEA 的 08:30 月度发布（失业率/CPI/PCE/萨姆）等。
//     这类指标**必须**在发布当天就反映，等 21:00 纯属无谓滞后，本引擎处理这一类。
//
//  B. **连续行情型**——WTI 油价、信用利差 BAA10Y、收益率曲线 T10Y3M、EPU 日频：
//     它们每时每刻都在变，而系统按"每日 21:00 采样点"记 track record。把这几个改成盘中实时刷新，
//     会让采样点从"固定时点"漂移成"最后一次访问的时刻"，历史序列失去可比性，
//     且回测（run-backtest/daily-replay）锚定的是收盘口径——**结论是这几个保持 21:00，
//     不是不能做，是做了会破坏时间序列语义**。日频指标滞后 1-2 天在既有判定里已被容忍
//     （油价看30天窗口、曲线看63交易日窗口、信用利差看90日窗口）。
//
// 因此本引擎的定位：给"事件型"指标提供统一的即时落地路径，而不是把全部指标都实时化。
//
// 三条不变量（与决议日实现完全一致，均为历次审查的教训）：
//   ① **只更新既有快照行，绝不 INSERT**——track record 采样点不可被污染；
//   ② **降档守卫**：重算结果比现生效档更宽松时一动不动，等 21:00 完整管道定性；
//      （方向单侧化 = 最坏情况"该防守没防守"变成"该宽松没宽松"，后者可容忍）
//   ③ **任何外部失败都降级为"等今晚 21:00"**，绝不让新源成为判定链的单点故障。
//
// 与"绝不提前跑"不变量的关系：该不变量约束的是"用不完整的当日数据冒充 21:00 采样点"
// （收盘价/财报未出）。事件型指标不存在"晚上还会变"，且本引擎只更新已存在的当天快照、
// 只写受该事件影响的维度，不触碰 evening-only 字段。

import {
  getLatestSnapshot, getAllOverrides, updateSnapshotFields,
} from './storage.js';
import {
  calcMonetarySignal, calcFiscalSignal, calcAdminSignal, calcAiSupplySignal,
  deriveAiSupplySubSignals, calcFinalSignal,
  applyYieldCurveVeto, applyCreditSpreadVeto, applyRealRateVeto,
  applyTrendReentry, applyTrendFloor, applyDowngradeHold,
} from '../api/signal.js';
import { computeLocks } from '../api/locks.js';
import { fetchMacroData } from '../api/fetch-macro.js';
import { fetchPolicyData } from '../api/fetch-policy.js';
import { sendOpsAlert } from './mailer.js';
import { todayET } from './datetime.js';

const SEVERITY = { defense: 3, reduce: 2, neutral: 1, attack: 0 };
const severity = s => SEVERITY[s] ?? 1;

// 各维度可即时刷新的白名单：只有事件型指标驱动的维度在此列。
// 行政维依赖 EPU 日频与油价（连续行情型）→ 不进白名单；
// AI供需维依赖 EDGAR 财报日与 OpenRouter 调用量（发布节奏不定）→ 不进白名单。
export const EVENT_REFRESHABLE_DIMENSIONS = ['monetary', 'fiscal'];

/**
 * 用最新拉取的宏观数据，重算指定维度并评估是否应立即改写当天快照。
 * 纯函数（不碰库），便于测试覆盖全部方向组合。
 *
 * @param {object} p
 * @param {object} p.macroData - fetchMacroData 的返回
 * @param {object} p.policyData - fetchPolicyData 的返回（财政维输入）
 * @param {object} p.snapshot - 当天快照行
 * @param {object} p.overrides - getAllOverrides 的返回
 * @param {string} p.today
 * @param {string[]} [p.dimensions] - 本次事件影响的维度（默认 EVENT_REFRESHABLE_DIMENSIONS）
 * @param {Array<{key:string, label:string}>} [p.changedInputs] - 调用方已确认"确实变了"的输入清单
 * @returns {{apply:boolean, reason?:string, monetary?:string, fiscal?:string, finalSignal?:string,
 *            pendingSince?:string|null, pendingCandidate?:string|null, locks?:object}}
 */
export function evaluateEventRefresh({
  macroData, policyData, snapshot, overrides, today,
  dimensions = EVENT_REFRESHABLE_DIMENSIONS, changedInputs = [],
}) {
  if (!snapshot) return { apply: false, reason: 'no_snapshot' };

  // 货币维（联邦基金利率）：Fed 声明源在决议日顶替 FRED 滞后值
  const monetary = dimensions.includes('monetary')
    ? calcMonetarySignal(macroData)
    : (snapshot.monetary_auto_signal || snapshot.monetary_signal);
  // 财政维（联邦支出 TTM 实际同比）：BEA/财政部月度发布
  const fiscal = dimensions.includes('fiscal')
    ? calcFiscalSignal(policyData)
    : (snapshot.fiscal_auto_signal || snapshot.fiscal_signal);
  // 行政维与 AI供需维不在事件型白名单内，沿用快照生效值
  const admin = snapshot.admin_auto_signal || snapshot.admin_signal;
  const aiSupply = snapshot.ai_supply_auto_signal || snapshot.ai_supply_signal;

  const locks = computeLocks(macroData, snapshot, overrides, today);

  const decisionTreeSignal = applyRealRateVeto(
    applyCreditSpreadVeto(
      applyYieldCurveVeto(
        calcFinalSignal(aiSupply, monetary, fiscal, admin),
        snapshot.yield_curve_inverted_days ?? null
      ),
      snapshot.credit_spread_90d_widen_bp ?? null
    ),
    macroData.currentRate, macroData.trimmedPce12m
  );
  const lockActiveNow = locks.sahmLockActive || locks.reactiveAdjustmentLockActive;
  const spxAboveSma10 = snapshot.spx_above_sma10 == null ? null : !!snapshot.spx_above_sma10;
  const candidate = applyTrendFloor(
    applyTrendReentry(lockActiveNow ? 'defense' : decisionTreeSignal, {
      sahmLockActive: locks.sahmLockActive,
      reactiveLockActive: locks.reactiveAdjustmentLockActive,
      spxAboveSma10,
    }),
    spxAboveSma10
  );

  // 不变量②：降档守卫——比现生效档更宽松一律不动
  const prevEffective = snapshot.final_signal || null;
  if (prevEffective && severity(candidate) < severity(prevEffective)) {
    return { apply: false, reason: `would_ease (${candidate} < ${prevEffective})`, monetary, fiscal };
  }
  const hold = applyDowngradeHold(
    candidate, prevEffective,
    snapshot.final_downgrade_pending_since, today,
    snapshot.final_downgrade_pending_candidate
  );

  // 无实质变化则不写库（避免无意义 IO 与告警）
  const finalSignal = hold.signal;
  const dimChanged = (dimensions.includes('monetary') && monetary !== snapshot.monetary_signal)
    || (dimensions.includes('fiscal') && fiscal !== snapshot.fiscal_signal);
  if (!dimChanged && finalSignal === prevEffective) {
    return { apply: false, reason: 'no_change', monetary, fiscal };
  }

  return {
    apply: true,
    monetary, fiscal, finalSignal, locks,
    pendingSince: hold.pendingSince, pendingCandidate: hold.pendingCandidate,
    changedInputs,
  };
}

/**
 * 落库：把评估结果写进既有的当天快照行（只 UPDATE，绝不 INSERT）。
 * 只写事件影响的列；其余字段原样保留，维持 21:00 采样点的语义完整性。
 */
export function buildSnapshotPatch(evaluation, macroData) {
  const patch = {
    final_signal: evaluation.finalSignal,
    final_downgrade_pending_since: evaluation.pendingSince,
    final_downgrade_pending_candidate: evaluation.pendingCandidate,
  };
  if (evaluation.monetary !== undefined) patch.monetary_signal = evaluation.monetary;
  if (evaluation.fiscal !== undefined) patch.fiscal_signal = evaluation.fiscal;
  if (evaluation.locks) {
    patch.sahm_lock_active = evaluation.locks.sahmLockActive ? 1 : 0;
    patch.reactive_adjustment_lock_active = evaluation.locks.reactiveAdjustmentLockActive ? 1 : 0;
    patch.reactive_adjustment_lock_trigger_bp = evaluation.locks.reactiveAdjustmentLockTriggerBp;
  }
  return patch;
}

/**
 * 事件型指标的"发布检测"：把本次拉取到的参考期/发布日期与快照里存的比对，
 * 找出**确实发布了新数据**的指标。
 *
 * 为什么用这个判据而不是"每隔N分钟重拉一次就重算"：后者会在没有新发布的日子里
 * 反复重算同一份数据（无谓 IO 与告警风险），且拿不到"是新数据触发的"这个语义。
 * 参考期变化 = 数据源确实翻到了新一期，是最可靠的事件信号。
 *
 * 覆盖指标（均为发布时刻固定、结果公布即确定的离散事件型）：
 *   - 联邦基金利率（FOMC 决议，美东 14:00）
 *   - 核心PCE / 截尾PCE 三期 / 失业率 / 萨姆（BEA/BLS 08:30 月度发布）
 *   - 联邦月度支出（财政部 MTS，月度）
 *   - 半导体产出（美联储 G.17，月度）
 * 明确不含连续行情型（WTI/信用利差/收益率曲线/EPU 日频）——见文件头第 B 类说明。
 *
 * @param {object} macroData - 本次 fetchMacroData 的返回
 * @param {object} policyData - 本次 fetchPolicyData 的返回（可为 null，则跳过相关项）
 * @param {object} snapshot - 当天快照行
 * @returns {Array<{key:string, label:string, from:string|null, to:string|null}>} 有更新的指标
 */
export function detectPublishedIndicators(macroData, policyData, snapshot) {
  if (!snapshot) return [];
  // 每项：快照列名（存参考期的列） + 本次值 + 展示名
  const checks = [
    ['rate_decision_date', macroData?.rateDecisionDate, 'FOMC 决议日'],
    ['core_pce_period_date', macroData?.corePcePeriodDate, '核心PCE同比'],
    ['trimmed_pce_1m_period_date', macroData?.trimmedPce1mPeriodDate, '截尾均值PCE(1个月)'],
    ['trimmed_pce_period_date', macroData?.trimmedPcePeriodDate, '截尾均值PCE(6个月)'],
    ['trimmed_pce_12m_period_date', macroData?.trimmedPce12mPeriodDate, '截尾均值PCE(12个月)'],
    ['unemployment_period_date', macroData?.unemploymentPeriodDate, '失业率'],
    ['sahm_period_date', macroData?.sahmPeriodDate, '萨姆规则'],
    ['semi_ip_period_date', policyData?.semiIpPeriodDate, '半导体产出同比'],
    ['fiscal_period_date', policyData?.fiscalPeriodDate, '联邦月度支出'],
  ];
  const changed = [];
  for (const [col, now, label] of checks) {
    if (now === null || now === undefined) continue;      // 本次没拉到，跳过（stale-keep 语义）
    const stored = snapshot[col] ?? null;
    // 仅在"参考期前移"（新一期）时算更新；参考期回退说明数据源回滚，不据此改写
    if (stored === null) continue;                        // 旧库无该列，交由 21:00 完整管道写全
    if (now > stored) changed.push({ key: col, label, from: stored, to: now });
  }
  return changed;
}

/**
 * 事件型指标 → 受影响维度。用于把"哪些指标更新了"映射成"该重算哪个维度"。
 * 只映射到 EVENT_REFRESHABLE_DIMENSIONS 内的维度（其余维度不在事件型白名单内）。
 */
export function dimensionsForIndicators(changed) {
  const dims = new Set();
  for (const c of changed) {
    if (c.key === 'rate_decision_date') dims.add('monetary');
    if (c.key === 'fiscal_period_date') dims.add('fiscal');
  }
  return [...dims];
}

/**
 * 完整的"事件驱动即时刷新"流程：拉数据 → 检测新发布 → 评估 → 落库 → 告警。
 *
 * 触发方式（调用方决定，本函数只做一次尝试）：
 *   - 每日 cron 之后（几乎总是 no_change，成本一次完整拉取）
 *   - 页面访问触发（仅当冷却已过）
 *   - 专项轮询（如美东上午 08:35 / 10:05 / 14:05 三次定点）
 * 注意本函数会发起一次完整宏观拉取（约 20 次 HTTP），因此**不应**放在每次页面访问的路径上，
 * 必须由调用方用冷却或定点时点控制频次。
 *
 * @returns {Promise<{updated:boolean, reason?:string, changed?:Array, dimensions?:Array,
 *                    monetary?:string, fiscal?:string, finalSignal?:string}>}
 */
export async function runEventDrivenRefresh({ today = todayET(), deps = {}, label = '事件型指标发布' } = {}) {
  const fetchMacro = deps.fetchMacro || fetchMacroData;
  const fetchPolicy = deps.fetchPolicy || fetchPolicyData;
  const getLatest = deps.getLatest || getLatestSnapshot;
  const getOverrides = deps.getOverrides || getAllOverrides;
  const updateFields = deps.updateFields || updateSnapshotFields;
  const alert = deps.alert || sendOpsAlert;
  const log = deps.log || console.log;

  const snapshot = await getLatest();
  if (!snapshot) return { updated: false, reason: 'no_snapshot' };

  let macroData, policyData;
  try {
    macroData = await fetchMacro();
  } catch (err) {
    return { updated: false, reason: `macro_fetch_failed: ${err.message}` };
  }
  try {
    policyData = await fetchPolicy();
  } catch (err) {
    // 财政维输入拉取失败 → 只处理宏观侧事件，财政维本次不参与（沿用快照值）
    log(`[event-refresh] policy fetch failed, fiscal dimension skipped: ${err.message}`);
    policyData = null;
  }

  const changed = detectPublishedIndicators(macroData, policyData, snapshot);
  if (!changed.length) return { updated: false, reason: 'no_new_release' };
  const dimensions = dimensionsForIndicators(changed);
  if (!dimensions.length) {
    // 有新发布，但落在非事件型白名单维度（如 PCE/失业率只影响否决器与展示）→ 不改动判定链
    return { updated: false, reason: `release_not_decision_relevant (${changed.map(c => c.label).join('、')})`, changed };
  }

  const overrides = await getOverrides();
  const evaluation = evaluateEventRefresh({
    macroData, policyData, snapshot, overrides, today, dimensions, changedInputs: changed,
  });
  if (!evaluation.apply) return { updated: false, reason: evaluation.reason, changed, dimensions };

  const written = await updateFields(snapshot.id, buildSnapshotPatch(evaluation, macroData));
  if (!written) return { updated: false, reason: 'patch_rejected', changed };

  const payload = buildEventAlertPayload({
    evaluation, snapshot, macroData, today,
    eventLabel: `${label}：${changed.map(c => c.label).join('、')}`,
  });
  await alert(process.env.ADMIN_EMAIL, payload).catch(() => {});
  log(`[event-refresh] ${payload.stage} — ${payload.error}`);

  return {
    updated: true, changed, dimensions,
    monetary: evaluation.monetary, fiscal: evaluation.fiscal, finalSignal: evaluation.finalSignal,
  };
}
/**
 * 事件告警文案（管理员）：本引擎改变了档位或维度时发信。
 * 用户明确要求"一经公布就通知我"，故不依赖订阅者告警链。
 */
export function buildEventAlertPayload({ evaluation, snapshot, macroData, eventLabel, today }) {
  const bits = [];
  if (evaluation.monetary !== undefined && evaluation.monetary !== snapshot.monetary_signal) {
    bits.push(`货币维 ${snapshot.monetary_signal} → ${evaluation.monetary}`);
  }
  if (evaluation.fiscal !== undefined && evaluation.fiscal !== snapshot.fiscal_signal) {
    bits.push(`财政维 ${snapshot.fiscal_signal} → ${evaluation.fiscal}`);
  }
  if (evaluation.finalSignal !== snapshot.final_signal) {
    bits.push(`最终档位 ${snapshot.final_signal} → ${evaluation.finalSignal}`);
  }
  return {
    stage: `${eventLabel}（${today}）`,
    error: `${bits.join('；') || '维度取值已更新'}；`
      + `已就地更新 ${snapshot.date} 当天快照（不新增采样点），21:00 完整管道会再核一遍。`
      + (evaluation.changedInputs?.length
        ? `触发输入：${evaluation.changedInputs.map(c => c.label).join('、')}。` : ''),
    dataDate: snapshot.date,
  };
}
