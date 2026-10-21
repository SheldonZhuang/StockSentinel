<template>
  <div class="research-panel">
    <!-- 研究文档采集（129号阶段1）：最近一次运行、每家公司×财季覆盖、数据质量问题 -->
    <section class="section">
      <div class="section-header">
        <h3>{{ $t('admin.research.title') }}</h3>
        <button class="key-btn" :disabled="starting || status?.running" @click="startIngest">
          {{ status?.running ? $t('admin.research.running') : $t('admin.research.run') }}
        </button>
      </div>
      <div v-if="loading" class="loading">{{ $t('signal.loading') }}</div>
      <div v-else-if="error" class="hint">✗ {{ error }}</div>
      <template v-else-if="status">
        <p v-if="!status.lastRun" class="hint">{{ $t('admin.research.never') }}</p>
        <p v-else class="hint">
          {{ $t('admin.research.lastRun', {
            at: status.lastRun.finished_at || status.lastRun.started_at,
            trigger: status.lastRun.trigger,
            newFilings: status.lastRun.new_filings,
            failed: status.lastRun.failed,
          }) }}
          · {{ $t('admin.research.totals', { filings: status.totals?.parsed ?? 0, chunks: status.totals?.chunks ?? 0 }) }}
        </p>

        <table v-if="coverageRows.length" class="key-table">
          <caption class="sr-only">{{ $t('admin.research.coverageCaption') }}</caption>
          <thead>
            <tr>
              <th scope="col">{{ $t('admin.research.colTicker') }}</th>
              <th v-for="q in quarterCols" :key="q" scope="col">{{ q }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in coverageRows" :key="row.ticker">
              <th scope="row">{{ row.ticker }}</th>
              <td v-for="(cell, i) in row.cells" :key="i" :class="['cov', cell.cls]" :title="cell.title">
                {{ cell.text }}
              </td>
            </tr>
          </tbody>
        </table>

        <h4 class="sub-title">{{ $t('admin.research.issues', { n: realIssues.length }) }}</h4>
        <p v-if="!realIssues.length" class="hint">{{ $t('admin.research.noIssues') }}</p>
        <table v-else class="key-table">
          <thead>
            <tr>
              <th scope="col">{{ $t('admin.research.colTicker') }}</th>
              <th scope="col">{{ $t('admin.research.colKind') }}</th>
              <th scope="col">{{ $t('admin.research.colDetail') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(i, k) in realIssues" :key="k">
              <td>{{ i.ticker || '—' }}</td>
              <td :class="['kind', i.kind]">{{ $te(`admin.research.kinds.${i.kind}`) ? $t(`admin.research.kinds.${i.kind}`) : i.kind }}</td>
              <td class="detail">{{ i.detail }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="pendingCount" class="hint">{{ $t('admin.research.pending', { n: pendingCount }) }}</p>

        <!-- LLM 预算（硬上限）与公司 Wiki 进度 -->
        <h4 class="sub-title">{{ $t('admin.research.budgetTitle') }}</h4>
        <p v-if="status.budget" class="hint">
          {{ $t('admin.research.budgetLine', {
            today: usd(status.budget.researchToday), daily: status.budget.budgets.research.daily,
            month: usd(status.budget.researchMonth), monthly: status.budget.budgets.research.monthly,
            ask: usd(status.budget.askMonth), askCap: status.budget.budgets.ask.monthly,
            backfill: usd(status.budget.backfillTotal), backfillCap: status.budget.budgets.backfill.total,
          }) }}
        </p>
        <table v-if="status.wiki?.length" class="key-table">
          <thead>
            <tr>
              <th scope="col">{{ $t('admin.research.colTicker') }}</th>
              <th scope="col">{{ $t('admin.research.colWikiDone') }}</th>
              <th scope="col">{{ $t('admin.research.colWikiBlocked') }}</th>
              <th scope="col">{{ $t('admin.research.colWikiEntries') }}</th>
              <th scope="col">{{ $t('admin.research.colWikiConflicts') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in status.wiki" :key="w.ticker">
              <td>{{ w.ticker }}</td>
              <td>{{ w.done }} / {{ w.filings }}</td>
              <td :class="{ 'cov bad': w.blocked > 0 }">{{ w.blocked }}</td>
              <td>{{ w.entries }}</td>
              <td>{{ w.conflicts }}</td>
            </tr>
          </tbody>
        </table>
      </template>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../api/client.js';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const status = ref(null);
const loading = ref(true);
const error = ref('');
const starting = ref(false);
let pollTimer = null;

// 文件类型 → 单元格缩写：E=财报新闻稿 Q=10-Q K=年报(10-K/20-F) F=TSM 季度合并财报
const KIND_ABBR = { earnings_release: 'E', periodic: 'Q', annual: 'K', ifrs_financials: 'F' };

// 覆盖矩阵：列为最近 8 个"财季序号"（各公司财年不同，按各自 FYxxxxQn 排列，列头只显示序号 −0…−7）
const quarterCols = computed(() => Array.from({ length: 8 }, (_, i) => (i === 0 ? t('admin.research.latest') : `−${i}`)));

const coverageRows = computed(() => {
  const byTicker = new Map();
  for (const f of status.value?.coverage || []) {
    if (!byTicker.has(f.ticker)) byTicker.set(f.ticker, new Map());
    const label = `FY${f.fiscal_year}Q${f.fiscal_quarter}`;
    const m = byTicker.get(f.ticker);
    if (!m.has(label)) m.set(label, []);
    m.get(label).push(f);
  }
  return [...byTicker.entries()].map(([ticker, m]) => {
    const labels = [...m.keys()].sort().reverse().slice(0, 8);
    const cells = labels.map(label => {
      const files = m.get(label);
      const failed = files.some(f => f.status === 'failed');
      return {
        text: `${label.slice(2)} ${files.filter(f => f.status === 'parsed').map(f => KIND_ABBR[f.doc_kind] || '?').sort().join('')}`,
        cls: failed ? 'bad' : 'ok',
        title: files.map(f => `${f.form_type} ${f.status} ${f.accession} (${f.chunk_count ?? 0} chunks)`).join('\n'),
      };
    });
    while (cells.length < 8) cells.push({ text: '—', cls: 'none', title: '' });
    return { ticker, cells };
  });
});

const usd = v => `$${Number(v || 0).toFixed(2)}`;

// pending_quarter（还没到该交的时候）不算问题，只计数
const realIssues = computed(() => (status.value?.issues || []).filter(i => i.kind !== 'pending_quarter'));
const pendingCount = computed(() => (status.value?.issues || []).length - realIssues.value.length);

async function load() {
  try {
    status.value = await api.adminResearchStatus();
    error.value = '';
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
  // 运行中每 5 秒刷新一次，结束即停
  clearTimeout(pollTimer);
  if (status.value?.running) pollTimer = setTimeout(load, 5000);
}

async function startIngest() {
  starting.value = true;
  try {
    await api.adminResearchIngest();
    if (status.value) status.value.running = true;
    pollTimer = setTimeout(load, 2000);
  } catch (e) {
    error.value = e.message;
  } finally {
    starting.value = false;
  }
}

onMounted(load);
onUnmounted(() => clearTimeout(pollTimer));
</script>

<style scoped>
.research-panel { max-width: 1100px; }
.section { background: var(--bg-card); border: 1px solid var(--border-2); border-radius: 10px; padding: 16px; margin-bottom: 16px; overflow-x: auto; }
.section h3 { font-size: var(--fs-lg); color: var(--text-3); margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.05em; }
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.section-header h3 { margin: 0; }
.sub-title { font-size: var(--fs-md); color: var(--text-3); margin: 16px 0 8px 0; }
.hint { font-size: var(--fs-sm); color: var(--text-4); margin: 0 0 10px 0; }
.loading { color: var(--text-4); font-size: var(--fs-sm); }
.key-btn { background: var(--bg-input); border: 1px solid var(--border-3); border-radius: 6px; color: var(--text-2); padding: 6px 14px; cursor: pointer; font-size: var(--fs-sm); }
.key-btn:hover:not(:disabled) { border-color: var(--blue); }
.key-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.key-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.key-table th, .key-table td { padding: 6px 8px; border-bottom: 1px solid var(--border-2); text-align: left; color: var(--text-2); white-space: nowrap; }
.key-table th { color: var(--text-3); font-weight: 600; }
.cov.bad, .kind.parse_failed, .kind.missing_quarter { color: var(--red); }
.cov.none { color: var(--text-4); }
.detail { white-space: normal; word-break: break-all; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
