// capex_guidance_records 自愈迁移语义（113号）单测——用真实 sql.js 临时库：
// ① 补源前旧代码落的 none 记录（source 为空）不算已处理，窗口内会被重新检测；
// ② saveGuidanceRecord 为 upsert，重跑结果覆盖旧行而非被 UNIQUE 挡掉。
// 云端 Railway 与本机实例靠这两条自动收敛，无需人工修库。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DB_PATH 在 storage.js 模块加载时读取，须先设 env 再动态 import
const tmpDb = path.join(os.tmpdir(), `stock-sentinel-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
const storage = await import('../utils/storage.js');

afterAll(() => {
  try { fs.unlinkSync(tmpDb); } catch { /* 已清理 */ }
});

describe('capex_guidance_records 自愈迁移（113号）', () => {
  it('旧语义 none 记录（source 为空）不算已处理；完整记录算已处理', async () => {
    // 模拟补源前旧代码落的档：direction=none、无 source
    await storage.saveGuidanceRecord({
      symbol: 'GOOGL', filingDate: '2026-07-22', accession: 'ACC-LEGACY-NONE', direction: 'none',
    });
    // 补源后的完整档：none 但 source=web（双源均未见指引的强否定）
    await storage.saveGuidanceRecord({
      symbol: 'META', filingDate: '2026-07-29', accession: 'ACC-WEB-NONE', direction: 'none', source: 'web',
    });
    // 有指引的档
    await storage.saveGuidanceRecord({
      symbol: 'MSFT', filingDate: '2026-07-30', accession: 'ACC-RAISE', direction: 'raise', source: 'press_release',
    });

    const processed = await storage.getProcessedGuidanceAccessions();
    expect(processed).not.toContain('ACC-LEGACY-NONE'); // 遗留档重新进检测窗口
    expect(processed).toContain('ACC-WEB-NONE');
    expect(processed).toContain('ACC-RAISE');
  });

  it('同 accession 重跑覆盖旧行（upsert），不残留重复记录', async () => {
    await storage.saveGuidanceRecord({
      symbol: 'GOOGL', filingDate: '2026-07-22', accession: 'ACC-LEGACY-NONE',
      direction: 'raise', confidence: 'high', source: 'web',
      fyGuidance: 'FY2026 $195-205B', qtrCapex: 44924e6, qtrCapexYoY: 100.1,
    });
    const rows = (await storage.getRecentGuidance(20)).filter(r => r.symbol === 'GOOGL');
    expect(rows).toHaveLength(1); // 覆盖而非新增
    expect(rows[0].direction).toBe('raise');
    expect(rows[0].source).toBe('web');
    expect(rows[0].fy_guidance).toBe('FY2026 $195-205B');
    // 覆盖后已是完整档 → 算已处理
    expect(await storage.getProcessedGuidanceAccessions()).toContain('ACC-LEGACY-NONE');
  });
});
