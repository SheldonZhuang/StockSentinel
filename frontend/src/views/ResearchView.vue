<template>
  <div class="research-view">
    <!-- 公司研究笔记（129号阶段5）：公开只读。公司 → 季度 → 笔记；每条陈述可展开出处，点链接跳 SEC 原文 -->
    <header class="head">
      <h1>{{ $t('research.title') }}</h1>
      <p class="sub">{{ $t('research.subtitle') }}</p>
    </header>

    <div v-if="loading" class="hint">{{ $t('signal.loading') }}</div>
    <div v-else-if="error" class="hint">✗ {{ error }}</div>
    <p v-else-if="!companies.length" class="hint">{{ $t('research.empty') }}</p>

    <template v-else>
      <nav class="tabs" :aria-label="$t('research.companies')">
        <button v-for="c in companies" :key="c" type="button" :class="['tab', { active: c === ticker }]"
                :aria-pressed="c === ticker" @click="selectTicker(c)">{{ c }}</button>
      </nav>
      <nav v-if="quarters.length" class="tabs small" :aria-label="$t('research.quarters')">
        <button v-for="q in quarters" :key="q.fiscal_label" type="button" :class="['tab', { active: q.fiscal_label === quarter }]"
                :aria-pressed="q.fiscal_label === quarter" @click="selectQuarter(q.fiscal_label)">
          {{ q.fiscal_label }}<span class="stage">{{ q.stage === 'final' ? '' : ` · ${$t('research.preliminary')}` }}</span>
        </button>
      </nav>

      <div v-if="noteLoading" class="hint">{{ $t('signal.loading') }}</div>
      <article v-else-if="note" class="note">
        <h2>{{ note.ticker }} {{ note.fiscal_period }}
          <span class="badge">{{ note.stage === 'final' ? $t('research.final') : $t('research.preliminary') }}</span>
          <span v-if="note.status === 'needs_review'" class="badge warn">{{ $t('research.needsReview') }}</span>
        </h2>
        <p class="meta">
          {{ $t('research.periodEnd') }} {{ note.period_end }} ·
          {{ $t('research.basedOn') }}
          <template v-for="(b, i) in note.based_on" :key="b.accession">
            <a :href="b.url" target="_blank" rel="noopener noreferrer">{{ b.form }} {{ b.filing_date }}</a><span v-if="i < note.based_on.length - 1">、</span>
          </template>
        </p>

        <section>
          <h3>{{ $t('research.summary') }}</h3>
          <p>{{ note.summary }}</p>
        </section>

        <section v-if="note.key_figures?.length">
          <h3>{{ $t('research.keyFigures') }}</h3>
          <div class="table-wrap">
            <table class="figures">
              <caption class="sr-only">{{ $t('research.keyFigures') }}</caption>
              <thead>
                <tr>
                  <th scope="col">{{ $t('research.colMetric') }}</th>
                  <th scope="col">{{ $t('research.colCurrent') }}</th>
                  <th scope="col">{{ $t('research.colPriorQ') }}</th>
                  <th scope="col">{{ $t('research.colPriorY') }}</th>
                  <th scope="col">{{ $t('research.colQoQ') }}</th>
                  <th scope="col">{{ $t('research.colYoY') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="k in note.key_figures" :key="k.id">
                  <th scope="row">{{ k.label }}</th>
                  <td>
                    <a v-if="k.source?.url" :href="k.source.url" target="_blank" rel="noopener noreferrer"
                       :title="sourceTitle(k.source)">{{ fmt(k.value, k.unit) }}</a>
                    <span v-else>{{ fmt(k.value, k.unit) }}</span>
                  </td>
                  <td>{{ fmt(k.prior_quarter, k.unit) }}</td>
                  <td>{{ fmt(k.prior_year, k.unit) }}</td>
                  <td>{{ chg(k.qoq, k.change_unit) }}</td>
                  <td>{{ chg(k.yoy, k.change_unit) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section v-for="sec in SECTIONS" :key="sec">
          <h3>{{ $t(`research.sec.${sec}`) }}</h3>
          <p v-if="!(note[sec] || []).length" class="hint">—</p>
          <ul class="claims">
            <li v-for="(c, i) in note[sec]" :key="i" :class="{ review: c.status !== 'verified' }">
              <span v-if="c.status !== 'verified'" class="badge warn">{{ $t('research.needsReview') }}</span>
              {{ c.text }}
              <span v-if="c.generated" class="gen">（{{ $t('research.generated') }}）</span>
              <details v-if="c.evidence?.length" class="src">
                <summary>{{ $t('research.sources', { n: c.evidence.length }) }}</summary>
                <ul>
                  <li v-for="(e, j) in c.evidence" :key="j">
                    <template v-if="e.type === 'metric'">
                      {{ $t('research.dataSource') }}：{{ e.label }} {{ e.value }}
                      <span class="muted">{{ e.source?.concept || e.source?.derived || '' }}</span>
                      <a v-if="e.source?.url" :href="e.source.url" target="_blank" rel="noopener noreferrer">{{ $t('research.openFiling') }}</a>
                    </template>
                    <template v-else>
                      <a :href="e.url" target="_blank" rel="noopener noreferrer">{{ e.form }} · {{ e.section }}</a>
                      <span class="muted">{{ $t('research.chars', { a: e.char_range?.[0], b: e.char_range?.[1] }) }}</span>
                      <blockquote>{{ e.quote }}</blockquote>
                    </template>
                  </li>
                </ul>
              </details>
              <p v-if="c.problems?.length" class="problems">{{ c.problems.join('；') }}</p>
            </li>
          </ul>
        </section>

        <section v-if="note.not_disclosed?.length">
          <h3>{{ $t('research.notDisclosed') }}</h3>
          <ul><li v-for="(x, i) in note.not_disclosed" :key="i">{{ x }}</li></ul>
        </section>

        <p class="disclaimer">{{ note.disclaimer }}</p>
      </article>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client.js';

const SECTIONS = ['highlights', 'guidance_check', 'changes', 'risks'];
const route = useRoute();
const router = useRouter();
const list = ref([]);
const loading = ref(true);
const error = ref('');
const note = ref(null);
const noteLoading = ref(false);
const ticker = ref('');
const quarter = ref('');

const companies = computed(() => [...new Set(list.value.map(n => n.ticker))]);
const quarters = computed(() => list.value.filter(n => n.ticker === ticker.value));

// 与后端 metrics.js fmt 同口径：美元十亿/百万、新台币亿元、百分比一位小数
function fmt(v, unit) {
  if (v == null) return '—';
  if (unit === '%') return `${Number(v).toFixed(1)}%`;
  if (unit === 'USD/share') return `$${Number(v).toFixed(2)}`;
  if (unit === 'TWD/share') return `NT$${Number(v).toFixed(2)}`;
  if (unit === 'TWD') return `新台币${(v / 1e8).toFixed(2)}亿元`;
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v}`;
}
const chg = (v, u) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}${u || '%'}`);
const sourceTitle = s => [s.concept, s.dims, s.derived, s.accession].filter(Boolean).join(' · ');

let seq = 0; // 快速切换时只采纳最后一次请求（同 AdminPanel loadRef 模式）
async function loadNote() {
  if (!ticker.value) return;
  const my = ++seq;
  noteLoading.value = true;
  try {
    const n = await api.researchNote(ticker.value, quarter.value || undefined);
    if (my !== seq) return;
    note.value = n;
    quarter.value = n.fiscal_period;
  } catch (e) {
    if (my === seq) { note.value = null; error.value = e.status === 404 ? '' : e.message; }
  } finally {
    if (my === seq) noteLoading.value = false;
  }
}

function sync() {
  router.replace({ query: { ticker: ticker.value, quarter: quarter.value || undefined } }).catch(() => {});
}
function selectTicker(t) { ticker.value = t; quarter.value = ''; loadNote().then(sync); }
function selectQuarter(q) { quarter.value = q; loadNote().then(sync); }

onMounted(async () => {
  try {
    list.value = (await api.researchNotes()).notes || [];
    ticker.value = companies.value.includes(String(route.query.ticker || '').toUpperCase())
      ? String(route.query.ticker).toUpperCase() : (companies.value[0] || '');
    quarter.value = String(route.query.quarter || '');
    await loadNote();
  } catch (e) {
    // 后端还没有研究接口（前端先于后端上线，如 Railway 暂停部署期间）时 404：按"暂无笔记"显示，不把原始错误甩给访客
    if (e.status === 404) companies.value = [];
    else error.value = e.message;
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.research-view { max-width: 1000px; margin: 0 auto; padding: 16px; color: var(--text-1); }
.head h1 { font-size: var(--fs-xl); margin: 0 0 4px; }
.sub, .hint, .muted, .meta { color: var(--text-3); font-size: var(--fs-sm); }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
.tab { background: var(--bg-input); border: 1px solid var(--border-3); border-radius: 6px; color: var(--text-2); padding: 6px 12px; cursor: pointer; font-size: var(--fs-md); }
.tabs.small .tab { font-size: var(--fs-sm); padding: 4px 10px; }
.tab.active { border-color: var(--blue); color: var(--text-1); }
.tab:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.stage { color: var(--text-3); }
.note { background: var(--bg-card); border: 1px solid var(--border-2); border-radius: 10px; padding: 16px; }
.note h2 { font-size: var(--fs-lg); margin: 0 0 6px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.note h3 { font-size: var(--fs-md); color: var(--text-2); margin: 18px 0 8px; }
.badge { font-size: var(--fs-xs); border: 1px solid var(--border-3); border-radius: 4px; padding: 1px 6px; color: var(--text-2); }
.badge.warn { border-color: var(--red-border); color: var(--red); background: var(--red-bg); }
/* 窄屏横向滚动；指标名列固定在左侧，滚动时始终知道每行是什么 */
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
/* 固定列限宽并允许换行：长指标名（"AI Clouds Industrial Enterprise"）不会把固定列撑宽到盖住后面的数字。
   2026-10-21 预览发现：未限宽时横向滚动后 "+105.9%" 被固定列遮成 "5.9%"——数字读错，不只是排版问题 */
.figures th[scope="row"], .figures thead th:first-child {
  position: sticky; left: 0; z-index: 1; background: var(--bg-card);
  white-space: normal; min-width: 7em; max-width: 9.5em; box-shadow: 1px 0 0 var(--border-3);
}
@media (min-width: 720px) {
  .figures th[scope="row"], .figures thead th:first-child { max-width: none; white-space: nowrap; }
}
.figures { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); font-family: var(--font-num); }
.figures th, .figures td { padding: 6px 8px; border-bottom: 1px solid var(--border-2); text-align: right; white-space: nowrap; }
.figures th[scope="row"], .figures thead th:first-child { text-align: left; font-family: var(--font-sans); }
.figures thead th { color: var(--text-3); font-weight: 600; }
a { color: var(--blue); }
/* 表格里的数字链接用正文色+下划线：数字是本页最重要的信息，不能用浅蓝（亮色主题下对白底对比度不足） */
.figures td a { color: var(--text-1); text-decoration: underline; text-decoration-color: var(--blue); text-underline-offset: 3px; }
.claims { padding-left: 18px; }
.claims > li { margin: 6px 0; line-height: 1.6; }
.claims > li.review { color: var(--text-2); }
.gen { color: var(--text-3); font-size: var(--fs-xs); }
.src { margin: 2px 0 0; font-size: var(--fs-sm); }
.src summary { cursor: pointer; color: var(--text-3); }
.src blockquote { margin: 4px 0 6px; padding-left: 8px; border-left: 2px solid var(--border-3); color: var(--text-2); }
.problems { color: var(--red); font-size: var(--fs-xs); margin: 2px 0; }
.disclaimer { margin-top: 20px; color: var(--text-3); font-size: var(--fs-xs); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
