// accuracy-report.mjs 纯函数 + run-backtest.js X系变体开关的单元测试（2026-07-18）
import { describe, it, expect } from 'vitest';
import {
  episodesOf,
  futureDrawdownPct,
  confusionStats,
  buildConfusionPairs,
  crisisSpansOf,
  episodeVerdict,
} from '../backtest/accuracy-report.mjs';
import { replayMonth } from '../backtest/run-backtest.js';

// ---------- 纯函数 ----------

describe('futureDrawdownPct', () => {
  const spx = [100, 90, 80, 120, 70];
  it('未来h月窗口内最低价 vs 当月价', () => {
    expect(futureDrawdownPct(spx, 0, 2)).toBeCloseTo(-20); // min(90,80)/100-1
    expect(futureDrawdownPct(spx, 0, 4)).toBeCloseTo(-30); // min含70
  });
  it('末端窗口截断：用可得部分', () => {
    expect(futureDrawdownPct(spx, 3, 6)).toBeCloseTo(70 / 120 * 100 - 100);
  });
  it('无未来点或基准缺失 → null', () => {
    expect(futureDrawdownPct(spx, 4, 3)).toBeNull();
    expect(futureDrawdownPct([null, 90], 0, 1)).toBeNull();
  });
  it('未来价缺失点被跳过', () => {
    expect(futureDrawdownPct([100, null, 80], 0, 2)).toBeCloseTo(-20);
  });
});

describe('confusionStats', () => {
  it('TP/FP/FN/TN 与派生指标', () => {
    const pairs = [
      { actual: true, predicted: true },   // TP
      { actual: true, predicted: true },   // TP
      { actual: false, predicted: true },  // FP
      { actual: true, predicted: false },  // FN
      { actual: false, predicted: false }, // TN
      { actual: false, predicted: false }, // TN
    ];
    const s = confusionStats(pairs);
    expect([s.tp, s.fp, s.fn, s.tn]).toEqual([2, 1, 1, 2]);
    expect(s.accuracy).toBeCloseTo(4 / 6);
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.recall).toBeCloseTo(2 / 3);
    expect(s.f1).toBeCloseTo(2 / 3);
  });
  it('空输入不除零', () => {
    const s = confusionStats([]);
    expect(s.accuracy).toBeNull();
    expect(s.precision).toBeNull();
    expect(s.f1).toBeNull();
  });
});

describe('buildConfusionPairs', () => {
  const tl = [
    { month: '2020-01', spx: 100, final: 'defense' },
    { month: '2020-02', spx: 80, final: 'defense' },
    { month: '2020-03', spx: 95, final: 'neutral' },
    { month: '2020-04', spx: 100, final: 'neutral' },
  ];
  it('actual=未来h月回撤超阈值；末尾不足h月的月份剔除', () => {
    const pairs = buildConfusionPairs(tl, 1, 15);
    expect(pairs.map(p => p.month)).toEqual(['2020-01', '2020-02', '2020-03']);
    expect(pairs[0]).toMatchObject({ actual: true, predicted: true });   // 100→80 = -20%
    expect(pairs[1]).toMatchObject({ actual: false, predicted: true });  // 80→95 上涨
    expect(pairs[2]).toMatchObject({ actual: false, predicted: false });
  });
});

describe('episodesOf', () => {
  it('连续defense切段，end=恢复月（不含），在续段end=null', () => {
    const tl = [
      { month: '2020-01', final: 'neutral' },
      { month: '2020-02', final: 'defense' },
      { month: '2020-03', final: 'defense' },
      { month: '2020-04', final: 'reduce' },
      { month: '2020-05', final: 'defense' },
    ];
    const eps = episodesOf(tl);
    expect(eps).toHaveLength(2);
    expect(eps[0]).toMatchObject({ start: '2020-02', end: '2020-04' });
    expect(eps[0].months).toHaveLength(2);
    expect(eps[1]).toMatchObject({ start: '2020-05', end: null });
  });
});

