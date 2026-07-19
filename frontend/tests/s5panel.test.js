import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';

vi.mock('../src/api/client.js', () => ({
  api: { getMe: vi.fn(), getAdminS5: vi.fn() },
}));

import { api } from '../src/api/client.js';
import { useAuthStore } from '../src/stores/auth.js';
import S5Panel from '../src/components/S5Panel.vue';
import zh from '../src/i18n/locales/zh.json';

const i18n = createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'zh', messages: { zh } });

function mountPanel() {
  return mount(S5Panel, { global: { plugins: [i18n] } });
}

const baseS5 = {
  tier: 'neutral',
  state: 'in_market',
  todayAction: 'hold_deploy',
  transitions: [
    { date: '2026-05-02', kind: 'sell', from: 'reduce', to: 'defense' },
    { date: '2026-06-10', kind: 'buyback', from: 'defense', to: 'reduce' },
  ],
  asOf: '2026-07-18',
  downgradePendingSince: null,
  spxAboveSma10: true,
  capeLayer: { available: true, cape: 32.4, percentile30y: 72, month: '2026-06', active: false },
  targetWeightPct: 100,
  playbook: { xirrPct: 40.1, maxUnderwaterPct: -28.3, roundTrips26y: 9, falseSignals: 4, note: '月度回测口径' },
};

describe('S5Panel', () => {
  beforeEach(() => {
    const auth = useAuthStore();
    auth.user.value = null;
    auth.checked.value = false;
    vi.clearAllMocks();
  });

  it('renders nothing for non-admin and does not call the API', async () => {
    useAuthStore().user.value = { id: 1, isAdmin: false };
    const wrapper = mountPanel();
    await flushPromises();
    expect(api.getAdminS5).not.toHaveBeenCalled();
    expect(wrapper.find('.s5-panel').exists()).toBe(false);
  });

  it('hides silently when the API fails (401)', async () => {
    useAuthStore().user.value = { id: 1, isAdmin: true };
    const err = new Error('unauthorized');
    err.status = 401;
    api.getAdminS5.mockRejectedValue(err);
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('.s5-panel').exists()).toBe(false);
  });

  it('renders state, action, log and playbook for admin', async () => {
    useAuthStore().user.value = { id: 1, isAdmin: true };
    api.getAdminS5.mockResolvedValue(baseS5);
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('.s5-panel').exists()).toBe(true);
    expect(wrapper.text()).toContain('持有TQQQ');
    expect(wrapper.text()).toContain('持有；本月定投+全部现金储备买入TQQQ');
    expect(wrapper.text()).toContain('上升（SPX ≥ 10月SMA）');
    expect(wrapper.findAll('.log-table tr')).toHaveLength(2);
    expect(wrapper.text()).toContain('40.1%');
    expect(wrapper.text()).toContain('-28.3%');
    expect(wrapper.text()).toContain('docs/s5-execution-playbook.md');
    // CAPE 未激活：绿色 + 目标仓位提示（非告警态）
    expect(wrapper.find('.cape-inactive').text()).toBe('CAPE分位 P72 ≤90 → 目标仓位 100%');
    expect(wrapper.find('.weight-hint').text()).toBe('（当前目标仓位 100%）');
    expect(wrapper.find('.weight-hint.warn').exists()).toBe(false);
  });

  it('renders the literal $ in hold_accumulate copy', async () => {
    useAuthStore().user.value = { id: 1, isAdmin: true };
    api.getAdminS5.mockResolvedValue({ ...baseS5, tier: 'reduce', todayAction: 'hold_accumulate' });
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain('持有存量不动；本月定投$进现金储备（减仓期不买入）');
  });

  it('highlights boundary-day actions and shows downgrade confirmation deadline', async () => {
    useAuthStore().user.value = { id: 1, isAdmin: true };
    api.getAdminS5.mockResolvedValue({
      ...baseS5,
      tier: 'defense',
      state: 'in_cash',
      todayAction: 'sell_all',
      downgradePendingSince: '2026-07-01',
      spxAboveSma10: false,
      targetWeightPct: 0,
    });
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('.action-card.urgent').exists()).toBe(true);
    expect(wrapper.text()).toContain('卖出全部TQQQ存量转现金');
    // 2026-07-01 + 30 天 = 2026-07-31
    expect(wrapper.text()).toContain('确认期至 2026-07-31');
    expect(wrapper.text()).toContain('下降（SPX < 10月SMA）');
    // 空仓类动作不显示目标仓位提示
    expect(wrapper.find('.weight-hint').exists()).toBe(false);
  });

  it('shows red CAPE row and bold warn hint when the CAPE layer is active (55%)', async () => {
    useAuthStore().user.value = { id: 1, isAdmin: true };
    api.getAdminS5.mockResolvedValue({
      ...baseS5,
      capeLayer: { available: true, cape: 38.7, percentile30y: 93, month: '2026-06', active: true },
      targetWeightPct: 55,
    });
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('.cape-active').text()).toBe('CAPE 38.7（30年分位 P93）> 90 → TQQQ目标仓位 55%');
    const hint = wrapper.find('.weight-hint.warn');
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toBe('（当前目标仓位 55%）');
  });

  it('shows yellow fallback when CAPE data is unavailable', async () => {
    useAuthStore().user.value = { id: 1, isAdmin: true };
    api.getAdminS5.mockResolvedValue({
      ...baseS5,
      capeLayer: { available: false, cape: null, percentile30y: null, month: null, active: null },
    });
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('.cape-unavailable').text()).toBe('数据不可用·按100%仓位');
    expect(wrapper.find('.cape-active').exists()).toBe(false);
    expect(wrapper.find('.cape-inactive').exists()).toBe(false);
  });
});
