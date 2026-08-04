<template>
  <div class="watchlist-panel">
    <!-- 添加股票 -->
    <div class="add-row">
      <input
        v-model="newSymbol"
        :placeholder="$t('watchlist.addPlaceholder')"
        @keyup.enter="addStock"
        class="add-input"
        maxlength="10"
      />
      <button @click="addStock" class="add-btn" :disabled="!newSymbol.trim()">
        {{ $t('watchlist.add') }}
      </button>
    </div>

    <!-- 日期区间选择 -->
    <div class="date-range-row">
      <input type="date" v-model="startDate" class="date-input" />
      <span class="date-sep">→</span>
      <input type="date" v-model="endDate" class="date-input" />
    </div>

    <!-- 快速添加预设 -->
    <div class="presets-row">
      <span class="preset-label">{{ $t('watchlist.presets') }}:</span>
      <button @click="addPreset(MAG7)" class="preset-btn">{{ $t('watchlist.mag7') }}</button>
      <button @click="addPreset(ETFS)" class="preset-btn">{{ $t('watchlist.etfs') }}</button>
    </div>

    <!-- 排序 -->
    <div class="sort-row">
      <span class="preset-label">{{ $t('watchlist.sortBy') }}:</span>
      <button
        v-for="opt in SORT_OPTIONS"
        :key="opt.key"
        :class="['preset-btn', 'sort-btn', { active: sortKey === opt.key }]"
        @click="toggleSort(opt.key)"
      >
        {{ $t(opt.label) }}
        <span v-if="sortKey === opt.key" class="sort-arrow">{{ sortDir === 1 ? '▲' : '▼' }}</span>
      </button>
      <!-- 指标说明开关：卡片上的 title 悬停触屏不可达，这里给统一的可点击入口（120号 a11y） -->
      <button class="preset-btn" :aria-expanded="showHints" @click="showHints = !showHints">
        ⓘ {{ $t('watchlist.hintToggle') }}
      </button>
    </div>
    <div v-if="showHints" class="hint-expand">{{ $t('watchlist.percentileHint') }}
{{ $t('watchlist.valuationHint') }}</div>

    <!-- 股票列表 -->
    <div v-if="loading" class="loading">{{ $t('signal.loading') }}</div>
    <div v-else-if="loadError" class="empty">
      ⚠️ {{ $t('error.fetchFailed') }}
      <button class="retry-btn" @click="loadWatchlist">{{ $t('error.retry') }}</button>
    </div>
    <div v-else-if="stocks.length === 0" class="empty">{{ $t('watchlist.empty') }}</div>
    <div v-else class="stock-list">
      <div v-for="stock in sortedStocks" :key="stock.symbol" class="stock-card">
        <div class="stock-header">
          <span class="stock-symbol">{{ stock.symbol }}</span>
          <span class="stock-name" v-if="stock.shortName && stock.shortName !== stock.symbol">{{ stock.shortName }}</span>
          <button @click="removeStock(stock.symbol)" class="remove-btn" :aria-label="$t('watchlist.removeLabel', { symbol: stock.symbol })" :title="$t('watchlist.removeLabel', { symbol: stock.symbol })">✕</button>
        </div>
        <div v-if="stock.error" class="stock-error">{{ stock.error }}</div>
        <template v-else>
          <div class="stock-price">
            <span class="price-value">{{ stock.currentPrice != null ? '$' + stock.currentPrice.toFixed(2) : '—' }}</span>
            <span class="pct-group" :title="$t('watchlist.percentileHint')">
              <span class="pct-label">{{ $t('watchlist.pricePercentile') }}</span>
              <span class="percentile-badge" :class="percentileClass(stock.pricePercentile)">
                {{ stock.pricePercentile != null ? stock.pricePercentile + '%' : '—' }}
              </span>
            </span>
          </div>
          <div class="stock-valuation" :title="$t('watchlist.valuationHint')">
            <span class="val-item">
              {{ $t('watchlist.pe') }}:
              <strong>{{ stock.currentPE != null ? stock.currentPE.toFixed(1) : '—' }}</strong>
            </span>
            <span class="val-item">
              {{ $t('watchlist.ps') }}:
              <strong>{{ stock.currentPS != null ? stock.currentPS.toFixed(2) : '—' }}</strong>
            </span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { api } from '../api/client.js';

