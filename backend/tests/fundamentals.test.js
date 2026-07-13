import { describe, it, expect } from 'vitest';
import { sumTtmRevenue } from '../api/fundamentals.js';

const q = (start, end, val, form = '10-Q') => ({ start, end, val, form });

describe('sumTtmRevenue', () => {
  it('最近4个季度求和（同期重述去重取最新披露）', () => {
    const facts = [
      q('2025-07-01', '2025-09-28', 100),
      q('2025-09-29', '2025-12-28', 110),
      q('2025-12-29', '2026-03-29', 120),
      q('2025-12-29', '2026-03-29', 121), // 重述：同end取后者
      q('2026-03-30', '2026-06-28', 130),
      q('2025-04-01', '2025-06-30', 90),  // 第5个季度，不计入
    ];
    expect(sumTtmRevenue(facts, '2026-07-13')).toBe(100 + 110 + 121 + 130);
  });

  it('季度不足4个 → 退回最近年报口径（20-F外国发行人场景）', () => {
    const facts = [
      q('2025-01-01', '2025-12-31', 1000, '20-F'),
      q('2026-01-01', '2026-03-31', 260),
    ];
    expect(sumTtmRevenue(facts, '2026-07-13')).toBe(1000);
  });

  it('最新报告期距今超400天（退市/停报）→ null', () => {
    const facts = [
      q('2024-01-01', '2024-03-31', 100),
      q('2024-04-01', '2024-06-30', 100),
      q('2024-07-01', '2024-09-30', 100),
      q('2024-10-01', '2024-12-31', 100),
    ];
    expect(sumTtmRevenue(facts, '2026-07-13')).toBe(null);
  });

  it('空/无效输入 → null', () => {
    expect(sumTtmRevenue([], '2026-07-13')).toBe(null);
    expect(sumTtmRevenue(null, '2026-07-13')).toBe(null);
    expect(sumTtmRevenue([q('2026-01-01', '2026-03-31', NaN)], '2026-07-13')).toBe(null);
  });

  it('年度值也陈旧 → null；YTD半年值（约180天）不误当季度', () => {
    const facts = [
      q('2026-01-01', '2026-06-28', 500), // 半年YTD，不是季度
    ];
    expect(sumTtmRevenue(facts, '2026-07-13')).toBe(null);
  });
});
