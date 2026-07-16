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
import { fetchMacroData, calcRateSteps } from '../api/fetch-macro.js';

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
    // 前7次调用是 fetchSeries（利率/资产负债表/核心PCE/Trimmed PCE 1M/6M/12M/失业率），
    // 后5次调用是 fetchReleaseDate（核心PCE/Trimmed PCE 1M/6M/12M/失业率各查一次真实发布日期）
    axios.get
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } })
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } })
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } })
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } })
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } })
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } })
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } })
      .mockResolvedValueOnce({ data: { observations: makeObs([0.6, 0.4, 0.2]) } })
      .mockResolvedValue({ data: { observations: [{ date: '2024-01-01', value: '4.75', realtime_start: '2024-01-15' }] } });

    const data = await fetchMacroData();

    expect(data).toHaveProperty('currentRate');
    expect(data).toHaveProperty('prevRate');
    expect(data).toHaveProperty('currentBalanceSheet');
    expect(data).toHaveProperty('prevBalanceSheet');
    expect(data).toHaveProperty('corePce');
    expect(data).toHaveProperty('trimmedPce1m');
    expect(data).toHaveProperty('trimmedPce');
    expect(data).toHaveProperty('trimmedPce12m');
    expect(data).toHaveProperty('unemployment');
    expect(typeof data.currentRate).toBe('number');

    expect(data).toHaveProperty('rateDecisionDate');
    expect(data).toHaveProperty('balanceSheetPeriodDate');
    expect(data).toHaveProperty('balanceSheetReleaseDate');
    expect(data).toHaveProperty('balanceSheetStatus');
    expect(data.corePcePeriodDate).toBe('2024-01-01');
    expect(data.corePceReleaseDate).toBe('2024-01-15');
    expect(data.trimmedPce1mPeriodDate).toBe('2024-01-01');
    expect(data.trimmedPce1mReleaseDate).toBe('2024-01-15');
    expect(data.trimmedPcePeriodDate).toBe('2024-01-01');
    expect(data.trimmedPceReleaseDate).toBe('2024-01-15');
    expect(data.trimmedPce12mPeriodDate).toBe('2024-01-01');
    expect(data.trimmedPce12mReleaseDate).toBe('2024-01-15');
    expect(data.unemploymentPeriodDate).toBe('2024-01-01');
    expect(data.unemploymentReleaseDate).toBe('2024-01-15');
    expect(data).toHaveProperty('sahmValue');
    expect(data.sahmValue).toBe(0.6);
    expect(data.sahmPeriodDate).toBe('2024-01-01');
    expect(data.sahmReleaseDate).toBe('2024-01-15');

    expect(data.prevCorePce).toBe(4.25);
    expect(data.prevTrimmedPce1m).toBe(4.25);
    expect(data.prevTrimmedPce).toBe(4.25);
    expect(data.prevTrimmedPce12m).toBe(4.25);
    expect(data.prevUnemployment).toBe(4.25);
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

  it('元数据（发布日期）拉取失败不击穿管道，核心字段仍返回', async () => {
    // 前2次核心序列（利率/资产负债表）成功；其余序列成功；发布日期查询全部 reject
    let call = 0;
    axios.get.mockImplementation(() => {
      call++;
      if (call <= 8) return Promise.resolve({ data: { observations: makeObs([4.75, 4.25, 4.0]) } });
      return Promise.reject(new Error('429 rate limited')); // fetchReleaseDate 全挂
    });
    const data = await fetchMacroData();
    expect(data.currentRate).toBe(4.75); // 核心字段不受影响
    expect(data.corePceReleaseDate).toBeNull(); // 元数据降级为 null
  });

  it('非核心序列（SAHM）拉取失败降级为 null，不影响利率', async () => {
    let call = 0;
    axios.get.mockImplementation(() => {
      call++;
      if (call === 8) return Promise.reject(new Error('timeout')); // 第8个是 SAHM
      if (call <= 8) return Promise.resolve({ data: { observations: makeObs([4.75, 4.25, 4.0]) } });
      return Promise.resolve({ data: { observations: [{ date: '2024-01-01', value: '4.75', realtime_start: '2024-01-15' }] } });
    });
    const data = await fetchMacroData();
    expect(data.currentRate).toBe(4.75);
    expect(data.sahmValue).toBeNull(); // SAHM 降级
  });
});

describe('calcRateSteps', () => {
  it('降序观测 → 逐笔非零台阶（date=新值生效日）', () => {
    const obs = [
      { date: '2024-03-01', value: '4.00' },
      { date: '2024-02-01', value: '4.25' },
      { date: '2024-01-01', value: '4.25' }, // 无变动，不产生台阶
      { date: '2023-12-01', value: '4.50' },
    ];
    expect(calcRateSteps(obs)).toEqual([
      { date: '2024-03-01', diffBp: -25 },
      { date: '2024-01-01', diffBp: -25 },
    ]);
  });

  it('跳过无效值，空/单元素返回空', () => {
    expect(calcRateSteps([])).toEqual([]);
    expect(calcRateSteps([{ date: '2024-01-01', value: '4.5' }])).toEqual([]);
    expect(calcRateSteps(null)).toEqual([]);
  });

  it('一次50bp调整产生单笔台阶', () => {
    const obs = [
      { date: '2024-02-01', value: '4.50' },
      { date: '2024-01-01', value: '5.00' },
    ];
    expect(calcRateSteps(obs)).toEqual([{ date: '2024-02-01', diffBp: -50 }]);
  });
});
