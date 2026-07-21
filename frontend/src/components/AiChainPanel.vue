<template>
  <div class="ai-chain-panel">
    <div class="section-title">{{ $t('aiChain.title') }}</div>
    <div v-if="loadError" class="error-state">
      {{ $t('error.loadFailed') }}
      <button class="retry-btn" @click="load">{{ $t('error.retry') }}</button>
    </div>
    <div class="chain-flow">
      <template v-for="(row, ri) in stageRows" :key="row[0].key">
        <div :class="['stage-row', { paired: row.length > 1 }]">
          <div
            v-for="stage in row"
            :key="stage.key"
            :class="['chain-stage', { bottleneck: bottleneck.stage === stage.key }]"
          >
            <div class="stage-header">
              <span class="stage-name">
                {{ $t(`aiChain.stages.${stage.key}`) }}
                <span v-if="stage.rank" class="rank-badge">#{{ stage.rank }}</span>
              </span>
              <span class="stage-metrics">
                <span v-if="stage.key === 'model' && bubble.modelUsageTrendPct != null"
                  :class="['rel-return', bubble.modelUsageTrendPct >= 0 ? 'pos' : 'neg']">
                  {{ formatPct(bubble.modelUsageTrendPct) }}
                </span>
                <span v-else-if="stage.relReturnPct != null"
                  :class="['rel-return', stage.relReturnPct >= 0 ? 'pos' : 'neg']"
                  :title="$t('aiChain.relReturnLabel')">
                  {{ formatPct(stage.relReturnPct) }}
                </span>
                <span v-if="bottleneck.stage === stage.key" class="bottleneck-tag">
                  🔥 {{ $t('aiChain.currentBottleneck') }} ·
                  {{ $t(bottleneck.source === 'manual' ? 'aiChain.sourceManual' : 'aiChain.sourceAuto') }}
                </span>
              </span>
            </div>
            <div class="stage-tickers">
              <span v-for="ticker in stage.tickers" :key="ticker" class="ticker-chip">{{ ticker }}</span>
            </div>
          </div>
        </div>
        <div v-if="ri < stageRows.length - 1" class="stage-arrow">↓</div>
      </template>
    </div>

    <!-- 泡沫监测：调用量/资本开支/半导体产出（下降 → 防守预警） -->
    <div class="bubble-monitor">
      <div class="bubble-title">{{ $t('aiChain.bubbleTitle') }}</div>
      <div v-if="bubble.warning" class="bubble-alert">⚠️ {{ $t('aiChain.bubbleWarning') }}</div>
      <div class="bubble-metrics">
        <div class="bubble-cell" :title="$t('indicators.hints.modelUsageTrend') + '\n' + $t('indicators.hintGlobal')">
          <span class="bubble-label hinted">{{ $t('aiChain.modelUsageTrend') }}</span>
          <span :class="['bubble-value', usageClass]">
            {{ bubble.modelUsageTrendPct != null ? formatPct(bubble.modelUsageTrendPct) : $t('aiChain.noData') }}
          </span>
        </div>
        <div class="bubble-cell" :title="$t('indicators.hints.capexYoY') + '\n' + $t('indicators.hints.capexQtrYoY') + '\n' + $t('indicators.hintGlobal')">
          <span class="bubble-label hinted">{{ $t('aiChain.capexYoY') }}</span>
          <span :class="['bubble-value', capexClass]">
            {{ capexDisplay }}
          </span>
        </div>
        <div class="bubble-cell" :title="$t('indicators.hints.semiIpYoy') + '\n' + $t('indicators.hintGlobal')">
          <span class="bubble-label hinted">{{ $t('aiChain.semiIpYoy') }}</span>
          <span :class="['bubble-value', semiIpClass]">
            {{ bubble.semiIpYoy != null ? formatPct(bubble.semiIpYoy) : $t('aiChain.noData') }}
          </span>
        </div>
      </div>
      <div v-if="bubble.modelUsageAsOf" class="bubble-source">
        Source: OpenRouter (openrouter.ai/rankings), as of {{ bubble.modelUsageAsOf }}
      </div>

      <!-- capex指引自动检测（常驻）：每家最近一次财报新闻稿的前瞻指引方向，含"未给指引"。
           数据归集在capex口径旁便于对照判读（实际数据加速中 vs 某家指引已下修一眼可见） -->
      <div v-if="guidanceRows.length" class="guidance-row" :title="$t('signal.capexGuidanceRefHint')">
        <span class="guidance-label hinted">{{ $t('aiChain.guidanceTitle') }}</span>
        <span v-for="g in guidanceRows" :key="g.symbol"
              :class="['guidance-chip', g.direction]" :title="g.quote || ''">
          {{ g.symbol }}: {{ $t(`signal.guidanceDir.${g.direction}`) }}<template v-if="g.filingDate">（{{ g.filingDate }}）</template>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { AI_CHAIN_STAGES } from '../data/aiChain.js';
