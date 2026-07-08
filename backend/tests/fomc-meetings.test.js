import { describe, it, expect } from 'vitest';
import { getLastFomcDecisionDate } from '../config/fomc-meetings.js';

describe('getLastFomcDecisionDate', () => {
  it('会议当天返回该会议日期', () => {
    expect(getLastFomcDecisionDate('2026-06-17')).toBe('2026-06-17');
  });

  it('会议前一天返回上一次会议日期', () => {
    expect(getLastFomcDecisionDate('2026-06-16')).toBe('2026-04-29');
  });

  it('两次会议之间返回较早的那次', () => {
    expect(getLastFomcDecisionDate('2026-05-15')).toBe('2026-04-29');
  });

  it('早于所有已知会议日期时返回 null', () => {
    expect(getLastFomcDecisionDate('2024-01-01')).toBe(null);
  });
});
