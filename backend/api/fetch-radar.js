// AI需求侧第二数据源（120c号，2026-08-04 用户拍板"二源交叉必做"落地）：
// Cloudflare Radar 的 AI 爬虫/代理 HTTP 请求量时序（全网视角，与 OpenRouter 完全独立）。
// 诚实口径：这是"全网 AI 活动"的宏观代理（训练爬虫+AI代理流量），不是推理 API 需求的直测——
// 因此只作为 usage_divergence 分歧核查的独立佐证进运维邮件，**不进判定链**（进判定属新增
// 判定输入，须单独拍板）。OpenRouter 份额漂移误报收紧时：Radar 仍在增长 → 漂移嫌疑增强；
// Radar 同步回落 → 收紧可信度高。
// 配置：CLOUDFLARE_API_TOKEN（免费，仅需 Radar 读权限）；未配置/失败 → null（fail-open，
// 分歧邮件里如实注明"第二源未配置/不可用"）。
import axios from 'axios';

const RADAR_URL = 'https://api.cloudflare.com/client/v4/radar/ai/bots/timeseries';

// 与 OpenRouter 调用量趋势同窗口口径（2026-07-17 定稿：28日均 vs 前28日均）
const WINDOW_DAYS = 28;

/**
 * 纯函数：日频值数组（升序，至少 2×window 天）→ 近window日均 vs 前window日均 变化率%
 * Radar 值是窗口内归一化的（峰值=1），比值口径下归一化系数约掉，变化率仍有效
 */
export function calcRadarTrendPct(values, windowDays = WINDOW_DAYS) {
  const nums = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);
  if (nums.length < windowDays * 2) return null;
  const recent = nums.slice(-windowDays);
  const prior = nums.slice(-windowDays * 2, -windowDays);
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const prev = avg(prior);
  if (prev === 0) return null;
  return (avg(recent) / prev - 1) * 100;
}

let cache = null; // { at, trendPct }
const CACHE_MS = 12 * 3600 * 1000;

/** 近28日 vs 前28日的全网 AI bot 请求量变化率%；未配置 token/失败/数据不足 → null */
export async function fetchRadarAiBotTrend() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return null;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.trendPct;
  try {
    // dateRange=12w（84天）覆盖 2×28 日窗口；aggInterval=1d 日频
    const res = await axios.get(RADAR_URL, {
      params: { dateRange: '12w', aggInterval: '1d', format: 'json' },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
    });
    // Radar 时序响应：result.serie_0.{timestamps, values}（values 为归一化字符串数组）
    const values = res.data?.result?.serie_0?.values;
    const trendPct = calcRadarTrendPct(values);
    cache = { at: Date.now(), trendPct };
    if (trendPct === null) console.warn('[radar] AI bot timeseries 数据不足/形状异常，第二源本轮不可用');
    return trendPct;
  } catch (err) {
    console.warn('[radar] AI bot trend fetch failed (第二源本轮不可用):', err.response?.status || err.message);
    return null; // 失败不缓存：下次分歧核查时重试
  }
}
