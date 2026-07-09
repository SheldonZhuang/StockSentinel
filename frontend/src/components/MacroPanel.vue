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

      <!-- 信号解读：为什么防守 / 距进攻还差什么 -->
      <div class="interpret-section">
        <div class="section-title">{{ $t('interpret.title') }}</div>
        <div v-if="tightDims.length" class="interpret-block">
          <span class="interpret-label">{{ $t('interpret.triggers') }}</span>
          <span v-for="d in tightDims" :key="d.key" class="interpret-item tight">
            {{ $t(`signalPos.${d.key}`) }}<template v-if="d.detail">（{{ d.detail }}）</template>
          </span>
        </div>
        <div v-if="signal.finalSignal === 'attack'" class="interpret-block">
          <span class="interpret-item loose">✓ {{ $t('interpret.allLoose') }}</span>
        </div>
        <div v-else class="interpret-block">
          <span class="interpret-label">{{ $t('interpret.toAttack') }}</span>
          <span v-for="d in dimStates" :key="d.key" :class="['interpret-item', d.value === 'loose' ? 'loose' : 'pending']">
            {{ d.value === 'loose' ? '✓' : '○' }} {{ $t(`signalPos.${d.key}`) }}
          </span>
        </div>
      </div>

      <!-- 三个信号位明细 -->
      <div class="signal-positions">
        <div v-for="pos in positions" :key="pos.key" class="pos-row">
          <span class="pos-label">{{ $t(`signalPos.${pos.key}`) }}</span>
          <span class="pos-value">
            <span v-if="pos.source === 'override'" class="pos-source">{{ $t('signalPos.override') }}</span>
            <span :class="['pos-badge', pos.value]">{{ $t(`signalPos.${pos.value}`) }}</span>
          </span>
        </div>
      </div>

      <!-- 指标参考数值 -->
      <div class="indicators-section">
        <div class="section-title">{{ $t('indicators.sectionTitle') }}</div>
        <div class="indicator-block" v-for="ind in indicators" :key="ind.key">
          <div class="indicator-row">
            <span class="ind-label">{{ $t(`indicators.${ind.key}`) }}</span>
            <span class="ind-value">
              {{ ind.value != null ? ind.value.toFixed(2) + ind.unit : '—' }}
              <span v-if="ind.change !== null" :class="['ind-change', trendClass(ind.change)]">
                {{ trendArrow(ind.change) }}{{ Math.abs(ind.change).toFixed(2) }}{{ ind.unit }}
                ({{ $t(`indicators.${trendKey(ind.change)}`) }})
              </span>
              <span v-if="ind.bsStatus" :class="['pos-badge', ind.bsStatus]">{{ $t(`indicators.bsStatus.${ind.bsStatus}`) }}</span>
              <span v-if="ind.extra" class="ind-extra">{{ ind.extra }}</span>
              <span v-if="ind.signalBadge" :class="['pos-badge', ind.signalBadge]">{{ $t(`signalPos.${ind.signalBadge}`) }}</span>
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
  return ''; // 持平不加符号，直接显示 0.00%
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
    { key: 'fiscal', value: signal.value.fiscalSignal, source: signal.value.fiscalSignalSource },
    { key: 'administrative', value: signal.value.adminSignal, source: signal.value.adminSignalSource },
    { key: 'aiSupply', value: signal.value.aiSupplySignal, source: signal.value.aiSupplySignalSource },
  ];
});

// 各维度收紧时附带的关键数据（解读卡展示"为什么"）
function dimDetail(key) {
  const ind = signal.value?.indicators || {};
  const fmt = v => (v == null ? null : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
  if (key === 'fiscal' && ind.fiscalDeficitChangePct != null) {
    return `${t('indicators.fiscalDeficitTtm')} ${t('indicators.yoyChange')} ${fmt(ind.fiscalDeficitChangePct)}`;
  }
  if (key === 'administrative' && ind.epuTradePercentile != null) {
    return `${t('indicators.epuTrade')} ${t('indicators.percentile10y')} ${ind.epuTradePercentile.toFixed(0)}`;
  }
  if (key === 'aiSupply' && ind.aiBubbleWarning) {
    return t('aiChain.bubbleWarning');
  }
  return null;
}

// 收紧中的维度（防守触发原因）
const tightDims = computed(() =>
  positions.value.filter(p => p.value === 'tight').map(p => ({ ...p, detail: dimDetail(p.key) }))
);

// 四维达成进攻条件（全宽松）的进度
const dimStates = computed(() => positions.value);

const indicators = computed(() => {
  if (!signal.value?.indicators) return [];
  const ind = signal.value.indicators;
  return [
    {
      key: 'rate', value: ind.rate, unit: '%',
      change: ind.rate !== null && ind.ratePrev !== null ? ind.rate - ind.ratePrev : null,
      signalBadge: ind.rateSignal,
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
    {
      // 存的是盈余/赤字（赤字为负，百万美元），展示为"赤字规模"（十亿美元）
      key: 'fiscalDeficitTtm', value: ind.fiscalDeficitTtm != null ? -ind.fiscalDeficitTtm / 1000 : null, unit: 'B', change: null,
      extra: ind.fiscalDeficitChangePct != null
        ? `${t('indicators.yoyChange')} ${ind.fiscalDeficitChangePct > 0 ? '+' : ''}${ind.fiscalDeficitChangePct.toFixed(1)}%`
        : null,
      signalBadge: ind.fiscalAutoSignal,
      periodDate: ind.fiscalPeriodDate, releaseDate: ind.fiscalReleaseDate, periodIsMonth: true,
    },
    {
      key: 'epuTrade', value: ind.epuTrade, unit: '', change: null,
      extra: ind.epuTradePercentile != null ? `${t('indicators.percentile10y')} ${ind.epuTradePercentile.toFixed(0)}` : null,
      signalBadge: ind.adminAutoSignal,
      periodDate: ind.epuTradePeriodDate, periodIsMonth: true,
    },
    {
      key: 'smhSpyRelReturn', value: ind.smhSpyRelReturnPct, unit: '%', change: null,
      signalBadge: ind.aiMarketSignal,
    },
    {
      key: 'semiIpYoy', value: ind.semiIpYoy, unit: '%', change: null,
      signalBadge: ind.aiFundamentalSignal,
      periodDate: ind.semiIpPeriodDate, releaseDate: ind.semiIpReleaseDate, periodIsMonth: true,
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

.interpret-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: #111;
  border-radius: 10px;
}
.interpret-block { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; }
.interpret-label { font-size: 12px; color: #888; }
.interpret-item { font-size: 12px; }
.interpret-item.tight { color: #f87171; }
.interpret-item.loose { color: #4ade80; }
.interpret-item.pending { color: #facc15; }

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

.pos-value { display: flex; align-items: center; gap: 6px; }

.pos-source {
  font-size: 10px;
  color: #777;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 1px 5px;
}

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
.ind-change.flat { color: #facc15; } /* 持平=中性，与观望档位同色 */

.ind-extra { font-size: 11px; color: #888; }

.ind-meta { font-size: 11px; color: #555; display: flex; gap: 4px; flex-wrap: wrap; }
.ind-value .pos-badge { font-size: 10px; padding: 2px 6px; }
</style>
