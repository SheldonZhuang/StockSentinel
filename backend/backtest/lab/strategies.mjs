// 策略库：每个工厂返回 (ctx) => null | 目标权重。只在需要调仓时返回权重（引擎按换手计成本）。
// 规则一律只用 ≤ 当日收盘的数据；参数含义见各函数注释。来源见 tasks/strategy-lab.md。

const same = (a, b) => {
  const ks = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of ks) if (Math.abs((a?.[k] || 0) - (b?.[k] || 0)) > 1e-9) return false;
  return true;
};
/** 只在目标与上次发出的目标不同时返回（避免"每天重发同一目标"把漂移权重拉回去） */
function emit(state, target) {
  if (same(state.last, target)) return null;
  state.last = target; return target;
}

/** 买入持有（可多资产固定权重，rebalance='monthly'|'never'） */
export const buyHold = (weights, { rebalance = 'never' } = {}) => ctx => {
  if (!ctx.state.started) { ctx.state.started = true; return weights; }
  return rebalance === 'monthly' && ctx.monthEnd ? weights : null;
};

/**
 * 均线过滤：signal 收盘价相对其 n 日均线，上穿 (1+band) 进 risk，下穿 (1−band) 退到 off。
 * freq='daily' 每天检查；'monthly' 只在月末检查。
 */
export const smaFilter = ({ risk, signal, n = 200, band = 0.02, off = null, freq = 'daily' }) => ctx => {
  const s = ctx.state;
  if (freq === 'monthly' && !ctx.monthEnd && s.on !== undefined) return null;
  const ma = ctx.sma(signal, n); if (!(ma > 0)) return null;
  const r = ctx.px(signal) / ma - 1;
  if (s.on === undefined) s.on = r > 0; // 首日：只看在不在均线之上
  else if (!s.on && r > band) s.on = true;
  else if (s.on && r < -band) s.on = false;
  return emit(s, s.on ? { [risk]: 1 } : off ? { [off]: 1 } : {});
};

/**
 * 波动率目标：仓位 = min(cap, target / 已实现波动(risk, lookback))，变化超过 step 才调仓。
 * 可叠加均线过滤（gate=smaFilter 参数）：过滤器为空仓时仓位为 0。
 */
export const volTarget = ({ risk, target = 0.4, lookback = 20, cap = 1, step = 0.1, gate = null }) => {
  const g = gate ? smaFilter({ ...gate, risk }) : null;
  return ctx => {
    const s = ctx.state;
    if (g) { s.g ??= {}; const t = g({ ...ctx, state: s.g }); if (t) s.gateOn = !!t[risk]; if (s.gateOn === undefined) return null; }
    const v = ctx.vol(risk, lookback); if (!(v > 0)) return null;
    let w = Math.min(cap, target / v);
    if (g && !s.gateOn) w = 0;
    w = Math.round(w / step) * step;
    return emit(s, w > 0 ? { [risk]: w } : {});
  };
};

/**
 * 双动量 GEM（Antonacci）：月末，若 lookback 回报 us > CASH，持 us/intl 中较强者，否则持 bond。
 */
export const gem = ({ us = 'SPY', intl = 'EFA', bond = 'AGG', lookback = 252 }) => ctx => {
  if (!ctx.monthEnd && ctx.state.last) return null;
  const mu = ctx.mom(us, lookback), mi = ctx.mom(intl, lookback), mc = ctx.mom('CASH', lookback);
  if (!(mu === mu)) return null;
  const pick = mu > mc ? (mu >= mi ? us : intl) : bond;
  return emit(ctx.state, { [pick]: 1 });
};

/**
 * 加速双动量 ADM：月末，score = 1/3/6 月回报之和，取 us/intl 较高者；都 < 0 则持 bond。
 * hold 可把信号标的映射到实际持有标的（如 {SPY:'SSO'}：用 SPY 打分、持 2x）；
 * volTarget 可选：对持有的风险腿按 20 日波动缩放仓位（月末定，不日调），剩余现金。
 */
export const adm = ({ us = 'SPY', intl = 'EFA', bond = 'TLT', hold = {}, volTarget = null, volN = 20 }) => ctx => {
  if (!ctx.monthEnd && ctx.state.last) return null;
  const sc = t => ctx.mom(t, 21) + ctx.mom(t, 63) + ctx.mom(t, 126);
  const a = sc(us), b = sc(intl);
  if (!(a === a && b === b)) return null;
  const pick = Math.max(a, b) < 0 ? bond : a >= b ? us : intl;
  const sym = hold[pick] || pick;
  let w = 1;
  if (volTarget && pick !== bond) { const v = ctx.vol(sym, volN); if (v > 0) w = Math.min(1, Math.round(volTarget / v * 10) / 10); }
  return emit(ctx.state, w > 0 ? { [sym]: w } : {});
};

