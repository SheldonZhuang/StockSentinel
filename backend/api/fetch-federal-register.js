import axios from 'axios';

const FR_BASE = 'https://www.federalregister.gov/api/v1/documents.json';

const KEYWORDS = {
  fiscal: ['tax', 'budget', 'debt ceiling', 'deficit', 'stimulus', 'spending', 'revenue', 'appropriation'],
  administrative: ['tariff', 'trade war', 'export control', 'technology restriction', 'sanction', 'import duty', 'regulation', 'enforcement'],
};

/**
 * 从 Federal Register API 拉取最新相关公告
 * @param {'fiscal'|'administrative'} category
 * @param {number} limit
 * @returns {Array<{title, date, type, url}>}
 */
export async function fetchFederalRegister(category = 'fiscal', limit = 20) {
  const terms = KEYWORDS[category] || KEYWORDS.fiscal;
  const query = terms.join(' OR ');

  const res = await axios.get(FR_BASE, {
    params: {
      conditions: { term: query },
      fields: ['title', 'publication_date', 'type', 'html_url'],
      per_page: limit,
      order: 'newest',
    },
    timeout: 15000,
  });

  const docs = res.data?.results || [];
  return docs.map(doc => ({
    title: doc.title,
    date: doc.publication_date,
    type: doc.type,
    url: doc.html_url,
  }));
}
