<template>
  <div class="signal-hero">
    <div v-if="!signal" class="loading">{{ $t('signal.loading') }}</div>
    <template v-else>
      <!-- 当前信号大型显示 -->
      <div class="hero-main">
        <div class="hero-badges">
          <div
            v-for="s in SIGNALS"
            :key="s.key"
            :class="['hero-badge', s.key, { active: signal.finalSignal === s.key }]"
          >
            <span class="hero-emoji">{{ s.emoji }}</span>
            <span class="hero-label">{{ $t(`signal.${s.key}`) }}</span>
          </div>
        </div>
        <div v-if="signal.dataDate" class="hero-date">
          {{ $t('indicators.dataDate') }}: {{ signal.dataDate }}
        </div>
      </div>

      <!-- 快照过期警示：云端 cron 停摆时 dataDate 停走，用户须显式知道信号已失效 -->
      <div v-if="snapshotStaleDays >= 3" class="stale-banner">
        ⚠️ {{ $t('signal.snapshotStale', { days: snapshotStaleDays }) }}
      </div>

      <!-- 泡沫预警横幅 -->
      <div v-if="signal.indicators?.aiBubbleWarning" class="bubble-banner">
        ⚠️ {{ $t('aiChain.bubbleWarning') }}
      </div>

      <!-- N3 capex指引下修事件横幅：巨头财报电话会明确下修capex指引（前瞻信号，管理员录入） -->
      <div v-if="signal.indicators?.capexGuidanceDowngrade" class="bubble-banner">
        🔴 {{ $t('signal.capexGuidanceBanner') }}<template v-if="signal.indicators?.capexGuidanceNote">：{{ signal.indicators.capexGuidanceNote }}</template>
      </div>

      <!-- 衰退防守锁定横幅 -->
      <div v-if="lockInfo" class="lock-banner">
        ⚠️ {{ $t('recessionLock.banner') }}：{{ lockInfo.reasonText }}
        <template v-if="lockInfo.overridden"> · {{ $t('recessionLock.overridden') }}</template>
        <div class="lock-wait">{{ $t('recessionLock.waitCondition') }}</div>
      </div>

      <!-- 信号解读：为什么防守 / 距进攻还差什么 -->
      <div class="interpret">
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
          <span v-for="c in attackChecklist" :key="c.key" :class="['interpret-item', c.ok ? 'loose' : 'pending']">
            {{ c.ok ? '✓' : '○' }} {{ $t(c.labelKey) }}
          </span>
        </div>
      </div>

      <!-- 四维信号卡（顺序=策略主线：长线看供需，短线看政策） -->
      <div class="dim-cards">
        <div v-for="d in positions" :key="d.key" :class="['dim-card', d.value, { stale: d.stale }]">
          <div class="dim-head">
            <span class="dim-name">{{ $t(`signalPos.${d.key}`) }}</span>
            <span v-if="d.source === 'override'" class="dim-source">{{ $t('signalPos.override') }}</span>
            <span v-else-if="d.stale" class="dim-source stale-tag" :title="$t('indicators.staleHint')">{{ $t('indicators.stale') }}</span>
          </div>
          <div :class="['dim-badge', d.value]">{{ $t(`signalPos.${d.value}`) }}</div>
          <div class="dim-metric">{{ d.metric || '—' }}</div>
        </div>
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

const { t } = useI18n();

const SIGNALS = [
  { key: 'attack', emoji: '🟢' },
  { key: 'neutral', emoji: '🟡' },
  { key: 'reduce', emoji: '🟠' },
  { key: 'defense', emoji: '🔴' },
];

const fmtPct = v => (v == null ? null : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);

// "距进攻"清单达成判定（非对称进攻，同步 backend/api/signal.js calcFinalSignal）：
// AI供需必须=宽松（主动引擎发动）；货币/财政/行政只需"不收紧"（中性或宽松均达成，任一收紧即否决）。
// 锁激活在 server 层强制防守，不进此清单。
function attackReady(d) {
  return d.key === 'aiSupply' ? d.value === 'loose' : d.value !== 'tight';
}

