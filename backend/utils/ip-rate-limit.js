// 轻量按 IP 保底限流：内存滑动计数，供 /mcp 与 /auth 等无 key 路径兜底，
// 防止匿名高频请求打满 CPU（bcrypt）/ 烧第三方 API 配额 / 撑爆缓存。
// 与 public.js 的日额度计费限流正交：这里是"每分钟保底闸"，不做计费对账。
const buckets = new Map(); // `${实例序号}:${ip}` → { windowStart, count }
const WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000; // 上限防内存 DoS：超限时清最旧一批
let instanceSeq = 0;

// IPv6 按 /64 归桶（2026-07-30 L6 引入于 public.js 日额度；120号下沉到此处让分钟闸同享）：
// 家宽 IPv6 前缀内可轮换 2^64 个地址，完整 IP 计数=每个地址一份新额度，还可借海量地址
// 灌满 MAX_BUCKETS 触发 clear() 清掉所有人的计数；/64 是单用户典型分配粒度
export function normalizeIpForQuota(ip) {
  if (!ip || !ip.includes(':')) return ip || 'unknown';
  const bare = ip.replace(/^::ffff:/, ''); // IPv4-mapped 原样走 IPv4 路径
  if (!bare.includes(':')) return bare;
  const full = bare.includes('::') ? expandIpv6(bare) : bare.split(':');
  return full.slice(0, 4).join(':') + '::/64';
}
function expandIpv6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  return [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
}

/**
 * @param {object} opts
 * @param {number} opts.max     每窗口最大请求数
 * @param {function} [opts.keyFn] 自定义取键（默认 req.ip 经 /64 归一）
 * @returns Express 中间件
 */
export function ipRateLimit({ max, keyFn }) {
  // 每个中间件实例独立命名空间：/v1(120)、/mcp(60)、/auth(20) 各有各的 max，
  // 共享同一 ip 桶会让宽松路由的正常流量吃掉严格路由的额度（刷满 /v1 后登录被 20/min 闸误封）
  const scope = `${instanceSeq++}:`;
  return function (req, res, next) {
    const key = scope + (keyFn ? keyFn(req) : normalizeIpForQuota(req.ip));
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
