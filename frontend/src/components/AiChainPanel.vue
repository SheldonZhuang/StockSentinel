<template>
  <div class="ai-chain-panel">
    <div class="section-title">{{ $t('aiChain.title') }}</div>
    <div class="chain-flow">
      <div
        v-for="(stage, idx) in stages"
        :key="stage.key"
        :class="['chain-stage', { bottleneck: bottleneckStage === stage.key }]"
      >
        <div class="stage-header">
          <span class="stage-name">{{ $t(`aiChain.stages.${stage.key}`) }}</span>
          <span v-if="bottleneckStage === stage.key" class="bottleneck-tag">
            🔥 {{ $t('aiChain.currentBottleneck') }}
          </span>
        </div>
        <div class="stage-tickers">
          <span v-for="ticker in stage.tickers" :key="ticker" class="ticker-chip">{{ ticker }}</span>
        </div>
        <div v-if="idx < stages.length - 1" class="stage-arrow">↓</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { AI_CHAIN_STAGES } from '../data/aiChain.js';
import { api } from '../api/client.js';

const stages = AI_CHAIN_STAGES;
const bottleneckStage = ref(null);

onMounted(async () => {
  try {
    const data = await api.getBottleneck();
    bottleneckStage.value = data?.stage || null;
  } catch (e) {
    console.error('Failed to load bottleneck', e);
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

.stage-header { display: flex; justify-content: space-between; align-items: center; }
.stage-name { font-size: 13px; color: #ccc; font-weight: 600; }
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
</style>
