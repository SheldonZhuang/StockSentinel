import cfg from '../config/signal.config.js';

const {
  SIGNAL, FINAL_SIGNAL, RATE_REACTIVE_ADJUSTMENT_BP, BALANCE_SHEET_PAUSE_THRESHOLD_PCT,
  FISCAL_TTM_CHANGE_THRESHOLD_PCT,
  EPU_PERCENTILE_TIGHT, EPU_PERCENTILE_LOOSE,
  AI_MODEL_USAGE_LOOSE_PCT, AI_MODEL_USAGE_DECLINE_THRESHOLD_PCT,
  AI_CAPEX_YOY_LOOSE_PCT, AI_CAPEX_YOY_TIGHT_PCT,
  AI_SEMI_IP_YOY_LOOSE_PCT, AI_SEMI_IP_YOY_TIGHT_PCT,
  SAHM_TRIGGER_THRESHOLD, ZERO_RATE_FLOOR_PCT, OIL_SHOCK_PCT,
  YIELD_CURVE_INVERSION_CONFIRM_DAYS, LOCK_MIN_AGE_DAYS, FINAL_DOWNGRADE_CONFIRM_DAYS,
} = cfg;

/**
 * 根据 FRED 原始数据判定货币信号位
 * @param {object} macroData - fetchMacroData() 返回的对象
 * @returns {'loose'|'neutral'|'tight'}
 */
export function calcMonetarySignal(macroData) {
  const { rateSignal, balanceSheetSignal } = deriveSubSignals(macroData);

  // 收紧：任何加息（rateSignal=tight，含渐进25bp——加息即资金成本升高，利空）。
  // 单次≥50bp 另经应对式锁强制全面防守（server 层）；QT 不单票定罪收紧——
  // 回测实证：QT是环境收紧而非危机信号（2017/2023等QT年份市场大涨，六次危机
  // 的捕获全部由应对式锁或多维共振触发，无一由QT单独触发）
  if (rateSignal === 'tight') {
    return SIGNAL.TIGHT;
  }

  // 宽松：降息/暂停 AND 资产负债表不收缩（QT仍拦截宽松评级）
  if (rateSignal === 'loose' && balanceSheetSignal !== 'tight') {
    return SIGNAL.LOOSE;
  }

  // 其余（降息/暂停 + QT，或利率数据缺失）
  return SIGNAL.NEUTRAL;
}

/**
 * 分解利率和资产负债表子信号
 *
 * 利率方向规则（2026-07-16 用户拍板，纯方向）：加息=资金成本升高=利空=收紧；降息/暂停=放松。
 *   - 任何加息（Δ>0，含渐进25bp）→ tight（覆盖"温水煮青蛙"，两次决议之间保持收紧）
 *   - 降息或暂停（Δ≤0）→ loose
 *   - 单次 |Δ|≥50bp（不论方向）另触发应对式利率锁 → 强制防守（在 server 层/computeLocks 处理）
 *     ≥50bp 降息虽方向上是 loose，但锁会强制防守（应对式降息=危机中的紧急降息）
 *
 * prevRate 语义（2026-07-17 修复）：调用方须传"最近一次FOMC决议前的利率"（fetch-macro 已封装），
 * 而非日频序列的前一条观测——后者在两次议息之间恒等于现值，会把加息周期几乎全程误判为宽松。
 */
export function deriveSubSignals(macroData) {
  const { currentRate, prevRate, currentBalanceSheet, prevBalanceSheet } = macroData;

  let rateSignal;
  if (currentRate === null || prevRate === null || currentRate === undefined || prevRate === undefined) {
    rateSignal = 'neutral';
  } else {
    const rateDiffBp = Math.round((currentRate - prevRate) * 100); // 正=最近决议加息，负=降息，0=暂停
    rateSignal = rateDiffBp > 0 ? 'tight' : 'loose'; // 加息→收紧（保持到下次决议）；降息/暂停→宽松
  }

  const balanceSheetSignal = deriveBalanceSheetStatus(currentBalanceSheet, prevBalanceSheet);

  return { rateSignal, balanceSheetSignal };
}

/**
 * 资产负债表方向判断：QE 扩张(loose) / 暂停·持平(neutral) / QT 收缩(tight)
 * @returns {'loose'|'neutral'|'tight'}
 */
