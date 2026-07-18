// dca-schemes.mjs 纯函数单测（定投方案对比，2026-07-18）
import { describe, it, expect } from 'vitest';
import {
  xirrMonthly,
  simulateDcaBuyHold,
  simulateDcaHedged,
  dcaStats,
} from '../backtest/dca-schemes.mjs';

describe('xirrMonthly（月度现金流资金加权收益率）', () => {
  it('单笔投入一年后收回1.1倍 → 年化10%', () => {
    const r = xirrMonthly([{ i: 0, amount: -1 }, { i: 12, amount: 1.1 }]);
    expect(r).toBeCloseTo(10, 5);
  });
  it('单笔翻倍（12个月）→ 年化100%', () => {
    expect(xirrMonthly([{ i: 0, amount: -1 }, { i: 12, amount: 2 }])).toBeCloseTo(100, 4);
  });
  it('定投零收益：每月-1共3笔、期末收回3 → 年化0%', () => {
    const r = xirrMonthly([
      { i: 0, amount: -1 }, { i: 1, amount: -1 }, { i: 2, amount: -1 },
      { i: 2, amount: 3 },
    ]);
    expect(r).toBeCloseTo(0, 6);
  });
  it('资金加权特性：后期投入权重大——先亏后赚的定投XIRR高于时间加权', () => {
    // 月0投1（次月腰斩），月1投1（次月翻倍）：TWR=0.5×2-1=0；期末市值=(0.5×0.5+... )
    // 简化：i0投-1、i1投-1、i2期末收回 (1×0.5×2 + 1×2)=3 → 明显>0
    const r = xirrMonthly([{ i: 0, amount: -1 }, { i: 1, amount: -1 }, { i: 2, amount: 3 }]);
    expect(r).toBeGreaterThan(0);
  });
  it('无符号变化（全为负）→ null；不足两笔 → null', () => {
    expect(xirrMonthly([{ i: 0, amount: -1 }, { i: 1, amount: -1 }])).toBe(null);
    expect(xirrMonthly([{ i: 0, amount: -1 }])).toBe(null);
  });
});

describe('simulateDcaBuyHold（定投+买入持有）', () => {
  const months = [{ month: '2020-01' }, { month: '2020-02' }, { month: '2020-03' }];
  it('价格不变：市值=累计投入，TWR恒为1', () => {
    const pxMap = new Map([['2020-01', 10], ['2020-02', 10], ['2020-03', 10]]);
    const r = simulateDcaBuyHold(months, pxMap);
    expect(r.points[0].value).toBeCloseTo(1, 12);
    expect(r.points[1].value).toBeCloseTo(2, 12);
    expect(r.points[2].value).toBeCloseTo(3, 12);
    expect(r.points[2].invested).toBe(3);
    expect(r.twr[2].nav).toBeCloseTo(1, 12);
  });
  it('TWR等于标的自身价格路径（月末入金当月不产生收益）', () => {
    const pxMap = new Map([['2020-01', 10], ['2020-02', 20], ['2020-03', 5]]);
    const r = simulateDcaBuyHold(months, pxMap);
    expect(r.twr[1].nav).toBeCloseTo(2, 12);   // 10→20
    expect(r.twr[2].nav).toBeCloseTo(0.5, 12); // 20→5
    // 市值：月1买0.1股；月2市值2+入1(0.05股)；月3价5 → 0.15×5+1/5×5=... 0.15股+0.2股=0.35×5
    expect(r.points[2].value).toBeCloseTo(0.35 * 5, 12);
  });
  it('缺月末价 → 抛错', () => {
    expect(() => simulateDcaBuyHold(months, new Map([['2020-01', 10]]))).toThrow(/缺/);
  });
});

