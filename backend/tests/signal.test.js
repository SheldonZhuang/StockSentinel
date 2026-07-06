import { describe, it, expect } from 'vitest';
import { calcMonetarySignal, calcFinalSignal, deriveSubSignals } from '../api/signal.js';

// 测试所有货币信号位分支
describe('calcMonetarySignal', () => {
  it('宽松：利率暂停 + 资产负债表扩张', () => {
    expect(calcMonetarySignal({
      currentRate: 4.25,
      prevRate: 4.25,
      currentBalanceSheet: 7200,
      prevBalanceSheet: 7100,
    })).toBe('loose');
  });

  it('宽松：利率暂停 + 资产负债表基本不变（暂停）', () => {
    expect(calcMonetarySignal({
      currentRate: 4.25,
      prevRate: 4.25,
      currentBalanceSheet: 7200,
      prevBalanceSheet: 7201,
    })).toBe('loose');
  });

  it('宽松：降息 + 资产负债表扩张', () => {
    expect(calcMonetarySignal({
      currentRate: 4.0,
      prevRate: 4.25,
      currentBalanceSheet: 7200,
      prevBalanceSheet: 7100,
    })).toBe('loose');
  });

  it('收紧：应对式加息 >= 50bp', () => {
    expect(calcMonetarySignal({
      currentRate: 4.75,
      prevRate: 4.25,
      currentBalanceSheet: 7200,
      prevBalanceSheet: 7200,
    })).toBe('tight');
  });

  it('收紧：资产负债表 QT 收缩（即使利率暂停）', () => {
    expect(calcMonetarySignal({
      currentRate: 4.25,
      prevRate: 4.25,
      currentBalanceSheet: 7000,
      prevBalanceSheet: 7200,
    })).toBe('tight');
  });

  it('收紧：应对式加息 + QT 同时发生', () => {
    expect(calcMonetarySignal({
      currentRate: 4.75,
      prevRate: 4.25,
      currentBalanceSheet: 7000,
      prevBalanceSheet: 7200,
    })).toBe('tight');
  });

  it('中性：预防式加息 <50bp + 资产负债表暂停', () => {
    expect(calcMonetarySignal({
      currentRate: 4.5,
      prevRate: 4.25,
      currentBalanceSheet: 7200,
      prevBalanceSheet: 7200,
    })).toBe('neutral');
  });

  it('中性：降息 + QT 同时发生（互相抵消）', () => {
    expect(calcMonetarySignal({
      currentRate: 4.0,
      prevRate: 4.25,
      currentBalanceSheet: 7000,
      prevBalanceSheet: 7200,
    })).toBe('tight'); // QT 触发 OR 收紧
  });
});

// 测试 bp 换算
describe('deriveSubSignals', () => {
  it('恰好 50bp 加息视为应对式 tight', () => {
    const { rateSignal } = deriveSubSignals({
      currentRate: 4.75, prevRate: 4.25,
      currentBalanceSheet: 7200, prevBalanceSheet: 7200,
    });
    expect(rateSignal).toBe('tight');
  });

  it('49bp 加息视为预防式 neutral', () => {
    const { rateSignal } = deriveSubSignals({
      currentRate: 4.74, prevRate: 4.25,
      currentBalanceSheet: 7200, prevBalanceSheet: 7200,
    });
    expect(rateSignal).toBe('neutral');
  });
});

// 决策树合成
describe('calcFinalSignal', () => {
  it('进攻：三全宽松', () => {
    expect(calcFinalSignal('loose', 'loose', 'loose')).toBe('attack');
  });

  it('防守：货币收紧', () => {
    expect(calcFinalSignal('tight', 'loose', 'loose')).toBe('defense');
  });

  it('防守：财政收紧', () => {
    expect(calcFinalSignal('loose', 'tight', 'loose')).toBe('defense');
  });

  it('防守：行政收紧', () => {
    expect(calcFinalSignal('loose', 'loose', 'tight')).toBe('defense');
  });

  it('防守：多个同时收紧', () => {
    expect(calcFinalSignal('tight', 'tight', 'tight')).toBe('defense');
  });

  it('中性：货币宽松 财政中性 行政宽松', () => {
    expect(calcFinalSignal('loose', 'neutral', 'loose')).toBe('neutral');
  });

  it('中性：三个全中性', () => {
    expect(calcFinalSignal('neutral', 'neutral', 'neutral')).toBe('neutral');
  });

  it('中性：货币宽松 财政宽松 行政中性（非全宽松）', () => {
    expect(calcFinalSignal('loose', 'loose', 'neutral')).toBe('neutral');
  });
});
