// 128号（2026-09-17）：事件驱动即时刷新引擎单测。
//
// 用户原则："参考指标一经公布，网页与决策系统立即更新"。落地时按发布节奏分两类：
//   A 离散事件型（FOMC 决议、08:30 月度发布）→ 即时刷新（本引擎）
//   B 连续行情型（WTI/信用利差/收益率曲线/EPU 日频）→ 保持 21:00
//     （盘中实时化会让 track record 采样点漂移成"最后一次访问的时刻"，破坏历史可比性）
//
// 本文件锁定四件事：
//   ① 白名单边界：只有货币维/财政维可被事件刷新，行政维与 AI供需维绝不被它改写；
//   ② 降档守卫：重算比现档更宽松一律不落库；
//   ③ 只 UPDATE 不 INSERT（调用方持行 id，本引擎只产出 patch）；
//   ④ 发布检测：只在"参考期前移"时算新发布，回退/缺失都不触发。
import { describe, it, expect } from 'vitest';
import {
  evaluateEventRefresh, buildSnapshotPatch, buildEventAlertPayload,
  detectPublishedIndicators, dimensionsForIndicators,
  EVENT_REFRESHABLE_DIMENSIONS,
} from '../utils/event-refresh.js';

function snapshot(over = {}) {
  return {
    id: 200, date: '2026-09-17',
    monetary_signal: 'tight', fiscal_signal: 'neutral',
    admin_signal: 'tight', ai_supply_signal: 'loose',
    fiscal_auto_signal: 'neutral', admin_auto_signal: 'tight', ai_supply_auto_signal: 'loose',
    final_signal: 'reduce',
    yield_curve_inverted_days: null, credit_spread_90d_widen_bp: null,
    sahm_lock_active: 0, reactive_adjustment_lock_active: 0,
    spx_above_sma10: 1,
    final_downgrade_pending_since: null, final_downgrade_pending_candidate: null,
    ...over,
  };
}

const MACRO = {
  currentRate: 4, prevRate: 3.75, rateSource: 'fed_statement',
  rateDecisionDate: '2026-09-16', rateSteps: [{ date: '2026-09-17', diffBp: 25 }],
  sahmValue: 0.3, trimmedPce12m: 2.28,
  currentBalanceSheet: 6740, prevBalanceSheet: 6740,
};

describe('白名单边界（哪些维度可被事件刷新）', () => {
  it('只有货币维与财政维在白名单内', () => {
    expect(EVENT_REFRESHABLE_DIMENSIONS).toEqual(['monetary', 'fiscal']);
  });

  it('引擎绝不改写行政维与 AI供需维（它们是连续行情型/发布不定型，不属事件型）', () => {
    const ev = evaluateEventRefresh({
      macroData: MACRO, policyData: { outlaysChangePct: -2.8 },
      snapshot: snapshot(), overrides: {}, today: '2026-09-17',
      dimensions: ['monetary', 'fiscal'],
    });
    // 返回里根本不带 admin / aiSupply —— 无法被调用方误写
    expect(ev).not.toHaveProperty('admin');
    expect(ev).not.toHaveProperty('aiSupply');
  });

  it('维度限定为 monetary 时，不重算财政维（沿用快照值）', () => {
    const ev = evaluateEventRefresh({
      macroData: MACRO, policyData: { outlaysChangePct: 99 },  // 会判 tight 的极端值
      snapshot: snapshot(), overrides: {}, today: '2026-09-17',
      dimensions: ['monetary'],
    });
    expect(ev.fiscal).toBe('neutral'); // 快照值，未被 99 改写
  });
});

