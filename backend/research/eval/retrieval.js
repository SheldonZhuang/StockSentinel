// 检索评估（129号阶段2）：在 retrieval-gold.json 上算 recall@5、MRR@10、出处命中率。
// 定义：
//   相关块 = 来自正确公司 + 正确财季的申报，且块正文匹配金标 answer 正则；
//   recall@5 = top5 里至少有一个相关块的题目占比；
//   MRR@10 = 第一个相关块排名倒数的均值（top10 内没有记 0）；
//   出处命中率 = top5 结果中"公司+财季都正确"的块占比（衡量过滤与排序把检索约束在对的申报里的程度）。
// 金标自检：每题在库里至少要有一个相关块，否则是金标错误（或库缺文件），直接报错，不能拿来算分。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { all } from '../db.js';
import { search } from '../search.js';
import { parseQuestion } from '../query.js';
import { queryFact } from '../xbrl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadGold() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'retrieval-gold.json'), 'utf8')).questions;
}

const isRelevant = (g, r) => r.ticker === g.ticker && r.fiscalLabel === `FY${g.fy}Q${g.fq}` && new RegExp(g.answer).test(r.text);

/** 金标自检：相关块存在性 + XBRL 数值交叉核对。返回问题清单（空 = 通过） */
export function checkGold(gold) {
  const problems = [];
  for (const g of gold) {
    const rows = all(
      `SELECT c.text, f.period_end FROM chunks c JOIN filings f USING(accession)
       WHERE c.ticker = ? AND f.fiscal_year = ? AND f.fiscal_quarter = ?`,
      [g.ticker, g.fy, g.fq],
    );
    const rx = new RegExp(g.answer);
    if (!rows.some(r => rx.test(r.text))) problems.push(`${g.id}: 库中没有匹配金标的块`);
    if (g.xbrl) {
      const periodEnd = rows.map(r => r.period_end).sort().at(-1);
      const f = queryFact(g.ticker, g.xbrl.concepts, periodEnd, 'quarter');
      const got = f ? f.value / g.xbrl.scale : null;
      // 金标数字按披露口径四舍五入（$96.2 billion），容差取最后一位的一半
      const decimals = (String(g.xbrl.expect).split('.')[1] || '').length;
      const tol = 0.5 * 10 ** -decimals + 1e-9;
      if (got == null || Math.abs(got - g.xbrl.expect) > tol) {
        problems.push(`${g.id}: XBRL 核对不一致（期望 ${g.xbrl.expect}，XBRL ${got ?? '无'}）`);
      }
    }
  }
  return problems;
}

/**
 * 跑一遍评估。retrieve(question) → 结果数组（每项含 ticker/fiscalLabel/text），默认用关键词 BM25。
 * @returns {{ n, recallAt5, mrrAt10, provenanceAt5, perQuestion }}
 */
export function evaluateRetrieval(gold, retrieve = defaultRetrieve) {
  const perQuestion = [];
  let hit5 = 0;
  let rr = 0;
  let prov = 0;
  let provN = 0;
  for (const g of gold) {
    const res = retrieve(g.q).slice(0, 10);
    const rank = res.findIndex(r => isRelevant(g, r));
    const top5 = res.slice(0, 5);
    if (rank >= 0 && rank < 5) hit5++;
    if (rank >= 0) rr += 1 / (rank + 1);
    prov += top5.filter(r => r.ticker === g.ticker && r.fiscalLabel === `FY${g.fy}Q${g.fq}`).length;
    provN += top5.length;
    perQuestion.push({ id: g.id, rank: rank >= 0 ? rank + 1 : null, top1: res[0] ? `${res[0].ticker} ${res[0].fiscalLabel} ${res[0].section} #${res[0].chunkId}` : null });
  }
  const n = gold.length;
  return {
    n,
    recallAt5: hit5 / n,
    mrrAt10: rr / n,
    provenanceAt5: provN ? prov / provN : 0,
    perQuestion,
  };
}

export function defaultRetrieve(question) {
  const p = parseQuestion(question);
  return search(p.terms, {
    tickers: p.tickers, fiscalYear: p.fiscalYear, fiscalQuarter: p.fiscalQuarter, sections: p.sections, topics: p.topics,
  }, 10);
}
