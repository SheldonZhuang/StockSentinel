import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

import axios from 'axios';
import { parseRssItems, fetchAiSupplyNews } from '../api/fetch-rss.js';

const sampleXml = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[NVIDIA Announces Blackwell Ultra]]></title><link>https://nvidianews.nvidia.com/a</link><pubDate>Wed, 08 Jul 2026 12:00:00 GMT</pubDate></item>
<item><title>HBM4 &amp; Foundry Update</title><link>https://trendforce.com/b</link><pubDate>Tue, 07 Jul 2026 08:00:00 GMT</pubDate></item>
<item><title>No Link Item</title></item>
</channel></rss>`;

describe('parseRssItems', () => {
  it('解析 title/link/pubDate，CDATA 与实体正确处理', () => {
    const items = parseRssItems(sampleXml);
    expect(items).toEqual([
      { title: 'NVIDIA Announces Blackwell Ultra', url: 'https://nvidianews.nvidia.com/a', date: '2026-07-08' },
      { title: 'HBM4 & Foundry Update', url: 'https://trendforce.com/b', date: '2026-07-07' },
    ]);
  });

  it('缺 link 的条目被跳过；空输入返回空数组', () => {
    expect(parseRssItems(sampleXml)).toHaveLength(2);
    expect(parseRssItems('')).toEqual([]);
    expect(parseRssItems(null)).toEqual([]);
  });
});

describe('fetchAiSupplyNews', () => {
  beforeEach(() => vi.clearAllMocks());

  it('多源合并按日期降序，type 为来源名', async () => {
    axios.get.mockImplementation(url => {
      if (url.includes('nvidianews')) {
        return Promise.resolve({ data: '<item><title>A</title><link>https://n/a</link><pubDate>Wed, 08 Jul 2026 00:00:00 GMT</pubDate></item>' });
      }
      if (url.includes('trendforce')) {
        return Promise.resolve({ data: '<item><title>B</title><link>https://t/b</link><pubDate>Thu, 09 Jul 2026 00:00:00 GMT</pubDate></item>' });
      }
      return Promise.resolve({ data: '' });
    });
    const docs = await fetchAiSupplyNews();
    expect(docs[0]).toEqual({ title: 'B', url: 'https://t/b', date: '2026-07-09', type: 'TrendForce' });
    expect(docs[1].type).toBe('NVIDIA Newsroom');
  });

  it('单源失败不影响其他源，不抛错', async () => {
    axios.get.mockImplementation(url => {
      if (url.includes('trendforce')) return Promise.reject(new Error('timeout'));
      return Promise.resolve({ data: '<item><title>A</title><link>https://n/a</link><pubDate>Wed, 08 Jul 2026 00:00:00 GMT</pubDate></item>' });
    });
    const docs = await fetchAiSupplyNews();
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every(d => d.type !== 'TrendForce')).toBe(true);
  });
});
