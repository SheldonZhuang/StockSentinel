// R系（2026-07-19 路线图末三项评估）纯函数测试：
// R1 净流动性（buildNetLiquidityWeekly / netLiqChangePctAsOf / replayMonth.netLiquidity）
// R2 盈利周期确认票（cpYoyVisibleAsOf / replayMonth.cpConfirmVote）
// R3 CAPE仓位缩放（capeScaleOf / simulateS5.targetWeightOf / simulateS5Daily.targetOf）
import { describe, it, expect } from 'vitest';
import {
  buildNetLiquidityWeekly,
  netLiqChangePctAsOf,
  cpYoyVisibleAsOf,
  replayMonth,
} from '../backtest/run-backtest.js';
import { simulateS5 } from '../backtest/dca-schemes.mjs';
import { simulateS5Daily } from '../backtest/s5-daily.mjs';
import { capeScaleOf, CAPE_BANDS } from '../backtest/cape-scaling.mjs';

describe('buildNetLiquidityWeekly（R1 净流动性周度构建）', () => {
  const walcl = [
    { date: '2023-01-04', value: 8_500_000 }, // 百万美元
    { date: '2023-01-11', value: 8_480_000 },
  ];
  it('单位换算：WALCL(百万) − (TGA+RRP)(十亿×1000)，对齐 WALCL 周三', () => {
    const tga = [{ date: '2023-01-04', value: 500 }]; // 十亿
    const rrp = [{ date: '2023-01-04', value: 2000 }];
    const out = buildNetLiquidityWeekly(walcl, tga, rrp);
    expect(out[0]).toEqual({ date: '2023-01-04', value: 8_500_000 - 2500 * 1000 });
    expect(out).toHaveLength(2); // 第二周 TGA 沿用（7天 ≤ maxStaleDays 10）
  });
  it('TGA 过旧（>10天，序列起点前）→ 该周无条目（调用方回退WALCL口径）', () => {
    const tga = [{ date: '2022-12-01', value: 500 }];
    const out = buildNetLiquidityWeekly(walcl, tga, []);
    expect(out).toHaveLength(0);
  });
  it('RRP 近7天无观测 = 隔夜余额为0（2009-2013 无常设ON RRP，非数据缺失）', () => {
    const tga = [{ date: '2023-01-04', value: 500 }];
    const rrp = [{ date: '2022-06-01', value: 999 }]; // 过旧 → 按0计
    const out = buildNetLiquidityWeekly(walcl, tga, rrp);
    expect(out[0].value).toBe(8_500_000 - 500 * 1000);
  });
});

describe('netLiqChangePctAsOf（R1 13周变化率，周四发布+新鲜度护栏）', () => {
  // 14条连续周三观测：前13条=1000，最后一条=1100 → 13周变化 +10%
  const mk = (n, lastVal) => Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2023, 0, 4 + i * 7)).toISOString().slice(0, 10),
    value: i === n - 1 ? lastVal : 1000,
  }));
  it('可见性：观测日+1 才可见（周四发布），13周变化率正确', () => {
    const s = mk(14, 1100); // 最后观测 2023-04-05（周三）
    expect(netLiqChangePctAsOf(s, '2023-04-05')).toBe(null); // 当日不可见 → 退到前一条，不足新鲜/够数条件
    expect(netLiqChangePctAsOf(s, '2023-04-06')).toBeCloseTo(10, 6); // 周四起可见
  });
  it('最新观测距 asOf 超过14天 → null（RRP断档期不允许陈旧值冒充）', () => {
    const s = mk(14, 1100);
    expect(netLiqChangePctAsOf(s, '2023-05-01')).toBe(null); // 最新观测2023-04-05距此26天
  });
  it('不足14条观测 → null', () => {
    expect(netLiqChangePctAsOf(mk(13, 1100), '2023-04-06')).toBe(null);
  });
});

