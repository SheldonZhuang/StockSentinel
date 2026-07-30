// 116号审查修复单测：
// ① getActiveAdminSignal"最新意图"语义——短期 override 过期后旧的永不过期 override 不得僵尸复活；
//    signal='auto' 清除哨兵（误报 N3 事件的手动清除路径）
// ② mailer 对 Resend SDK 真实错误语义的处理——SDK 从不 reject（返回 {data,error}），
//    必须检查 error 字段，否则所有失败被计为成功、重试链路全是死代码
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDb = path.join(os.tmpdir(), `stock-sentinel-r116-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
const storage = await import('../utils/storage.js');

afterAll(() => {
  try { fs.unlinkSync(tmpDb); } catch { /* 已清理 */ }
});

describe('getActiveAdminSignal 最新意图语义（116号修复）', () => {
  it('短期 override 过期后，更早的永不过期 override 不复活', async () => {
    await storage.setAdminSignal('fiscal', 'tight', null, '永不过期的旧覆盖', 'admin');
    // 之后录一条已过期的短期覆盖（最新意图，但已过期）
    await storage.setAdminSignal('fiscal', 'loose', '2020-01-01 00:00:00', '短期覆盖', 'admin');
    const active = await storage.getActiveAdminSignal('fiscal');
    expect(active).toBeNull(); // 最新一条已过期 → 无 override（旧的 tight 不得复活）
  });

  it("signal='auto' 清除哨兵：撤销当前 override", async () => {
    await storage.setAdminSignal('ai_supply', 'tight', null, 'N3 误报', 'auto-detector');
    expect((await storage.getActiveAdminSignal('ai_supply'))?.signal).toBe('tight');
    await storage.setAdminSignal('ai_supply', 'auto', null, '人工核实为误报，清除', 'admin');
    expect(await storage.getActiveAdminSignal('ai_supply')).toBeNull();
  });

  it('未过期的最新 override 正常生效', async () => {
    await storage.setAdminSignal('administrative', 'tight', null, null, 'admin');
    expect((await storage.getActiveAdminSignal('administrative'))?.signal).toBe('tight');
  });
});

describe('mailer 对 Resend {data,error} 语义的处理（116号修复）', () => {
  it('SDK 返回 error 对象（不 reject）时计为失败并重试，全败后 failed 计数如实', async () => {
    vi.resetModules();
    const sendMock = vi.fn().mockResolvedValue({ data: null, error: { name: 'rate_limit', message: '429' } });
    vi.doMock('resend', () => ({ Resend: class { emails = { send: sendMock }; } }));
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendSignalAlert } = await import('../utils/mailer.js');
    const r = await sendSignalAlert([{ email: 'a@example.com' }], { finalSignal: 'reduce', changes: [], details: {} });
    expect(r.failed).toBe(1);
    expect(r.sent).toBe(0);
    expect(sendMock).toHaveBeenCalledTimes(3); // 3 次重试真实发生（旧实现首轮即"全部成功"）
    vi.doUnmock('resend');
  }, 20000);

  it('SDK 返回 error:null 时计为成功', async () => {
    vi.resetModules();
    const sendMock = vi.fn().mockResolvedValue({ data: { id: 'ok' }, error: null });
    vi.doMock('resend', () => ({ Resend: class { emails = { send: sendMock }; } }));
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendSignalAlert } = await import('../utils/mailer.js');
    const r = await sendSignalAlert([{ email: 'a@example.com' }], { finalSignal: 'reduce', changes: [], details: {} });
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(0);
    vi.doUnmock('resend');
  });

  it('replica 实例压制订阅者群发（双实例防重复邮件）', async () => {
    vi.resetModules();
    const sendMock = vi.fn();
    vi.doMock('resend', () => ({ Resend: class { emails = { send: sendMock }; } }));
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.INSTANCE_ROLE = 'replica';
    const { sendSignalAlert } = await import('../utils/mailer.js');
    const r = await sendSignalAlert([{ email: 'a@example.com' }], { finalSignal: 'reduce', changes: [], details: {} });
    expect(r.skippedReplica).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
    delete process.env.INSTANCE_ROLE;
    vi.doUnmock('resend');
  });
});
