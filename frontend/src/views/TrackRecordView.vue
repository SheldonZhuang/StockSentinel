<template>
  <div class="track-view">
    <div class="panel">
      <h2 class="page-title">{{ $t('track.title') }}</h2>
      <p class="page-sub">{{ $t('track.subtitle') }}</p>

      <!-- 回测成绩速览 -->
      <div v-if="bt" class="bt-grid">
        <div class="bt-cell">
          <div class="bt-num">{{ bt.stratCagr }}%</div>
          <div class="bt-label">{{ $t('track.stratCagr') }}</div>
        </div>
        <div class="bt-cell">
          <div class="bt-num muted">{{ bt.bhCagr }}%</div>
          <div class="bt-label">{{ $t('track.bhCagr') }}</div>
        </div>
        <div class="bt-cell">
          <div class="bt-num good">{{ bt.stratMdd }}%</div>
          <div class="bt-label">{{ $t('track.stratMdd') }}</div>
        </div>
        <div class="bt-cell">
          <div class="bt-num muted">{{ bt.bhMdd }}%</div>
          <div class="bt-label">{{ $t('track.bhMdd') }}</div>
        </div>
      </div>
      <p v-if="bt" class="bt-note">{{ $t('track.btNote', { years: bt.years }) }}</p>
    </div>

    <!-- 每日信号存档 -->
    <div class="panel">
      <div class="section-title">{{ $t('track.archiveTitle') }}</div>
      <div v-if="loading" class="empty">{{ $t('signal.loading') }}</div>
      <div v-else-if="error" class="empty error-state">
        {{ $t('error.loadFailed') }}
        <button class="retry-btn" @click="load">{{ $t('error.retry') }}</button>
      </div>
      <table v-else class="archive-table">
        <thead>
          <tr>
            <th>{{ $t('track.colDate') }}</th>
            <th>{{ $t('track.colFinal') }}</th>
            <th class="dim-col">{{ $t('signalPos.aiSupply') }}</th>
            <th class="dim-col">{{ $t('signalPos.monetary') }}</th>
            <th class="dim-col">{{ $t('signalPos.fiscal') }}</th>
            <th class="dim-col">{{ $t('signalPos.administrative') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in history" :key="row.date">
            <td class="date-cell">{{ row.date }}</td>
            <td><span :class="['final-badge', row.final_signal]">{{ $t(`signal.${row.final_signal}`) }}</span></td>
            <td class="dim-col"><span :class="['dim-dot', row.ai_supply_signal || 'neutral']"></span>{{ $t(`signalPos.${row.ai_supply_signal || 'neutral'}`) }}</td>
            <td class="dim-col"><span :class="['dim-dot', row.monetary_signal]"></span>{{ $t(`signalPos.${row.monetary_signal}`) }}</td>
            <td class="dim-col"><span :class="['dim-dot', row.fiscal_signal]"></span>{{ $t(`signalPos.${row.fiscal_signal}`) }}</td>
            <td class="dim-col"><span :class="['dim-dot', row.admin_signal]"></span>{{ $t(`signalPos.${row.admin_signal}`) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api/client.js';

const history = ref([]);
const loading = ref(true);
const error = ref(false);
const bt = ref(null);

async function load() {
  loading.value = true;
  error.value = false;
  try {
    history.value = await api.getSignalHistory(365);
  } catch (e) {
    console.error(e);
    error.value = true;
  } finally {
    loading.value = false;
  }
}

async function loadBacktest() {
  try {
    const res = await fetch('/v1/backtest/summary');
    if (!res.ok) return;
    const { summary } = await res.json();
    const o = summary?.overall;
    if (!o) return;
    bt.value = {
      years: o.years.toFixed(1),
      stratCagr: o.stratCagr.toFixed(1),
      bhCagr: o.buyHoldCagr.toFixed(1),
      stratMdd: o.stratMdd.toFixed(0),
      bhMdd: o.buyHoldMdd.toFixed(0),
    };
  } catch { /* 回测数据可选 */ }
}

onMounted(() => { load(); loadBacktest(); });
</script>

<style scoped>
.track-view { display: flex; flex-direction: column; gap: 20px; }

.panel {
  position: relative;
  background: linear-gradient(180deg, var(--panel-a), var(--panel-b));
  border: 1px solid var(--border-2);
  border-radius: 14px;
  padding: 20px;
}

.page-title { margin: 0 0 4px; font-size: var(--fs-xl); color: var(--text-1); }
.page-sub { margin: 0 0 16px; font-size: var(--fs-sm); color: var(--text-3); }

.bt-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.bt-cell {
  background: var(--bg-card);
  border: 1px solid var(--border-2);
  border-radius: 10px;
  padding: 14px;
  text-align: center;
}
.bt-num { font-size: var(--fs-xl); font-weight: 700; font-family: var(--font-num); color: var(--green); }
.bt-num.muted { color: var(--text-3); }
.bt-num.good { color: var(--green); }
.bt-label { font-size: var(--fs-xs); color: var(--text-4); margin-top: 4px; }
.bt-note { font-size: var(--fs-xs); color: var(--text-4); margin: 10px 0 0; }

.section-title { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-4); margin-bottom: 12px; }
.empty { font-size: var(--fs-md); color: var(--text-4); }
.error-state { display: flex; align-items: center; gap: 10px; color: var(--red); }
.retry-btn {
  background: var(--bg-input); border: 1px solid var(--border-3); border-radius: 6px;
  color: var(--text-2); padding: 4px 12px; cursor: pointer; font-size: var(--fs-sm);
}

.archive-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.archive-table th {
  text-align: left; color: var(--text-4); font-weight: 500; font-size: var(--fs-xs);
  padding: 6px 10px; border-bottom: 1px solid var(--border-2);
}
.archive-table td { padding: 6px 10px; border-bottom: 1px solid var(--border-1); color: var(--text-2); }
.date-cell { font-family: var(--font-num); color: var(--text-3); }

.final-badge { font-weight: 600; padding: 2px 8px; border-radius: 6px; font-size: var(--fs-xs); }
.final-badge.attack { background: var(--green-bg); color: var(--green); }
.final-badge.neutral { background: var(--yellow-bg); color: var(--yellow); }
.final-badge.reduce { background: var(--orange-bg); color: var(--orange); }
.final-badge.defense { background: var(--red-bg); color: var(--red); }

.dim-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.dim-dot.loose { background: var(--green); }
.dim-dot.neutral { background: var(--yellow); }
.dim-dot.tight { background: var(--red); }

@media (max-width: 700px) {
  .bt-grid { grid-template-columns: repeat(2, 1fr); }
  .dim-col { display: none; }
}
</style>
