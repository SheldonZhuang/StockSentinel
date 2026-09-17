// 127号（2026-09-17）：FOMC 决议日即时重算控制器单测。
// 事故背景：决议在美东 14:00 公布，而完整管道在 21:00——中间 7 小时网页显示决议前状态
// （2026-09-16 加息 25bp 后，用户上午看到的是"3.75% 0.00%（持平）"）。
//
// 核心不变量（本文件是它们的守门人）：
//   ① 只在"Fed 源确实顶替了 FRED"且"决议日落在最新快照日与今天之间"时才改写；
//   ② 绝不降档（重算比快照更宽松 → 一动不动，等 21:00 完整管道定性）；
//   ③ 只 UPDATE 既有快照行，绝不 INSERT 新快照（track record 采样点不可被污染）；
//   ④ 任何外部失败都不抛错、不改库（决议链路绝不因此变成新的单点故障）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runFedDecisionRefresh } from '../utils/fed-refresh.js';

const TODAY = '2026-09-16';

/** 构造一条 2026-09-16 快照（实况：加息决议当天，FRED 仍停在决议前 3.75） */
function snapshot(overrides = {}) {
  return {
    id: 199,
    date: TODAY,
    monetary_signal: 'loose',   // 修复前被 FRED 滞后误导成宽松
    final_signal: 'reduce',
    fiscal_auto_signal: 'neutral',
    admin_auto_signal: 'tight',
    ai_supply_auto_signal: 'loose',
    fred_rate: 3.75,
    fred_rate_prev: 3.75,
    yield_curve_inverted_days: null,
    credit_spread_90d_widen_bp: null,
    sahm_lock_active: 0,
    reactive_adjustment_lock_active: 0,
    spx_above_sma10: 1,
    final_downgrade_pending_since: null,
    final_downgrade_pending_candidate: null,
    ...overrides,
  };
}

/** 构造 fetchMacroData 的返回（Fed 源顶替后的形态） */
function macro(overrides = {}) {
  return {
    currentRate: 4, prevRate: 3.75, rateSource: 'fed_statement',
    rateDecisionDate: TODAY, fedDecisionAction: 'raise',
    rateSteps: [{ date: '2026-09-17', diffBp: 25, source: 'fed_statement' }],
    sahmValue: 0.3, trimmedPce12m: 2.28, currentBalanceSheet: 6740, prevBalanceSheet: 6740,
    ...overrides,
  };
}

function makeDeps({ snap = snapshot(), macroData = macro(), updateFields } = {}) {
  const updates = [];
  const alerts = [];
  return {
    updates, alerts,
    deps: {
      getLatest: async () => snap,
      fetchMacro: async () => macroData,
      getOverrides: async () => ({}),
      updateFields: updateFields || (async (id, patch) => { updates.push({ id, patch }); return Object.keys(patch).length; }),
      alert: async (to, p) => { alerts.push({ to, p }); },
    },
  };
}

beforeEach(() => {
  delete process.env.ADMIN_EMAIL;
  vi.restoreAllMocks();
});

