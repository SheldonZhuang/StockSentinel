// NDX 调整日历：季度（3/6/9/12 月第三个周五收盘后生效，次一交易日开盘起新权重），12 月同时为年度重构；
// 特别再平衡：2011-04-29 收盘后（2011-05-02 开盘起，nasdaqtrader.com fpnews2011-018），2023-07-21 收盘后（2023-07-24 开盘起，Nasdaq 2023-07-07 公告）。
// 交易日历取自 SPY 的 Tiingo 日线（含 2001-09-11、2012-10-29 等休市）。
import path from 'path';
import { fileURLToPath } from 'url';
import { tiingo, writeJSON, OUT } from './lib.mjs';

export async function tradingDays() { return (await tiingo('SPY')).rows.map(r => r.d); }
const thirdFriday = (y, m) => { const d = new Date(Date.UTC(y, m - 1, 1)); const off = (5 - d.getUTCDay() + 7) % 7; return new Date(Date.UTC(y, m - 1, 1 + off + 14)).toISOString().slice(0, 10); };
export const SPECIALS = [
  { eff: '2011-04-29', inForce: '2011-05-02', kind: 'special', src: 'https://nasdaqtrader.com/TraderNews.aspx?id=fpnews2011-018' },
  { eff: '2023-07-21', inForce: '2023-07-24', kind: 'special', src: 'https://ir.nasdaq.com/news-releases/news-release-details/nasdaq-100-index-special-rebalance-be-effective-july-24-2023' },
];

/** 返回 [{eff(生效收盘日), inForce(新权重首个交易日=买入日), kind}]；第三个周五休市（如 2000 年无此情况）则取之前最近交易日 */
export async function rebalanceCalendar(fromY = 1999, toDate) {
  const days = await tradingDays(), set = new Set(days);
  const last = toDate || days.at(-1);
  const out = [];
  for (let y = fromY; y <= +last.slice(0, 4); y++) for (const m of [3, 6, 9, 12]) {
    let f = thirdFriday(y, m);
    while (!set.has(f) && f > '1990') f = days[days.findIndex(d => d > f) - 1];
    const i = days.indexOf(f);
    if (i < 0 || i + 1 >= days.length) continue;
    out.push({ eff: f, inForce: days[i + 1], kind: m === 12 ? 'annual+quarterly' : 'quarterly' });
  }
  for (const s of SPECIALS) out.push(s);
  return out.filter(r => r.inForce <= last).sort((a, b) => a.eff.localeCompare(b.eff));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cal = await rebalanceCalendar(2000);
  writeJSON(path.join(OUT, 'rebalance_calendar.json'), cal);
  console.log(cal.length, 'events'); console.log(cal.map(c => `${c.eff}${c.kind === 'special' ? '*' : ''}`).join(' '));
}
