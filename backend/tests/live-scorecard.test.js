import { describe, it, expect } from 'vitest';
import { forwardReturnPct, scoreByTier, tierTransitions } from '../backtest/live-scorecard.mjs';

const closes = [
  { date: '2026-07-01', close: 100 },
  { date: '2026-07-02', close: 102 },
  { date: '2026-07-03', close: 99 },
  { date: '2026-07-06', close: 101 },
  { date: '2026-07-07', close: 98 },
];

describe('live-scorecard 纯函数', () => {
  it('forwardReturnPct：n 交易日前向收益，越界 null', () => {
    expect(forwardReturnPct(closes, 0, 2)).toBeCloseTo(-1, 5); // 100→99
    expect(forwardReturnPct(closes, 3, 5)).toBeNull();
    expect(forwardReturnPct(closes, -1, 1)).toBeNull();
  });

  it('scoreByTier：按档位聚合前向收益与下跌占比；非交易日信号取之后首个交易日', () => {
    const rows = [
      { date: '2026-07-01', finalSignal: 'defense' },
      { date: '2026-07-04', finalSignal: 'neutral' }, // 周六 → 落到 07-06
    ];
    const s = scoreByTier(rows, closes, 1);
    expect(s.defense.n).toBe(1);
    expect(s.defense.avgPct).toBeCloseTo(2, 5);   // 100→102
    expect(s.defense.downShare).toBe(0);
    expect(s.neutral.avgPct).toBeCloseTo(-2.9703, 3); // 101→98
    expect(s.neutral.downShare).toBe(1);
  });

  it('tierTransitions：升降档事件按时间正序输出', () => {
    const rows = [
      { date: '2026-07-03', finalSignal: 'reduce' },
      { date: '2026-07-02', finalSignal: 'neutral' },
      { date: '2026-07-01', finalSignal: 'neutral' },
    ];
    const ev = tierTransitions(rows);
    expect(ev).toEqual([{ date: '2026-07-03', from: 'neutral', to: 'reduce', dir: '升档(更防守)' }]);
  });
});
