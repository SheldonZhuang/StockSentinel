<template>
  <div class="home-view">
    <!-- Hero：当前进攻/防守信号 + 解读 + 四维信号卡 -->
    <div class="hero-section panel">
      <SignalHero :signal="signal" />
    </div>

    <!-- 主线区：AI产业链（长线看供需）+ 参考指标（短线看政策数据） -->
    <div class="main-grid">
      <div class="panel">
        <AiChainPanel />
      </div>
      <div class="panel">
        <MacroPanel :signal="signal" />
      </div>
    </div>

    <!-- 自选股 -->
    <div class="panel">
      <WatchlistPanel />
    </div>

    <!-- 信号历史时间轴 -->
    <div class="panel">
      <SignalTimeline />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import SignalHero from '../components/SignalHero.vue';
import MacroPanel from '../components/MacroPanel.vue';
import WatchlistPanel from '../components/WatchlistPanel.vue';
import SignalTimeline from '../components/SignalTimeline.vue';
import AiChainPanel from '../components/AiChainPanel.vue';
import { api } from '../api/client.js';

// /api/signal 只拉一次，下发给 Hero 与指标明细
const signal = ref(null);

onMounted(async () => {
  try {
    signal.value = await api.getSignal();
  } catch (e) {
    console.error('Failed to load signal', e);
  }
});
</script>

<style scoped>
.home-view { display: flex; flex-direction: column; gap: 20px; }

.panel {
  position: relative;
  background: linear-gradient(180deg, #101010, #0c0c0c);
  border: 1px solid #1e1e1e;
  border-radius: 14px;
  padding: 20px;
  overflow: hidden;
}
.panel::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
}

.hero-section { padding: 28px 20px; }

.main-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 20px;
  align-items: start;
}

@media (max-width: 900px) {
  .main-grid { grid-template-columns: 1fr; }
}
</style>
