// capex 指引自动检测（fetch-guidance.js）单测：
// 段落截取/快报统计的纯函数逻辑 + 8-K 筛选/新闻稿抓取/LLM 分析/web 检索兜底/N3 自动录入的 mock 流程
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
vi.mock('yahoo-finance2', () => ({
  default: { historical: vi.fn(), quote: vi.fn(), quoteSummary: vi.fn(), fundamentalsTimeSeries: vi.fn() },
}));
vi.mock('../utils/storage.js', () => ({
  getProcessedGuidanceAccessions: vi.fn().mockResolvedValue([]),
  saveGuidanceRecord: vi.fn().mockResolvedValue(undefined),
  setAdminSignal: vi.fn().mockResolvedValue(undefined),
  getActiveAdminSignal: vi.fn().mockResolvedValue(null),
  getAlertSubscribers: vi.fn().mockResolvedValue([]),
}));
vi.mock('../utils/mailer.js', () => ({
  sendSignalAlert: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
}));

import {
  extractCapexParagraphs,
  findNewEarningsFilings,
  processCapexGuidance,
  computeCapexStats,
  latestCompletedQuarterEnd,
  webCutQualified,
} from '../api/fetch-guidance.js';
import {
  saveGuidanceRecord,
  setAdminSignal,
  getActiveAdminSignal,
} from '../utils/storage.js';

// LLM 回复构造：press=新闻稿分析（无 plugins），web=检索兜底（带 plugins）
const llmReply = obj => ({ data: { choices: [{ message: { content: JSON.stringify(obj) } }] } });

describe('extractCapexParagraphs', () => {
  it('无关键词 → null', () => {
    expect(extractCapexParagraphs('revenue grew 20% year over year')).toBe(null);
    expect(extractCapexParagraphs(null)).toBe(null);
  });

  it('截取关键词±600字符，相邻命中合并', () => {
    const pad = 'x'.repeat(700);
    const text = `${pad} capital expenditures were $10B ${pad}`;
    const out = extractCapexParagraphs(text);
    expect(out).toContain('capital expenditures were $10B');
    expect(out.length).toBeLessThanOrEqual(1300); // ±600 + 关键词长度
  });

  it('相距远的两处命中用分隔符连接且限长', () => {
    const gap = 'y'.repeat(3000);
    const text = `capex plan A ${gap} capital expenditure plan B`;
    const out = extractCapexParagraphs(text, 4000);
    expect(out).toContain('...');
    expect(out.length).toBeLessThanOrEqual(4000);
  });
});

describe('findNewEarningsFilings', () => {
  beforeEach(() => vi.clearAllMocks());

  const submissionsFor = rows => ({
    data: {
      filings: {
        recent: {
          form: rows.map(r => r.form),
          items: rows.map(r => r.items),
          filingDate: rows.map(r => r.date),
          accessionNumber: rows.map(r => r.acc),
        },
      },
    },
  });

  it('只取近10天内 item 2.02 的 8-K，过滤已处理', async () => {
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockResolvedValue(submissionsFor([
      { form: '8-K', items: '2.02,9.01', date: today, acc: 'ACC-NEW' },
      { form: '8-K', items: '5.02', date: today, acc: 'ACC-NOT202' },
      { form: '10-Q', items: '', date: today, acc: 'ACC-10Q' },
      { form: '8-K', items: '2.02', date: '2020-01-01', acc: 'ACC-OLD' },
    ]));
    const out = await findNewEarningsFilings(new Set(['ACC-PROCESSED']));
    // 四家公司同一 mock：每家返回一条 ACC-NEW
    expect(out).toHaveLength(4);
    expect(out.every(f => f.accession === 'ACC-NEW')).toBe(true);
  });

  it('已处理的 accession 不再返回', async () => {
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockResolvedValue(submissionsFor([
      { form: '8-K', items: '2.02', date: today, acc: 'ACC-DONE' },
    ]));
    const out = await findNewEarningsFilings(new Set(['ACC-DONE']));
    expect(out).toHaveLength(0);
  });

  it('单家 submissions 失败不影响其他家', async () => {
    const today = new Date().toISOString().slice(0, 10);
    let call = 0;
    axios.get.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.reject(new Error('503'));
      return Promise.resolve(submissionsFor([
        { form: '8-K', items: '2.02', date: today, acc: `ACC-${call}` },
      ]));
    });
    const out = await findNewEarningsFilings(new Set());
    expect(out).toHaveLength(3); // 4家中1家失败
  });
});

