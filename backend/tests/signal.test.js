import { describe, it, expect } from 'vitest';
import {
  calcMonetarySignal, calcFinalSignal, deriveSubSignals, deriveBalanceSheetStatus,
  calcFiscalSignal, calcAdminSignal, deriveAiSupplySubSignals, calcAiSupplySignal,
  calcBubbleWarning, calcLockActive,
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

  it('观望：利率暂停 + QT收缩——QT只拦截宽松不定罪收紧（环境收紧≠危机信号）', () => {
    expect(calcMonetarySignal({
      currentRate: 4.25,
      prevRate: 4.25,
      currentBalanceSheet: 7000,
      prevBalanceSheet: 7200,
    })).toBe('neutral');
  });

  it('收紧：应对式加息 + QT 同时发生', () => {
    expect(calcMonetarySignal({
      currentRate: 4.75,
      prevRate: 4.25,
      currentBalanceSheet: 7000,
      prevBalanceSheet: 7200,
    })).toBe('tight');
  });

  it('收紧：任何加息（含小幅25bp）——加息=资金成本升高=利空', () => {
    expect(calcMonetarySignal({
      currentRate: 4.5,
      prevRate: 4.25,
      currentBalanceSheet: 7200,
      prevBalanceSheet: 7200,
    })).toBe('tight');
  });

  it('观望：小幅降息 + QT 同时发生（QT拦截宽松评级）', () => {
    expect(calcMonetarySignal({
      currentRate: 4.0,
      prevRate: 4.25,
      currentBalanceSheet: 7000,
      prevBalanceSheet: 7200,
    })).toBe('neutral');
  });

  it('收紧：渐进加息到高位（纯方向规则）——连续25bp加息全程收紧，不再误判宽松', () => {
    // 2023场景：本次仅25bp加息，但加息即收紧（覆盖"温水煮青蛙"）
    expect(calcMonetarySignal({
      currentRate: 5.5, prevRate: 5.25,
      currentBalanceSheet: 7200, prevBalanceSheet: 7200,
    })).toBe('tight');
  });
});

