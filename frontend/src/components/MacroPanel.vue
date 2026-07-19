<template>
  <div class="macro-panel">
    <div v-if="!signal" class="loading">{{ $t('signal.loading') }}</div>
    <template v-else>
      <!-- 参考指标明细：按策略主线分组（AI供需 → 货币 → 财政 → 行政） -->
      <div class="indicators-section">
        <div class="section-title">{{ $t('indicators.sectionTitle') }}</div>
        <template v-for="group in groups" :key="group.key">
          <div class="group-title">{{ $t(`signalPos.${group.key}`) }}</div>
          <div class="indicator-block" v-for="ind in group.items" :key="ind.key" :title="hintFor(ind)">
            <div class="indicator-row">
              <span :class="['ind-label', { hinted: hintFor(ind) }]">{{ $t(`indicators.${ind.key}`) }}</span>
              <span class="ind-value">
                {{ ind.value != null ? (ind.signed && ind.value > 0 ? '+' : '') + ind.value.toFixed(2) + ind.unit : '—' }}
                <span v-if="ind.change !== null" :class="['ind-change', trendClass(ind.change)]">
                  {{ trendArrow(ind.change) }}{{ Math.abs(ind.change).toFixed(2) }}{{ ind.unit }}
                  ({{ $t(`indicators.${trendKey(ind.change)}`) }})
                </span>
                <span v-if="ind.bsStatus" :class="['pos-badge', ind.bsStatus]">{{ $t(`indicators.bsStatus.${ind.bsStatus}`) }}</span>
                <span v-if="ind.ycStatus" :class="['pos-badge', ind.ycStatus]">{{ $t(`indicators.ycStatus.${ind.ycStatus}`) }}</span>
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

// 参与判定的指标悬停显示判定规则 + 全局叠加规则；纯参考指标显示"仅参考"
const JUDGED_KEYS = new Set(['modelUsageTrend', 'capexYoY', 'semiIpYoy', 'rate', 'balanceSheet', 'sahm', 'fiscalOutlaysTtm', 'epuTrade', 'epuDaily', 'oilWti']);

// EPU 百分位 → 子档位徽章（阈值同步 signal.config.js：>80 收紧 / <50 宽松）
function epuBadge(percentile) {
  if (percentile == null) return null;
  if (percentile > 80) return 'tight';
  if (percentile < 50) return 'loose';
  return 'neutral';
}

// 油价事件层徽章：与 backend/api/signal.js calcAdminSignal 事件层同步，改后端时必须同步这里。
// guard = 日频EPU百分位 ?? 月度贸易EPU百分位（优先更新鲜的日频做护栏）：
//   涨幅≥+20% 且 guard>80 → tight（战争/供给冲击；EPU平静时的大涨=需求复苏，不误判防守）；
//   跌幅≤−20% 且 guard 非空且 ≤80 → loose（冲突缓和；EPU双缺或高企时 fail-closed 不判宽松）；
//   其余 → neutral
function oilBadge(ind) {
  if (ind.oilChange30dPct == null) return null;
  const guard = ind.epuDailyPercentile ?? ind.epuTradePercentile;
  const guardKnown = guard != null;
  const uncertaintyHigh = guardKnown && guard > 80;
  // O1油价水平护栏(2026-07-19)：低位反弹(oilLevelLow===true)不判战争冲击——与 backend calcAdminSignal 同步
  if (ind.oilChange30dPct >= 20 && uncertaintyHigh && ind.oilLevelLow !== true) return 'tight';
  if (ind.oilChange30dPct <= -20 && guardKnown && !uncertaintyHigh) return 'loose';
  return 'neutral';
}

// 收益率曲线状态徽章（阈值同步 signal.config.js YIELD_CURVE_INVERSION_CONFIRM_DAYS=63 /
// api/signal.js applyYieldCurveVeto）：倒挂≥63交易日=确认期（红，进攻档准入被否决）；
// 0<天数<63=倒挂未确认（黄）；未倒挂（绿）。数据全缺失不显示徽章
function ycStatus(ind) {
  if (ind.yieldCurveSpread == null && ind.yieldCurveInvertedDays == null) return null;
  const days = ind.yieldCurveInvertedDays ?? 0;
  if (days >= 63) return 'tight';
  if (days > 0) return 'neutral';
  return 'loose';
}

