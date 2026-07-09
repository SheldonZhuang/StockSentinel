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
];

/**
 * 返回截至 asOfDate（含当天）最近一次已公布的 FOMC 决议日期
 * @param {string} asOfDate - 'YYYY-MM-DD'，默认今天
 * @returns {string|null}
 */
export function getLastFomcDecisionDate(asOfDate = todayET()) {
  let last = null;
  for (const date of DECISION_DATES) {
    if (date <= asOfDate) last = date;
    else break;
  }
  return last;
}
