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

/**
 * 指定日期是否为 FOMC 决议日（日历内）。
 *
 * 用途（127b）：决议日当天若 Fed 声明解析失败（官网改版/措辞变化/网络故障），
 * 系统会静默退回 FRED——也就是退回"显示持平、方向可能反了"的老问题。日历是独立于
 * Fed 官网的第二信息源，用它可判定"今天本该有决议结果，但我们没拿到"，据此告警。
 * 注意：日历可能缺当天的临时会议（加急会议不提前列入日程），故本函数只用于
 * "日历说今天是决议日"这一侧的判断，反过来（日历说不是 → 一定没有决议）不成立。
 * @param {string} date - 'YYYY-MM-DD'
 */
export function isFomcDecisionDate(date) {
  return DECISION_DATES.includes(date);
}

/**
 * 截至 asOfDate 已过（含当天）的最近一个决议日，与 asOfDate 相差几天。
 * 供"决议日已过但仍未取到声明"的持续告警使用。
 * @returns {number|null} 天数差；日历内无早于 asOfDate 的决议日时为 null
 */
export function daysSinceLastFomcDecision(asOfDate = todayET()) {
  const last = getLastFomcDecisionDate(asOfDate);
  if (!last) return null;
  return Math.floor((Date.parse(asOfDate) - Date.parse(last)) / 86400000);
}
