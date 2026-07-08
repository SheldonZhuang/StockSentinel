import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock axios 避免真实 HTTP 请求
vi.mock('axios', () => {
  return {
    default: {
      get: vi.fn(),
    },
  };
});

import axios from 'axios';
import { fetchMacroData } from '../api/fetch-macro.js';

function makeObs(values) {
  return values.map((v, i) => ({
    date: `2024-0${i + 1}-01`,
    value: String(v),
  }));
}

beforeEach(() => {
  process.env.FRED_API_KEY = 'test-key';
  vi.clearAllMocks();
});

describe('fetchMacroData', () => {
  it('正常返回所有字段', async () => {
    // 前5次调用是 fetchSeries（利率/资产负债表/核心PCE/Trimmed PCE/失业率），
    // 后3次调用是 fetchReleaseDate（核心PCE/Trimmed PCE/失业率各查一次真实发布日期）
    axios.get
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } })
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } })
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } })
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } })
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } })
      .mockResolvedValue({ data: { observations: [{ date: '2024-01-01', value: '4.75', realtime_start: '2024-01-15' }] } });

    const data = await fetchMacroData();

    expect(data).toHaveProperty('currentRate');
    expect(data).toHaveProperty('prevRate');
    expect(data).toHaveProperty('currentBalanceSheet');
    expect(data).toHaveProperty('prevBalanceSheet');
    expect(data).toHaveProperty('corePce');
    expect(data).toHaveProperty('trimmedPce');
    expect(data).toHaveProperty('unemployment');
    expect(typeof data.currentRate).toBe('number');

    expect(data).toHaveProperty('rateDecisionDate');
    expect(data).toHaveProperty('balanceSheetPeriodDate');
    expect(data).toHaveProperty('balanceSheetReleaseDate');
    expect(data).toHaveProperty('balanceSheetStatus');
    expect(data.corePcePeriodDate).toBe('2024-01-01');
    expect(data.corePceReleaseDate).toBe('2024-01-15');
    expect(data.trimmedPcePeriodDate).toBe('2024-01-01');
    expect(data.trimmedPceReleaseDate).toBe('2024-01-15');
    expect(data.unemploymentPeriodDate).toBe('2024-01-01');
    expect(data.unemploymentReleaseDate).toBe('2024-01-15');
  });

  it('latest value 取第一条有效观测', async () => {
    // 第一条是 '.' (无效), 第二条是 4.75
    axios.get.mockResolvedValue({
      data: {
        observations: [
          { date: '2024-03-01', value: '.' },
          { date: '2024-02-01', value: '4.75' },
          { date: '2024-01-01', value: '4.25' },
        ],
      },
    });

    const data = await fetchMacroData();
    expect(data.currentRate).toBe(4.75);
    expect(data.prevRate).toBe(4.25);
  });

  it('FRED_API_KEY 未设置时抛错', async () => {
    delete process.env.FRED_API_KEY;
    await expect(fetchMacroData()).rejects.toThrow('FRED_API_KEY not set');
  });
});
