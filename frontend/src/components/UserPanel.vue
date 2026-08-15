<template>
  <div class="user-panel">
    <!-- 用户管理（123号）：列表+搜索+订阅/禁用编辑+行内用量详情 -->
    <section class="section">
      <div class="section-header">
        <h3>{{ $t('admin.users.title') }}</h3>
        <span class="total-hint">{{ $t('admin.users.total', { n: total }) }}</span>
      </div>
      <div class="toolbar">
        <input v-model="search" class="input search-input" :placeholder="$t('admin.users.searchPlaceholder')"
               @keyup.enter="loadUsers(1)" />
        <button class="key-btn" @click="loadUsers(1)">{{ $t('admin.users.search') }}</button>
      </div>
      <div v-if="loading" class="loading">{{ $t('signal.loading') }}</div>
      <table v-else-if="users.length" class="key-table">
        <thead>
          <tr>
            <th>{{ $t('admin.users.colEmail') }}</th>
            <th>{{ $t('admin.users.colRegistered') }}</th>
            <th>{{ $t('admin.users.colSubscription') }}</th>
            <th>{{ $t('admin.users.colRemaining') }}</th>
            <th>{{ $t('admin.users.colQuotaToday') }}</th>
            <th>{{ $t('admin.users.colCalls7d') }}</th>
            <th>{{ $t('admin.users.colCalls30d') }}</th>
            <th>{{ $t('admin.users.colCallsTotal') }}</th>
            <th>{{ $t('admin.users.colLastCall') }}</th>
            <th>{{ $t('admin.users.colKeys') }}</th>
            <th>{{ $t('admin.users.colStatus') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="u in users" :key="u.id">
            <tr :class="{ 'row-disabled': u.disabled }">
              <td>{{ u.email }}</td>
              <td class="num">{{ (u.created_at || '').slice(0, 10) }}</td>
              <td>
                <span :class="['sig-badge', subBadgeClass(u)]">{{ subLabel(u) }}</span>
              </td>
              <td class="num" :class="remainingClass(u)">{{ remainingLabel(u) }}</td>
              <td class="num">{{ quotaTodayLabel(u) }}</td>
              <td class="num">{{ u.total_7d }}</td>
              <td class="num">{{ u.total_30d }}</td>
              <!-- 总量口径（125号审查#5）：开放API底账(400天,已含近30天v1/mcp) + web明细——
                   直接加 total_30d 会把近30天的 v1/mcp 双计 -->
              <td class="num">{{ u.api_total_alltime + u.web_30d }}</td>
              <td class="num">{{ u.last_call_at || '—' }}</td>
              <td class="num">{{ u.key_count }}</td>
              <td>{{ u.disabled ? $t('admin.users.disabled') : $t('admin.users.active') }}</td>
              <td class="actions">
                <button class="key-btn small" @click="toggleExpand(u)">
                  {{ expandedId === u.id ? $t('admin.users.collapse') : $t('admin.users.detail') }}
                </button>
                <button class="key-btn small" @click="openEdit(u)">{{ $t('admin.users.edit') }}</button>
                <!-- 自锁防护（125号审查#10）：管理员对自己不显示禁用按钮（后端同拒 403） -->
                <button v-if="u.id !== authUser?.id" class="key-btn small" :class="{ danger: !u.disabled }" @click="toggleDisabled(u)">
                  {{ u.disabled ? $t('admin.users.enable') : $t('admin.users.disable') }}
                </button>
              </td>
            </tr>
            <!-- 编辑行 -->
            <tr v-if="editId === u.id">
              <td colspan="12" class="edit-cell">
                <div class="edit-form">
                  <label>{{ $t('admin.users.subscriptionExpires') }}</label>
                  <input type="datetime-local" v-model="editExpiresAt" class="input" />
                  <label class="checkbox-label">
                    <input type="checkbox" v-model="editSubscribed" /> {{ $t('admin.users.isSubscribed') }}
                  </label>
                  <button class="key-btn" @click="saveEdit(u)">{{ $t('admin.save') }}</button>
                  <button class="key-btn" @click="editId = null">{{ $t('admin.users.cancel') }}</button>
                  <span v-if="editMsg" class="save-msg">{{ editMsg }}</span>
                </div>
              </td>
            </tr>
            <!-- 用量详情展开行 -->
            <tr v-if="expandedId === u.id">
              <td colspan="12" class="detail-cell">
                <div class="detail-toolbar">
                  <div class="ref-tabs">
                    <button v-for="d in [7, 30]" :key="d" :class="['tab', detailDays === d ? 'active' : '']"
                            @click="detailDays = d; loadDetail(u)">{{ $t('admin.users.lastNDays', { n: d }) }}</button>
                  </div>
                  <div class="ref-tabs">
                    <button v-for="ch in ['', 'web', 'v1', 'mcp']" :key="ch"
                            :class="['tab', detailChannel === ch ? 'active' : '']"
                            @click="detailChannel = ch; loadDetail(u)">
                      {{ ch === '' ? $t('admin.users.allChannels') : ch }}
                    </button>
                  </div>
                </div>
                <div v-if="detailLoading" class="loading">{{ $t('signal.loading') }}</div>
                <template v-else-if="detail">
                  <!-- 按日调用量 -->
                  <div class="detail-block">
                    <h4>{{ $t('admin.users.dailyCalls') }}（{{ $t('admin.users.totalCalls', { n: detail.total }) }}）</h4>
                    <div class="bar-chart">
                      <div v-for="d in dailyMerged" :key="d.day" class="bar-col" :title="`${d.day}: ${d.count}`">
                        <div class="bar" :style="{ height: barHeight(d.count) }"></div>
                        <span class="bar-label">{{ d.day.slice(5) }}</span>
                      </div>
                      <span v-if="!dailyMerged.length" class="ref-empty">{{ $t('admin.noData') }}</span>
                    </div>
                  </div>
                  <!-- 端点 TOP -->
                  <div class="detail-block">
                    <h4>{{ $t('admin.users.topEndpoints') }}</h4>
                    <table class="history-table" v-if="detail.endpoints.length">
                      <thead><tr><th>{{ $t('admin.users.colEndpoint') }}</th><th>{{ $t('admin.users.colChannel') }}</th><th>{{ $t('admin.users.colCount') }}</th><th>{{ $t('admin.users.colLastCall') }}</th></tr></thead>
                      <tbody>
                        <tr v-for="e in detail.endpoints" :key="e.endpoint + e.channel">
                          <td class="key-code">{{ e.endpoint }}</td><td>{{ e.channel }}</td>
                          <td class="num">{{ e.count }}</td><td class="num">{{ e.last_call }}</td>
                        </tr>
                      </tbody>
                    </table>
                    <span v-else class="ref-empty">{{ $t('admin.noData') }}</span>
                  </div>
                  <!-- 明细日志 -->
                  <div class="detail-block">
                    <h4>{{ $t('admin.users.callLog') }}</h4>
                    <table class="history-table" v-if="detail.logs.length">
                      <thead><tr><th>{{ $t('admin.colTime') }}</th><th>{{ $t('admin.users.colChannel') }}</th><th>{{ $t('admin.users.colEndpoint') }}</th><th>{{ $t('admin.users.colStatusCode') }}</th></tr></thead>
                      <tbody>
                        <tr v-for="(l, i) in detail.logs" :key="i">
                          <td class="num">{{ l.ts }}</td><td>{{ l.channel }}</td>
                          <td class="key-code">{{ l.endpoint }}</td>
                          <td class="num" :class="{ 'status-err': l.status >= 400 }">{{ l.status }}</td>
                        </tr>
                      </tbody>
                    </table>
                    <span v-else class="ref-empty">{{ $t('admin.noData') }}</span>
                  </div>
                </template>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <div v-else class="loading">{{ $t('admin.noRecords') }}</div>
      <div class="pager" v-if="total > pageSize">
        <button class="key-btn small" :disabled="page <= 1" @click="loadUsers(page - 1)">‹</button>
        <span class="num">{{ page }} / {{ Math.ceil(total / pageSize) }}</span>
        <button class="key-btn small" :disabled="page >= Math.ceil(total / pageSize)" @click="loadUsers(page + 1)">›</button>
      </div>
    </section>

    <!-- 全局功能热度（资源投放依据） -->
    <section class="section">
      <div class="section-header">
        <h3>{{ $t('admin.users.endpointStats') }}</h3>
        <div class="ref-tabs">
          <button v-for="d in [7, 30]" :key="d" :class="['tab', statsDays === d ? 'active' : '']"
                  @click="statsDays = d; loadStats()">{{ $t('admin.users.lastNDays', { n: d }) }}</button>
        </div>
      </div>
      <p class="hint">{{ $t('admin.users.endpointStatsHint') }}</p>
      <table class="history-table" v-if="endpointStats.length">
        <thead>
          <tr>
            <th>{{ $t('admin.users.colEndpoint') }}</th><th>{{ $t('admin.users.colChannel') }}</th>
            <th>{{ $t('admin.users.colCount') }}</th><th>{{ $t('admin.users.colUsers') }}</th>
            <th>{{ $t('admin.users.colIdentifiers') }}</th><th>{{ $t('admin.users.colLastCall') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in endpointStats" :key="e.endpoint + e.channel">
            <td class="key-code">{{ e.endpoint }}</td><td>{{ e.channel }}</td>
            <td class="num">{{ e.count }}</td><td class="num">{{ e.user_count }}</td>
            <td class="num">{{ e.identifier_count }}</td><td class="num">{{ e.last_call }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="loading">{{ $t('admin.noData') }}</div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api/client.js';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth.js';

const { t } = useI18n();
const { user: authUser } = useAuthStore();

const users = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(50);
const search = ref('');
const loading = ref(false);

// 与后端 TIER_DAILY_LIMITS 同值仅作展示（权威值在 public.js，429 响应会给真实上限）
const TIER_LIMITS = { free: 250, pro: 10000 };

async function loadUsers(p = 1) {
  loading.value = true;
  try {
    const res = await api.adminListUsers(search.value.trim(), p);
    users.value = res.users;
    total.value = res.total;
    page.value = res.page;
    pageSize.value = res.pageSize;
  } catch (e) {
    console.error(e);
  } finally {
    loading.value = false;
  }
}

function subLabel(u) {
  if (u.subscription_active) return t('admin.users.subActive');
  if (u.is_subscribed) return t('admin.users.subExpired');
  return t('admin.users.subFree');
}
function subBadgeClass(u) {
  if (u.subscription_active) return 'loose';
  if (u.is_subscribed) return 'tight';
  return 'neutral';
}
function remainingDays(u) {
  if (!u.subscription_active || !u.subscription_expires_at) return null;
  // 'T' 分隔为 ISO 标准格式：空格分隔串 V8 恰好宽容但 Safari 解析为 NaN
  return Math.ceil((Date.parse(u.subscription_expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 86400000);
}
function remainingLabel(u) {
  if (!u.subscription_active) return u.is_subscribed ? t('admin.users.expired') : '—';
  if (!u.subscription_expires_at) return t('admin.users.noExpiry');
  return t('admin.users.daysLeft', { n: remainingDays(u) });
}
function remainingClass(u) {
  if (u.is_subscribed && !u.subscription_active) return 'warn-red';
  const d = remainingDays(u);
  if (d !== null && d <= 7) return 'warn-orange';
  return '';
}
function quotaTodayLabel(u) {
  if (!u.effective_tier) return '—';
  const limit = TIER_LIMITS[u.effective_tier];
  return `${u.api_today}/${limit}`;
}

// --- 启用/禁用 ---
async function toggleDisabled(u) {
  const action = u.disabled ? t('admin.users.enable') : t('admin.users.disable');
  if (!confirm(`${action}: ${u.email}?`)) return;
  try {
    await api.adminUpdateUser(u.id, { disabled: !u.disabled });
    await loadUsers(page.value);
  } catch (e) { alert(e.message); }
}

// --- 编辑订阅 ---
const editId = ref(null);
const editExpiresAt = ref('');
const editSubscribed = ref(false);
const editMsg = ref('');

function openEdit(u) {
  editId.value = editId.value === u.id ? null : u.id;
  editMsg.value = '';
  editSubscribed.value = !!u.is_subscribed;
  // 时区往返闭合（125号审查#3）：库值是 UTC 墙钟，datetime-local 显示/回收的是本地墙钟。
  // 旧写法 toISOString().slice(0,16) 填入的是 UTC 墙钟 → 保存时被 toUtcIso 再按本地转 UTC，
  // 每次保存漂移一个时区偏移（UTC+8 实测 -8h）。先减 getTimezoneOffset 得本地墙钟再截串
  if (u.subscription_expires_at) {
    const d = new Date(u.subscription_expires_at.replace(' ', 'T') + 'Z');
    editExpiresAt.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  } else {
    editExpiresAt.value = '';
  }
}

function toUtcIso(local) {
  if (!local) return null;
  const d = new Date(local);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function saveEdit(u) {
  editMsg.value = '';
  try {
    await api.adminUpdateUser(u.id, {
      subscribed: editSubscribed.value,
      subscriptionExpiresAt: toUtcIso(editExpiresAt.value),
    });
    editMsg.value = t('admin.savedMsg');
    editId.value = null;
    await loadUsers(page.value);
  } catch (e) {
    editMsg.value = '✗ ' + e.message;
  }
}

// --- 用量详情 ---
const expandedId = ref(null);
const detail = ref(null);
const detailDays = ref(30);
const detailChannel = ref('');
const detailLoading = ref(false);
let detailSeq = 0; // 请求序号守卫（同 AdminPanel refSeq 模式）：快速切换筛选时只采纳最后一次

function toggleExpand(u) {
  if (expandedId.value === u.id) { expandedId.value = null; return; }
  expandedId.value = u.id;
  detail.value = null;
  loadDetail(u);
}

async function loadDetail(u) {
  const seq = ++detailSeq;
  detailLoading.value = true;
  try {
    const res = await api.adminUserUsage(u.id, { days: detailDays.value, channel: detailChannel.value });
    if (seq !== detailSeq) return;
    detail.value = res;
  } catch (e) {
    console.error(e);
  } finally {
    if (seq === detailSeq) detailLoading.value = false;
  }
}

const dailyMerged = computed(() => {
  if (!detail.value) return [];
  const byDay = new Map();
  for (const d of detail.value.daily) {
    byDay.set(d.day, (byDay.get(d.day) || 0) + d.count);
  }
  return [...byDay.entries()].map(([day, count]) => ({ day, count }));
});

function barHeight(count) {
  const max = Math.max(...dailyMerged.value.map(d => d.count), 1);
  return `${Math.max(4, Math.round((count / max) * 60))}px`;
}

// --- 全局功能热度 ---
const endpointStats = ref([]);
const statsDays = ref(30);

async function loadStats() {
  try { endpointStats.value = await api.adminEndpointStats(statsDays.value); }
  catch (e) { console.error(e); }
}

onMounted(() => {
  loadUsers(1);
  loadStats();
});
</script>

<style scoped>
.user-panel { max-width: 1100px; }

.section { background: var(--bg-card); border: 1px solid var(--border-2); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.section h3 { font-size: var(--fs-lg); color: var(--text-3); margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.05em; }
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.section-header h3 { margin: 0; }
.total-hint { font-size: var(--fs-sm); color: var(--text-4); }
.hint { font-size: var(--fs-sm); color: var(--text-4); margin: 0 0 10px 0; }

.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
.input { background: var(--bg-input); border: 1px solid var(--border-3); border-radius: 6px; color: var(--text-1); padding: 7px 10px; font-size: var(--fs-md); }
.search-input { flex: 1; max-width: 320px; }

.key-btn { background: var(--bg-input); border: 1px solid var(--border-3); border-radius: 6px; color: var(--text-2); padding: 6px 14px; cursor: pointer; font-size: var(--fs-sm); }
.key-btn:hover { border-color: var(--blue); }
.key-btn:disabled { opacity: 0.4; cursor: default; }
.key-btn.small { padding: 2px 10px; font-size: var(--fs-xs); }
.key-btn.danger:hover { border-color: var(--red); color: var(--red); }

.key-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.key-table th { text-align: left; color: var(--text-4); font-size: var(--fs-xs); padding: 4px 8px; border-bottom: 1px solid var(--border-2); white-space: nowrap; }
.key-table td { padding: 4px 8px; border-bottom: 1px solid var(--border-1); color: var(--text-2); }
.row-disabled td { opacity: 0.5; }
.num { font-family: var(--font-num); font-size: var(--fs-xs); white-space: nowrap; }
.actions { display: flex; gap: 4px; white-space: nowrap; }
.key-code { font-family: var(--font-num); font-size: var(--fs-xs); }

.sig-badge { padding: 2px 8px; border-radius: 6px; font-weight: 600; font-size: var(--fs-xs); white-space: nowrap; }
.sig-badge.loose { background: var(--green-bg); color: var(--green); }
.sig-badge.neutral { background: var(--yellow-bg); color: var(--yellow); }
.sig-badge.tight { background: var(--red-bg); color: var(--red); }

.warn-red { color: var(--red); }
.warn-orange { color: var(--orange); }
.status-err { color: var(--red); }

.edit-cell, .detail-cell { background: var(--bg-input); }
.edit-form { display: flex; align-items: center; gap: 10px; padding: 8px; flex-wrap: wrap; }
.edit-form label { font-size: var(--fs-sm); color: var(--text-3); }
.checkbox-label { display: flex; align-items: center; gap: 4px; }
.save-msg { font-size: var(--fs-sm); color: var(--text-3); }

.detail-cell { padding: 12px !important; }
.detail-toolbar { display: flex; gap: 16px; margin-bottom: 10px; flex-wrap: wrap; }
.ref-tabs { display: flex; gap: 6px; }
.tab { background: var(--bg-input); border: 1px solid var(--border-3); border-radius: 5px; color: var(--text-3); padding: 4px 10px; font-size: var(--fs-sm); cursor: pointer; }
.tab.active { border-color: var(--border-focus); color: var(--text-1); }

.detail-block { margin-bottom: 14px; }
.detail-block h4 { font-size: var(--fs-sm); color: var(--text-3); margin: 0 0 6px 0; }

.bar-chart { display: flex; align-items: flex-end; gap: 3px; min-height: 76px; overflow-x: auto; padding-bottom: 4px; }
.bar-col { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.bar { width: 16px; background: var(--blue); border-radius: 2px 2px 0 0; opacity: 0.75; }
.bar-label { font-size: 9px; color: var(--text-5); font-family: var(--font-num); }

.history-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.history-table th { color: var(--text-4); font-weight: normal; padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border-2); }
.history-table td { color: var(--text-3); padding: 6px 8px; border-bottom: 1px solid var(--border-1); }

.loading, .ref-empty { font-size: var(--fs-md); color: var(--text-4); }
.pager { display: flex; align-items: center; gap: 10px; margin-top: 10px; justify-content: center; color: var(--text-3); }
</style>
