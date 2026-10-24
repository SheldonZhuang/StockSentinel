// 策略实验室引擎：执行滞后、成本、权重漂移、前视检测（合成面板，不依赖网络/缓存）
import { describe, it, expect } from 'vitest';
import { backtest, stats } from '../backtest/lab/engine.mjs';
import { smaFilter, buyHold, volTarget, gem } from '../backtest/lab/strategies.mjs';

function panelFrom(series, { rf = 0 } = {}) {
  const n = Object.values(series)[0].length;
  const dates = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2000, 0, 3) + i * 864e5).toISOString().slice(0, 10));
  const px = {}, ret = {};
  for (const [k, p] of Object.entries(series)) {
    px[k] = Float64Array.from(p, v => v / p[0]);
    ret[k] = Float64Array.from(p, (v, i) => (i ? v / p[i - 1] - 1 : 0));
  }
  const rfd = new Float64Array(n).fill(rf);
  ret.CASH = Float64Array.from(rfd, (v, i) => (i ? v : 0));
  px.CASH = new Float64Array(n); for (let i = 0; i < n; i++) px.CASH[i] = i ? px.CASH[i - 1] * (1 + ret.CASH[i]) : 1;
  return { dates, px, ret, rf: rfd };
}
const walk = (n, seed = 1, drift = 0.0005, sd = 0.02) => {
  let s = seed, p = 100; const o = [];
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < n; i++) { o.push(p); const z = Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd()); p *= 1 + drift + sd * z; }
  return o;
};

describe('引擎', () => {
  it('买入持有 = 标的总回报（零成本）', () => {
    const P = panelFrom({ A: [100, 110, 99, 121] });
    const r = backtest(P, buyHold({ A: 1 }), { lag: 0, costBps: 0 });
    expect(r.curve.at(-1)).toBeCloseTo(1.21, 10);
  });
  it('lag=1：第 0 日信号第 1 日收盘成交，第 1 日收益不归新仓', () => {
    const P = panelFrom({ A: [100, 200, 200, 300] });
    const r = backtest(P, buyHold({ A: 1 }), { lag: 1, costBps: 0 });
    expect(r.curve[1]).toBeCloseTo(1, 10);      // 第 1 日仍空仓
    expect(r.curve.at(-1)).toBeCloseTo(1.5, 10); // 200 → 300
  });
  it('成本按换手扣：一进一出各 10bp', () => {
    const P = panelFrom({ A: [100, 100, 100, 100] });
    let k = 0; const s = () => (k++ === 0 ? { A: 1 } : k === 2 ? {} : null);
    const r = backtest(P, s, { lag: 0, costBps: 10 });
    expect(r.curve.at(-1)).toBeCloseTo(0.999 * 0.999, 12);
    expect(r.trades).toBe(2);
  });
  it('两资产 50/50 不再平衡时权重随价格漂移', () => {
    const P = panelFrom({ A: [100, 200, 200], B: [100, 100, 50] });
    const r = backtest(P, buyHold({ A: 0.5, B: 0.5 }), { lag: 0, costBps: 0 });
    // 第 1 日 1.5（A 翻倍），第 2 日 B 腰斩：B 占 1/3 → 1.5 × (1 − 1/3 × 0.5) = 1.25
    expect(r.curve.at(-1)).toBeCloseTo(1.25, 10);
  });
  it('现金部分按 rf 计息', () => {
    const P = panelFrom({ A: [100, 100, 100] }, { rf: 0.001 });
    const r = backtest(P, () => null, { costBps: 0 });
    expect(r.curve.at(-1)).toBeCloseTo(1.001 ** 2, 12);
  });
});

describe('前视检测：把第 k 日之后的数据换成噪声，k 日及之前的净值不得变化', () => {
  const n = 900, k = 600;
  const base = { Q: walk(n, 7), E: walk(n, 11), B: walk(n, 13, 0.0001, 0.005) };
  const noisy = Object.fromEntries(Object.entries(base).map(([s, p], j) => [s, p.map((v, i) => (i > k ? v * (1 + 0.3 * Math.sin(i * (j + 2))) : v))]));
  const cases = {
    smaFilter: () => smaFilter({ risk: 'Q', signal: 'Q', n: 200, band: 0.02 }),
    volTarget: () => volTarget({ risk: 'Q', target: 0.3, gate: { signal: 'Q', n: 100, band: 0 } }),
    gem: () => gem({ us: 'Q', intl: 'E', bond: 'B', lookback: 120 }),
  };
  for (const [name, mk] of Object.entries(cases)) {
    it(name, () => {
      const a = backtest(panelFrom(base), mk(), { costBps: 5 });
      const b = backtest(panelFrom(noisy), mk(), { costBps: 5 });
      for (let i = 0; i <= k; i++) expect(b.curve[i]).toBeCloseTo(a.curve[i], 12);
      expect(stats(a).trades).toBeGreaterThan(0);
    });
  }
});
