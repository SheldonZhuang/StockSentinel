import { describe, it, expect } from 'vitest';
import {
  spliceRateSeries,
  sampleMonthEnd,
  percentileAsOf,
  ttmDeficitChangePct,
  replayMonth,
  findPeakTrough,
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

describe('ttmDeficitChangePct', () => {
  it('赤字扩大（更负）→ 正百分比', () => {
    // 前12月每月 -100，后12月每月 -110 → 赤字扩大10%
    const values = [...Array(12).fill(-100), ...Array(12).fill(-110)];
    expect(ttmDeficitChangePct(values)).toBeCloseTo(10, 5);
  });

  it('不足24个月 → null', () => {
    expect(ttmDeficitChangePct(Array(23).fill(-100))).toBe(null);
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