function hintFor(ind) {
  if (JUDGED_KEYS.has(ind.key)) {
    return `${t(`indicators.hints.${ind.key}`)}\n${t('indicators.hintGlobal')}`;
  }
  // 收益率曲线是参考指标但有专属提示（唯一判定角色：倒挂确认期否决进攻档准入）
  if (ind.key === 'yieldCurve') return t('indicators.hints.yieldCurve');
  return t('indicators.hints.reference');
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
        // 顺序=AI产业链现金流向：模型用量（源头需求）→ 云厂商资本开支 → 半导体产出
        {
          key: 'modelUsageTrend', signed: true, value: ind.modelUsageTrendPct, unit: '%', change: null,
          // 优先用后端算好的调用量子信号（server.js 复用 aiMarketSignal 列存 usageSignal）；
          // null 时回退本地阈值，同步 signal.config.js：>+3 宽松 / <-3 收紧 / 其间中性
          // （2026-07-17 窗口改为28日均vs前28日均后阈值随之重标定，±10 → ±3）
          signalBadge: ind.aiMarketSignal ?? (ind.modelUsageTrendPct != null
            ? (ind.modelUsageTrendPct > 3 ? 'loose' : ind.modelUsageTrendPct < -3 ? 'tight' : 'neutral')
            : null),
        },
        {
          key: 'capexYoY', signed: true, value: ind.capexYoY, unit: '%', change: null,
          // 阈值同步 signal.config.js：>+10% 宽松 / <0% 收紧（触发泡沫预警）/ 其间中性
          signalBadge: ind.capexYoY != null
            ? (ind.capexYoY > 10 ? 'loose' : ind.capexYoY < 0 ? 'tight' : 'neutral')
            : null,
        },
        {
          key: 'semiIpYoy', signed: true, value: ind.semiIpYoy, unit: '%', change: null,
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
          key: 'sahm', value: ind.sahmValue, unit: '%',
          change: null,
          // 阈值同步 signal.config.js：≥0.5 触发萨姆锁
          extra: ind.sahmValue != null ? '(< 0.5%)' : null,
          signalBadge: ind.sahmLockActive ? 'tight'
            : ind.sahmValue != null ? (ind.sahmValue >= 0.5 ? 'tight' : 'loose') : null,
          periodDate: ind.sahmPeriodDate, releaseDate: ind.sahmReleaseDate, periodIsMonth: true,
        },
        {
          key: 'unemployment', value: ind.unemployment, unit: '%',
          change: ind.unemployment !== null && ind.unemploymentPrev !== null ? ind.unemployment - ind.unemploymentPrev : null,
          periodDate: ind.unemploymentPeriodDate, releaseDate: ind.unemploymentReleaseDate, periodIsMonth: true,
        },
        {
          // 收益率曲线(10y−3m)参考指标：不参与防守判定；唯一判定角色=倒挂确认期（≥63交易日）
          // 否决进攻档准入（backend/api/signal.js applyYieldCurveVeto 同口径）
          key: 'yieldCurve', signed: true, value: ind.yieldCurveSpread, unit: '%', change: null,
          extra: (ind.yieldCurveInvertedDays ?? 0) > 0
            ? t('indicators.ycInvertedDays', { n: ind.yieldCurveInvertedDays })
            : null,
          ycStatus: ycStatus(ind),
          periodDate: ind.yieldCurvePeriodDate,
        },
      ],
    },
    {
      key: 'fiscal',
      items: [
        {
          // 联邦支出TTM（百万美元）展示为十亿美元；判定指标=支出同比（政府规模变化）
          key: 'fiscalOutlaysTtm', value: ind.fiscalOutlaysTtm != null ? ind.fiscalOutlaysTtm / 1000 : null, unit: 'B', change: null,
          extra: ind.fiscalOutlaysChangePct != null
            ? `${t('indicators.yoyChange')} ${ind.fiscalOutlaysChangePct > 0 ? '+' : ''}${ind.fiscalOutlaysChangePct.toFixed(1)}%`
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
          // 油价事件层：WTI 30天涨跌幅是战争新闻的市场实时定价（开战跳涨/停战跳水），±20%优先于EPU
          key: 'oilWti', value: ind.oilWti, unit: '', change: null,
          extra: ind.oilChange30dPct != null
            ? `30D ${ind.oilChange30dPct > 0 ? '+' : ''}${ind.oilChange30dPct.toFixed(1)}%`
              + (ind.oilSource ? ` · ${t(`indicators.oilSource.${ind.oilSource}`)}` : '')
            : null,
          signalBadge: oilBadge(ind),
          periodDate: ind.oilPeriodDate,
        },
        {
          // 日频EPU 7日均线：政策转向（如关税战暂停）数天内可见，与月度贸易专项指数一致才定档
          key: 'epuDaily', value: ind.epuDaily, unit: '', change: null,
          extra: ind.epuDailyPercentile != null ? `${t('indicators.percentile10y')} ${ind.epuDailyPercentile.toFixed(0)}` : null,
          signalBadge: epuBadge(ind.epuDailyPercentile),
          periodDate: ind.epuDailyPeriodDate,
        },
        {
          key: 'epuTrade', value: ind.epuTrade, unit: '', change: null,
          extra: ind.epuTradePercentile != null ? `${t('indicators.percentile10y')} ${ind.epuTradePercentile.toFixed(0)}` : null,
          signalBadge: epuBadge(ind.epuTradePercentile),
          periodDate: ind.epuTradePeriodDate, periodIsMonth: true,
        },
      ],
    },
  ];
});
</script>

<style scoped>
.macro-panel { display: flex; flex-direction: column; gap: 12px; }

.loading { color: var(--text-3); font-size: var(--fs-lg); }

.indicators-section { display: flex; flex-direction: column; gap: 10px; }
.section-title { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-4); margin-bottom: 4px; }

.group-title {
  font-size: var(--fs-xs);
  color: var(--blue);
  font-weight: 600;
  margin-top: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border-1);
}

.indicator-block { display: flex; flex-direction: column; gap: 2px; }

.indicator-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--fs-md);
}

.ind-label { color: var(--text-3); font-weight: 500; }
/* 有悬浮提示的指标标签用帮助光标提示可悬停 */
.ind-label.hinted { cursor: help; }
.ind-value { color: var(--text-2); font-family: var(--font-num); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.ind-change { font-size: var(--fs-xs); margin-left: 6px; }
.ind-change.up { color: var(--red); }
.ind-change.down { color: var(--green); }
.ind-change.flat { color: var(--yellow); } /* 持平=中性，与观望档位同色 */

.ind-extra { font-size: var(--fs-xs); color: var(--text-3); }

.ind-meta { font-size: var(--fs-xs); color: var(--text-4); display: flex; gap: 4px; flex-wrap: wrap; }

.pos-badge {
  font-size: var(--fs-xs);
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 6px;
}
.pos-badge.loose { background: var(--green-bg); color: var(--green); }
.pos-badge.neutral { background: var(--yellow-bg); color: var(--yellow); }
.pos-badge.tight { background: var(--red-bg); color: var(--red); }
</style>
