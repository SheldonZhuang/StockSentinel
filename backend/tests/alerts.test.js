import { describe, it, expect } from 'vitest';
import { detectSignalChanges } from '../api/signal.js';
import { buildAlertEmail } from '../utils/mailer.js';

const basePrev = {
  final_signal: 'neutral',
  monetary_signal: 'loose',
  fiscal_signal: 'neutral',
  admin_signal: 'neutral',
  ai_supply_signal: 'loose',
  ai_bubble_warning: 0,
};

const baseCurrent = {
  finalSignal: 'neutral',
  monetary: 'loose',
  fiscal: 'neutral',
  admin: 'neutral',
  aiSupply: 'loose',
  bubbleWarning: false,
  bubbleReasons: [],
};

describe('detectSignalChanges', () => {
  it('无任何变化 → 空数组不示警', () => {
    expect(detectSignalChanges(basePrev, baseCurrent)).toEqual([]);
  });

  it('首次运行（无历史快照）→ 不示警', () => {
    expect(detectSignalChanges(null, { ...baseCurrent, finalSignal: 'defense' })).toEqual([]);
  });

  it('最终信号变化 → final 事件', () => {
    const changes = detectSignalChanges(basePrev, { ...baseCurrent, finalSignal: 'defense' });
    expect(changes).toContainEqual({ kind: 'final', from: 'neutral', to: 'defense' });
  });

  it('任一维度转收紧 → dimTight 事件（用户策略：任一收紧=立即防守）', () => {
    const changes = detectSignalChanges(basePrev, { ...baseCurrent, fiscal: 'tight' });
    expect(changes).toContainEqual({ kind: 'dimTight', dim: 'fiscal', from: 'neutral', to: 'tight' });
  });

  it('已经是收紧的维度保持收紧 → 不重复示警', () => {
    const prev = { ...basePrev, fiscal_signal: 'tight' };
    expect(detectSignalChanges(prev, { ...baseCurrent, fiscal: 'tight' })).toEqual([]);
  });

  it('泡沫预警 0→1 → bubble 事件', () => {
    const changes = detectSignalChanges(basePrev, {
      ...baseCurrent, bubbleWarning: true, bubbleReasons: ['capex'],
    });
    expect(changes).toContainEqual({ kind: 'bubble', reasons: ['capex'] });
  });

  it('泡沫预警持续为1 → 不重复示警', () => {
    const prev = { ...basePrev, ai_bubble_warning: 1 };
    expect(detectSignalChanges(prev, { ...baseCurrent, bubbleWarning: true })).toEqual([]);
  });

  it('多事件同时发生 → 全部收集', () => {
    const changes = detectSignalChanges(basePrev, {
      ...baseCurrent, finalSignal: 'defense', fiscal: 'tight', admin: 'tight',
      bubbleWarning: true, bubbleReasons: ['modelUsage'],
    });
    expect(changes).toHaveLength(4);
  });
});

describe('buildAlertEmail', () => {
  it('主题含当前信号，正文含变化原因与四维现状', () => {
    const { subject, html } = buildAlertEmail({
      finalSignal: 'defense',
      changes: [
        { kind: 'final', from: 'neutral', to: 'defense' },
        { kind: 'dimTight', dim: 'fiscal', from: 'neutral', to: 'tight' },
        { kind: 'bubble', reasons: ['capex'] },
      ],
      details: {
        monetary: 'loose', fiscal: 'tight', admin: 'tight', aiSupply: 'loose',
        fiscalDeficitChangePct: -16.7, epuTradePercentile: 85.7, semiIpYoy: 14.4,
      },
    });
    expect(subject).toContain('防守');
    expect(html).toContain('财政政策');
    expect(html).toContain('-16.7%');
    expect(html).toContain('泡沫预警');
    expect(html).toContain('P86');
  });

  it('数据缺失时占位为 —，不抛错', () => {
    const { html } = buildAlertEmail({
      finalSignal: 'neutral',
      changes: [{ kind: 'dimTight', dim: 'monetary', from: 'loose', to: 'tight' }],
      details: { monetary: 'tight' },
    });
    expect(html).toContain('货币政策');
  });
});
