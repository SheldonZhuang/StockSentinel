<template>
  <div class="home-view">
    <!-- Hero：当前进攻/防守信号 + 解读 + 四维信号卡 -->
    <div class="hero-section panel">
      <div v-if="signalError" class="signal-error">
        <span>⚠️ {{ $t('error.fetchFailed') }}</span>
        <button class="retry-btn" @click="loadSignal">{{ $t('error.retry') }}</button>
      </div>
      <template v-else>
        <!-- 补更新提示（118号）：快照过点未更新，打开页面已自动触发后台补跑，轮询等新快照 -->
        <div v-if="catchingUp" class="catchup-banner">⏳ {{ $t('signal.catchUpBanner') }}</div>
        <SignalHero :signal="signal" />
      </template>
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

    <!-- 自选股（登录态专属）：未登录显示登录引导（125号：首页开放只读后信号区全公开，
         个人化功能仍需账号） -->
    <div v-if="authUser" class="panel">
      <WatchlistPanel />
    </div>
    <div v-else class="panel login-cta">
      <span>{{ $t('home.loginCta') }}</span>
      <router-link to="/login" class="cta-btn">{{ $t('auth.login') }}</router-link>
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
import { ref, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import SignalHero from '../components/SignalHero.vue';
import MacroPanel from '../components/MacroPanel.vue';
import WatchlistPanel from '../components/WatchlistPanel.vue';
import SignalTimeline from '../components/SignalTimeline.vue';
import AiChainPanel from '../components/AiChainPanel.vue';
import { api } from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';

const { locale } = useI18n();
const { user: authUser } = useAuthStore();

// /api/signal 只拉一次，下发给 Hero 与指标明细。
// 失败要有用户可见反馈（116号修复）：只 console.error 会让最核心的信号永远停在"加载中"
const signal = ref(null);
const signalError = ref(false);
const report = ref(null);
// 补更新（118号）：后端返回 catchUp 标志 = 快照过点未更新、已自动触发后台补跑，
// 前端轮询（30秒×10次）等新快照落库后自动刷新展示
const catchingUp = ref(false);
let pollTimer = null;
let pollTries = 0;

function stopCatchUpPolling(done = false) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (done) catchingUp.value = false;
}

function startCatchUpPolling() {
  if (pollTimer) return;
  catchingUp.value = true;
  pollTries = 0;
  pollTimer = setInterval(async () => {
    pollTries++;
    try {
      const res = await api.getSignal();
      if (res?.finalSignal) {
        signal.value = res;
        if (!res.catchUp) { stopCatchUpPolling(true); return; } // 新快照已生成
      }
    } catch { /* 轮询失败静默，下轮再试 */ }
    if (pollTries >= 10) stopCatchUpPolling(true); // 5分钟未完成则停（补跑失败会由运维告警兜底）
  }, 30000);
}

async function loadSignal() {
  signalError.value = false;
  try {
    const res = await api.getSignal();
    // 后端无快照时返回 {status:'loading'}（HTTP 200），视同加载中，否则维度卡会渲染出 undefined 的 i18n key
    signal.value = res?.finalSignal ? res : null;
    if (res?.catchUp) startCatchUpPolling();
  } catch (e) {
    console.error('Failed to load signal', e);
    signalError.value = true;
  }
}

onUnmounted(() => stopCatchUpPolling());

onMounted(async () => {
  await loadSignal();
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

.signal-error { display: flex; align-items: center; justify-content: center; gap: 12px; color: var(--text-2); font-size: var(--fs-md); padding: 12px 0; }
.catchup-banner {
  text-align: center; font-size: var(--fs-sm); color: var(--yellow);
  background: var(--yellow-bg); border: 1px solid var(--yellow-border);
  border-radius: 8px; padding: 8px 14px; margin-bottom: 14px;
}
.retry-btn {
  background: none; border: 1px solid var(--border-3); border-radius: 6px;
  color: var(--text-2); padding: 4px 12px; cursor: pointer; font-size: var(--fs-sm);
}
.retry-btn:hover { border-color: var(--text-3); }

.report-panel { padding: 16px 20px; }
.login-cta {
  display: flex; align-items: center; justify-content: center; gap: 14px;
  font-size: var(--fs-md); color: var(--text-3); padding: 18px 20px;
}
.cta-btn {
  background: var(--green-bg); color: var(--green); border: 1px solid var(--green-border);
  border-radius: 8px; padding: 6px 18px; text-decoration: none; font-weight: 600; font-size: var(--fs-sm);
}
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
