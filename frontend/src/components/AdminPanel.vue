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

    <!-- 衰退防守锁定应急清除 -->
    <section class="section">
      <h3>{{ $t('recessionLock.banner') }}</h3>
      <p class="lock-note">{{ $t('admin.lockOverrideNote') }}</p>
      <form @submit.prevent="clearLock" class="signal-form">
        <div class="form-row">
          <label>{{ $t('admin.type') }}</label>
          <select v-model="lockForm.type" class="input">
            <option value="sahmLock">{{ $t('admin.clearSahmLock') }}</option>
            <option value="reactiveAdjustmentLock">{{ $t('admin.clearReactiveLock') }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>{{ $t('admin.expiresAt') }}</label>
          <input type="datetime-local" v-model="lockForm.expiresAt" class="input" />
        </div>
        <div class="form-row">
          <label>{{ $t('admin.note') }}</label>
          <input v-model="lockForm.note" class="input" type="text" />
        </div>
        <button type="submit" class="save-btn" :disabled="lockSaving">{{ $t('admin.clearLock') }}</button>
        <span v-if="lockMsg" class="save-msg">{{ lockMsg }}</span>
      </form>
    </section>

    <!-- 当前信号位状态 -->
    <section class="section">
      <h3>{{ $t('admin.currentSignals') }}</h3>
      <div v-if="currentSignals" class="current-signals">
        <div class="sig-row">
          <span>{{ $t('admin.aiSupply') }}</span>
          <span :class="['sig-badge', currentSignals.aiSupply]">{{ $t(`signalPos.${currentSignals.aiSupply}`) }}</span>
          <span v-if="currentSignals.aiSupplyMeta?.expires_at" class="expires">{{ $t('admin.expiresLabel') }}: {{ currentSignals.aiSupplyMeta.expires_at }}</span>
        </div>
        <div class="sig-row">
          <span>{{ $t('admin.fiscal') }}</span>
          <span :class="['sig-badge', currentSignals.fiscal]">{{ $t(`signalPos.${currentSignals.fiscal}`) }}</span>
          <span v-if="currentSignals.fiscalMeta?.expires_at" class="expires">{{ $t('admin.expiresLabel') }}: {{ currentSignals.fiscalMeta.expires_at }}</span>
        </div>
        <div class="sig-row">
          <span>{{ $t('admin.administrative') }}</span>
          <span :class="['sig-badge', currentSignals.administrative]">{{ $t(`signalPos.${currentSignals.administrative}`) }}</span>
          <span v-if="currentSignals.administrativeMeta?.expires_at" class="expires">{{ $t('admin.expiresLabel') }}: {{ currentSignals.administrativeMeta.expires_at }}</span>
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
        <li v-if="refDocs.length === 0" class="ref-empty">{{ $t('admin.noData') }}</li>
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
      <div v-if="history.length === 0" class="loading">{{ $t('admin.noRecords') }}</div>
      <table v-else class="history-table">
        <thead>
          <tr><th>{{ $t('admin.colType') }}</th><th>{{ $t('admin.colSignal') }}</th><th>{{ $t('admin.colExpires') }}</th><th>{{ $t('admin.colNote') }}</th><th>{{ $t('admin.colTime') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="h in history" :key="h.id">
            <td>{{ $te(`admin.typeNames.${h.type}`) ? $t(`admin.typeNames.${h.type}`) : h.type }}</td>
            <td :class="['sig-badge', h.signal]">{{ h.signal === 'cleared' ? $t('admin.signalCleared') : $t(`signalPos.${h.signal}`) }}</td>
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
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const form = ref({ type: 'ai_supply', signal: 'neutral', expiresAt: '', note: '' });
const saving = ref(false);
const saveMsg = ref('');
const lockForm = ref({ type: 'sahmLock', expiresAt: '', note: '' });
const lockSaving = ref(false);
const lockMsg = ref('');
const currentSignals = ref(null);
const history = ref([]);
const refDocs = ref([]);
const refLoading = ref(false);
const refCategory = ref('ai_supply');

// 'auto' = 清除手动设定，回到按环节排名自动识别
const bottleneckStages = ['auto', 'model', 'cloud', 'chip', 'memory', 'optical', 'packaging', 'power'];
const bottleneckForm = ref({ stage: 'packaging', note: '' });
const bottleneckSaving = ref(false);
const bottleneckMsg = ref('');
const currentBottleneck = ref(null);

// datetime-local 产出无时区的本地时间串，直接入库会被后端按 UTC 比较导致过期判定漂移；
// 在浏览器侧（知道用户真实时区）先转成 UTC ISO
function toUtcIso(local) {
  if (!local) return null;
  const d = new Date(local);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function saveSignal() {
  saving.value = true;
  saveMsg.value = '';
  try {
    await api.setAdminSignal(form.value.type, form.value.signal, toUtcIso(form.value.expiresAt), form.value.note || null);
    saveMsg.value = t('admin.savedMsg');
    await loadData();
  } catch (e) {
    saveMsg.value = '✗ ' + e.message;
  } finally {
    saving.value = false;
  }
}

async function clearLock() {
  lockSaving.value = true;
  lockMsg.value = '';
  try {
    await api.setLockOverride(lockForm.value.type, toUtcIso(lockForm.value.expiresAt), lockForm.value.note || null);
    lockMsg.value = t('admin.clearedMsg');
  } catch (e) {
    lockMsg.value = '✗ ' + e.message;
  } finally {
    lockSaving.value = false;
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
    bottleneckMsg.value = t('admin.savedMsg');
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
.admin-panel h2 { color: var(--text-1); margin-bottom: 24px; }

.section { background: var(--bg-card); border: 1px solid var(--border-2); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.section h3 { font-size: var(--fs-lg); color: var(--text-3); margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.05em; }

.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.section-header h3 { margin: 0; }

.lock-note { font-size: var(--fs-sm); color: var(--text-4); margin: 0 0 10px 0; }
.signal-form { display: flex; flex-direction: column; gap: 10px; }
.form-row { display: flex; align-items: center; gap: 10px; }
.form-row label { width: 90px; font-size: var(--fs-md); color: var(--text-3); }
.input { flex: 1; background: var(--bg-input); border: 1px solid var(--border-3); border-radius: 6px; color: var(--text-1); padding: 7px 10px; font-size: var(--fs-md); }

.save-btn { background: var(--green-bg); color: var(--green); border: 1px solid var(--green-border); border-radius: 8px; padding: 8px 20px; cursor: pointer; font-weight: 600; width: fit-content; }
.save-msg { font-size: var(--fs-md); color: var(--text-3); }

.current-signals { display: flex; flex-direction: column; gap: 8px; }
.sig-row { display: flex; align-items: center; gap: 10px; font-size: var(--fs-md); }
.expires { font-size: var(--fs-xs); color: var(--text-4); }

.sig-badge { padding: 2px 8px; border-radius: 6px; font-weight: 600; font-size: var(--fs-sm); }
.sig-badge.loose { background: var(--green-bg); color: var(--green); }
.sig-badge.neutral { background: var(--yellow-bg); color: var(--yellow); }
.sig-badge.tight { background: var(--red-bg); color: var(--red); }

.ref-tabs { display: flex; gap: 6px; }
.tab { background: var(--bg-input); border: 1px solid var(--border-3); border-radius: 5px; color: var(--text-3); padding: 4px 10px; font-size: var(--fs-sm); cursor: pointer; }
.tab.active { border-color: var(--border-focus); color: var(--text-1); }

.loading { font-size: var(--fs-md); color: var(--text-4); }

.ref-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow-y: auto; }
.ref-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.ref-link { font-size: var(--fs-sm); color: var(--blue); text-decoration: none; flex: 1; line-height: 1.4; }
.ref-link:hover { text-decoration: underline; }
.ref-date { font-size: var(--fs-xs); color: var(--text-4); white-space: nowrap; }
.ref-source { font-size: var(--fs-xs); color: var(--blue); border: 1px solid var(--blue-border); border-radius: 4px; padding: 0 5px; white-space: nowrap; }
.ref-empty { font-size: var(--fs-md); color: var(--text-4); }

.history-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.history-table th { color: var(--text-4); font-weight: normal; padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border-2); }
.history-table td { color: var(--text-3); padding: 6px 8px; border-bottom: 1px solid var(--border-1); }
</style>