describe('crisisSpansOf / episodeVerdict', () => {
  const crisisRows = [
    { name: '大危机', drawdownPct: -40, peakDate: '2020-02-19', troughDate: '2020-03-23' },
    { name: '小回调', drawdownPct: -9, peakDate: '2026-01-27', troughDate: '2026-03-30' },
    { name: '缺数据', drawdownPct: null, peakDate: '数据缺失', troughDate: '—' },
  ];
  it('只保留>15%危机，区间为[顶部月,底部月]', () => {
    const spans = crisisSpansOf(crisisRows);
    expect(spans).toEqual([{ name: '大危机', start: '2020-02', end: '2020-03' }]);
  });
  it('strict：起始月起12个月内>15%跟随；overlap：与危机区间相交', () => {
    const tl = [
      { month: '2020-02', spx: 100, final: 'defense' },
      { month: '2020-03', spx: 80, final: 'defense' },
      { month: '2020-04', spx: 95, final: 'neutral' },
    ];
    const idxOf = new Map(tl.map((t, i) => [t.month, i]));
    const spans = crisisSpansOf(crisisRows);
    const eps = episodesOf(tl);
    const v = episodeVerdict(eps[0], tl, idxOf, spans);
    expect(v.maxDD12).toBeCloseTo(-20);
    expect(v.strictTrue).toBe(true);
    expect(v.overlapCrisis).toBe('大危机');
  });
  it('晚到的防守：strict假但overlap真（滞后捕获不算纯误报）', () => {
    const tl = [
      { month: '2020-03', spx: 80, final: 'defense' },  // 底部月才防守
      { month: '2020-04', spx: 95, final: 'neutral' },
    ];
    const idxOf = new Map(tl.map((t, i) => [t.month, i]));
    const v = episodeVerdict(episodesOf(tl)[0], tl, idxOf, crisisSpansOf(crisisRows));
    expect(v.strictTrue).toBe(false);
    expect(v.overlapCrisis).toBe('大危机');
  });
});

// ---------- replayMonth X系变体开关（默认全关 = 与基线逐位一致） ----------

const baseM = {
  rate: null, prevRate: null, walcl: null, prevWalcl: null,
  fiscalChangePct: null, epuPercentile: null, sahm: null,
  oilChangePct: null, spxBelowSma10: null, realRatePct: null, semiYoy: null,
};

describe('X2 monetaryCarryDir 货币决议方向近似', () => {
  it('默认关：本月无变动一律判宽松', () => {
    const r = replayMonth({ ...baseM, rate: 5.0, prevRate: 5.0 }, { rateSignal: 'tight' }, {});
    expect(r.monetary).toBe('loose');
  });
  it('开启：diff=0 沿用上月方向（加息周期无会议月保持tight）', () => {
    const r = replayMonth({ ...baseM, rate: 5.0, prevRate: 5.0 }, { rateSignal: 'tight' }, { monetaryCarryDir: true });
    expect(r.monetary).toBe('tight');
    expect(r.rateSignal).toBe('tight'); // 状态继续向后传
  });
  it('开启：有实际变动时不沿用（降息压过历史方向）', () => {
    const r = replayMonth({ ...baseM, rate: 4.75, prevRate: 5.0 }, { rateSignal: 'tight' }, { monetaryCarryDir: true });
    expect(r.monetary).toBe('loose');
  });
});

