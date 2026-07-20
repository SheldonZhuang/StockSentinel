// daily-replay.mjs 纯函数单测：发布日阶梯化 / 利率窗口口径 / 日度锁状态机（computeLocks 复刻）/
// 油价窗口涨跌幅 / 曲线倒挂计数 / 日度净值与防守片段
import { describe, it, expect } from 'vitest';
import {
  addMonthsYM, firstFridayOf,
  mtsVisibleFrom, pcepiVisibleFrom, sahmVisibleFrom, epuTradeVisibleFrom,
  buildVisibleSeries, calcRateStepsAsc, lastIdxLE, rateInputsAsOf, computeLocksDaily,
  oilChange30dAsOf, curveRunLengths, oilLevelLowAsOf, OIL_GUARD_DEFAULT,
  simulateNavDailyRecs, defenseEpisodesDaily, episodeIsFalsePositive,
} from '../backtest/daily-replay.mjs';
import { replayMonth } from '../backtest/run-backtest.js';

describe('addMonthsYM / firstFridayOf', () => {
  it('跨年进位与负数月', () => {
    expect(addMonthsYM('2020-12', 1)).toBe('2021-01');
    expect(addMonthsYM('2020-01', -2)).toBe('2019-11');
    expect(addMonthsYM('2020-06', 14)).toBe('2021-08');
  });
  it('第一个周五：2024-08-02（真实萨姆触发发布日）/ 月初即周五', () => {
    expect(firstFridayOf('2024-08')).toBe('2024-08-02'); // 2024-08-01 是周四
    expect(firstFridayOf('2021-01')).toBe('2021-01-01'); // 2021-01-01 是周五
    expect(firstFridayOf('2020-03')).toBe('2020-03-06'); // 2020-03-01 是周日
  });
});

describe('月度序列发布日阶梯化', () => {
  it('财政MTS：次月15日；PCEPI：次次月1日（月度回放M-2同口径）', () => {
    expect(mtsVisibleFrom('2020-01')).toBe('2020-02-15');
    expect(pcepiVisibleFrom('2020-01')).toBe('2020-03-01');
  });
  it('萨姆：次月第一个周五（随非农）；EPUTRADE：次月最后一日（编制滞后~1个月，闰年正确）', () => {
    expect(sahmVisibleFrom('2024-07')).toBe('2024-08-02');
    expect(epuTradeVisibleFrom('2020-01')).toBe('2020-02-29');
    expect(epuTradeVisibleFrom('2021-01')).toBe('2021-02-28');
  });
  it('buildVisibleSeries 附 visibleFrom 且不改原字段', () => {
    const rows = [{ month: '2020-01', value: 5 }, { month: '2020-02', value: 6 }];
    const vis = buildVisibleSeries(rows, mtsVisibleFrom);
    expect(vis[0]).toEqual({ month: '2020-01', value: 5, visibleFrom: '2020-02-15' });
    expect(vis[1].visibleFrom).toBe('2020-03-15');
  });
});

describe('calcRateStepsAsc / lastIdxLE', () => {
  const asc = [
    { date: '2022-01-03', value: 0.25 },
    { date: '2022-03-16', value: 0.25 },
    { date: '2022-03-17', value: 0.5 },  // +25
    { date: '2022-05-04', value: 0.5 },
    { date: '2022-05-05', value: 1.0 },  // +50
  ];
  it('台阶表含生效日/幅度/前值', () => {
    expect(calcRateStepsAsc(asc)).toEqual([
      { date: '2022-03-17', diffBp: 25, prevValue: 0.25 },
      { date: '2022-05-05', diffBp: 50, prevValue: 0.5 },
    ]);
  });
  it('lastIdxLE 二分边界：早于首元素→-1，恰等命中，晚于末元素→末下标', () => {
    expect(lastIdxLE(asc, '2021-12-31')).toBe(-1);
    expect(lastIdxLE(asc, '2022-03-17')).toBe(2);
    expect(lastIdxLE(asc, '2022-04-01')).toBe(2); // 03-17 之后、05-04 之前
    expect(lastIdxLE(asc, '2023-01-01')).toBe(4);
  });
});

