"""向量对比实验：评估（129号阶段2）。只需 numpy，不加载模型，内存很小。

对比四种检索（过滤条件与线上关键词检索完全相同：公司 / 财季 / 章节）：
  bm25      线上现用的关键词检索（export.mjs 导出的前 50 候选）
  dense_en  向量检索，查询 = query.js 生成的英文检索词
  dense_zh  向量检索，查询 = 原始中文问题（只对多语言模型 e5 有意义）
  hybrid    bm25 与 dense_en 的倒数排名融合（RRF，k=60）
指标与 eval/retrieval.js 同口径：recall@5、MRR@10。

用法：python -I evaluate.py <数据目录> <bge|e5> > result.json
"""
import json
import os
import sys

import numpy as np


def ranks_to_metrics(per_q):
    n = len(per_q)
    r5 = sum(1 for r in per_q.values() if r is not None and r <= 5) / n
    mrr = sum(1 / r for r in per_q.values() if r is not None and r <= 10) / n
    return {'recallAt5': round(r5, 3), 'mrrAt10': round(mrr, 3)}


def first_rank(ranked_ids, relevant):
    for i, cid in enumerate(ranked_ids[:10]):
        if cid in relevant:
            return i + 1
    return None


def rrf(lists, k=60):
    score = {}
    for lst in lists:
        for i, cid in enumerate(lst):
            score[cid] = score.get(cid, 0) + 1 / (k + i + 1)
    return [cid for cid, _ in sorted(score.items(), key=lambda x: (-x[1], x[0]))]


def main():
    d, name = sys.argv[1], sys.argv[2]
    md = os.path.join(d, name)
    E = np.load(os.path.join(md, 'E.npy'))
    Qen = np.load(os.path.join(md, 'Qen.npy'))
    Qzh = np.load(os.path.join(md, 'Qzh.npy'))
    ids = json.load(open(os.path.join(md, 'ids.json')))
    chunks = [json.loads(l) for l in open(os.path.join(d, 'chunks.jsonl'), encoding='utf8')]
    meta = {c['id']: c for c in chunks}
    qs = json.load(open(os.path.join(d, 'queries.json'), encoding='utf8'))
    idx = np.array(ids)

    out = {m: {} for m in ['bm25', 'dense_en', 'dense_zh', 'hybrid']}
    for qi, q in enumerate(qs):
        rel = set(q['relevant'])
        mask = np.array([
            (not q['tickers'] or meta[c]['ticker'] in q['tickers'])
            and (q['fy'] is None or meta[c]['fy'] == q['fy'])
            and (q['fq'] is None or meta[c]['fq'] == q['fq'])
            and (not q['sections'] or meta[c]['section'] in q['sections'])
            for c in ids])
        cand = idx[mask]
        bm = [cid for cid, _ in q['bm25']]
        de = cand[np.argsort(-(E[mask] @ Qen[qi]), kind='stable')][:50].tolist()
        dz = cand[np.argsort(-(E[mask] @ Qzh[qi]), kind='stable')][:50].tolist()
        out['bm25'][q['id']] = first_rank(bm, rel)
        out['dense_en'][q['id']] = first_rank(de, rel)
        out['dense_zh'][q['id']] = first_rank(dz, rel)
        out['hybrid'][q['id']] = first_rank(rrf([bm, de]), rel)

    res = {
        'model': name,
        'n': len(qs),
        'metrics': {m: ranks_to_metrics(v) for m, v in out.items()},
        'perQuestion': {q['id']: {m: out[m][q['id']] for m in out} for q in qs},
    }
    json.dump(res, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
