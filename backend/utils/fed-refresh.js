// FOMC 决议日即时重算（127号，2026-09-17，用户要求"一经公布就在网页上同步更新并反映到决策系统"）
//
// 问题：决议在美东 14:00 由 Fed 官网发布，而系统的更新时点是每日 21:00 的完整管道——
// 决议当天 14:00-21:00 这 7 小时网页仍显示决议前的状态，正好覆盖"最需要信息的时段"。
// 2026-09-16 加息 25bp 后，用户上午打开页面看到的是"3.75% 0.00%（持平）"。
//
// 本模块只做一件事：决议日 14:00 后，用 Fed 官方声明（见 fetch-fed-rate.js）把**货币维**重算一遍
// 并就地更新"今天这条快照"，让网页与判定系统立刻反映决议结果。
//
// 与"绝不提前跑"不变量的关系（绝不是绕过它）：
//   - 该不变量约束的是"用不完整的当日数据（收盘价/财报未出）冒充 21:00 采样点"。而 FOMC 决议
//     是 14:00 起就永久确定的离散事件，不存在"晚上还会变"；重算只动货币维 + 锁 + 最终档位，
//     不触碰 SPX/产业链/日报等 evening-only 字段；
//   - 更新对象是**已存在的今天这条快照**（21:00 正式 cron 的产物或 catchUp 补跑产物），
//     没有就跳过（不新建）；21:00 的完整 cron 照常运行并覆盖为最终版本；
//   - 绝不降档（见下 reviewLevel 参数）。
//
// 降档守卫：本模块永远不让最终档位变得更宽松（只允许"升档/维持"）。两个理由：
//   ① 防抖需求——决议当天重算的货币维若比快照更宽松，会与 21:00 完整 cron 的结论产生
//      "14:00 升档 → 21:00 降档"来回翻转与成对反向邮件；
//   ② 防错需求——货币维重算依赖 Fed 声明解析，解析异常时的最坏情况是"误判宽松"，只允许升档
//      使该风险单侧化（误判宽松时什么都不发生，不会误解除防守）。
//   该方向性恰好与既有策略公理一致："防守不过夜"（历次审查教训"判定链修复均漏防守侧"）。

import {
  getLatestSnapshot, getAllOverrides, updateSnapshotFields,
} from '../utils/storage.js';
import { fetchMacroData } from '../api/fetch-macro.js';
import {
  calcMonetarySignal,
  calcFinalSignal, applyYieldCurveVeto, applyCreditSpreadVeto, applyRealRateVeto,
  applyTrendReentry, applyTrendFloor, applyDowngradeHold,
} from '../api/signal.js';
import { computeLocks } from '../api/locks.js';
import { sendOpsAlert } from '../utils/mailer.js';
import { todayET } from '../utils/datetime.js';

const SEVERITY = { defense: 3, reduce: 2, neutral: 1, attack: 0 };
const severity = s => SEVERITY[s] ?? 1;

// 进程内冷却：决议日页面访问会触发本模块，冷却避免访客洪峰把 Fed RSS/声明抓爆。
// 代价可忽略（两次 HTTP，无行情/LLM），但没必要的重复请求也不该发。
// 注意：调用方（/api/signal）会 await 本模块，故冷却必须在**发起任何网络请求之前**判断，
// 否则每次页面加载都要等一轮 FRED（约 1-3 秒）——见 isFedRefreshCoolingDown
let lastAttemptMs = 0;
const ATTEMPT_COOLDOWN_MS = 10 * 60 * 1000;

/** 冷却中？（供调用方在 await 之前做零成本短路，避免每次页面加载都等一轮网络往返） */
export function isFedRefreshCoolingDown() {
  return Date.now() - lastAttemptMs < ATTEMPT_COOLDOWN_MS;
}

/**
 * 决议日即时重算：拉 Fed 声明 → 重算货币维 → 更新当天这条快照。
 * @param {object} [opts]
 * @param {Function} [opts.log] 日志函数（测试可注入静默实现）
 * @param {string} [opts.today] 'YYYY-MM-DD'（ET），默认今天
 * @param {boolean} [opts.bypassCooldown] 跳过 10 分钟冷却（仅测试/手工补跑用）
 * @param {object} [opts.deps] 依赖注入（测试用）：{ fetchMacro, getLatest, getOverrides, updateFields, alert }
 * @returns {Promise<{updated:boolean, reason?:string, from?:string, to?:string, monetary?:string}>}
 */
