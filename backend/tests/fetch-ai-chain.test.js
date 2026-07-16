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
  deriveQuarterlyCapex,
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

  it('最新季度过期（>400天，如换XBRL标签致数据冻结）→ 该公司剔除', () => {
    const dated = (latestEnd, vals) => vals.map((v, i) => {
      const d = new Date(latestEnd);
      d.setMonth(d.getMonth() - i * 3); // 每季往前3个月
      return { date: d.toISOString().slice(0, 10), capitalExpenditure: v };
    });
    const quarters = {
      FRESH: dated('2026-06-30', [-110, -110, -110, -110, -100, -100, -100, -100]),
      STALE: dated('2024-01-31', [-999, -999, -999, -999, -1, -1, -1, -1]), // 最新季>400天前 → 剔除
    };
    const r = calcCapexYoY(quarters);
    expect(r.capexYoY).toBeCloseTo(10, 5); // 只算 FRESH，STALE 不污染
    expect(r.capexTtm).toBe(440);
  });
});

// SEC XBRL facts → 离散季度值（10-Q 现金流按财年累计披露，需相邻相减）
describe('deriveQuarterlyCapex', () => {
  // 一个财年的 YTD 链：Q1(3月)、6月累计、9月累计、10-K 全年
  const ytdChain = (startYear, q1, h1, m9, fy) => [
    { start: `${startYear}-01-01`, end: `${startYear}-03-31`, val: q1, form: '10-Q' },
    { start: `${startYear}-01-01`, end: `${startYear}-06-30`, val: h1, form: '10-Q' },
    { start: `${startYear}-01-01`, end: `${startYear}-09-30`, val: m9, form: '10-Q' },
    { start: `${startYear}-01-01`, end: `${startYear}-12-31`, val: fy, form: '10-K' },
  ];

  it('YTD 累计链相减得出4个单季值', () => {
    const quarters = deriveQuarterlyCapex(ytdChain(2025, 100, 220, 350, 500));
    expect(quarters).toEqual([
      { date: '2025-12-31', capitalExpenditure: 150 },
      { date: '2025-09-30', capitalExpenditure: 130 },
      { date: '2025-06-30', capitalExpenditure: 120 },
      { date: '2025-03-31', capitalExpenditure: 100 },
    ]);
  });

  it('独立单季 fact 与 YTD 推导结果按季度末去重（后者覆盖）', () => {
    const facts = [
      ...ytdChain(2025, 100, 220, 350, 500),
      // MSFT 风格：同时披露独立单季值
      { start: '2025-04-01', end: '2025-06-30', val: 120, form: '10-Q' },
    ];
    const quarters = deriveQuarterlyCapex(facts);
    expect(quarters).toHaveLength(4);
    expect(quarters.find(x => x.date === '2025-06-30').capitalExpenditure).toBe(120);
  });

  it('缺 Q1 时半年累计不会被误当单季（时长超120天跳过）', () => {
    const facts = [
      { start: '2025-01-01', end: '2025-06-30', val: 220, form: '10-Q' },
      { start: '2025-01-01', end: '2025-09-30', val: 350, form: '10-Q' },
    ];
    const quarters = deriveQuarterlyCapex(facts);
    expect(quarters).toEqual([{ date: '2025-09-30', capitalExpenditure: 130 }]);
  });

  it('非 10-Q/10-K 表单与无效值被过滤', () => {
    const facts = [
      { start: '2025-01-01', end: '2025-03-31', val: 100, form: '8-K' },
      { start: '2025-01-01', end: '2025-03-31', form: '10-Q' }, // 无 val
    ];
    expect(deriveQuarterlyCapex(facts)).toEqual([]);
    expect(deriveQuarterlyCapex(null)).toEqual([]);
  });
});