const MAG7 = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'];
const ETFS = ['QQQ', 'SPY'];

// 排序项：首字母 / 价格百分位 / PE / PS
const SORT_OPTIONS = [
  { key: 'symbol', label: 'watchlist.sortSymbol' },
  { key: 'pricePercentile', label: 'watchlist.pricePercentile' },
  { key: 'currentPE', label: 'watchlist.pe' },
  { key: 'currentPS', label: 'watchlist.ps' },
];

const newSymbol = ref('');
const loading = ref(true);
const loadError = ref(false); // 116号修复：接口故障不再伪装成"暂无自选股"
const showHints = ref(false); // 指标说明展开态（a11y：title 的触屏可达替代入口）
const stocks = ref([]);
const sortKey = ref(null); // null = 添加顺序
const sortDir = ref(1);    // 1 升序 / -1 降序

function toggleSort(key) {
  if (sortKey.value === key) {
    sortDir.value = -sortDir.value; // 同键再点切换方向
  } else {
    sortKey.value = key;
    sortDir.value = 1;
  }
}

// 无数据(null/—)的条目永远排在最后，不受方向影响
const sortedStocks = computed(() => {
  if (!sortKey.value) return stocks.value;
  const key = sortKey.value;
  const dir = sortDir.value;
  return [...stocks.value].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    const aNull = va === null || va === undefined;
    const bNull = vb === null || vb === undefined;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (key === 'symbol') return dir * String(va).localeCompare(String(vb));
    return dir * (va - vb);
  });
});

// 用户本地日期（toISOString 是 UTC：美洲用户晚间会把"明天"当默认区间终点）
const localDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = localDateStr(new Date());
const threeYearsAgo = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 3);
  return localDateStr(d);
})();

const startDate = ref(threeYearsAgo);
const endDate = ref(today);