export async function runFedDecisionRefresh({
  log = console.log, today = todayET(), bypassCooldown = false, deps = {},
} = {}) {
  const fetchMacro = deps.fetchMacro || fetchMacroData;
  const getLatest = deps.getLatest || getLatestSnapshot;
  const getOverrides = deps.getOverrides || getAllOverrides;
  const updateFields = deps.updateFields || updateSnapshotFields;
  const alert = deps.alert || sendOpsAlert;

  const nowMs = Date.now();
  if (!bypassCooldown && nowMs - lastAttemptMs < ATTEMPT_COOLDOWN_MS) {
    return { updated: false, reason: 'cooldown' };
  }
  lastAttemptMs = nowMs;

  const snapshot = await getLatest();
  if (!snapshot) return { updated: false, reason: 'no_snapshot' };

  let macroData;
  try {
    macroData = await fetchMacro();
  } catch (err) {
    return { updated: false, reason: `fred_fetch_failed: ${err.message}` };
  }
  // 只有 Fed 源确实顶替了 FRED（决议已发布而序列尚未更新）才继续——
  // 否则说明 FRED 已是权威（或本次根本没读到决议），交给 21:00 完整 cron，避免无谓重算
  if (macroData.rateSource !== 'fed_statement') {
    return { updated: false, reason: `rate_source_${macroData.rateSource}` };
  }
  // 决议日必须落在"最新快照日 ≤ 决议日 ≤ 今天"区间内：
  //   早于快照日 → 该决议已被完整的每日管道计入，无需（也不应）再改写；
  //   晚于今天   → 未来声明（RSS 时钟偏差/预发布），绝不提前计入。
  // 注意这里用"最新快照"而非"今天这条"：决议日当晚 21:00 的 cron 若已用过时 FRED 值写了快照，
  // 次日清晨的补跑正好落在 ≤ 快照日 的边界上——由 reconstruct 路径（21:00 完整 cron）覆盖，
  // 本模块不参与改写历史快照（track record 不可篡改）
  const snapDate = snapshot.date;
  if (!(macroData.rateDecisionDate >= snapDate && macroData.rateDecisionDate <= today)) {
    return { updated: false, reason: `decision_out_of_range (${macroData.rateDecisionDate} vs snapshot ${snapDate})` };
  }
  // 只在决议"新鲜"时改写（近 7 天内），避免历史决议因 FRED 长期异常而被反复重算
  const ageDays = Math.floor((Date.parse(today) - Date.parse(macroData.rateDecisionDate)) / 86400000);
  if (ageDays > 7) return { updated: false, reason: `decision_too_old (${ageDays}d)` };

  const overrides = await getOverrides();
  // 货币维无手动覆盖通道（管理面板只提供财政/行政/AI供需/两把锁/capex指引），故直接自动判定
  const monetary = calcMonetarySignal(macroData);
  const locks = computeLocks(macroData, snapshot, overrides, today);

  // 其余三维沿用快照生效值（本模块不重算它们：政策/财政/产业链在 14:00 无新增输入，
  // 重算只会引入与 21:00 不一致的口径风险）
  const fiscal = snapshot.fiscal_auto_signal || snapshot.fiscal_signal;
  const admin = snapshot.admin_auto_signal || snapshot.admin_signal;
  const aiSupply = snapshot.ai_supply_auto_signal || snapshot.ai_supply_signal;

  const treeSignal = applyRealRateVeto(
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
    applyTrendReentry(lockActiveNow ? 'defense' : treeSignal, {
      sahmLockActive: locks.sahmLockActive,
      reactiveLockActive: locks.reactiveAdjustmentLockActive,
      spxAboveSma10,
    }),
    spxAboveSma10
  );
  // 降档守卫：重算结果比快照生效档更宽松 → 保持原档（等待 21:00 完整 cron 的结论）。
  // 升档/持平则照常走迟滞（升档即时生效）
  const prevEffective = snapshot.final_signal || null;
  if (prevEffective && severity(candidate) < severity(prevEffective)) {
    return { updated: false, reason: `would_ease (${candidate} < ${prevEffective})` };
  }
  const hold = applyDowngradeHold(
    candidate, prevEffective,
    snapshot.final_downgrade_pending_since, today,
    snapshot.final_downgrade_pending_candidate
  );
  const finalSignal = hold.signal;
  if (finalSignal === prevEffective && monetary === snapshot.monetary_signal) {
    return { updated: false, reason: 'no_change' };
  }

  // 就地更新今天这条快照：只写货币维/利率组/锁/最终档位，其余字段原样保留——
  // 决议日 14:00 的重算不得覆盖 21:00 采样点的其余（收盘价/产业链/财报）字段语义
  const written = await updateFields(snapshot.id, {
    monetary_signal: monetary,
    final_signal: finalSignal,
    fred_rate: macroData.currentRate,
    fred_rate_prev: macroData.prevRate,
    rate_source: macroData.rateSource,
    rate_decision_date: macroData.rateDecisionDate,
    sahm_lock_active: locks.sahmLockActive ? 1 : 0,
    reactive_adjustment_lock_active: locks.reactiveAdjustmentLockActive ? 1 : 0,
    reactive_adjustment_lock_trigger_bp: locks.reactiveAdjustmentLockTriggerBp,
    final_downgrade_pending_since: hold.pendingSince,
    final_downgrade_pending_candidate: hold.pendingCandidate,
  });
  if (!written) return { updated: false, reason: 'patch_rejected' };

  log(`[fed-refresh] FOMC decision ${macroData.rateDecisionDate}: ${macroData.fedDecisionAction} → monetary=${monetary}, final=${prevEffective}→${finalSignal}`);

  // 运维告警（用户明确要求"一经公布就通知我"）：本模块改变了决策系统档位或货币维时发信。
  // 不依赖订阅者告警链（那只在看板用户订阅时触发），管理员始终收到——
  // 决议日 14:00 的档位变化正是最需要人来复核的场景
  if (monetary !== snapshot.monetary_signal || finalSignal !== prevEffective) {
    await alert(process.env.ADMIN_EMAIL, {
      stage: `FOMC 决议即时生效（${macroData.rateDecisionDate} ${macroData.fedDecisionAction}）`,
      error: `利率 ${snapshot.fred_rate}% → ${macroData.currentRate}%（Fed 官方声明，FRED 序列尚未更新）`
        + `；货币维 ${snapshot.monetary_signal} → ${monetary}；最终档位 ${prevEffective} → ${finalSignal}`
        + `；已就地更新 ${macroData.rateDecisionDate} 当天快照，21:00 完整管道会再核一遍`,
      dataDate: snapshot.date,
    }).catch(() => {});
  }

  return { updated: true, from: prevEffective, to: finalSignal, monetary };
}
