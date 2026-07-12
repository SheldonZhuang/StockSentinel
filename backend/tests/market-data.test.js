import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('yahoo-finance2', () => ({
  default: { historical: vi.fn(), quote: vi.fn(), quoteSummary: vi.fn(), fundamentalsTimeSeries: vi.fn() },
}));

import axios from 'axios';
import yahooFinance from 'yahoo-finance2';
import { getDailyCloses, getQuote, clearMarketDataCache } from '../api/market-data.js';

beforeEach(() => {
  vi.clearAllMocks();
  clearMarketDataCache();
  process.env.TIINGO_API_KEY = 'test-tiingo';
  process.env.TWELVEDATA_API_KEY = 'test-td';
  delete process.env.FMP_API_KEY;
  delete process.env.financialmodelingprep_API_KEY;
});

describe('getDailyCloses 三层回退', () => {
  it('Yahoo 成功：不触发备用源', async () => {
    yahooFinance.historical.mockResolvedValue([
      { date: new Date('2026-07-01'), close: 100 },
      { date: new Date('2026-07-02'), close: 101 },
    ]);
    const closes = await getDailyCloses('SPY', '2026-07-01', '2026-07-02');
    expect(closes).toEqual([
      { date: '2026-07-01', close: 100 },
      { date: '2026-07-02', close: 101 },
    ]);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('Yahoo 挂（库+chart直连都挂）→ Tiingo 接管（adjClose 优先，日期截断）', async () => {
    yahooFinance.historical.mockRejectedValue(new Error('429'));
    axios.get.mockImplementation(url => {
      if (url.includes('finance.yahoo.com')) return Promise.reject(new Error('429'));
      return Promise.resolve({
        data: [
          { date: '2026-07-01T00:00:00.000Z', close: 99, adjClose: 100 },
          { date: '2026-07-02T00:00:00.000Z', close: 100.5, adjClose: 101 },
        ],
      });
    });
    const closes = await getDailyCloses('SPY', '2026-07-01', '2026-07-02');
    expect(closes).toEqual([
      { date: '2026-07-01', close: 100 },
      { date: '2026-07-02', close: 101 },
    ]);
    const tiingoCalls = axios.get.mock.calls.filter(c => c[0].includes('tiingo.com'));
    expect(tiingoCalls.length).toBe(1);
  });

  it('Yahoo 库挂但 chart 直连可用 → 不消耗备用源配额', async () => {
    yahooFinance.historical.mockRejectedValue(new Error('429'));
    axios.get.mockImplementation(url => {
      if (url.includes('finance.yahoo.com')) {
        return Promise.resolve({ data: { chart: { result: [{
          timestamp: [Date.UTC(2026, 6, 1) / 1000, Date.UTC(2026, 6, 2) / 1000],
          indicators: { adjclose: [{ adjclose: [100, 101] }], quote: [{ close: [99, 100.5] }] },
        }] } } });
      }
      return Promise.reject(new Error('should not reach backup providers'));
    });
    const closes = await getDailyCloses('SPY', '2026-07-01', '2026-07-02');
    expect(closes).toEqual([
      { date: '2026-07-01', close: 100 },
      { date: '2026-07-02', close: 101 },
    ]);
    expect(axios.get.mock.calls.every(c => c[0].includes('finance.yahoo.com'))).toBe(true);
  });

  it('Yahoo+Tiingo 挂 → TwelveData 接管（降序反转、字符串解析）', async () => {
    yahooFinance.historical.mockRejectedValue(new Error('429'));
    axios.get.mockImplementation(url => {
      if (url.includes('tiingo')) return Promise.reject(new Error('403'));
      return Promise.resolve({
        data: {
          values: [
            { datetime: '2026-07-02', close: '101' },
            { datetime: '2026-07-01', close: '100' },
          ],
        },
      });
    });
    const closes = await getDailyCloses('SPY', '2026-07-01', '2026-07-02');
    expect(closes).toEqual([
      { date: '2026-07-01', close: 100 },
      { date: '2026-07-02', close: 101 },
    ]);
  });

  it('TwelveData 返回 status:error 视为失败', async () => {
    yahooFinance.historical.mockRejectedValue(new Error('429'));
    axios.get.mockImplementation(url => {
      if (url.includes('tiingo')) return Promise.reject(new Error('403'));
      return Promise.resolve({ data: { status: 'error', message: 'symbol not found' } });
    });
    expect(await getDailyCloses('BADSYM', '2026-07-01', '2026-07-02')).toBe(null);
  });

  it('三层全挂 → null 不抛错', async () => {
    yahooFinance.historical.mockRejectedValue(new Error('429'));
    axios.get.mockRejectedValue(new Error('down'));
    expect(await getDailyCloses('SPY', '2026-07-01', '2026-07-02')).toBe(null);
  });

  it('备用源无 key 时跳过：Yahoo（库+chart）挂且无备用 key → null，不调备用源', async () => {
    delete process.env.TIINGO_API_KEY;
    delete process.env.TWELVEDATA_API_KEY;
    yahooFinance.historical.mockRejectedValue(new Error('429'));
    axios.get.mockRejectedValue(new Error('429')); // chart 直连也挂
    expect(await getDailyCloses('SPY', '2026-07-01', '2026-07-02')).toBe(null);
    // 只有 yahoo chart 直连的调用，没有备用源调用
    expect(axios.get.mock.calls.every(c => c[0].includes('finance.yahoo.com'))).toBe(true);
  });

  it('缓存命中不重复请求', async () => {
    yahooFinance.historical.mockResolvedValue([{ date: new Date('2026-07-01'), close: 100 }]);
    await getDailyCloses('SPY', '2026-07-01', '2026-07-02');
    await getDailyCloses('SPY', '2026-07-01', '2026-07-02');
    expect(yahooFinance.historical).toHaveBeenCalledTimes(1);
  });
});

describe('getQuote 三层回退', () => {
  it('Yahoo 成功：全字段', async () => {
    yahooFinance.quote.mockResolvedValue({
      regularMarketPrice: 555.5, trailingPE: 30, forwardPE: 25, priceToBook: 12, shortName: 'SPDR S&P 500',
    });
    const q = await getQuote('SPY');
    expect(q).toEqual({
      price: 555.5, trailingPE: 30, forwardPE: 25, priceToSales: null, priceToBook: 12, shortName: 'SPDR S&P 500', source: 'yahoo',
    });
  });

  it('Yahoo 挂 → Tiingo IEX 接管（只有价格，估值为 null）', async () => {
    yahooFinance.quote.mockRejectedValue(new Error('429'));
    axios.get.mockResolvedValue({ data: [{ tngoLast: 554.2, last: 554.0 }] });
    const q = await getQuote('SPY');
    expect(q.price).toBe(554.2);
    expect(q.trailingPE).toBe(null);
    expect(q.source).toBe('tiingo');
  });

  it('前两层挂 → TwelveData price 接管', async () => {
    yahooFinance.quote.mockRejectedValue(new Error('429'));
    axios.get.mockImplementation(url => {
      if (url.includes('tiingo')) return Promise.reject(new Error('403'));
      return Promise.resolve({ data: { price: '553.10' } });
    });
    const q = await getQuote('SPY');
    expect(q.price).toBe(553.1);
    expect(q.source).toBe('twelvedata');
  });

  it('三层全挂 → null 不抛错', async () => {
    yahooFinance.quote.mockRejectedValue(new Error('429'));
    axios.get.mockRejectedValue(new Error('down'));
    expect(await getQuote('SPY')).toBe(null);
  });

  it('有FMP key时：Tiingo只给价格 → ratios-ttm 补全真实PE/PS', async () => {
    process.env.FMP_API_KEY = 'test-fmp';
    yahooFinance.quote.mockRejectedValue(new Error('429'));
    axios.get.mockImplementation(url => {
      if (url.includes('tiingo')) return Promise.resolve({ data: [{ tngoLast: 316.2 }] });
      if (url.includes('ratios-ttm')) {
        return Promise.resolve({ data: [{ priceToEarningsRatioTTM: 38.1, priceToSalesRatioTTM: 10.3, priceToBookRatioTTM: 43.7 }] });
      }
      return Promise.reject(new Error('unexpected'));
    });
    const q = await getQuote('AAPL');
    expect(q.price).toBe(316.2);
    expect(q.trailingPE).toBeCloseTo(38.1, 5);
    expect(q.priceToSales).toBeCloseTo(10.3, 5);
  });

  it('FMP作为第4层价格兜底（stable/quote）', async () => {
    process.env.FMP_API_KEY = 'test-fmp';
    yahooFinance.quote.mockRejectedValue(new Error('429'));
    axios.get.mockImplementation(url => {
      if (url.includes('tiingo') || url.includes('twelvedata')) return Promise.reject(new Error('down'));
      if (url.includes('stable/quote')) return Promise.resolve({ data: [{ price: 751.7, name: 'SPDR S&P 500' }] });
      if (url.includes('ratios-ttm')) return Promise.resolve({ data: [] }); // ETF无财报
      return Promise.reject(new Error('unexpected'));
    });
    const q = await getQuote('SPY');
    expect(q.price).toBe(751.7);
    expect(q.source).toBe('fmp');
    expect(q.trailingPE).toBe(null); // ETF无PE属正常
  });

  it('无FMP key时不做补全也不调ratios接口', async () => {
    yahooFinance.quote.mockRejectedValue(new Error('429'));
    axios.get.mockImplementation(url => {
      if (url.includes('tiingo')) return Promise.resolve({ data: [{ tngoLast: 100 }] });
      return Promise.reject(new Error('down'));
    });
    const q = await getQuote('AAPL');
    expect(q.trailingPE).toBe(null);
    expect(axios.get.mock.calls.every(c => !String(c[0]).includes('ratios-ttm'))).toBe(true);
  });
});

describe('TwelveData 并发节流', () => {
  it('并发调用串行排队，相邻调用间隔≥8秒（不齐发）', async () => {
    vi.useFakeTimers();
    try {
      yahooFinance.quote.mockRejectedValue(new Error('429'));
      const tdCallTimes = [];
      axios.get.mockImplementation(url => {
        if (url.includes('finance.yahoo.com')) return Promise.reject(new Error('429'));
        if (url.includes('tiingo')) return Promise.reject(new Error('403'));
        tdCallTimes.push(Date.now());
        return Promise.resolve({ data: { price: '100' } });
      });
      const all = Promise.all([getQuote('AAA'), getQuote('BBB'), getQuote('CCC')]);
      await vi.runAllTimersAsync();
      await all;
      expect(tdCallTimes.length).toBe(3);
      expect(tdCallTimes[1] - tdCallTimes[0]).toBeGreaterThanOrEqual(8000);
      expect(tdCallTimes[2] - tdCallTimes[1]).toBeGreaterThanOrEqual(8000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('缓存TTL分级', () => {
  it('11分钟后：日线closes仍走缓存（12小时TTL），quote已过期重取（10分钟TTL）', async () => {
    vi.useFakeTimers();
    try {
      yahooFinance.historical.mockResolvedValue([{ date: new Date('2026-07-01'), close: 100 }]);
      yahooFinance.quote.mockResolvedValue({ regularMarketPrice: 100 });
      await getDailyCloses('SPY', '2026-07-01', '2026-07-02');
      await getQuote('SPY');
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      await getDailyCloses('SPY', '2026-07-01', '2026-07-02');
      await getQuote('SPY');
      expect(yahooFinance.historical).toHaveBeenCalledTimes(1);
      expect(yahooFinance.quote).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