describe('runFedDecisionRefresh（决议日即时重算）', () => {
  it('加息决议当晚：货币维 loose→tight、利率写为 4/3.75，并只改既有快照行', async () => {
    const { deps, updates, alerts } = makeDeps();
    const r = await runFedDecisionRefresh({ log: () => {}, today: TODAY, bypassCooldown: true, deps });

    expect(r.updated).toBe(true);
    expect(r.monetary).toBe('tight');
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(199);                 // 只 UPDATE id=199，未新建快照
    expect(updates[0].patch.monetary_signal).toBe('tight');
    expect(updates[0].patch.fred_rate).toBe(4);
    expect(updates[0].patch.fred_rate_prev).toBe(3.75);
    expect(updates[0].patch.rate_source).toBe('fed_statement');
    expect(alerts).toHaveLength(1);                  // 档位/货币维变化 → 运维告警
  });

  it('降档守卫：重算结果比快照更宽松 → 一动不动', async () => {
    // 快照已是 defense（双维收紧），本次重算只给出 reduce（更宽松）→ 必须拒绝
    const { deps, updates } = makeDeps({
      snap: snapshot({ final_signal: 'defense', monetary_signal: 'tight', admin_auto_signal: 'tight' }),
      macroData: macro({ currentRate: 3.75, prevRate: 3.75, rateDecisionDate: TODAY }),
    });
    const r = await runFedDecisionRefresh({ log: () => {}, today: TODAY, bypassCooldown: true, deps });
    expect(r.updated).toBe(false);
    expect(r.reason).toMatch(/would_ease/);
    expect(updates).toHaveLength(0);
  });

  it('非 Fed 源（FRED 已是权威）→ 不重算，交给 21:00 完整管道', async () => {
    const { deps, updates } = makeDeps({ macroData: macro({ rateSource: 'fred' }) });
    const r = await runFedDecisionRefresh({ log: () => {}, today: TODAY, bypassCooldown: true, deps });
    expect(r.updated).toBe(false);
    expect(r.reason).toBe('rate_source_fred');
    expect(updates).toHaveLength(0);
  });

  it('决议日早于快照日（已被完整管道计入）→ 不改写', async () => {
    const { deps, updates } = makeDeps({
      snap: snapshot({ date: '2026-09-17' }),
      macroData: macro({ rateDecisionDate: '2026-09-16' }),
    });
    const r = await runFedDecisionRefresh({ log: () => {}, today: '2026-09-17', bypassCooldown: true, deps });
    expect(r.updated).toBe(false);
    expect(r.reason).toMatch(/decision_out_of_range/);
    expect(updates).toHaveLength(0);
  });

  it('未来声明的决议日 → 不改写（绝不提前计入）', async () => {
    const { deps, updates } = makeDeps({ macroData: macro({ rateDecisionDate: '2026-10-28' }) });
    const r = await runFedDecisionRefresh({ log: () => {}, today: TODAY, bypassCooldown: true, deps });
    expect(r.updated).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('决议过老（>7天）→ 不改写（防历史决议被反复重算）', async () => {
    const { deps, updates } = makeDeps({
      snap: snapshot({ date: '2026-09-01' }),
      macroData: macro({ rateDecisionDate: '2026-09-01' }),
    });
    const r = await runFedDecisionRefresh({ log: () => {}, today: '2026-09-20', bypassCooldown: true, deps });
    expect(r.updated).toBe(false);
    expect(r.reason).toMatch(/decision_too_old/);
    expect(updates).toHaveLength(0);
  });

  it('无变化（货币维与档位都没变）→ 不写库、不发信', async () => {
    const { deps, updates, alerts } = makeDeps({
      snap: snapshot({ monetary_signal: 'tight' }), // 已是 tight
    });
    const r = await runFedDecisionRefresh({ log: () => {}, today: TODAY, bypassCooldown: true, deps });
    expect(r.updated).toBe(false);
    expect(r.reason).toBe('no_change');
    expect(updates).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  it('FRED 抓取失败 → 不抛错、不改库（降级为"今晚 21:00 再说"）', async () => {
    const { deps, updates } = makeDeps();
    deps.fetchMacro = async () => { throw new Error('FRED 503'); };
    const r = await runFedDecisionRefresh({ log: () => {}, today: TODAY, bypassCooldown: true, deps });
    expect(r.updated).toBe(false);
    expect(r.reason).toMatch(/fred_fetch_failed/);
    expect(updates).toHaveLength(0);
  });

  it('无快照 → 不抛错、不新建', async () => {
    const { deps, updates } = makeDeps({ snap: null });
    const r = await runFedDecisionRefresh({ log: () => {}, today: TODAY, bypassCooldown: true, deps });
    expect(r.updated).toBe(false);
    expect(r.reason).toBe('no_snapshot');
    expect(updates).toHaveLength(0);
  });

  it('冷却期内不重复跑（访客洪峰防护）', async () => {
    const { deps } = makeDeps();
    await runFedDecisionRefresh({ log: () => {}, today: TODAY, bypassCooldown: true, deps });
    const r2 = await runFedDecisionRefresh({ log: () => {}, today: TODAY, deps }); // 不带 bypass
    expect(r2.updated).toBe(false);
    expect(r2.reason).toBe('cooldown');
  });
});