describe('processCapexGuidance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks 不清 mockResolvedValue 实现——幂等用例改写的 getActiveAdminSignal 会泄漏，显式复位
    getActiveAdminSignal.mockResolvedValue(null);
    delete process.env.OPENROUTER_API_KEY;
    // FMP 备源 key 清空：快报统计在单测中走"无 key → null"路径，不发真实请求
    delete process.env.FMP_API_KEY;
    delete process.env.financialmodelingprep_API_KEY;
  });

  it('无新申报 → {checked: 0}，不触碰存储', async () => {
    axios.get.mockResolvedValue({ data: { filings: { recent: { form: [], items: [], filingDate: [], accessionNumber: [] } } } });
    const r = await processCapexGuidance();
    expect(r).toEqual({ checked: 0 });
    expect(saveGuidanceRecord).not.toHaveBeenCalled();
  });

  it('明确下修+高置信 → 自动录入 N3 事件并存档', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockImplementation(url => {
      if (url.includes('data.sec.gov/submissions/CIK0000789019')) {
        // 仅 MSFT 有新 8-K，其余家空
        return Promise.resolve({ data: { filings: { recent: {
          form: ['8-K'], items: ['2.02'], filingDate: [today], accessionNumber: ['0000789019-26-000099'],
        } } } });
      }
      if (url.includes('data.sec.gov/submissions/')) {
        return Promise.resolve({ data: { filings: { recent: { form: [], items: [], filingDate: [], accessionNumber: [] } } } });
      }
      if (url.includes('index.json')) {
        return Promise.resolve({ data: { directory: { item: [{ name: 'ex991.htm' }] } } });
      }
      // EX-99 正文
      return Promise.resolve({ data: '<p>We now expect capital expenditures for fiscal 2027 to be significantly lower than prior guidance.</p>' });
    });
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content:
      '{"hasGuidance": true, "direction": "cut", "quote": "capex significantly lower than prior guidance", "confidence": "high"}' } }] } });

    const r = await processCapexGuidance();
    expect(r.checked).toBe(1);
    expect(r.autoEvents).toBe(1);
    expect(setAdminSignal).toHaveBeenCalledWith(
      'capex_guidance', 'tight', expect.any(String), expect.stringContaining('MSFT'), 'auto-detector');
    expect(saveGuidanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'MSFT', direction: 'cut', confidence: 'high', autoEventCreated: 1,
    }));
  });

  it('已有活动 N3 事件时不重复录入（幂等）', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    getActiveAdminSignal.mockResolvedValue({ id: 1, type: 'capex_guidance', signal: 'tight' });
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockImplementation(url => {
      if (url.includes('CIK0000789019')) {
        return Promise.resolve({ data: { filings: { recent: {
          form: ['8-K'], items: ['2.02'], filingDate: [today], accessionNumber: ['0000789019-26-000100'],
        } } } });
      }
      if (url.includes('data.sec.gov/submissions/')) {
        return Promise.resolve({ data: { filings: { recent: { form: [], items: [], filingDate: [], accessionNumber: [] } } } });
      }
      if (url.includes('index.json')) {
        return Promise.resolve({ data: { directory: { item: [{ name: 'ex991.htm' }] } } });
      }
      return Promise.resolve({ data: 'capital expenditures guidance cut sharply' });
    });
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content:
      '{"hasGuidance": true, "direction": "cut", "quote": "cut", "confidence": "high"}' } }] } });

    const r = await processCapexGuidance();
    expect(r.autoEvents).toBe(0);
    expect(setAdminSignal).not.toHaveBeenCalled();
  });

  it('raise/maintain 方向只存档不建事件', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockImplementation(url => {
      if (url.includes('CIK0001326801')) {
        return Promise.resolve({ data: { filings: { recent: {
          form: ['8-K'], items: ['2.02'], filingDate: [today], accessionNumber: ['0001326801-26-000050'],
        } } } });
      }
      if (url.includes('data.sec.gov/submissions/')) {
        return Promise.resolve({ data: { filings: { recent: { form: [], items: [], filingDate: [], accessionNumber: [] } } } });
      }
      if (url.includes('index.json')) {
        return Promise.resolve({ data: { directory: { item: [{ name: 'pressrelease.htm' }] } } });
      }
      return Promise.resolve({ data: 'we anticipate capital expenditures in the range of $66-72 billion, raised from prior outlook' });
    });
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content:
      '{"hasGuidance": true, "direction": "raise", "quote": "raised from prior outlook", "confidence": "high"}' } }] } });

    const r = await processCapexGuidance();
    expect(r.autoEvents).toBe(0);
    expect(setAdminSignal).not.toHaveBeenCalled();
    expect(saveGuidanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'META', direction: 'raise', autoEventCreated: 0,
    }));
  });

  it('LLM 失败 → 不存档不标已处理（次日重试），主链路不抛', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockImplementation(url => {
      if (url.includes('CIK0001652044')) {
        return Promise.resolve({ data: { filings: { recent: {
          form: ['8-K'], items: ['2.02'], filingDate: [today], accessionNumber: ['0001652044-26-000060'],
        } } } });
      }
      if (url.includes('data.sec.gov/submissions/')) {
        return Promise.resolve({ data: { filings: { recent: { form: [], items: [], filingDate: [], accessionNumber: [] } } } });
      }
      if (url.includes('index.json')) {
        return Promise.resolve({ data: { directory: { item: [{ name: 'ex99.htm' }] } } });
      }
      return Promise.resolve({ data: 'capital expenditures were $35.7 billion' });
    });
    axios.post.mockRejectedValue(new Error('LLM 402'));

    const r = await processCapexGuidance();
    expect(r.checked).toBe(1);
    // 关键断言：LLM 不可用时不能落档——落了就永久标记已处理，档案定格为错误的 none
    expect(saveGuidanceRecord).not.toHaveBeenCalled();
    expect(setAdminSignal).not.toHaveBeenCalled();
  });

  it('新闻稿无 capex 段落 → web 检索兜底也未见指引 → 存档 none/source=web', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockImplementation(url => {
      if (url.includes('CIK0001652044')) {
        return Promise.resolve({ data: { filings: { recent: {
          form: ['8-K'], items: ['2.02'], filingDate: [today], accessionNumber: ['0001652044-26-000061'],
        } } } });
      }
      if (url.includes('data.sec.gov/submissions/')) {
        return Promise.resolve({ data: { filings: { recent: { form: [], items: [], filingDate: [], accessionNumber: [] } } } });
      }
      if (url.includes('index.json')) {
        return Promise.resolve({ data: { directory: { item: [{ name: 'ex99.htm' }] } } });
      }
      return Promise.resolve({ data: 'revenue grew 20% year over year' });
    });
    axios.post.mockResolvedValue(llmReply({
      hasGuidance: false, direction: 'none', quote: '', confidence: 'low',
      fyGuidance: '', forwardGuidance: '', sources: [],
    }));

    const r = await processCapexGuidance();
    expect(r.checked).toBe(1);
    expect(axios.post).toHaveBeenCalledTimes(1); // 无段落不调新闻稿LLM，只调web兜底
    expect(axios.post.mock.calls[0][1].plugins).toEqual([{ id: 'web', max_results: 5 }]);
    expect(saveGuidanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'GOOGL', direction: 'none', source: 'web', autoEventCreated: 0,
    }));
  });

  it('新闻稿有capex段落但无指引 → web 兜底检出上修 → 存档 raise/source=web 含指引摘要', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockImplementation(url => {
      if (url.includes('CIK0001652044')) {
        return Promise.resolve({ data: { filings: { recent: {
          form: ['8-K'], items: ['2.02'], filingDate: [today], accessionNumber: ['0001652044-26-000066'],
        } } } });
      }
      if (url.includes('data.sec.gov/submissions/')) {
        return Promise.resolve({ data: { filings: { recent: { form: [], items: [], filingDate: [], accessionNumber: [] } } } });
      }
      if (url.includes('index.json')) {
        return Promise.resolve({ data: { directory: { item: [{ name: 'googexhibit991.htm' }] } } });
      }
      return Promise.resolve({ data: 'purchases of property and equipment (44,924) ... capital expenditures' });
    });
    // 第1次=新闻稿分析（无指引），第2次=web检索（检出上修）
    axios.post.mockImplementation((url, body) => {
      if (body.plugins) {
        return Promise.resolve(llmReply({
          hasGuidance: true, direction: 'raise', quote: 'capex guidance raised to $195-205 billion',
          confidence: 'high', fyGuidance: 'FY2026 $195-205B, raised from $185B',
          forwardGuidance: 'further increase expected in 2027',
          sources: ['https://www.cnbc.com/2026/07/22/google-earnings.html'],
        }));
      }
      return Promise.resolve(llmReply({
        hasGuidance: false, direction: 'none', quote: '', confidence: 'low',
        fyGuidance: '', forwardGuidance: '', qtrCapexUsdMillions: 44924,
      }));
    });

    const r = await processCapexGuidance();
    expect(r.checked).toBe(1);
    expect(r.autoEvents).toBe(0);
    expect(saveGuidanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'GOOGL', direction: 'raise', source: 'web',
      fyGuidance: 'FY2026 $195-205B, raised from $185B',
      forwardGuidance: 'further increase expected in 2027',
      sources: JSON.stringify(['https://www.cnbc.com/2026/07/22/google-earnings.html']),
    }));
  });

  it('web 源下修未达佐证门槛（单一来源+非一手）→ 只存档不建 N3，醒目日志请人工核实', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockImplementation(url => {
      if (url.includes('CIK0001018724')) {
        return Promise.resolve({ data: { filings: { recent: {
          form: ['8-K'], items: ['2.02'], filingDate: [today], accessionNumber: ['0001018724-26-000077'],
        } } } });
      }
      if (url.includes('data.sec.gov/submissions/')) {
        return Promise.resolve({ data: { filings: { recent: { form: [], items: [], filingDate: [], accessionNumber: [] } } } });
      }
      if (url.includes('index.json')) {
        return Promise.resolve({ data: { directory: { item: [{ name: 'ex991.htm' }] } } });
      }
      return Promise.resolve({ data: 'no relevant keywords here' });
    });
    axios.post.mockResolvedValue(llmReply({
      hasGuidance: true, direction: 'cut', quote: 'capex will be significantly lower',
      confidence: 'high', fyGuidance: 'FY2026 cut to $80B', forwardGuidance: '',
      sources: ['https://reuters.com/x'], primarySource: false,
    }));

    const r = await processCapexGuidance();
    expect(r.autoEvents).toBe(0);
    expect(setAdminSignal).not.toHaveBeenCalled(); // 关键断言：单源非一手的下修不自动录N3
    expect(saveGuidanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'cut', source: 'web', autoEventCreated: 0,
    }));
  });

  it('web 源下修达佐证门槛（≥2独立来源）→ 自动录入 N3（2026-07-23 用户拍板放开）', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockImplementation(url => {
      if (url.includes('CIK0001018724')) {
        return Promise.resolve({ data: { filings: { recent: {
          form: ['8-K'], items: ['2.02'], filingDate: [today], accessionNumber: ['0001018724-26-000078'],
        } } } });
      }
      if (url.includes('data.sec.gov/submissions/')) {
        return Promise.resolve({ data: { filings: { recent: { form: [], items: [], filingDate: [], accessionNumber: [] } } } });
      }
      if (url.includes('index.json')) {
        return Promise.resolve({ data: { directory: { item: [{ name: 'ex991.htm' }] } } });
      }
      return Promise.resolve({ data: 'no relevant keywords here' });
    });
    axios.post.mockResolvedValue(llmReply({
      hasGuidance: true, direction: 'cut', quote: 'we are reducing our capex plans for the year',
      confidence: 'high', fyGuidance: 'FY2026 cut to $80B', forwardGuidance: '',
      sources: ['https://reuters.com/x', 'https://cnbc.com/y'], primarySource: false,
    }));

    const r = await processCapexGuidance();
    expect(r.autoEvents).toBe(1);
    expect(setAdminSignal).toHaveBeenCalledWith(
      'capex_guidance', 'tight', expect.any(String), expect.stringContaining('电话会/媒体检索'), 'auto-detector');
    expect(saveGuidanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'cut', source: 'web', autoEventCreated: 1,
    }));
  });

  it('新闻稿判维持但 web 检出达标下修（一手来源）→ 方向覆盖为 cut 并录 N3', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockImplementation(url => {
      if (url.includes('CIK0000789019')) {
        return Promise.resolve({ data: { filings: { recent: {
          form: ['8-K'], items: ['2.02'], filingDate: [today], accessionNumber: ['0000789019-26-000101'],
        } } } });
      }
      if (url.includes('data.sec.gov/submissions/')) {
        return Promise.resolve({ data: { filings: { recent: { form: [], items: [], filingDate: [], accessionNumber: [] } } } });
      }
      if (url.includes('index.json')) {
        return Promise.resolve({ data: { directory: { item: [{ name: 'ex991.htm' }] } } });
      }
      return Promise.resolve({ data: 'capital expenditures in line with prior expectations' });
    });
    axios.post.mockImplementation((url, body) => {
      if (body.plugins) {
        return Promise.resolve(llmReply({
          hasGuidance: true, direction: 'cut', quote: 'on the call, CFO said capex will come down meaningfully next fiscal year',
          confidence: 'high', fyGuidance: 'FY2027 capex to decline', forwardGuidance: '',
          sources: ['https://fool.com/transcript'], primarySource: true,
        }));
      }
      return Promise.resolve(llmReply({
        hasGuidance: true, direction: 'maintain', quote: 'in line with prior expectations',
        confidence: 'high', fyGuidance: '', forwardGuidance: '',
      }));
    });

    const r = await processCapexGuidance();
    expect(r.autoEvents).toBe(1);
    expect(setAdminSignal).toHaveBeenCalled();
    expect(saveGuidanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'cut', source: 'web', autoEventCreated: 1, // 电话会下修覆盖新闻稿maintain
    }));
  });

  it('新闻稿有指引但 web 检索失败 → 不落档窗口内重试；新闻稿下修的 N3 仍即刻录入不等 web', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockImplementation(url => {
      if (url.includes('CIK0000789019')) {
        return Promise.resolve({ data: { filings: { recent: {
          form: ['8-K'], items: ['2.02'], filingDate: [today], accessionNumber: ['0000789019-26-000102'],
        } } } });
      }
      if (url.includes('data.sec.gov/submissions/')) {
        return Promise.resolve({ data: { filings: { recent: { form: [], items: [], filingDate: [], accessionNumber: [] } } } });
      }
      if (url.includes('index.json')) {
        return Promise.resolve({ data: { directory: { item: [{ name: 'ex991.htm' }] } } });
      }
      return Promise.resolve({ data: 'we now expect capital expenditures to be significantly lower than prior guidance' });
    });
    axios.post.mockImplementation((url, body) => {
      if (body.plugins) return Promise.reject(new Error('web plugin 503'));
      return Promise.resolve(llmReply({
        hasGuidance: true, direction: 'cut', quote: 'significantly lower than prior guidance', confidence: 'high',
        fyGuidance: '', forwardGuidance: '',
      }));
    });

    const r = await processCapexGuidance();
    expect(r.checked).toBe(1);
    expect(saveGuidanceRecord).not.toHaveBeenCalled(); // web 是必需源：失败不落档，窗口内重试
    expect(setAdminSignal).toHaveBeenCalledWith( // 但防守动作不过夜：新闻稿下修即刻录N3
      'capex_guidance', 'tight', expect.any(String), expect.stringContaining('业绩新闻稿'), 'auto-detector');
    expect(r.autoEvents).toBe(1);
  });

  it('新闻稿有指引但缺未来指引 → web 补齐 forwardGuidance，方向保留新闻稿口径', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockImplementation(url => {
      if (url.includes('CIK0001326801')) {
        return Promise.resolve({ data: { filings: { recent: {
          form: ['8-K'], items: ['2.02'], filingDate: [today], accessionNumber: ['0001326801-26-000051'],
        } } } });
      }
      if (url.includes('data.sec.gov/submissions/')) {
        return Promise.resolve({ data: { filings: { recent: { form: [], items: [], filingDate: [], accessionNumber: [] } } } });
      }
      if (url.includes('index.json')) {
        return Promise.resolve({ data: { directory: { item: [{ name: 'pressrelease.htm' }] } } });
      }
      return Promise.resolve({ data: 'we anticipate capital expenditures in the range of $66-72 billion' });
    });
    axios.post.mockImplementation((url, body) => {
      if (body.plugins) {
        return Promise.resolve(llmReply({
          hasGuidance: true, direction: 'raise', quote: 'meaningfully higher capex in 2027',
          confidence: 'high', fyGuidance: 'FY2026 $66-72B', forwardGuidance: 'meaningfully higher capex growth in 2027',
          sources: ['https://cnbc.com/meta'], primarySource: true,
        }));
      }
      return Promise.resolve(llmReply({
        hasGuidance: true, direction: 'raise', quote: 'raised to $66-72 billion', confidence: 'high',
        fyGuidance: 'FY2026 $66-72B', forwardGuidance: '',
      }));
    });

    const r = await processCapexGuidance();
    expect(r.autoEvents).toBe(0);
    expect(saveGuidanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'META', direction: 'raise', source: 'press_release', // 方向保留新闻稿
      forwardGuidance: 'meaningfully higher capex growth in 2027', // 未来指引由web补齐
      sources: JSON.stringify(['https://cnbc.com/meta']),
    }));
  });
  it('新闻稿无指引且 web 检索失败 → 不存档不标已处理（次日重试）', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const today = new Date().toISOString().slice(0, 10);
    axios.get.mockImplementation(url => {
      if (url.includes('CIK0001652044')) {
        return Promise.resolve({ data: { filings: { recent: {
          form: ['8-K'], items: ['2.02'], filingDate: [today], accessionNumber: ['0001652044-26-000062'],
        } } } });
      }
      if (url.includes('data.sec.gov/submissions/')) {
        return Promise.resolve({ data: { filings: { recent: { form: [], items: [], filingDate: [], accessionNumber: [] } } } });
      }
      if (url.includes('index.json')) {
        return Promise.resolve({ data: { directory: { item: [{ name: 'ex99.htm' }] } } });
      }
      return Promise.resolve({ data: 'no relevant keywords here' });
    });
    axios.post.mockRejectedValue(new Error('web plugin 402'));

    const r = await processCapexGuidance();
    expect(r.checked).toBe(1);
    // 关键断言：web 检索不可用时不能落档——落了就永久标记已处理，档案定格为错误的 none
    expect(saveGuidanceRecord).not.toHaveBeenCalled();
  });
});

