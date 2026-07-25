import { describe, it, expect } from 'vitest';
import { staleKeepIndicators, checkIndicatorFreshness } from '../utils/stale-keep.js';

// 模拟 fetchMacroData/fetchPolicyData 输出（仅相关字段）与上一快照 DB 行
function freshMacro() {
  return {
    corePce: 2.6, prevCorePce: 2.5, corePcePeriodDate: '2026-05-01', corePceReleaseDate: '2026-06-25',
    unemployment: 4.1, prevUnemployment: 4.0, unemploymentPeriodDate: '2026-06-01', unemploymentReleaseDate: '2026-07-02',
    sahmValue: 0.1, sahmPeriodDate: '2026-06-01', sahmReleaseDate: '2026-07-02',
    yieldCurveSpread: 0.5, yieldCurveInvertedDays: 0, yieldCurvePeriodDate: '2026-07-24',
  };
}

const prevSnapshot = {
  fred_core_pce: 2.5, fred_core_pce_prev: 2.4, core_pce_period_date: '2026-04-01', core_pce_release_date: '2026-05-30',
  fred_unemployment: 4.0, fred_unemployment_prev: 3.9, unemployment_period_date: '2026-05-01', unemployment_release_date: '2026-06-06',
  sahm_value: 0.07, sahm_period_date: '2026-05-01', sahm_release_date: '2026-06-06',
  yield_curve_spread: 0.48, yield_curve_inverted_days: 0, yield_curve_period_date: '2026-07-23',
  epu_daily: 150.2, epu_daily_percentile: 60.5, epu_daily_period_date: '2026-07-23',
  semi_ip_yoy: 12.3, semi_ip_period_date: '2026-05-01', semi_ip_release_date: '2026-06-17',
};

describe('staleKeepIndicators（114号：参考指标组级 stale-keep）', () => {
  it('当日拉取成功的组不被覆盖', () => {
    const macro = freshMacro();
    const policy = { epuDaily: 160, epuDailyPercentile: 70, epuDailyPeriodDate: '2026-07-24', semiIpYoy: 13, semiIpPeriodDate: '2026-06-01', semiIpReleaseDate: '2026-07-17' };
    const kept = staleKeepIndicators(macro, policy, prevSnapshot);
    expect(kept).toEqual([]);
    expect(macro.corePce).toBe(2.6);
    expect(policy.epuDaily).toBe(160);
  });

  it('null 组整组沿用上一快照（值+参考期+发布日一起带走，不伪造新鲜度）', () => {
    const macro = freshMacro();
    macro.corePce = null; macro.prevCorePce = null; macro.corePcePeriodDate = null; macro.corePceReleaseDate = null;
    macro.sahmValue = null; macro.sahmPeriodDate = null; macro.sahmReleaseDate = null;
    const policy = { epuDaily: null, epuDailyPercentile: null, epuDailyPeriodDate: null, semiIpYoy: null, semiIpPeriodDate: null, semiIpReleaseDate: null };
    const kept = staleKeepIndicators(macro, policy, prevSnapshot);
    expect(kept).toEqual(expect.arrayContaining(['corePce', 'sahm', 'epuDaily', 'semiIp']));
    expect(macro.corePce).toBe(2.5);
    expect(macro.corePcePeriodDate).toBe('2026-04-01'); // 参考期如实回退到旧日期
    expect(macro.corePceReleaseDate).toBe('2026-05-30');
    expect(macro.sahmValue).toBe(0.07);
    expect(policy.epuDaily).toBe(150.2);
    expect(policy.epuDailyPercentile).toBe(60.5);
    expect(policy.semiIpYoy).toBe(12.3);
    // 未失败的组不动
    expect(macro.unemployment).toBe(4.1);
  });

  it('上一快照同样缺值（连续故障/全新库）→ 保持 null，不报错', () => {
    const macro = freshMacro();
    macro.unemployment = null; macro.prevUnemployment = null; macro.unemploymentPeriodDate = null; macro.unemploymentReleaseDate = null;
    const kept = staleKeepIndicators(macro, {}, { fred_unemployment: null });
    expect(kept).toEqual([]);
    expect(macro.unemployment).toBeNull();
  });

  it('无上一快照（全新库首跑）→ 直接返回空', () => {
    const macro = freshMacro();
    macro.corePce = null;
    expect(staleKeepIndicators(macro, {}, null)).toEqual([]);
    expect(macro.corePce).toBeNull();
  });

  it('倒挂天数为 0（falsy 但有效）不触发回填——判空只看 null/undefined', () => {
    const macro = freshMacro();
    macro.yieldCurveSpread = 0; // 有效观测 0
    const kept = staleKeepIndicators(macro, null, prevSnapshot);
    expect(kept).not.toContain('yieldCurve');
    expect(macro.yieldCurveSpread).toBe(0);
  });
});

describe('checkIndicatorFreshness（114b号：超龄看门狗，防 stale-keep 掩盖序列永久失效）', () => {
  it('参考期在预算内 → 不告警（月度数据滞后2个月属正常）', () => {
    const macro = { corePce: 2.5, corePcePeriodDate: '2026-05-01' }; // 85天 < 100天预算
    expect(checkIndicatorFreshness(macro, null, '2026-07-25')).toEqual([]);
  });

  it('月度组参考期超100天 → 上榜，带天数与预算', () => {
    const macro = { corePce: 2.5, corePcePeriodDate: '2026-03-01' }; // 146天
    const overdue = checkIndicatorFreshness(macro, null, '2026-07-25');
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({ name: 'corePce', periodDate: '2026-03-01', budgetDays: 100 });
    expect(overdue[0].ageDays).toBe(146);
  });

  it('日频组预算10天：曲线参考期11天前 → 上榜；EPUTRADE 编制慢享160天豁免', () => {
    const macro = { yieldCurveSpread: 0.5, yieldCurvePeriodDate: '2026-07-14' }; // 11天 > 10
    const policy = { epuTrade: 1600, epuTradePercentile: 85, epuTradePeriodDate: '2026-03-01' }; // 146天 < 160
    const overdue = checkIndicatorFreshness(macro, policy, '2026-07-25');
    expect(overdue.map(o => o.name)).toEqual(['yieldCurve']);
  });

  it('值为 null（无历史可沿用的新库）或参考期缺失 → 不上榜，不报错', () => {
    const macro = { corePce: null, corePcePeriodDate: null, unemployment: 4.2, unemploymentPeriodDate: null };
    expect(checkIndicatorFreshness(macro, null, '2026-07-25')).toEqual([]);
  });
});
