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
          <span :class="['bubble-value', usageClass]">
            {{ bubble.modelUsageTrendPct != null ? formatPct(bubble.modelUsageTrendPct) : $t('aiChain.noData') }}
          </span>
        </div>
        <div class="bubble-cell">
          <span class="bubble-label">{{ $t('aiChain.capexYoY') }}</span>
          <span :class="['bubble-value', capexClass]">
            {{ capexDisplay }}
          </span>
        </div>
        <div class="bubble-cell">
          <span class="bubble-label">{{ $t('aiChain.semiIpYoy') }}</span>
          <span :class="['bubble-value', semiIpClass]">
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
import { useI18n } from 'vue-i18n';
import { AI_CHAIN_STAGES } from '../data/aiChain.js';
import { api } from '../api/client.js';

const { t } = useI18n();
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

// 统一颜色语义：绿=宽松/利好进攻，黄=中性/观望，红=收紧/利好防守（与信号位徽章一致）
// 调用量：触发预警→红；负增长但未到预警线→黄；正增长→绿
const usageClass = computed(() => {
  const v = bubble.value.modelUsageTrendPct;
  if (v == null) return '';
  if ((bubble.value.reasons || []).includes('modelUsage')) return 'neg';
  return v >= 0 ? 'pos' : 'neutral';
});

// 资本开支：判定阈值即0，负增长必触发预警→红，正增长→绿
const capexClass = computed(() => {
  const v = bubble.value.capexYoY;
  if (v == null) return '';
  if ((bubble.value.reasons || []).includes('capex')) return 'neg';
  return v >= 0 ? 'pos' : 'neutral';
});

// 半导体产出：直接用后端 aiSupply 基本面子信号（>5%宽松/<0%收紧/其间观望）
const semiIpClass = computed(() => {
  const sig = bubble.value.aiFundamentalSignal;
  if (sig === 'loose') return 'pos';
  if (sig === 'tight') return 'neg';
  if (sig === 'neutral') return 'neutral';
  return '';
});

// 资本开支显示：总额（按语言用 亿/億/억 或 B/Mrd/MM）+ 同比%
const capexDisplay = computed(() => {
  const { capexTtm, capexYoY } = bubble.value;
  if (capexTtm == null && capexYoY == null) return t('aiChain.noData');
  const parts = [];
  if (capexTtm != null) {
    parts.push(t('aiChain.capexAmount', {
      yi: Math.round(capexTtm / 1e8).toLocaleString(),
      bn: (capexTtm / 1e9).toFixed(0),
    }));
  }
  if (capexYoY != null) parts.push(`(${formatPct(capexYoY)})`);
  return parts.join(' ');
});

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
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-4);
  margin-bottom: 4px;
}

.chain-flow { display: flex; flex-direction: column; align-items: center; gap: 4px; }

.chain-stage {
  width: 100%;
  max-width: 480px;
  background: var(--bg-card);
  border: 1px solid var(--border-2);
  border-radius: 10px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chain-stage.bottleneck {
  border-color: var(--amber-border);
  background: var(--amber-bg);
}

.stage-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.stage-name { font-size: var(--fs-md); color: var(--text-2); font-weight: 600; display: flex; align-items: center; gap: 6px; }
.rank-badge {
  font-size: var(--fs-xs);
  color: var(--yellow);
  border: 1px solid var(--yellow-border);
  border-radius: 4px;
  padding: 0 5px;
}
.stage-metrics { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.rel-return { font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.rel-return.pos { color: var(--green); }
.rel-return.neg { color: var(--red); }
.bottleneck-tag { font-size: var(--fs-xs); color: var(--yellow); }

.stage-tickers { display: flex; flex-wrap: wrap; gap: 6px; }
.ticker-chip {
  font-size: var(--fs-xs);
  color: var(--blue);
  background: var(--blue-bg);
  border: 1px solid var(--blue-border);
  border-radius: 5px;
  padding: 2px 8px;
}

.stage-arrow { text-align: center; color: var(--text-5); font-size: var(--fs-lg); }

.bubble-monitor {
  background: var(--bg-card);
  border: 1px solid var(--border-2);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bubble-title { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-4); }
.bubble-alert {
  font-size: var(--fs-sm);
  color: var(--red);
  background: var(--red-bg);
  border-radius: 6px;
  padding: 6px 10px;
}
.bubble-metrics { display: flex; gap: 16px; flex-wrap: wrap; }
.bubble-cell { display: flex; flex-direction: column; gap: 2px; min-width: 140px; }
.bubble-label { font-size: var(--fs-xs); color: var(--text-3); font-weight: 500; }
.bubble-value { font-size: var(--fs-lg); color: var(--text-2); font-variant-numeric: tabular-nums; }
.bubble-value.pos { color: var(--green); }
.bubble-value.neg { color: var(--red); }
.bubble-value.neutral { color: var(--yellow); }
.bubble-source { font-size: var(--fs-xs); color: var(--text-4); }
</style>
