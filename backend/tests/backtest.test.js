import { describe, it, expect } from 'vitest';
import {
  spliceRateSeries,
  sampleMonthEnd,
  percentileAsOf,
  ttmChangePct,
  replayMonth,
  findPeakTrough,
  lastDayOfMonth,
  lastTwoWeeklyAsOf,
  calcMissedPct,
  crisisPathStats,
  simulateNav,
  smaLast,
  applyDowngradeHoldWithDays,
  VARIANTS_DEFAULT,
} from '../backtest/run-backtest.js';
import { applyDowngradeHold } from '../api/signal.js';
import {
  synthLeveragedDaily,
  monthlyCloseMap,
  simulateExecution,
  perfectForesightCagr,
} from '../backtest/execution-layer.mjs';

describe('spliceRateSeries', () => {
  it('DFEDTAR 在 DFEDTARU 起点之前的观测保留，之后被 DFEDTARU 接管', () => {
    const legacy = [
      { date: '2008-12-01', value: '1.00' },
      { date: '2008-12-20', value: '0.25' }, // 晚于 modern 起点，应剔除
    ];
    const modern = [
      { date: '2008-12-16', value: '0.25' },
      { date: '2009-01-05', value: '0.25' },
    ];
    const out = spliceRateSeries(legacy, modern);
    expect(out.map(o => o.date)).toEqual(['2008-12-01', '2008-12-16', '2009-01-05']);
    expect(out[0].value).toBe(1.0);
  });

  it('无效值（.）被过滤', () => {
    const out = spliceRateSeries([{ date: '2000-01-01', value: '.' }], [{ date: '2010-01-01', value: '2.5' }]);
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe(2.5);
  });
});

describe('sampleMonthEnd', () => {
  it('每月取最后一个观测', () => {
    const out = sampleMonthEnd([
      { date: '2020-03-05', value: 1 },
      { date: '2020-03-31', value: 2 },
      { date: '2020-04-15', value: 3 },
    ]);
    expect(out).toEqual([
      { month: '2020-03', date: '2020-03-31', value: 2 },
      { month: '2020-04', date: '2020-04-15', value: 3 },
    ]);
  });
});

describe('percentileAsOf（前视安全）', () => {
  it('只基于传入的历史窗口计算', () => {
    expect(percentileAsOf(10, [1, 2, 3, 10])).toBe(100);
    expect(percentileAsOf(1, [1, 2, 3, 10])).toBe(25);
    expect(percentileAsOf(5, [])).toBe(null);
  });
});

describe('ttmChangePct', () => {
  it('联邦支出扩大 → 正百分比', () => {
    // 前12月每月 100，后12月每月 110 → 支出扩大10%
    const values = [...Array(12).fill(100), ...Array(12).fill(110)];
    expect(ttmChangePct(values)).toBeCloseTo(10, 5);
  });

  it('不足24个月 → null', () => {
    expect(ttmChangePct(Array(23).fill(100))).toBe(null);
  });
});

