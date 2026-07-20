import { describe, it, expect } from 'vitest';
import {
  calcMonetarySignal, calcFinalSignal, deriveSubSignals, deriveBalanceSheetStatus,
  calcFiscalSignal, calcAdminSignal, deriveAiSupplySubSignals, calcAiSupplySignal,
  calcLockActive, applyYieldCurveVeto, applyDowngradeHold, calcTrendState, applyTrendReentry,
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

  // capex 单季侦察兵规则 N1/N2（2026-07-20 用户拍板）
  describe('capex单季侦察兵规则', () => {
    it('N1 拦截宽松：TTM达宽松线但单季<0 → 降为 neutral', () => {
      expect(deriveAiSupplySubSignals({ capexYoY: 25, capexQtrYoY: -3 }).capexSignal).toBe('neutral');
    });

    it('N1 只拦截宽松：TTM本就 neutral/tight 时单季<0 不改变结果', () => {
      expect(deriveAiSupplySubSignals({ capexYoY: 5, capexQtrYoY: -3 }).capexSignal).toBe('neutral');
      expect(deriveAiSupplySubSignals({ capexYoY: -5, capexQtrYoY: -3 }).capexSignal).toBe('tight');
    });

    it('N2 两季连负 → 直接 tight，即使TTM仍达宽松线', () => {
      expect(deriveAiSupplySubSignals({ capexYoY: 25, capexQtrYoY: -3, capexQtrPrevQtrYoY: -1 }).capexSignal).toBe('tight');
    });

    it('仅当季负、上季正 → 只触发N1不触发N2', () => {
      expect(deriveAiSupplySubSignals({ capexYoY: 25, capexQtrYoY: -3, capexQtrPrevQtrYoY: 2 }).capexSignal).toBe('neutral');
    });

    it('上季负但当季已回正 → 两规则均不触发（TTM口径原样）', () => {
      expect(deriveAiSupplySubSignals({ capexYoY: 25, capexQtrYoY: 4, capexQtrPrevQtrYoY: -1 }).capexSignal).toBe('loose');
    });

    it('单季数据缺失 → 规则不触发，退回纯TTM口径', () => {
      expect(deriveAiSupplySubSignals({ capexYoY: 25 }).capexSignal).toBe('loose');
      expect(deriveAiSupplySubSignals({ capexYoY: 25, capexQtrYoY: null, capexQtrPrevQtrYoY: null }).capexSignal).toBe('loose');
      // 当季负但上季缺失 → N2 不触发（缺数据不推断连续性），N1 仍生效
      expect(deriveAiSupplySubSignals({ capexYoY: 25, capexQtrYoY: -3, capexQtrPrevQtrYoY: null }).capexSignal).toBe('neutral');
    });

    it('N2 传导到维度合成：两季连负单独把AI供需拖成 tight', () => {
      expect(calcAiSupplySignal({ modelUsageTrendPct: 15, capexYoY: 25, semiIpYoy: 8, capexQtrYoY: -3, capexQtrPrevQtrYoY: -1 })).toBe('tight');
    });

    it('N1 传导到维度合成：拦截宽松使全链一致性破缺 → neutral', () => {
      expect(calcAiSupplySignal({ modelUsageTrendPct: 15, capexYoY: 25, semiIpYoy: 8, capexQtrYoY: -3 })).toBe('neutral');
    });
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

  it('X3(2026-07-18)：纯"货币+财政"双维共振降为 reduce（防守共振须含行政维或锁）', () => {
    expect(calcFinalSignal('loose', 'tight', 'tight', 'loose')).toBe('reduce');
    expect(calcFinalSignal('neutral', 'tight', 'tight', 'neutral')).toBe('reduce');
  });

  it('X3边界：行政参与或AI参与的双维共振仍是 defense；三维共振仍是 defense', () => {
    expect(calcFinalSignal('loose', 'tight', 'loose', 'tight')).toBe('defense');
    expect(calcFinalSignal('loose', 'loose', 'tight', 'tight')).toBe('defense');
    expect(calcFinalSignal('tight', 'loose', 'tight', 'loose')).toBe('defense');
    expect(calcFinalSignal('loose', 'tight', 'tight', 'tight')).toBe('defense');
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

describe('applyYieldCurveVeto（曲线倒挂≥3个月否决进攻档准入）', () => {
  it('attack + 倒挂≥63交易日 → 降级 neutral', () => {
    expect(applyYieldCurveVeto('attack', 63)).toBe('neutral');
    expect(applyYieldCurveVeto('attack', 120)).toBe('neutral');
  });

  it('attack + 倒挂未达确认期 → 保持 attack', () => {
    expect(applyYieldCurveVeto('attack', 0)).toBe('attack');
    expect(applyYieldCurveVeto('attack', 62)).toBe('attack');
  });

  it('数据缺失 fail-open：不否决', () => {
    expect(applyYieldCurveVeto('attack', null)).toBe('attack');
    expect(applyYieldCurveVeto('attack', undefined)).toBe('attack');
  });

  it('只作用于 attack：其他档位原样通过（不触发防守、不做锁）', () => {
    expect(applyYieldCurveVeto('defense', 200)).toBe('defense');
    expect(applyYieldCurveVeto('reduce', 200)).toBe('reduce');
    expect(applyYieldCurveVeto('neutral', 200)).toBe('neutral');
  });
});

describe('calcLockActive 最短锁存期（V3，2026-07-17采纳）', () => {
  it('锁龄不足60天：小幅调整不解锁（拦住2007-10场景：-50bp锁定次月-25bp跟进）', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: -25, currentRate: 4.25, prevLockActive: true, lockAgeDays: 30,
    })).toBe(true);
  });

  it('锁龄满60天：小幅调整正常解锁', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: -25, currentRate: 4.25, prevLockActive: true, lockAgeDays: 60,
    })).toBe(false);
  });

  it('零利率解锁不受锁存期限制', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: 0, currentRate: 0.25, prevLockActive: true, lockAgeDays: 5,
    })).toBe(false);
  });

  it('锁龄未知（旧快照无锁存日期）：fail-open 兼容旧行为', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: -25, currentRate: 4.25, prevLockActive: true, lockAgeDays: null,
    })).toBe(false);
  });
});

