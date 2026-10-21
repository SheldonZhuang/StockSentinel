// XBRL 数值事实（129号阶段2）：companyfacts → xbrl_facts。
// 研究笔记里"每个数字必须来自 XBRL 或原文"，这里是数字的主来源，也是评估集数值答案的金标来源。
// 去重口径：同一 概念+单位+期间 在多份申报里反复出现（10-K 会重报前两年数据），保留最新申报的值
// ——重述后的数字以最新为准，与 SEC frames API 的口径一致。
import { edgarGet, companyFactsUrl } from '../utils/edgar-client.js';
import { all, run, tx } from './db.js';

const PERIODIC_FORMS = /^(10-Q|10-K|20-F)(\/A)?$/;

/** companyfacts JSON → 去重后的事实行（纯函数）。since：只保留期末 ≥ since 的 */
export function flattenCompanyFacts(json, ticker, since) {
  const best = new Map();
  for (const [taxonomy, concepts] of Object.entries(json?.facts || {})) {
    if (taxonomy === 'dei') continue;
    for (const [concept, body] of Object.entries(concepts || {})) {
      for (const [unit, facts] of Object.entries(body?.units || {})) {
        // EDGAR 可能返回 units:{USD:{}} 空对象（119号 BE 实测），必须 Array.isArray
        if (!Array.isArray(facts)) continue;
        for (const f of facts) {
          if (!f?.end || f.end < since || !PERIODIC_FORMS.test(f.form || '') || typeof f.val !== 'number') continue;
          const key = `${taxonomy}|${concept}|${unit}|${f.start || ''}|${f.end}`;
          const prev = best.get(key);
          if (!prev || f.filed > prev.filed) {
            best.set(key, {
              ticker, taxonomy, concept, unit, period_start: f.start || '', period_end: f.end, value: f.val,
              fy: f.fy ?? null, fp: f.fp ?? null, form: f.form, accession: f.accn, filed: f.filed,
            });
          }
        }
      }
    }
  }
  return [...best.values()];
}

/** 拉一家公司的 companyfacts 并整体替换该公司的事实（替换而非追加：重述值以最新为准） */
export async function refreshXbrlFacts(ticker, cik, since) {
  const res = await edgarGet(companyFactsUrl(cik), { timeout: 60000 });
  const rows = flattenCompanyFacts(res.data, ticker, since);
  tx(() => {
    run('DELETE FROM xbrl_facts WHERE ticker = ?', [ticker]);
    for (const r of rows) {
      run(`INSERT INTO xbrl_facts (ticker, taxonomy, concept, unit, period_start, period_end, value, fy, fp, form, accession, filed)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [r.ticker, r.taxonomy, r.concept, r.unit, r.period_start, r.period_end, r.value, r.fy, r.fp, r.form, r.accession, r.filed]);
    }
  });
  return rows.length;
}

const DAY = 86400000;
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY + 1;

/**
 * 查询一个期间事实。duration：'quarter'（约 3 个月）/ 'year'（约 12 个月）/ 'instant'（时点）。
 * periodEnd 容差 ±7 天（52/53 周财年名义季末与实际期末差几天）。
 * concepts 按优先级给多个（各公司科目命名不一，如 AMZN capex 用 PaymentsToAcquireProductiveAssets）。
 * 单季值缺失时按 YTD 差分推算并标 derived：现金流量表只报年初至今（NVDA 10-Q 的 capex 只有 6M/9M），
 * 10-K 只报全年（Q4 单季普遍缺）——单季 = 截至本期末的 YTD − 同一起点截至上季末的 YTD。
 * @returns {{value, concept, unit, period_start, period_end, accession, filed, form, derived?}|null}
 */
export function queryFact(ticker, concepts, periodEnd, duration = 'quarter') {
  for (const concept of concepts) {
    const rows = all(
      `SELECT * FROM xbrl_facts WHERE ticker = ? AND concept = ?
         AND ABS(julianday(period_end) - julianday(?)) <= 7`,
      [ticker, concept, periodEnd],
    );
    const pick = rows.filter(r => {
      if (duration === 'instant') return !r.period_start;
      if (!r.period_start) return false;
      const d = days(r.period_start, r.period_end);
      return duration === 'quarter' ? d >= 80 && d <= 100 : d >= 350 && d <= 380;
    }).sort((a, b) => (b.filed > a.filed ? 1 : -1))[0];
    if (pick) return { ...pick };
    if (duration === 'quarter') {
      // 截至本期末、跨度 6/9/12 个月的 YTD，取跨度最长的（10-K 的全年优先于同期别的口径）
      const ytds = rows.filter(r => r.period_start && days(r.period_start, r.period_end) >= 170)
        .sort((a, b) => days(b.period_start, b.period_end) - days(a.period_start, a.period_end));
      for (const ytd of ytds) {
        const span = days(ytd.period_start, ytd.period_end);
        const prev = all(
          `SELECT * FROM xbrl_facts WHERE ticker = ? AND concept = ? AND unit = ? AND period_start = ?`,
          [ticker, concept, ytd.unit, ytd.period_start],
        ).find(r => { const d = days(r.period_start, r.period_end); return d >= span - 100 && d <= span - 80; });
        if (prev) {
          return {
            ...ytd,
            value: ytd.value - prev.value,
            period_start: prev.period_end,
            derived: `${Math.round(span / 30.4)}M YTD ${ytd.accession} − ${Math.round(days(prev.period_start, prev.period_end) / 30.4)}M YTD ${prev.accession}`,
          };
        }
      }
    }
  }
  return null;
}
