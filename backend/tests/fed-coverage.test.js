// 127b（2026-09-17）：FOMC 决议结果覆盖告警单测。
// 背景：解析靠 Fed 声明的固定句式，官网改版/改措辞/RSS 不可达都会让解析返回 null，
// 系统静默退回 FRED（即"显示持平、方向可能反了"的老问题），此前唯一的痕迹是一行日志。
// 本模块用"日历（该有决议）× 官网（是否真拿到）"两个独立源交叉，缺一不明判、判则必告警。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildFedCoverageStatus, sendFedCoverageAlert, _resetFedCoverageAlerts,
} from '../utils/fed-coverage.js';

const base = {
  today: '2026-10-28',
  isDecisionDate: true,
  gotStatement: true,
  rateSource: 'fed_statement',
  rateDecisionDate: '2026-10-28',
  lastRateStepDate: '2026-09-17',
};

beforeEach(() => { _resetFedCoverageAlerts(); delete process.env.ADMIN_EMAIL; });

describe('buildFedCoverageStatus（覆盖判据）', () => {
  it('决议日 + 拿到声明 → 不告警', () => {
    expect(buildFedCoverageStatus(base).alert).toBe(false);
  });

  it('决议日 + 没拿到声明 + FRED 未收录台阶 → 告警（方向可能失真）', () => {
    const r = buildFedCoverageStatus({ ...base, gotStatement: false, rateSource: 'fred' });
    expect(r.alert).toBe(true);
    expect(r.stage).toMatch(/未取到 Fed 声明/);
    expect(r.message).toMatch(/人工核查/);
  });

  it('决议日 + 没拿到声明，但 FRED 台阶已落地 → 不告警（序列已是权威）', () => {
    const r = buildFedCoverageStatus({
      ...base, gotStatement: false, rateSource: 'fred', lastRateStepDate: '2026-10-28',
    });
    expect(r.alert).toBe(false);
  });

  it('按兵不动的决议：无声明顶替、台阶也未覆盖、也没读到今天的声明 → 告警', () => {
    // 三条落实路径全不成立：这正是"声明解析失败"的真实形态
    const r = buildFedCoverageStatus({
      ...base, gotStatement: true, rateSource: 'fred', lastRateStepDate: '2026-09-17',
      rateDecisionDate: '2026-10-28',
    });
    expect(r.alert).toBe(true);
  });

  it('按兵不动的决议：声明已取到（日期=今天）→ 不告警（三条落实路径中的③成立）', () => {
    // 按兵不动时区间未变 → 没有新台阶，applyFedDecisionOverride 有意不顶替；
    // 但"今天读到今天的决议结果"这一点已成立，属正常路径，绝不该误报
    const r = buildFedCoverageStatus({
      ...base, gotStatement: true, rateSource: 'fred', lastRateStepDate: '2026-09-17',
      rateDecisionDate: '2026-10-28', fedStatementDate: '2026-10-28',
    });
    expect(r.alert).toBe(false);
  });

  it('声明日期不是今天（读到的是上次决议）→ 仍告警', () => {
    const r = buildFedCoverageStatus({
      ...base, gotStatement: true, rateSource: 'fred', lastRateStepDate: '2026-09-17',
      rateDecisionDate: '2026-10-28', fedStatementDate: '2026-09-16',
    });
    expect(r.alert).toBe(true);
  });

  it('台阶日为 null 又没声明 → 告警（信息完全缺失）', () => {
    const r = buildFedCoverageStatus({
      ...base, gotStatement: false, rateSource: 'fred', lastRateStepDate: null,
    });
    expect(r.alert).toBe(true);
  });

  it('非决议日 → 不告警（日历说不是，就没什么该有而没拿到的）', () => {
    expect(buildFedCoverageStatus({ ...base, isDecisionDate: false, gotStatement: false, rateSource: 'fred' }).alert).toBe(false);
  });

  it('声明取到了但覆盖没生效、且台阶未落地 → 告警（拿到声明却未收敛，需人工看）', () => {
    expect(buildFedCoverageStatus({ ...base, rateSource: 'fred' }).alert).toBe(true);
  });
});

describe('sendFedCoverageAlert（去重与失败重试）', () => {
  const status = buildFedCoverageStatus({ ...base, gotStatement: false, rateSource: 'fred' });

  it('同一决议日只发一次（看门狗每小时调用也不会刷屏）', async () => {
    const sent = [];
    const deps = { status, today: '2026-10-28', sendAlert: async () => { sent.push(1); }, adminEmail: 'a@b.c' };
    expect(await sendFedCoverageAlert(deps)).toBe(true);
    expect(await sendFedCoverageAlert(deps)).toBe(false); // 第二次被去重挡下
    expect(sent).toHaveLength(1);
  });

  it('未配置管理员邮箱 → 不发（也不标记已发，配好后仍能发出）', async () => {
    const sent = [];
    const sendAlert = async () => { sent.push(1); };
    expect(await sendFedCoverageAlert({ status, today: '2026-10-28', sendAlert, adminEmail: undefined })).toBe(false);
    expect(sent).toHaveLength(0);
    expect(await sendFedCoverageAlert({ status, today: '2026-10-28', sendAlert, adminEmail: 'a@b.c' })).toBe(true);
  });

  it('发送失败 → 撤回去重标记，下次可重试（告警不能因一次失败永久静默）', async () => {
    let fail = true;
    const sendAlert = async () => { if (fail) throw new Error('SMTP down'); };
    const p = { status, today: '2026-10-28', sendAlert, adminEmail: 'a@b.c' };
    expect(await sendFedCoverageAlert(p)).toBe(false);
    fail = false;
    expect(await sendFedCoverageAlert(p)).toBe(true); // 重试成功
  });

  it('不同决议日各自可发一次', async () => {
    const sent = [];
    const sendAlert = async () => { sent.push(1); };
    await sendFedCoverageAlert({ status, today: '2026-10-28', sendAlert, adminEmail: 'a@b.c' });
    await sendFedCoverageAlert({ status, today: '2026-12-09', sendAlert, adminEmail: 'a@b.c' });
    expect(sent).toHaveLength(2);
  });

  it('无告警内容 → 不发送', async () => {
    const sent = [];
    const ok = buildFedCoverageStatus(base);
    expect(await sendFedCoverageAlert({
      status: ok, today: '2026-10-28', sendAlert: async () => { sent.push(1); }, adminEmail: 'a@b.c',
    })).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