describe('cpYoyVisibleAsOf（R2 CP季度同比，~2.5个月发布滞后）', () => {
  const cpQ = [
    { date: '2000-01-01', value: 2.3 },  // Q1：季末3月 → 6月可见
    { date: '2000-04-01', value: -1.6 }, // Q2：季末6月 → 9月可见
  ];
  it('Q1 在 6 月决策首次可见；5 月不可见', () => {
    expect(cpYoyVisibleAsOf(cpQ, '2000-05')).toBe(null);
    expect(cpYoyVisibleAsOf(cpQ, '2000-06')).toBe(2.3);
  });
  it('取可见的最新一季：9 月起 Q2 覆盖 Q1', () => {
    expect(cpYoyVisibleAsOf(cpQ, '2000-08')).toBe(2.3);
    expect(cpYoyVisibleAsOf(cpQ, '2000-09')).toBe(-1.6);
    expect(cpYoyVisibleAsOf(cpQ, '2001-12')).toBe(-1.6); // 之后沿用最新
  });
});

describe('replayMonth R1/R2 变体', () => {
  const NEUTRAL_INPUT = { rate: 3, prevRate: 3, walcl: null, prevWalcl: null, fiscalChangePct: null, epuPercentile: null, sahm: null };
  const NO_LOCK = { sahmLockActive: false, reactiveLockActive: false };

  it('R1：净流动性13周 <−2% → QT拦截宽松票（暂停月 loose→neutral）；>+2% → 放行 loose', () => {
    const tight = replayMonth({ ...NEUTRAL_INPUT, netLiqChangePct: -3 }, NO_LOCK, { netLiquidity: true });
    expect(tight.monetary).toBe('neutral');
    const loose = replayMonth({ ...NEUTRAL_INPUT, netLiqChangePct: 3 }, NO_LOCK, { netLiquidity: true });
    expect(loose.monetary).toBe('loose');
  });
  it('R1：净流动性不可得（null）→ 回退 WALCL 周环比口径', () => {
    const r = replayMonth({ ...NEUTRAL_INPUT, netLiqChangePct: null, walcl: 99, prevWalcl: 100 }, NO_LOCK, { netLiquidity: true });
    expect(r.monetary).toBe('neutral'); // WALCL -1% < -0.25% → bs tight 拦截宽松
  });
  it('R1 结构性不变式：资产负债表子信号永不产生 tight（只在 loose↔neutral 切换）', () => {
    const r = replayMonth({ ...NEUTRAL_INPUT, rate: 4, prevRate: 3.75, netLiqChangePct: -99 }, NO_LOCK, { netLiquidity: true });
    expect(r.monetary).toBe('tight'); // tight 只来自加息方向，与净流动性无关
    const r2 = replayMonth({ ...NEUTRAL_INPUT, netLiqChangePct: -99 }, NO_LOCK, { netLiquidity: true });
    expect(r2.monetary).toBe('neutral'); // 暂停+净流动性崩塌也只到 neutral，不是 tight
  });
  it('R2：恰1维tight + CP同比<0 → reduce 升级 defense；CP≥0 或变体关 → 保持 reduce', () => {
    const oneTight = { ...NEUTRAL_INPUT, fiscalChangePct: 8 }; // 财政tight单维
    expect(replayMonth(oneTight, NO_LOCK, {}).final).toBe('reduce');
    expect(replayMonth({ ...oneTight, cpYoy: -2 }, NO_LOCK, { cpConfirmVote: true }).final).toBe('defense');
    expect(replayMonth({ ...oneTight, cpYoy: 2 }, NO_LOCK, { cpConfirmVote: true }).final).toBe('reduce');
    expect(replayMonth({ ...oneTight, cpYoy: -2 }, NO_LOCK, {}).final).toBe('reduce');
  });
  it('R2：0维tight（neutral）不受CP影响；W5趋势门上方的R2升级会被降回 reduce', () => {
    expect(replayMonth({ ...NEUTRAL_INPUT, cpYoy: -2, rate: 3, prevRate: 3.25 }, NO_LOCK, { cpConfirmVote: true }).final).toBe('neutral');
    const gated = replayMonth(
      { ...NEUTRAL_INPUT, fiscalChangePct: 8, cpYoy: -2, spxBelowSma10: false },
      NO_LOCK, { cpConfirmVote: true, trendReentry: true },
    );
    expect(gated.final).toBe('reduce'); // 树驱动defense在趋势上方被W5门降回
  });
});