/**
 * 多资产时间序列动量（管理期货的 ETF 只做多近似）：月末，每个资产 12 个月回报 > 现金 则持有，
 * 持有的资产按逆波动率分配到组合目标波动 target（单资产上限 capEach，总仓位 ≤ 1），否则现金。
 * 与真实 CTA 的差别：不做空、无期货杠杆，2022 年那种"做空债券赚钱"拿不到，只能躲开。
 */
export const tsmom = ({ syms, lookback = 252, volN = 63, target = 0.10, capEach = 0.4 }) => ctx => {
  if (!ctx.monthEnd && ctx.state.last) return null;
  const mc = ctx.mom('CASH', lookback);
  const on = syms.filter(t => ctx.mom(t, lookback) > mc);
  if (syms.some(t => !(ctx.mom(t, lookback) === ctx.mom(t, lookback)))) return null;
  if (!on.length) return emit(ctx.state, {});
  const iv = on.map(t => 1 / ctx.vol(t, volN)), tot = iv.reduce((a, b) => a + b, 0);
  // 等风险贡献近似（忽略相关性）：w_i ∝ 1/σ_i，再整体缩放到目标波动（按"各资产独立"的上界估计，偏保守）
  let w = on.map((t, k) => iv[k] / tot);
  const portVol = Math.sqrt(on.reduce((a, t, k) => a + (w[k] * ctx.vol(t, volN)) ** 2, 0));
  const scale = Math.min(1 / w.reduce((a, b) => a + b, 0), target / portVol);
  w = w.map(x => Math.min(capEach, x * scale));
  return emit(ctx.state, Object.fromEntries(on.map((t, k) => [t, Math.round(w[k] * 100) / 100]).filter(([, v]) => v > 0)));
};

/** 逆波动率风险平价（只做多，不加杠杆）：月末按 1/σ 分配，总仓位 1 */
export const riskParity = ({ syms, volN = 63 }) => ctx => {
  if (!ctx.monthEnd && ctx.state.last) return null;
  const iv = syms.map(t => 1 / ctx.vol(t, volN));
  if (iv.some(x => !(x > 0) || !isFinite(x))) return null;
  const tot = iv.reduce((a, b) => a + b, 0);
  return (ctx.state.last = Object.fromEntries(syms.map((t, k) => [t, Math.round(iv[k] / tot * 1000) / 1000])));
};

/**
 * 组合：把多个子策略按固定资金比例分账，每个子策略在自己的账内独立运行（各自状态、各自漂移），
 * 月末把各账的实际权重按 alloc 重新合成并再平衡（各账资金回到 alloc）。
 * 只要任一子策略今天发出新目标，或月末，就输出合并后的目标。
 */
export const combo = (parts) => {
  const subs = parts.map(([alloc, mk]) => ({ alloc, f: mk(), st: {}, w: {} }));
  return ctx => {
    let changed = false;
    for (const s of subs) {
      const t = s.f({ ...ctx, state: s.st });
      if (t) { s.w = t; changed = true; }
    }
    if (!changed && !ctx.monthEnd) return null;
    const out = {};
    for (const s of subs) for (const [k, v] of Object.entries(s.w)) out[k] = (out[k] || 0) + s.alloc * v;
    return out;
  };
};

/**
 * 行业趋势（Zarattini & Antonacci 简化版，只做多）：每个行业 entryN 日新高进场、exitN 日新低出场；
 * 持有中的行业按逆波动率分配，总仓位 ≤ 1（不加杠杆），其余现金。月末或有进出时重算权重。
 */
export const sectorTrend = ({ syms, entryN = 50, exitN = 25, volN = 63 }) => ctx => {
  const s = ctx.state; s.in ??= new Set();
  const { px } = ctx.panel, i = ctx.i;
  if (i < Math.max(entryN, exitN, volN)) return null;
  let changed = false;
  for (const t of syms) {
    const p = px[t]; let hi = -Infinity, lo = Infinity;
    for (let k = i - entryN; k < i; k++) hi = Math.max(hi, p[k]);
    for (let k = i - exitN; k < i; k++) lo = Math.min(lo, p[k]);
    if (!s.in.has(t) && p[i] > hi) { s.in.add(t); changed = true; }
    else if (s.in.has(t) && p[i] < lo) { s.in.delete(t); changed = true; }
  }
  if (!changed && !ctx.monthEnd) return null;
  const held = [...s.in];
  if (!held.length) return emit(s, {});
  const iv = held.map(t => 1 / ctx.vol(t, volN)), tot = iv.reduce((a, b) => a + b, 0);
  // 每个行业最多 1/syms.length × 2 的仓位，避免单一行业独占；总和 ≤ 1
  const capEach = 2 / syms.length;
  const w = Object.fromEntries(held.map((t, k) => [t, Math.min(capEach, iv[k] / tot)]));
  return changed || ctx.monthEnd ? (s.last = w) : null;
};
