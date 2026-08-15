// 按次调用明细埋点（123号用户管理）：内存缓冲 + 批量落盘。
// sql.js persist 是 O(库体积) 的全库导出，绝不能每请求写库——与 public.js 用量刷盘同一取舍。
// 崩溃最多丢一个缓冲窗口的明细（长期底账 api_usage 不受影响）。
import { insertCallLogs, pruneCallLogs } from './storage.js';

const buffer = [];
const BUFFER_MAX = 5000;        // 超限丢弃最旧的（明细是运营观测数据，不是计费底账，可承受截断）
const FLUSH_INTERVAL_MS = 600_000; // 与 public.js 用量刷盘同节奏
const RETENTION_DAYS = 30;      // 用户拍板：明细保留30天

let lastPruneDay = null;

function nowUtc() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 记录一次调用（同步、零 IO）。在 res 'finish' 时调用以拿到最终状态码。
 * @param {{userId?: number, keyId?: number, identifier?: string, channel: 'web'|'v1'|'mcp', endpoint: string, status?: number}} entry
 */
export function recordCall(entry) {
  if (buffer.length >= BUFFER_MAX) buffer.shift();
  buffer.push({ ts: nowUtc(), ...entry });
}

// 单飞守卫（125号审查#6）：admin 三个读接口 + 10分钟定时器可能并发触发 flush——
// persist() 的临时文件按 pid 命名，同进程两次并发写同名文件再各自 rename 会落坏文件。
// 并发调用共享同一个进行中的 Promise，天然串行化。
let flushInFlight = null;

export function flushCallLogs() {
  flushInFlight ??= doFlush().finally(() => { flushInFlight = null; });
  return flushInFlight;
}

async function doFlush() {
  if (!buffer.length) return;
  const batch = buffer.splice(0, buffer.length);
  try {
    await insertCallLogs(batch);
  } catch (err) {
    console.warn('[usage-log] flush failed:', err.message);
    // 有界重插（125号审查#1）：只回插缓冲还容得下的部分，且必须先判 room>0——
    // 旧写法 slice(-Math.max(0,room)) 在 room=0 时是 slice(-0)=slice(0)=整个数组，
    // 故障期每轮全量回插+新流量 → 内存无界增长直至 unshift 爆栈
    const room = BUFFER_MAX - buffer.length;
    if (room > 0) buffer.unshift(...batch.slice(-room));
    return;
  }
  // 每日一次清理保留期外明细
  const day = new Date().toISOString().slice(0, 10);
  if (lastPruneDay !== day) {
    lastPruneDay = day;
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000)
      .toISOString().slice(0, 19).replace('T', ' ');
    await pruneCallLogs(cutoff).catch(err => console.warn('[usage-log] prune failed:', err.message));
  }
}

const flushTimer = setInterval(() => { flushCallLogs().catch(() => {}); }, FLUSH_INTERVAL_MS);
flushTimer.unref();

// 端点值域封闭（125号审查#2）：未匹配路由的 404 归并到哨兵值、已知动态段归一——
// 否则攻击者旋转随机路径（120/min IP 闸内）30天可造 ~594MB 脏行：拖慢每次 persist、
// 撑爆 GitHub 备份 Contents API ~100MB 上限、令 GROUP BY 统计卡住事件循环
const DYNAMIC_SEGMENTS = [
  [/^\/v1\/stock\/[^/]+$/, '/v1/stock/:symbol'],
  [/^\/api\/watchlist\/[^/]+$/, '/api/watchlist/:symbol'],
  [/^\/api\/admin\/users\/\d+\/usage$/, '/api/admin/users/:id/usage'],
  [/^\/api\/admin\/users\/\d+$/, '/api/admin/users/:id'],
  [/^\/api\/admin\/api-keys\/\d+$/, '/api/admin/api-keys/:id'],
];

export function normalizeEndpoint(endpoint, status) {
  for (const [re, canonical] of DYNAMIC_SEGMENTS) {
    if (re.test(endpoint)) return canonical;
  }
  // 404 = 未匹配任何路由：路径是攻击者可控的无界值域，归并为哨兵（保渠道级计数，弃路径明细）
  if (status === 404) return '_unmatched';
  return endpoint.slice(0, 120);
}

/**
 * Express 中间件工厂：响应结束时记录（拿到最终状态码）。
 * 端点串必须在进入时捕获：'finish' 事件触发时 Express 已把 req.baseUrl/path 重置回挂载前值。
 * getMeta 可选：从 req 提取 { userId, keyId, identifier }（/v1、/mcp 的 key 归属由 rateLimit 挂到 req）
 */
export function callLogger(channel, getMeta = null) {
  return (req, res, next) => {
    const rawEndpoint = (req.baseUrl + (req.path === '/' ? '' : req.path)) || '/';
    res.on('finish', () => {
      try {
        const meta = getMeta ? getMeta(req) : {};
        recordCall({
          channel,
          endpoint: normalizeEndpoint(rawEndpoint, res.statusCode),
          status: res.statusCode,
          userId: meta.userId ?? req.user?.id ?? null,
          keyId: meta.keyId ?? null,
          identifier: meta.identifier ?? null,
        });
      } catch { /* 埋点绝不砸请求路径 */ }
    });
    next();
  };
}