import { api } from '../api/client.js';

const { t } = useI18n();
const chainData = ref(null);
const loadError = ref(false);

async function load() {
  loadError.value = false;
  try {
    chainData.value = await api.getAiChain();
  } catch (e) {
    console.error('Failed to load ai-chain data', e);
    loadError.value = true;
  }
}

const bottleneck = computed(() => chainData.value?.bottleneck || { stage: null, source: 'auto', note: null });
const bubble = computed(() => chainData.value?.bubble || {});
// capex指引检测：每家最近一条（后端已按symbol去重），下修排最前
const DIR_ORDER = { cut: 0, maintain: 1, raise: 2, none: 3 };
const guidanceRows = computed(() =>
  [...(chainData.value?.guidance || [])].sort((a, b) => (DIR_ORDER[a.direction] ?? 9) - (DIR_ORDER[b.direction] ?? 9))
);

// 静态标的清单 + 后端排名/相对收益按环节合并
const stages = computed(() => {
  const metrics = new Map((chainData.value?.stages || []).map(s => [s.key, s]));
  return AI_CHAIN_STAGES.map(s => ({ ...s, ...(metrics.get(s.key) || {}) }));
});

// 现金流同层的并列环节（1行2列展示）：存储 与 光模块
const PAIRED_KEYS = new Set(['memory', 'optical']);
const stageRows = computed(() => {
  const rows = [];
  for (const s of stages.value) {
    const last = rows[rows.length - 1];
    if (PAIRED_KEYS.has(s.key) && last && last.length === 1 && PAIRED_KEYS.has(last[0].key)) {
      last.push(s);
    } else {
      rows.push([s]);
    }
  }
  return rows;
});

function formatPct(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

// 统一颜色语义：绿=宽松/利好进攻，黄=中性/观望，红=收紧/利好防守（与信号位徽章一致）
// 调用量：触发预警→红；负增长但未到预警线→黄；正增长→绿
const usageClass = computed(() => {
  const v = bubble.value.modelUsageTrendPct;
  if (v == null) return '';
  // 后端 server.js 写入的 reason key 为 'usage'（usage/capex/semiIp 三件套）
  if ((bubble.value.reasons || []).includes('usage')) return 'neg';
  return v >= 0 ? 'pos' : 'neutral';
});

// 资本开支：判定阈值即0，负增长必触发预警→红，正增长→绿
const capexClass = computed(() => {
  const v = bubble.value.capexYoY;
  if (v == null) return '';
  if ((bubble.value.reasons || []).includes('capex')) return 'neg';
  return v >= 0 ? 'pos' : 'neutral';
});

// 半导体产出：直接用后端 aiSupply 基本面子信号（>5%宽松/<0%收紧/其间观望）
const semiIpClass = computed(() => {
  const sig = bubble.value.aiFundamentalSignal;
  if (sig === 'loose') return 'pos';
  if (sig === 'tight') return 'neg';
  if (sig === 'neutral') return 'neutral';
  return '';
});

// 资本开支显示：总额（按语言用 亿/億/억 或 B/Mrd/MM）+ TTM同比% + 最新单季同比（拐点侦察兵，参考）
const capexDisplay = computed(() => {
  const { capexTtm, capexYoY, capexQtrYoY } = bubble.value;
  if (capexTtm == null && capexYoY == null) return t('aiChain.noData');
  const parts = [];
  if (capexTtm != null) {
    parts.push(t('aiChain.capexAmount', {
      yi: Math.round(capexTtm / 1e8).toLocaleString(),
      bn: (capexTtm / 1e9).toFixed(0),
    }));
  }
  if (capexYoY != null) parts.push(`(${formatPct(capexYoY)})`);
  if (capexQtrYoY != null) parts.push(`· ${t('aiChain.capexQtr', { pct: formatPct(capexQtrYoY) })}`);
  return parts.join(' ');
});

onMounted(load);
</script>

<style scoped>
.ai-chain-panel { display: flex; flex-direction: column; gap: 12px; }

.error-state { display: flex; align-items: center; gap: 10px; color: var(--red); font-size: var(--fs-md); }
.retry-btn {
  background: var(--bg-input);
  border: 1px solid var(--border-3);
  border-radius: 6px;
  color: var(--text-2);
  padding: 4px 12px;
  cursor: pointer;
  font-size: var(--fs-sm);
}
.retry-btn:hover { border-color: var(--blue); }

.section-title {
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-4);
  margin-bottom: 4px;
}