describe('rateInputsAsOf（线上 calcDecisionPrevRate 语义 + 100天回看窗口）', () => {
  const asc = [
    { date: '2022-01-03', value: 0.25 },
    { date: '2022-03-17', value: 0.5 },
    { date: '2022-05-05', value: 1.0 },
  ];
  const steps = calcRateStepsAsc(asc);
  it('日历缺失（2025前）：窗口内有台阶 → 最近一次实际调整方向（加息→prevRate=前值）', () => {
    const r = rateInputsAsOf(asc, steps, '2022-05-20', { decisionDate: null });
    expect(r.currentRate).toBe(1.0);
    expect(r.prevRate).toBe(0.5); // +50bp → tight 方向
  });
  it('台阶滑出100天窗口 → prevRate=现值（差0=暂停→宽松，与线上一致）', () => {
    const r = rateInputsAsOf(asc, steps, '2022-09-01', { decisionDate: null });
    expect(r.prevRate).toBe(1.0);
  });
  it('FOMC日历口径：最近决议按兵不动（决议日晚于最新台阶）→ prevRate=现值', () => {
    const r = rateInputsAsOf(asc, steps, '2022-06-20', { decisionDate: '2022-06-15' });
    expect(r.prevRate).toBe(1.0); // 台阶2022-05-05 < 决议2022-06-15 → 暂停
  });
  it('FOMC日历口径：最近决议改了利率（台阶≥决议日）→ prevRate=台阶前值', () => {
    const r = rateInputsAsOf(asc, steps, '2022-05-10', { decisionDate: '2022-05-04' });
    expect(r.prevRate).toBe(0.5);
  });
});

describe('computeLocksDaily（server computeLocks 复刻：快照差+台阶扫描+60天锁龄）', () => {
  const steps = [
    { date: '2024-09-19', diffBp: -50, prevValue: 5.5 },
    { date: '2024-11-08', diffBp: -25, prevValue: 5.0 },
    { date: '2024-12-19', diffBp: -25, prevValue: 4.75 },
  ];
  const base = { currentRate: 5.0, sahmValue: 0.1, stepsAsc: steps };
  it('触发日：±50bp台阶 → 应对式锁激活，锁存起始日=当日', () => {
    const r = computeLocksDaily({ ...base, today: '2024-09-19', prev: { date: '2024-09-18', rate: 5.5, sahmLockActive: false, reactiveLockActive: false } });
    expect(r.rateDiffBp).toBe(-50);
    expect(r.reactiveLockActive).toBe(true);
    expect(r.reactiveLockSince).toBe('2024-09-19');
  });
  it('小幅调整但锁龄<60天 → 不解锁（月度2月近似在此解锁，日度真锁龄不解——2024-11-08实测差异）', () => {
    const r = computeLocksDaily({
      ...base, currentRate: 4.75, today: '2024-11-08',
      prev: { date: '2024-11-07', rate: 5.0, sahmLockActive: false, reactiveLockActive: true, reactiveLockSince: '2024-09-19' },
    });
    expect(r.rateDiffBp).toBe(-25);
    expect(r.reactiveLockActive).toBe(true); // 锁龄50天 < 60
    expect(r.reactiveLockSince).toBe('2024-09-19'); // 沿用
  });
  it('小幅调整且锁龄≥60天 → 解锁，起始日清空', () => {
    const r = computeLocksDaily({
      ...base, currentRate: 4.5, today: '2024-12-19',
      prev: { date: '2024-12-18', rate: 4.75, sahmLockActive: false, reactiveLockActive: true, reactiveLockSince: '2024-09-19' },
    });
    expect(r.reactiveLockActive).toBe(false);
    expect(r.reactiveLockSince).toBe(null);
  });

  it('SAHM数据缺失日 fail-closed：已激活的萨姆锁视同触发存续，小幅调整不误解锁', () => {
    // 2026-07-20 审查修复：sahmValue=null（FRED故障）+ <50bp调整 + 锁龄≥60天，
    // 修复前 sahmTrigger=false → smallAdjustmentUnlock 误放行；修复后触发沿用锁存态
    const r = computeLocksDaily({
      ...base, sahmValue: null, currentRate: 4.5, today: '2024-12-19',
      prev: { date: '2024-12-18', rate: 4.75, sahmLockActive: true, reactiveLockActive: false, sahmLockSince: '2024-09-19' },
    });
    expect(r.sahmLockActive).toBe(true);
    // 未激活的锁在缺数日不无中生有
    const r2 = computeLocksDaily({
      ...base, sahmValue: null, today: '2024-10-01',
      prev: { date: '2024-09-30', rate: 5.0, sahmLockActive: false, reactiveLockActive: false },
    });
    expect(r2.sahmLockActive).toBe(false);
  });
  it('零利率(≤0.25%)无条件解锁，萨姆触发也压不住', () => {
    const r = computeLocksDaily({
      stepsAsc: steps, currentRate: 0.25, sahmValue: 0.9, today: '2025-01-02',
      prev: { date: '2025-01-01', rate: 0.25, sahmLockActive: true, sahmLockSince: '2024-12-01', reactiveLockActive: true, reactiveLockSince: '2024-12-01' },
    });
    expect(r.sahmLockActive).toBe(false);
    expect(r.reactiveLockActive).toBe(false);
  });
  it('快照差窗口 (prevDate, today]：上一快照日当天的台阶不重复计入；窗口内多台阶取幅度最大', () => {
    const two = [
      { date: '2024-09-19', diffBp: -50, prevValue: 5.5 },
      { date: '2024-09-20', diffBp: -25, prevValue: 5.0 },
    ];
    const r = computeLocksDaily({
      stepsAsc: two, currentRate: 4.75, sahmValue: 0.1, today: '2024-09-21',
      prev: { date: '2024-09-18', rate: 5.5, sahmLockActive: false, reactiveLockActive: false },
    });
    expect(r.rateDiffBp).toBe(-50); // 幅度最大的一笔，而非端点差-75
    const r2 = computeLocksDaily({
      stepsAsc: two, currentRate: 4.75, sahmValue: 0.1, today: '2024-09-21',
      prev: { date: '2024-09-19', rate: 5.0, sahmLockActive: false, reactiveLockActive: false },
    });
    expect(r2.rateDiffBp).toBe(-25); // 9/19台阶已被上一快照消化
  });
  it('首跑（无快照）只看最近一笔台阶（与线上 allSteps.slice(0,1) 等价）', () => {
    const r = computeLocksDaily({ ...base, currentRate: 4.5, today: '2025-01-02', prev: null });
    expect(r.rateDiffBp).toBe(-25); // 最近台阶 2024-12-19
  });
  it('萨姆持续≥0.5期间小幅调整不解锁（触发日豁免，防单日解锁次日重锁翻转）', () => {
    const r = computeLocksDaily({
      stepsAsc: steps, currentRate: 4.75, sahmValue: 0.6, today: '2024-11-08',
      prev: { date: '2024-11-07', rate: 5.0, sahmLockActive: true, sahmLockSince: '2024-08-02', reactiveLockActive: false },
    });
    expect(r.sahmLockActive).toBe(true);
  });
});

