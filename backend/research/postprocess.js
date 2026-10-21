// 研究笔记交稿后的程序化补全（129号阶段4 改进，纯函数，不经 LLM）。
// 背景：deepseek 评估轮事实覆盖率 70.6%——模型按自己的判断挑 3–6 个要点，资本开支、稀释 EPS 最常被漏掉；
// 另有 4 处把指标表里明明有值的项列进"未披露"（误报 2.6%）。两件事都不该交给模型的"判断"：
//   1) 关键指标漏了 → 程序用指标表生成一条陈述补进要点（数字直接来自 XBRL，出处为指标行，标 generated）；
//   2) "未披露"清单里出现指标表有值的项 → 删掉，并记一条改动说明（不静默）。
// 关键指标的口径是阶段0定的笔记内容（收入、毛利率、营业利润、净利润、EPS、资本开支、分部收入），
// 与评估金标无关：评估用的是冻结的 notes-gold.json，这里不读它。
import { fmt } from './metrics.js';

// 每份笔记必须出现的指标（存在于指标表里才要求）；分部收入取当季收入最大的 2 个分部
export const KEY_METRICS = ['revenue', 'gross_margin', 'operating_income', 'net_income', 'eps_diluted', 'capex'];

// "未披露"清单里的条目 → 它说的是哪个指标（关键词 → 指标 id）
const ND_WORDS = [
  [/资本开支|资本支出|capex/i, 'capex'],
  [/每股收益|EPS/i, 'eps_diluted'],
  [/毛利率/, 'gross_margin'],
  [/(?:营业利润|经营利润)(?!率)/, 'operating_income'],
  [/营业利润率|经营利润率/, 'operating_margin'],
  [/(?:净利润|净利)(?!率)/, 'net_income'],
  [/营业收入|营收|总收入/, 'revenue'],
  [/经营(?:活动)?现金流/, 'operating_cash_flow'],
  [/自由现金流/, 'free_cash_flow'],
  [/研发/, 'rnd'],
];

const chg = (v, isPct) => (v == null ? null : `${v > 0 ? '增长' : v < 0 ? '下降' : '持平'}${v === 0 ? '' : `${Math.abs(v)}${isPct ? '个百分点' : '%'}`}`);

/** 指标行 → 一句中文陈述（数字全部来自该行，自检必然能在出处里找到） */
export function metricSentence(m, fiscalLabel) {
  const isPct = m.unit === '%';
  const cur = fmt(m.current, m.unit);
  const qoq = isPct ? chg(m.qoq_pp, true) : chg(m.qoq_pct, false);
  const yoy = isPct ? chg(m.yoy_pp, true) : chg(m.yoy_pct, false);
  const parts = [`${fiscalLabel}${m.label}为${cur}`];
  if (qoq) parts.push(`环比${qoq}`);
  if (yoy) parts.push(`同比${yoy}`);
  return `${parts.join('，')}。`;
}

/** 草稿里已经覆盖了哪些指标（陈述的出处引用了该指标 id） */
function coveredMetricIds(draft) {
  const ids = new Set();
  for (const s of ['highlights', 'guidance_check', 'changes', 'risks']) {
    for (const c of draft?.[s] || []) for (const e of c?.evidence || []) if (e?.metric) ids.add(e.metric);
  }
  return ids;
}

/**
 * 补全草稿（返回新对象，不改入参）。
 * @returns {{ draft, added: string[], removedNotDisclosed: string[] }}
 */
export function completeDraft(draft, table) {
  if (!draft || !table) return { draft, added: [], removedNotDisclosed: [] };
  const byId = new Map(table.metrics.map(m => [m.id, m]));
  const covered = coveredMetricIds(draft);
  const segments = table.metrics.filter(m => m.id.startsWith('segment:') && m.current != null)
    .sort((a, b) => b.current - a.current).slice(0, 2).map(m => m.id);
  const want = [...KEY_METRICS, ...segments].filter(id => byId.get(id)?.current != null);
  const added = [];
  const extra = [];
  for (const id of want) {
    if (covered.has(id)) continue;
    extra.push({ text: metricSentence(byId.get(id), table.fiscalLabel), evidence: [{ metric: id }], generated: true });
    added.push(id);
  }
  const removedNotDisclosed = [];
  const nd = (draft.not_disclosed || []).filter(item => {
    const hit = ND_WORDS.find(([re]) => re.test(item));
    if (hit && byId.get(hit[1])?.current != null) { removedNotDisclosed.push(item); return false; }
    return true;
  });
  return {
    draft: { ...draft, highlights: [...(draft.highlights || []), ...extra], not_disclosed: nd },
    added,
    removedNotDisclosed,
  };
}
