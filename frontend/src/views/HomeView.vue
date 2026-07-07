<template>
  <div class="home-view">
    <div class="workbench">
      <!-- 左栏：宏观信号面板 -->
      <div class="left-col">
        <MacroPanel />
      </div>
      <!-- 右栏：自选股面板 -->
      <div class="right-col">
        <WatchlistPanel />
      </div>
    </div>
    <!-- AI产业链地图 -->
    <div class="ai-chain-section">
      <AiChainPanel />
    </div>
    <!-- 首页底部：信号历史时间轴 -->
    <div class="timeline-section">
      <SignalTimeline />
    </div>
  </div>
</template>

<script setup>
import MacroPanel from '../components/MacroPanel.vue';
import WatchlistPanel from '../components/WatchlistPanel.vue';
import SignalTimeline from '../components/SignalTimeline.vue';
import AiChainPanel from '../components/AiChainPanel.vue';
</script>

<style scoped>
.home-view { display: flex; flex-direction: column; gap: 32px; }

.workbench {
  display: grid;
  grid-template-columns: 340px 1fr;
  gap: 24px;
}

.left-col, .right-col {
  background: #0d0d0d;
  border: 1px solid #1e1e1e;
  border-radius: 14px;
  padding: 20px;
  min-height: 400px;
}

.ai-chain-section {
  background: #0d0d0d;
  border: 1px solid #1e1e1e;
  border-radius: 14px;
  padding: 20px;
}

.timeline-section {
  background: #0d0d0d;
  border: 1px solid #1e1e1e;
  border-radius: 14px;
  padding: 20px;
}

@media (max-width: 768px) {
  .workbench { grid-template-columns: 1fr; }
}
</style>
