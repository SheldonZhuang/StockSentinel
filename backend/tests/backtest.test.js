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
} from '../backtest/run-backtest.js';

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