describe('applyDowngradeHold 降档迟滞（V4，2026-07-17采纳）', () => {
  it('升档即时生效并清空等待（锁强制defense不受迟滞影响）', () => {
    expect(applyDowngradeHold('defense', 'reduce', '2026-07-01', '2026-07-10'))
      .toEqual({ signal: 'defense', pendingSince: null });
  });

  it('持平：直接生效，清空等待', () => {
    expect(applyDowngradeHold('reduce', 'reduce', null, '2026-07-10'))
      .toEqual({ signal: 'reduce', pendingSince: null });
  });

  it('降档开始等待：沿用上一档，记录起始日', () => {
    expect(applyDowngradeHold('reduce', 'defense', null, '2026-07-10'))
      .toEqual({ signal: 'defense', pendingSince: '2026-07-10' });
  });

  it('确认期内（<30天）继续沿用上一档', () => {
    expect(applyDowngradeHold('reduce', 'defense', '2026-07-01', '2026-07-15'))
      .toEqual({ signal: 'defense', pendingSince: '2026-07-01' });
  });

  it('确认期满（≥30天）降档生效（2019-12场景在月度回测中被此机制拦住）', () => {
    expect(applyDowngradeHold('reduce', 'defense', '2026-06-10', '2026-07-10'))
      .toEqual({ signal: 'reduce', pendingSince: null });
  });

  it('等待期间候选反弹回升档：即时生效并清空等待', () => {
    expect(applyDowngradeHold('defense', 'defense', '2026-07-01', '2026-07-05'))
      .toEqual({ signal: 'defense', pendingSince: null });
  });

  it('无历史（首次运行）：候选直接生效', () => {
    expect(applyDowngradeHold('neutral', null, null, '2026-07-10'))
      .toEqual({ signal: 'neutral', pendingSince: null });
  });
});

