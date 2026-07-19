<template>
  <!-- 仅管理员 + 数据加载成功才渲染；非管理员/401 静默隐藏（用户96号：暂不对外展示） -->
  <section v-if="auth.isAdmin.value && data" class="section s5-panel">
    <p class="s5-disclaimer">{{ $t('s5.disclaimer') }}</p>

    <!-- 头部：档位徽章 + 持仓状态 -->
    <div class="s5-header">
      <h3>{{ $t('s5.title') }}</h3>
      <span v-if="data.tier" :class="['tier-badge', data.tier]">{{ $t(`signal.${data.tier}`) }}</span>
      <span :class="['state-badge', data.state]">{{ $t(`s5.state.${data.state}`) }}</span>
    </div>

    <!-- 今日动作卡（最醒目） -->
    <div :class="['action-card', isBoundary ? 'urgent' : '']">
      <div class="action-label">{{ $t('s5.todayTitle') }}</div>
      <div class="action-text">{{ $t(`s5.action.${data.todayAction}`) }}</div>
    </div>

    <!-- 状态行 -->
    <div class="status-rows">
      <div v-if="data.downgradePendingSince" class="status-row pending">
        {{ $t('s5.downgradePending', { date: downgradeConfirmDate }) }}
      </div>
      <div v-if="data.spxAboveSma10 !== null" class="status-row">
        <span :class="data.spxAboveSma10 ? 'trend-up' : 'trend-down'">
          {{ data.spxAboveSma10 ? $t('s5.trendAbove') : $t('s5.trendBelow') }}
        </span>
      </div>
      <div v-if="data.asOf" class="status-row muted">{{ $t('s5.asOf', { date: data.asOf }) }}</div>
    </div>

    <!-- S5 交易日志 -->
    <div class="s5-block">
      <h4>{{ $t('s5.logTitle') }}</h4>
      <div v-if="!data.transitions?.length" class="muted">{{ $t('s5.logEmpty') }}</div>
      <table v-else class="log-table">
        <tbody>
          <tr v-for="tr in [...data.transitions].reverse()" :key="tr.date + tr.kind">
            <td class="log-date">{{ tr.date }}</td>
            <td :class="['log-kind', tr.kind]">{{ $t(`s5.kind.${tr.kind}`) }}</td>
            <td class="log-tiers">{{ tierName(tr.from) }} → {{ tierName(tr.to) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 回测速览 -->
    <div class="s5-block">
      <h4>{{ $t('s5.playbookTitle') }}</h4>
      <div class="pb-grid">
        <div class="pb-cell">
          <div class="pb-num">{{ data.playbook.xirrPct.toFixed(1) }}%</div>
          <div class="pb-label">{{ $t('s5.xirr') }}</div>
        </div>
        <div class="pb-cell">
          <div class="pb-num">{{ data.playbook.maxUnderwaterPct.toFixed(1) }}%</div>
          <div class="pb-label">{{ $t('s5.maxUnderwater') }}</div>
        </div>
        <div class="pb-cell">
          <div class="pb-num">{{ data.playbook.roundTrips26y }}</div>
          <div class="pb-label">{{ $t('s5.roundTrips') }}</div>
        </div>
        <div class="pb-cell">
          <div class="pb-num">{{ data.playbook.falseSignals }}</div>
          <div class="pb-label">{{ $t('s5.falseSignals') }}</div>
        </div>
      </div>
      <p class="pb-note">{{ data.playbook.note }}</p>
      <p class="pb-doc">{{ $t('s5.playbookDoc') }}</p>
    </div>
  </section>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';

const { t, te } = useI18n();
const auth = useAuthStore();
const data = ref(null);

// 边界日（今天要卖/要买回）→ 动作卡高亮
const isBoundary = computed(() =>
  data.value && ['sell_all', 'buyback_all'].includes(data.value.todayAction)
);

// 降档确认期截止：pendingSince + 30 天（UTC 日期串运算，避免时区漂移）
const downgradeConfirmDate = computed(() => {
  const since = data.value?.downgradePendingSince;
  if (!since) return '';
  const d = new Date(since + 'T00:00:00Z');
  if (isNaN(d.getTime())) return since;
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
});

function tierName(tier) {
  return te(`signal.${tier}`) ? t(`signal.${tier}`) : tier;
}

onMounted(async () => {
  if (!auth.isAdmin.value) return;
  try {
    data.value = await api.getAdminS5();
  } catch {
    // 非管理员/401/旧后端无此端点：静默隐藏，不报错不闪现
    data.value = null;
  }
});
</script>

<style scoped>
.section { background: var(--bg-card); border: 1px solid var(--border-2); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.s5-panel { max-width: 800px; }

.s5-disclaimer { font-size: var(--fs-xs); color: var(--text-4); margin: 0 0 10px 0; }

.s5-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.s5-header h3 { font-size: var(--fs-lg); color: var(--text-3); margin: 0; text-transform: uppercase; letter-spacing: 0.05em; }

.tier-badge { padding: 2px 10px; border-radius: 6px; font-weight: 700; font-size: var(--fs-sm); }
.tier-badge.attack { background: var(--green-bg); color: var(--green); }
.tier-badge.neutral { background: var(--yellow-bg); color: var(--yellow); }
.tier-badge.reduce { background: var(--yellow-bg); color: var(--yellow); }
.tier-badge.defense { background: var(--red-bg); color: var(--red); }

.state-badge { font-size: var(--fs-sm); font-weight: 600; padding: 2px 10px; border-radius: 6px; border: 1px solid var(--border-3); color: var(--text-2); }

.action-card { border: 1px solid var(--border-focus); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; background: var(--bg-input); }
.action-card.urgent { border-color: var(--red); background: var(--red-bg); }
.action-label { font-size: var(--fs-xs); color: var(--text-4); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
.action-text { font-size: var(--fs-lg); font-weight: 700; color: var(--text-1); line-height: 1.5; }
.action-card.urgent .action-text { color: var(--red); }

.status-rows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.status-row { font-size: var(--fs-md); color: var(--text-2); }
.status-row.pending { color: var(--yellow); background: var(--yellow-bg); border-radius: 6px; padding: 6px 10px; }
.trend-up { color: var(--green); font-weight: 600; }
.trend-down { color: var(--red); font-weight: 600; }
.muted { font-size: var(--fs-sm); color: var(--text-4); }

.s5-block { margin-top: 14px; }
.s5-block h4 { font-size: var(--fs-md); color: var(--text-3); margin: 0 0 8px 0; }

.log-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.log-table td { padding: 5px 8px; border-bottom: 1px solid var(--border-1); color: var(--text-2); }
.log-date { font-family: var(--font-num); white-space: nowrap; }
.log-kind { font-weight: 600; }
.log-kind.sell { color: var(--red); }
.log-kind.buyback { color: var(--green); }
.log-tiers { color: var(--text-3); }

.pb-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 8px; }
.pb-cell { background: var(--bg-input); border: 1px solid var(--border-1); border-radius: 8px; padding: 10px; text-align: center; }
.pb-num { font-family: var(--font-num); font-size: var(--fs-xl); font-weight: 700; color: var(--text-1); }
.pb-label { font-size: var(--fs-xs); color: var(--text-4); margin-top: 4px; }
.pb-note { font-size: var(--fs-sm); color: var(--text-3); margin: 6px 0 0 0; }
.pb-doc { font-size: var(--fs-xs); color: var(--text-4); margin: 4px 0 0 0; }
</style>
