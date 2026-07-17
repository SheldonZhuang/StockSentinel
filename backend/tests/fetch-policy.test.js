import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('yahoo-finance2', () => ({ default: { historical: vi.fn(), quote: vi.fn() } }));

import axios from 'axios';
import yahooFinance from 'yahoo-finance2';
import { clearMarketDataCache } from '../api/market-data.js';
import {
  calcTtmDeficitChange,
  calcPercentile,
  calcRelativeReturn,
  calcWindowChangePct,
  fetchPolicyData,
} from '../api/fetch-policy.js';

// 生成 FRED desc 序列：从 latestDate 往前逐月，每月固定 value
function monthlyObs(count, valueFn) {
  const obs = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(2026, 4 - i, 1)); // 2026-05-01 起往前
    obs.push({ date: d.toISOString().slice(0, 10), value: String(valueFn(i)) });
  }
  return obs;
}

describe('calcTtmDeficitChange', () => {
  it('赤字扩大：本期TTM赤字比上年更大 → changePct 为正', () => {
    // 最近12个月每月 -110（TTM=-1320），前12个月每月 -100（TTM=-1200）
    const obs = monthlyObs(25, i => (i < 12 ? -110 : -100));
    const { ttmCurrent, ttmPrevYear, changePct } = calcTtmDeficitChange(obs);
    expect(ttmCurrent).toBe(-1320);
    expect(ttmPrevYear).toBe(-1200);
    expect(changePct).toBeCloseTo(10, 5);
  });

  it('赤字收窄：本期TTM赤字比上年小 → changePct 为负', () => {
    const obs = monthlyObs(24, i => (i < 12 ? -90 : -100));
    expect(calcTtmDeficitChange(obs).changePct).toBeCloseTo(-10, 5);
  });

  it('观测不足24个 → 全 null', () => {
    const obs = monthlyObs(20, () => -100);
    expect(calcTtmDeficitChange(obs)).toEqual({ ttmCurrent: null, ttmPrevYear: null, changePct: null });
  });

  it('无效值（.）被跳过，不计入24个观测', () => {
    const obs = [{ date: '2026-06-01', value: '.' }, ...monthlyObs(24, i => (i < 12 ? -110 : -100))];
    expect(calcTtmDeficitChange(obs).changePct).toBeCloseTo(10, 5);
  });
});

describe('calcPercentile', () => {
  it('最大值 → 100 分位', () => {
    expect(calcPercentile(50, [10, 20, 30, 50])).toBe(100);
  });

  it('中间值按 <= 占比计算', () => {
    expect(calcPercentile(20, [10, 20, 30, 40])).toBe(50);
  });

  it('latest 为 null 或序列为空 → null', () => {
    expect(calcPercentile(null, [1, 2, 3])).toBe(null);
    expect(calcPercentile(5, [])).toBe(null);
  });
});

describe('calcWindowChangePct', () => {
  it('最新值 vs 约30天前观测的涨跌幅', () => {
    const obs = [
      { date: '2026-07-10', value: '96' },
      { date: '2026-06-25', value: '90' },
      { date: '2026-06-09', value: '80' }, // 第一个 <= 30天前(6/10)的观测
      { date: '2026-05-01', value: '70' },
    ];
    const r = calcWindowChangePct(obs, 30);
    expect(r.latest).toBe(96);
    expect(r.changePct).toBeCloseTo(20, 5); // 96 vs 80
    expect(r.latestDate).toBe('2026-07-10');
  });

  it('窗口前无观测 → changePct null 但 latest 保留', () => {
    const r = calcWindowChangePct([{ date: '2026-07-10', value: '96' }], 30);
    expect(r.latest).toBe(96);
    expect(r.changePct).toBe(null);
  });

  it('空序列/全无效值 → 全 null', () => {
    expect(calcWindowChangePct([], 30)).toEqual({ latest: null, changePct: null, latestDate: null });
    expect(calcWindowChangePct([{ date: '2026-07-10', value: '.' }], 30)).toEqual({ latest: null, changePct: null, latestDate: null });
  });
});

