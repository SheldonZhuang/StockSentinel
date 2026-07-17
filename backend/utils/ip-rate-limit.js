// 轻量按 IP 保底限流：内存滑动计数，供 /mcp 与 /auth 等无 key 路径兜底，
// 防止匿名高频请求打满 CPU（bcrypt）/ 烧第三方 API 配额 / 撑爆缓存。
// 与 public.js 的日额度计费限流正交：这里是"每分钟保底闸"，不做计费对账。
const buckets = new Map(); // `${实例序号}:${ip}` → { windowStart, count }
const WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000; // 上限防内存 DoS：超限时清最旧一批
let instanceSeq = 0;

/**
 * @param {object} opts
 * @param {number} opts.max     每窗口最大请求数
 * @param {function} [opts.keyFn] 自定义取键（默认 req.ip）
 * @returns Express 中间件
 */
export function ipRateLimit({ max, keyFn }) {
  // 每个中间件实例独立命名空间：/v1(120)、/mcp(60)、/auth(20) 各有各的 max，
  // 共享同一 ip 桶会让宽松路由的正常流量吃掉严格路由的额度（刷满 /v1 后登录被 20/min 闸误封）
  const scope = `${instanceSeq++}:`;
  return function (req, res, next) {
    const key = scope + (keyFn ? keyFn(req) : req.ip || 'unknown');
    const now = Date.now();

    if (buckets.size > MAX_BUCKETS) {
      // 简单淘汰：删掉已过期的桶；仍超限则清空（宁可短暂放宽也不 OOM）
      for (const [k, v] of buckets) {
        if (now - v.windowStart > WINDOW_MS) buckets.delete(k);
      }
      if (buckets.size > MAX_BUCKETS) buckets.clear();
    }

    let b = buckets.get(key);
    if (!b || now - b.windowStart > WINDOW_MS) {
      b = { windowStart: now, count: 0 };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.windowStart + WINDOW_MS - now) / 1000)));
      return res.status(429).json({ error: 'rate_limited', message: `Too many requests (max ${max}/min per IP)` });
    }
    next();
  };
}
