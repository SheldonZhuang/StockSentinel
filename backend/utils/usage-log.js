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

export async function flushCallLogs() {
  if (!buffer.length) return;
  const batch = buffer.splice(0, buffer.length);
  try {
    await insertCallLogs(batch);
  } catch (err) {
    console.warn('[usage-log] flush failed:', err.message);
    // 回插重试（保持容量上限）：明细丢失可接受，但瞬时故障不应直接丢
    buffer.unshift(...batch.slice(-Math.max(0, BUFFER_MAX - buffer.length)));
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

/**
 * Express 中间件工厂：响应结束时记录（拿到最终状态码；req.user 由链上 requireAuth 挂载，
 * 'finish' 时刻已可读——web 渠道未登录的请求 userId 为空，只计入端点热度不归属用户）。
 * getMeta 可选：从 req 提取 { userId, keyId, identifier }（/v1、/mcp 的 key 归属由 rateLimit 挂到 req）
 */
export function callLogger(channel, getMeta = null) {
  return (req, res, next) => {
    // 端点串必须在进入时捕获：'finish' 事件触发时 Express 已把 req.baseUrl/path 重置回挂载前值
    const endpoint = (req.baseUrl + (req.path === '/' ? '' : req.path)).slice(0, 120) || '/';
    res.on('finish', () => {
      try {
        const meta = getMeta ? getMeta(req) : {};
        recordCall({
          channel, endpoint, status: res.statusCode,
          userId: meta.userId ?? req.user?.id ?? null,
          keyId: meta.keyId ?? null,
          identifier: meta.identifier ?? null,
        });
      } catch { /* 埋点绝不砸请求路径 */ }
    });
    next();
  };
}