describe('降档守卫（不变量②）', () => {
  it('重算比现生效档更宽松 → 不落库', () => {
    // 快照处 defense，本次事件算出来只有 reduce（更宽松）→ 必须拒绝
    const ev = evaluateEventRefresh({
      macroData: MACRO, policyData: { outlaysChangePct: -2.8 },
      snapshot: snapshot({ final_signal: 'defense' }),
      overrides: {}, today: '2026-09-17', dimensions: ['monetary', 'fiscal'],
    });
    expect(ev.apply).toBe(false);
    expect(ev.reason).toMatch(/would_ease/);
  });

  it('升档方向放行：财政转 tight 后按判定树生效（纯货币+财政共振按 X3 降为 reduce）', () => {
    // 快照 monetary=tight、fiscal=neutral、admin=tight → 单维收紧=reduce
    // 财政转 tight 后为"货币+财政"双维共振；按 X3（2026-07-18 采纳）该组合降为 reduce，
    // 不是 defense——引擎必须与判定树同口径，不得自行加严
    const ev = evaluateEventRefresh({
      macroData: MACRO, policyData: { outlaysChangePct: 9 },
      snapshot: snapshot(), overrides: {}, today: '2026-09-17', dimensions: ['fiscal'],
    });
    expect(ev.apply).toBe(true);
    expect(ev.fiscal).toBe('tight');
    expect(ev.finalSignal).toBe('reduce');
  });

  it('升档到 defense：三维收紧且趋势转弱时放行（趋势再入场规则不降级）', () => {
    // 三维收紧（货币+财政+行政）→ 树判 defense；此时若 SPY 在 10月SMA 之上，
    // applyTrendReentry（W5/X1）会把"树上来的 defense"降为 reduce——那是既有策略，
    // 引擎必须与之一致；故本用例用 spx_above_sma10=0（趋势转弱）验证 defense 真正放行
    const ev = evaluateEventRefresh({
      macroData: MACRO, policyData: { outlaysChangePct: 9 },
      snapshot: snapshot({ admin_auto_signal: 'tight', admin_signal: 'tight', spx_above_sma10: 0 }),
      overrides: {}, today: '2026-09-17', dimensions: ['fiscal'],
    });
    expect(ev.apply).toBe(true);
    expect(ev.finalSignal).toBe('defense');
  });

  it('三维收紧但趋势向上 → 按趋势再入场规则降为 reduce（既有策略，引擎不得自行加严）', () => {
    const ev = evaluateEventRefresh({
      macroData: MACRO, policyData: { outlaysChangePct: 9 },
      snapshot: snapshot({ admin_auto_signal: 'tight', admin_signal: 'tight', spx_above_sma10: 1 }),
      overrides: {}, today: '2026-09-17', dimensions: ['fiscal'],
    });
    expect(ev.finalSignal).toBe('reduce');
  });
});

describe('无变化不写库', () => {
  it('维度与档位都没变 → apply=false', () => {
    const ev = evaluateEventRefresh({
      macroData: MACRO, policyData: { outlaysChangePct: -2.8 },
      snapshot: snapshot(), overrides: {}, today: '2026-09-17',
    });
    expect(ev.apply).toBe(false);
    expect(ev.reason).toBe('no_change');
  });

  it('无快照 → 不落库且不抛错', () => {
    const ev = evaluateEventRefresh({
      macroData: MACRO, policyData: null, snapshot: null, overrides: {}, today: '2026-09-17',
    });
    expect(ev.apply).toBe(false);
    expect(ev.reason).toBe('no_snapshot');
  });
});

describe('buildSnapshotPatch（只产出待更新列，绝不新建行）', () => {
  it('patch 仅含判定相关列，不含 date/id（无法 INSERT）', () => {
    const ev = evaluateEventRefresh({
      macroData: MACRO, policyData: { outlaysChangePct: 9 },
      snapshot: snapshot({ admin_auto_signal: 'tight', admin_signal: 'tight', spx_above_sma10: 0 }),
      overrides: {}, today: '2026-09-17', dimensions: ['fiscal'],
    });
    const patch = buildSnapshotPatch(ev, MACRO);
    expect(patch).not.toHaveProperty('date');
    expect(patch).not.toHaveProperty('id');
    expect(patch.fiscal_signal).toBe('tight');
    expect(patch).toHaveProperty('final_signal');
    expect(patch).toHaveProperty('sahm_lock_active');
  });
});

