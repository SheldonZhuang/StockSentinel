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

describe('getLastFomcDecisionDate 2027 日历（126号录入 Fed 2025-09-05 新闻稿）', () => {
  it('2027-01-27 会议当天返回该日期', () => {
    expect(getLastFomcDecisionDate('2027-01-27')).toBe('2027-01-27');
  });
  it('2027 年中两次会议之间返回较早一次', () => {
    expect(getLastFomcDecisionDate('2027-07-01')).toBe('2027-06-09');
  });
  it('2027-12-08 之后到 2028-01-26 之间仍返回 2027-12-08（间隔49天，不触发70天耗尽护栏）', () => {
    const warned = [];
    expect(getLastFomcDecisionDate('2028-01-25', m => warned.push(m))).toBe('2027-12-08');
    expect(warned).toEqual([]);
  });
  it('日历耗尽时触发 onStale 回调（126号运维告警钩子）', () => {
    const warned = [];
    expect(getLastFomcDecisionDate('2028-06-01', m => warned.push(m))).toBe('2028-01-26');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/2028-01-26/);
  });
});
