// s5-daily.mjs 纯函数单测：日序列构建 / S5日度状态机（T+0与T+1执行、月末新钱规则、
// 往返记账、储备计息）/ 日度盯市极值
import { describe, it, expect } from 'vitest';
import { buildS5Days, simulateS5Daily, dailyPathExtremes } from '../backtest/s5-daily.mjs';

const day = (date, px, tier, isMonthEnd = false, rate = 0) =>
  ({ date, px, tier, rate, isMonthEnd, trigger: '决策树共振' });

describe('buildS5Days', () => {
  const recs = [
    { date: '2020-01-30', final: 'neutral', rawFinal: 'neutral', sahmLockActive: false, reactiveLockActive: false, metrics: { rate: 1.75 } },
    { date: '2020-01-31', final: 'neutral', rawFinal: 'reduce', sahmLockActive: false, reactiveLockActive: false, metrics: { rate: 1.75 } },
    { date: '2020-02-03', final: 'defense', rawFinal: 'defense', sahmLockActive: false, reactiveLockActive: true, metrics: { rate: 1.75 } },
  ];
  const bars = [
    { date: '2020-01-30', close: 100 }, { date: '2020-01-31', close: 101 }, { date: '2020-02-03', close: 90 },
  ];
  it('月末=该月最后一个交易日；样本末一天恒为月末；触发标注锁优先', () => {
    const days = buildS5Days(recs, bars);
    expect(days.map(d => d.isMonthEnd)).toEqual([false, true, true]);
    expect(days[2].trigger).toBe('应对式锁');
    expect(days[2].px).toBe(90);
  });
  it('tierKey=rawFinal 取无迟滞档；缺当日bar用最近可得收盘承接', () => {
    const days = buildS5Days(recs, bars.slice(0, 2), 'rawFinal'); // 2020-02-03 无bar
    expect(days[1].tier).toBe('reduce');
    expect(days[2].px).toBe(101); // 承接 01-31 收盘
  });
});

describe('simulateS5Daily：T+0 执行', () => {
  const days = [
    day('2020-01-30', 100, 'neutral'),
    day('2020-01-31', 100, 'neutral', true),  // 月末买入 C=1 → 0.01股
    day('2020-02-03', 90, 'defense'),         // 进defense当日收盘卖出@90
    day('2020-02-28', 80, 'defense', true),   // 防守期月末：新钱入储备
    day('2020-03-02', 85, 'neutral'),         // 出defense当日收盘买回@85
    day('2020-03-31', 90, 'neutral', true),   // 常规月末买入
  ];
  const run = simulateS5Daily(days);
  it('往返记账：卖出/买回日与价格、期间涨跌、持币天数', () => {
    expect(run.episodes).toHaveLength(1);
    const e = run.episodes[0];
    expect(e.sellDate).toBe('2020-02-03');
    expect(e.sellPx).toBe(90);
    expect(e.buyDate).toBe('2020-03-02');
    expect(e.buyPx).toBe(85);
    expect(e.tqqqChangePct).toBeCloseTo((85 / 90 - 1) * 100, 6);
    expect(e.waitDays).toBe(28);
  });
  it('资金流：卖出0.01股@90=0.9入储备，月末+1=1.9，买回1.9/85股，月末再买1/90', () => {
    const units = 1.9 / 85 + 1 / 90;
    const last = run.dailyPoints[run.dailyPoints.length - 1];
    expect(last.value).toBeCloseTo(units * 90, 10);
    expect(last.invested).toBe(3);
    expect(run.trades.sells).toBe(1);
    expect(run.missedMonthEnds).toBe(1); // 仅 2020-02-28（defense月末）
  });
});

describe('simulateS5Daily：T+1 执行（收邮件次日交易）', () => {
  const days = [
    day('2020-01-31', 100, 'neutral', true),
    day('2020-02-03', 90, 'defense'),         // 信号日
    day('2020-02-04', 80, 'defense'),         // T+1 在此卖出@80
    day('2020-03-02', 85, 'neutral'),         // 退出信号日
    day('2020-03-03', 88, 'neutral'),         // T+1 在此买回@88
  ];
  it('卖出/买回都顺延到下一交易日收盘', () => {
    const run = simulateS5Daily(days, 1, { execLagDays: 1 });
    const e = run.episodes[0];
    expect(e.sellDate).toBe('2020-02-04');
    expect(e.sellPx).toBe(80);
    expect(e.buyDate).toBe('2020-03-03');
    expect(e.buyPx).toBe(88);
  });
});

describe('simulateS5Daily：储备计息与样本末开放往返', () => {
  it('储备按上一交易日目标利率/252 复利', () => {
    const days = [
      day('2020-01-31', 100, 'reduce', true, 25.2), // 新钱1入储备
      day('2020-02-03', 100, 'reduce', false, 25.2), // 储备 ×(1+0.001)
    ];
    const run = simulateS5Daily(days);
    expect(run.dailyPoints[1].value).toBeCloseTo(1 * (1 + 25.2 / 100 / 252), 10);
  });
  it('样本末仍在defense：episode 记 buyDate=null，按末日价计涨跌', () => {
    const days = [
      day('2020-01-31', 100, 'neutral', true),
      day('2020-02-03', 90, 'defense'),
      day('2020-02-28', 63, 'defense', true),
    ];
    const run = simulateS5Daily(days);
    expect(run.episodes).toHaveLength(1);
    expect(run.episodes[0].buyDate).toBe(null);
    expect(run.episodes[0].tqqqChangePct).toBeCloseTo((63 / 90 - 1) * 100, 6);
  });
});

describe('dailyPathExtremes', () => {
  it('日度盯市：市值回撤与最大浮亏（vs累计投入）', () => {
    const pts = [
      { date: 'd1', value: 1, invested: 1 },
      { date: 'd2', value: 2, invested: 2 },
      { date: 'd3', value: 1.2, invested: 2 }, // 回撤-40%，浮亏-40%
      { date: 'd4', value: 3, invested: 3 },
    ];
    const x = dailyPathExtremes(pts);
    expect(x.valueMddPct).toBeCloseTo(-40, 6);
    expect(x.minValueToInvestedPct).toBeCloseTo(-40, 6);
  });
});