// 各维度卡片上的核心数据一行
function dimMetric(key) {
  const ind = props.signal?.indicators || {};
  if (key === 'aiSupply') {
    // 按产业链现金流向排列：付费源头（模型调用量）最领先最靠前 → 云capex → 半导体产出
    const parts = [];
    if (ind.modelUsageTrendPct != null) parts.push(`${t('indicators.short.modelUsage')} ${fmtPct(ind.modelUsageTrendPct)}`);
    // 单季同比为括号附注：拐点侦察兵（参考），TTM为主判定口径，不混排成第四个判定输入
    if (ind.capexYoY != null) {
      const qtr = ind.capexQtrYoY != null ? ` (${t('indicators.short.capexQtr')} ${fmtPct(ind.capexQtrYoY)})` : '';
      parts.push(`${t('indicators.short.capex')} ${fmtPct(ind.capexYoY)}${qtr}`);
    }
    if (ind.semiIpYoy != null) parts.push(`${t('indicators.short.semiIp')} ${fmtPct(ind.semiIpYoy)}`);
    return parts.join(' · ') || null;
  }
  if (key === 'monetary') {
    // 判定要素：利率 + 资产负债表状态（QE/暂停/QT）
    const parts = [];
    if (ind.rate != null) parts.push(`${t('indicators.rate')} ${ind.rate.toFixed(2)}%`);
    if (ind.balanceSheetStatus) parts.push(t(`indicators.bsStatus.${ind.balanceSheetStatus}`));
    return parts.join(' · ') || null;
  }
  if (key === 'fiscal') {
    return ind.fiscalOutlaysChangePct != null
      ? `${t('indicators.short.outlaysYoY')} ${fmtPct(ind.fiscalOutlaysChangePct)}`
      : null;
  }
  if (key === 'administrative') {
    // 按判定优先级排列：油价（事件层第一优先，常显）→ 日频EPU（时效）→ 月度贸易EPU（结构）
    const parts = [];
    if (ind.oilChange30dPct != null) {
      parts.push(`WTI 30D ${fmtPct(ind.oilChange30dPct)}`);
    }
    if (ind.epuDailyPercentile != null) {
      parts.push(`${t('indicators.short.epuDaily')} P${ind.epuDailyPercentile.toFixed(0)}`);
    }
    if (ind.epuTradePercentile != null) {
      parts.push(`${t('indicators.short.epuTrade')} P${ind.epuTradePercentile.toFixed(0)}`);
    }
    return parts.join(' · ') || null;
  }
  return null;
}

// 收紧维度附带的关键数据（解读块）
function dimDetail(key) {
  const ind = props.signal?.indicators || {};
  if (key === 'fiscal' && ind.fiscalOutlaysChangePct != null) {
    return `${t('indicators.fiscalOutlaysTtm')} ${t('indicators.yoyChange')} ${fmtPct(ind.fiscalOutlaysChangePct)}`;
  }
  if (key === 'administrative' && ind.epuTradePercentile != null) {
    return `${t('indicators.epuTrade')} ${t('indicators.percentile10y')} ${ind.epuTradePercentile.toFixed(0)}`;
  }
  if (key === 'aiSupply' && ind.aiBubbleWarning) {
    return t('aiChain.bubbleWarning');
  }
  return null;
}

// 顺序遵循策略主线："长线看供需（AI供需），短线看政策（货币/财政/行政）"
const positions = computed(() => {
  const s = props.signal;
  if (!s) return [];
  const stale = s.staleFlags || {};
  return [
    { key: 'aiSupply', value: s.aiSupplySignal, source: s.aiSupplySignalSource, metric: dimMetric('aiSupply'), stale: !!stale.aiSupply },
    { key: 'monetary', value: s.monetarySignal, metric: dimMetric('monetary') },
    { key: 'fiscal', value: s.fiscalSignal, source: s.fiscalSignalSource, metric: dimMetric('fiscal'), stale: !!stale.fiscal },
    { key: 'administrative', value: s.adminSignal, source: s.adminSignalSource, metric: dimMetric('administrative'), stale: !!stale.administrative },
  ];
});

const tightDims = computed(() =>
  positions.value.filter(p => p.value === 'tight').map(p => ({ ...p, detail: dimDetail(p.key) }))
);

// "距进攻"清单 = 四维达成状态 + 收益率曲线否决器。
// 曲线项同步 backend/api/signal.js applyYieldCurveVeto：10y−3m 连续倒挂 ≥63 个交易日
// （≈3个月，signal.config.js YIELD_CURVE_INVERSION_CONFIRM_DAYS）时否决进攻档准入；
// 数据缺失(null)视为达成——与后端 fail-open 同口径。
const attackChecklist = computed(() => [
  ...positions.value.map(d => ({ key: d.key, labelKey: `signalPos.${d.key}`, ok: attackReady(d) })),
  {
    key: 'yieldCurve',
    labelKey: 'interpret.yieldCurveOk',
    ok: (props.signal?.indicators?.yieldCurveInvertedDays ?? 0) < 63,
  },
]);

const lockInfo = computed(() => {
  const ind = props.signal?.indicators;
  if (!ind) return null;
  if (ind.sahmLockActive) {
    return {
      overridden: !!ind.sahmLockOverridden,
      reasonText: t('recessionLock.sahmReason', { value: ind.sahmValue != null ? ind.sahmValue.toFixed(2) : '—' }),
    };
  }
  if (ind.reactiveAdjustmentLockActive) {
    return {
      overridden: !!ind.reactiveAdjustmentLockOverridden,
      reasonText: t('recessionLock.reactiveReason', { bp: ind.reactiveAdjustmentLockTriggerBp ?? '—' }),
    };
  }
  return null;
});

// 快照距今天数：>=3 天显示失效警示（周末+假日最长2天无cron属正常，3天=真停摆）。
// 云端 cron 停摆时 dataDate 停走，没有这个警示用户会把过期信号当最新信号执行
const snapshotStaleDays = computed(() => {
  const d = props.signal?.dataDate;
  if (!d) return 0;
  const age = Math.floor((Date.now() - Date.parse(d + 'T00:00:00Z')) / 86400000);
  return age > 0 ? age : 0;
});
</script>

