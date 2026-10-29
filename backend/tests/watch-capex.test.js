// 130号：观察名单 CapEx（SpaceX 含 xAI）——只展示不进判定；EDGAR YTD 差分 → 单季同比 + 年初至今同比
import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/edgar-client.js', async importOriginal => ({
  ...(await importOriginal()),
  edgarGet: vi.fn(async () => ({ data: { units: { USD: [
    { start: '2025-01-01', end: '2025-06-30', val: 6965000000, form: '10-Q' },
    { start: '2025-01-01', end: '2025-09-30', val: 13846000000, form: '10-Q' },
    { start: '2026-01-01', end: '2026-06-30', val: 28476000000, form: '10-Q' },
    { start: '2026-01-01', end: '2026-09-30', val: 48069000000, form: '10-Q' },
  ] } } })),
}));

import { fetchWatchCapex } from '../api/fetch-ai-chain.js';

describe('fetchWatchCapex', () => {
  it('上市不足8季：单季同比与年初至今同比照算，数值取 EDGAR 原值', async () => {
    const [s] = await fetchWatchCapex();
    expect(s.symbol).toBe('SPCX');
    expect(s.qtrEnd).toBe('2026-09-30');
    expect(s.qtrCapex).toBe(19593000000);                 // 48.069B − 28.476B
    expect(s.qtrCapexYoY).toBeCloseTo((19593 / 6881 - 1) * 100, 1);
    expect(s.ytdCapex).toBe(48069000000);
    expect(s.ytdCapexYoY).toBeCloseTo((48069 / 13846 - 1) * 100, 1);
  });
});
