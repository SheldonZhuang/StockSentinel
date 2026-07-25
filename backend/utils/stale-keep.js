// 参考指标 stale-keep（114号）：FRED 美东凌晨维护窗口的瞬时故障会把独立降级序列打成 null，
// 落库后前端整天显示"暂无数据"。月度/日频参考序列的上一日观测依然有效——保存快照前，
// 值仍为 null 的指标按"组"沿用上一快照（值+参考期+发布日整组带走，展示层的数据参考期
// 如实显示旧日期，不伪造新鲜度）。
//
// 边界（授权边界原则）：只回填落库/展示字段，不改判定输入——调用方必须在四维信号、锁、
// 收益率曲线否决全部算完之后再调用；信号级 stale-keep（fiscal/admin/aiSupply）语义不变，
// stale 标志在回填前已按原始 null 判定完毕。

// [组名, 目标对象选择器('macro'|'policy'), {内存字段: 快照列名}, 新鲜度预算(天)]，每组首字段为判空主键。
// 新鲜度预算 = 参考期(periodDate)距今天的最大正常天数：月度序列发布滞后1~2个月（EPUTRADE编制
// 滞后更长），日频序列滞后数个工作日。超预算说明 stale-keep 已连续多日沿用旧值——大概率是
// 序列改名/停更或持续故障，须运维告警而不是无限静默沿用（stale-keep 本身会掩盖这类永久失效）
const GROUPS = [
  ['corePce', 'macro', { corePce: 'fred_core_pce', prevCorePce: 'fred_core_pce_prev', corePcePeriodDate: 'core_pce_period_date', corePceReleaseDate: 'core_pce_release_date' }, 100],
  ['trimmedPce1m', 'macro', { trimmedPce1m: 'fred_trimmed_pce_1m', prevTrimmedPce1m: 'fred_trimmed_pce_1m_prev', trimmedPce1mPeriodDate: 'trimmed_pce_1m_period_date', trimmedPce1mReleaseDate: 'trimmed_pce_1m_release_date' }, 100],
  ['trimmedPce', 'macro', { trimmedPce: 'fred_trimmed_pce', prevTrimmedPce: 'fred_trimmed_pce_prev', trimmedPcePeriodDate: 'trimmed_pce_period_date', trimmedPceReleaseDate: 'trimmed_pce_release_date' }, 100],
  ['trimmedPce12m', 'macro', { trimmedPce12m: 'fred_trimmed_pce_12m', prevTrimmedPce12m: 'fred_trimmed_pce_12m_prev', trimmedPce12mPeriodDate: 'trimmed_pce_12m_period_date', trimmedPce12mReleaseDate: 'trimmed_pce_12m_release_date' }, 100],
  ['unemployment', 'macro', { unemployment: 'fred_unemployment', prevUnemployment: 'fred_unemployment_prev', unemploymentPeriodDate: 'unemployment_period_date', unemploymentReleaseDate: 'unemployment_release_date' }, 100],
  ['sahm', 'macro', { sahmValue: 'sahm_value', sahmPeriodDate: 'sahm_period_date', sahmReleaseDate: 'sahm_release_date' }, 100],
  ['creditSpread', 'macro', { creditSpread: 'credit_spread', creditSpreadPercentile: 'credit_spread_percentile', creditSpread90dWidenBp: 'credit_spread_90d_widen_bp', creditSpreadPeriodDate: 'credit_spread_period_date' }, 10],
  ['yieldCurve', 'macro', { yieldCurveSpread: 'yield_curve_spread', yieldCurveInvertedDays: 'yield_curve_inverted_days', yieldCurvePeriodDate: 'yield_curve_period_date' }, 10],
  ['epuTrade', 'policy', { epuTrade: 'epu_trade', epuTradePercentile: 'epu_trade_percentile', epuTradePeriodDate: 'epu_trade_period_date' }, 160],
  ['epuDaily', 'policy', { epuDaily: 'epu_daily', epuDailyPercentile: 'epu_daily_percentile', epuDailyPeriodDate: 'epu_daily_period_date' }, 10],
  ['semiIp', 'policy', { semiIpYoy: 'semi_ip_yoy', semiIpPeriodDate: 'semi_ip_period_date', semiIpReleaseDate: 'semi_ip_release_date' }, 100],
  ['fiscal', 'policy', { outlaysTtm: 'fiscal_outlays_ttm', outlaysTtmPrev: 'fiscal_outlays_ttm_prev', outlaysChangePct: 'fiscal_outlays_change_pct', fiscalPeriodDate: 'fiscal_period_date', fiscalReleaseDate: 'fiscal_release_date' }, 100],
  ['oil', 'policy', { oilWti: 'oil_wti', oilChange30dPct: 'oil_change_30d_pct', oilPeriodDate: 'oil_period_date', oilSource: 'oil_source', oilLevelLow: 'oil_level_low' }, 10],
];

/**
 * 就地回填当日拉取失败（主键为 null）的指标组，返回被回填的组名列表（供日志与验证）。
 * @param {object} macroData - fetchMacroData 返回值（会被就地修改）
 * @param {object} policyData - fetchPolicyData 返回值（会被就地修改）
 * @param {object|null} prevSnapshot - 上一快照 DB 行（snake_case 列），无则不回填
 * @returns {string[]} 回填的组名
 */
export function staleKeepIndicators(macroData, policyData, prevSnapshot) {
  if (!prevSnapshot) return [];
  const kept = [];
  for (const [name, which, mapping] of GROUPS) {
    const target = which === 'macro' ? macroData : policyData;
    if (!target) continue;
    const keyField = Object.keys(mapping)[0];
    // 当日拉到了值 → 不动；上一快照也没有 → 无可沿用
    if (target[keyField] !== null && target[keyField] !== undefined) continue;
    const prevVal = prevSnapshot[mapping[keyField]];
    if (prevVal === null || prevVal === undefined) continue;
    for (const [field, column] of Object.entries(mapping)) {
      target[field] = prevSnapshot[column] ?? null;
    }
    kept.push(name);
  }
  return kept;
}

/**
 * 新鲜度看门狗（114b号）：stale-keep 之后调用。有值但参考期超过该组新鲜度预算 →
 * 说明该组已连续多日拿不到新数据（序列改名/停更/持续故障），返回超龄清单供运维告警。
 * 值本身就为 null 的组不在此列（那是"无历史可沿用"的新库场景，前端已如实显示"—"）。
 * @param {object} macroData / policyData - stale-keep 处理后的当日数据（不修改）
 * @param {string} todayStr - 'YYYY-MM-DD'（ET 当日）
 * @returns {Array<{name, periodDate, ageDays, budgetDays}>}
 */
export function checkIndicatorFreshness(macroData, policyData, todayStr) {
  const todayMs = Date.parse(todayStr + 'T00:00:00Z');
  if (isNaN(todayMs)) return [];
  const overdue = [];
  for (const [name, which, mapping, budgetDays] of GROUPS) {
    const target = which === 'macro' ? macroData : policyData;
    if (!target) continue;
    const keyField = Object.keys(mapping)[0];
    if (target[keyField] === null || target[keyField] === undefined) continue;
    const periodField = Object.keys(mapping).find(f => /PeriodDate$/.test(f));
    const periodDate = target[periodField];
    if (!periodDate) continue;
    const periodMs = Date.parse(periodDate + 'T00:00:00Z');
    if (isNaN(periodMs)) continue;
    const ageDays = Math.floor((todayMs - periodMs) / 86400000);
    if (ageDays > budgetDays) overdue.push({ name, periodDate, ageDays, budgetDays });
  }
  return overdue;
}