export function deriveBalanceSheetStatus(current, prev) {
  if (current === null || prev === null) return 'neutral';

  const changePct = ((current - prev) / prev) * 100;
  if (changePct > BALANCE_SHEET_PAUSE_THRESHOLD_PCT) return 'loose'; // QE 扩张
  if (changePct < -BALANCE_SHEET_PAUSE_THRESHOLD_PCT) return 'tight'; // QT 收缩
  return 'neutral'; // 暂停
}

/**
 * 衰退防守锁定判定：萨姆锁 / 应对式调整锁 复用同一套逻辑
 * 解锁条件：零利率区间(<=0.25%，联储降到底=框架内的进攻时刻，无条件解锁)；
 * 或 当天发生非零小幅调整(<50bp，不限方向)——但仅在当天没有触发条件时生效：
 * 萨姆触发是水平型条件（值≥0.5会持续数月），若小幅调整能在萨姆仍触发时解锁，
 * 次日会立即重新锁定，产生"单日解锁→次日重锁"翻转和一对方向相反的示警邮件。
 * rateDiffBp===0（无议息决议日 或 决议暂停）不触发小幅调整解锁
 * @returns {boolean}
 */
/**
 * 衰退防守锁定判定：萨姆锁 / 应对式调整锁 复用同一套逻辑。
 * 解锁条件：零利率区间(<=0.25%，联储降到底=框架内的进攻时刻，无条件解锁)；
 * 或 当天发生非零小幅调整(<50bp，不限方向)——但仅在当天没有触发条件时生效。
 *
 * 设计说明（2026-07-16 回测验证）：曾尝试"萨姆锁只由萨姆值解、应对式锁只由反向调整解"的
 * 更严谨分化规则，但回测证明它让锁在降息周期长期锁死（2022加息锁拖到2024、且2024降息又触发新锁），
 * 防守月数97→166、年化10.9%→7.1%、2009/2020/2023复苏牛捕获率崩溃。
 * 现有"零利率+小幅调整解锁"虽在个别时点（2008-12）偏早，但系统层面平衡了"抓危机"与"不误伤复苏"，是回测最优。
 * @returns {boolean}
 */
export function calcLockActive({ triggerToday, rateDiffBp, currentRate, prevLockActive, lockAgeDays }) {
  const zeroFloorUnlock = currentRate !== null && currentRate !== undefined
    && currentRate <= ZERO_RATE_FLOOR_PCT;
  if (zeroFloorUnlock) return false;

  // 最短锁存期（2026-07-17 V3 采纳）：锁龄不足 60 天时小幅调整不解锁——拦住
  // "危机中 -50bp 锁定后下次会议 -25bp 跟进降息立即解锁"（2007-10 顶部区域满仓实录）。
  // lockAgeDays 为 null/undefined（调用方未提供，如旧快照无锁存日期）时不设限（fail-open 兼容旧行为）
  const lockAgeOk = lockAgeDays === null || lockAgeDays === undefined || lockAgeDays >= LOCK_MIN_AGE_DAYS;
  const smallAdjustmentUnlock = rateDiffBp !== null && rateDiffBp !== undefined && rateDiffBp !== 0
    && Math.abs(rateDiffBp) < RATE_REACTIVE_ADJUSTMENT_BP
    && (!prevLockActive || lockAgeOk);
  if (smallAdjustmentUnlock && !triggerToday) return false;

  return !!prevLockActive || !!triggerToday;
}

/**
 * 档位降档迟滞（2026-07-17 V4 采纳）：升档（更防守方向，含锁强制 defense）即时生效；
 * 降档（更宽松方向）需候选档持续温和满 FINAL_DOWNGRADE_CONFIRM_DAYS 天才生效，
 * 期间沿用上一生效档。回测实证：唯一拦住 2019-12"新冠崩盘前2个月退出防守"的机制，
 * 且消除阈值边界抖动造成的档位翻转与示警邮件（2019-11→12→2020-01 实录）。
 * @param {string} candidate - 本日原始候选档（决策树+锁+曲线否决之后）
 * @param {string|null} prevEffective - 上一快照的生效档
 * @param {string|null} pendingSince - 降档等待开始日（上一快照），无等待为 null
 * @param {string} today - 'YYYY-MM-DD'
 * @returns {{signal: string, pendingSince: string|null}}
 */
