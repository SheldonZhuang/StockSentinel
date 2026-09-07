import { todayET } from '../utils/datetime.js';

// FOMC 议息会议决定公布日期（第二日，即声明发布当天）
// 来源：federalreserve.gov/monetarypolicy/fomccalendars.htm
// Fed 每年8月左右公布下一年度日程，需要每年手动补充
const DECISION_DATES = [
  '2025-01-29',
  '2025-03-19',
  '2025-05-07',
  '2025-06-18',
  '2025-07-30',
  '2025-09-17',
  '2025-10-29',
  '2025-12-10',
  '2026-01-28',
  '2026-03-18',
  '2026-04-29',
  '2026-06-17',
  '2026-07-29',
  '2026-09-16',
  '2026-10-28',
  '2026-12-09',
  // 2027 暂定日程（Fed 2025-09-05 新闻稿 monetary20250905a，126号录入）
  '2027-01-27',
  '2027-03-17',
  '2027-04-28',
  '2027-06-09',
  '2027-07-28',
  '2027-09-15',
  '2027-10-27',
  '2027-12-08',
'2028-01-26', // 2028 首次会议（同一新闻稿披露）；2028 其余日程约 2026-09 公布后再补
];

/**
 * 返回截至 asOfDate（含当天）最近一次已公布的 FOMC 决议日期
 * @param {string} asOfDate - 'YYYY-MM-DD'，默认今天
 * @returns {string|null}
 */
export function getLastFomcDecisionDate(asOfDate = todayET(), onStale = null) {
  let last = null;
  for (const date of DECISION_DATES) {
    if (date <= asOfDate) last = date;
    else break;
  }
  // 日历耗尽护栏：FOMC 例会间隔约6-8周，最近日程已过去70天以上说明该补新年份了——
  // 货币维度的"暂停/加息"判定依赖此日历，静默陈旧会让方向判定失真
  if (last && (Date.parse(asOfDate) - Date.parse(last)) > 70 * 86400000) {
    const msg = `[fomc-meetings] calendar may be stale: last known decision ${last}, asOf ${asOfDate} — add next year's DECISION_DATES`;
    console.warn(msg);
    if (onStale) onStale(msg);
  }
  return last;
}
