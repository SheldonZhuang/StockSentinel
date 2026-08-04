// 前后端阈值防漂移守卫（120号，2026-08-04）：前端组件在"后端子信号缺失时的本地回退"
// 与悬停提示/清单里硬编码了一批判定阈值（SignalHero 63/60、MacroPanel 80/50/±20/±3/10/0/0.5、
// S5Panel 55），此前仅靠"改后端时必须同步这里"的注释约定维持一致——姊妹项目曾因手抄
// 计算函数漂移出 554 处错误。本测试把 backend/config/signal.config.js 的当前值钉死为
// 前端硬编码所依据的快照：后端改阈值 → 本测试红灯 → 提示同步前端组件与 i18n 文案。
// （注意：本测试失败不代表后端错了，代表**前端需要跟着改**——同步后更新这里的期望值）
import { describe, it, expect } from 'vitest';
import cfg from '../../backend/config/signal.config.js';

// 前端硬编码位置备查：
//  SignalHero.vue attackChecklist（63/60）
//  MacroPanel.vue epuBadge(80/50)、oilBadge(±20)、sahm extra(0.5)、ycStatus(63)、
//                 modelUsageTrend 回退(±3)、capexYoY 回退(10/0)
//  S5Panel.vue / api/admin.js CAPE 层（55% 目标仓位）
//  i18n 7语言 hints/interpret 文案中的同名数字
const FRONTEND_SNAPSHOT = {
  YIELD_CURVE_INVERSION_CONFIRM_DAYS: 63,       // 窗口长度（120号 M2 起语义=窗口）
  YIELD_CURVE_INVERSION_MIN_INVERTED_DAYS: 51,  // 窗口内确认线（SignalHero/MacroPanel 用 51）
  CREDIT_SPREAD_ATTACK_VETO_WIDEN_BP: 60,
  REAL_RATE_ATTACK_VETO_PCT: 1.5,               // 120号① 第三否决器（SignalHero checklist 用 1.5）
  BALANCE_SHEET_PAUSE_THRESHOLD_PCT: 0.8,       // 120号 M1 13周窗口（hints.balanceSheet 文案用 0.8）
  BALANCE_SHEET_WINDOW_DAYS: 91,
  SAHM_TRIGGER_THRESHOLD: 0.5,
  EPU_PERCENTILE_TIGHT: 80,
  EPU_PERCENTILE_LOOSE: 50,
  OIL_SHOCK_PCT: 20,
  AI_MODEL_USAGE_LOOSE_PCT: 3,
  AI_MODEL_USAGE_DECLINE_THRESHOLD_PCT: -3,
  AI_CAPEX_YOY_LOOSE_PCT: 10,
  AI_CAPEX_YOY_TIGHT_PCT: 0,
};

describe('后端判定阈值 vs 前端硬编码快照（漂移即红灯）', () => {
  for (const [key, expected] of Object.entries(FRONTEND_SNAPSHOT)) {
    it(`${key} = ${expected}`, () => {
      expect(cfg[key]).toBe(expected);
    });
  }
});
