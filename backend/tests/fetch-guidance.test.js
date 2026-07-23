// capex 指引自动检测（fetch-guidance.js）单测：
// 段落截取的纯函数逻辑 + 8-K 筛选/新闻稿抓取/LLM 分析/N3 自动录入的 mock 流程
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
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
} from '../api/fetch-guidance.js';
import {
  saveGuidanceRecord,
  setAdminSignal,
  getActiveAdminSignal,
} from '../utils/storage.js';

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
    delete process.env.OPENROUTER_API_KEY;
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

  it('新闻稿无 capex 段落 → 正常存档 none（不属于失败，不重试）', async () => {
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

    const r = await processCapexGuidance();
    expect(r.checked).toBe(1);
    expect(axios.post).not.toHaveBeenCalled(); // 无段落不调 LLM
    expect(saveGuidanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'GOOGL', direction: 'none', autoEventCreated: 0,
    }));
  });
});
