// 月度回测内联判定 vs 线上 calc* 函数的漂移测试（116号收尾项，2026-07-30）：
// replayMonth 为性能/输入形态原因内联复刻了货币/资产负债表/财政/行政四维判定，
// 双实现漂移（线上改了、月度头条数字默默停在旧规则）是 O1 事件的既往剧本。
// 本测试把同一输入喂给两边、在共享语义域逐位对比——漂移直接红灯。
//
// 已知且合法的口径差（不在对比域）：
//  - 货币 prevRate：月度=上月末值（月度差分近似）；线上=FOMC决议前值。对比时直接喂同一对
//    (rate, prevRate)，只验证"差值→方向"的映射一致。
//  - 行政 EPU：月度只有 EPUTRADE 单代理；线上双代理。对比时线上 epuDailyPercentile=null
//    （单边缺失用可用侧，语义等价单代理）。
//  - 油价水平护栏 O1：月度基线关（月度口径下结构性冗余，--eval-oil 已实证逐位无变化）；
//    对比时月度开 oilLevelGuard 变体与线上对齐。
import { describe, it, expect } from 'vitest';
import { replayMonth, VARIANTS_DEFAULT } from '../backtest/run-backtest.js';
import { calcMonetarySignal, calcFiscalSignal, calcAdminSignal, deriveBalanceSheetStatus } from '../api/signal.js';

const NO_LOCK = { sahmLockActive: false, reactiveLockActive: false };
const BASE = { rate: 3, prevRate: 3, walcl: null, prevWalcl: null, fiscalChangePct: null, epuPercentile: null, sahm: null, oilChangePct: null, oilLevelLow: null };

function monthly(m) {
  return replayMonth({ ...BASE, ...m }, NO_LOCK, { ...VARIANTS_DEFAULT, oilLevelGuard: true });
}

describe('replayMonth vs 线上判定函数：货币维', () => {
  const rateCases = [
    { rate: 4, prevRate: 3.75 },   // +25bp 渐进加息
    { rate: 4, prevRate: 3.25 },   // +75bp
    { rate: 3.25, prevRate: 3.5 }, // -25bp 降息
    { rate: 3, prevRate: 3 },      // 暂停
    { rate: null, prevRate: null },
  ];
  const bsCases = [
    { walcl: null, prevWalcl: null },
    { walcl: 8000, prevWalcl: 8100 }, // QT 收缩 -1.2%
    { walcl: 8100, prevWalcl: 8000 }, // QE 扩张 +1.25%
    { walcl: 8001, prevWalcl: 8000 }, // 持平 +0.01%
  ];
  it('全组合逐位一致（含 QT 拦截宽松）', () => {
    for (const rc of rateCases) {
      for (const bc of bsCases) {
        const m = monthly({ ...rc, ...bc });
        const online = calcMonetarySignal({
          currentRate: rc.rate, prevRate: rc.prevRate,
          currentBalanceSheet: bc.walcl, prevBalanceSheet: bc.prevWalcl,
        });
        expect(m.monetary, JSON.stringify({ rc, bc })).toBe(online);
      }
    }
  });
  it('资产负债表子信号阈值一致', () => {
    for (const bc of [{ walcl: 8000, prevWalcl: 8100 }, { walcl: 8100, prevWalcl: 8000 }, { walcl: 8001, prevWalcl: 8000 }]) {
      // 月度内联的 bsSignal 不单独输出，经货币合成间接验证：rate 暂停(loose票) + bs 状态
      const m = monthly({ rate: 3, prevRate: 3, ...bc });
      const bs = deriveBalanceSheetStatus(bc.walcl, bc.prevWalcl);
      const expected = bs === 'tight' ? 'neutral' : 'loose'; // 暂停→loose 票，QT 拦截为 neutral
      expect(m.monetary, JSON.stringify(bc)).toBe(expected);
    }
  });
});

describe('replayMonth vs 线上判定函数：财政维', () => {
  it('阈值与 null 行为逐位一致', () => {
    for (const pct of [null, -8, -5.01, -5, -2, 0, 2, 5, 5.01, 8]) {
      const m = monthly({ fiscalChangePct: pct });
      const online = calcFiscalSignal({ outlaysChangePct: pct });
      expect(m.fiscal, `fiscalChangePct=${pct}`).toBe(online);
    }
  });
});

describe('replayMonth vs 线上判定函数：行政维（EPU 单代理域 + 油价事件层）', () => {
  const epuCases = [null, 10, 49.9, 50, 65, 80, 80.1, 95];
  const oilCases = [
    { oilChangePct: null, oilLevelLow: null },
    { oilChangePct: 25, oilLevelLow: false },  // 高位飙升
    { oilChangePct: 25, oilLevelLow: true },   // 低位反弹（O1 放行）
    { oilChangePct: 19.9, oilLevelLow: false },// 未达事件层
    { oilChangePct: -25, oilLevelLow: null },  // 暴跌
    { oilChangePct: -19.9, oilLevelLow: null },
  ];
  it('全组合逐位一致（飙升双护栏/暴跌 fail-closed/百分位回落）', () => {
    for (const epu of epuCases) {
      for (const oc of oilCases) {
        const m = monthly({ epuPercentile: epu, ...oc });
        const online = calcAdminSignal({
          epuTradePercentile: epu, epuDailyPercentile: null,
          oilChange30dPct: oc.oilChangePct, oilLevelLow: oc.oilLevelLow,
        });
        expect(m.admin, JSON.stringify({ epu, oc })).toBe(online);
      }
    }
  });
});