describe('calcRelativeReturn', () => {
  it('SMH 涨 20%，SPY 涨 5% → 相对收益 +15%（同区间对齐）', () => {
    const smh = [{ date: '2024-01-01', close: 100 }, { date: '2024-01-02', close: 110 }, { date: '2024-01-03', close: 120 }];
    const spy = [{ date: '2024-01-01', close: 200 }, { date: '2024-01-02', close: 205 }, { date: '2024-01-03', close: 210 }];
    expect(calcRelativeReturn(smh, spy)).toBeCloseTo(15, 5);
  });

  it('缺失 close 的 bar 被跳过', () => {
    const smh = [{ date: '2024-01-01', close: null }, { date: '2024-01-02', close: 100 }, { date: '2024-01-03', close: 120 }];
    const spy = [{ date: '2024-01-02', close: 200 }, { date: '2024-01-03', close: 200 }];
    expect(calcRelativeReturn(smh, spy)).toBeCloseTo(20, 5);
  });

  it('有效数据点不足2个 → null', () => {
    expect(calcRelativeReturn([{ date: '2024-01-01', close: 100 }], [{ date: '2024-01-01', close: 200 }, { date: '2024-01-02', close: 210 }])).toBe(null);
    expect(calcRelativeReturn(null, [{ date: '2024-01-01', close: 200 }, { date: '2024-01-02', close: 210 }])).toBe(null);
  });

  it('窗口不等长时对齐到共同区间，避免新标的被系统性误判', () => {
    // semi 只覆盖后半段（如新 IPO），bench 覆盖全程 → 只比共同区间 [01-02, 01-03]
    const semi = [{ date: '2024-01-02', close: 100 }, { date: '2024-01-03', close: 110 }]; // 共同区间 +10%
    const bench = [{ date: '2024-01-01', close: 200 }, { date: '2024-01-02', close: 200 }, { date: '2024-01-03', close: 210 }]; // 共同区间 +5%
    expect(calcRelativeReturn(semi, bench)).toBeCloseTo(5, 5);
  });

  it('无重叠区间 → null（不可比）', () => {
    const semi = [{ date: '2024-01-01', close: 100 }, { date: '2024-01-02', close: 110 }];
    const bench = [{ date: '2024-03-01', close: 200 }, { date: '2024-03-02', close: 210 }];
    expect(calcRelativeReturn(semi, bench)).toBe(null);
  });
});

