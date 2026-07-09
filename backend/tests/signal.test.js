import { describe, it, expect } from 'vitest';
import {
  calcMonetarySignal, calcFinalSignal, deriveSubSignals, deriveBalanceSheetStatus,
  calcFiscalSignal, calcAdminSignal, deriveAiSupplySubSignals, calcAiSupplySignal,
  calcBubbleWarning,
} from '../api/signal.js';

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

// 资产负债表方向判断（独立函数，供 fetch-macro.js 复用展示状态）
describe('deriveBalanceSheetStatus', () => {
  it('扩张：变化 > 0.25% 视为 QE 扩张(loose)', () => {
    expect(deriveBalanceSheetStatus(7200, 7100)).toBe('loose');
  });

  it('收缩：变化 < -0.25% 视为 QT 收缩(tight)', () => {
    expect(deriveBalanceSheetStatus(7000, 7200)).toBe('tight');
  });

  it('暂停：变化幅度在 ±0.25% 内视为 neutral', () => {
    expect(deriveBalanceSheetStatus(7200, 7201)).toBe('neutral');
  });

  it('数据缺失时视为 neutral', () => {
    expect(deriveBalanceSheetStatus(null, 7200)).toBe('neutral');
    expect(deriveBalanceSheetStatus(7200, null)).toBe('neutral');
  });
});

// 财政信号：TTM赤字同比变化（阈值 ±5%）
describe('calcFiscalSignal', () => {
  it('宽松：赤字同比扩大超过阈值', () => {
    expect(calcFiscalSignal({ deficitTtmChangePct: 12.3 })).toBe('loose');
  });

  it('收紧：赤字同比收窄超过阈值', () => {
    expect(calcFiscalSignal({ deficitTtmChangePct: -8.1 })).toBe('tight');
  });

  it('观望：变化在阈值内', () => {
    expect(calcFiscalSignal({ deficitTtmChangePct: 3.2 })).toBe('neutral');
    expect(calcFiscalSignal({ deficitTtmChangePct: -4.9 })).toBe('neutral');
  });

  it('观望：恰好等于阈值（边界不触发）', () => {
    expect(calcFiscalSignal({ deficitTtmChangePct: 5 })).toBe('neutral');
    expect(calcFiscalSignal({ deficitTtmChangePct: -5 })).toBe('neutral');
  });

  it('观望：数据缺失', () => {
    expect(calcFiscalSignal({ deficitTtmChangePct: null })).toBe('neutral');
    expect(calcFiscalSignal({})).toBe('neutral');
  });
});

// 行政信号：贸易政策不确定性指数10年百分位（>80 tight，<50 loose）
describe('calcAdminSignal', () => {
  it('收紧：百分位 > 80', () => {
    expect(calcAdminSignal({ epuTradePercentile: 92.5 })).toBe('tight');
  });

  it('宽松：百分位 < 50', () => {
    expect(calcAdminSignal({ epuTradePercentile: 33 })).toBe('loose');
  });

  it('观望：百分位在 50~80 之间', () => {
    expect(calcAdminSignal({ epuTradePercentile: 65 })).toBe('neutral');
  });

  it('观望：恰好等于边界值', () => {
    expect(calcAdminSignal({ epuTradePercentile: 80 })).toBe('neutral');
    expect(calcAdminSignal({ epuTradePercentile: 50 })).toBe('neutral');
  });

  it('观望：数据缺失', () => {
    expect(calcAdminSignal({ epuTradePercentile: null })).toBe('neutral');
    expect(calcAdminSignal({})).toBe('neutral');
  });
});

// AI供需子信号（市场：SMH-SPY相对收益 ±8%；基本面：半导体IP同比 >5% / <0%）
describe('deriveAiSupplySubSignals', () => {
  it('市场子信号：相对收益 >+8% → loose，<-8% → tight，之间 → neutral', () => {
    expect(deriveAiSupplySubSignals({ smhSpyRelReturnPct: 12, semiIpYoy: null }).marketSignal).toBe('loose');
    expect(deriveAiSupplySubSignals({ smhSpyRelReturnPct: -10, semiIpYoy: null }).marketSignal).toBe('tight');
    expect(deriveAiSupplySubSignals({ smhSpyRelReturnPct: 3, semiIpYoy: null }).marketSignal).toBe('neutral');
  });

  it('基本面子信号：同比 >+5% → loose，<0% → tight，0~5% → neutral', () => {
    expect(deriveAiSupplySubSignals({ smhSpyRelReturnPct: null, semiIpYoy: 9.5 }).fundamentalSignal).toBe('loose');
    expect(deriveAiSupplySubSignals({ smhSpyRelReturnPct: null, semiIpYoy: -2.1 }).fundamentalSignal).toBe('tight');
    expect(deriveAiSupplySubSignals({ smhSpyRelReturnPct: null, semiIpYoy: 2.4 }).fundamentalSignal).toBe('neutral');
  });

  it('数据缺失的子信号为 neutral', () => {
    const subs = deriveAiSupplySubSignals({ smhSpyRelReturnPct: null, semiIpYoy: null });
    expect(subs.marketSignal).toBe('neutral');
    expect(subs.fundamentalSignal).toBe('neutral');
  });
});

