// 2000 年起的合成 TQQQ 数据集（压力测试共用）：TQQQ 2010-02 前用 QQQ 日收益合成，开盘价按 QQQ 隔夜涨跌×3；
// VXN 2001-02 前用 QQQ 20 日已实现波动×1.2；QQQ 信号指标用 1999 年起的复权收盘（H10 只用 120 日线与收盘）
import { tiingo } from '../ndx-rotation/lib.mjs';
import { SWAP_SPREAD } from './data.mjs';
import { indicators } from './hypo10-13.mjs';

export async function synth2000(D) {
  const q = (await tiingo('QQQ')).rows, realT = D.px.TQQQ, first = [...realT.keys()].sort()[0];
  const T = new Map(); let c = 1, prevQ = null;
  for (const r of q) {
    if (r.d >= first) break;
    if (prevQ) {
      const fin = (2 * (D.rf(r.d) + SWAP_SPREAD) + 0.86) / 100 / 252;
      const o = c * (1 + 3 * (r.ao / prevQ.ac - 1));
      c = c * (1 + 3 * (r.ac / prevQ.ac - 1) - fin);
      T.set(r.d, { ao: Math.max(o, 1e-9), ac: Math.max(c, 1e-9) });
    }
    prevQ = r;
  }
  // 与真实 TQQQ 首日按收盘衔接（缩放合成段使其末值 = 真实首日开盘）
  const k = realT.get(first).ao / c;
  const px = new Map([...[...T].map(([d, v]) => [d, { ao: v.ao * k, ac: v.ac * k }]), ...realT]);
  // VXN 2001-02 前：QQQ 20 日已实现波动 × 1.2（隐含通常高于已实现）
  const rv = new Map(); const rs = q.map((r, i) => (i ? Math.log(r.ac / q[i - 1].ac) : 0));
  q.forEach((r, i) => { if (i >= 20) { const w = rs.slice(i - 19, i + 1), m = w.reduce((a, b) => a + b, 0) / 20; rv.set(r.d, Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 19 * 252) * 100 * 1.2); } });
  const vxn = d => (d < '2001-02-02' ? rv.get(d) ?? 60 : D.vxn(d));
  const days = q.map(r => r.d).filter(d => d >= '2000-01-03' && px.has(d));
  const sigQQQ = indicators(q.map(r => ({ d: r.d, c: r.ac })));
  return { ...D, px: { ...D.px, TQQQ: px }, vxn, days, sig: { ...D.sig, QQQ: sigQQQ } };
}
