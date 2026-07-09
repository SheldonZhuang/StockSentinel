<template>
  <div class="ai-chain-panel">
    <div class="section-title">{{ $t('aiChain.title') }}</div>
    <div class="chain-flow">
      <div
        v-for="(stage, idx) in stages"
        :key="stage.key"
        :class="['chain-stage', { bottleneck: bottleneck.stage === stage.key }]"
      >
        <div class="stage-header">
          <span class="stage-name">
            {{ $t(`aiChain.stages.${stage.key}`) }}
            <span v-if="stage.rank" class="rank-badge">#{{ stage.rank }}</span>
          </span>
          <span class="stage-metrics">
            <span v-if="stage.key === 'model' && bubble.modelUsageTrendPct != null"
              :class="['rel-return', bubble.modelUsageTrendPct >= 0 ? 'pos' : 'neg']">
              {{ formatPct(bubble.modelUsageTrendPct) }}
            </span>
            <span v-else-if="stage.relReturnPct != null"
              :class="['rel-return', stage.relReturnPct >= 0 ? 'pos' : 'neg']"
              :title="$t('aiChain.relReturnLabel')">
              {{ formatPct(stage.relReturnPct) }}
            </span>
            <span v-if="bottleneck.stage === stage.key" class="bottleneck-tag">
              🔥 {{ $t('aiChain.currentBottleneck') }} ·
              {{ $t(bottleneck.source === 'manual' ? 'aiChain.sourceManual' : 'aiChain.sourceAuto') }}
            </span>
          </span>
        </div>
        <div class="stage-tickers">
          <span v-for="ticker in stage.tickers" :key="ticker" class="ticker-chip">{{ ticker }}</span>
        </div>
        <div v-if="idx < stages.length - 1" class="stage-arrow">↓</div>
      </div>
    </div>

    <!-- 泡沫监测：调用量/资本开支/半导体产出（下降 → 防守预警） -->
    <div class="bubble-monitor">
      <div class="bubble-title">{{ $t('aiChain.bubbleTitle') }}</div>
      <div v-if="bubble.warning" class="bubble-alert">⚠️ {{ $t('aiChain.bubbleWarning') }}</div>
      <div class="bubble-metrics">
        <div class="bubble-cell">
          <span class="bubble-label">{{ $t('aiChain.modelUsageTrend') }}</span>
          <span :class="bubbleValueClass(bubble.modelUsageTrendPct)">
            {{ bubble.modelUsageTrendPct != null ? formatPct(bubble.modelUsageTrendPct) : $t('aiChain.noData') }}
          </span>
        </div>
        <div class="bubble-cell">
          <span class="bubble-label">{{ $t('aiChain.capexYoY') }}</span>
          <span :class="bubbleValueClass(bubble.capexYoY)">
            {{ bubble.capexYoY != null ? formatPct(bubble.capexYoY) : $t('aiChain.noData') }}
          </span>
        </div>
        <div class="bubble-cell">
          <span class="bubble-label">{{ $t('aiChain.semiIpYoy') }}</span>
          <span :class="bubbleValueClass(bubble.semiIpYoy)">
            {{ bubble.semiIpYoy != null ? formatPct(bubble.semiIpYoy) : $t('aiChain.noData') }}
          </span>
        </div>
      </div>
      <div v-if="bubble.modelUsageAsOf" class="bubble-source">
        Source: OpenRouter (openrouter.ai/rankings), as of {{ bubble.modelUsageAsOf }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { AI_CHAIN_STAGES } from '../data/aiChain.js';
import { api } from '../api/client.js';

const chainData = ref(null);

const bottleneck = computed(() => chainData.value?.bottleneck || { stage: null, source: 'auto', note: null });
const bubble = computed(() => chainData.value?.bubble || {});

// 静态标的清单 + 后端排名/相对收益按环节合并
const stages = computed(() => {
  const metrics = new Map((chainData.value?.stages || []).map(s => [s.key, s]));
  return AI_CHAIN_STAGES.map(s => ({ ...s, ...(metrics.get(s.key) || {}) }));
});

function formatPct(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function bubbleValueClass(v) {
  if (v == null) return 'bubble-value';
  return ['bubble-value', v >= 0 ? 'pos' : 'neg'];
}

onMounted(async () => {
  try {
    chainData.value = await api.getAiChain();
  } catch (e) {
    console.error('Failed to load ai-chain data', e);
  }
});
</script>

<style scoped>
.ai-chain-panel { display: flex; flex-direction: column; gap: 12px; }

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: #eee;
  margin-bottom: 4px;
}

.chain-flow { display: flex; flex-direction: column; align-items: center; gap: 4px; }

.chain-stage {
  width: 100%;
  max-width: 480px;
  background: #111;
  border: 1px solid #222;
  border-radius: 10px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chain-stage.bottleneck {
  border-color: #5a3d1e;
  background: #1a140a;
}

.stage-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.stage-name { font-size: 13px; color: #ccc; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.rank-badge {
  font-size: 10px;
  color: #facc15;
  border: 1px solid #4a3d15;
  border-radius: 4px;
  padding: 0 5px;
}
.stage-metrics { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.rel-return { font-size: 12px; font-variant-numeric: tabular-nums; }
.rel-return.pos { color: #4ade80; }
.rel-return.neg { color: #f87171; }
.bottleneck-tag { font-size: 11px; color: #facc15; }

.stage-tickers { display: flex; flex-wrap: wrap; gap: 6px; }
.ticker-chip {
  font-size: 11px;
  color: #6b9eff;
  background: #0d1a2e;
  border: 1px solid #1e3a5a;
  border-radius: 5px;
  padding: 2px 8px;
}

.stage-arrow { text-align: center; color: #444; font-size: 14px; }

.bubble-monitor {
  background: #111;
  border: 1px solid #222;
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bubble-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #555; }
.bubble-alert {
  font-size: 12px;
  color: #f87171;
  background: #3a1717;
  border-radius: 6px;
  padding: 6px 10px;
}
.bubble-metrics { display: flex; gap: 16px; flex-wrap: wrap; }
.bubble-cell { display: flex; flex-direction: column; gap: 2px; min-width: 140px; }
.bubble-label { font-size: 11px; color: #888; }
.bubble-value { font-size: 14px; color: #ccc; font-variant-numeric: tabular-nums; }
.bubble-value.pos { color: #4ade80; }
.bubble-value.neg { color: #f87171; }
.bubble-source { font-size: 10px; color: #444; }
</style>