describe('replayMonth', () => {
  const NEUTRAL_INPUT = { rate: 3, prevRate: 3, walcl: null, prevWalcl: null, fiscalChangePct: null, epuPercentile: null, sahm: null };
  const NO_LOCK = { sahmLockActive: false, reactiveLockActive: false };

  it('应对式加息 ≥50bp → 货币收紧 + 应对式锁 → 防守', () => {
    const r = replayMonth({ ...NEUTRAL_INPUT, rate: 4, prevRate: 3.25 }, NO_LOCK);
    expect(r.monetary).toBe('tight');
    expect(r.reactiveLockActive).toBe(true);
    expect(r.final).toBe('defense');
  });

  it('萨姆值 ≥0.5 触发萨姆锁 → 防守，且锁存到下月', () => {
    const r1 = replayMonth({ ...NEUTRAL_INPUT, sahm: 0.6 }, NO_LOCK);
    expect(r1.sahmLockActive).toBe(true);
    expect(r1.final).toBe('defense');
    // 下月萨姆回落但无解锁事件 → 锁保持
    const r2 = replayMonth({ ...NEUTRAL_INPUT, sahm: 0.3 }, { sahmLockActive: true, reactiveLockActive: false });
    expect(r2.sahmLockActive).toBe(true);
  });

  it('零利率 ≤0.25% 解锁萨姆锁', () => {
    const r = replayMonth({ ...NEUTRAL_INPUT, rate: 0.25, prevRate: 0.25, sahm: 0.8 }, { sahmLockActive: true, reactiveLockActive: false });
    expect(r.sahmLockActive).toBe(false);
  });

  it('<50bp 非零小幅调整解锁', () => {
    const r = replayMonth({ ...NEUTRAL_INPUT, rate: 3.25, prevRate: 3 }, { sahmLockActive: true, reactiveLockActive: true });
    expect(r.sahmLockActive).toBe(false);
    expect(r.reactiveLockActive).toBe(false);
  });

  it('财政赤字扩大 >5%（政府扩张）→ 收紧 → 单维=减仓观望', () => {
    const r = replayMonth({ ...NEUTRAL_INPUT, fiscalChangePct: 8 }, NO_LOCK);
    expect(r.fiscal).toBe('tight');
    expect(r.final).toBe('reduce');
  });

  it('财政+行政双维收紧 → 全面防守', () => {
    const r = replayMonth({ ...NEUTRAL_INPUT, fiscalChangePct: 8, epuPercentile: 92 }, NO_LOCK);
    expect(r.final).toBe('defense');
  });

  it('财政赤字收窄 >5%（政府收缩）→ 宽松', () => {
    const r = replayMonth({ ...NEUTRAL_INPUT, fiscalChangePct: -8 }, NO_LOCK);
    expect(r.fiscal).toBe('loose');
  });

  it('EPU >80 分位 → 行政收紧 → 单维=减仓观望', () => {
    const r = replayMonth({ ...NEUTRAL_INPUT, epuPercentile: 92 }, NO_LOCK);
    expect(r.admin).toBe('tight');
    expect(r.final).toBe('reduce');
  });

  it('全部数据缺失 → 各维中性 → 观望（利率宽松但AI中性挡住进攻）', () => {
    const r = replayMonth({ rate: null, prevRate: null, walcl: null, prevWalcl: null, fiscalChangePct: null, epuPercentile: null, sahm: null }, NO_LOCK);
    expect(r.final).toBe('neutral');
  });
});

describe('VARIANTS_DEFAULT（基线口径守卫，2026-07-17 两轮评估定稿）', () => {
  it('V3(锁存2月)+V4(降档迟滞)+W5(趋势再入场) 默认开启，其余否决/搁置保持关闭', () => {
    expect(VARIANTS_DEFAULT).toEqual({
      trendConfirm: false,
      cutLockDirUnlock: false,
      minLockMonths: 2,
      downgradeHysteresis: true,
      realRateCap: false,
      aiSemi: false,
      // W系（2026-07-17 第二轮，2010起跑输归因驱动）：W5采纳，W1/W3丢2020/2025召回、
      // W2/W4b打穿08覆盖硬约束、W4a月度粒度下与30天不可分——均保持关闭
      defenseNeedsFinancial: false,
      epuTightPercentile: null,
      fiscalConfirmOnly: false,
      hysteresisConfirmDays: null,
      hysteresisLockOnly: false,
      trendReentry: true,
    });
  });
});

describe('smaLast（V1 十月均线）', () => {
  it('末端N期均值', () => {
    expect(smaLast([1, 2, 3, 4], 2)).toBe(3.5);
    expect(smaLast(Array(10).fill(5), 10)).toBe(5);
  });
  it('不足N期 → null（V1 前10个月跳过该规则）', () => {
    expect(smaLast([1, 2, 3], 10)).toBe(null);
    expect(smaLast([], 1)).toBe(null);
  });
});

describe('applyDowngradeHold 月度换算（V4：标准月=30天 合成日历 ⇔ 降档需连续2个月确认）', () => {
  // 月度重放把第 i 个月喂成 2000-01-01 + i×30 天，30天确认期恰好=1个标准月等待
  const synth = i => new Date(Date.parse('2000-01-01') + i * 30 * 86400000).toISOString().slice(0, 10);
  it('降档第1个标准月保持原档，第2个标准月生效（30天确认期满）', () => {
    const m1 = applyDowngradeHold('reduce', 'defense', null, synth(0));
    expect(m1.signal).toBe('defense');
    expect(m1.pendingSince).toBe(synth(0));
    const m2 = applyDowngradeHold('reduce', m1.signal, m1.pendingSince, synth(1));
    expect(m2).toEqual({ signal: 'reduce', pendingSince: null });
  });
  it('确认期内弹回防守 → 等待清零、即时回防（锁强制defense不受迟滞影响）', () => {
    const m1 = applyDowngradeHold('neutral', 'defense', null, synth(0));
    const m2 = applyDowngradeHold('defense', m1.signal, m1.pendingSince, synth(1));
    expect(m2).toEqual({ signal: 'defense', pendingSince: null });
  });
  it('首月无上档 → 直接采用候选档', () => {
    expect(applyDowngradeHold('reduce', null, null, synth(0))).toEqual({ signal: 'reduce', pendingSince: null });
  });
  it('真实月末日历会因2月28天<30天错过确认（合成日历存在的理由）', () => {
    const m1 = applyDowngradeHold('reduce', 'defense', null, '2001-01-31');
    const m2 = applyDowngradeHold('reduce', m1.signal, m1.pendingSince, '2001-02-28'); // 28天 < 30
    expect(m2.signal).toBe('defense'); // 若用真实日期，降档会拖到第3个月
  });
});

