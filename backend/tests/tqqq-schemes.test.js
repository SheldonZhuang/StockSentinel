// tqqq-schemes.mjs 纯函数单测（TQQQ/SQQQ/期权执行层方案评估，2026-07-18）
import { describe, it, expect } from 'vitest';
import {
  synthDailyCustom,
  normCdf,
  bsPrice,
  rollingVolByMonth,
  statsFromNav,
  navPathFromWeights,
  simulateEtfScheme,
  simulateOptionScheme,
} from '../backtest/tqqq-schemes.mjs';

describe('synthDailyCustom（自定义系数日度杠杆合成）', () => {
  const bars = [
    { date: '2020-01-01', close: 100 },
    { date: '2020-01-02', close: 110 },
    { date: '2020-01-03', close: 99 },
  ];
  it('TQQQ模型：3r − 2×FFR_d − ER_d 逐日复利', () => {
    const out = synthDailyCustom(bars, () => 2.52, { beta: 3, ffrMult: -2, erPct: 0.86, tradingDays: 252 });
    const ffrD = 2.52 / 100 / 252, erD = 0.86 / 100 / 252;
    const nav1 = 1 + 3 * 0.10 - 2 * ffrD - erD;
    const nav2 = nav1 * (1 + 3 * (99 / 110 - 1) - 2 * ffrD - erD);
    expect(out[0].close).toBe(1);
    expect(out[1].close).toBeCloseTo(nav1, 12);
    expect(out[2].close).toBeCloseTo(nav2, 12);
  });
  it('SQQQ模型：−3r + 4×FFR_d − ER_d（做空所得计息为正贡献）', () => {
    const out = synthDailyCustom(bars.slice(0, 2), () => 2.52, { beta: -3, ffrMult: 4, erPct: 0.95, tradingDays: 252 });
    expect(out[1].close).toBeCloseTo(1 - 3 * 0.10 + 4 * (2.52 / 100 / 252) - 0.95 / 100 / 252, 12);
  });
  it('单日亏穿100%后净值钉在0，不再复活', () => {
    const crash = [
      { date: '2020-01-01', close: 100 },
      { date: '2020-01-02', close: 60 },  // −40%×3 = −120% → 0
      { date: '2020-01-03', close: 120 },
    ];
    const out = synthDailyCustom(crash, () => 0, { beta: 3, ffrMult: 0, erPct: 0 });
    expect(out[1].close).toBe(0);
    expect(out[2].close).toBe(0);
  });
});

describe('normCdf / bsPrice（BS定价基元）', () => {
  it('normCdf 已知值：N(0)=0.5、N(1.96)≈0.975、对称性', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.5) + normCdf(1.5)).toBeCloseTo(1, 7);
  });
  it('put-call parity：C − P = S − K·e^{−rT}', () => {
    const S = 100, K = 120, T = 3, r = 0.04, sigma = 0.7;
    const c = bsPrice(S, K, T, r, sigma, 'call');
    const p = bsPrice(S, K, T, r, sigma, 'put');
    expect(c - p).toBeCloseTo(S - K * Math.exp(-r * T), 6);
  });
  it('T≤0 → 内在价值；sigma=0 → 贴现内在价值下界', () => {
    expect(bsPrice(100, 80, 0, 0.05, 0.7, 'call')).toBe(20);
    expect(bsPrice(100, 120, 0, 0.05, 0.7, 'put')).toBe(20);
    expect(bsPrice(100, 80, 1, 0.05, 0, 'call')).toBeCloseTo(100 - 80 * Math.exp(-0.05), 10);
  });
  it('波动率越高期权越贵（凸性方向）', () => {
    const lo = bsPrice(100, 120, 3, 0.04, 0.4, 'call');
    const hi = bsPrice(100, 120, 3, 0.04, 0.9, 'call');
    expect(hi).toBeGreaterThan(lo);
  });
});

describe('rollingVolByMonth（滚动252日实现波动率，月末采样）', () => {
  it('恒定日收益 → 波动率0；观测不足 minObs 的月份缺失', () => {
    const bars = [];
    for (let i = 0; i < 70; i++) {
      bars.push({ date: `2020-0${Math.floor(i / 25) + 1}-${String((i % 25) + 1).padStart(2, '0')}`, close: 100 * Math.pow(1.001, i) });
    }
    const m = rollingVolByMonth(bars, { window: 252, minObs: 60 });
    expect(m.get('2020-01')).toBeUndefined(); // 首月只有24个收益观测
    expect(m.get('2020-03')).toBeCloseTo(0, 10);
  });
  it('交替±收益的已知波动率 ≈ |log(1.1)|×√252', () => {
    const bars = [];
    for (let i = 0; i < 90; i++) {
      const mm = String(Math.floor(i / 28) + 1).padStart(2, '0');
      const dd = String((i % 28) + 1).padStart(2, '0');
      bars.push({ date: `2020-${mm}-${dd}`, close: i % 2 ? 110 : 100 });
    }
    const m = rollingVolByMonth(bars, { window: 252, minObs: 60 });
    const vols = [...m.values()];
    expect(vols[vols.length - 1]).toBeCloseTo(Math.abs(Math.log(1.1)) * Math.sqrt(252), 1);
  });
});