describe('oilChange30dAsOf / curveRunLengths', () => {
  it('30天涨跌幅：基准取最接近30天前(≤)的观测', () => {
    const asc = [
      { date: '2020-02-03', value: 50 },
      { date: '2020-02-20', value: 53 },
      { date: '2020-03-04', value: 47 },
      { date: '2020-03-09', value: 31 },
    ];
    expect(oilChange30dAsOf(asc, '2020-03-09')).toBeCloseTo((31 - 50) / 50 * 100, 6); // 2/3 ≤ 3/9−30天=2/8 之前最近
    expect(oilChange30dAsOf(asc, '2020-02-01')).toBe(null); // 无观测
    expect(oilChange30dAsOf(asc, '2020-02-20')).toBe(null); // 30天前无基准
  });
  it('连续倒挂交易日数逐点累计，转正清零', () => {
    const asc = [
      { date: 'd1', value: -0.1 }, { date: 'd2', value: -0.2 },
      { date: 'd3', value: 0.1 }, { date: 'd4', value: -0.3 },
    ];
    expect(curveRunLengths(asc)).toEqual([1, 2, 0, 1]);
  });
});

describe('oilLevelLowAsOf（O系油价水平护栏）', () => {
  const mkAsc = vals => vals.map((v, i) => ({ date: `2020-01-${String(i + 1).padStart(2, '0')}`, value: v }));
  it('median 模式：现价低于窗口中位数=低位；高于=非低位', () => {
    const asc = mkAsc([100, 90, 80, 70, 40]); // 窗口5个：中位80
    expect(oilLevelLowAsOf(asc, '2020-01-05', { mode: 'median', windowObs: 5 })).toBe(true);  // 40 < 80
    expect(oilLevelLowAsOf(asc, '2020-01-05', { mode: 'median', windowObs: 3 })).toBe(true);  // 窗口[80,70,40]中位70 → 40<70
    const asc2 = mkAsc([40, 50, 60, 70, 95]);
    expect(oilLevelLowAsOf(asc2, '2020-01-05', { mode: 'median', windowObs: 5 })).toBe(false); // 95 > 60
  });
  it('median 偶数窗口取中间两数均值（窗口含当日观测）', () => {
    const asc = mkAsc([10, 20, 30, 88]); // 窗口4=[10,20,30,88]：中位 (20+30)/2=25
    expect(oilLevelLowAsOf(asc, '2020-01-04', { mode: 'median', windowObs: 4 })).toBe(false); // 88 > 25
    const asc2 = mkAsc([10, 20, 30, 15]); // 窗口4=[10,20,30,15]排序后中位 (15+20)/2=17.5
    expect(oilLevelLowAsOf(asc2, '2020-01-04', { mode: 'median', windowObs: 4 })).toBe(true); // 15 < 17.5
  });
  it('drawdown 模式：距窗口最高价回撤仍超阈值=低位（深坑反弹）', () => {
    const asc = mkAsc([100, 30, 45]); // 高点100，现价45 → 回撤-55% ≤ -40 → 低位
    expect(oilLevelLowAsOf(asc, '2020-01-03', { mode: 'drawdown', windowObs: 504, ddPct: 40 })).toBe(true);
    const asc2 = mkAsc([100, 80, 95]); // 回撤-5% → 非低位
    expect(oilLevelLowAsOf(asc2, '2020-01-03', { mode: 'drawdown', windowObs: 504, ddPct: 40 })).toBe(false);
  });
  it('无观测 → null（调用方不抑制，fail-open）', () => {
    expect(oilLevelLowAsOf(mkAsc([50]), '2019-12-31', { mode: 'median', windowObs: 5 })).toBe(null);
  });
  it('OIL_GUARD_DEFAULT 真实可用（回归锁定：曾因 lookbackObs/windowObs 字段名不一致静默失效）', () => {
    const asc = mkAsc([100, 90, 80, 70, 40]);
    expect(oilLevelLowAsOf(asc, '2020-01-05', OIL_GUARD_DEFAULT)).toBe(true); // 40 < 中位80，必须能判低位
    expect(oilLevelLowAsOf(asc, '2020-01-05', { mode: 'median', lookbackObs: 504 })).toBe(true); // 别名容错
    expect(oilLevelLowAsOf(asc, '2020-01-05', { mode: 'median' })).toBe(null); // 两键皆缺 → fail-open
  });
});