describe('capeScaleOf（R3 分位→目标仓位）', () => {
  const P0 = CAPE_BANDS['P0任务书(1/.85/.70/.55)'];
  it('任务书档位映射与边界（区间上界不含）', () => {
    expect(capeScaleOf(30, P0)).toBe(1);
    expect(capeScaleOf(50, P0)).toBe(0.85);
    expect(capeScaleOf(79.9, P0)).toBe(0.85);
    expect(capeScaleOf(80, P0)).toBe(0.70);
    expect(capeScaleOf(90, P0)).toBe(0.55);
    expect(capeScaleOf(99, P0)).toBe(0.55);
  });
  it('分位缺失 → 1（fail-open满仓，调用方统计报告）', () => {
    expect(capeScaleOf(null, P0)).toBe(1);
    expect(capeScaleOf(undefined, P0)).toBe(1);
  });
});

describe('simulateS5.targetWeightOf（R3 月度）', () => {
  // 4个月合成：neutral → defense → reduce → neutral，价格恒定10（只验状态机记账）
  const months = [
    { month: '2020-01', final: 'neutral' },
    { month: '2020-02', final: 'defense', sahmLockActive: false, reactiveLockActive: false },
    { month: '2020-03', final: 'reduce' },
    { month: '2020-04', final: 'neutral' },
  ];
  const px = { tqqq: new Map(months.map(m => [m.month, 10])) };
  const rateMap = new Map();

  it('targetWeightOf ≡ 1 与基线逐位一致（回归锁定）', () => {
    const a = simulateS5(months, px, rateMap);
    const b = simulateS5(months, px, rateMap, 1, { targetWeightOf: () => 1 });
    a.points.forEach((p, i) => expect(b.points[i].value).toBeCloseTo(p.value, 10));
    expect(b.episodes.length).toBe(a.episodes.length);
  });
  it('目标 0.5：买入月只投到组合的50%，其余留储备；超配时卖回储备', () => {
    const r = simulateS5(months, px, rateMap, 1, { targetWeightOf: () => 0.5 });
    // 首月：新钱1 → 组合1 → TQQQ 0.5 + 储备0.5
    expect(r.points[0].value).toBeCloseTo(1, 9);
    const log0 = r.monthLog[0];
    expect(log0.reserve).toBeCloseTo(0.5, 9);
    // defense 月清仓；reduce 买回月按基线口径新钱留储备，买回到目标50%
    const log2 = r.monthLog[2];
    expect(log2.reserve).toBeGreaterThan(0); // 未全额部署
  });
  it('targetWeightOf 与 staged 不兼容 → 显式抛错', () => {
    expect(() => simulateS5(months, px, rateMap, 1, { targetWeightOf: () => 0.5, staged: true })).toThrow();
  });
});

describe('simulateS5Daily.targetOf（R3 日度）', () => {
  const mkDays = tiers => tiers.map((tier, i) => ({
    date: `2020-01-${String(i + 1).padStart(2, '0')}`,
    px: 10, tier, rate: 0, isMonthEnd: i === tiers.length - 1, trigger: '决策树共振',
  }));
  it('targetOf ≡ 1 与基线逐位一致（回归锁定）', () => {
    const days = mkDays(['neutral', 'defense', 'neutral', 'neutral']);
    const a = simulateS5Daily(days, 1);
    const b = simulateS5Daily(days, 1, { targetOf: () => 1 });
    a.dailyPoints.forEach((p, i) => expect(b.dailyPoints[i].value).toBeCloseTo(p.value, 10));
  });
  it('月末买入日按目标权重再平衡（0.5 → 一半留现金）', () => {
    const days = mkDays(['neutral', 'neutral']);
    const r = simulateS5Daily(days, 1, { targetOf: () => 0.5 });
    const last = r.dailyPoints[r.dailyPoints.length - 1];
    expect(last.value).toBeCloseTo(1, 9); // 价格不动，市值=投入
  });
});