describe('statsFromNav（月度净值路径统计）', () => {
  const points = [
    { month: '2019-12', nav: 1 },
    { month: '2020-01', nav: 1.1 },
    { month: '2020-02', nav: 0.55 },
    { month: '2020-03', nav: 0.66 },
  ];
  it('总收益/回撤/最低净值比', () => {
    const s = statsFromNav(points);
    expect(s.totalPct).toBeCloseTo(-34, 6);
    expect(s.mddPct).toBeCloseTo((0.55 / 1.1 - 1) * 100, 6);
    expect(s.minNavRatio).toBeCloseTo(0.55, 12);
  });
  it('yearly 按日历年聚合，首点为基期不计收益月', () => {
    const s = statsFromNav(points);
    expect(s.yearly.get('2020')).toBeCloseTo((0.66 - 1) * 100, 6);
    expect(s.yearMonths.get('2020')).toBe(3);
    expect(s.yearly.has('2019')).toBe(false);
  });
  it('归零路径：末值0 → cagr=−100，不抛错', () => {
    const s = statsFromNav([{ month: '2020-01', nav: 1 }, { month: '2020-02', nav: 0 }]);
    expect(s.cagrPct).toBe(-100);
    expect(s.minNavRatio).toBe(0);
  });
  it('不足两点 → null', () => {
    expect(statsFromNav(points.slice(0, 1))).toBe(null);
  });
});

describe('navPathFromWeights（E0/E3对照行的路径版，与 simulateExecution 同口径）', () => {
  const rateMap = new Map([['2020-01', 12], ['2020-02', 12]]);
  const pxMap = new Map([['2020-01', 100], ['2020-02', 110], ['2020-03', 55]]);
  const assetRet = (asset, m0, m1) => (asset === 'spy' ? pxMap.get(m1) / pxMap.get(m0) - 1 : null);
  const months = [
    { month: '2020-01', final: 'reduce' },
    { month: '2020-02', final: 'defense' },
    { month: '2020-03', final: 'neutral' },
  ];
  it('E0语义：reduce月×1.1、defense月×1.01（月 i 收益由 i−1 档位决定）', () => {
    const w = f => (f === 'defense' ? { cash: 1 } : { spy: 1 });
    const pts = navPathFromWeights(months, w, assetRet, rateMap);
    expect(pts[0].nav).toBe(1);
    expect(pts[1].nav).toBeCloseTo(1.1, 10);
    expect(pts[2].nav).toBeCloseTo(1.1 * 1.01, 10);
  });
  it('资产缺月收益 → 抛错', () => {
    expect(() => navPathFromWeights(months, () => ({ qqq: 1 }), assetRet, rateMap)).toThrow(/缺/);
  });
});