describe('detectPublishedIndicators（发布检测：只认参考期前移）', () => {
  const snap = snapshot({
    core_pce_period_date: '2026-07-01',
    unemployment_period_date: '2026-08-01',
    fiscal_period_date: '2026-08-01',
    rate_decision_date: '2026-07-29',
  });

  it('参考期前移 → 识别为已发布', () => {
    const changed = detectPublishedIndicators(
      { corePcePeriodDate: '2026-08-01', unemploymentPeriodDate: '2026-08-01', rateDecisionDate: '2026-09-16' },
      { fiscalPeriodDate: '2026-08-01' }, snap);
    const keys = changed.map(c => c.key).sort();
    expect(keys).toEqual(['core_pce_period_date', 'rate_decision_date']);
    expect(changed.find(c => c.key === 'core_pce_period_date').label).toBe('核心PCE同比');
  });

  it('参考期未变（同一份数据重拉）→ 不识别为发布', () => {
    expect(detectPublishedIndicators(
      { corePcePeriodDate: '2026-07-01', unemploymentPeriodDate: '2026-08-01' },
      { fiscalPeriodDate: '2026-08-01' }, snap)).toEqual([]);
  });

  it('参考期回退（数据源异常）→ 不识别为发布', () => {
    expect(detectPublishedIndicators(
      { corePcePeriodDate: '2026-06-01' }, null, snap)).toEqual([]);
  });

  it('本次拉取缺失（null）→ 跳过（stale-keep 语义，不误判为新发布）', () => {
    expect(detectPublishedIndicators(
      { corePcePeriodDate: null, unemploymentPeriodDate: undefined }, null, snap)).toEqual([]);
  });

  it('旧库缺该列（stored=null）→ 跳过，交由 21:00 完整管道写全', () => {
    expect(detectPublishedIndicators(
      { corePcePeriodDate: '2026-08-01' }, null, snapshot())).toEqual([]);
  });

  it('无快照 → 空数组', () => {
    expect(detectPublishedIndicators({ corePcePeriodDate: '2026-08-01' }, null, null)).toEqual([]);
  });
});

describe('dimensionsForIndicators（指标→维度映射）', () => {
  it('决议日 → 货币维；财政支出 → 财政维', () => {
    expect(dimensionsForIndicators([{ key: 'rate_decision_date' }])).toEqual(['monetary']);
    expect(dimensionsForIndicators([{ key: 'fiscal_period_date' }])).toEqual(['fiscal']);
    expect(dimensionsForIndicators([
      { key: 'rate_decision_date' }, { key: 'fiscal_period_date' },
    ]).sort()).toEqual(['fiscal', 'monetary']);
  });

  it('仅展示/否决器类指标（PCE/失业率）不映射到任何维度 → 不触发判定改写', () => {
    expect(dimensionsForIndicators([
      { key: 'core_pce_period_date' }, { key: 'unemployment_period_date' },
      { key: 'trimmed_pce_12m_period_date' }, { key: 'semi_ip_period_date' },
    ])).toEqual([]);
  });
});

describe('buildEventAlertPayload（告警文案）', () => {
  it('列出维度与档位变化，并说明是就地更新', () => {
    const ev = evaluateEventRefresh({
      macroData: MACRO, policyData: { outlaysChangePct: 9 },
      snapshot: snapshot({ admin_auto_signal: 'tight', admin_signal: 'tight', spx_above_sma10: 0 }),
      overrides: {}, today: '2026-09-17', dimensions: ['fiscal'],
      changedInputs: [{ key: 'fiscal_period_date', label: '联邦月度支出' }],
    });
    const p = buildEventAlertPayload({
      evaluation: ev, snapshot: snapshot(), macroData: MACRO,
      eventLabel: '事件型指标发布：联邦月度支出', today: '2026-09-17',
    });
    expect(p.stage).toMatch(/联邦月度支出/);
    expect(p.error).toMatch(/财政维 neutral → tight/);
    expect(p.error).toMatch(/就地更新/);
    expect(p.dataDate).toBe('2026-09-17');
  });
});