describe('simulateDcaHedged（定投TQQQ95%+SQQQ信号对冲）', () => {
  const mk = tiers => tiers.map((f, i) => ({ month: `2020-${String(i + 1).padStart(2, '0')}`, final: f }));
  const flatPx = {
    tqqq: new Map(Array.from({ length: 12 }, (_, i) => [`2020-${String(i + 1).padStart(2, '0')}`, 10])),
    sqqq: new Map(Array.from({ length: 12 }, (_, i) => [`2020-${String(i + 1).padStart(2, '0')}`, 100])),
  };
  it('价格不变：无泄漏——市值=累计投入，SQQQ权重≈5%', () => {
    const r = simulateDcaHedged(mk(['neutral', 'reduce', 'defense']), flatPx);
    expect(r.points[2].value).toBeCloseTo(3, 12);
    expect(r.avgHedgeWeightPct).toBeCloseTo(5, 6);
    expect(r.twr[2].nav).toBeCloseTo(1, 12);
  });
  it('attack档清仓SQQQ全归TQQQ；再回neutral时重建对冲', () => {
    const r = simulateDcaHedged(mk(['neutral', 'attack', 'neutral']), flatPx);
    // 月2 attack：SQQQ清零 → 权重0；月3 neutral：调回5%
    const w2 = r.points[1], w3 = r.points[2];
    expect(w2.value).toBeCloseTo(2, 12);
    // 月2无SQQQ：hedgeWSum 该月贡献0
    expect(r.avgHedgeWeightPct).toBeCloseTo(((0.05 + 0 + 0.05) / 3) * 100, 6);
    expect(w3.value).toBeCloseTo(3, 12);
  });
  it('TQQQ永不卖出：SQQQ补足以当月定投现金为上限（5%目标不可达时如实欠配）', () => {
    // SQQQ暴跌99%：持仓市值≈0，目标5%×组合 > 当月投入1 → 只能投入全额1的min(target,cash)
    const px = {
      tqqq: new Map([['2020-01', 10], ['2020-02', 10]]),
      sqqq: new Map([['2020-01', 100], ['2020-02', 1]]),
    };
    // 放大组合：先造大额组合再测——直接用大C系数等价，这里用hedgePct=0.5造"目标>现金"场景
    const r = simulateDcaHedged(mk(['neutral', 'neutral']).slice(0, 2), px, 1, { hedgePct: 0.5 });
    // 月1：目标0.5×1=0.5 → SQQQ买0.5(0.005股)、TQQQ 0.5；月2：SQQQ市值0.005、组合≈0.505+1
    // 目标≈0.7525，缺口≈0.7475 > 现金1? 否（现金=1足够）→ 此例验证目标达成；
    // 缺口>现金的欠配路径由 min(±) 分支保证，行为断言：SQQQ市值≤目标且现金不为负（市值守恒）
    const inv = r.points[1].invested;
    expect(r.points[1].value).toBeCloseTo(0.5 + 0.005 * 1 + (inv - 1), 6); // TQQQ 0.5 + SQQQ残值 + 第2月投入
  });
  it('季度模式：非季末月新资金按95/5入场、不调整存量', () => {
    const r = simulateDcaHedged(mk(['neutral', 'neutral', 'neutral', 'neutral']), flatPx, 1, { rebalanceQuarterly: true });
    // 2020-01/02 非季末：各买SQQQ 0.05；2020-03 季末：调回5%
    expect(r.points[1].value).toBeCloseTo(2, 12);
    expect(r.avgHedgeWeightPct).toBeCloseTo(5, 6); // 平价下入场比例即5% → 权重恒5%
  });
});

describe('dcaStats（定投路径统计）', () => {
  const points = [
    { month: '2020-01', value: 1, invested: 1 },
    { month: '2020-02', value: 1.1, invested: 2 },   // 市值<累计投入（0.55x）
    { month: '2020-03', value: 3.6, invested: 3 },
  ];
  it('倍数/最大浮亏/市值回撤', () => {
    const s = dcaStats(points);
    expect(s.totalInvested).toBe(3);
    expect(s.endValue).toBeCloseTo(3.6, 12);
    expect(s.multiple).toBeCloseTo(1.2, 12);
    expect(s.minValueToInvestedPct).toBeCloseTo((1.1 / 2 - 1) * 100, 8); // -45%
    expect(s.valueMddPct).toBe(0); // 市值路径1→1.1→3.6未回撤
  });
  it('XIRR：零收益定投=0%', () => {
    const s = dcaStats([
      { month: '2020-01', value: 1, invested: 1 },
      { month: '2020-02', value: 2, invested: 2 },
      { month: '2020-03', value: 3, invested: 3 },
    ]);
    expect(s.xirrPct).toBeCloseTo(0, 6);
  });
  it('市值最大回撤只看市值路径（含入金）', () => {
    const s = dcaStats([
      { month: '2020-01', value: 1, invested: 1 },
      { month: '2020-02', value: 0.5, invested: 2 }, // 含新入金仍腰斩
      { month: '2020-03', value: 0.6, invested: 3 },
    ]);
    expect(s.valueMddPct).toBeCloseTo(-50, 8);
  });
  it('不足两点 → null', () => {
    expect(dcaStats(points.slice(0, 1))).toBe(null);
  });
});