describe('月度 oilLevelGuard 结构性冗余不变式（--eval-oil 实证的单测锁定）', () => {
  // 月度单代理口径：飙升tight要求 epuPercentile>80，被抑制后回落到百分位判定仍是tight
  // → 开关在月度逐位无变化。此不变式若被未来改动打破（如月度改双代理），本测试会报警
  const m = {
    rate: 5, prevRate: 5, walcl: null, prevWalcl: null, fiscalChangePct: 0,
    epuPercentile: 90, oilChangePct: 25, oilLevelLow: true, sahm: 0.1, spxBelowSma10: false,
  };
  const state = { sahmLockActive: false, reactiveLockActive: false };
  it('油价飙升+EPU高位+低位反弹：抑制前后 admin 均为 tight（回落路径同结论）', () => {
    const off = replayMonth({ ...m }, { ...state });
    const on = replayMonth({ ...m }, { ...state }, { oilLevelGuard: true });
    expect(off.admin).toBe('tight');
    expect(on.admin).toBe('tight');
    expect(on.final).toBe(off.final);
  });
  it('默认（无变体）行为与未传 oilLevelLow 逐位一致（不改现有默认行为）', () => {
    const legacy = replayMonth({ ...m, oilLevelLow: undefined }, { ...state });
    const withField = replayMonth({ ...m }, { ...state });
    expect(withField).toEqual(legacy);
  });
});

describe('simulateNavDailyRecs / defenseEpisodesDaily / episodeIsFalsePositive', () => {
  const mk = (date, spx, final, rate = 5) => ({ date, spx, final, rawFinal: final, metrics: { rate } });
  it('defense日吃现金（目标利率/252）而非市场；调仓计数', () => {
    const recs = [
      mk('2020-01-01', 100, 'neutral'), mk('2020-01-02', 110, 'defense'),
      mk('2020-01-03', 55, 'neutral'), // defense期间腰斩不吃亏
      mk('2020-01-04', 60, 'neutral'),
    ];
    const sim = simulateNavDailyRecs(recs);
    const expected = (110 / 100) * (1 + 0.05 / 252) * (60 / 55);
    expect(sim.totalPct).toBeCloseTo((expected - 1) * 100, 6);
    expect(sim.trades).toBe(2); // 满仓→空仓→满仓
  });
  it('防守片段切分：起止/天数', () => {
    const recs = ['n', 'd', 'd', 'n', 'd'].map((s, i) =>
      mk(`2020-01-0${i + 1}`, 100, s === 'd' ? 'defense' : 'neutral'));
    const eps = defenseEpisodesDaily(recs);
    expect(eps).toHaveLength(2);
    expect(eps[0]).toMatchObject({ start: '2020-01-02', end: '2020-01-03', days: 2 });
    expect(eps[1]).toMatchObject({ start: '2020-01-05', end: '2020-01-05', days: 1 });
  });
  it('假阳性：片段起点后365日内最低收盘回撤未超-15% → true', () => {
    const spx = [
      { date: '2020-01-01', close: 100 }, { date: '2020-06-01', close: 90 },
      { date: '2020-12-01', close: 120 }, { date: '2022-01-01', close: 50 }, // 365天外的暴跌不算
    ];
    expect(episodeIsFalsePositive({ start: '2020-01-01' }, spx)).toBe(true);  // 最深-10%
    const spx2 = [{ date: '2020-01-01', close: 100 }, { date: '2020-03-23', close: 70 }];
    expect(episodeIsFalsePositive({ start: '2020-01-01' }, spx2)).toBe(false); // -30% 真危机
  });
});
