import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('yahoo-finance2', () => ({
  default: { historical: vi.fn(), quote: vi.fn(), quoteSummary: vi.fn(), fundamentalsTimeSeries: vi.fn() },
}));

import axios from 'axios';
import yahooFinance from 'yahoo-finance2';
import chainCfg from '../config/ai-chain.config.js';
import { clearMarketDataCache } from '../api/market-data.js';
import {
  aggregateDailyTokens,
  calcUsageTrend,
  calcCapexYoY,
  calcStageRelReturns,
  rankStages,
  fetchAiChainData,
} from '../api/fetch-ai-chain.js';

// 生成连续 N 天的日 token 序列（升序），tokensFn(i) i=0 为最早一天
function dailyTokens(count, tokensFn, endDate = '2026-07-08') {
  const end = new Date(endDate + 'T00:00:00Z');
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(end.getTime() - (count - 1 - i) * 86400000);
    out.push({ date: d.toISOString().slice(0, 10), tokens: tokensFn(i) });
  }
  return out;
}

describe('aggregateDailyTokens', () => {
  it('同日多模型（含 other 行）合并求和，按日期升序', () => {
    const rows = [
      { date: '2026-07-02', model_permaslug: 'a/x', total_tokens: '100' },
      { date: '2026-07-01', model_permaslug: 'a/x', total_tokens: '30' },
      { date: '2026-07-02', model_permaslug: 'other', total_tokens: '50' },
      { date: '2026-07-01', model_permaslug: 'b/y', total_tokens: '20' },
    ];
    expect(aggregateDailyTokens(rows)).toEqual([
      { date: '2026-07-01', tokens: 50 },
      { date: '2026-07-02', tokens: 150 },
    ]);
  });

  it('无效 token 值被跳过', () => {
    expect(aggregateDailyTokens([{ date: '2026-07-01', total_tokens: 'abc' }])).toEqual([]);
  });
});

describe('calcUsageTrend', () => {
  it('近7日均量高于前28日 → 正趋势', () => {
    // 前28天每天100，近7天每天110 → +10%
    const totals = dailyTokens(35, i => (i < 28 ? 100 : 110));
    const r = calcUsageTrend(totals, 7, 28, '2026-07-09');
    expect(r.modelUsageTrendPct).toBeCloseTo(10, 5);
    expect(r.modelUsageLatestTokens).toBe(110);
    expect(r.modelUsageAsOf).toBe('2026-07-08');
  });

  it('最新一天为今天(UTC)视为不完整数据丢弃', () => {
    const totals = dailyTokens(36, i => (i < 28 ? 100 : 110), '2026-07-09');
    const r = calcUsageTrend(totals, 7, 28, '2026-07-09');
    expect(r.modelUsageAsOf).toBe('2026-07-08');
    expect(r.modelUsageTrendPct).toBeCloseTo(10, 5);
  });

  it('完整天数不足 → 全 null', () => {
    const totals = dailyTokens(30, () => 100);
    expect(calcUsageTrend(totals, 7, 28, '2026-07-09').modelUsageTrendPct).toBe(null);
  });
});

describe('calcCapexYoY', () => {
  // capex 为现金流出（负值）
  const q = vals => vals.map((v, i) => ({ date: `2026-Q${i}`, capitalExpenditure: v }));

  it('滚动4季 vs 前4季，用绝对值口径', () => {
    // 最近4季每季-110（TTM=440），前4季每季-100（TTM=400）→ +10%
    const quarters = { MSFT: q([-110, -110, -110, -110, -100, -100, -100, -100]) };
    const r = calcCapexYoY(quarters);
    expect(r.capexYoY).toBeCloseTo(10, 5);
    expect(r.capexTtm).toBe(440);
    expect(r.capexPrevTtm).toBe(400);
  });

  it('不足8季度的公司剔除，两期口径一致', () => {
    const quarters = {
      MSFT: q([-110, -110, -110, -110, -100, -100, -100, -100]),
      AMZN: q([-999, -999, -999]), // 只有3季 → 整体剔除
    };
    expect(calcCapexYoY(quarters).capexYoY).toBeCloseTo(10, 5);
  });

  it('全部公司数据不足 → 全 null', () => {
    expect(calcCapexYoY({ MSFT: q([-100, -100]) })).toEqual({ capexYoY: null, capexTtm: null, capexPrevTtm: null });
  });
});