describe('webCutQualified（N3 佐证门槛纯函数）', () => {
  const base = { hasGuidance: true, direction: 'cut', confidence: 'high', sources: [], primarySource: false };
  it('cut/high + 一手来源 → 达标', () => {
    expect(webCutQualified({ ...base, primarySource: true })).toBe(true);
  });
  it('cut/high + ≥2 独立来源 → 达标', () => {
    expect(webCutQualified({ ...base, sources: ['a', 'b'] })).toBe(true);
  });
  it('cut/high 但单一来源且非一手 → 不达标', () => {
    expect(webCutQualified({ ...base, sources: ['a'] })).toBe(false);
  });
  it('低置信/非cut/无指引/null → 不达标', () => {
    expect(webCutQualified({ ...base, confidence: 'low', primarySource: true })).toBe(false);
    expect(webCutQualified({ ...base, direction: 'maintain', primarySource: true })).toBe(false);
    expect(webCutQualified({ ...base, hasGuidance: false, primarySource: true })).toBe(false);
    expect(webCutQualified(null)).toBe(false);
  });
});

describe('latestCompletedQuarterEnd', () => {
  it('申报日 → 上一个已结束的日历季度末', () => {
    expect(latestCompletedQuarterEnd('2026-07-22')).toBe('2026-06-30');
    expect(latestCompletedQuarterEnd('2026-04-02')).toBe('2026-03-31');
    expect(latestCompletedQuarterEnd('2026-10-05')).toBe('2026-09-30');
    expect(latestCompletedQuarterEnd('2026-01-15')).toBe('2025-12-31'); // 跨年
  });
});

