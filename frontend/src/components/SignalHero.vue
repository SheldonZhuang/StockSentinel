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

      <!-- 泡沫预警横幅 -->
      <div v-if="signal.indicators?.aiBubbleWarning" class="bubble-banner">
        ⚠️ {{ $t('aiChain.bubbleWarning') }}
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
          <span v-for="d in positions" :key="d.key" :class="['interpret-item', d.value === 'loose' ? 'loose' : 'pending']">
            {{ d.value === 'loose' ? '✓' : '○' }} {{ $t(`signalPos.${d.key}`) }}
          </span>
        </div>
      </div>

      <!-- 四维信号卡（顺序=策略主线：长线看供需，短线看政策） -->
      <div class="dim-cards">
        <div v-for="d in positions" :key="d.key" :class="['dim-card', d.value]">
          <div class="dim-head">
            <span class="dim-name">{{ $t(`signalPos.${d.key}`) }}</span>
            <span v-if="d.source === 'override'" class="dim-source">{{ $t('signalPos.override') }}</span>
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
  { key: 'defense', emoji: '🔴' },
];

const fmtPct = v => (v == null ? null : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);

// 各维度卡片上的核心数据一行
function dimMetric(key) {
  const ind = props.signal?.indicators || {};
  if (key === 'aiSupply') {
    const parts = [];
    if (ind.smhSpyRelReturnPct != null) parts.push(`SMH−SPY ${fmtPct(ind.smhSpyRelReturnPct)}`);
    if (ind.semiIpYoy != null) parts.push(`${t('indicators.semiIpYoy')} ${fmtPct(ind.semiIpYoy)}`);
    return parts.join(' · ') || null;
  }
  if (key === 'monetary') {
    return ind.rate != null ? `${t('indicators.rate')} ${ind.rate.toFixed(2)}%` : null;
  }
  if (key === 'fiscal') {
    return ind.fiscalDeficitChangePct != null
      ? `${t('indicators.yoyChange')} ${fmtPct(ind.fiscalDeficitChangePct)}`
      : null;
  }
  if (key === 'administrative') {
    return ind.epuTradePercentile != null
      ? `${t('indicators.percentile10y')} ${ind.epuTradePercentile.toFixed(0)}`
      : null;
  }
  return null;
}

// 收紧维度附带的关键数据（解读块）
function dimDetail(key) {
  const ind = props.signal?.indicators || {};
  if (key === 'fiscal' && ind.fiscalDeficitChangePct != null) {
    return `${t('indicators.fiscalDeficitTtm')} ${t('indicators.yoyChange')} ${fmtPct(ind.fiscalDeficitChangePct)}`;
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
  return [
    { key: 'aiSupply', value: s.aiSupplySignal, source: s.aiSupplySignalSource, metric: dimMetric('aiSupply') },
    { key: 'monetary', value: s.monetarySignal, metric: dimMetric('monetary') },
    { key: 'fiscal', value: s.fiscalSignal, source: s.fiscalSignalSource, metric: dimMetric('fiscal') },
    { key: 'administrative', value: s.adminSignal, source: s.adminSignalSource, metric: dimMetric('administrative') },
  ];
});

const tightDims = computed(() =>
  positions.value.filter(p => p.value === 'tight').map(p => ({ ...p, detail: dimDetail(p.key) }))
);
</script>

<style scoped>
.signal-hero { display: flex; flex-direction: column; gap: 16px; }
.loading { color: #888; font-size: 14px; }

.hero-main { display: flex; flex-direction: column; align-items: center; gap: 8px; }

.hero-badges { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; }

.hero-badge {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 28px;
  border-radius: 14px;
  border: 1px solid #222;
  opacity: 0.3;
  transform: scale(0.92);
  transition: all 0.3s ease;
}
.hero-badge .hero-emoji { font-size: 20px; }
.hero-badge .hero-label { font-size: 18px; font-weight: 700; letter-spacing: 0.02em; }

.hero-badge.active { opacity: 1; transform: scale(1.08); }
.hero-badge.attack { background: #10241708; color: #4ade80; border-color: #1f4a2c; }
.hero-badge.attack.active { background: #12301c; box-shadow: 0 0 36px rgba(74, 222, 128, 0.25); }
.hero-badge.neutral { color: #facc15; border-color: #4a4215; }
.hero-badge.neutral.active { background: #2c2812; box-shadow: 0 0 36px rgba(250, 204, 21, 0.2); }
.hero-badge.defense { color: #f87171; border-color: #4a1f1f; }
.hero-badge.defense.active {
  background: #301414;
  box-shadow: 0 0 36px rgba(248, 113, 113, 0.28);
  animation: defense-pulse 2s ease-in-out infinite; /* 防守=示警中，红色呼吸脉冲 */
}
@keyframes defense-pulse {
  0%, 100% { box-shadow: 0 0 24px rgba(248, 113, 113, 0.18); }
  50% { box-shadow: 0 0 48px rgba(248, 113, 113, 0.4); }
}

.hero-date { font-size: 12px; color: #666; }

.bubble-banner {
  text-align: center;
  font-size: 13px;
  color: #f87171;
  background: #2a1212;
  border: 1px solid #4a1f1f;
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
.interpret-label { font-size: 12px; color: #888; }
.interpret-item { font-size: 12px; }
.interpret-item.tight { color: #f87171; }
.interpret-item.loose { color: #4ade80; }
.interpret-item.pending { color: #facc15; }

.dim-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.dim-card {
  position: relative;
  background: linear-gradient(180deg, #131313, #0e0e0e);
  border: 1px solid #222;
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
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.14), transparent);
}
.dim-card:hover { border-color: #333; }
.dim-card.tight { border-color: #3a1c1c; }
.dim-card.loose { border-color: #1c3a24; }

.dim-head { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.dim-name { font-size: 12px; color: #aaa; font-weight: 600; }
.dim-source {
  font-size: 10px;
  color: #777;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 0 5px;
  white-space: nowrap;
}

.dim-badge {
  align-self: flex-start;
  font-size: 14px;
  font-weight: 700;
  padding: 4px 12px;
  border-radius: 7px;
}
.dim-badge.loose { background: #173a24; color: #4ade80; }
.dim-badge.neutral { background: #2a2a1a; color: #facc15; }
.dim-badge.tight { background: #3a1717; color: #f87171; }

.dim-metric { font-size: 11px; color: #777; font-variant-numeric: tabular-nums; }

@media (max-width: 900px) {
  .dim-cards { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 600px) {
  .dim-cards { grid-template-columns: 1fr; }
  .hero-badge { padding: 10px 18px; }
  .hero-badge .hero-label { font-size: 15px; }
}
</style>
