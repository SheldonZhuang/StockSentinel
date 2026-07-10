<template>
  <div class="timeline">
    <h3 class="title">{{ $t('timeline.title') }}</h3>
    <div v-if="loading" class="empty">{{ $t('signal.loading') }}</div>
    <div v-else-if="history.length === 0" class="empty">{{ $t('timeline.noHistory') }}</div>
    <div v-else class="entries">
      <div v-for="(item, i) in history" :key="item.id" :class="['entry', { changed: isChangePoint(i) }]">
        <div class="entry-dot-col">
          <div :class="['dot', item.final_signal, { big: isChangePoint(i) }]"></div>
          <div v-if="i < history.length - 1" class="line"></div>
        </div>
        <div class="entry-content">
          <div class="entry-date">
            {{ item.date }}
            <span v-if="isChangePoint(i)" class="change-tag">⚡ {{ $t('timeline.changed') }}</span>
          </div>
          <div :class="['entry-signal', item.final_signal]">
            {{ signalEmoji(item.final_signal) }} {{ $t(`signal.${item.final_signal}`) }}
          </div>
          <div class="entry-detail">
            {{ $t('signalPos.aiSupply') }}: {{ $t(`signalPos.${item.ai_supply_signal || 'neutral'}`) }} ·
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

// history 按日期降序：与时间上的前一天（i+1）不同 = 信号切换节点
function isChangePoint(i) {
  const next = history.value[i + 1];
  return !!next && history.value[i].final_signal !== next.final_signal;
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
.title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-5); margin: 0 0 16px 0; }
.empty { font-size: 13px; color: var(--text-4); }

.entries { display: flex; flex-direction: column; }
.entry { display: flex; gap: 12px; }

.entry-dot-col { display: flex; flex-direction: column; align-items: center; width: 16px; }
.dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin-top: 4px; }
.dot.big { width: 14px; height: 14px; margin-top: 2px; box-shadow: 0 0 6px var(--highlight); }
.dot.attack { background: var(--green); }
.dot.neutral { background: var(--yellow); }
.dot.defense { background: var(--red); }
.line { flex: 1; width: 1px; background: var(--border-2); min-height: 12px; margin: 2px 0; }

.change-tag {
  font-size: 10px;
  color: var(--yellow);
  border: 1px solid var(--yellow-border);
  border-radius: 4px;
  padding: 0 5px;
  margin-left: 6px;
}

.entry-content { padding-bottom: 12px; }
.entry-date { font-size: 11px; color: var(--text-5); }
.entry-signal { font-size: 14px; font-weight: 600; margin: 2px 0; }
.entry-signal.attack { color: var(--green); }
.entry-signal.neutral { color: var(--yellow); }
.entry-signal.defense { color: var(--red); }
.entry-detail { font-size: 11px; color: var(--text-5); }
</style>
