// 118号 快照补更新控制器单测：期望日期计算（美东21:45分界）+ 触发/冷却/互斥语义。
// 核心不变量：**绝不提前跑**——ET 21:45 前期望的是昨日快照，早间访问不触发当日早产快照
import { describe, it, expect, vi } from 'vitest';
import { expectedSnapshotDate, createCatchUpController } from '../utils/catch-up.js';

// 2026-07 为 EDT（UTC-4）：ET 时刻 → UTC Date
const etUtc = (dateStr, h, m = 0) => new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`);

describe('expectedSnapshotDate（美东 21:45 分界）', () => {
  it('ET 20:00 → 期望昨日（当日任务还没到点，绝不提前）', () => {
    expect(expectedSnapshotDate(etUtc('2026-07-31', 20, 0))).toBe('2026-07-30');
  });
  it('ET 21:30（宽限期内，任务可能正在跑）→ 仍期望昨日', () => {
    expect(expectedSnapshotDate(etUtc('2026-07-31', 21, 30))).toBe('2026-07-30');
  });
  it('ET 21:45 → 期望今日', () => {
    expect(expectedSnapshotDate(etUtc('2026-07-31', 21, 45))).toBe('2026-07-31');
  });
  it('ET 23:59 → 期望今日；ET 次日 00:30 → 期望前一日', () => {
    expect(expectedSnapshotDate(etUtc('2026-07-31', 23, 59))).toBe('2026-07-31');
    expect(expectedSnapshotDate(etUtc('2026-08-01', 0, 30))).toBe('2026-07-31');
  });
});

describe('createCatchUpController', () => {
  const mk = ({ latestDate, nowEt = ['2026-07-31', 22, 0], cooldownMs = 1000 }) => {
    const run = vi.fn().mockResolvedValue(undefined);
    let currentNow = etUtc(...nowEt);
    const ctl = createCatchUpController({
      getLatest: async () => (latestDate ? { date: latestDate } : null),
      run, cooldownMs, now: () => currentNow,
    });
    return { ctl, run, setNow: d => { currentNow = d; } };
  };

  it('快照未过期 → 不触发', async () => {
    const { ctl, run } = mk({ latestDate: '2026-07-31' }); // ET 22:00 期望今日，已有今日
    expect(await ctl.check()).toEqual({ overdue: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('早间访问（ET 8:00）+ 昨日快照在档 → 不触发（不提前跑）', async () => {
    const { ctl, run } = mk({ latestDate: '2026-07-30', nowEt: ['2026-07-31', 8, 0] });
    expect(await ctl.check()).toEqual({ overdue: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('过点未更新 → 触发一次补跑；冷却期内再查不重复触发', async () => {
    const { ctl, run } = mk({ latestDate: '2026-07-30' }); // ET 22:00 期望今日，只有昨日
    const r1 = await ctl.check();
    expect(r1.overdue).toBe(true);
    expect(r1.triggered).toBe(true);
    await new Promise(r => setTimeout(r, 10)); // run 立即 resolve，running 复位
    const r2 = await ctl.check();
    expect(r2.cooldown).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('冷却期过后仍过期 → 允许再次触发', async () => {
    const { ctl, run, setNow } = mk({ latestDate: '2026-07-30', cooldownMs: 1000 });
    await ctl.check();
    await new Promise(r => setTimeout(r, 10));
    setNow(etUtc('2026-07-31', 22, 30)); // 30分钟后（远超冷却1秒）
    const r = await ctl.check();
    expect(r.triggered).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('补跑进行中 → 返回 running 不重复触发', async () => {
    let resolveRun;
    const run = vi.fn(() => new Promise(r => { resolveRun = r; }));
    const ctl = createCatchUpController({
      getLatest: async () => ({ date: '2026-07-30' }), run,
      cooldownMs: 0, now: () => etUtc('2026-07-31', 22, 0),
    });
    expect((await ctl.check()).triggered).toBe(true);
    expect((await ctl.check()).running).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    resolveRun();
  });

  it('无任何快照（全新库）→ 视为过期触发', async () => {
    const { ctl, run } = mk({ latestDate: null });
    expect((await ctl.check()).triggered).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('run 抛错不外泄，running 状态复位', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    const ctl = createCatchUpController({
      getLatest: async () => ({ date: '2026-07-30' }), run,
      cooldownMs: 0, now: () => etUtc('2026-07-31', 22, 0),
    });
    expect((await ctl.check()).triggered).toBe(true);
    await new Promise(r => setTimeout(r, 10));
    expect((await ctl.check()).triggered).toBe(true); // 冷却0 → 可再触发，说明 running 已复位
  });
});