<style scoped>
.signal-hero { display: flex; flex-direction: column; gap: 16px; }
.loading { color: var(--text-3); font-size: var(--fs-lg); }

.hero-main { display: flex; flex-direction: column; align-items: center; gap: 8px; }

.hero-badges { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; }

.hero-badge {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 28px;
  border-radius: 14px;
  border: 1px solid var(--border-2);
  opacity: 0.3;
  transform: scale(0.92);
  transition: all 0.3s ease;
}
.hero-badge .hero-emoji { font-size: 20px; }
.hero-badge .hero-label { font-size: var(--fs-xl); font-weight: 700; letter-spacing: 0.02em; }

.hero-badge.active { opacity: 1; transform: scale(1.08); }
.hero-badge.attack { background: var(--green-bg); color: var(--green); border-color: var(--green-border); }
.hero-badge.attack.active { background: var(--green-bg); box-shadow: 0 0 36px var(--glow-green); }
.hero-badge.neutral { color: var(--yellow); border-color: var(--yellow-border); }
.hero-badge.neutral.active { background: var(--yellow-bg); box-shadow: 0 0 36px var(--glow-yellow); }
.hero-badge.reduce { color: var(--orange); border-color: var(--orange-border); }
.hero-badge.reduce.active { background: var(--orange-bg); box-shadow: 0 0 36px var(--glow-orange); }
.hero-badge.defense { color: var(--red); border-color: var(--red-border); }
.hero-badge.defense.active {
  background: var(--red-bg);
  box-shadow: 0 0 36px var(--glow-red);
  animation: defense-pulse 2s ease-in-out infinite; /* 防守=示警中，红色呼吸脉冲 */
}
@keyframes defense-pulse {
  0%, 100% { box-shadow: 0 0 24px var(--glow-red); }
  50% { box-shadow: 0 0 48px var(--glow-red); }
}

.hero-date { font-size: var(--fs-sm); color: var(--text-4); }

.bubble-banner {
  text-align: center;
  font-size: var(--fs-md);
  color: var(--red);
  background: var(--red-bg);
  border: 1px solid var(--red-border);
  border-radius: 8px;
  padding: 8px 14px;
}

.lock-banner {
  text-align: center;
  font-size: var(--fs-md);
  color: var(--red);
  background: var(--red-bg);
  border: 1px solid var(--red-border);
  border-radius: 8px;
  padding: 8px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.lock-wait { font-size: var(--fs-xs); color: var(--text-4); }

.stale-banner {
  text-align: center;
  font-size: var(--fs-md);
  color: var(--red);
  background: var(--red-bg);
  border: 1px solid var(--red-border);
  border-radius: 8px;
  padding: 8px 14px;
}

.interpret {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.interpret-block { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: center; gap: 6px 12px; }
.interpret-label { font-size: var(--fs-sm); color: var(--text-3); }
.interpret-item { font-size: var(--fs-sm); }
.interpret-item.tight { color: var(--red); }
.interpret-item.loose { color: var(--green); }
.interpret-item.pending { color: var(--yellow); }

.dim-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.dim-card {
  position: relative;
  background: linear-gradient(180deg, var(--panel-a), var(--panel-b));
  border: 1px solid var(--border-2);
  border-radius: 12px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
  transition: border-color 0.2s;
}
.dim-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--highlight), transparent);
}
.dim-card:hover { border-color: var(--border-3); }
.dim-card.tight { border-color: var(--red-border); }
.dim-card.loose { border-color: var(--green-bg); }
/* stale = 数据源故障沿用上次判定，整卡降饱和提示数据非当日 */
.dim-card.stale { opacity: 0.55; filter: grayscale(0.4); }
.stale-tag { cursor: help; color: var(--yellow); border-color: var(--yellow-border); }

.dim-head { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.dim-name { font-size: var(--fs-sm); color: var(--text-3); font-weight: 600; }
.dim-source {
  font-size: var(--fs-xs);
  color: var(--text-4);
  border: 1px solid var(--border-3);
  border-radius: 4px;
  padding: 0 5px;
  white-space: nowrap;
}

.dim-badge {
  align-self: flex-start;
  font-size: var(--fs-lg);
  font-weight: 700;
  padding: 4px 12px;
  border-radius: 6px;
}
.dim-badge.loose { background: var(--green-bg); color: var(--green); }
.dim-badge.neutral { background: var(--yellow-bg); color: var(--yellow); }
.dim-badge.tight { background: var(--red-bg); color: var(--red); }

.dim-metric { font-size: var(--fs-xs); color: var(--text-4); font-family: var(--font-num); }

@media (max-width: 900px) {
  .dim-cards { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 600px) {
  .dim-cards { grid-template-columns: 1fr; }
  .hero-badge { padding: 10px 18px; }
  .hero-badge .hero-label { font-size: var(--fs-lg); }
}
</style>