describe('replayMonth 变体（默认全关时与基线逐位一致）', () => {
  const NEUTRAL_INPUT = { rate: 3, prevRate: 3, walcl: null, prevWalcl: null, fiscalChangePct: null, epuPercentile: null, sahm: null };
  const NO_LOCK = { sahmLockActive: false, reactiveLockActive: false };

  it('V1 趋势否决：SPX<10月SMA 期间小幅调整解锁被否决，锁保持', () => {
    const m = { ...NEUTRAL_INPUT, rate: 3.25, prevRate: 3, spxBelowSma10: true };
    const base = replayMonth(m, { sahmLockActive: true, reactiveLockActive: true });
    expect(base.sahmLockActive).toBe(false); // 基线：小幅调整解锁
    const v1 = replayMonth(m, { sahmLockActive: true, reactiveLockActive: true }, { trendConfirm: true });
    expect(v1.sahmLockActive).toBe(true);
    expect(v1.reactiveLockActive).toBe(true);
    expect(v1.final).toBe('defense');
  });

  it('V1 趋势否决：零利率解锁也被否决（2008-12 场景）', () => {
    const m = { ...NEUTRAL_INPUT, rate: 0.25, prevRate: 1, sahm: 0.8, spxBelowSma10: true };
    const base = replayMonth(m, { sahmLockActive: true, reactiveLockActive: false });
    expect(base.sahmLockActive).toBe(false); // 基线：零利率解锁
    const v1 = replayMonth(m, { sahmLockActive: true, reactiveLockActive: false }, { trendConfirm: true });
    expect(v1.sahmLockActive).toBe(true);
  });

  it('V1 趋势收复（收盘≥SMA）后解锁路径恢复，与基线一致', () => {
    const m = { ...NEUTRAL_INPUT, rate: 3.25, prevRate: 3, spxBelowSma10: false };
    const v1 = replayMonth(m, { sahmLockActive: true, reactiveLockActive: true }, { trendConfirm: true });
    expect(v1.sahmLockActive).toBe(false);
    expect(v1.reactiveLockActive).toBe(false);
  });

  it('V1+V6 趋势之下不进攻：attack 降级 neutral', () => {
    const m = { ...NEUTRAL_INPUT, semiYoy: 12, spxBelowSma10: true };
    const above = replayMonth({ ...m, spxBelowSma10: false }, NO_LOCK, { trendConfirm: true, aiSemi: true });
    expect(above.final).toBe('attack');
    const below = replayMonth(m, NO_LOCK, { trendConfirm: true, aiSemi: true });
    expect(below.final).toBe('neutral');
  });

  it('V2 方向约束：降息触发的应对式锁不能被小幅降息解锁，小幅加息可以', () => {
    const locked = { sahmLockActive: false, reactiveLockActive: true, reactiveLockDir: 'cut', reactiveLockAge: 3 };
    const cut = replayMonth({ ...NEUTRAL_INPUT, rate: 2.75, prevRate: 3 }, locked, { cutLockDirUnlock: true });
    expect(cut.reactiveLockActive).toBe(true); // 小幅降息 → 锁保持
    const hike = replayMonth({ ...NEUTRAL_INPUT, rate: 3.25, prevRate: 3 }, locked, { cutLockDirUnlock: true });
    expect(hike.reactiveLockActive).toBe(false); // 小幅加息 → 解锁
    const zero = replayMonth({ ...NEUTRAL_INPUT, rate: 0.25, prevRate: 0.5 }, locked, { cutLockDirUnlock: true });
    expect(zero.reactiveLockActive).toBe(false); // 零利率 → 解锁
  });

  it('V2 加息触发的锁维持现行规则：小幅降息仍可解锁', () => {
    const locked = { sahmLockActive: false, reactiveLockActive: true, reactiveLockDir: 'hike', reactiveLockAge: 3 };
    const r = replayMonth({ ...NEUTRAL_INPUT, rate: 2.75, prevRate: 3 }, locked, { cutLockDirUnlock: true });
    expect(r.reactiveLockActive).toBe(false);
  });

  it('锁触发方向与锁龄锁存：降息≥50bp → dir=cut、age=1，次月保持则 age 递增', () => {
    const r1 = replayMonth({ ...NEUTRAL_INPUT, rate: 2.5, prevRate: 3 }, NO_LOCK);
    expect(r1.reactiveLockActive).toBe(true);
    expect(r1.reactiveLockDir).toBe('cut');
    expect(r1.reactiveLockAge).toBe(1);
    const r2 = replayMonth({ ...NEUTRAL_INPUT, rate: 2.5, prevRate: 2.5 }, r1);
    expect(r2.reactiveLockAge).toBe(2);
    expect(r2.reactiveLockDir).toBe('cut');
  });

  it('V3 最短锁存期：锁龄不足2月时小幅调整解锁无效，满2月后恢复', () => {
    const young = { sahmLockActive: false, reactiveLockActive: true, reactiveLockDir: 'hike', reactiveLockAge: 1 };
    const r1 = replayMonth({ ...NEUTRAL_INPUT, rate: 3.25, prevRate: 3 }, young, { minLockMonths: 2 });
    expect(r1.reactiveLockActive).toBe(true); // 锁龄1 < 2 → 保持
    const aged = { ...young, reactiveLockAge: 2 };
    const r2 = replayMonth({ ...NEUTRAL_INPUT, rate: 3.25, prevRate: 3 }, aged, { minLockMonths: 2 });
    expect(r2.reactiveLockActive).toBe(false); // 锁龄2 → 允许解锁
  });

  it('V3 零利率解锁不受最短锁存期限制', () => {
    const young = { sahmLockActive: true, reactiveLockActive: true, sahmLockAge: 1, reactiveLockAge: 1 };
    const r = replayMonth({ ...NEUTRAL_INPUT, rate: 0.25, prevRate: 1 }, young, { minLockMonths: 2 });
    expect(r.sahmLockActive).toBe(false);
    expect(r.reactiveLockActive).toBe(false);
  });

  it('V5 实际利率封顶：暂停（宽松票）且实际利率>+1.5% → 货币封顶 neutral；≤+1.5% 不动', () => {
    const capped = replayMonth({ ...NEUTRAL_INPUT, rate: 5.25, prevRate: 5.25, realRatePct: 3 }, NO_LOCK, { realRateCap: true });
    expect(capped.monetary).toBe('neutral');
    const kept = replayMonth({ ...NEUTRAL_INPUT, rate: 5.25, prevRate: 5.25, realRatePct: 1 }, NO_LOCK, { realRateCap: true });
    expect(kept.monetary).toBe('loose');
    const tight = replayMonth({ ...NEUTRAL_INPUT, rate: 5.5, prevRate: 5.25, realRatePct: 3 }, NO_LOCK, { realRateCap: true });
    expect(tight.monetary).toBe('tight'); // tight 不受封顶影响
  });

  it('V6 AI维半导体代理：同比>+5% → loose(进攻)；<0% → tight(单维=减仓)；之间 → neutral', () => {
    const loose = replayMonth({ ...NEUTRAL_INPUT, semiYoy: 8 }, NO_LOCK, { aiSemi: true });
    expect(loose.aiSupply).toBe('loose');
    expect(loose.final).toBe('attack'); // 政策三维不收紧 + AI宽松 → 进攻
    const tight = replayMonth({ ...NEUTRAL_INPUT, semiYoy: -2 }, NO_LOCK, { aiSemi: true });
    expect(tight.aiSupply).toBe('tight');
    expect(tight.final).toBe('reduce');
    const mid = replayMonth({ ...NEUTRAL_INPUT, semiYoy: 3 }, NO_LOCK, { aiSemi: true });
    expect(mid.aiSupply).toBe('neutral');
    const off = replayMonth({ ...NEUTRAL_INPUT, semiYoy: -2 }, NO_LOCK); // 变体关 → 恒 neutral
    expect(off.aiSupply).toBe('neutral');
  });
});

