import { describe, it, expect } from 'vitest';
import {
  calcMonetarySignal, calcFinalSignal, deriveSubSignals, deriveBalanceSheetStatus,
  calcFiscalSignal, calcAdminSignal, deriveAiSupplySubSignals, calcAiSupplySignal,
  calcLockActive,
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
  it('调用量子信号：>+10% loose，<-10% tight，之间 neutral', () => {
    expect(deriveAiSupplySubSignals({ modelUsageTrendPct: 15 }).usageSignal).toBe('loose');
    expect(deriveAiSupplySubSignals({ modelUsageTrendPct: -12 }).usageSignal).toBe('tight');
    expect(deriveAiSupplySubSignals({ modelUsageTrendPct: 3 }).usageSignal).toBe('neutral');
  });

  it('capex子信号：>+10% loose，<0% tight，0~10% neutral', () => {
    expect(deriveAiSupplySubSignals({ capexYoY: 25 }).capexSignal).toBe('loose');
    expect(deriveAiSupplySubSignals({ capexYoY: -5 }).capexSignal).toBe('tight');
    expect(deriveAiSupplySubSignals({ capexYoY: 5 }).capexSignal).toBe('neutral');
  });

  it('半导体产出子信号：>+5% loose，<0% tight，0~5% neutral', () => {
    expect(deriveAiSupplySubSignals({ semiIpYoy: 9.5 }).semiSignal).toBe('loose');
    expect(deriveAiSupplySubSignals({ semiIpYoy: -2.1 }).semiSignal).toBe('tight');
    expect(deriveAiSupplySubSignals({ semiIpYoy: 2.4 }).semiSignal).toBe('neutral');
  });

  it('数据缺失的子信号为 null（区别于 neutral）', () => {
    const subs = deriveAiSupplySubSignals({});
    expect(subs.usageSignal).toBe(null);
    expect(subs.capexSignal).toBe(null);
    expect(subs.semiSignal).toBe(null);
  });
});

// AI供需合成：任一环节收缩=收紧(供过于求)；全链一致宽松=宽松(供不应求)；其余中性；全缺中性
describe('calcAiSupplySignal', () => {
  it('宽松：三件套全部宽松（全链供不应求）', () => {
    expect(calcAiSupplySignal({ modelUsageTrendPct: 15, capexYoY: 25, semiIpYoy: 8 })).toBe('loose');
  });

  it('收紧：任一环节收缩（供过于求，用户框架"下降→尽快防守"）', () => {
    expect(calcAiSupplySignal({ modelUsageTrendPct: 15, capexYoY: -5, semiIpYoy: 8 })).toBe('tight');
    expect(calcAiSupplySignal({ modelUsageTrendPct: -20, capexYoY: 25, semiIpYoy: 8 })).toBe('tight');
  });

  it('观望：部分宽松部分中性（未全链一致）', () => {
    expect(calcAiSupplySignal({ modelUsageTrendPct: 15, capexYoY: 5, semiIpYoy: 8 })).toBe('neutral');
  });

  it('单/双件套可用：有数据的子信号一致才定档', () => {
    expect(calcAiSupplySignal({ semiIpYoy: 8 })).toBe('loose');
    expect(calcAiSupplySignal({ capexYoY: -5 })).toBe('tight');
    expect(calcAiSupplySignal({ modelUsageTrendPct: 15, semiIpYoy: 2 })).toBe('neutral');
  });

  it('全缺失 → 中性', () => {
    expect(calcAiSupplySignal({})).toBe('neutral');
  });
});

describe('calcFinalSignal 进攻档(非对称)', () => {
  it('进攻：AI供需宽松 + 政策三维全中性', () => {
    expect(calcFinalSignal('loose', 'neutral', 'neutral', 'neutral')).toBe('attack');
  });

  it('进攻：AI供需宽松 + 政策三维全宽松', () => {
    expect(calcFinalSignal('loose', 'loose', 'loose', 'loose')).toBe('attack');
  });

  it('进攻：AI供需宽松 + 货币宽松其余中性', () => {
    expect(calcFinalSignal('loose', 'loose', 'neutral', 'neutral')).toBe('attack');
  });

  it('非进攻：AI供需中性(引擎未发动)→观望', () => {
    expect(calcFinalSignal('neutral', 'loose', 'loose', 'loose')).toBe('neutral');
  });

  it('非进攻：AI供需宽松但行政收紧(贸易战)→减仓，不抢跑', () => {
    expect(calcFinalSignal('loose', 'neutral', 'neutral', 'tight')).toBe('reduce');
  });
});

// 决策树合成（四元，参数顺序=策略主线：AI供需/货币/财政/行政）
describe('calcFinalSignal', () => {
  it('进攻：AI供需宽松 + 政策三维全宽松', () => {
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

  it('进攻：AI供需宽松 + 政策三维不收紧（财政中性也进攻，非对称门槛）', () => {
    expect(calcFinalSignal('loose', 'loose', 'neutral', 'loose')).toBe('attack');
  });

  it('观望：四个全观望', () => {
    expect(calcFinalSignal('neutral', 'neutral', 'neutral', 'neutral')).toBe('neutral');
  });

  it('观望：AI供需观望 其余三个宽松（引擎未发动，不进攻）', () => {
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
