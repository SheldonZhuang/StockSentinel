<template>
  <div class="home-view">
    <!-- Hero：当前进攻/防守信号 + 解读 + 四维信号卡 -->
    <div class="hero-section panel">
      <SignalHero :signal="signal" />
    </div>

    <!-- AI 日报：LLM 基于当日快照生成的双语解读 -->
    <div v-if="report" class="panel report-panel">
      <div class="section-title">🤖 {{ $t('dailyReport.title') }} · {{ report.date }}</div>
      <p class="report-text">{{ locale === 'zh' ? report.zh : report.en }}</p>
    </div>

    <!-- 主线区：左列 AI产业链+信号历史（长线看供需）+ 右列参考指标（短线看政策数据）
         信号历史放左列填充两列高度差，避免左下大片空白 -->
    <div class="main-grid">
      <div class="main-col">
        <div class="panel">
          <AiChainPanel />
        </div>
        <div class="panel">
          <SignalTimeline />
        </div>
      </div>
      <div class="panel">
        <MacroPanel :signal="signal" />
      </div>
    </div>

    <!-- 自选股 -->
    <div class="panel">
      <WatchlistPanel />
    </div>

    <!-- 页脚：数据源与免责声明 -->
    <footer class="page-footer">
      <span>{{ $t('footer.sources') }}</span>
      <span class="footer-divider">·</span>
      <span>{{ $t('footer.disclaimer') }}</span>
    </footer>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import SignalHero from '../components/SignalHero.vue';
import MacroPanel from '../components/MacroPanel.vue';
import WatchlistPanel from '../components/WatchlistPanel.vue';
import SignalTimeline from '../components/SignalTimeline.vue';
import AiChainPanel from '../components/AiChainPanel.vue';
import { api } from '../api/client.js';

const { locale } = useI18n();

// /api/signal 只拉一次，下发给 Hero 与指标明细
const signal = ref(null);
const report = ref(null);

onMounted(async () => {
  try {
    const res = await api.getSignal();
    // 后端无快照时返回 {status:'loading'}（HTTP 200），视同加载中，否则维度卡会渲染出 undefined 的 i18n key
    signal.value = res?.finalSignal ? res : null;
  } catch (e) {
    console.error('Failed to load signal', e);
  }
  try {
    const r = await api.getDailyReport();
    if (r?.date) report.value = r;
  } catch { /* 日报是增值内容，失败不打扰 */ }
});
</script>

<style scoped>
.home-view { display: flex; flex-direction: column; gap: 20px; }

.panel {
  position: relative;
  background: linear-gradient(180deg, var(--panel-a), var(--panel-b));
  border: 1px solid var(--border-2);
  border-radius: 14px;
  padding: 20px;
  overflow: hidden;
}
.panel::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--highlight), transparent);
}

.hero-section { padding: 28px 20px; }

.report-panel { padding: 16px 20px; }
.report-panel .section-title { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-4); margin-bottom: 8px; }
.report-text { margin: 0; font-size: var(--fs-md); color: var(--text-2); line-height: 1.7; }

.main-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 20px;
  align-items: start;
}

.main-col { display: flex; flex-direction: column; gap: 20px; }

.page-footer {
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-4);
  padding: 8px 0 16px;
  display: flex;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}
.footer-divider { color: var(--text-5); }

@media (max-width: 900px) {
  .main-grid { grid-template-columns: 1fr; }
}
</style>