describe('findPeakTrough', () => {
  it('区间内最高/最低收盘', () => {
    const spx = [
      { date: '2020-01-15', close: 3300 },
      { date: '2020-02-19', close: 3386 },
      { date: '2020-03-23', close: 2237 },
      { date: '2020-06-01', close: 3055 },
    ];
    const { peak, trough } = findPeakTrough(spx, '2020-01-01', '2020-12-31');
    expect(peak.date).toBe('2020-02-19');
    expect(trough.date).toBe('2020-03-23');
  });
});

describe('lastDayOfMonth', () => {
  it('闰年2月', () => expect(lastDayOfMonth('2020-02')).toBe('2020-02-29'));
  it('平年2月', () => expect(lastDayOfMonth('2021-02')).toBe('2021-02-28'));
  it('12月跨年边界', () => expect(lastDayOfMonth('2021-12')).toBe('2021-12-31'));
});

describe('lastTwoWeeklyAsOf（WALCL周度环比 + 发布滞后）', () => {
  const series = [
    { date: '2020-03-04', value: 1 }, // 周三观测，3-05（周四）发布
    { date: '2020-03-11', value: 2 }, // 3-12 发布
    { date: '2020-03-18', value: 3 }, // 3-19 发布
  ];
  it('观测日+1 ≤ asOf 才可见：3-18 当天第三条尚未发布', () => {
    expect(lastTwoWeeklyAsOf(series, '2020-03-18')).toEqual({ curr: 2, prev: 1 });
  });
  it('3-19（发布日）起第三条可见', () => {
    expect(lastTwoWeeklyAsOf(series, '2020-03-19')).toEqual({ curr: 3, prev: 2 });
  });
  it('可见观测不足两条 → prev 为 null（判定降级 neutral）', () => {
    expect(lastTwoWeeklyAsOf(series, '2020-03-05')).toEqual({ curr: 1, prev: null });
    expect(lastTwoWeeklyAsOf(series, '2020-03-04')).toEqual({ curr: null, prev: null });
  });
});

