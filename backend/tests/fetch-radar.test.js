// 120c号：AI需求第二源（Cloudflare Radar）趋势纯函数单测——
// 分歧核查佐证口径（28日均 vs 前28日均），不进判定链
import { describe, it, expect } from 'vitest';
import { calcRadarTrendPct } from '../api/fetch-radar.js';

describe('calcRadarTrendPct（近28日均 vs 前28日均）', () => {
  it('增长趋势：后窗均值高于前窗 → 正变化率', () => {
    const values = [...Array(28).fill(0.5), ...Array(28).fill(0.6)];
    expect(calcRadarTrendPct(values)).toBeCloseTo(20, 5);
  });
  it('回落趋势 → 负变化率；只取末尾两个窗口（更早数据忽略）', () => {
    const values = [...Array(30).fill(9), ...Array(28).fill(1.0), ...Array(28).fill(0.8)];
    expect(calcRadarTrendPct(values)).toBeCloseTo(-20, 5);
  });
  it('Radar 归一化字符串值可解析；非数值项被过滤', () => {
    const values = [...Array(28).fill('0.5'), ...Array(28).fill('0.55')];
    expect(calcRadarTrendPct(values)).toBeCloseTo(10, 5);
  });
  it('数据不足两个窗口 / 非数组 / 前窗全零 → null（第二源本轮不可用）', () => {
    expect(calcRadarTrendPct(Array(55).fill(1))).toBe(null);
    expect(calcRadarTrendPct(null)).toBe(null);
    expect(calcRadarTrendPct([...Array(28).fill(0), ...Array(28).fill(1)])).toBe(null);
  });
});
