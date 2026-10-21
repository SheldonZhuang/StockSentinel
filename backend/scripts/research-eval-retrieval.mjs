// 检索评估（129号阶段2）：node scripts/research-eval-retrieval.mjs
// 先做金标自检（相关块存在 + XBRL 数值交叉核对），再输出 recall@5 / MRR@10 / 出处命中率与未命中题目
import { getResearchDb } from '../research/db.js';
import { loadGold, checkGold, evaluateRetrieval } from '../research/eval/retrieval.js';

await getResearchDb();
const gold = loadGold();
const problems = checkGold(gold);
if (problems.length) {
  console.error('金标自检失败：\n' + problems.join('\n'));
  process.exit(1);
}
const t0 = Date.now();
const r = evaluateRetrieval(gold);
console.log(JSON.stringify({
  n: r.n, recallAt5: +r.recallAt5.toFixed(3), mrrAt10: +r.mrrAt10.toFixed(3), provenanceAt5: +r.provenanceAt5.toFixed(3), ms: Date.now() - t0,
}));
for (const q of r.perQuestion) if (!q.rank || q.rank > 5) console.log(`miss ${q.id} rank=${q.rank ?? '>10'} top1=${q.top1}`);
