// 130号：FOMC 决议日 FRED 生效滞后护栏（isRateDecisionPending）——按兵不动须让位
import { describe, it, expect } from 'vitest';
import { isRateDecisionPending } from '../api/fetch-macro.js';

const TODAY = '2026-10-29';
const base = (o = {}) => ({
  rateDecisionDate: '2026-10-28', rateSource: 'fred',
  rateSteps: [{ date: '2026-09-17', diffBp: 25 }], ...o,
});
const prev = { fred_rate_prev: 3.75 };

describe('isRateDecisionPending', () => {
  it('决议后 FRED 未出新台阶、方向未知 → 护栏生效（防加息当晚误判暂停）', () => {
    expect(isRateDecisionPending({ macroData: base(), prevSnapshot: prev, today: TODAY })).toBe(true);
  });
  it('Fed 声明确认本次按兵不动 → 让位（10-28 实战：暂停被压回上次加息基线判 tight）', () => {
    const m = base({ fedDecisionAction: 'maintain', fedDecisionDate: '2026-10-28' });
    expect(isRateDecisionPending({ macroData: m, prevSnapshot: prev, today: TODAY })).toBe(false);
  });
  it('声明是上一次会议的按兵不动 → 不让位（日期须对上本次决议）', () => {
    const m = base({ fedDecisionAction: 'maintain', fedDecisionDate: '2026-09-16' });
    expect(isRateDecisionPending({ macroData: m, prevSnapshot: prev, today: TODAY })).toBe(true);
  });
  it('Fed 声明源已顶替（加息/降息）→ 让位（127号）', () => {
    expect(isRateDecisionPending({ macroData: base({ rateSource: 'fed_statement' }), prevSnapshot: prev, today: TODAY })).toBe(false);
  });
  it('FRED 已收录新台阶 / 超过 2 天 / 无上一快照基线 → 不生效', () => {
    expect(isRateDecisionPending({ macroData: base({ rateSteps: [{ date: '2026-10-29', diffBp: 25 }] }), prevSnapshot: prev, today: TODAY })).toBe(false);
    expect(isRateDecisionPending({ macroData: base(), prevSnapshot: prev, today: '2026-10-31' })).toBe(false);
    expect(isRateDecisionPending({ macroData: base(), prevSnapshot: {}, today: TODAY })).toBe(false);
  });
});