describe('calcStageRelReturns / rankStages', () => {
  const bars = closes => closes.map(c => ({ close: c }));
  const bench = bars([100, 100]); // SPY 0%

  it('等权平均；无效标的剔除；全无效环节 → null', () => {
    const baskets = { chip: ['NVDA', 'AMD'], power: ['BE'] };
    const barsBySymbol = new Map([
      ['NVDA', bars([100, 120])], // +20%
      ['AMD', bars([100, 110])],  // +10%
      ['BE', null],               // 拉取失败
    ]);
    const metrics = calcStageRelReturns(baskets, barsBySymbol, bench);
    expect(metrics.find(s => s.key === 'chip').relReturnPct).toBeCloseTo(15, 5);
    expect(metrics.find(s => s.key === 'chip').validTickerCount).toBe(2);
    expect(metrics.find(s => s.key === 'power').relReturnPct).toBe(null);
  });

  it('排名降序，第1名为自动卡点', () => {
    const metrics = [
      { key: 'cloud', relReturnPct: 2, validTickerCount: 5 },
      { key: 'chip', relReturnPct: 8, validTickerCount: 5 },
      { key: 'memory', relReturnPct: -3, validTickerCount: 7 },
    ];
    const { stages, autoBottleneck } = rankStages(metrics, 3);
    expect(autoBottleneck).toBe('chip');
    expect(stages.find(s => s.key === 'chip').rank).toBe(1);
    expect(stages.find(s => s.key === 'cloud').rank).toBe(2);
    expect(stages.find(s => s.key === 'memory').rank).toBe(3);
  });

  it('有效环节不足 minStages → 不给自动卡点', () => {
    const metrics = [
      { key: 'chip', relReturnPct: 8, validTickerCount: 5 },
      { key: 'cloud', relReturnPct: null, validTickerCount: 0 },
    ];
    const { autoBottleneck, stages } = rankStages(metrics, 3);
    expect(autoBottleneck).toBe(null);
    expect(stages.find(s => s.key === 'chip').rank).toBe(1); // 排名仍展示
    expect(stages.find(s => s.key === 'cloud').rank).toBe(null);
  });
});

describe('fetchAiChainData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'test-or-key';
    chainCfg.YAHOO_CALL_DELAY_MS = 0; // 测试不等真实节流间隔
    // 防止 market-data 回退层缓存跨用例串数据 / 备用源key污染
    clearMarketDataCache();
    delete process.env.TIINGO_API_KEY;
    delete process.env.TWELVEDATA_API_KEY;
  });

  const flatBars = [{ close: 100 }, { close: 100 }];
  const upBars = [{ close: 100 }, { close: 110 }];
  const orRows = (() => {
    // 35个完整天，前28天100、近7天110（相对昨天为止）
    const rows = [];
    for (let i = 0; i < 35; i++) {
      const d = new Date(Date.UTC(2000, 0, 1) + 0); // 占位，实际用相对今天的日期
      const date = new Date(Date.now() - (35 - i) * 86400000).toISOString().slice(0, 10);
      rows.push({ date, model_permaslug: 'a/x', total_tokens: String(i < 28 ? 100 : 110) });
    }
    return rows;
  })();
  const capexRows = [
    { date: '2026-03-31', capitalExpenditure: -110 }, { date: '2025-12-31', capitalExpenditure: -110 },
    { date: '2025-09-30', capitalExpenditure: -110 }, { date: '2025-06-30', capitalExpenditure: -110 },
    { date: '2025-03-31', capitalExpenditure: -100 }, { date: '2024-12-31', capitalExpenditure: -100 },
    { date: '2024-09-30', capitalExpenditure: -100 }, { date: '2024-06-30', capitalExpenditure: -100 },
  ];

  it('正常返回：排名+卡点+调用量+资本开支', async () => {
    yahooFinance.historical.mockImplementation(sym =>
      Promise.resolve(sym === 'NVDA' ? upBars : flatBars));
    yahooFinance.fundamentalsTimeSeries.mockResolvedValue(capexRows);
    axios.get.mockResolvedValue({ data: { data: orRows } });

    const d = await fetchAiChainData();
    expect(d.autoBottleneck).toBe('chip'); // NVDA +10% 拉高 chip 环节
    expect(d.stages.find(s => s.key === 'chip').rank).toBe(1);
    expect(d.stages.find(s => s.key === 'model').relReturnPct).toBe(null); // model 不参与价格排名
    expect(d.modelUsageTrendPct).toBeCloseTo(10, 5);
    expect(d.capexYoY).toBeCloseTo(10, 5);
  });

  it('Yahoo 全挂：排名/资本开支 null，调用量仍有值', async () => {
    yahooFinance.historical.mockRejectedValue(new Error('429'));
    yahooFinance.fundamentalsTimeSeries.mockRejectedValue(new Error('429'));
    axios.get.mockResolvedValue({ data: { data: orRows } });

    const d = await fetchAiChainData();
    expect(d.autoBottleneck).toBe(null);
    expect(d.capexYoY).toBe(null);
    expect(d.modelUsageTrendPct).toBeCloseTo(10, 5);
  });

  it('OpenRouter 响应异常：调用量 null，排名不受影响', async () => {
    yahooFinance.historical.mockResolvedValue(flatBars);
    yahooFinance.fundamentalsTimeSeries.mockResolvedValue(capexRows);
    axios.get.mockResolvedValue({ data: { unexpected: true } });

    const d = await fetchAiChainData();
    expect(d.modelUsageTrendPct).toBe(null);
    expect(d.capexYoY).toBeCloseTo(10, 5);
  });

  it('无 OPENROUTER_API_KEY：不调 axios，调用量 null，不抛错', async () => {
    delete process.env.OPENROUTER_API_KEY;
    yahooFinance.historical.mockResolvedValue(flatBars);
    yahooFinance.fundamentalsTimeSeries.mockResolvedValue(capexRows);

    const d = await fetchAiChainData();
    expect(d.modelUsageTrendPct).toBe(null);
    expect(axios.get).not.toHaveBeenCalled();
  });
});