export function applyDowngradeHold(candidate, prevEffective, pendingSince, today) {
  const severity = s => ({
    [FINAL_SIGNAL.DEFENSE]: 3, [FINAL_SIGNAL.REDUCE]: 2,
    [FINAL_SIGNAL.NEUTRAL]: 1, [FINAL_SIGNAL.ATTACK]: 0,
  })[s] ?? 1;

  if (!prevEffective || severity(candidate) >= severity(prevEffective)) {
    return { signal: candidate, pendingSince: null }; // 升档/持平即时生效，清空等待
  }
  const since = pendingSince || today;
  const ageDays = Math.floor((Date.parse(today) - Date.parse(since)) / 86400000);
  if (ageDays >= FINAL_DOWNGRADE_CONFIRM_DAYS) {
    return { signal: candidate, pendingSince: null }; // 确认期满，降档生效
  }
  return { signal: prevEffective, pendingSince: since }; // 确认期内沿用上一档
}

/**
 * 财政信号（政策原则"大市场小政府"）：
 * TTM联邦支出同比扩大超阈值 → 收紧（政府变大，损害市场经济）；
 * 收缩超阈值 → 宽松（政府瘦身，利好市场经济）。
 * 用支出而非赤字：赤字混入收入端——减税型赤字（如2017）符合"轻徭薄赋"不应判收紧
 * @param {object} policyData - fetchPolicyData() 返回的对象
 */
export function calcFiscalSignal({ outlaysChangePct }) {
  if (outlaysChangePct === null || outlaysChangePct === undefined) return SIGNAL.NEUTRAL;
  if (outlaysChangePct > FISCAL_TTM_CHANGE_THRESHOLD_PCT) return SIGNAL.TIGHT;
  if (outlaysChangePct < -FISCAL_TTM_CHANGE_THRESHOLD_PCT) return SIGNAL.LOOSE;
  return SIGNAL.NEUTRAL;
}

/**
 * 行政子信号：百分位 → 档位（>80 收紧，<50 宽松）
 */
function epuPercentileSignal(percentile) {
  if (percentile === null || percentile === undefined) return null;
  if (percentile > EPU_PERCENTILE_TIGHT) return SIGNAL.TIGHT;
  if (percentile < EPU_PERCENTILE_LOOSE) return SIGNAL.LOOSE;
  return SIGNAL.NEUTRAL;
}

/**
 * 行政信号：油价事件层优先，其次EPU双代理一致才定档。
 * 油价事件（WTI 30天涨跌幅≥±20%）= 战争/地缘冲突的市场实时定价，精确到日：
 *   飙升 → 战争/供给冲击 → 立即收紧（经OR叠加，无条件——冲击不论来源都利空）；
 *   暴跌 → 需区分两种成因：战争结束/对抗降级（利好）vs 危机需求崩塌（利空，如2025-04关税战恐慌）。
 *   护栏：暴跌只在不确定性指数未处高位（日频EPU≤80分位，缺失时用月度）时判宽松；
 *   EPU同时高企说明是危机型暴跌 → 回落到EPU双代理判定，不误判宽松。
 * 注意：行政宽松只撤掉本维度否决票，进攻仍需四维全宽松且无锁。
 * EPU双代理：月度贸易专项 EPUTRADE（结构性）+ 日频EPU 7日均线（时效性）。
 * 两者都有数据时一致才定档，不一致→观望；单边缺失用可用侧；全缺→观望
 */
export function calcAdminSignal({ epuTradePercentile, epuDailyPercentile, oilChange30dPct, oilLevelLow }) {
  const guardPct = epuDailyPercentile ?? epuTradePercentile; // 优先用更新鲜的日频做护栏
  const guardKnown = guardPct !== null && guardPct !== undefined;
  const uncertaintyHigh = guardKnown && guardPct > EPU_PERCENTILE_TIGHT;

  if (oilChange30dPct !== null && oilChange30dPct !== undefined) {
    // 飙升侧双护栏：①EPU高位（战争冲击必伴随不确定性飙升）②油价水平护栏（2026-07-19 O1采纳）——
    // 危机刚过时EPU必然还在高位，"EPU平静=复苏"假设失效（2009-03低位反弹+25%被误判战争冲击
    // 踏空V型底-17.5pp）；补充条件：仅当油价高于近2年中位（oilLevelLow!==true）才判战争冲击，
    // 低位反弹（2009 $45/2020 $38）放行，高位飙升（2022俄乌 $110）不受影响。null时fail-open不抑制
    if (oilChange30dPct >= OIL_SHOCK_PCT && uncertaintyHigh && oilLevelLow !== true) return SIGNAL.TIGHT;
    // 暴跌侧护栏 fail-closed：EPU双缺时无法区分缓和型vs危机需求型暴跌，不判宽松
    if (oilChange30dPct <= -OIL_SHOCK_PCT && guardKnown && !uncertaintyHigh) return SIGNAL.LOOSE;
  }

  const tradeSignal = epuPercentileSignal(epuTradePercentile);
  const dailySignal = epuPercentileSignal(epuDailyPercentile);

  if (tradeSignal !== null && dailySignal !== null) {
    return tradeSignal === dailySignal ? tradeSignal : SIGNAL.NEUTRAL;
  }
  return tradeSignal ?? dailySignal ?? SIGNAL.NEUTRAL;
}

