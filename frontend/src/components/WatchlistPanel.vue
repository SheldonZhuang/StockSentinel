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

    <!-- 股票列表 -->
    <div v-if="loading" class="loading">{{ $t('signal.loading') }}</div>
    <div v-else-if="stocks.length === 0" class="empty">{{ $t('watchlist.empty') }}</div>
    <div v-else class="stock-list">
      <div v-for="stock in stocks" :key="stock.symbol" class="stock-card">
        <div class="stock-header">
          <span class="stock-symbol">{{ stock.symbol }}</span>
          <span class="stock-name" v-if="stock.shortName && stock.shortName !== stock.symbol">{{ stock.shortName }}</span>
          <button @click="removeStock(stock.symbol)" class="remove-btn">✕</button>
        </div>
        <div v-if="stock.error" class="stock-error">{{ stock.error }}</div>
        <template v-else>
          <div class="stock-price">
            <span class="price-value">${{ stock.currentPrice?.toFixed(2) }}</span>
            <span class="percentile-badge" :class="percentileClass(stock.pricePercentile)">
              {{ stock.pricePercentile !== null ? stock.pricePercentile + '%' : '—' }}
            </span>
          </div>
          <div class="stock-valuation">
            <span class="val-item">
              {{ $t('watchlist.pe') }}:
              <strong>{{ stock.currentPE !== null ? stock.currentPE?.toFixed(1) : '—' }}</strong>
            </span>
            <span class="val-item">
              {{ $t('watchlist.ps') }}:
              <strong>{{ stock.currentPS !== null ? stock.currentPS?.toFixed(2) : '—' }}</strong>
            </span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';
import { api } from '../api/client.js';

const MAG7 = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'];
const ETFS = ['QQQ', 'SPY'];

const newSymbol = ref('');
const loading = ref(true);
const stocks = ref([]);

const today = new Date().toISOString().slice(0, 10);
const threeYearsAgo = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 3);
  return d.toISOString().slice(0, 10);
})();

const startDate = ref(threeYearsAgo);
const endDate = ref(today);

async function loadWatchlist() {
  loading.value = true;
  try {
    stocks.value = await api.getWatchlist(startDate.value, endDate.value);
  } catch (e) {
    console.error('Watchlist load failed', e);
  } finally {
    loading.value = false;
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
  await api.removeFromWatchlist(symbol);
  stocks.value = stocks.value.filter(s => s.symbol !== symbol);
}

async function addPreset(symbols) {
  await Promise.allSettled(symbols.map(s => api.addToWatchlist(s)));
  await loadWatchlist();
}

function percentileClass(p) {
  if (p === null) return '';
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
  background: #111;
  border: 1px solid #333;
  border-radius: 8px;
  color: #eee;
  padding: 8px 12px;
  font-size: 14px;
  text-transform: uppercase;
}
.add-input:focus { outline: none; border-color: #555; }
.add-btn {
  background: #1e3a2f;
  color: #4ade80;
  border: 1px solid #2d5a3d;
  border-radius: 8px;
  padding: 8px 16px;
  cursor: pointer;
  font-weight: 600;
}
.add-btn:disabled { opacity: 0.4; cursor: default; }

.date-range-row { display: flex; align-items: center; gap: 8px; }
.date-input { background: #111; border: 1px solid #333; border-radius: 6px; color: #ccc; padding: 6px 8px; font-size: 12px; }
.date-sep { color: #555; }

.presets-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.preset-label { font-size: 12px; color: #666; }
.preset-btn { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; color: #aaa; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.preset-btn:hover { border-color: #555; color: #eee; }

.loading, .empty { font-size: 13px; color: #666; text-align: center; padding: 20px; }

.stock-list { display: flex; flex-direction: column; gap: 8px; }

.stock-card {
  background: #111;
  border: 1px solid #222;
  border-radius: 10px;
  padding: 12px;
}

.stock-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.stock-symbol { font-weight: 700; font-size: 15px; color: #eee; }
.stock-name { font-size: 12px; color: #666; flex: 1; }
.remove-btn { background: none; border: none; color: #555; cursor: pointer; font-size: 14px; padding: 0 4px; margin-left: auto; }
.remove-btn:hover { color: #f87171; }

.stock-price { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.price-value { font-size: 18px; font-weight: 600; color: #ddd; font-variant-numeric: tabular-nums; }

.percentile-badge {
  font-size: 12px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 6px;
}
.percentile-badge.high { background: #3a1717; color: #f87171; }
.percentile-badge.mid { background: #3a3416; color: #facc15; }
.percentile-badge.low { background: #173a24; color: #4ade80; }

.stock-valuation { display: flex; gap: 16px; }
.val-item { font-size: 12px; color: #777; }
.val-item strong { color: #bbb; }

.stock-error { font-size: 12px; color: #f87171; }
</style>
