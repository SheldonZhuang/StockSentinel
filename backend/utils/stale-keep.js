// 参考指标 stale-keep（114号）：FRED 美东凌晨维护窗口的瞬时故障会把独立降级序列打成 null，
// 落库后前端整天显示"暂无数据"。月度/日频参考序列的上一日观测依然有效——保存快照前，
// 值仍为 null 的指标按"组"沿用上一快照（值+参考期+发布日整组带走，展示层的数据参考期
// 如实显示旧日期，不伪造新鲜度）。
//
// 边界（授权边界原则）：只回填落库/展示字段，不改判定输入——调用方必须在四维信号、锁、
// 收益率曲线否决全部算完之后再调用；信号级 stale-keep（fiscal/admin/aiSupply）语义不变，
// stale 标志在回填前已按原始 null 判定完毕。

// [组名, 目标对象选择器('macro'|'policy'), {内存字段: 快照列名}]，每组首字段为判空主键
const GROUPS = [
  ['corePce', 'macro', { corePce: 'fred_core_pce', prevCorePce: 'fred_core_pce_prev', corePcePeriodDate: 'core_pce_period_date', corePceReleaseDate: 'core_pce_release_date' }],
  ['trimmedPce1m', 'macro', { trimmedPce1m: 'fred_trimmed_pce_1m', prevTrimmedPce1m: 'fred_trimmed_pce_1m_prev', trimmedPce1mPeriodDate: 'trimmed_pce_1m_period_date', trimmedPce1mReleaseDate: 'trimmed_pce_1m_release_date' }],
  ['trimmedPce', 'macro', { trimmedPce: 'fred_trimmed_pce', prevTrimmedPce: 'fred_trimmed_pce_prev', trimmedPcePeriodDate: 'trimmed_pce_period_date', trimmedPceReleaseDate: 'trimmed_pce_release_date' }],
  ['trimmedPce12m', 'macro', { trimmedPce12m: 'fred_trimmed_pce_12m', prevTrimmedPce12m: 'fred_trimmed_pce_12m_prev', trimmedPce12mPeriodDate: 'trimmed_pce_12m_period_date', trimmedPce12mReleaseDate: 'trimmed_pce_12m_release_date' }],
  ['unemployment', 'macro', { unemployment: 'fred_unemployment', prevUnemployment: 'fred_unemployment_prev', unemploymentPeriodDate: 'unemployment_period_date', unemploymentReleaseDate: 'unemployment_release_date' }],
  ['sahm', 'macro', { sahmValue: 'sahm_value', sahmPeriodDate: 'sahm_period_date', sahmReleaseDate: 'sahm_release_date' }],
  ['creditSpread', 'macro', { creditSpread: 'credit_spread', creditSpreadPercentile: 'credit_spread_percentile', creditSpread90dWidenBp: 'credit_spread_90d_widen_bp', creditSpreadPeriodDate: 'credit_spread_period_date' }],
  ['yieldCurve', 'macro', { yieldCurveSpread: 'yield_curve_spread', yieldCurveInvertedDays: 'yield_curve_inverted_days', yieldCurvePeriodDate: 'yield_curve_period_date' }],
  ['epuTrade', 'policy', { epuTrade: 'epu_trade', epuTradePercentile: 'epu_trade_percentile', epuTradePeriodDate: 'epu_trade_period_date' }],
  ['epuDaily', 'policy', { epuDaily: 'epu_daily', epuDailyPercentile: 'epu_daily_percentile', epuDailyPeriodDate: 'epu_daily_period_date' }],
  ['semiIp', 'policy', { semiIpYoy: 'semi_ip_yoy', semiIpPeriodDate: 'semi_ip_period_date', semiIpReleaseDate: 'semi_ip_release_date' }],
  ['fiscal', 'policy', { outlaysTtm: 'fiscal_outlays_ttm', outlaysTtmPrev: 'fiscal_outlays_ttm_prev', outlaysChangePct: 'fiscal_outlays_change_pct', fiscalPeriodDate: 'fiscal_period_date', fiscalReleaseDate: 'fiscal_release_date' }],
  ['oil', 'policy', { oilWti: 'oil_wti', oilChange30dPct: 'oil_change_30d_pct', oilPeriodDate: 'oil_period_date', oilSource: 'oil_source', oilLevelLow: 'oil_level_low' }],
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