let loadSeq = 0;
async function loadWatchlist() {
  // 请求序号防竞态：改日期触发的并发请求中，只有最后一次的响应允许落地
  const seq = ++loadSeq;
  loading.value = true;
  loadError.value = false;
  try {
    const data = await api.getWatchlist(startDate.value, endDate.value);
    if (seq !== loadSeq) return;
    stocks.value = data;
  } catch (e) {
    console.error('Watchlist load failed', e);
    if (seq === loadSeq) loadError.value = true;
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

async function addStock() {
  const sym = newSymbol.value.trim().toUpperCase();
  if (!sym) return;
  try {
    await api.addToWatchlist(sym);
    newSymbol.value = '';
    await loadWatchlist();
  } catch (e) {
    alert(e.message);
  }
}

async function removeStock(symbol) {
  try {
    await api.removeFromWatchlist(symbol);
    stocks.value = stocks.value.filter(s => s.symbol !== symbol);
  } catch (e) {
    alert(e.message);
  }
}

async function addPreset(symbols) {
  await Promise.allSettled(symbols.map(s => api.addToWatchlist(s)));
  await loadWatchlist();
}

function percentileClass(p) {
  if (p == null) return ''; // == 同时拦 null/undefined：旧快照缺字段时 '—' 占位不该带黄色徽章底
  if (p >= 80) return 'high';
  if (p <= 20) return 'low';
  return 'mid';
}

watch([startDate, endDate], loadWatchlist);
onMounted(loadWatchlist);
</script>

<style scoped>
.watchlist-panel { display: flex; flex-direction: column; gap: 12px; }

.add-row { display: flex; gap: 8px; }
.add-input {
  flex: 1;
  background: var(--bg-input);
  border: 1px solid var(--border-3);
  border-radius: 8px;
  color: var(--text-1);
  padding: 8px 12px;
  font-size: var(--fs-lg);
  text-transform: uppercase;
}
.add-input:focus { outline: none; border-color: var(--border-focus); }
.add-btn {
  background: var(--green-bg);
  color: var(--green);
  border: 1px solid var(--green-border);
  border-radius: 8px;
  padding: 8px 16px;
  cursor: pointer;
  font-weight: 600;
}
.add-btn:disabled { opacity: 0.4; cursor: default; }

.date-range-row { display: flex; align-items: center; gap: 8px; }
.date-input { background: var(--bg-input); border: 1px solid var(--border-3); border-radius: 6px; color: var(--text-2); padding: 6px 8px; font-size: var(--fs-sm); }
.date-sep { color: var(--text-5); }

.presets-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sort-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sort-btn.active { border-color: var(--blue-border); color: var(--blue); background: var(--blue-bg); }
.sort-arrow { font-size: var(--fs-xs); margin-left: 2px; } /* 9px 超出字号5档下限，收敛到 fs-xs */
/* 点击展开的指标说明块（与卡片 title 同文） */
.hint-expand {
  font-size: var(--fs-xs);
  color: var(--text-3);
  white-space: pre-line;
  background: var(--bg-input);
  border: 1px solid var(--border-2);
  border-radius: 6px;
  padding: 6px 8px;
}
.preset-label { font-size: var(--fs-sm); color: var(--text-4); }
.preset-btn { background: var(--bg-input); border: 1px solid var(--border-3); border-radius: 6px; color: var(--text-3); padding: 4px 10px; font-size: var(--fs-sm); cursor: pointer; }
.preset-btn:hover { border-color: var(--border-focus); color: var(--text-1); }

.loading, .empty { font-size: var(--fs-md); color: var(--text-4); text-align: center; padding: 20px; }

.stock-list { display: flex; flex-direction: column; gap: 8px; }

.stock-card {
  background: var(--bg-card);
  border: 1px solid var(--border-2);
  border-radius: 10px;
  padding: 12px;
}

.stock-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.stock-symbol { font-weight: 700; font-size: var(--fs-lg); color: var(--text-1); }
.stock-name { font-size: var(--fs-sm); color: var(--text-4); flex: 1; }
/* text-3 而非 text-5：✕是可交互控件（UI组件对比度底线3:1），text-5 亮色主题下≈2.8:1近乎隐形 */
.remove-btn { background: none; border: none; color: var(--text-3); cursor: pointer; font-size: var(--fs-lg); padding: 0 4px; margin-left: auto; }
.remove-btn:hover { color: var(--red); }

.stock-price { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.price-value { font-size: var(--fs-xl); font-weight: 600; color: var(--text-1); font-family: var(--font-num); }

.pct-group { display: inline-flex; align-items: center; gap: 6px; cursor: help; }
.pct-label { font-size: var(--fs-xs); color: var(--text-4); }

.percentile-badge {
  font-size: var(--fs-sm);
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 6px;
  font-family: var(--font-num);
}
.percentile-badge.high { background: var(--red-bg); color: var(--red); }
.percentile-badge.mid { background: var(--yellow-bg); color: var(--yellow); }
.percentile-badge.low { background: var(--green-bg); color: var(--green); }

.stock-valuation { display: flex; gap: 16px; cursor: help; }
.val-item { font-size: var(--fs-sm); color: var(--text-4); }
.val-item strong { color: var(--text-2); font-family: var(--font-num); font-weight: 600; }

.stock-error { font-size: var(--fs-sm); color: var(--red); }
.retry-btn {
  background: none; border: 1px solid var(--border-3); border-radius: 6px;
  color: var(--text-2); padding: 2px 10px; cursor: pointer; font-size: var(--fs-sm); margin-left: 8px;
}
.retry-btn:hover { border-color: var(--text-3); }
</style>
