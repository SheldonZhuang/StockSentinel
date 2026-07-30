// 锁状态机双实现漂移测试（116号，2026-07-30 采纳）：线上 computeLocks（api/locks.js，
// 已从 server.js 抽出）与日度回放镜像 computeLocksDaily（backtest/daily-replay.mjs）
// 在共享语义域（无 override 场景——回测中不存在 override）逐位对比。
// 动因：O1 既往剧本——线上判定改了，回测复刻默默停留在旧规则，直到有人手动核对。
// 本测试让这种漂移直接变成红灯。已知的合法差异：computeLocks 会从 lock_since 还原
// override 期间的 raw 锁状态（M2 修复）——override 场景不在对比域内。
import { describe, it, expect } from 'vitest';
import { computeLocks } from '../api/locks.js';
import { computeLocksDaily } from '../backtest/daily-replay.mjs';

// 共享场景 → 两种接口的适配
function runBoth({ today, currentRate, sahmValue, steps, prev }) {
  // steps: 升序 [{date, diffBp}]
  const online = computeLocks(
    {
      currentRate,
      prevRate: prev?.rate ?? null,
      sahmValue,
      rateSteps: [...steps].sort((a, b) => (a.date < b.date ? 1 : -1)), // 线上要降序
    },
    prev
      ? {
          date: prev.date,
          fred_rate: prev.rate,
          sahm_lock_active: prev.sahmLockActive ? 1 : 0,
          reactive_adjustment_lock_active: prev.reactiveLockActive ? 1 : 0,
          sahm_lock_since: prev.sahmLockSince ?? null,
          reactive_adjustment_lock_since: prev.reactiveLockSince ?? null,
          reactive_adjustment_lock_trigger_bp: prev.triggerBp ?? null,
        }
      : null,
    {}, // 无 override（对比域）
    today
  );
  const replay = computeLocksDaily({ today, currentRate, sahmValue, stepsAsc: steps, prev });
  return { online, replay };
}

function expectSame({ online, replay }) {
  expect(online.rateDiffBp).toBe(replay.rateDiffBp);
  expect(!!online.sahmLockActive).toBe(!!replay.sahmLockActive);
  expect(!!online.reactiveAdjustmentLockActive).toBe(!!replay.reactiveLockActive);
  expect(online.sahmLockSince).toBe(replay.sahmLockSince);
  expect(online.reactiveAdjustmentLockSince).toBe(replay.reactiveLockSince);
}

describe('computeLocks(线上) vs computeLocksDaily(回放) 漂移对比', () => {
  it('平静日：无触发无锁', () => {
    expectSame(runBoth({
      today: '2026-07-30', currentRate: 3.75, sahmValue: 0.1, steps: [],
      prev: { date: '2026-07-29', rate: 3.75, sahmLockActive: false, reactiveLockActive: false },
    }));
  });

  it('-50bp 应对式降息：两端同触发', () => {
    const r = runBoth({
      today: '2026-07-30', currentRate: 3.25, sahmValue: 0.1,
      steps: [{ date: '2026-07-30', diffBp: -50 }],
      prev: { date: '2026-07-29', rate: 3.75, sahmLockActive: false, reactiveLockActive: false },
    });
    expectSame(r);
    expect(r.online.reactiveAdjustmentLockActive).toBe(true);
  });

  it('萨姆 ≥0.5 触发：两端同触发', () => {
    const r = runBoth({
      today: '2026-07-30', currentRate: 3.75, sahmValue: 0.53, steps: [],
      prev: { date: '2026-07-29', rate: 3.75, sahmLockActive: false, reactiveLockActive: false },
    });
    expectSame(r);
    expect(r.online.sahmLockActive).toBe(true);
  });

  it('锁龄不足60天时小幅调整不解锁（V3），满60天且触发消失才解锁', () => {
    const base = {
      currentRate: 3.5, sahmValue: 0.2,
      steps: [{ date: '2026-07-30', diffBp: -25 }],
    };
    // 锁龄 30 天：不解锁
    expectSame(runBoth({ ...base, today: '2026-07-30',
      prev: { date: '2026-07-29', rate: 3.75, sahmLockActive: true, reactiveLockActive: false, sahmLockSince: '2026-06-30' } }));
    // 锁龄 90 天：解锁
    const r = runBoth({ ...base, today: '2026-07-30',
      prev: { date: '2026-07-29', rate: 3.75, sahmLockActive: true, reactiveLockActive: false, sahmLockSince: '2026-05-01' } });
    expectSame(r);
    expect(r.online.sahmLockActive).toBe(false);
  });

  it('零利率无条件解锁', () => {
    const r = runBoth({
      today: '2026-07-30', currentRate: 0.25, sahmValue: 0.8, steps: [],
      prev: { date: '2026-07-29', rate: 0.25, sahmLockActive: true, reactiveLockActive: true, sahmLockSince: '2026-07-01', reactiveLockSince: '2026-07-01' },
    });
    expectSame(r);
    expect(r.online.sahmLockActive).toBe(false);
    expect(r.online.reactiveAdjustmentLockActive).toBe(false);
  });

  it('SAHM 缺数 fail-closed：已激活锁存续、未激活不无中生有', () => {
    const active = runBoth({
      today: '2026-07-30', currentRate: 3.75, sahmValue: null, steps: [],
      prev: { date: '2026-07-29', rate: 3.75, sahmLockActive: true, reactiveLockActive: false, sahmLockSince: '2026-07-01' },
    });
    expectSame(active);
    expect(active.online.sahmLockActive).toBe(true);
    const inactive = runBoth({
      today: '2026-07-30', currentRate: 3.75, sahmValue: null, steps: [],
      prev: { date: '2026-07-29', rate: 3.75, sahmLockActive: false, reactiveLockActive: false },
    });
    expectSame(inactive);
    expect(inactive.online.sahmLockActive).toBe(false);
  });

  it('停机窗口两笔 25bp：台阶扫描取最大单笔（不聚合成假 50bp）', () => {
    const r = runBoth({
      today: '2026-07-30', currentRate: 3.25, sahmValue: 0.1,
      steps: [{ date: '2026-07-10', diffBp: -25 }, { date: '2026-07-25', diffBp: -25 }],
      prev: { date: '2026-07-01', rate: 3.75, sahmLockActive: false, reactiveLockActive: false },
    });
    expectSame(r);
    expect(Math.abs(r.online.rateDiffBp)).toBe(25); // 端点差是 -50，但台阶扫描保住真实幅度
    expect(r.online.reactiveAdjustmentLockActive).toBe(false);
  });

  it('首跑（无前快照）只看最近一笔台阶', () => {
    expectSame(runBoth({
      today: '2026-07-30', currentRate: 3.75, sahmValue: 0.1,
      steps: [{ date: '2026-06-18', diffBp: 25 }],
      prev: null,
    }));
  });
});
