<template>
  <div class="admin-panel">
    <h2>{{ $t('admin.title') }}</h2>

    <!-- 设定信号位 -->
    <section class="section">
      <h3>{{ $t('admin.setSignal') }}</h3>
      <form @submit.prevent="saveSignal" class="signal-form">
        <div class="form-row">
          <label>{{ $t('admin.type') }}</label>
          <select v-model="form.type" class="input">
            <option value="ai_supply">{{ $t('admin.aiSupply') }}</option>
            <option value="fiscal">{{ $t('admin.fiscal') }}</option>
            <option value="administrative">{{ $t('admin.administrative') }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>{{ $t('admin.signal') }}</label>
          <select v-model="form.signal" class="input">
            <option value="loose">{{ $t('signalPos.loose') }}</option>
            <option value="neutral">{{ $t('signalPos.neutral') }}</option>
            <option value="tight">{{ $t('signalPos.tight') }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>{{ $t('admin.expiresAt') }}</label>
          <input type="datetime-local" v-model="form.expiresAt" class="input" />
        </div>
        <div class="form-row">
          <label>{{ $t('admin.note') }}</label>
          <input v-model="form.note" class="input" type="text" />
        </div>
        <button type="submit" class="save-btn" :disabled="saving">{{ $t('admin.save') }}</button>
        <span v-if="saveMsg" class="save-msg">{{ saveMsg }}</span>
      </form>
    </section>

    <!-- 当前信号位状态 -->
    <section class="section">
      <h3>当前信号位</h3>
      <div v-if="currentSignals" class="current-signals">
        <div class="sig-row">
          <span>{{ $t('admin.aiSupply') }}</span>
          <span :class="['sig-badge', currentSignals.aiSupply]">{{ $t(`signalPos.${currentSignals.aiSupply}`) }}</span>
          <span v-if="currentSignals.aiSupplyMeta?.expires_at" class="expires">到期: {{ currentSignals.aiSupplyMeta.expires_at }}</span>
        </div>
        <div class="sig-row">
          <span>{{ $t('admin.fiscal') }}</span>
          <span :class="['sig-badge', currentSignals.fiscal]">{{ $t(`signalPos.${currentSignals.fiscal}`) }}</span>
          <span v-if="currentSignals.fiscalMeta?.expires_at" class="expires">到期: {{ currentSignals.fiscalMeta.expires_at }}</span>
        </div>
        <div class="sig-row">
          <span>{{ $t('admin.administrative') }}</span>
          <span :class="['sig-badge', currentSignals.administrative]">{{ $t(`signalPos.${currentSignals.administrative}`) }}</span>
          <span v-if="currentSignals.administrativeMeta?.expires_at" class="expires">到期: {{ currentSignals.administrativeMeta.expires_at }}</span>
        </div>
      </div>
    </section>

    <!-- 参考素材 -->
    <section class="section">
      <div class="section-header">
        <h3>{{ $t('admin.reference') }}</h3>
        <div class="ref-tabs">
          <button :class="['tab', refCategory === 'ai_supply' ? 'active' : '']" @click="loadRef('ai_supply')">{{ $t('admin.aiSupply') }}</button>
          <button :class="['tab', refCategory === 'fiscal' ? 'active' : '']" @click="loadRef('fiscal')">{{ $t('admin.fiscal') }}</button>
          <button :class="['tab', refCategory === 'administrative' ? 'active' : '']" @click="loadRef('administrative')">{{ $t('admin.administrative') }}</button>
        </div>
      </div>
      <div v-if="refLoading" class="loading">{{ $t('signal.loading') }}</div>
      <ul v-else class="ref-list">
        <li v-for="doc in refDocs" :key="doc.url" class="ref-item">
          <a :href="doc.url" target="_blank" class="ref-link">{{ doc.title }}</a>
          <span v-if="refCategory === 'ai_supply' && doc.type" class="ref-source">{{ doc.type }}</span>
          <span class="ref-date">{{ doc.date }}</span>
        </li>
        <li v-if="refDocs.length === 0" class="ref-empty">暂无数据</li>
      </ul>
    </section>

    <!-- 当前卡脖子环节 -->
    <section class="section">
      <h3>{{ $t('admin.bottleneck') }}</h3>
      <form @submit.prevent="saveBottleneckStage" class="signal-form">
        <div class="form-row">
          <label>{{ $t('admin.bottleneckStage') }}</label>
          <select v-model="bottleneckForm.stage" class="input">
            <option v-for="stage in bottleneckStages" :key="stage" :value="stage">
              {{ stage === 'auto' ? $t('admin.bottleneckAuto') : $t(`aiChain.stages.${stage}`) }}
            </option>
          </select>
        </div>
        <div class="form-row">
          <label>{{ $t('admin.note') }}</label>
          <input v-model="bottleneckForm.note" class="input" type="text" />
        </div>
        <button type="submit" class="save-btn" :disabled="bottleneckSaving">{{ $t('admin.bottleneckSave') }}</button>
        <span v-if="bottleneckMsg" class="save-msg">{{ bottleneckMsg }}</span>
      </form>
      <div v-if="currentBottleneck?.stage" class="current-signals">
        <div class="sig-row">
          <span>{{ $t('aiChain.currentBottleneck') }}</span>
          <span class="sig-badge loose">
            {{ $t(`aiChain.stages.${currentBottleneck.stage}`) }} ·
            {{ $t(currentBottleneck.source === 'manual' ? 'aiChain.sourceManual' : 'aiChain.sourceAuto') }}
          </span>
        </div>
      </div>
    </section>

    <!-- 设定历史 -->
    <section class="section">
      <h3>{{ $t('admin.history') }}</h3>
      <div v-if="history.length === 0" class="loading">暂无记录</div>
      <table v-else class="history-table">
        <thead>
          <tr><th>类型</th><th>档位</th><th>有效期</th><th>备注</th><th>时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="h in history" :key="h.id">
            <td>{{ h.type }}</td>
            <td :class="['sig-badge', h.signal]">{{ h.signal }}</td>
            <td>{{ h.expires_at || '—' }}</td>
            <td>{{ h.note || '—' }}</td>
            <td>{{ h.created_at }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api/client.js';

const form = ref({ type: 'ai_supply', signal: 'neutral', expiresAt: '', note: '' });
const saving = ref(false);
const saveMsg = ref('');
const currentSignals = ref(null);
const history = ref([]);
const refDocs = ref([]);
const refLoading = ref(false);
const refCategory = ref('ai_supply');

// 'auto' = 清除手动设定，回到按环节排名自动识别
const bottleneckStages = ['auto', 'model', 'cloud', 'chip', 'memory', 'packaging', 'power'];
const bottleneckForm = ref({ stage: 'packaging', note: '' });
const bottleneckSaving = ref(false);
const bottleneckMsg = ref('');
const currentBottleneck = ref(null);

async function saveSignal() {
  saving.value = true;
  saveMsg.value = '';
  try {
    await api.setAdminSignal(form.value.type, form.value.signal, form.value.expiresAt || null, form.value.note || null);
    saveMsg.value = '✓ 已保存';
    await loadData();
  } catch (e) {
    saveMsg.value = '✗ ' + e.message;
  } finally {
    saving.value = false;
  }
}

async function loadData() {
  const [signals, hist] = await Promise.all([
    api.getAdminSignals().catch(() => null),
    api.getAdminHistory().catch(() => []),
  ]);
  currentSignals.value = signals;
  history.value = hist;
}

async function saveBottleneckStage() {
  bottleneckSaving.value = true;
  bottleneckMsg.value = '';
  try {
    await api.setBottleneck(bottleneckForm.value.stage, bottleneckForm.value.note || null);
    bottleneckMsg.value = '✓ 已保存';
    currentBottleneck.value = await api.getBottleneck();
  } catch (e) {
    bottleneckMsg.value = '✗ ' + e.message;
  } finally {
    bottleneckSaving.value = false;
  }
}

async function loadRef(category) {
  refCategory.value = category;
  refLoading.value = true;
  refDocs.value = [];
  try {
    refDocs.value = await api.getReference(category);
  } catch (e) {
    console.error(e);
  } finally {
    refLoading.value = false;
  }
}

onMounted(async () => {
  await loadData();
  await loadRef('ai_supply');
  currentBottleneck.value = await api.getBottleneck().catch(() => null);
});
</script>

<style scoped>
.admin-panel { max-width: 800px; }
.admin-panel h2 { color: #eee; margin-bottom: 24px; }

.section { background: #111; border: 1px solid #222; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.section h3 { font-size: 14px; color: #aaa; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.05em; }

.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.section-header h3 { margin: 0; }

.signal-form { display: flex; flex-direction: column; gap: 10px; }
.form-row { display: flex; align-items: center; gap: 10px; }
.form-row label { width: 90px; font-size: 13px; color: #888; }
.input { flex: 1; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; color: #eee; padding: 7px 10px; font-size: 13px; }

.save-btn { background: #1e3a2f; color: #4ade80; border: 1px solid #2d5a3d; border-radius: 8px; padding: 8px 20px; cursor: pointer; font-weight: 600; width: fit-content; }
.save-msg { font-size: 13px; color: #aaa; }

.current-signals { display: flex; flex-direction: column; gap: 8px; }
.sig-row { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.expires { font-size: 11px; color: #666; }

.sig-badge { padding: 2px 8px; border-radius: 5px; font-weight: 600; font-size: 12px; }
.sig-badge.loose { background: #173a24; color: #4ade80; }
.sig-badge.neutral { background: #2a2a1a; color: #facc15; }
.sig-badge.tight { background: #3a1717; color: #f87171; }

.ref-tabs { display: flex; gap: 6px; }
.tab { background: #1a1a1a; border: 1px solid #333; border-radius: 5px; color: #888; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.tab.active { border-color: #555; color: #eee; }

.loading { font-size: 13px; color: #666; }

.ref-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow-y: auto; }
.ref-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.ref-link { font-size: 12px; color: #6b9eff; text-decoration: none; flex: 1; line-height: 1.4; }
.ref-link:hover { text-decoration: underline; }
.ref-date { font-size: 11px; color: #555; white-space: nowrap; }
.ref-source { font-size: 10px; color: #6b9eff; border: 1px solid #1e3a5a; border-radius: 4px; padding: 0 5px; white-space: nowrap; }
.ref-empty { font-size: 13px; color: #666; }

.history-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.history-table th { color: #666; font-weight: normal; padding: 6px 8px; text-align: left; border-bottom: 1px solid #222; }
.history-table td { color: #aaa; padding: 6px 8px; border-bottom: 1px solid #1a1a1a; }
</style>
