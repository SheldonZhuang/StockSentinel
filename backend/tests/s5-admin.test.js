import { describe, it, expect } from 'vitest';
import { deriveS5State } from '../api/admin.js';
import { buildS5ActionEmail } from '../utils/mailer.js';

const row = (date, final) => ({ date, final_signal: final });

describe('deriveS5State（S5执行台状态机）', () => {
  it('非defense=持仓；reduce日例行动作=持有+攒储备', () => {
    const s = deriveS5State([row('2026-07-18', 'reduce'), row('2026-07-17', 'neutral')]);
    expect(s.state).toBe('in_market');
    expect(s.todayAction).toBe('hold_accumulate');
  });

  it('进入defense当日=卖出指令；持续defense=保持空仓', () => {
    const enter = deriveS5State([row('2026-07-17', 'reduce'), row('2026-07-18', 'defense')]);
    expect(enter.state).toBe('in_cash');
    expect(enter.todayAction).toBe('sell_all');
    const stay = deriveS5State([row('2026-07-16', 'reduce'), row('2026-07-17', 'defense'), row('2026-07-18', 'defense')]);
    expect(stay.todayAction).toBe('stay_cash');
  });

  it('退出defense当日（含到reduce）=立即买回指令', () => {
    const s = deriveS5State([row('2026-07-16', 'defense'), row('2026-07-17', 'defense'), row('2026-07-18', 'reduce')]);
    expect(s.state).toBe('in_market');
    expect(s.todayAction).toBe('buyback_all');
    expect(s.transitions.map(t => t.kind)).toEqual(['buyback']);
  });

  it('neutral/attack=定投+储备部署；transitions按时间正序且含进出双向', () => {
    const s = deriveS5State([
      row('2026-07-14', 'neutral'), row('2026-07-15', 'defense'),
      row('2026-07-16', 'defense'), row('2026-07-17', 'neutral'), row('2026-07-18', 'neutral'),
    ]);
    expect(s.todayAction).toBe('hold_deploy');
    expect(s.transitions.map(t => [t.date, t.kind])).toEqual([
      ['2026-07-15', 'sell'], ['2026-07-17', 'buyback'],
    ]);
  });

  it('空历史不抛错', () => {
    const s = deriveS5State([]);
    expect(s.tier).toBeNull();
    expect(s.transitions).toEqual([]);
  });
});

describe('buildS5ActionEmail', () => {
  it('进入防守=卖出指令主题', () => {
    const { subject, html } = buildS5ActionEmail({ kind: 'enterDefense', from: 'reduce', to: 'defense', dataDate: '2026-07-18' });
    expect(subject).toContain('卖出');
    expect(html).toContain('2026-07-18');
  });

  it('退出防守=买回指令，含"恢复到reduce也要买回"的命门提示', () => {
    const { subject, html } = buildS5ActionEmail({ kind: 'exitDefense', from: 'defense', to: 'reduce', dataDate: '2026-07-19' });
    expect(subject).toContain('买回');
    expect(html).toContain('37.0%→18.2%');
  });
});
