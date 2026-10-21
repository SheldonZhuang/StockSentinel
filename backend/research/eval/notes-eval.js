// 研究笔记离线评估（129号阶段4）：在冻结的金标（notes-gold.json）上给笔记打分。全部指标由程序计算，可复现。
//
// 指标定义（阶段0 / 用户 2026-10-21 定）：
//   数值准确率   = 笔记陈述里提到的金标事实中，数字正确的比例。按"陈述引用了哪个指标 / 引文"把陈述对到金标事实，
//                  再按显示精度比数字（"900.1亿美元"对 $90.007B 算对；"910亿"算错）。没提到的事实不计入分母（见覆盖率）
//   事实覆盖率   = 10 个金标事实里，笔记陈述提到了几个（数字区表格由程序生成，不算模型的覆盖）
//   出处覆盖率   = 有出处的陈述 / 全部陈述
//   出处准确率   = 出处里确实能找到该陈述（自检通过：引文逐字存在 + 数字可在出处里找到）的陈述 / 有出处的陈述
//   "未披露"误报率 = 金标有值、笔记却写"未披露"的事实 / 金标有值的事实；
//                   反向（金标"未披露"、笔记编出数字指引）记为"捏造指引"，单列
//   失败率       = 生成失败（无笔记）的份数 / 总份数
//   延迟、成本   = 每份笔记的 latency_ms、cost_usd（P50 / P95 / 均值）
//   有用性       = 用户 1–5 打分（打分表 notes-usefulness.csv），这里只汇总已填的分
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { quantitiesIn } from '../verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const GOLD_PATH = path.join(__dirname, 'notes-gold.json');
export const USEFULNESS_PATH = path.join(__dirname, 'notes-usefulness.csv');
export const USEFULNESS_AI_PATH = path.join(__dirname, 'notes-usefulness-ai.csv'); // AI 双评委盲评（scripts/research-judge.mjs）

const SECTIONS = ['highlights', 'guidance_check', 'changes', 'risks'];

// 金标事实 id → 陈述怎样算"提到了它"：引用了对应指标（指标 id 前缀匹配），或正文出现关键词
const FACT_MATCH = {
  revenue: { metrics: ['revenue'], words: /营收|营业收入|收入|revenue|net sales/i },
  revenue_yoy: { metrics: ['revenue'], words: /营收|营业收入|收入/ , pct: true },
  revenue_usd: { metrics: [], words: /美元/ },
  revenue_usd_yoy: { metrics: [], words: /美元/, pct: true },
  gross_margin: { metrics: ['gross_margin'], words: /毛利率|gross margin/i, pct: true },
  // "营业利润率"是另一个指标（operating_margin），不能当营业利润
  operating_income: { metrics: ['operating_income'], words: /(?:营业利润|经营利润)(?!率)|operating income(?! margin)/i },
  net_income: { metrics: ['net_income'], words: /(?:净利润|净利)(?!率)|net income(?! margin)/i },
  net_income_yoy: { metrics: ['net_income'], words: /净利润|净利/, pct: true },
  eps_diluted: { metrics: ['eps_diluted'], words: /每股收益|EPS/i },
  capex: { metrics: ['capex'], words: /资本开支|资本支出|capex/i },
};

const isNotDisclosed = t => /未披露|未提供|没有披露|未给出/.test(t);

/** 笔记是否把某金标事实说成"未披露"：not_disclosed 清单里的条目，或正文里带"未披露"字样的陈述，提到了该事实的关键词 */
function ndMentions(note, fact) {
  const words = fact.id.startsWith('segment:') || fact.id.startsWith('product:')
    ? new RegExp(fact.label.split('：').pop().split(' ')[0], 'i')
    // 只认"下一季（或季度）收入指引未披露"；"全年营收指引未披露""每股盈余区间未给出"不是这个事实
    : fact.id === 'next_q_revenue_guidance' ? /(?:下一?季|季度?|quarter)[^，。；]{0,12}(?:收入|营收|revenue)[^，。；]{0,6}(?:指引|展望|guidance)|(?:收入|营收)指引[^，。；]{0,6}(?:下一?季|季度)/i : FACT_MATCH[fact.id]?.words;
  if (!words) return false;
  const nd = [...(note.not_disclosed || []), ...SECTIONS.flatMap(s => (note[s] || []).map(c => c.text)).filter(isNotDisclosed)];
  return nd.some(x => words.test(x));
}

/** 一条陈述是否"提到"某金标事实 */
function mentions(claim, fact) {
  const metricIds = claim.evidence.filter(e => e.type === 'metric').map(e => e.metric);
  if (fact.id.startsWith('segment:') || fact.id.startsWith('product:')) return metricIds.includes(fact.id);
  // "下季收入指引"：陈述里有指引类词 + 季度词 + 收入词。季度写法覆盖"第三季""第二季度""Q3"；收入覆盖英文原文 Revenue
  // （2026-10-21 grok 轮：TSM 写"公司对2026年第三季的展望为：美元营收介于…"，旧正则只认"第X季度"漏判，再被"未披露"清单里
  //  "全年营收指引"误配成误报）
  if (fact.id === 'next_q_revenue_guidance') {
    return /指引|展望|预计|预期|guidance|outlook|expected/i.test(claim.text)
      && /下一?季|第[一二三四]季(?:度)?|Q[1-4]|下季|quarter/i.test(claim.text)
      && /收入|营收|销售|revenue|net sales/i.test(claim.text);
  }
  const rule = FACT_MATCH[fact.id];
  if (!rule) return false;
  // 增速类（revenue_yoy 等）共用金额指标的 id：引了该指标、且正文里确有百分比，才算提到增速
  const hasPct = quantitiesIn(claim.text).some(q => q.pct);
  if (rule.metrics.some(m => metricIds.includes(m))) return !rule.pct || hasPct || fact.id === 'gross_margin';
  // 关键词回退只用于没有指标表的公司（TSM）：有指标表时，没引用该指标的陈述不算提到它
  // （2026-10-21 deepseek 轮："Reality Labs 减少营业利润 40.3 亿"被当成公司营业利润、"营业利润率 17.3%"被当成营业利润，误判 6 处）
  if (!claim.noMetricTable) return false;
  return rule.words.test(claim.text) && quantitiesIn(claim.text).some(q => !!q.pct === !!rule.pct);
}