describe('calcMissedPct（双语义）', () => {
  it('提前捕获（leadDays>0）：信号→顶部再涨 +X%（踏空成本，正值）', () => {
    const r = calcMissedPct(100, 110, 30);
    expect(r.missedKind).toBe('preTop');
    expect(r.missedPct).toBeCloseTo(10, 5);
  });
  it('滞后捕获（leadDays≤0）：顶部→信号已回落 −X%（负值）', () => {
    const r = calcMissedPct(90, 100, -30);
    expect(r.missedKind).toBe('postTop');
    expect(r.missedPct).toBeCloseTo(-10, 5);
  });
  it('缺数据 → null', () => {
    expect(calcMissedPct(null, 100, 5)).toEqual({ missedPct: null, missedKind: null });
    expect(calcMissedPct(100, 110, null)).toEqual({ missedPct: null, missedKind: null });
  });
});

describe('crisisPathStats（实际曝险路径，防守中途解除如实计入）', () => {
  const rateMap = new Map([['2020-01', 12], ['2020-02', 12]]); // 12%年化 → 1%/月
  it('defense月吃现金、非defense月吃SPY，savedPct=路径−买入持有（百分点）', () => {
    const timeline = [
      { month: '2020-01', spx: 100, final: 'defense' }, // 防守月：躲过 -10%
      { month: '2020-02', spx: 90, final: 'neutral' },  // 中途解除：吃满 -50%
      { month: '2020-03', spx: 45, final: 'defense' },
    ];
    const s = crisisPathStats(timeline, rateMap, '2020-01', '2020-03');
    expect(s.pathRetPct).toBeCloseTo(-49.5, 5);    // 1.01 × 0.5 − 1
    expect(s.buyHoldRetPct).toBeCloseTo(-55, 5);   // 0.45 − 1
    expect(s.savedPct).toBeCloseTo(5.5, 5);        // 相对买入持有少亏 5.5pp
    expect(s.coveragePct).toBeCloseTo(50, 5);      // 2个曝险决策月中1个defense
  });
  it('一路防守到底 → 覆盖率100%，savedPct=现金路径−买入持有', () => {
    const timeline = [
      { month: '2020-01', spx: 100, final: 'defense' },
      { month: '2020-02', spx: 50, final: 'defense' },
      { month: '2020-03', spx: 40, final: 'defense' },
    ];
    const s = crisisPathStats(timeline, rateMap, '2020-01', '2020-03');
    expect(s.coveragePct).toBe(100);
    expect(s.pathRetPct).toBeCloseTo((1.01 * 1.01 - 1) * 100, 5);
    expect(s.savedPct).toBeCloseTo((1.01 * 1.01 - 0.4) * 100, 5);
  });
  it('区间不足两个月 → null', () => {
    expect(crisisPathStats([{ month: '2020-01', spx: 100, final: 'defense' }], rateMap, '2020-01', '2020-01')).toBe(null);
  });
});

