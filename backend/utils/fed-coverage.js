// 决议结果覆盖检查（127b，2026-09-17）：决议日当天若 Fed 声明拿不到/解析不出，
// 系统会静默退回 FRED 的日更滞后值——即"显示持平、方向可能反了"的老问题重现，
// 而唯一的痕迹只是一行日志。本模块把它升级为可告警的判定。
//
// 两个独立信息源交叉验证：
//   ① FOMC 日历（config/fomc-meetings.js）：告知"今天本该有决议结果"
//   ② Fed 官网 RSS/声明（fetch-fed-rate.js）：告知"我们是否真的拿到了"
// 只有"日历说是决议日"而"没拿到声明"才是异常；两者都缺时无从判断，不发告警（避免噪声）。
//
// 去重：同一决议日只告警一次（进程内按日期记），否则每小时看门狗会重复发信。
const alertedDates = new Set();

/**
 * 构建决议结果覆盖状态（纯函数，便于测试）
 * @param {object} p
 * @param {string} p.today - 'YYYY-MM-DD'（ET）
 * @param {boolean} p.isDecisionDate - 日历判定今天是决议日
 * @param {boolean} p.gotStatement - 本次是否成功取到并解析出 Fed 声明
 * @param {string} p.rateSource - 'fed_statement' | 'fred'
 * @param {string|null} p.rateDecisionDate - 本次判定使用的决议日
 * @param {string|null} p.lastRateStepDate - FRED 序列最近台阶日
 * @returns {{alert: boolean, stage?: string, message?: string}}
 */
export function buildFedCoverageStatus({
  today, isDecisionDate, gotStatement, rateSource, rateDecisionDate, lastRateStepDate, fedStatementDate,
}) {
  // 日历说今天不是决议日 → 无事可做（临时会议不在日历内属已知局限，交由 RSS 侧自然识别。
  // 注意调用方已把"声明本身的日期＝今天"并入 isDecisionDate，故临时会议仍会被覆盖检查）
  if (!isDecisionDate) return { alert: false };

  // 本次决议结果是否已落实？三条任一成立即算落实——
  //   ① Fed 声明顶替已生效（rateSource='fed_statement'）：加息/降息且区间有变；
  //   ② FRED 台阶已收录（台阶日 ≥ 决议日）：序列已成权威；
  //   ③ 今天的声明已成功取到并解析（fedStatementDate=today）：覆盖路径是否顶替无关紧要——
  //      按兵不动时区间未变，applyFedDecisionOverride 有意不顶替（序列口径本就正确），
  //      但"我们确实读到了今天的决议结果"这一点已经成立，不该误报。
  // 必须分开看这三条：漏掉③会把每一次"按兵不动"的决议都报成故障。
  const overrideActive = rateSource === 'fed_statement' && !!rateDecisionDate;
  const fredCaughtUp = !!rateDecisionDate && !!lastRateStepDate && lastRateStepDate >= rateDecisionDate;
  const statementRead = !!fedStatementDate && fedStatementDate === today;
  if (overrideActive || fredCaughtUp || statementRead) return { alert: false };

  // 日历确认为决议日，却既没读到声明、FRED 台阶也没落地 → 正在用过时数据判定方向
  return {
    alert: true,
    stage: `FOMC 决议日未取到 Fed 声明（货币方向可能失真，${today}）`,
    message: `日历判定 ${today} 为 FOMC 决议日，但本次决议结果三条落实路径都未成立：`
      + `Fed 声明${gotStatement ? '已取到但未生效' : '未取到/解析失败'}，`
      + `FRED 最近台阶日=${lastRateStepDate || '无'}（决议日=${rateDecisionDate || '无'}），`
      + `利率取值来源=${rateSource}，声明日期=${fedStatementDate || '无'}。`
      + `货币维可能按"暂停→宽松"误判（方向可能反了），网页与决策系统暂时沿用决议前状态。请人工核查：`
      + `① Fed 官网该日声明页面是否改版或改变措辞（解析正则需同步）；`
      + `② 网络/RSS 是否可达；③ 若确认决议结果，可在管理面板用 override 人工纠正货币维`,
  };
}

/**
 * 带进程内去重的告警发送：同一决议日只发一次。
 * @param {object} status - buildFedCoverageStatus 的返回
 * @param {string} today
 * @param {Function} sendAlert - sendOpsAlert 签名 (email, payload) => Promise
 * @param {string|undefined} adminEmail
 * @returns {Promise<boolean>} 是否实际发出
 */
export async function sendFedCoverageAlert({ status, today, sendAlert, adminEmail }) {
  if (!status.alert || !adminEmail) return false;
  if (alertedDates.has(today)) return false;
  alertedDates.add(today);
  try {
    await sendAlert(adminEmail, { stage: status.stage, message: status.message, error: status.message });
  } catch (err) {
    // 告警失败不阻止重试：把去重标记撤回，让下一次看门狗再试
    alertedDates.delete(today);
    console.warn('[fed-coverage] alert send failed:', err.message);
    return false;
  }
  return true;
}

/** 测试用：清空去重状态 */
export function _resetFedCoverageAlerts() {
  alertedDates.clear();
}
