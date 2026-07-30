// 两把全局锁（萨姆锁/应对式调整锁）的每日状态机——从 server.js 抽出为独立模块
// （116号，2026-07-30）：server.js 含顶层 await 与 listen，无法被测试/回测 import；
// 独立成模块后，backtest/daily-replay.mjs 的 computeLocksDaily 镜像可以用漂移测试
// 与本实现逐位对比（tests/locks-drift.test.js），防"线上改了、回测复刻默默过期"。
import signalCfg from '../config/signal.config.js';
import { calcLockActive } from './signal.js';
import { todayET } from '../utils/datetime.js';

/**
 * 根据当天 macroData 和前一条快照，计算两个锁的 effective 状态（应用管理员清锁 override 后）
 * @returns {{sahmValue, rateDiffBp, sahmLockActive, reactiveAdjustmentLockActive, reactiveAdjustmentLockTriggerBp,
 *            sahmLockOverridden, reactiveAdjustmentLockOverridden}}
 */
export function computeLocks(macroData, prevSnapshot, overrides, todayOpt) {
  const { currentRate, prevRate, sahmValue, rateSteps } = macroData;
  // 利率变动基线优先用上一快照：FRED 序列相邻观测差只在变动次日非零，
  // 当天 cron 恰好缺跑就永久漏检；快照差跨任意天数仍能捕捉调整事件（首次运行退回序列前值）
  const baselineRate = prevSnapshot?.fred_rate ?? prevRate;
  const endpointDiffBp = currentRate !== null && baselineRate !== null && baselineRate !== undefined
    ? Math.round((currentRate - baselineRate) * 100)
    : null;

  // 调整事件判定优先用 FRED 序列在 (上次快照日, 今天] 内的逐笔台阶：
  // 端点差会把停机窗口内两次渐进 25bp 聚合成一次假 50bp"应对式"触发；
  // 台阶扫描保留每次调整的真实幅度（取窗口内幅度最大的一笔）。
  // 首跑（无快照）只看最近一笔台阶（与旧行为等价）；
  // 序列回看窗口覆盖不到快照日或无台阶时，退回端点差兜底。
  const sinceDate = prevSnapshot?.date ?? null;
  const allSteps = rateSteps || [];
  const stepsSince = sinceDate ? allSteps.filter(s => s.date > sinceDate) : allSteps.slice(0, 1);
  const rateDiffBp = stepsSince.length
    ? stepsSince.reduce((a, b) => (Math.abs(b.diffBp) > Math.abs(a.diffBp) ? b : a)).diffBp
    : endpointDiffBp;

  // raw 锁状态还原（2026-07-30 审查修复）：快照的 *_lock_active 存的是 override 清锁后的
  // effective 值，但 *_lock_since 按 raw 状态存（非空即 raw 激活）——override 期间必须以 raw
  // 为基线演进锁龄，否则 since 每日被重置为今天，override 到期后 60 天最短锁存期从零重跑
  const prevSahmLockActive = prevSnapshot
    ? !!(prevSnapshot.sahm_lock_active || prevSnapshot.sahm_lock_since) : false;
  const prevReactiveLockActive = prevSnapshot
    ? !!(prevSnapshot.reactive_adjustment_lock_active || prevSnapshot.reactive_adjustment_lock_since) : false;
  const prevTriggerBp = prevSnapshot ? prevSnapshot.reactive_adjustment_lock_trigger_bp : null;
  // 锁存起始日（V3 最短锁存期用）：旧快照无此列时为 null → calcLockActive fail-open 兼容旧行为
  const prevSahmLockSince = prevSnapshot?.sahm_lock_since ?? null;
  const prevReactiveLockSince = prevSnapshot?.reactive_adjustment_lock_since ?? null;
  const today = todayOpt || todayET();
  const ageDays = since => (since ? Math.floor((Date.parse(today) - Date.parse(since)) / 86400000) : null);

  // 萨姆触发 fail-closed（2026-07-20 审查修复）：SAHM 数据缺失（FRED故障/429）时，
  // 已激活的锁视同触发仍存续——否则缺数日恰逢<50bp调整会误解锁，次日数据恢复又重锁，
  // 产生"单日解锁→次日重锁"翻转和一对方向相反的示警邮件（正是锁设计要避免的模式）。
  // 未激活的锁在缺数日保持未触发（不无中生有）。
  const sahmTrigger = sahmValue !== null && sahmValue !== undefined
    ? sahmValue >= signalCfg.SAHM_TRIGGER_THRESHOLD
    : prevSahmLockActive;
  const reactiveTrigger = rateDiffBp !== null && Math.abs(rateDiffBp) >= signalCfg.RATE_REACTIVE_ADJUSTMENT_BP;

  const rawSahmLockActive = calcLockActive({
    triggerToday: sahmTrigger, rateDiffBp, currentRate, prevLockActive: prevSahmLockActive,
    lockAgeDays: prevSahmLockActive ? ageDays(prevSahmLockSince) : null,
  });
  const rawReactiveLockActive = calcLockActive({
    triggerToday: reactiveTrigger, rateDiffBp, currentRate, prevLockActive: prevReactiveLockActive,
    lockAgeDays: prevReactiveLockActive ? ageDays(prevReactiveLockSince) : null,
  });

  // 锁存起始日演进：新激活 → 今天；持续激活 → 沿用（旧快照缺列则从今天起算）；解除 → 清空
  const sahmLockSince = rawSahmLockActive
    ? (prevSahmLockActive ? (prevSahmLockSince ?? today) : today)
    : null;
  const reactiveAdjustmentLockSince = rawReactiveLockActive
    ? (prevReactiveLockActive ? (prevReactiveLockSince ?? today) : today)
    : null;

  let reactiveAdjustmentLockTriggerBp = null;
  if (reactiveTrigger) {
    reactiveAdjustmentLockTriggerBp = rateDiffBp;
  } else if (rawReactiveLockActive) {
    reactiveAdjustmentLockTriggerBp = prevTriggerBp;
  }

  const sahmLockOverridden = !!overrides.sahmLockClear;
  const reactiveAdjustmentLockOverridden = !!overrides.reactiveAdjustmentLockClear;

  return {
    sahmValue,
    rateDiffBp,
    sahmLockActive: sahmLockOverridden ? false : rawSahmLockActive,
    reactiveAdjustmentLockActive: reactiveAdjustmentLockOverridden ? false : rawReactiveLockActive,
    reactiveAdjustmentLockTriggerBp: reactiveAdjustmentLockOverridden ? null : reactiveAdjustmentLockTriggerBp,
    sahmLockOverridden,
    reactiveAdjustmentLockOverridden,
    // 锁存起始日按 raw 状态记录（override 清锁不清起始日——override 撤销后锁龄延续）
    sahmLockSince,
    reactiveAdjustmentLockSince,
  };
}
