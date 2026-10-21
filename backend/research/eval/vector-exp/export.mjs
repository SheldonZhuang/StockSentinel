// 向量对比实验输入导出（129号阶段2，本机一次性实验，不进线上）：
// 块正文 + 每题的检索请求（英文检索词与过滤条件）+ BM25 前 50 候选与得分 + 金标相关块 id
import fs from 'fs';
import path from 'path';
import { getResearchDb, all } from '../../db.js';
import { loadGold } from '../retrieval.js';
import { parseQuestion } from '../../query.js';
import { search } from '../../search.js';

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
await getResearchDb();
const chunks = all('SELECT c.id, c.ticker, f.fiscal_year fy, f.fiscal_quarter fq, c.section, c.text FROM chunks c JOIN filings f USING(accession) ORDER BY c.id');
fs.writeFileSync(path.join(out, 'chunks.jsonl'), chunks.map(c => JSON.stringify(c)).join('\n'));
const qs = loadGold().map(g => {
  const p = parseQuestion(g.q);
  const rx = new RegExp(g.answer);
  const relevant = chunks.filter(c => c.ticker === g.ticker && c.fy === g.fy && c.fq === g.fq && rx.test(c.text)).map(c => c.id);
  const bm25 = search(p.terms, { tickers: p.tickers, fiscalYear: p.fiscalYear, fiscalQuarter: p.fiscalQuarter, sections: p.sections, topics: p.topics }, 50)
    .map(r => [r.chunkId, r.score]);
  return { id: g.id, q: g.q, en: p.terms, tickers: p.tickers, fy: p.fiscalYear ?? null, fq: p.fiscalQuarter ?? null, sections: p.sections, relevant, bm25 };
});
fs.writeFileSync(path.join(out, 'queries.json'), JSON.stringify(qs));
console.log(`chunks ${chunks.length}, queries ${qs.length}`);
