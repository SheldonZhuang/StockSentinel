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
        <div class="indicator-block" v-for="ind in indicators" :key="ind.key">
          <div class="indicator-row">
            <span class="ind-label">{{ $t(`indicators.${ind.key}`) }}</span>
            <span class="ind-value">
              {{ ind.value !== null ? ind.value.toFixed(2) + ind.unit : '—' }}
              <span v-if="ind.change !== null" :class="['ind-change', trendClass(ind.change)]">
                {{ trendArrow(ind.change) }}{{ Math.abs(ind.change).toFixed(2) }}{{ ind.unit }}
                ({{ $t(`indicators.${trendKey(ind.change)}`) }})
              </span>
              <span v-if="ind.bsStatus" :class="['pos-badge', ind.bsStatus]">{{ $t(`indicators.bsStatus.${ind.bsStatus}`) }}</span>
            </span>
          </div>
          <div class="ind-meta">
            <span v-if="ind.decisionDate">{{ $t('indicators.decisionDate') }}: {{ formatDate(ind.decisionDate) }}</span>
            <span v-if="ind.periodDate">{{ $t('indicators.periodDate') }}: {{ ind.periodIsMonth ? formatMonth(ind.periodDate) : formatDate(ind.periodDate) }}</span>
            <span v-if="ind.releaseDate">· {{ $t('indicators.releaseDate') }}: {{ formatDate(ind.releaseDate) }}</span>
          </div>
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

const LOCALE_TAGS = { zh: 'zh-CN', en: 'en-US', fr: 'fr-FR', de: 'de-DE', es: 'es-ES', ja: 'ja-JP', ko: 'ko-KR' };

const { t, locale } = useI18n();
const signal = ref(null);
const loading = ref(true);

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const tag = LOCALE_TAGS[locale.value] || 'en-US';
  return new Intl.DateTimeFormat(tag, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(dateStr + 'T00:00:00Z'));
}

// PCE/失业率是月度数据，参考期展示到月份即可（不展示FRED返回的月首占位日期）
function formatMonth(dateStr) {
  if (!dateStr) return '—';
  const tag = LOCALE_TAGS[locale.value] || 'en-US';
  return new Intl.DateTimeFormat(tag, { year: 'numeric', month: 'long' }).format(new Date(dateStr + 'T00:00:00Z'));
}

function trendKey(change) {
  if (change === null) return null;
  const rounded = Math.round(change * 100) / 100;
  if (rounded > 0) return 'trendUp';
  if (rounded < 0) return 'trendDown';
  return 'trendFlat';
}

function trendArrow(change) {
  const key = trendKey(change);
  if (key === 'trendUp') return '▲';
  if (key === 'trendDown') return '▼';
  return '—';
}

function trendClass(change) {
  const key = trendKey(change);
  if (key === 'trendUp') return 'up';
  if (key === 'trendDown') return 'down';
  return 'flat';
}

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
    {
      key: 'rate', value: ind.rate, unit: '%',
      change: ind.rate !== null && ind.ratePrev !== null ? ind.rate - ind.ratePrev : null,
      decisionDate: ind.rateDecisionDate,
    },
    {
      key: 'balanceSheet', value: ind.balanceSheet != null ? ind.balanceSheet / 1000 : null, unit: 'B', change: null,
      periodDate: ind.balanceSheetPeriodDate, releaseDate: ind.balanceSheetReleaseDate, bsStatus: ind.balanceSheetStatus,
    },
    {
      key: 'corePce', value: ind.corePce, unit: '%',
      change: ind.corePce !== null && ind.corePcePrev !== null ? ind.corePce - ind.corePcePrev : null,
      periodDate: ind.corePcePeriodDate, releaseDate: ind.corePceReleaseDate, periodIsMonth: true,
    },
    {
      key: 'trimmedPce1m', value: ind.trimmedPce1m, unit: '%',
      change: ind.trimmedPce1m !== null && ind.trimmedPce1mPrev !== null ? ind.trimmedPce1m - ind.trimmedPce1mPrev : null,
      periodDate: ind.trimmedPce1mPeriodDate, releaseDate: ind.trimmedPce1mReleaseDate, periodIsMonth: true,
    },
    {
      key: 'trimmedPce', value: ind.trimmedPce, unit: '%',
      change: ind.trimmedPce !== null && ind.trimmedPcePrev !== null ? ind.trimmedPce - ind.trimmedPcePrev : null,
      periodDate: ind.trimmedPcePeriodDate, releaseDate: ind.trimmedPceReleaseDate, periodIsMonth: true,
    },
    {
      key: 'trimmedPce12m', value: ind.trimmedPce12m, unit: '%',
      change: ind.trimmedPce12m !== null && ind.trimmedPce12mPrev !== null ? ind.trimmedPce12m - ind.trimmedPce12mPrev : null,
      periodDate: ind.trimmedPce12mPeriodDate, releaseDate: ind.trimmedPce12mReleaseDate, periodIsMonth: true,
    },
    {
      key: 'unemployment', value: ind.unemployment, unit: '%',
      change: ind.unemployment !== null && ind.unemploymentPrev !== null ? ind.unemployment - ind.unemploymentPrev : null,
      periodDate: ind.unemploymentPeriodDate, releaseDate: ind.unemploymentReleaseDate, periodIsMonth: true,
    },
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

.indicators-section { display: flex; flex-direction: column; gap: 10px; }
.section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin-bottom: 4px; }

.indicator-block { display: flex; flex-direction: column; gap: 2px; }

.indicator-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.ind-label { color: #888; }
.ind-value { color: #ccc; font-variant-numeric: tabular-nums; display: flex; align-items: center; gap: 6px; }
.ind-change { font-size: 11px; margin-left: 6px; }
.ind-change.up { color: #f87171; }
.ind-change.down { color: #4ade80; }
.ind-change.flat { color: #999; }

.ind-meta { font-size: 11px; color: #555; display: flex; gap: 4px; flex-wrap: wrap; }
.ind-value .pos-badge { font-size: 10px; padding: 2px 6px; }
</style>
