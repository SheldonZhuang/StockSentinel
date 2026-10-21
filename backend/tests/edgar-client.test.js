// EDGAR 统一访问层（129号）：UA、串行、瞬时故障重试、确定性错误不重试、CIK 映射
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const { edgarGet, isTransientEdgarError, tickerToCik, _resetCikCache, EDGAR_HEADERS, archiveBase } = await import('../utils/edgar-client.js');

const httpErr = status => Object.assign(new Error(`status ${status}`), { response: { status } });

beforeEach(() => {
  axios.get.mockReset();
  vi.useRealTimers();
});

describe('isTransientEdgarError', () => {
  it('429 / 5xx / 网络超时 → 重试；404 / 403 / 普通错误 → 不重试', () => {
    expect(isTransientEdgarError(httpErr(429))).toBe(true);
    expect(isTransientEdgarError(httpErr(503))).toBe(true);
    expect(isTransientEdgarError(Object.assign(new Error('t'), { code: 'ECONNABORTED' }))).toBe(true);
    expect(isTransientEdgarError(httpErr(404))).toBe(false);
    expect(isTransientEdgarError(httpErr(403))).toBe(false);
    expect(isTransientEdgarError(new Error('boom'))).toBe(false);
  });
});

describe('edgarGet', () => {
  it('带 SEC 要求的裸 UA', async () => {
    axios.get.mockResolvedValue({ data: 1 });
    await edgarGet('https://data.sec.gov/x');
    expect(axios.get.mock.calls[0][1].headers['User-Agent']).toBe('StockSentinel admin@stocksentinel.app');
    expect(EDGAR_HEADERS['User-Agent']).not.toMatch(/[()/]/);
  });

  it('429 后退避重试成功', async () => {
    vi.useFakeTimers();
    axios.get.mockRejectedValueOnce(httpErr(429)).mockResolvedValueOnce({ data: 'ok' });
    const p = edgarGet('https://data.sec.gov/y');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ data: 'ok' });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('持续 503：共 3 次后抛出', async () => {
    vi.useFakeTimers();
    axios.get.mockRejectedValue(httpErr(503));
    const p = edgarGet('https://data.sec.gov/z');
    const assertion = expect(p).rejects.toThrow('503');
    await vi.runAllTimersAsync();
    await assertion;
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  it('404 立即抛出不重试', async () => {
    axios.get.mockRejectedValue(httpErr(404));
    await expect(edgarGet('https://data.sec.gov/w')).rejects.toThrow('404');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('并发调用串行执行（同一时刻只有一个请求在途）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    axios.get.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return { data: 1 };
    });
    await Promise.all([edgarGet('a'), edgarGet('b'), edgarGet('c')]);
    expect(maxInFlight).toBe(1);
  });
});

describe('tickerToCik / archiveBase', () => {
  it('补零到 10 位、大小写不敏感、带缓存', async () => {
    _resetCikCache();
    axios.get.mockResolvedValue({ data: { 0: { ticker: 'MSFT', cik_str: 789019 } } });
    expect(await tickerToCik('msft')).toBe('0000789019');
    expect(await tickerToCik('NOPE')).toBe(null);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('目录路径去前导零与横线', () => {
    expect(archiveBase('0000789019', '0001193125-26-191507')).toBe('https://www.sec.gov/Archives/edgar/data/789019/000119312526191507');
  });
});