describe('fetchPolicyData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FRED_API_KEY = 'test-key';
    // 防止 market-data 回退层缓存跨用例串数据 / 备用源key污染
    clearMarketDataCache();
    delete process.env.TIINGO_API_KEY;
    delete process.env.TWELVEDATA_API_KEY;
  });

  function mockFredBySeriesId(handlers) {
    // 按 URL 中的 series_id 分发 mock 响应，比按调用顺序 mock 更稳（三个维度并行）
    axios.get.mockImplementation(url => {
      for (const [id, result] of Object.entries(handlers)) {
        if (url.includes(`series_id=${id}`)) {
          if (result instanceof Error) return Promise.reject(result);
          return Promise.resolve({ data: { observations: result } });
        }
      }
      return Promise.resolve({ data: { observations: [] } });
    });
  }

  const fiscalObs = monthlyObs(25, i => (i < 12 ? 110 : 100)); // 支出：最近12月110 vs 之前100 → 名义+10%
  // PCEPI（desc）：近12月均值102 vs 前12月均值100 → 通胀≈2% → 实际支出同比≈10%−2%=8%
  const pcepiObs = monthlyObs(25, i => (i < 12 ? 102 : 100));
  const epuObs = monthlyObs(120, i => 100 + i); // 最新值100为最小 → 低百分位
  // 日频序列（desc）：最新7天都是200，之前80天都是100 → 7日均线最新=200为最大 → 100分位
  const epuDailyObs = Array.from({ length: 87 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 4, 30) - i * 86400000).toISOString().slice(0, 10),
    value: String(i < 7 ? 200 : 100),
  }));
  // 油价（desc）：最新96，30天前80 → +20% 恰好触发战争冲击收紧
  const oilObs = [
    { date: '2026-05-30', value: '96' },
    { date: '2026-04-28', value: '80' },
  ];
  const semiIpObs = [{ date: '2026-05-01', value: '7.2' }];

  it('正常返回三个维度的全部字段', async () => {
    mockFredBySeriesId({
      MTSO133FMS: fiscalObs,
      PCEPI: pcepiObs,
      EPUTRADE: epuObs,
      USEPUINDXD: epuDailyObs,
      DCOILWTICO: oilObs,
      IPG3344S: semiIpObs,
    });
    yahooFinance.historical.mockImplementation(symbol =>
      Promise.resolve(symbol === 'SMH'
        ? [{ date: new Date('2024-01-01'), close: 100 }, { date: new Date('2024-01-02'), close: 112 }]
        : [{ date: new Date('2024-01-01'), close: 200 }, { date: new Date('2024-01-02'), close: 202 }])
    );

    const data = await fetchPolicyData();
    expect(data.outlaysTtm).toBe(1320);
    expect(data.outlaysNominalChangePct).toBeCloseTo(10, 5); // 名义同比
    expect(data.fiscalInflationPct).toBeCloseTo(2, 1);       // 通胀≈2%
    expect(data.outlaysChangePct).toBeCloseTo(8, 1);         // 实际同比=名义−通胀≈8%
    expect(data.fiscalPeriodDate).toBe('2026-05-01');
    expect(data.epuTrade).toBe(100);
    expect(data.epuTradePercentile).toBeCloseTo(0.8, 1); // 1/120
    expect(data.epuDaily).toBe(200); // 最新7天均值
    expect(data.epuDailyPercentile).toBe(100); // 历史最高
    expect(data.semiIpYoy).toBe(7.2);
    expect(data.semiIpPeriodDate).toBe('2026-05-01');
    expect(data.oilWti).toBe(96);
    expect(data.oilChange30dPct).toBeCloseTo(20, 5);
    expect(data.oilPeriodDate).toBe('2026-05-30');
  });

  it('单维度失败隔离：EPUTRADE 拒绝 → 月度侧 null，日频侧与财政/AI照常', async () => {
    mockFredBySeriesId({
      MTSO133FMS: fiscalObs,
      EPUTRADE: new Error('FRED 500'),
      USEPUINDXD: epuDailyObs,
      DCOILWTICO: oilObs,
      IPG3344S: semiIpObs,
    });
    yahooFinance.historical.mockResolvedValue([{ close: 100 }, { close: 100 }]);

    const data = await fetchPolicyData();
    expect(data.epuTrade).toBe(null);
    expect(data.epuTradePercentile).toBe(null);
    expect(data.epuDailyPercentile).toBe(100); // 日频侧不受月度失败影响
    expect(data.outlaysChangePct).toBeCloseTo(10, 5);
    expect(data.semiIpYoy).toBe(7.2);
  });

  it('半导体IP独立于其他维度：EPU/油价失败时半导体产出仍返回', async () => {
    mockFredBySeriesId({
      MTSO133FMS: fiscalObs,
      EPUTRADE: epuObs,
      IPG3344S: semiIpObs,
    });

    const data = await fetchPolicyData();
    expect(data.semiIpYoy).toBe(7.2);
  });

  it('油价优先用 CL=F 期货（最新交易日），FRED 现货仅兜底', async () => {
    mockFredBySeriesId({
      MTSO133FMS: fiscalObs,
      EPUTRADE: epuObs,
      USEPUINDXD: epuDailyObs,
      DCOILWTICO: oilObs, // FRED 兜底值 96/+20%，若走了兜底则断言会失败
      IPG3344S: semiIpObs,
    });
    yahooFinance.historical.mockResolvedValue([{ close: 100 }, { close: 100 }]);
    // 油价期货走 Yahoo 原始 chart 接口（axios直连），在 series_id 分发之外单独拦截
    const fredImpl = axios.get.getMockImplementation();
    axios.get.mockImplementation((url, ...rest) => {
      if (url.includes('/v8/finance/chart/CL%3DF')) {
        return Promise.resolve({ data: { chart: { result: [{
          timestamp: [Date.UTC(2026, 5, 5) / 1000, Date.UTC(2026, 6, 10) / 1000],
          indicators: { quote: [{ close: [100, 70] }] }, // 30天 -30%，且日期比FRED新4天
        }] } } });
      }
      return fredImpl(url, ...rest);
    });

    const data = await fetchPolicyData();
    expect(data.oilWti).toBe(70);
    expect(data.oilChange30dPct).toBeCloseTo(-30, 5);
    expect(data.oilPeriodDate).toBe('2026-07-10');
    expect(data.oilSource).toBe('futures');
  });

  it('缺少 FRED_API_KEY → 全部 null，不抛错', async () => {
    delete process.env.FRED_API_KEY;
    const data = await fetchPolicyData();
    expect(data.outlaysChangePct).toBe(null);
    expect(data.epuTradePercentile).toBe(null);
    expect(data.semiIpYoy).toBe(null);
  });
});