/**
 * AI供需子信号：纯现金流三件套（沿资金流向）——移除原SMH-SPY股价代理。
 * 每个子信号 loose(供不应求/需求投资旺) / neutral / tight(供过于求/收缩)：
 *   usage    模型调用量趋势（需求侧，最前瞻）：>+3% loose；<-3% tight
 *   capex    云厂商资本开支同比（投资侧）：TTM为主口径 >+10% loose；<0% tight
 *   semiIp   半导体产出同比（供给侧，末端）：>+5% loose；<0% tight
 *
 * capex 单季侦察兵规则（N1/N2，2026-07-20 用户拍板）——TTM是4季滑动平均，
 * 单季刹车被稀释、滞后2-3个财报季，两条规则让单季在关键场景拿到有限判定权：
 *   N1 拦截宽松：单季同比<0 时 capex 不得判 loose（最多 neutral）——最新一季已在收缩，
 *      无论TTM多高都不该投"扩产旺"宽松票。同构先例：资产负债表QT只拦截宽松不单独判收紧。
 *   N2 加速确认收紧：连续两个财报季单季同比<0 → capex 直接判 tight，不等TTM转负
 *      （两季连负基本排除交付节奏噪声，比TTM转负平均提前1-2个季度）。
 *   单季数据缺失（null）时两规则不触发，行为退回纯TTM口径。
 * @returns {{usageSignal, capexSignal, semiSignal}}
 */
export function deriveAiSupplySubSignals({ modelUsageTrendPct, capexYoY, semiIpYoy, capexQtrYoY, capexQtrPrevQtrYoY }) {
  const band = (v, looseTh, tightTh) => {
    if (v === null || v === undefined) return null;
    if (v > looseTh) return SIGNAL.LOOSE;
    if (v < tightTh) return SIGNAL.TIGHT;
    return SIGNAL.NEUTRAL;
  };
  let capexSignal = band(capexYoY, AI_CAPEX_YOY_LOOSE_PCT, AI_CAPEX_YOY_TIGHT_PCT);
  const qtrNeg = capexQtrYoY != null && capexQtrYoY < 0;
  const prevQtrNeg = capexQtrPrevQtrYoY != null && capexQtrPrevQtrYoY < 0;
  if (qtrNeg && prevQtrNeg) {
    capexSignal = SIGNAL.TIGHT;                       // N2：两季连负 → 收紧
  } else if (qtrNeg && capexSignal === SIGNAL.LOOSE) {
    capexSignal = SIGNAL.NEUTRAL;                     // N1：单季转负 → 拦截宽松
  }
  return {
    usageSignal: band(modelUsageTrendPct, AI_MODEL_USAGE_LOOSE_PCT, AI_MODEL_USAGE_DECLINE_THRESHOLD_PCT),
    capexSignal,
    semiSignal: band(semiIpYoy, AI_SEMI_IP_YOY_LOOSE_PCT, AI_SEMI_IP_YOY_TIGHT_PCT),
  };
}

/**
 * AI供需信号：现金流三件套（调用量/capex/半导体产出）共识判定。
 * 供不应求(资金流向上)=宽松；供过于求(向下)=收紧。
 * 规则：取所有有数据的子信号——任一为tight即tight（供过于求是防守信号，用户框架"下降→尽快防守"，
 *   任一环节收缩即警示）；否则全部loose才loose（供不应求需全链一致）；其余neutral；全缺→neutral。
 * @param {object} data - 含 modelUsageTrendPct/capexYoY/semiIpYoy/capexQtrYoY/capexQtrPrevQtrYoY
 */