describe('simulateNav（净值模拟统一口径）', () => {
  const rateMap = new Map([['2020-01', 12], ['2020-02', 12]]); // 1%/月现金
  const months = [
    { month: '2020-01', spx: 100, final: 'reduce' },
    { month: '2020-02', spx: 110, final: 'defense' },
    { month: '2020-03', spx: 55, final: 'neutral' },
  ];
  it('buyHold 忽略档位恒满仓', () => {
    expect(simulateNav(months, rateMap, { buyHold: true }).totalPct).toBeCloseTo(-45, 5);
  });
  it('默认（仅defense离场）：defense月计现金利息而非零收益', () => {
    // reduce月满仓 ×1.1，defense月现金 ×1.01 → 11.1%
    expect(simulateNav(months, rateMap).totalPct).toBeCloseTo(11.1, 5);
  });
  it('reduce=50%仓敏感性：reduce月 50%SPY+50%现金', () => {
    // (0.5×1.1 + 0.5×1.01) × 1.01 − 1 = 6.555%
    expect(simulateNav(months, rateMap, { reduceWeight: 0.5 }).totalPct).toBeCloseTo(6.555, 3);
  });
  it('最大回撤按净值峰值回撤计', () => {
    const flat = [
      { month: '2020-01', spx: 100, final: 'neutral' },
      { month: '2020-02', spx: 120, final: 'neutral' },
      { month: '2020-03', spx: 60, final: 'neutral' },
    ];
    expect(simulateNav(flat, rateMap, { buyHold: true }).mddPct).toBeCloseTo(-50, 5);
  });
  it('不足两个月 → null', () => {
    expect(simulateNav([{ month: '2020-01', spx: 100, final: 'neutral' }], rateMap)).toBe(null);
  });
});

describe('W系变体（2026-07-17 第二轮：2010起跑输归因的针对性变体，默认全关）', () => {
  const NEUTRAL_INPUT = { rate: 3, prevRate: 3, walcl: null, prevWalcl: null, fiscalChangePct: null, epuPercentile: null, sahm: null };
  const NO_LOCK = { sahmLockActive: false, reactiveLockActive: false };

  describe('W1 防守共振须含金融维（defenseNeedsFinancial）', () => {
    it('纯政策组合（财政+行政双tight、货币不tight）只到 reduce', () => {
      const m = { ...NEUTRAL_INPUT, fiscalChangePct: 8, epuPercentile: 92 };
      expect(replayMonth(m, NO_LOCK).final).toBe('defense'); // 基线：双维共振防守
      expect(replayMonth(m, NO_LOCK, { defenseNeedsFinancial: true }).final).toBe('reduce');
    });
    it('货币tight参与的共振仍是 defense', () => {
      const m = { ...NEUTRAL_INPUT, rate: 3.25, prevRate: 3, epuPercentile: 92 }; // 加息→货币tight + 行政tight
      expect(replayMonth(m, NO_LOCK, { defenseNeedsFinancial: true }).final).toBe('defense');
    });
    it('锁不受限：财政+行政共振被降级，但萨姆锁仍强制 defense', () => {
      const m = { ...NEUTRAL_INPUT, fiscalChangePct: 8, epuPercentile: 92, sahm: 0.6 };
      const r = replayMonth(m, NO_LOCK, { defenseNeedsFinancial: true });
      expect(r.sahmLockActive).toBe(true);
      expect(r.final).toBe('defense');
    });
  });

  describe('W2 行政tight阈值覆盖（epuTightPercentile）', () => {
    it('85分位在90阈值下不再tight（80阈值下tight）', () => {
      const m = { ...NEUTRAL_INPUT, epuPercentile: 85 };
      expect(replayMonth(m, NO_LOCK).admin).toBe('tight');
      expect(replayMonth(m, NO_LOCK, { epuTightPercentile: 90 }).admin).toBe('neutral');
    });
    it('92分位在90阈值下仍tight；油价护栏 epuHigh 同步用覆盖阈值', () => {
      expect(replayMonth({ ...NEUTRAL_INPUT, epuPercentile: 92 }, NO_LOCK, { epuTightPercentile: 90 }).admin).toBe('tight');
      // 油价+25%飙升：EPU 85分位在90阈值下不算高位 → 不判战争冲击tight（走百分位判定→neutral）
      const r = replayMonth({ ...NEUTRAL_INPUT, epuPercentile: 85, oilChangePct: 25 }, NO_LOCK, { epuTightPercentile: 90 });
      expect(r.admin).toBe('neutral');
    });
  });

  describe('W3 财政降为确认性信号（fiscalConfirmOnly）', () => {
    it('财政+行政双tight：财政不计共振票 → reduce（仍计减仓票）', () => {
      const m = { ...NEUTRAL_INPUT, fiscalChangePct: 8, epuPercentile: 92 };
      expect(replayMonth(m, NO_LOCK, { fiscalConfirmOnly: true }).final).toBe('reduce');
    });
    it('货币+行政双tight（不含财政）→ 仍 defense', () => {
      const m = { ...NEUTRAL_INPUT, rate: 3.25, prevRate: 3, epuPercentile: 92 };
      expect(replayMonth(m, NO_LOCK, { fiscalConfirmOnly: true }).final).toBe('defense');
    });
    it('财政单维tight → 仍触发 reduce', () => {
      const m = { ...NEUTRAL_INPUT, fiscalChangePct: 8 };
      expect(replayMonth(m, NO_LOCK, { fiscalConfirmOnly: true }).final).toBe('reduce');
    });
  });

  describe('W5 趋势再入场（trendReentry：月末SPX>10月SMA时决策树defense降级reduce）', () => {
    const treeDef = { ...NEUTRAL_INPUT, fiscalChangePct: 8, epuPercentile: 92 }; // 财政+行政树防守
    it('SPX在10月SMA上方（spxBelowSma10=false）→ 树防守降级 reduce', () => {
      expect(replayMonth({ ...treeDef, spxBelowSma10: false }, NO_LOCK, { trendReentry: true }).final).toBe('reduce');
    });
    it('SPX在SMA下方或SMA不可得（null）→ 树防守保持', () => {
      expect(replayMonth({ ...treeDef, spxBelowSma10: true }, NO_LOCK, { trendReentry: true }).final).toBe('defense');
      expect(replayMonth({ ...treeDef, spxBelowSma10: null }, NO_LOCK, { trendReentry: true }).final).toBe('defense');
    });
    it('锁驱动的defense不受趋势影响（2022应对锁/2024萨姆锁场景）', () => {
      const m = { ...NEUTRAL_INPUT, sahm: 0.6, spxBelowSma10: false };
      const r = replayMonth(m, NO_LOCK, { trendReentry: true });
      expect(r.sahmLockActive).toBe(true);
      expect(r.final).toBe('defense');
    });
  });
});

