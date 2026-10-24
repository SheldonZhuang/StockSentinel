// 幸存者偏差缺口筛查（2000–2007 选股年）：Tiingo 没有价格的 QQQ 持仓名，冠军判定里看不到。
// 对每个缺口名，用 QQQ 9/30 持仓表里的 "市值/股数" 作为当日未复权价，估 9/30(Y-1)→9/30(Y) 的价格变化（未含分红、跨拆股会失真），
// 与当年冠军的同口径涨幅比较。若缺口名的估算涨幅接近或超过冠军，则该年冠军"不可确认"。
import path from 'path';
import { readJSON, writeJSON, OUT } from './lib.mjs';
import { rowOnOrBefore } from './prices.mjs';

const U = readJSON(path.join(OUT, 'universe.json'));
const H = readJSON(path.join(OUT, 'qqq_holdings_sep30.json'));
const SCALE = {};
for (let y = 1999; y <= 2008; y++) { const tot = H[`${y}-09-30`].rows.reduce((a, b) => a + b.value, 0); SCALE[y] = tot / (await rowOnOrBefore('QQQ', `${y}-09-30`, 5)).ac; }
const res = {};
for (let Y = 1999; Y <= 2006; Y++) {
  const A = U.mapped[Y - 1] || null, B = U.mapped[Y];
  const champ = U.years[Y].top[0];
  // 冠军同口径：9/30(Y-1)→9/30(Y) 未复权价涨幅
  let champSep = null;
  if (champ) { const a = await rowOnOrBefore(champ.sym, `${Y - 1}-09-30`, 5), b = await rowOnOrBefore(champ.sym, `${Y}-09-30`, 5); if (a && b) champSep = b.ac / a.ac - 1; }
  const gaps = U.years[Y].gaps.map(g => {
    const key = (B.find(x => x.name === g.name) || A?.find(x => x.name === g.name))?.key;
    const a = A?.find(x => x.key === key), b = B.find(x => x.key === key), c = U.mapped[Y + 1]?.find(x => x.key === key);
    // 拆股校正：QQQ 持股数 / QQQ 规模（总持仓市值 ÷ QQQ 复权价）≈ 该股指数股数；跨期翻倍以上视为拆股
    const sh = (yy, nm) => H[`${yy}-09-30`]?.rows.find(r => r.name === nm)?.shares;
    const splitF = (x, y0, z, y1) => { if (!x || !z) return 1; const r = (sh(y1, z.name) / sh(y0, x.name)) / (SCALE[y1] / SCALE[y0]); return r > 1.7 ? Math.round(r) : 1; };
    const est = a && b ? (b.impliedPx * splitF(a, Y - 1, b, Y)) / a.impliedPx - 1 : null;          // 9/30(Y-1)→9/30(Y)
    const estNext = b && c ? (c.impliedPx * splitF(b, Y, c, Y + 1)) / b.impliedPx - 1 : null;      // 9/30(Y)→9/30(Y+1)，参考
    return { name: g.name, ticker: g.ticker, why: g.why, core: g.core, estSepToSep: est, estNextSepToSep: estNext };
  });
  const threats = gaps.filter(g => g.estSepToSep != null && champSep != null && g.estSepToSep > champSep * 0.6);
  res[Y] = { champ: champ && { sym: champ.sym, calRet: champ.ret, sepToSep: champSep }, nGaps: gaps.length, unestimable: gaps.filter(g => g.estSepToSep == null).map(g => g.name), threats, gaps };
  console.log(Y, 'champ', champ?.sym, 'cal', champ ? (champ.ret * 100).toFixed(0) + '%' : '-', 'sep→sep', champSep != null ? (champSep * 100).toFixed(0) + '%' : '-',
    '| gaps', gaps.length, '| threats:', threats.map(t => `${t.name} ~${(t.estSepToSep * 100).toFixed(0)}%`).join('; ') || 'none',
    '| unestimable:', res[Y].unestimable.length);
}
writeJSON(path.join(OUT, 'gap_screen.json'), res);
