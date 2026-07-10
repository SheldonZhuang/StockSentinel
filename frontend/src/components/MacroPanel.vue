<template>
  <div class="macro-panel">
    <div v-if="!signal" class="loading">{{ $t('signal.loading') }}</div>
    <template v-else>
      <!-- 参考指标明细：按策略主线分组（AI供需 → 货币 → 财政 → 行政） -->
      <div class="indicators-section">
        <div class="section-title">{{ $t('indicators.sectionTitle') }}</div>
        <template v-for="group in groups" :key="group.key">
          <div class="group-title">{{ $t(`signalPos.${group.key}`) }}</div>
          <div class="indicator-block" v-for="ind in group.items" :key="ind.key">
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
        </template>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  signal: { type: Object, default: null },
});

const LOCALE_TAGS = { zh: 'zh-CN', en: 'en-US', fr: 'fr-FR', de: 'de-DE', es: 'es-ES', ja: 'ja-JP', ko: 'ko-KR' };

const { t, locale } = useI18n();

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

// 按策略主线分组："长线看供需（AI供需），短线看政策（货币/财政/行政）"
const groups = computed(() => {
  if (!props.signal?.indicators) return [];
  const ind = props.signal.indicators;
  return [
    {
      key: 'aiSupply',
      items: [
        {
          key: 'smhSpyRelReturn', value: ind.smhSpyRelReturnPct, unit: '%', change: null,
          signalBadge: ind.aiMarketSignal,
        },
        {
          key: 'semiIpYoy', value: ind.semiIpYoy, unit: '%', change: null,
          signalBadge: ind.aiFundamentalSignal,
          periodDate: ind.semiIpPeriodDate, releaseDate: ind.semiIpReleaseDate, periodIsMonth: true,
        },
      ],
    },
    {
      key: 'monetary',
      items: [
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
      ],
    },
    {
      key: 'fiscal',
      items: [
        {
          // 存的是盈余/赤字（赤字为负，百万美元），展示为"赤字规模"（十亿美元）
          key: 'fiscalDeficitTtm', value: ind.fiscalDeficitTtm != null ? -ind.fiscalDeficitTtm / 1000 : null, unit: 'B', change: null,
          extra: ind.fiscalDeficitChangePct != null
            ? `${t('indicators.yoyChange')} ${ind.fiscalDeficitChangePct > 0 ? '+' : ''}${ind.fiscalDeficitChangePct.toFixed(1)}%`
            : null,
          signalBadge: ind.fiscalAutoSignal,
          periodDate: ind.fiscalPeriodDate, releaseDate: ind.fiscalReleaseDate, periodIsMonth: true,
        },
      ],
    },
    {
      key: 'administrative',
      items: [
        {
          key: 'epuTrade', value: ind.epuTrade, unit: '', change: null,
          extra: ind.epuTradePercentile != null ? `${t('indicators.percentile10y')} ${ind.epuTradePercentile.toFixed(0)}` : null,
          signalBadge: ind.adminAutoSignal,
          periodDate: ind.epuTradePeriodDate, periodIsMonth: true,
        },
      ],
    },
  ];
});
</script>

<style scoped>
.macro-panel { display: flex; flex-direction: column; gap: 12px; }

.loading { color: #888; font-size: 14px; }

.indicators-section { display: flex; flex-direction: column; gap: 10px; }
.section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin-bottom: 4px; }

.group-title {
  font-size: 11px;
  color: #6b9eff;
  font-weight: 600;
  margin-top: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid #1a1a1a;
}

.indicator-block { display: flex; flex-direction: column; gap: 2px; }

.indicator-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.ind-label { color: #888; }
.ind-value { color: #ccc; font-variant-numeric: tabular-nums; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.ind-change { font-size: 11px; margin-left: 6px; }
.ind-change.up { color: #f87171; }
.ind-change.down { color: #4ade80; }
.ind-change.flat { color: #facc15; } /* 持平=中性，与观望档位同色 */

.ind-extra { font-size: 11px; color: #888; }

.ind-meta { font-size: 11px; color: #555; display: flex; gap: 4px; flex-wrap: wrap; }

.pos-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 6px;
}
.pos-badge.loose { background: #173a24; color: #4ade80; }
.pos-badge.neutral { background: #2a2a1a; color: #facc15; }
.pos-badge.tight { background: #3a1717; color: #f87171; }
</style>
