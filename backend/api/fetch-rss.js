import axios from 'axios';

// AI供需参考素材源：英伟达官方新闻稿 + 英伟达博客 + TrendForce（覆盖存储/半导体行业动态）
// 均为公开 RSS，无需key；单源失败不影响其他源
const AI_SUPPLY_FEEDS = [
  { source: 'NVIDIA Newsroom', url: 'https://nvidianews.nvidia.com/releases.xml' },
  { source: 'NVIDIA Blog', url: 'https://blogs.nvidia.com/feed/' },
  { source: 'TrendForce', url: 'https://www.trendforce.com/news/feed/' },
];

const stripCdata = s => s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
const decodeEntities = s => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#8217;/g, '’');

/**
 * 极简 RSS 解析：提取 <item> 的 title/link/pubDate（不引入 XML 解析依赖）
 * @returns {Array<{title, url, date}>} date 为 YYYY-MM-DD，解析失败的字段置空
 */
export function parseRssItems(xml, limit = 20) {
  const items = [];
  const itemBlocks = String(xml || '').match(/<item[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks.slice(0, limit)) {
    const pick = tag => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? decodeEntities(stripCdata(m[1].trim())) : '';
    };
    const title = pick('title');
    const url = pick('link');
    if (!title || !url) continue;
    const pubDate = pick('pubDate');
    const parsed = pubDate ? new Date(pubDate) : null;
    items.push({
      title,
      url,
      date: parsed && !isNaN(parsed) ? parsed.toISOString().slice(0, 10) : '',
    });
  }
  return items;
}

/**
 * 拉取AI供需参考新闻：三源并行、单源容错、按日期降序合并
 * @returns {Array<{title, date, type, url}>} type 字段放来源名，与 Federal Register 返回结构对齐
 */
export async function fetchAiSupplyNews(limit = 20) {
  const results = await Promise.all(
    AI_SUPPLY_FEEDS.map(async ({ source, url }) => {
      try {
        const res = await axios.get(url, {
          timeout: 15000,
          headers: { 'User-Agent': 'Mozilla/5.0 (StockSentinel)' },
          responseType: 'text',
        });
        return parseRssItems(res.data, limit).map(item => ({ ...item, type: source }));
      } catch (err) {
        console.warn(`[fetch-rss] ${source} failed:`, err.message);
        return [];
      }
    })
  );

  // NVIDIA Newsroom 与 Blog 常同步发布同一篇文章，按标题去重（保留先出现的源）
  const seen = new Set();
  return results
    .flat()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .filter(item => {
      if (seen.has(item.title)) return false;
      seen.add(item.title);
      return true;
    })
    .slice(0, limit);
}
