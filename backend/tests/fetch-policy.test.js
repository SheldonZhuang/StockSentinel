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

describe('calcRelativeReturn', () => {
  it('SMH 涨 20%，SPY 涨 5% → 相对收益 +15%', () => {
    const smh = [{ close: 100 }, { close: 110 }, { close: 120 }];
    const spy = [{ close: 200 }, { close: 205 }, { close: 210 }];
    expect(calcRelativeReturn(smh, spy)).toBeCloseTo(15, 5);
  });

  it('缺失 close 的 bar 被跳过', () => {
    const smh = [{ close: null }, { close: 100 }, { close: 120 }];
    const spy = [{ close: 200 }, { close: 200 }];
    expect(calcRelativeReturn(smh, spy)).toBeCloseTo(20, 5);
  });

  it('有效数据点不足2个 → null', () => {
    expect(calcRelativeReturn([{ close: 100 }], [{ close: 200 }, { close: 210 }])).toBe(null);
    expect(calcRelativeReturn(null, [{ close: 200 }, { close: 210 }])).toBe(null);
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

  const fiscalObs = monthlyObs(25, i => (i < 12 ? -110 : -100));
  const epuObs = monthlyObs(120, i => 100 + i); // 最新值100为最小 → 低百分位
  // 日频序列（desc）：最新7天都是200，之前80天都是100 → 7日均线最新=200为最大 → 100分位
  const epuDailyObs = Array.from({ length: 87 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 4, 30) - i * 86400000).toISOString().slice(0, 10),
    value: String(i < 7 ? 200 : 100),
  }));
  const semiIpObs = [{ date: '2026-05-01', value: '7.2' }];

  it('正常返回三个维度的全部字段', async () => {
    mockFredBySeriesId({
      MTSDS133FMS: fiscalObs,
      EPUTRADE: epuObs,
      USEPUINDXD: epuDailyObs,
      IPG3344S: semiIpObs,
    });
    yahooFinance.historical.mockImplementation(symbol =>
      Promise.resolve(symbol === 'SMH'
        ? [{ close: 100 }, { close: 112 }]
        : [{ close: 200 }, { close: 202 }])
    );

    const data = await fetchPolicyData();
    expect(data.deficitTtm).toBe(-1320);
    expect(data.deficitTtmChangePct).toBeCloseTo(10, 5);
    expect(data.fiscalPeriodDate).toBe('2026-05-01');
    expect(data.epuTrade).toBe(100);
    expect(data.epuTradePercentile).toBeCloseTo(0.8, 1); // 1/120
    expect(data.epuDaily).toBe(200); // 最新7天均值
    expect(data.epuDailyPercentile).toBe(100); // 历史最高
    expect(data.smhSpyRelReturnPct).toBeCloseTo(11, 5); // 12% - 1%
    expect(data.semiIpYoy).toBe(7.2);
    expect(data.semiIpPeriodDate).toBe('2026-05-01');
  });

  it('单维度失败隔离：EPUTRADE 拒绝 → 月度侧 null，日频侧与财政/AI照常', async () => {
    mockFredBySeriesId({
      MTSDS133FMS: fiscalObs,
      EPUTRADE: new Error('FRED 500'),
      USEPUINDXD: epuDailyObs,
      IPG3344S: semiIpObs,
    });
    yahooFinance.historical.mockResolvedValue([{ close: 100 }, { close: 100 }]);

    const data = await fetchPolicyData();
    expect(data.epuTrade).toBe(null);
    expect(data.epuTradePercentile).toBe(null);
    expect(data.epuDailyPercentile).toBe(100); // 日频侧不受月度失败影响
    expect(data.deficitTtmChangePct).toBeCloseTo(10, 5);
    expect(data.semiIpYoy).toBe(7.2);
  });

  it('Yahoo 失败隔离：市场指标 null，但半导体IP仍有值', async () => {
    mockFredBySeriesId({
      MTSDS133FMS: fiscalObs,
      EPUTRADE: epuObs,
      IPG3344S: semiIpObs,
    });
    yahooFinance.historical.mockRejectedValue(new Error('yahoo down'));

    const data = await fetchPolicyData();
    expect(data.smhSpyRelReturnPct).toBe(null);
    expect(data.semiIpYoy).toBe(7.2);
  });

  it('缺少 FRED_API_KEY → 全部 null，不抛错', async () => {
    delete process.env.FRED_API_KEY;
    const data = await fetchPolicyData();
    expect(data.deficitTtmChangePct).toBe(null);
    expect(data.epuTradePercentile).toBe(null);
    expect(data.smhSpyRelReturnPct).toBe(null);
    expect(data.semiIpYoy).toBe(null);
  });
});