describe('computeCapexStats', () => {
  // GOOGL 真实量级（百万→美元简化为直接数值），降序
  const edgar = [
    { date: '2026-03-31', capitalExpenditure: -35674 },
    { date: '2025-12-31', capitalExpenditure: -27851 },
    { date: '2025-09-30', capitalExpenditure: -23953 },
    { date: '2025-06-30', capitalExpenditure: -22452 },
    { date: '2025-03-31', capitalExpenditure: -17197 },
    { date: '2024-12-31', capitalExpenditure: -14276 },
    { date: '2024-09-30', capitalExpenditure: -13061 },
    { date: '2024-06-30', capitalExpenditure: -13186 },
  ];

  it('EDGAR 8季 + 新季值 → 单季/TTM 额度与同比', () => {
    const s = computeCapexStats(edgar, { date: '2026-06-30', value: 44924 });
    expect(s.qtrEnd).toBe('2026-06-30');
    expect(s.qtrCapex).toBe(44924);
    expect(s.qtrCapexYoY).toBeCloseTo((44924 / 22452 - 1) * 100, 1); // ≈+100.1%
    expect(s.ttmCapex).toBe(44924 + 35674 + 27851 + 23953); // 132402
    expect(s.ttmCapexYoY).toBeCloseTo((132402 / 66986 - 1) * 100, 1); // ≈+97.7%
  });

  it('EDGAR 已含该季（10-Q已出）→ 官方值优先，新季值不覆盖', () => {
    const s = computeCapexStats(edgar, { date: '2026-03-31', value: 99999 });
    expect(s.qtrCapex).toBe(35674); // EDGAR 原值
  });

  it('无新季值 → 按 EDGAR 最新季如实计算并标注季度末', () => {
    const s = computeCapexStats(edgar, null);
    expect(s.qtrEnd).toBe('2026-03-31');
    expect(s.qtrCapex).toBe(35674);
    expect(s.qtrCapexYoY).toBeCloseTo((35674 / 17197 - 1) * 100, 1);
  });

  it('缺上年同季 → 同比 null 不凑数；TTM 链断裂 → TTM null', () => {
    const shortSeries = edgar.slice(0, 3); // 只有3季
    const s = computeCapexStats(shortSeries, { date: '2026-06-30', value: 44924 });
    expect(s.qtrCapex).toBe(44924);
    expect(s.qtrCapexYoY).toBe(null); // 无 2025Q2
    expect(s.ttmCapex).toBe(44924 + 35674 + 27851 + 23953); // 恰好4季
    expect(s.ttmCapexYoY).toBe(null); // 无上年TTM
  });

  it('空序列 + 无新季 → 全 null', () => {
    expect(computeCapexStats([], null)).toEqual({
      qtrEnd: null, qtrCapex: null, qtrCapexYoY: null, ttmCapex: null, ttmCapexYoY: null,
    });
    expect(computeCapexStats(null, null).qtrCapex).toBe(null);
  });
});