describe('applyDowngradeHoldWithDays（W4a：确认期参数化，逻辑与线上逐位一致）', () => {
  const synth = i => new Date(Date.parse('2000-01-01') + i * 30 * 86400000).toISOString().slice(0, 10);
  it('confirmDays=30 与线上 applyDowngradeHold 行为一致：第2个标准月降档生效', () => {
    const m1 = applyDowngradeHoldWithDays('reduce', 'defense', null, synth(0), 30);
    expect(m1).toEqual(applyDowngradeHold('reduce', 'defense', null, synth(0)));
    const m2 = applyDowngradeHoldWithDays('reduce', m1.signal, m1.pendingSince, synth(1), 30);
    expect(m2).toEqual({ signal: 'reduce', pendingSince: null });
  });
  it('confirmDays=14 在月度粒度（30天步长）下与30天等价：仍是第2个标准月生效', () => {
    const m1 = applyDowngradeHoldWithDays('reduce', 'defense', null, synth(0), 14);
    expect(m1.signal).toBe('defense'); // 第1个月 ageDays=0 < 14 → 扛住
    const m2 = applyDowngradeHoldWithDays('reduce', m1.signal, m1.pendingSince, synth(1), 14);
    expect(m2.signal).toBe('reduce');  // 第2个月 ageDays=30 ≥ 14 → 生效（与30天确认期同月）
  });
  it('升档即时生效并清空等待', () => {
    expect(applyDowngradeHoldWithDays('defense', 'reduce', synth(0), synth(1), 14))
      .toEqual({ signal: 'defense', pendingSince: null });
  });
});

describe('synthLeveragedDaily（执行层：2x日度再平衡杠杆合成，诚实费用口径）', () => {
  const bars = [
    { date: '2020-01-02', close: 100 },
    { date: '2020-01-03', close: 110 }, // +10%
    { date: '2020-01-06', close: 99 },  // −10%
  ];
  it('逐日 净值×=1+2×日收益−日费用；费用=[ER+(2−1)×(FFR+0.4)]/252', () => {
    const out = synthLeveragedDaily(bars, () => 2.0, { leverage: 2, erPct: 0.95, borrowSpreadPct: 0.4, tradingDays: 252 });
    const fee = (0.95 + 1 * (2.0 + 0.4)) / 100 / 252;
    const nav1 = 1 * (1 + 2 * 0.10 - fee);
    const nav2 = nav1 * (1 + 2 * (99 / 110 - 1) - fee);
    expect(out[0].close).toBe(1);
    expect(out[1].close).toBeCloseTo(nav1, 12);
    expect(out[2].close).toBeCloseTo(nav2, 12);
  });
  it('携带波动损耗：+10%再−10%，1x总收益−1%，2x≈−4%再扣费（劣于"月收益×2"的乐观近似）', () => {
    const out = synthLeveragedDaily(bars, () => 0, { leverage: 2, erPct: 0, borrowSpreadPct: 0 });
    expect(out[2].close).toBeCloseTo(1.2 * 0.8, 12); // −4% < 2×(−1%)
  });
  it('leverage=1 时无借贷成本项，仅 ER 拖累', () => {
    const out = synthLeveragedDaily(bars.slice(0, 2), () => 5, { leverage: 1, erPct: 0.95, borrowSpreadPct: 0.4 });
    expect(out[1].close).toBeCloseTo(1 + 0.10 - 0.95 / 100 / 252, 12);
  });
});

