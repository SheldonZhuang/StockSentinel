import { describe, it, expect } from 'vitest';
import { parseMultplCape, capePercentile30y } from '../utils/cape.js';
import { parseMultplCape as backtestParse } from '../backtest/run-backtest.js';

const FIXTURE = `
<tr><td>Jul 1, 2026</td><td> &#x2002; 41.10 </td></tr>
<tr><td>Jun 1, 2026</td><td> &#x2002; 40.55 </td></tr>
<tr><td>Jun 15, 2026</td><td> &#x2002; 99.99 </td></tr>
<tr><td>May 1, 2026</td><td> &#x2002; 39.20 </td></tr>
`;

describe('cape.js（线上CAPE层数据源）', () => {
  it('解析multpl月度表：升序、同月保留靠前一条', () => {
    const s = parseMultplCape(FIXTURE);
    expect(s).toEqual([
      { month: '2026-05', value: 39.2 },
      { month: '2026-06', value: 40.55 },
      { month: '2026-07', value: 41.1 },
    ]);
  });

  it('与回测parseMultplCape同一实现（fixture锁定一致性，防两处漂移）', () => {
    expect(parseMultplCape(FIXTURE)).toEqual(backtestParse(FIXTURE));
  });

  it('capePercentile30y：末端值在30年窗口内的分位；样本<120月→null', () => {
    const series = Array.from({ length: 360 }, (_, i) => ({ month: `m${i}`, value: i + 1 }));
    expect(capePercentile30y(series)).toBe(100); // 最新值最大
    series[359] = { month: 'last', value: 180.5 }; // 大于前180个
    expect(capePercentile30y(series)).toBeCloseTo(50.3, 1);
    expect(capePercentile30y(series.slice(0, 100))).toBeNull();
  });
});
