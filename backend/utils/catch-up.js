// 快照补更新控制器（118号，2026-07-31 用户提议"打开前端若数据未按时更新则自动刷新"）：
// 每日快照定在美东 21:00（盘后财报/收盘价/宏观数据到齐），**绝不提前跑**——提前触发会生成
// 数据不完整的当日快照污染 track record。本模块只做"过点未更新"的补跑：
//   - 判定过期：最新快照日期 < 期望日期（美东 21:00+45分钟宽限后期望今天，否则期望昨天）
//   - 触发来源：①每小时看门狗 cron（用户还没打开页面通常已自愈）②/api/signal 与 /v1/signal
//     被访问时（打开页面即触发，响应立即返回旧数据+catchUp 标志，前端轮询等新快照）
//   - 防打爆：runDailyUpdate 自带互斥；本层再加 30 分钟冷却（失败场景下访问洪峰不会
//     连环触发 FRED/LLM 全链路）
import { getLatestSnapshot } from './storage.js';

const GRACE_MINUTES = 45;      // 21:00 定时任务常态跑数分钟，45 分钟内不算"没跑"
const COOLDOWN_MS = 30 * 60 * 1000;

/** 美东当前 年月日/时/分（hourCycle h23 防 '24' 边界） */
export function etParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: +parts.hour, minute: +parts.minute };
}

/**
 * 当前时点"应该已存在"的快照日期（ET）：
 * ET 21:45 之后 → 今天；否则 → 昨天（早间重启产生的当日早快照日期 ≥ 昨天，不会误判过期）
 */
export function expectedSnapshotDate(now = new Date()) {
  const { date, hour, minute } = etParts(now);
  if (hour > 21 || (hour === 21 && minute >= GRACE_MINUTES)) return date;
  return etParts(new Date(now.getTime() - 24 * 3600 * 1000)).date;
}

/**
 * 可测试的控制器工厂
 * @param {object} deps - { getLatest, run, cooldownMs?, now? }
 */
export function createCatchUpController({ getLatest, run, cooldownMs = COOLDOWN_MS, now = () => new Date() }) {
  let lastAttemptMs = 0;
  let running = false;
  return {
    async check() {
      const nowD = now();
      const expected = expectedSnapshotDate(nowD);
      const latest = await getLatest().catch(() => null);
      const latestDate = latest?.date ?? null;
      if (latestDate && latestDate >= expected) return { overdue: false };
      // 120号守卫（H1）：runDailyUpdate 写入的日期永远是"今天(ET)"，只有当期望快照就是
      // 今天（即已过今天 21:45）时补跑才补得对。期望=昨天（故障跨过午夜、今天21:45前恢复）
      // 时补跑会生成"提前跑"的今日快照——装着今天上午的数据冒充今晚 21:00 采样点，
      // 既补不上昨天的洞又污染今天的 track record，且今晚正式 cron 会再写一条同日快照。
      // 此场景只报 overdue（前端 stale 横幅照常示警），等今晚 21:00 正式 cron。
      if (expected !== etParts(nowD).date) return { overdue: true, waitingForToday: true };
      if (running) return { overdue: true, running: true };
      const t = nowD.getTime();
      if (t - lastAttemptMs < cooldownMs) return { overdue: true, cooldown: true };
      lastAttemptMs = t;
      running = true;
      // fire-and-forget：API 响应立即返回旧数据（快照生成需数分钟），前端轮询等新数据
      Promise.resolve(run()).catch(() => {}).finally(() => { running = false; });
      return { overdue: true, triggered: true };
    },
  };
}

// --- 进程级单例（server.js 启动时注入 runDailyUpdate；public.js/内部路由共享） ---
let controller = null;

export function initCatchUp(run) {
  controller = createCatchUpController({ getLatest: getLatestSnapshot, run });
}

/** 检查并按需触发补更新；未初始化（如测试环境）时恒返回不过期 */
export async function maybeCatchUp() {
  if (!controller) return { overdue: false };
  return controller.check();
}