describe('X4 sahmConfirmMonths 萨姆锁确认期', () => {
  it('默认关：首个≥0.5月即触发萨姆锁强制defense', () => {
    const r = replayMonth({ ...baseM, sahm: 0.53 }, {}, {});
    expect(r.sahmLockActive).toBe(true);
    expect(r.final).toBe('defense');
    expect(r.sahmHighStreak).toBe(1);
  });
  it('确认2月：首月不触发，连续第2月触发', () => {
    const r1 = replayMonth({ ...baseM, sahm: 0.53 }, {}, { sahmConfirmMonths: 2 });
    expect(r1.sahmLockActive).toBe(false);
    expect(r1.sahmHighStreak).toBe(1);
    const r2 = replayMonth({ ...baseM, sahm: 0.57 }, { sahmHighStreak: r1.sahmHighStreak }, { sahmConfirmMonths: 2 });
    expect(r2.sahmLockActive).toBe(true);
    expect(r2.final).toBe('defense');
  });
  it('中断清零：低于0.5后重新计数', () => {
    const r = replayMonth({ ...baseM, sahm: 0.4 }, { sahmHighStreak: 1 }, { sahmConfirmMonths: 2 });
    expect(r.sahmHighStreak).toBe(0);
    expect(r.sahmLockActive).toBe(false);
  });
});

describe('X3 defenseNeedsAdminOrLock 纯"货币+财政"共振降级（2026-07-18采纳，最窄口径=线上calcFinalSignal内置）', () => {
  // 货币tight(+25bp) + 财政tight(>5%)，行政不tight → 纯政策两维共振
  const m = { ...baseM, rate: 5.25, prevRate: 5.0, fiscalChangePct: 6, epuPercentile: 50 };
  it('默认关：货币+财政两维共振 = defense', () => {
    expect(replayMonth(m, {}, {}).final).toBe('defense');
  });
  it('开启：纯货币+财政降级reduce', () => {
    expect(replayMonth(m, {}, { defenseNeedsAdminOrLock: true }).final).toBe('reduce');
  });
  it('开启：含行政维的共振不受影响', () => {
    const r = replayMonth({ ...m, epuPercentile: 85 }, {}, { defenseNeedsAdminOrLock: true });
    expect(r.admin).toBe('tight');
    expect(r.final).toBe('defense');
  });
  it('开启：锁驱动defense不受影响（锁在降级之后覆盖）', () => {
    const r = replayMonth({ ...m, sahm: 0.6 }, {}, { defenseNeedsAdminOrLock: true });
    expect(r.final).toBe('defense');
  });
});

describe('X1/X1b 锁驱动defense的趋势再入场门', () => {
  const sahmLockM = { ...baseM, sahm: 0.6, spxBelowSma10: false }; // 萨姆锁 + 月末价在10月SMA上方
  it('W5默认：锁驱动defense豁免趋势门', () => {
    const r = replayMonth(sahmLockM, {}, { trendReentry: true });
    expect(r.final).toBe('defense');
  });
  it('X1：萨姆锁驱动的defense被趋势门降级reduce（锁状态本身保持）', () => {
    const r = replayMonth(sahmLockM, {}, { trendReentry: true, sahmLockTrendReentry: true });
    expect(r.sahmLockActive).toBe(true);
    expect(r.final).toBe('reduce');
  });
  it('X1不动应对锁：50bp降息触发的应对锁仍defense（2007-09保护）', () => {
    const m = { ...baseM, rate: 4.75, prevRate: 5.25, spxBelowSma10: false }; // -50bp
    const r = replayMonth(m, {}, { trendReentry: true, sahmLockTrendReentry: true });
    expect(r.reactiveLockActive).toBe(true);
    expect(r.final).toBe('defense');
  });
  it('X1b：应对锁也过趋势门 → reduce', () => {
    const m = { ...baseM, rate: 4.75, prevRate: 5.25, spxBelowSma10: false };
    const r = replayMonth(m, {}, { trendReentry: true, lockTrendReentry: true });
    expect(r.final).toBe('reduce');
  });
  it('趋势下方（spxBelowSma10=true）时X1不降级：防守保持', () => {
    const r = replayMonth({ ...sahmLockM, spxBelowSma10: true }, {}, { trendReentry: true, sahmLockTrendReentry: true });
    expect(r.final).toBe('defense');
  });
});
