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

  it('Yahoo 挂 → Tiingo 接管（adjClose 优先，日期截断）', async () => {
    yahooFinance.historical.mockRejectedValue(new Error('429'));
    axios.get.mockResolvedValue({
      data: [
        { date: '2026-07-01T00:00:00.000Z', close: 99, adjClose: 100 },
        { date: '2026-07-02T00:00:00.000Z', close: 100.5, adjClose: 101 },
      ],
    });
    const closes = await getDailyCloses('SPY', '2026-07-01', '2026-07-02');
    expect(closes).toEqual([
      { date: '2026-07-01', close: 100 },
      { date: '2026-07-02', close: 101 },
    ]);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][0]).toContain('tiingo.com');
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

  it('备用源无 key 时跳过：Yahoo 挂且无备用 key → null，不调 axios', async () => {
    delete process.env.TIINGO_API_KEY;
    delete process.env.TWELVEDATA_API_KEY;
    yahooFinance.historical.mockRejectedValue(new Error('429'));
    expect(await getDailyCloses('SPY', '2026-07-01', '2026-07-02')).toBe(null);
    expect(axios.get).not.toHaveBeenCalled();
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
      price: 555.5, trailingPE: 30, forwardPE: 25, priceToBook: 12, shortName: 'SPDR S&P 500', source: 'yahoo',
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
});