describe('calcTrendState / applyTrendReentry（W5趋势再入场，2026-07-17采纳）', () => {
  const mkBars = (months, lastClose) => {
    // 每月两根：月中100x、月末给定值；最后一个月只有"进行中"的最新收盘
    const bars = [];
    months.forEach(([ym, close]) => {
      bars.push({ date: `${ym}-10`, close: close - 1 });
      bars.push({ date: `${ym}-28`, close });
    });
    return bars.concat(lastClose ? [{ date: '2026-07-10', close: lastClose }] : []);
  };
  const tenMonths = v => Array.from({ length: 10 }, (_, i) => [`2025-${String(i + 9).padStart(2, '0')}`, v])
    .map(([ym, c], i) => [i < 4 ? `2025-${String(9 + i).padStart(2, '0')}` : `2026-0${i - 3}`, c]);

  it('最新收盘≥10月SMA → aboveSma10=true；月末收盘取每月最后一根', () => {
    const s = calcTrendState(mkBars(tenMonths(100), 120));
    expect(s.spxClose).toBe(120);
    expect(s.spxAboveSma10).toBe(true); // SMA含当月(120)：(9*100+120)/10=102，120≥102
  });

  it('最新收盘跌破SMA → aboveSma10=false', () => {
    const s = calcTrendState(mkBars(tenMonths(100), 80));
    expect(s.spxAboveSma10).toBe(false); // SMA=(9*100+80)/10=98，80<98
  });

  it('不足10个月 → 全null（fail-open）', () => {
    const s = calcTrendState([{ date: '2026-07-01', close: 100 }]);
    expect(s.spxMa10m).toBeNull();
    expect(s.spxAboveSma10).toBeNull();
    expect(calcTrendState([]).spxClose).toBeNull();
    expect(calcTrendState(null).spxAboveSma10).toBeNull();
  });

  it('树驱动defense + 趋势向上 → 降级reduce', () => {
    expect(applyTrendReentry('defense', { sahmLockActive: false, reactiveLockActive: false, spxAboveSma10: true })).toBe('reduce');
  });

  it('锁驱动defense不受趋势否决（锁=确证的危机应对）', () => {
    expect(applyTrendReentry('defense', { sahmLockActive: false, reactiveLockActive: true, spxAboveSma10: true })).toBe('defense');
    // X1(2026-07-18)：萨姆锁驱动的defense也过趋势门（2024-08移民失真误触发归因）
    expect(applyTrendReentry('defense', { sahmLockActive: true, reactiveLockActive: false, spxAboveSma10: true })).toBe('reduce');
    // 双锁并存：应对式锁在场即豁免
    expect(applyTrendReentry('defense', { sahmLockActive: true, reactiveLockActive: true, spxAboveSma10: true })).toBe('defense');
  });

  it('趋势向下或未知 → 不降级（fail-open）', () => {
    expect(applyTrendReentry('defense', { sahmLockActive: false, reactiveLockActive: false, spxAboveSma10: false })).toBe('defense');
    expect(applyTrendReentry('defense', { sahmLockActive: false, reactiveLockActive: false, spxAboveSma10: null })).toBe('defense');
    expect(applyTrendReentry('defense', { sahmLockActive: true, reactiveLockActive: false, spxAboveSma10: false })).toBe('defense');
  });

  it('非defense档原样通过', () => {
    expect(applyTrendReentry('reduce', { sahmLockActive: false, reactiveLockActive: false, spxAboveSma10: true })).toBe('reduce');
    expect(applyTrendReentry('attack', { sahmLockActive: false, reactiveLockActive: false, spxAboveSma10: true })).toBe('attack');
  });
});

describe('calcAdminSignal 油价水平护栏（O1，2026-07-19采纳）', () => {
  it('高位飙升+EPU高位（俄乌型）→ tight 不受影响', () => {
    expect(calcAdminSignal({ epuTradePercentile: 92, epuDailyPercentile: 90, oilChange30dPct: 25, oilLevelLow: false })).toBe('tight');
  });

  it('低位反弹+EPU高位（2009-03型危机后复苏）→ 不判战争冲击，落回EPU双代理判定', () => {
    // 修复前此场景误判tight踏空V型底-17.5pp；修复后落回EPU判定（双高位→tight仍可能，
    // 但飙升快速通道被关闭——此处EPU双代理一致高位仍为tight属EPU自身判定）
    expect(calcAdminSignal({ epuTradePercentile: 92, epuDailyPercentile: 94, oilChange30dPct: 25, oilLevelLow: true })).toBe('tight');
    // EPU不一致时（日频回落）：修复前飙升通道仍judge tight，修复后正确回到"不一致→观望"
    expect(calcAdminSignal({ epuTradePercentile: 92, epuDailyPercentile: 60, oilChange30dPct: 25, oilLevelLow: true })).toBe('neutral');
  });

  it('油价水平未知（null）→ fail-open 保持旧行为', () => {
    expect(calcAdminSignal({ epuTradePercentile: 92, epuDailyPercentile: 90, oilChange30dPct: 25, oilLevelLow: null })).toBe('tight');
    expect(calcAdminSignal({ epuTradePercentile: 92, epuDailyPercentile: 90, oilChange30dPct: 25 })).toBe('tight');
  });

  it('暴跌侧不受水平护栏影响', () => {
    expect(calcAdminSignal({ epuTradePercentile: 30, epuDailyPercentile: 20, oilChange30dPct: -25, oilLevelLow: true })).toBe('loose');
  });
});
