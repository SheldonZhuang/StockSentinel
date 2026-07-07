<template>
  <div class="macro-panel">
    <div v-if="loading" class="loading">{{ $t('signal.loading') }}</div>
    <template v-else-if="signal">
      <!-- 主信号 -->
      <div class="signal-section">
        <SignalBadge :current="signal.finalSignal" />
        <div v-if="signal.dataDate" class="data-date">
          {{ $t('indicators.dataDate') }}: {{ signal.dataDate }}
        </div>
      </div>

      <!-- 三个信号位明细 -->
      <div class="signal-positions">
        <div v-for="pos in positions" :key="pos.key" class="pos-row">
          <span class="pos-label">{{ $t(`signalPos.${pos.key}`) }}</span>
          <span :class="['pos-badge', pos.value]">{{ $t(`signalPos.${pos.value}`) }}</span>
        </div>
      </div>

      <!-- FRED 指标参考数值 -->
      <div class="indicators-section">
        <div class="section-title">FRED 指标</div>
        <div class="indicator-row" v-for="ind in indicators" :key="ind.key">
          <span class="ind-label">{{ $t(`indicators.${ind.key}`) }}</span>
          <span class="ind-value">
            {{ ind.value !== null ? ind.value.toFixed(2) + ind.unit : '—' }}
            <span v-if="ind.change !== null" :class="['ind-change', ind.change > 0 ? 'up' : 'down']">
              {{ ind.change > 0 ? '▲' : '▼' }}{{ Math.abs(ind.change).toFixed(2) }}{{ ind.unit }}
            </span>
          </span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import SignalBadge from './SignalBadge.vue';
import { api } from '../api/client.js';

const { t } = useI18n();
const signal = ref(null);
const loading = ref(true);

onMounted(async () => {
  try {
    signal.value = await api.getSignal();
  } catch (e) {
    console.error('Failed to load signal', e);
  } finally {
    loading.value = false;
  }
});

const positions = computed(() => {
  if (!signal.value) return [];
  return [
    { key: 'monetary', value: signal.value.monetarySignal },
    { key: 'fiscal', value: signal.value.fiscalSignal },
    { key: 'administrative', value: signal.value.adminSignal },
    { key: 'aiSupply', value: signal.value.aiSupplySignal },
  ];
});

const indicators = computed(() => {
  if (!signal.value?.indicators) return [];
  const ind = signal.value.indicators;
  return [
    { key: 'rate', value: ind.rate, unit: '%', change: ind.rate !== null && ind.ratePrev !== null ? ind.rate - ind.ratePrev : null },
    { key: 'balanceSheet', value: ind.balanceSheet != null ? ind.balanceSheet / 1000 : null, unit: 'B', change: null },
    { key: 'corePce', value: ind.corePce, unit: '%', change: null },
    { key: 'trimmedPce', value: ind.trimmedPce, unit: '%', change: null },
    { key: 'unemployment', value: ind.unemployment, unit: '%', change: null },
  ];
});
</script>

<style scoped>
.macro-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.loading { color: #888; font-size: 14px; }

.signal-section { display: flex; flex-direction: column; gap: 8px; }

.data-date { font-size: 12px; color: #666; }

.signal-positions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: #111;
  border-radius: 10px;
}

.pos-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.pos-label { font-size: 13px; color: #aaa; }

.pos-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 6px;
}
.pos-badge.loose { background: #173a24; color: #4ade80; }
.pos-badge.neutral { background: #2a2a1a; color: #facc15; }
.pos-badge.tight { background: #3a1717; color: #f87171; }

.indicators-section { display: flex; flex-direction: column; gap: 6px; }
.section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin-bottom: 4px; }

.indicator-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.ind-label { color: #888; }
.ind-value { color: #ccc; font-variant-numeric: tabular-nums; }
.ind-change { font-size: 11px; margin-left: 6px; }
.ind-change.up { color: #f87171; }
.ind-change.down { color: #4ade80; }
</style>