describe('monthlyCloseMap（执行层：日线→月末收盘）', () => {
  it('每月取最后一根日线收盘', () => {
    const m = monthlyCloseMap([
      { date: '2020-03-05', close: 1 },
      { date: '2020-03-31', close: 2 },
      { date: '2020-04-15', close: 3 },
    ]);
    expect(m.get('2020-03')).toBe(2);
    expect(m.get('2020-04')).toBe(3);
  });
});

describe('simulateExecution（执行层：档位→持仓月末调仓）', () => {
  const rateMap = new Map([['2020-01', 12], ['2020-02', 12]]); // 1%/月现金
  const pxMap = new Map([['2020-01', 100], ['2020-02', 110], ['2020-03', 55]]);
  const assetRet = (asset, m0, m1) => {
    if (asset !== 'spy') return null;
    const a = pxMap.get(m0), b = pxMap.get(m1);
    return a && b ? b / a - 1 : null;
  };
  const months = [
    { month: '2020-01', final: 'reduce' },
    { month: '2020-02', final: 'defense' },
    { month: '2020-03', final: 'neutral' },
  ];
  it('E0语义（defense→现金，其余SPY）与 simulateNav 同口径：reduce月×1.1，defense月×1.01', () => {
    const w = f => (f === 'defense' ? { cash: 1 } : { spy: 1 });
    expect(simulateExecution(months, w, assetRet, rateMap).totalPct).toBeCloseTo(11.1, 5);
  });
  it('混合权重月末再平衡：0.5xSPY+0.5现金 → 0.5×10%+0.5×1%', () => {
    const w = () => ({ spy: 0.5, cash: 0.5 });
    const s = simulateExecution(months.slice(0, 2), w, assetRet, rateMap);
    expect(s.totalPct).toBeCloseTo(5.5, 5);
  });
  it('yearly 按日历年聚合收益，yearMonths 计收益月数（首月为基期不计）', () => {
    const w = () => ({ spy: 1 });
    const s = simulateExecution(months, w, assetRet, rateMap);
    expect(s.yearly.get('2020')).toBeCloseTo((1.1 * 0.5 - 1) * 100, 5);
    expect(s.yearMonths.get('2020')).toBe(2);
  });
  it('资产缺月收益 → 抛错（样本窗口必须从资产起始月裁剪，不静默跳过）', () => {
    const w = () => ({ qqq: 1 });
    expect(() => simulateExecution(months, w, assetRet, rateMap)).toThrow(/缺/);
  });
  it('不足两个月 → null', () => {
    expect(simulateExecution(months.slice(0, 1), () => ({ spy: 1 }), assetRet, rateMap)).toBe(null);
  });
});

describe('perfectForesightCagr（执行层：完美预知月度择时天花板）', () => {
  const rateMap = new Map([['2020-01', 12], ['2020-02', 12]]); // 1%/月现金
  it('每月取 max(资产收益, 现金收益)：涨月满仓、跌月现金', () => {
    const pxMap = new Map([['2020-01', 100], ['2020-02', 110], ['2020-03', 55]]);
    const retOf = (m0, m1) => pxMap.get(m1) / pxMap.get(m0) - 1;
    const months = [{ month: '2020-01' }, { month: '2020-02' }, { month: '2020-03' }];
    const p = perfectForesightCagr(months, retOf, rateMap);
    // 第1月 +10% > 1% → 满仓；第2月 −50% < 1% → 现金：总 1.1×1.01
    const nav = 1.1 * 1.01;
    expect(p.cagrPct).toBeCloseTo((Math.pow(nav, 12 / 2) - 1) * 100, 6);
    expect(p.cashMonths).toBe(1);
    expect(p.totalMonths).toBe(2);
  });
  it('不足两个月 → null', () => {
    expect(perfectForesightCagr([{ month: '2020-01' }], () => 0, rateMap)).toBe(null);
  });
});