describe('simulateEtfScheme（TQQQ/SQQQ现货方案状态机）', () => {
  const rateMap = new Map(); // 零利率简化
  const px = {
    tqqq: new Map([['2020-01', 10], ['2020-02', 20], ['2020-03', 10], ['2020-04', 10]]),
    sqqq: new Map([['2020-01', 100], ['2020-02', 50], ['2020-03', 100], ['2020-04', 100]]),
  };
  const tl = tiers => tiers.map((f, i) => ({ month: `2020-0${i + 1}`, final: f }));

  it('字面版：无 attack 档 → TQQQ 持有月数恒为0（结构缺陷证明）', () => {
    const r = simulateEtfScheme(tl(['neutral', 'reduce', 'defense', 'neutral']), px, rateMap, {
      tqqqTiers: ['attack'], attackRebalance: true, reduceSellsHalf: true,
    });
    expect(r.tqqqMonths).toBe(0);
    // 首月买入5% SQQQ后随市值漂移不补仓：nav = 0.95 + 0.05×(价格比)
    expect(r.points[1].nav).toBeCloseTo(0.95 + 0.05 * (50 / 100), 10);
  });
  it('修正映射：首个 neutral 月买 TQQQ 至85%，已持则不补仓（市值漂移）', () => {
    const r = simulateEtfScheme(tl(['neutral', 'neutral']), px, rateMap, {
      tqqqTiers: ['attack', 'neutral'], sqqqLeg: 'none',
    });
    expect(r.tqqqMonths).toBe(2);
    expect(r.points[0].nav).toBeCloseTo(1, 10);
    // 月2：TQQQ 翻倍 → nav = 0.15 + 0.85×2 = 1.85，且不回落到85%（不再平衡）
    expect(r.points[1].nav).toBeCloseTo(1.85, 10);
  });
  it('进入 reduce 一次性卖出50% TQQQ，连续 reduce 不重复减半；defense 清仓', () => {
    const r = simulateEtfScheme(tl(['neutral', 'reduce', 'reduce', 'defense']), px, rateMap, {
      tqqqTiers: ['attack', 'neutral'], reduceSellsHalf: true, defenseClearsTqqq: true, sqqqLeg: 'none',
    });
    // 月1买0.85（0.085股）；月2进入reduce：先市值1.85，卖半 → 0.0425股
    // 月3价格回到10：nav = 现金(0.15+0.85) + 0.0425×10 = 1.425；连续reduce不再卖 → 持仓不变
    expect(r.points[2].nav).toBeCloseTo(0.15 + 0.85 + 0.425, 10);
    expect(r.tqqqMonths).toBe(3); // 月4 defense清仓 → 不计持有
    expect(r.points[3].nav).toBeCloseTo(r.points[2].nav, 10); // 价格不变，清仓不改净值
  });
  it('SQQQ月度重平5%：每月末回到5%权重（常备保险口径）', () => {
    const r = simulateEtfScheme(tl(['neutral', 'neutral']), px, rateMap, {
      tqqqTiers: [], sqqqLeg: 'rebalance',
    });
    // 月1：SQQQ=5%；月2：SQQQ价格减半 → nav=0.975，重平后SQQQ市值=0.04875
    expect(r.points[1].nav).toBeCloseTo(0.975, 10);
    expect(r.sqqqMonths).toBe(2);
  });
  it('现金按上月FFR月化计息（10%备用金口径的利息来源）', () => {
    const rm = new Map([['2020-01', 12]]);
    const r = simulateEtfScheme(tl(['defense', 'defense']), px, rm, { tqqqTiers: [], sqqqLeg: 'none' });
    expect(r.points[1].nav).toBeCloseTo(1.01, 10);
  });
});

describe('simulateOptionScheme（TQQQ期权方案状态机，BS粗建模）', () => {
  const rateMap = new Map(); // 零利率
  const mkMonths = tiers => tiers.map((f, i) => ({ month: `202${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, final: f }));
  const flatPx = months => new Map(months.map(m => [m.month, 100]));
  const flatVol = months => new Map(months.map(m => [m.month, 0.6]));

  it('字面版：无 attack → LEAPS 持有月数0，Put常备滚动照买（对冲腿独立漂移）', () => {
    const months = mkMonths(Array(8).fill('neutral'));
    const r = simulateOptionScheme(months, flatPx(months), flatVol(months), rateMap, { callTiers: ['attack'] });
    expect(r.callMonths).toBe(0);
    // 价格不动的0.8×S Put到期归零 → 净值单调下降（theta损耗）
    expect(r.points[7].nav).toBeLessThan(r.points[0].nav);
  });
  it('修正映射：neutral 买入 LEAPS（85%预算，含0.5%摩擦），defense 清仓', () => {
    const months = mkMonths(['neutral', 'defense']);
    const r = simulateOptionScheme(months, flatPx(months), flatVol(months), rateMap, { callTiers: ['attack', 'neutral'] });
    expect(r.callMonths).toBe(1);
    // 买入即付0.5%摩擦 → 首月净值 < 1
    expect(r.points[0].nav).toBeLessThan(1);
    expect(r.points[0].nav).toBeGreaterThan(0.98);
  });
  it('Put 到期按内在价值结算：标的暴跌时对冲腿兑现', () => {
    const months = mkMonths(Array(8).fill('defense'));
    const px = flatPx(months);
    for (const m of months.slice(6)) px.set(m.month, 40); // 第7个月起暴跌60%
    const r = simulateOptionScheme(months, px, flatVol(months), rateMap, { callTiers: [] });
    // 0.8×100=80行权价 put 在 S=40 时内在价值40 —— 第7个月净值应高于纯theta损耗路径
    expect(r.points[6].nav).toBeGreaterThan(r.points[5].nav);
  });
  it('LEAPS 剩余≤2个月时滚动（卖旧买新，各收0.5%摩擦），持仓不中断', () => {
    const months = mkMonths(Array(40).fill('neutral'));
    const r = simulateOptionScheme(months, flatPx(months), flatVol(months), rateMap, { callTiers: ['attack', 'neutral'] });
    expect(r.callMonths).toBe(40); // 36−2=34个月时卖旧、同月买新36个月
  });
});