describe('calcStageRelReturns / rankStages', () => {
  const bars = closes => closes.map((c, i) => ({ date: `2024-01-0${i + 1}`, close: c }));
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

  const flatBars = [{ date: '2024-01-01', close: 100 }, { date: '2024-01-02', close: 100 }];
  const upBars = [{ date: '2024-01-01', close: 100 }, { date: '2024-01-02', close: 110 }];
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
  // SEC EDGAR facts：两个财年的 YTD 链，每季110/100 → TTM 440 vs 400 → +10%
  const edgarFacts = [
    { start: '2025-01-01', end: '2025-03-31', val: 100, form: '10-Q' },
    { start: '2025-01-01', end: '2025-06-30', val: 200, form: '10-Q' },
    { start: '2025-01-01', end: '2025-09-30', val: 300, form: '10-Q' },
    { start: '2025-01-01', end: '2025-12-31', val: 400, form: '10-K' },
    { start: '2026-01-01', end: '2026-03-31', val: 110, form: '10-Q' },
    { start: '2026-01-01', end: '2026-06-30', val: 220, form: '10-Q' },
    { start: '2026-01-01', end: '2026-09-30', val: 330, form: '10-Q' },
    { start: '2026-01-01', end: '2026-12-31', val: 440, form: '10-K' },
  ];

  // axios 按 URL 分发：sec.gov → EDGAR capex；其余（openrouter）→ 调用量数据
  function mockAxiosByHost({ edgar = { data: { units: { USD: edgarFacts } } }, openrouter = { data: { data: null } } } = {}) {
    axios.get.mockImplementation(url => {
      if (url.includes('sec.gov')) {
        return edgar instanceof Error ? Promise.reject(edgar) : Promise.resolve(edgar);
      }
      return openrouter instanceof Error ? Promise.reject(openrouter) : Promise.resolve(openrouter);
    });
  }

  it('正常返回：排名+卡点+调用量+资本开支', async () => {
    yahooFinance.historical.mockImplementation(sym =>
      Promise.resolve(sym === 'NVDA' ? upBars : flatBars));
    mockAxiosByHost({ openrouter: { data: { data: orRows } } });

    const d = await fetchAiChainData();
    expect(d.autoBottleneck).toBe('chip'); // NVDA +10% 拉高 chip 环节
    expect(d.stages.find(s => s.key === 'chip').rank).toBe(1);
    expect(d.stages.find(s => s.key === 'model').relReturnPct).toBe(null); // model 不参与价格排名
    expect(d.modelUsageTrendPct).toBeCloseTo(10, 5);
    expect(d.capexYoY).toBeCloseTo(10, 5);
  });

  it('Yahoo 全挂：排名 null，EDGAR资本开支与调用量仍有值', async () => {
    yahooFinance.historical.mockRejectedValue(new Error('429'));
    mockAxiosByHost({ openrouter: { data: { data: orRows } } });

    const d = await fetchAiChainData();
    expect(d.autoBottleneck).toBe(null);
    expect(d.capexYoY).toBeCloseTo(10, 5); // capex 走 EDGAR，不受 Yahoo 影响
    expect(d.modelUsageTrendPct).toBeCloseTo(10, 5);
  });

  it('EDGAR 挂：资本开支 null，排名与调用量不受影响', async () => {
    yahooFinance.historical.mockResolvedValue(flatBars);
    mockAxiosByHost({ edgar: new Error('503'), openrouter: { data: { data: orRows } } });

    const d = await fetchAiChainData();
    expect(d.capexYoY).toBe(null);
    expect(d.modelUsageTrendPct).toBeCloseTo(10, 5);
  });

  it('OpenRouter 响应异常：调用量 null，资本开支不受影响', async () => {
    yahooFinance.historical.mockResolvedValue(flatBars);
    mockAxiosByHost({ openrouter: { data: { unexpected: true } } });

    const d = await fetchAiChainData();
    expect(d.modelUsageTrendPct).toBe(null);
    expect(d.capexYoY).toBeCloseTo(10, 5);
  });

  it('无 OPENROUTER_API_KEY：调用量 null 且不请求 openrouter，不抛错', async () => {
    delete process.env.OPENROUTER_API_KEY;
    yahooFinance.historical.mockResolvedValue(flatBars);
    mockAxiosByHost();

    const d = await fetchAiChainData();
    expect(d.modelUsageTrendPct).toBe(null);
    expect(axios.get.mock.calls.every(c => c[0].includes('sec.gov'))).toBe(true);
  });
});
