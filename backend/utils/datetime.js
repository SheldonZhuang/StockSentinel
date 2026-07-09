// 后端所有"今天"的判定统一用美东时间(ET)，因为业务语义锚定在美股/美联储节奏
// （FOMC决议、FRED数据发布日、美股交易日），不应该受服务器实际部署时区影响
const ET_TZ = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export function todayET() {
  return fmt.format(new Date());
}

export function daysAgoET(n) {
  return fmt.format(new Date(Date.now() - n * 86400000));
}