export function calcAiSupplySignal(data) {
  const { usageSignal, capexSignal, semiSignal } = deriveAiSupplySubSignals(data);
  const subs = [usageSignal, capexSignal, semiSignal].filter(s => s !== null);
  if (!subs.length) return SIGNAL.NEUTRAL;                    // 全缺失
  if (subs.some(s => s === SIGNAL.TIGHT)) return SIGNAL.TIGHT; // 任一环节收缩=供过于求→收紧
  if (subs.every(s => s === SIGNAL.LOOSE)) return SIGNAL.LOOSE; // 全链供不应求→宽松
  return SIGNAL.NEUTRAL;
}

/**
 * 示警变化检测：对比前一快照与本次结果，找出所有值得提醒的事件
 * 用户策略"防守信号出现任意一项就立即防守"→ 不止最终信号变化，任一维度转收紧、泡沫预警触发都要示警
 * @param {object|null} prevSnapshot - 上一条 signal_snapshots 行（下划线列名），无历史时为 null
 * @param {object} current - { finalSignal, monetary, fiscal, admin, aiSupply, sahmLockActive, reactiveAdjustmentLockActive }
 * @returns {Array<{kind, ...}>} 空数组 = 无需示警
 */
export function detectSignalChanges(prevSnapshot, current) {
  if (!prevSnapshot) return []; // 首次运行无对比基准，不示警

  const changes = [];

  if (prevSnapshot.final_signal !== current.finalSignal) {
    changes.push({ kind: 'final', from: prevSnapshot.final_signal, to: current.finalSignal });
  }

  const dims = [
    // 顺序遵循策略主线"长线看供需，短线看政策"：AI供需 → 货币 → 财政 → 行政
    ['aiSupply', prevSnapshot.ai_supply_signal, current.aiSupply],
    ['monetary', prevSnapshot.monetary_signal, current.monetary],
    ['fiscal', prevSnapshot.fiscal_signal, current.fiscal],
    ['admin', prevSnapshot.admin_signal, current.admin],
  ];
  for (const [dim, prev, now] of dims) {
    if (prev !== SIGNAL.TIGHT && now === SIGNAL.TIGHT) {
      changes.push({ kind: 'dimTight', dim, from: prev, to: now });
    }
  }

  if (!prevSnapshot.sahm_lock_active && current.sahmLockActive) {
    changes.push({ kind: 'sahmLockOn' });
  } else if (prevSnapshot.sahm_lock_active && !current.sahmLockActive) {
    changes.push({ kind: 'sahmLockOff' });
  }

  if (!prevSnapshot.reactive_adjustment_lock_active && current.reactiveAdjustmentLockActive) {
    changes.push({ kind: 'reactiveAdjustmentLockOn', bp: current.reactiveAdjustmentLockTriggerBp ?? null });
  } else if (prevSnapshot.reactive_adjustment_lock_active && !current.reactiveAdjustmentLockActive) {
    changes.push({ kind: 'reactiveAdjustmentLockOff' });
  }

  return changes;
}

/**
 * 决策树：四个信号位 → 最终信号（防守分级 + 非对称进攻，2026-07-16 用户拍板）
 * 参数顺序遵循策略主线"长线看供需，短线看政策"：AI供需 → 货币 → 财政 → 行政
 * 全面防守 = 双维以上收紧（多维共振，历史上与真实危机高度重合；锁激活在 server 层强制）
 * 减仓观望 = 仅单维收紧
 * 进攻（非对称）= AI供需宽松（主动看多引擎必须发动）且 货币/财政/行政都不收紧（政策三维作否决项，
 *   中性或宽松均可，任一收紧即否决——解决贸易战/打仗期抢跑：行政收紧则不进攻，等威胁解除再进攻）且 无锁
 * 观望 = 其余
 */
export function calcFinalSignal(aiSupply, monetary, fiscal, admin) {
  const tightCount = [aiSupply, monetary, fiscal, admin].filter(s => s === SIGNAL.TIGHT).length;

  if (tightCount >= 2) {
    // X3（2026-07-18 归因采纳）：纯"货币+财政"双维共振降为 reduce——防守共振须含行政维
    // （或锁，锁在 server 层强制）。归因：2004-08 假防守段=渐进加息25bp+财政TTM同比5.4%
    // 擦线过阈值的纯噪声（当时EPU仅6.7分位，世界毫无危险）。只实施经回测检验的最窄口径：
    // AI供需参与的共振（未被历史检验，且AI是用户长线主线）保持 defense 不动
    if (tightCount === 2 && monetary === SIGNAL.TIGHT && fiscal === SIGNAL.TIGHT) {
      return FINAL_SIGNAL.REDUCE;
    }
    return FINAL_SIGNAL.DEFENSE;
  }
  if (tightCount === 1) return FINAL_SIGNAL.REDUCE;

  // 进攻（非对称）：AI供需宽松 且 政策三维都不收紧（此处 tightCount===0 已保证无收紧，
  // 只需再要求 AI供需=宽松）。锁在 server 层强制防守，不会走到这里。
  if (aiSupply === SIGNAL.LOOSE) {
    return FINAL_SIGNAL.ATTACK;
  }

  // 观望（含 AI供需中性、政策三维不收紧的情形）
  return FINAL_SIGNAL.NEUTRAL;
}