/** 陈述里的数字与金标是否一致（任一数量在容差内即算对；按金标单位只比同类数量） */
function numberCorrect(claim, fact) {
  const qs = quantitiesIn(claim.text);
  if (fact.kind === 'guidance') {
    // 指引：陈述里要出现金标指引句里的主要数字（区间两端或中值），按显示精度比
    const goldNums = fact.numbers.filter(n => n >= 1);
    return goldNums.some(g => qs.some(q => !q.pct && (Math.abs(q.v - g * 1e9) <= q.tol || Math.abs(q.v - g) <= q.tol)));
  }
  const pct = fact.unit === '%';
  const target = Math.abs(fact.value);
  return qs.some(q => !!q.pct === pct && Math.abs(Math.abs(q.v) - target) <= Math.max(q.tol, target * 1e-9));
}

/**
 * 给一份笔记打分。
 * @param note  research_notes.note_json 解析后的对象（null = 生成失败）
 * @param gold  { ticker, fiscalLabel, facts }
 */
export function scoreNote(note, gold) {
  const r = { ticker: gold.ticker, fiscalLabel: gold.fiscalLabel, failed: !note, facts: [] };
  if (!note) return r;
  const noMetricTable = !(note.key_figures || []).length;
  const claims = SECTIONS.flatMap(s => (note[s] || []).map(c => ({ ...c, section: s, noMetricTable })));
  const allText = [note.summary, ...claims.map(c => c.text), ...(note.not_disclosed || [])].join('\n');
  r.claims = claims.length;
  r.withSource = claims.filter(c => c.evidence?.length).length;
  r.sourceVerified = claims.filter(c => c.evidence?.length && c.status === 'verified').length;
  for (const f of gold.facts) {
    const hit = claims.filter(c => mentions(c, f));
    const row = { id: f.id, kind: f.kind, mentioned: hit.length > 0 };
    if (f.kind === 'not_disclosed') {
      // 金标"未披露"：笔记若给出了带数字的下一季收入指引，就是捏造
      row.fabricated = hit.some(c => quantitiesIn(c.text).some(q => !q.pct && q.v >= 1e8));
    } else {
      row.correct = hit.length ? hit.some(c => numberCorrect(c, f)) : null;
      // 金标有值，笔记却把它列为未披露：not_disclosed 清单（或正文"未披露"句）里出现该事实的关键词
      row.falseNotDisclosed = !hit.length && ndMentions(note, f);
    }
    r.facts.push(row);
  }
  return r;
}

const pctl = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/** 汇总一组笔记（一个模型）的指标 */
export function aggregate(scored, runs) {
  const ok = scored.filter(s => !s.failed);
  const facts = ok.flatMap(s => s.facts);
  const numeric = facts.filter(f => f.kind !== 'not_disclosed');
  const mentionedNumeric = numeric.filter(f => f.mentioned);
  const claims = ok.reduce((n, s) => n + s.claims, 0);
  const withSource = ok.reduce((n, s) => n + s.withSource, 0);
  const verified = ok.reduce((n, s) => n + s.sourceVerified, 0);
  const nd = facts.filter(f => f.kind === 'not_disclosed');
  const lat = runs.map(r => r.latency_ms).filter(x => x != null);
  const cost = runs.map(r => r.cost_usd).filter(x => x != null);
  const r3 = x => (x == null ? null : Math.round(x * 1000) / 1000);
  return {
    notes: scored.length,
    failureRate: r3((scored.length - ok.length) / scored.length),
    numericAccuracy: r3(mentionedNumeric.length ? mentionedNumeric.filter(f => f.correct).length / mentionedNumeric.length : null),
    factCoverage: r3(facts.length ? facts.filter(f => f.mentioned).length / facts.length : null),
    sourceCoverage: r3(claims ? withSource / claims : null),
    sourceAccuracy: r3(withSource ? verified / withSource : null),
    falseNotDisclosedRate: r3(numeric.length ? numeric.filter(f => f.falseNotDisclosed).length / numeric.length : null),
    fabricatedGuidance: nd.filter(f => f.fabricated).length,
    notDisclosedFacts: nd.length,
    latencyP50s: lat.length ? Math.round(pctl(lat, 50) / 100) / 10 : null,
    latencyP95s: lat.length ? Math.round(pctl(lat, 95) / 100) / 10 : null,
    costPerNoteUsd: cost.length ? Math.round((cost.reduce((a, b) => a + b, 0) / cost.length) * 1e4) / 1e4 : null,
    costTotalUsd: cost.length ? Math.round(cost.reduce((a, b) => a + b, 0) * 1e4) / 1e4 : null,
  };
}

/** 有用性打分表：ticker,fiscal_label,model,score(1-5),comment；没填的行忽略 */
export function readUsefulness(file = USEFULNESS_PATH) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1).map(l => l.split(','))
    .filter(c => c.length >= 4 && /^[1-5](\.\d+)?$/.test(c[3].trim()))
    .map(([ticker, fiscal_label, model, score]) => ({ ticker, fiscal_label, model, score: Number(score) }));
}