// 利率方向规则：任何加息→tight；降息/暂停→loose
describe('deriveSubSignals', () => {
  it('恰好 50bp 加息 → tight', () => {
    const { rateSignal } = deriveSubSignals({
      currentRate: 4.75, prevRate: 4.25,
      currentBalanceSheet: 7200, prevBalanceSheet: 7200,
    });
    expect(rateSignal).toBe('tight');
  });

  it('小幅加息（25bp）→ tight（加息即收紧，覆盖温水煮青蛙）', () => {
    const { rateSignal } = deriveSubSignals({
      currentRate: 4.5, prevRate: 4.25,
      currentBalanceSheet: 7200, prevBalanceSheet: 7200,
    });
    expect(rateSignal).toBe('tight');
  });

  it('小幅降息（49bp）→ loose', () => {
    const { rateSignal } = deriveSubSignals({
      currentRate: 3.76, prevRate: 4.25,
      currentBalanceSheet: 7200, prevBalanceSheet: 7200,
    });
    expect(rateSignal).toBe('loose');
  });

  it('利率暂停（Δ=0）→ loose', () => {
    const { rateSignal } = deriveSubSignals({
      currentRate: 4.25, prevRate: 4.25,
      currentBalanceSheet: 7200, prevBalanceSheet: 7200,
    });
    expect(rateSignal).toBe('loose');
  });

  it('大幅降息（50bp）→ loose（方向仍是宽松；应对式锁另在server层强制防守）', () => {
    const { rateSignal } = deriveSubSignals({
      currentRate: 3.75, prevRate: 4.25,
      currentBalanceSheet: 7200, prevBalanceSheet: 7200,
    });
    expect(rateSignal).toBe('loose');
  });

  it('利率数据缺失 → neutral', () => {
    const { rateSignal } = deriveSubSignals({
      currentRate: null, prevRate: null,
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

// 财政信号：TTM联邦支出同比变化（阈值 ±5%，"大市场小政府"：支出扩大=政府变大=收紧）
describe('calcFiscalSignal', () => {
  it('收紧：支出同比扩大超过阈值（政府变大）', () => {
    expect(calcFiscalSignal({ outlaysChangePct: 12.3 })).toBe('tight');
  });

  it('宽松：支出同比收缩超过阈值（政府瘦身）', () => {
    expect(calcFiscalSignal({ outlaysChangePct: -8.1 })).toBe('loose');
  });

  it('观望：变化在阈值内', () => {
    expect(calcFiscalSignal({ outlaysChangePct: 3.2 })).toBe('neutral');
    expect(calcFiscalSignal({ outlaysChangePct: -4.9 })).toBe('neutral');
  });

  it('观望：恰好等于阈值（边界不触发）', () => {
    expect(calcFiscalSignal({ outlaysChangePct: 5 })).toBe('neutral');
    expect(calcFiscalSignal({ outlaysChangePct: -5 })).toBe('neutral');
  });

  it('观望：数据缺失', () => {
    expect(calcFiscalSignal({ outlaysChangePct: null })).toBe('neutral');
    expect(calcFiscalSignal({})).toBe('neutral');
  });
});

// 行政信号：双代理（月度EPUTRADE + 日频EPU 7日均线）10年百分位，>80 tight / <50 loose，一致才定档
describe('calcAdminSignal', () => {
  it('单边（仅月度）：百分位 > 80 → 收紧', () => {
    expect(calcAdminSignal({ epuTradePercentile: 92.5 })).toBe('tight');
  });

  it('单边（仅月度）：百分位 < 50 → 宽松', () => {
    expect(calcAdminSignal({ epuTradePercentile: 33 })).toBe('loose');
  });

  it('单边（仅日频）：百分位 < 50 → 宽松（月度缺失用可用侧）', () => {
    expect(calcAdminSignal({ epuTradePercentile: null, epuDailyPercentile: 30 })).toBe('loose');
  });

  it('双边一致 → 定档', () => {
    expect(calcAdminSignal({ epuTradePercentile: 92, epuDailyPercentile: 88 })).toBe('tight');
    expect(calcAdminSignal({ epuTradePercentile: 30, epuDailyPercentile: 20 })).toBe('loose');
  });

  it('双边不一致 → 观望（月度仍高压但日频已回落=政策转向初期）', () => {
    expect(calcAdminSignal({ epuTradePercentile: 92, epuDailyPercentile: 40 })).toBe('neutral');
    expect(calcAdminSignal({ epuTradePercentile: 30, epuDailyPercentile: 90 })).toBe('neutral');
  });

  it('观望：百分位在 50~80 之间', () => {
    expect(calcAdminSignal({ epuTradePercentile: 65 })).toBe('neutral');
  });

  it('观望：恰好等于边界值', () => {
    expect(calcAdminSignal({ epuTradePercentile: 80 })).toBe('neutral');
    expect(calcAdminSignal({ epuTradePercentile: 50 })).toBe('neutral');
  });

  it('观望：数据全缺失', () => {
    expect(calcAdminSignal({ epuTradePercentile: null, epuDailyPercentile: null })).toBe('neutral');
    expect(calcAdminSignal({})).toBe('neutral');
  });

  // 油价事件层：飙升侧对称护栏（修复#5）——区分战争冲击 vs 需求复苏
  it('油价+20%且EPU高位（战争/供给冲击）→ 收紧', () => {
    expect(calcAdminSignal({ epuTradePercentile: 92, epuDailyPercentile: 90, oilChange30dPct: 25 })).toBe('tight');
  });

  it('油价+20%但EPU平静（需求复苏，如2009/2016/2020V型底）→ 不误判防守，落回EPU判定为宽松', () => {
    // 修复前：油价飙升无条件tight，会在最佳买点误判防守。修复后：EPU平静→需求信号→落回EPU(低位=loose)
    expect(calcAdminSignal({ epuTradePercentile: 30, epuDailyPercentile: 20, oilChange30dPct: 25 })).toBe('loose');
  });

  it('油价+20%且EPU中性 → 落回EPU判定为neutral', () => {
    expect(calcAdminSignal({ epuTradePercentile: 65, epuDailyPercentile: 60, oilChange30dPct: 25 })).toBe('neutral');
  });

  it('油价30天-20%以上（战争结束/对抗降级）→ 立即宽松：日频EPU未处高位时', () => {
    // 月度92滞后高位，但日频已回落到40 → 缓和型暴跌 → 宽松（月度指数滞后不挡）
    expect(calcAdminSignal({ epuTradePercentile: 92, epuDailyPercentile: 40, oilChange30dPct: -24 })).toBe('loose');
  });

  it('油价暴跌但日频EPU仍处高位（>80）→ 危机需求型暴跌，不判宽松，回落EPU判定', () => {
    // 2025-04关税战场景：油价因需求恐慌暴跌，EPU同时飙升 → 双高位一致 → 收紧
    expect(calcAdminSignal({ epuTradePercentile: 95, epuDailyPercentile: 96, oilChange30dPct: -24 })).toBe('tight');
  });

  it('油价暴跌且日频缺失时用月度做护栏', () => {
    // 月度高位 → 不判宽松，回落单边月度 → 收紧
    expect(calcAdminSignal({ epuTradePercentile: 92, epuDailyPercentile: null, oilChange30dPct: -24 })).toBe('tight');
    // 月度低位 → 缓和型 → 宽松
    expect(calcAdminSignal({ epuTradePercentile: 30, epuDailyPercentile: null, oilChange30dPct: -24 })).toBe('loose');
  });

  it('油价暴跌但EPU双路全缺失 → 护栏fail-closed，不判宽松（危机日常伴数据故障）', () => {
    // 无法区分缓和型vs危机需求型暴跌 → 不走宽松，回落EPU判定（全缺→观望）
    expect(calcAdminSignal({ epuTradePercentile: null, epuDailyPercentile: null, oilChange30dPct: -24 })).toBe('neutral');
    expect(calcAdminSignal({ oilChange30dPct: -30 })).toBe('neutral');
  });

  it('油价波动在±20%以内 → 回落到EPU双代理判定', () => {
    expect(calcAdminSignal({ epuTradePercentile: 92, epuDailyPercentile: 88, oilChange30dPct: 5 })).toBe('tight');
    expect(calcAdminSignal({ epuTradePercentile: 30, epuDailyPercentile: 20, oilChange30dPct: -10 })).toBe('loose');
  });

  it('油价缺失 → EPU双代理判定不受影响', () => {
    expect(calcAdminSignal({ epuTradePercentile: 92, epuDailyPercentile: 88, oilChange30dPct: null })).toBe('tight');
  });
});

// AI供需子信号（市场：SMH-SPY相对收益 ±8%；基本面：半导体IP同比 >5% / <0%）
describe('deriveAiSupplySubSignals', () => {
  it('市场子信号：相对收益 >+8% → loose，<-8% → tight，之间 → neutral', () => {
    expect(deriveAiSupplySubSignals({ smhSpyRelReturnPct: 12, semiIpYoy: null }).marketSignal).toBe('loose');
    expect(deriveAiSupplySubSignals({ smhSpyRelReturnPct: -10, semiIpYoy: null }).marketSignal).toBe('tight');
    expect(deriveAiSupplySubSignals({ smhSpyRelReturnPct: 3, semiIpYoy: null }).marketSignal).toBe('neutral');
  });

  it('供不应求越极端越宽松（无过热截断）：相对收益+30%仍是loose', () => {
    // 用户框架：供不应求=宽松不封顶；防守靠"供过于求(长线转弱)+货币收紧"双维共振
    expect(deriveAiSupplySubSignals({ smhSpyRelReturnPct: 30, semiIpYoy: null }).marketSignal).toBe('loose');
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

// 决策树合成（四元，参数顺序=策略主线：AI供需/货币/财政/行政）
describe('calcFinalSignal', () => {
  it('进攻：四个信号位全部宽松', () => {
    expect(calcFinalSignal('loose', 'loose', 'loose', 'loose')).toBe('attack');
  });

  it('减仓观望：仅货币收紧（单维=噪声容忍）', () => {
    expect(calcFinalSignal('loose', 'tight', 'loose', 'loose')).toBe('reduce');
  });

  it('减仓观望：仅财政收紧', () => {
    expect(calcFinalSignal('loose', 'loose', 'tight', 'loose')).toBe('reduce');
  });

  it('减仓观望：仅行政收紧', () => {
    expect(calcFinalSignal('loose', 'loose', 'loose', 'tight')).toBe('reduce');
  });

  it('减仓观望：仅AI供需收紧，其余三个宽松', () => {
    expect(calcFinalSignal('tight', 'loose', 'loose', 'loose')).toBe('reduce');
  });

  it('全面防守：AI供需与货币双维共振收紧', () => {
    expect(calcFinalSignal('tight', 'tight', 'loose', 'loose')).toBe('defense');
  });

  it('全面防守：多个同时收紧', () => {
    expect(calcFinalSignal('tight', 'tight', 'tight', 'tight')).toBe('defense');
  });

  it('观望：AI供需宽松 货币宽松 财政观望 行政宽松（非全宽松）', () => {
    expect(calcFinalSignal('loose', 'loose', 'neutral', 'loose')).toBe('neutral');
  });

  it('观望：四个全观望', () => {
    expect(calcFinalSignal('neutral', 'neutral', 'neutral', 'neutral')).toBe('neutral');
  });

  it('观望：AI供需观望 其余三个宽松（非全宽松）', () => {
    expect(calcFinalSignal('neutral', 'loose', 'loose', 'loose')).toBe('neutral');
  });
});

// 衰退防守锁定判定：萨姆锁/应对式调整锁复用同一套判定逻辑
describe('calcLockActive', () => {
  it('触发进入锁定：萨姆值超阈值', () => {
    expect(calcLockActive({
      triggerToday: true, rateDiffBp: 0, currentRate: 4.25, prevLockActive: false,
    })).toBe(true);
  });

  it('触发进入锁定：大幅加息', () => {
    expect(calcLockActive({
      triggerToday: true, rateDiffBp: 75, currentRate: 5.0, prevLockActive: false,
    })).toBe(true);
  });

  it('触发进入锁定：大幅降息', () => {
    expect(calcLockActive({
      triggerToday: true, rateDiffBp: -75, currentRate: 3.5, prevLockActive: false,
    })).toBe(true);
  });

  it('锁定期间维持：触发条件当天不满足，但 prevLockActive 为真', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: 0, currentRate: 4.0, prevLockActive: true,
    })).toBe(true);
  });

  it('零利率解锁：currentRate <= 0.25 时无论其他条件如何都解锁', () => {
    expect(calcLockActive({
      triggerToday: true, rateDiffBp: 60, currentRate: 0.25, prevLockActive: true,
    })).toBe(false);
  });

  it('小幅调整解锁：非零且<50bp 的降息', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: -25, currentRate: 3.0, prevLockActive: true,
    })).toBe(false);
  });

  it('小幅调整解锁：非零且<50bp 的加息（不限方向）', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: 25, currentRate: 3.5, prevLockActive: true,
    })).toBe(false);
  });

  it('rateDiffBp === 0（无决议日/暂停决议）不解锁，锁定持续', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: 0, currentRate: 3.5, prevLockActive: true,
    })).toBe(true);
  });

  it('触发优先于小幅调整解锁：萨姆仍触发时25bp微调不解锁（避免单日解锁次日重锁翻转）', () => {
    expect(calcLockActive({
      triggerToday: true, rateDiffBp: 25, currentRate: 3.5, prevLockActive: false,
    })).toBe(true);
  });

  it('小幅调整解锁：触发条件已消失（如萨姆回落<0.5）时25bp微调解锁', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: 25, currentRate: 3.5, prevLockActive: true,
    })).toBe(false);
  });

  it('解锁优先级：触发条件和零利率解锁同天满足时，解锁生效', () => {
    expect(calcLockActive({
      triggerToday: true, rateDiffBp: -60, currentRate: 0.25, prevLockActive: false,
    })).toBe(false);
  });

  it('数据缺失：currentRate 为 null 时零利率解锁不生效', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: 0, currentRate: null, prevLockActive: true,
    })).toBe(true);
  });

  it('数据缺失：rateDiffBp 为 null 时小幅调整解锁不生效', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: null, currentRate: 3.5, prevLockActive: true,
    })).toBe(true);
  });

  it('无锁定、无触发、无解锁 → 保持未锁定', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: 0, currentRate: 4.25, prevLockActive: false,
    })).toBe(false);
  });
});
