// 回测引擎：按 [buyDate, sellDate) 区间持有单只股票，开盘价成交（Tiingo adjOpen，与 adjClose 同一复权因子，总回报口径）。
// 区间内退市/停止报价：最后一个可得 adjClose 转现金（现金 0 收益）直到下一次换仓。生成逐日净值用于最大回撤。
import { series } from './prices.mjs';

/** 持有 sym 从 buyD 开盘到 sellD 开盘（sellD=null 表示持有到数据末日收盘）。返回 {mult, daily:[{d,v}], event} */
export async function holdLeg(sym, buyD, sellD, days) {
  const s = await series(sym);
  const iBuy = s.idx.get(buyD);
  const legDays = days.filter(d => d >= buyD && (sellD ? d <= sellD : true));
  if (iBuy == null) return { mult: 1, daily: legDays.map(d => ({ d, v: 1 })), event: `no price on ${buyD} → held cash` };
  const entry = s.rows[iBuy].ao;
  const daily = []; let lastV = 1, lastD = buyD, event = null;
  for (const d of legDays) {
    if (sellD && d === sellD) {
      const i = s.idx.get(d);
      if (i != null) { lastV = s.rows[i].ao / entry; lastD = d; }
      daily.push({ d, v: lastV });
      break;
    }
    const i = s.idx.get(d);
    if (i != null) { lastV = s.rows[i].ac / entry; lastD = d; }
    else if (!event && d > s.rows.at(-1).d) event = `price series ends ${s.rows.at(-1).d} (delisted/acquired) → cash at last adjClose`;
    daily.push({ d, v: lastV });
  }
  return { mult: lastV, daily, event, lastPriced: lastD };
}

/** 买入持有基准：首日开盘到末日收盘 */
export async function buyHold(sym, d0, days) {
  const s = await series(sym);
  const i0 = s.idx.get(d0), entry = s.rows[i0].ao;
  return days.filter(d => d >= d0).map(d => { const i = s.idx.get(d); return { d, v: i == null ? null : s.rows[i].ac / entry }; }).filter(x => x.v != null);
}

export function stats(curve, start = 10000) {
  const v0 = curve[0].v, vN = curve.at(-1).v;
  let peak = -Infinity, mdd = 0, peakD = null, trough = null;
  for (const p of curve) { if (p.v > peak) { peak = p.v; peakD = p.d; } const dd = p.v / peak - 1; if (dd < mdd) { mdd = dd; trough = { peakD, d: p.d }; } }
  const yrs = (Date.parse(curve.at(-1).d) - Date.parse(curve[0].d)) / (365.25 * 864e5);
  const mult = vN / v0;
  return { final: start * mult, totalRet: mult - 1, cagr: mult ** (1 / yrs) - 1, mdd, mddWindow: trough, years: yrs, from: curve[0].d, to: curve.at(-1).d };
}

export function yearlyReturns(curve) {
  const out = {}; let prev = curve[0].v, py = curve[0].d.slice(0, 4);
  for (let i = 1; i < curve.length; i++) {
    const y = curve[i].d.slice(0, 4);
    if (y !== py) { out[py] = curve[i - 1].v / prev - 1; prev = curve[i - 1].v; py = y; }
  }
  out[py] = curve.at(-1).v / prev - 1;
  return out;
}
