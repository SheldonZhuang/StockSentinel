// 策略实验室回测引擎：日频、多资产目标权重、执行滞后、换手成本、现金计息。
// 策略接口：strategy(ctx) → null（保持不动）或 {SYM: weight, ...}（剩余为现金，按无风险利率计息）。
//   ctx = { i, d, panel, sma(sym,n), mom(sym,n), vol(sym,n), monthEnd, state }，只能看到 ≤ i 的数据（引擎不防君子，策略自律；
//   lab/tests 有前视检测：把 i 之后的数据改成噪声，结果不得变化）
// 执行：第 i 日收盘出信号 → 第 i+lag 日收盘成交（默认 lag=1，即"看到收盘后次日收盘下单"，保守且无前视）；
//   成交前的当日收益仍归旧仓位。成本 = 换手 Σ|Δw| × costBps（单边），每次调仓从净值里扣。
// 权重在两次调仓之间随价格漂移（真实持仓口径），不会被每天隐式再平衡。

export function makeCtx(panel) {
  const { px, ret, dates } = panel;
  const n = dates.length;
  const memo = new Map();
  const roll = (key, f) => { if (!memo.has(key)) memo.set(key, f()); return memo.get(key); };
  /** 滚动均值（第 i 位 = 含 i 在内最近 w 个值的均值；不足 w 为 NaN） */
  const smaArr = (sym, w) => roll(`sma|${sym}|${w}`, () => {
    const p = px[sym], o = new Float64Array(n).fill(NaN); let s = 0;
    for (let i = 0; i < n; i++) { s += p[i]; if (i >= w) s -= p[i - w]; if (i >= w - 1) o[i] = s / w; }
    return o;
  });
  /** 滚动年化波动（日收益标准差 × √252） */
  const volArr = (sym, w) => roll(`vol|${sym}|${w}`, () => {
    const r = ret[sym], o = new Float64Array(n).fill(NaN); let s = 0, q = 0;
    for (let i = 1; i < n; i++) {
      s += r[i]; q += r[i] * r[i];
      if (i > w) { s -= r[i - w]; q -= r[i - w] * r[i - w]; }
      if (i >= w) { const m = s / w; o[i] = Math.sqrt(Math.max(q / w - m * m, 0) * 252); }
    }
    return o;
  });
  const isMonthEnd = roll('me', () => Uint8Array.from(dates, (d, i) => (i === n - 1 || dates[i + 1].slice(0, 7) !== d.slice(0, 7) ? 1 : 0)));
  return (i, state) => ({
    i, d: dates[i], panel, state,
    px: sym => px[sym][i],
    sma: (sym, w) => smaArr(sym, w)[i],
    vol: (sym, w) => volArr(sym, w)[i],
    mom: (sym, w) => (i >= w ? px[sym][i] / px[sym][i - w] - 1 : NaN),
    monthEnd: isMonthEnd[i] === 1,
  });
}

/**
 * @param panel loadPanel() 结果
 * @param strategy (ctx) => null | Record<string, number>
 * @param {{start?:string, end?:string, lag?:number, costBps?:number, initialWeights?:Record<string,number>}} opts
 */
export function backtest(panel, strategy, { start = panel.dates[0], end = '9999-12-31', lag = 1, costBps = 5 } = {}) {
  const { dates, ret, rf } = panel;
  const i0 = dates.findIndex(d => d >= start);
  let i1 = dates.length - 1; while (dates[i1] > end) i1--;
  if (i0 < 0 || i1 <= i0) throw new Error(`empty window ${start}..${end}`);
  const ctxAt = makeCtx(panel);
  const state = {};
  let w = {}, eq = 1, pending = null, trades = 0, turnover = 0, exposureSum = 0, curI = i0;
  const log = [];
  const curve = new Float64Array(i1 - i0 + 1), cash = new Float64Array(i1 - i0 + 1);
  const execute = target => {
    const keys = new Set([...Object.keys(w), ...Object.keys(target)]);
    let to = 0; for (const k of keys) to += Math.abs((target[k] || 0) - (w[k] || 0));
    if (to > 1e-9) { eq *= 1 - to * costBps / 1e4; trades++; turnover += to; log.push({ d: dates[curI], eq, w: target }); }
    w = Object.fromEntries(Object.entries(target).filter(([, v]) => Math.abs(v) > 1e-12));
  };
  for (let i = i0; i <= i1; i++) {
    curI = i;
    if (i > i0) {
      let gross = 0, pr = 0;
      for (const [k, v] of Object.entries(w)) { pr += v * ret[k][i]; gross += v; }
      pr += (1 - gross) * rf[i];
      eq *= 1 + pr;
      if (eq <= 0) { eq = 0; w = {}; }
      else for (const k of Object.keys(w)) w[k] = w[k] * (1 + ret[k][i]) / (1 + pr);
    }
    if (pending && pending.at === i) { execute(pending.w); pending = null; }
    const t = eq > 0 ? strategy(ctxAt(i, state)) : null;
    if (t) { if (lag === 0) execute(t); else pending = { at: i + lag, w: t }; }
    curve[i - i0] = eq;
    exposureSum += Object.values(w).reduce((a, b) => a + b, 0);
  }
  return { dates: dates.slice(i0, i1 + 1), curve, rf: rf.slice(i0, i1 + 1), trades, turnover, avgExposure: exposureSum / (i1 - i0 + 1), log };
}

/** 统计：总收益、CAGR、年化波动、夏普（超额 rf）、最大回撤及区间、Calmar、最差自然年、逐年收益 */
export function stats(res, initial = 10000) {
  const { dates, curve, rf } = res;
  const n = curve.length;
  const yrs = (Date.parse(dates[n - 1]) - Date.parse(dates[0])) / (365.25 * 864e5);
  const mult = curve[n - 1] / curve[0];
  let peak = curve[0], peakI = 0, mdd = 0, mddPeak = 0, mddTrough = 0, s = 0, q = 0;
  for (let i = 1; i < n; i++) {
    if (curve[i] > peak) { peak = curve[i]; peakI = i; }
    const dd = curve[i] / peak - 1; if (dd < mdd) { mdd = dd; mddPeak = peakI; mddTrough = i; }
    const ex = curve[i - 1] > 0 ? curve[i] / curve[i - 1] - 1 - rf[i] : 0; s += ex; q += ex * ex;
  }
  const m = s / (n - 1), sd = Math.sqrt(Math.max(q / (n - 1) - m * m, 0));
  const yearly = {}; let y0 = dates[0].slice(0, 4), base = curve[0];
  for (let i = 1; i < n; i++) {
    const y = dates[i].slice(0, 4);
    if (y !== y0) { yearly[y0] = curve[i - 1] / base - 1; base = curve[i - 1]; y0 = y; }
  }
  yearly[y0] = curve[n - 1] / base - 1;
  const cagr = mult > 0 ? mult ** (1 / yrs) - 1 : -1;
  return {
    from: dates[0], to: dates[n - 1], years: yrs,
    final: initial * mult, totalRet: mult - 1, cagr, vol: sd * Math.sqrt(252),
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(252) : 0, mdd, mddFrom: dates[mddPeak], mddTo: dates[mddTrough],
    calmar: mdd < 0 ? cagr / -mdd : Infinity, worstYear: Math.min(...Object.values(yearly)), yearly,
    trades: res.trades, tradesPerYear: res.trades / yrs, turnoverPerYear: res.turnover / yrs, avgExposure: res.avgExposure,
  };
}
