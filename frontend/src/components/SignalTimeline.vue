<template>
  <div class="timeline">
    <h3 class="title">{{ $t('timeline.title') }}</h3>
    <div v-if="loading" class="empty">{{ $t('signal.loading') }}</div>
    <div v-else-if="history.length === 0" class="empty">{{ $t('timeline.noHistory') }}</div>
    <div v-else class="entries">
      <div v-for="(item, i) in history" :key="item.id" class="entry">
        <div class="entry-dot-col">
          <div :class="['dot', item.final_signal]"></div>
          <div v-if="i < history.length - 1" class="line"></div>
        </div>
        <div class="entry-content">
          <div class="entry-date">{{ item.date }}</div>
          <div :class="['entry-signal', item.final_signal]">
            {{ signalEmoji(item.final_signal) }} {{ $t(`signal.${item.final_signal}`) }}
          </div>
          <div class="entry-detail">
            {{ $t('signalPos.monetary') }}: {{ $t(`signalPos.${item.monetary_signal}`) }} ·
            {{ $t('signalPos.fiscal') }}: {{ $t(`signalPos.${item.fiscal_signal}`) }} ·
            {{ $t('signalPos.administrative') }}: {{ $t(`signalPos.${item.admin_signal}`) }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api/client.js';

const history = ref([]);
const loading = ref(true);

function signalEmoji(s) {
  return s === 'attack' ? '🟢' : s === 'defense' ? '🔴' : '🟡';
}

onMounted(async () => {
  try {
    const data = await api.getSignalHistory(90);
    history.value = data;
  } catch (e) {
    console.error(e);
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.timeline { padding: 0; }
.title { font-size: 14px; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 16px 0; }
.empty { font-size: 13px; color: #666; }

.entries { display: flex; flex-direction: column; }
.entry { display: flex; gap: 12px; }

.entry-dot-col { display: flex; flex-direction: column; align-items: center; width: 16px; }
.dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin-top: 4px; }
.dot.attack { background: #4ade80; }
.dot.neutral { background: #facc15; }
.dot.defense { background: #f87171; }
.line { flex: 1; width: 1px; background: #222; min-height: 12px; margin: 2px 0; }

.entry-content { padding-bottom: 12px; }
.entry-date { font-size: 11px; color: #555; }
.entry-signal { font-size: 14px; font-weight: 600; margin: 2px 0; }
.entry-signal.attack { color: #4ade80; }
.entry-signal.neutral { color: #facc15; }
.entry-signal.defense { color: #f87171; }
.entry-detail { font-size: 11px; color: #555; }
</style>