/**
 * 收益率曲线否决器（2026-07-17，参考指标的唯一判定角色）：
 * 10y−3m 连续倒挂 ≥ 确认期（63个交易日≈3个月）时，进攻档降级为观望——
 * 曲线倒挂是最经受检验的衰退领先指标（领先12-18个月，1968年以来零漏报），
 * 倒挂确认期内不开最激进档位。只否决 attack，不触发防守、不做锁
 * （吸取信用利差锁误锁复苏期的教训：领先指标适合"不抢跑"，不适合"强制离场"）。
 * server 层与 payloads 层共用本函数，保证快照与实时读取同口径。
 * @param {string} signal - calcFinalSignal 的结果
 * @param {number|null} invertedDays - 连续倒挂交易日数（数据缺失时 null → 不否决，fail-open）
 */
export function applyYieldCurveVeto(signal, invertedDays) {
  if (signal !== FINAL_SIGNAL.ATTACK) return signal;
  if (invertedDays === null || invertedDays === undefined) return signal;
  return invertedDays >= YIELD_CURVE_INVERSION_CONFIRM_DAYS ? FINAL_SIGNAL.NEUTRAL : signal;
}

/**
 * 趋势状态（W5 趋势再入场用）：SPY 最新收盘 vs 含当月的最近10个"月末收盘"简单均线。
 * 与回测同口径：回测在月末采样，SMA 含当月月末收盘；线上日频的当月等价值=最新收盘。
 * @param {Array<{date: string, close: number}>} bars - 日线（升序或乱序均可，内部按日期排序）
 * @returns {{spxClose: number|null, spxMa10m: number|null, spxAboveSma10: boolean|null}}
 *          数据不足10个月 → 全 null（调用方 fail-open）
 */
export function calcTrendState(bars) {
  const valid = (bars || [])
    .filter(b => b && b.date && Number.isFinite(b.close))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!valid.length) return { spxClose: null, spxMa10m: null, spxAboveSma10: null };

  // 每个自然月取最后一根收盘（当月为止损益=最新收盘）
  const byMonth = new Map();
  for (const b of valid) byMonth.set(b.date.slice(0, 7), b.close);
  const monthly = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, c]) => c);
  const spxClose = valid[valid.length - 1].close;
  if (monthly.length < 10) return { spxClose, spxMa10m: null, spxAboveSma10: null };

  const spxMa10m = monthly.slice(-10).reduce((a, b) => a + b, 0) / 10;
  return { spxClose, spxMa10m, spxAboveSma10: spxClose >= spxMa10m };
}

/**
 * 趋势再入场加速器（2026-07-17 W5 采纳；2026-07-18 X1 扩展至萨姆锁）：
 * 市场处上升趋势（最新收盘≥10月SMA）时，**决策树驱动**与**萨姆锁驱动**的全面防守降级为
 * 减仓观望；应对式调整锁驱动的防守不受趋势否决（X1b 实测：应对式锁也过趋势门会砸掉
 * 2008 年顶部前入场，08少亏 58.1→50.7pp，否决）。
 * X1 归因依据：2024-08 萨姆锁为萨姆规则 1970 年来首次假阳性（移民推高失业率），当时市场
 * 全程在 10 月 SMA 上方；而 2001/2008/2020 三次真触发时市场均已跌破趋势线，趋势门不影响真危机。
 * trendUp 为 null（数据不足/拉取失败）时不降级（fail-open）。
 */
export function applyTrendReentry(signal, { sahmLockActive, reactiveLockActive, spxAboveSma10 }) {
  if (signal !== FINAL_SIGNAL.DEFENSE || reactiveLockActive) return signal;
  return spxAboveSma10 === true ? FINAL_SIGNAL.REDUCE : signal;
}