// AI供需合成：两边都有数据要求一致；单边缺失用另一边；全缺失观望
describe('calcAiSupplySignal', () => {
  it('宽松：两个子信号都宽松', () => {
    expect(calcAiSupplySignal({ smhSpyRelReturnPct: 12, semiIpYoy: 8 })).toBe('loose');
  });

  it('收紧：两个子信号都收紧', () => {
    expect(calcAiSupplySignal({ smhSpyRelReturnPct: -15, semiIpYoy: -3 })).toBe('tight');
  });

  it('观望：市场宽松但基本面收紧（分歧）', () => {
    expect(calcAiSupplySignal({ smhSpyRelReturnPct: 12, semiIpYoy: -3 })).toBe('neutral');
  });

  it('观望：市场宽松但基本面观望（分歧）', () => {
    expect(calcAiSupplySignal({ smhSpyRelReturnPct: 12, semiIpYoy: 2 })).toBe('neutral');
  });

  it('单边缺失：市场数据缺失时采用基本面判定', () => {
    expect(calcAiSupplySignal({ smhSpyRelReturnPct: null, semiIpYoy: 8 })).toBe('loose');
    expect(calcAiSupplySignal({ smhSpyRelReturnPct: null, semiIpYoy: -3 })).toBe('tight');
  });

  it('单边缺失：基本面数据缺失时采用市场判定', () => {
    expect(calcAiSupplySignal({ smhSpyRelReturnPct: -15, semiIpYoy: null })).toBe('tight');
  });

  it('观望：数据全缺失', () => {
    expect(calcAiSupplySignal({ smhSpyRelReturnPct: null, semiIpYoy: null })).toBe('neutral');
  });
});

// AI泡沫预警（调用量趋势 < -10% 或 资本开支同比 < 0）
describe('calcBubbleWarning', () => {
  it('调用量趋势跌破阈值 → 预警', () => {
    expect(calcBubbleWarning({ modelUsageTrendPct: -12, capexYoY: 20 }))
      .toEqual({ warning: true, reasons: ['modelUsage'] });
  });

  it('资本开支同比转负 → 预警', () => {
    expect(calcBubbleWarning({ modelUsageTrendPct: 5, capexYoY: -5 }))
      .toEqual({ warning: true, reasons: ['capex'] });
  });

  it('双重预警', () => {
    expect(calcBubbleWarning({ modelUsageTrendPct: -20, capexYoY: -1 }))
      .toEqual({ warning: true, reasons: ['modelUsage', 'capex'] });
  });

  it('未跌破阈值不预警', () => {
    expect(calcBubbleWarning({ modelUsageTrendPct: -9, capexYoY: 3 }).warning).toBe(false);
  });

  it('数据缺失不预警（优雅降级）', () => {
    expect(calcBubbleWarning({ modelUsageTrendPct: null, capexYoY: null }).warning).toBe(false);
    expect(calcBubbleWarning({}).warning).toBe(false);
    expect(calcBubbleWarning().warning).toBe(false);
  });
});

// 泡沫预警对 AI供需信号的强制作用
describe('calcAiSupplySignal + bubble', () => {
  it('预警触发时即使双子信号宽松也强制收紧', () => {
    expect(calcAiSupplySignal(
      { smhSpyRelReturnPct: 12, semiIpYoy: 8 },
      { warning: true, reasons: ['capex'] }
    )).toBe('tight');
  });

  it('无预警时行为与不传 bubble 一致（回归）', () => {
    const data = { smhSpyRelReturnPct: 12, semiIpYoy: 8 };
    expect(calcAiSupplySignal(data, { warning: false, reasons: [] })).toBe(calcAiSupplySignal(data));
    expect(calcAiSupplySignal(data, null)).toBe('loose');
  });
});

// 决策树合成（四元：货币/财政/行政/AI供需）
describe('calcFinalSignal', () => {
  it('进攻：四个信号位全部宽松', () => {
    expect(calcFinalSignal('loose', 'loose', 'loose', 'loose')).toBe('attack');
  });

  it('防守：货币收紧', () => {
    expect(calcFinalSignal('tight', 'loose', 'loose', 'loose')).toBe('defense');
  });

  it('防守：财政收紧', () => {
    expect(calcFinalSignal('loose', 'tight', 'loose', 'loose')).toBe('defense');
  });

  it('防守：行政收紧', () => {
    expect(calcFinalSignal('loose', 'loose', 'tight', 'loose')).toBe('defense');
  });

  it('防守：仅AI供需收紧，其余三个宽松', () => {
    expect(calcFinalSignal('loose', 'loose', 'loose', 'tight')).toBe('defense');
  });

  it('防守：AI供需与货币同时收紧', () => {
    expect(calcFinalSignal('tight', 'loose', 'loose', 'tight')).toBe('defense');
  });

  it('防守：多个同时收紧', () => {
    expect(calcFinalSignal('tight', 'tight', 'tight', 'tight')).toBe('defense');
  });

  it('观望：货币宽松 财政观望 行政宽松 AI供需宽松（非全宽松）', () => {
    expect(calcFinalSignal('loose', 'neutral', 'loose', 'loose')).toBe('neutral');
  });

  it('观望：四个全观望', () => {
    expect(calcFinalSignal('neutral', 'neutral', 'neutral', 'neutral')).toBe('neutral');
  });

  it('观望：货币宽松 财政宽松 行政宽松 AI供需观望（非全宽松）', () => {
    expect(calcFinalSignal('loose', 'loose', 'loose', 'neutral')).toBe('neutral');
  });
});