.chain-flow { display: flex; flex-direction: column; align-items: center; gap: 4px; }

.stage-row { width: 100%; max-width: 480px; display: flex; gap: 10px; }
.stage-row .chain-stage { max-width: none; flex: 1; min-width: 0; }
@media (max-width: 600px) {
  .stage-row.paired { flex-direction: column; }
}

.chain-stage {
  width: 100%;
  max-width: 480px;
  background: var(--bg-card);
  border: 1px solid var(--border-2);
  border-radius: 10px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chain-stage.bottleneck {
  border-color: var(--amber-border);
  background: var(--amber-bg);
}

.stage-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.stage-name { font-size: var(--fs-md); color: var(--text-2); font-weight: 600; display: flex; align-items: center; gap: 6px; }
.rank-badge {
  font-size: var(--fs-xs);
  color: var(--yellow);
  border: 1px solid var(--yellow-border);
  border-radius: 4px;
  padding: 0 5px;
}
.stage-metrics { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.rel-return { font-size: var(--fs-sm); font-family: var(--font-num); }
.rel-return.pos { color: var(--green); }
.rel-return.neg { color: var(--red); }
.bottleneck-tag { font-size: var(--fs-xs); color: var(--yellow); }

.stage-tickers { display: flex; flex-wrap: wrap; gap: 6px; }
.ticker-chip {
  font-size: var(--fs-xs);
  color: var(--blue);
  background: var(--blue-bg);
  border: 1px solid var(--blue-border);
  border-radius: 5px;
  padding: 2px 8px;
}

.stage-arrow { text-align: center; color: var(--text-5); font-size: var(--fs-lg); }

.bubble-monitor {
  background: var(--bg-card);
  border: 1px solid var(--border-2);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bubble-title { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-4); }
.bubble-alert {
  font-size: var(--fs-sm);
  color: var(--red);
  background: var(--red-bg);
  border-radius: 6px;
  padding: 6px 10px;
}
.bubble-metrics { display: flex; gap: 16px; flex-wrap: wrap; }
.bubble-cell { display: flex; flex-direction: column; gap: 2px; min-width: 140px; }
.bubble-label { font-size: var(--fs-xs); color: var(--text-3); font-weight: 500; }
.bubble-label.hinted { cursor: help; }
.bubble-value { font-size: var(--fs-lg); color: var(--text-2); font-family: var(--font-num); }
.bubble-value.pos { color: var(--green); }
.bubble-value.neg { color: var(--red); }
.bubble-value.neutral { color: var(--yellow); }
.bubble-source { font-size: var(--fs-xs); color: var(--text-4); }

.guidance-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: var(--fs-xs);
}
.guidance-label { color: var(--text-4); }
.guidance-chip {
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-3);
}
.guidance-chip.cut { color: var(--red); background: var(--red-bg); }
.guidance-chip.raise { color: var(--green); background: var(--green-bg); }
.guidance-chip.maintain { color: var(--text-2); }
</style>
