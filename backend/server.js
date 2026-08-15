import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

import authRouter from './api/auth.js';
import adminRouter from './api/admin.js';
import watchlistRouter from './api/watchlist.js';
import { requireAuth, ensureAdminUser, normalizeEmail } from './api/auth.js';

import { fetchMacroData } from './api/fetch-macro.js';
import { fetchPolicyData } from './api/fetch-policy.js';
import { fetchAiChainData } from './api/fetch-ai-chain.js';
import chainCfg from './config/ai-chain.config.js';
import {
  calcMonetarySignal,
  calcFinalSignal,
  calcFiscalSignal,
  calcAdminSignal,
  calcAiSupplySignal,
  deriveAiSupplySubSignals,
  deriveSubSignals,
  calcLockActive,
  detectSignalChanges,
  applyYieldCurveVeto,
  applyCreditSpreadVeto,
  applyRealRateVeto,
  applyTrendFloor,
  applyDowngradeHold,
  applyTrendReentry,
  calcTrendState,
} from './api/signal.js';
import signalCfg from './config/signal.config.js';
import { staleKeepIndicators, checkIndicatorFreshness } from './utils/stale-keep.js';
import {
  getLatestSnapshot,
  saveSignalSnapshot,
  getSnapshotHistory,
  getAlertSubscribers,
  getEffectiveBottleneck,
  saveAiChainSnapshot,
  getLatestAiChainSnapshot,
  getAllOverrides,
  getUserById,
  getUserByEmail,
  updateUserAlerts,
  getAllWatchlistSymbols,
  getLatestDailyReport,
} from './utils/storage.js';
import { sendSignalAlert, sendS5ActionAlert, sendOpsAlert, unsubscribeToken } from './utils/mailer.js';
import { prewarmFundamentals } from './api/fundamentals.js';
import { normalizeSymbol, getDailyCloses } from './api/market-data.js';
import { todayET, daysAgoET } from './utils/datetime.js';
import { asyncRoute } from './utils/async-route.js';
import { buildSignalPayload, buildAiChainPayload } from './api/payloads.js';
import { computeLocks } from './api/locks.js';
import { initCatchUp, maybeCatchUp } from './utils/catch-up.js';
import publicRouter from './api/public.js';
import mcpRouter from './api/mcp.js';
import { generateDailyReport } from './api/daily-report.js';
import { processCapexGuidance } from './api/fetch-guidance.js';
import { fetchRadarAiBotTrend } from './api/fetch-radar.js';
import { backupDatabase, restoreDatabaseIfMissing, scheduleUserDataBackup } from './utils/backup.js';
import { setUserWriteListener } from './utils/storage.js';

// 用户侧写入（注册/自选股/override/API key）触发防抖 GitHub 备份：
// 只靠每日 cron 备份，在 Railway 非持久化文件系统上有最长24小时的用户数据丢失窗口
setUserWriteListener(() => scheduleUserDataBackup());

const app = express();
const PORT = process.env.PORT || 3001;

// JWT_SECRET 未配置时（120号）：登录签发/校验实际已不可用，退订 token 还会回退到公开常量
// 'no-secret'（任何人可离线计算全体用户退订 token）。不硬退出（避免云端缺配陷入崩溃循环、
// 连无鉴权的信号接口也瘫掉），但启动即打 CRITICAL 日志要求补配
if (!process.env.JWT_SECRET) {
  console.error('[startup] CRITICAL: JWT_SECRET is not set — auth tokens and unsubscribe HMAC are insecure/broken. Set JWT_SECRET immediately.');
}

// 部署在 Railway：只信任最外层一跳代理，使 req.ip 取到真实客户端 IP（而非代理层 IP，
// 否则所有匿名用户塌缩进同一个 keyless 桶，任一人 25 次即耗尽全网免费额度）。
// 不用 true（信任全链）——那样 X-Forwarded-For 可被客户端完全伪造以刷额度。
// replica（本机，无代理直连）不信任任何跳（120号）：直连场景下 trust proxy 1 会把
// 客户端自带的 X-Forwarded-For 头当真实 IP，全部 IP 限流可被旋转伪造头绕过
app.set('trust proxy', (process.env.INSTANCE_ROLE || 'primary') === 'replica' ? false : 1);

const allowedOrigins = [
  'http://localhost:5173',
  'https://stock-sentinel-eight.vercel.app',
];

// 白名单 CORS 只挂内部 /api/*：全局挂载会先于 /v1、/mcp 处理 OPTIONS 预检
// （cors 默认 preflightContinue:false 直接 204 终结），非白名单来源永远到不了
// 路由级 cors({origin:'*'})，浏览器端第三方集成全部被误拦
app.use('/api', cors({
  origin: allowedOrigins,
}));
app.use(express.json({ limit: '256kb' })); // 限制请求体，防超大 JSON 打满内存

// 内部 /api 保底限流（120号）：CORS 白名单只约束浏览器，脚本/AI 客户端可直打 /api/signal
// 等只读路由绕开 /v1 的 keyless 25/日与付费 key 体系（与"/mcp batch 绕过限流"同构，这次
// 绕的是整个 /api 前缀）。120/min 与 /v1 分钟闸持平：正常前端一次加载十余请求远够用，
// 挡住的是把 /api 当免费开放 API 刷的脚本。auth 路由自带更严格的双层闸（先到先算，正交）
import { ipRateLimit } from './utils/ip-rate-limit.js';
app.use('/api', ipRateLimit({ max: 120 }));

// 网站渠道调用明细埋点（123号用户管理）：登录用户的请求归属到人（最后调用时间/功能热度
// 数据来源）；未登录请求只计端点热度。公开路由（/api/signal 等）不经过 requireAuth，
// 带 Authorization 头也不会挂 req.user——埋点侧做轻量可选解码（HS256 verify 微秒级，
// 解码失败按匿名计，绝不影响请求本身）。auth 登录/注册不记（避免把邮箱枚举尝试写进明细表）
import { callLogger } from './utils/usage-log.js';
import { normalizeIpForQuota } from './utils/ip-rate-limit.js';
import jwt from 'jsonwebtoken';
const webCallLogger = callLogger('web', (req) => {
  // identifier 记归一 IP（125号审查#8）：COUNT(DISTINCT identifier) 跳过 NULL，
  // web 行全 NULL 会让功能热度的"独立来源"列恒为 0；与 api_usage 的 ip: 前缀同惯例
  const identifier = `ip:${normalizeIpForQuota(req.ip)}`;
  if (req.user?.id) return { userId: req.user.id, identifier };
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !process.env.JWT_SECRET) return { identifier };
  try {
    return { userId: jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }).id ?? null, identifier };
  } catch { return { identifier }; }
});
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  return webCallLogger(req, res, next);
});

// --- 路由 ---
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/watchlist', watchlistRouter);
// 开放API（面向AI客户端/第三方开发者）：独立CORS+key限流，见 backend/openapi.yaml
app.use('/v1', publicRouter);
// 远程 MCP 端点（Streamable HTTP）：claude.ai/Smithery 等 URL 型客户端直连，见 backend/api/mcp.js
app.use('/mcp', mcpRouter);

// GET /api/signal — 当前宏观信号 + 各信号位明细
app.get('/api/signal', asyncRoute(async (req, res) => {
  const payload = await buildSignalPayload();
  if (!payload) return res.json({ status: 'loading', message: 'No data yet, cron will run soon' });
  // 补更新钩子（118号）：快照过点未更新（定时任务缺跑/失败）时，被访问即触发后台补跑——
  // 响应立即返回现有数据 + catchUp 标志，前端据此展示"补更新中"并轮询新快照。
  // 绝不提前跑（美东21:45前期望的是昨日快照），只补"该跑而没跑成"的
  const cu = await maybeCatchUp();
  if (cu.overdue) payload.catchUp = cu;
  res.json(payload);
}));

// GET /api/signal/history
app.get('/api/signal/history', asyncRoute(async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 90, 365));
  const history = await getSnapshotHistory(limit);
  res.json(history);
}));

// GET /api/bottleneck — 当前AI产业链最卡脖子环节（公开只读，手动优先否则自动识别）
app.get('/api/bottleneck', asyncRoute(async (req, res) => {
  const bottleneck = await getEffectiveBottleneck();
  res.json(bottleneck);
}));

// GET /api/ai-chain — AI产业链环节排名 + 卡点 + 泡沫监测（公开只读）
// GET /api/daily-report — AI日报（内部，前端展示用）
app.get('/api/daily-report', asyncRoute(async (req, res) => {
  const report = await getLatestDailyReport();
  if (!report) return res.json({ status: 'none' });
  res.json({ date: report.date, zh: report.content_zh, en: report.content_en });
}));

app.get('/api/ai-chain', asyncRoute(async (req, res) => {
  res.json(await buildAiChainPayload());
}));

// GET /api/backtest/summary — 内部路由（前端 track record 页用，不占开放API配额）：
// 2026-07-30 M2 修复配套——前端经 Vercel 代理访问 /v1 时全站访客塌缩进同一 keyless
// IP 桶（25次/日共享），/v1 代理已从 vercel.json 移除，前端改走本内部路由。
// 进程内缓存解析结果（120号）：269KB 文件只在重部署时变，每请求同步 readFileSync+parse 放大 CPU 面
let backtestSummaryCache;
app.get('/api/backtest/summary', asyncRoute(async (req, res) => {
  if (backtestSummaryCache === undefined) {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), 'backtest/backtest-raw.json');
    backtestSummaryCache = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).summary : null;
  }
  if (!backtestSummaryCache) return res.status(404).json({ error: 'not_available' });
  res.json({ summary: backtestSummaryCache });
}));

// GET /api/user/me — 当前用户信息 + 是否是 admin + 邮件提醒开关状态
app.get('/api/user/me', requireAuth, asyncRoute(async (req, res) => {
  const isAdmin = normalizeEmail(req.user.email) === normalizeEmail(process.env.ADMIN_EMAIL || '');
  const user = await getUserById(req.user.id);
  res.json({
    id: req.user.id,
    email: req.user.email,
    isAdmin,
    emailAlerts: !!user?.email_alerts,
  });
}));

// PATCH /api/user/alerts — 开关邮件示警
app.patch('/api/user/alerts', requireAuth, asyncRoute(async (req, res) => {
  const enabled = !!req.body.enabled;
  await updateUserAlerts(req.user.id, enabled);
  res.json({ ok: true, emailAlerts: enabled });
}));

// 一键退订（116号）：邮件 List-Unsubscribe 头指向此端点。POST=RFC 8058 一键退订（邮箱客户端
// 直接调用）；GET=用户点链接的确认路径（同样直接生效，退订宁可过度顺畅不设摩擦）。
// token=HMAC(email, JWT_SECRET)，无会话要求（收件人未必登录着）
const handleUnsubscribe = asyncRoute(async (req, res) => {
  const email = String(req.query.e || '');
  const token = String(req.query.t || '');
  // 常数时间比较（120号）：!== 按字符短路，可被时序侧信道逐位猜 token（退订端点无登录门槛）
  const expected = email ? unsubscribeToken(email) : '';
  const tokenOk = !!email && !!token && token.length === expected.length
    && (await import('crypto')).timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!tokenOk) {
    return res.status(400).send('Invalid unsubscribe link');
  }
  const user = await getUserByEmail(email);
  if (user) await updateUserAlerts(user.id, false);
  res.send('已退订股哨兵示警邮件。You have been unsubscribed from Stock Sentinel alerts. 登录网站可随时重新开启 / Log in to re-enable anytime.');
});
app.get('/api/unsubscribe', handleUnsubscribe);
app.post('/api/unsubscribe', handleUnsubscribe);

// --- cron 任务 ---
// 重入护栏（2026-07-30 审查修复）：启动跑与 21:00 cron 可能重叠（部署恰在 20:5x、
// 或 LLM/行情链路拖长数分钟），并发跑会读到同一 prevSnapshot → 变更告警双发
let dailyUpdateRunning = false;
async function runDailyUpdate() {
  if (dailyUpdateRunning) {
    console.warn('[cron] previous daily update still running, skipping this trigger');
    return;
  }
  dailyUpdateRunning = true;
  try {
    await runDailyUpdateInner();
  } finally {
    dailyUpdateRunning = false;
  }
}

async function runDailyUpdateInner() {
  console.log('[cron] Starting daily signal update...');

  let macroData;
  try {
    macroData = await fetchMacroData();
  } catch (err) {
    console.error('[cron] FRED fetch failed:', err.message);
    // 静默停摆是信号产品最大运营风险：FRED 挂=当日快照不生成=track record 断档，
    // 必须显式告警管理员（告警自身失败只记日志，不砸主链路）
    await sendOpsAlert(process.env.ADMIN_EMAIL, {
      stage: 'FRED宏观数据拉取（当日快照未生成）',
      error: err.message,
      dataDate: (await getLatestSnapshot().catch(() => null))?.date,
    }).catch(() => {});
    return;
  }

  const today = todayET();
  const prevSnapshot = await getLatestSnapshot();

  // FOMC 决议日 FRED 生效滞后窗口（2026-07-30 审查修复，H1）：DFEDTARU 新台阶在决议
  // 次日（叠加发布滞后可达次二日）才出现。这 1-2 天内 calcDecisionPrevRate 会把
  // "决议已开、数据未生效"误判为"按兵不动→宽松"——加息周期每次决议都会产生
  // 单日 tight→loose→tight 的快照污染与一封假"货币转收紧"邮件。修复：该窗口内
  // 沿用上一快照的决议前基线（利率未变时方向自然与前日一致），台阶落地后自动恢复
  const lastRateStepDate = macroData.rateSteps?.[0]?.date ?? null;
  const decisionDataPending = !!macroData.rateDecisionDate
    && (lastRateStepDate === null || lastRateStepDate < macroData.rateDecisionDate)
    && (Date.parse(today) - Date.parse(macroData.rateDecisionDate)) / 86400000 <= 2
    && prevSnapshot?.fred_rate_prev != null;
  if (decisionDataPending) {
    console.log(`[cron] FOMC decision ${macroData.rateDecisionDate} not yet in FRED series, keeping previous rate baseline`);
    macroData.prevRate = prevSnapshot.fred_rate_prev;
  }

  // 货币维 stale-keep（2026-07-30 审查修复，L5）：FRED 返回 200+空观测（不抛错）时
  // currentRate=null 会让货币维静默转 neutral、无声解除收紧——与其他三维的 stale-keep
  // 语义对齐：数据缺失日沿用上一快照判定
  const monetaryStale = macroData.currentRate == null && !!prevSnapshot?.monetary_signal;
  const monetary = monetaryStale ? prevSnapshot.monetary_signal : calcMonetarySignal(macroData);

  // 财政/行政/AI供需自动判定（内部各维度独立容错，永不 throw）
  const policyData = await fetchPolicyData();
  // AI产业链数据串行在 policy 之后拉取，避免与其他 Yahoo 调用并发触发限流
  const chainData = await fetchAiChainData();

  // overrides 提前读取：capex_guidance 指引下修事件是 AI供需判定输入（N3），须在合成前可用
  const overrides = await getAllOverrides();
  const { fiscal: fiscalOverride, administrative: adminOverride, aiSupply: aiSupplyOverride } = overrides;
  const capexGuidanceDowngrade = !!overrides.capexGuidance;

  // AI供需现金流三件套：调用量+capex（chainData）+ 半导体产出（policyData）合成一个维度
  // 单季两值供 capex 侦察兵规则 N1/N2（拦截宽松/两季连负判收紧）；
  // capexGuidanceDowngrade=N3 指引下修人工事件（强制 capex 子信号收紧）
  const aiSupplyInputs = {
    modelUsageTrendPct: chainData.modelUsageTrendPct,
    capexYoY: chainData.capexYoY,
    semiIpYoy: policyData.semiIpYoy,
    capexQtrYoY: chainData.capexQtrYoY,
    capexQtrPrevQtrYoY: chainData.capexQtrPrevQtrYoY,
    capexGuidanceDowngrade,
  };

  const fiscalAuto = calcFiscalSignal(policyData);
  const adminAuto = calcAdminSignal(policyData);
  const aiSupplyAuto = calcAiSupplySignal(aiSupplyInputs);
  const aiSubSignals = deriveAiSupplySubSignals(aiSupplyInputs);

  // OpenRouter 单点交叉验证（120号②，用户拍板）：调用量子信号是三件套里唯一押注单一聚合商
  // 的输入——超大客户绕开聚合商直连时会表现为份额下滑的"假收紧"。当调用量单独报收紧而
  // capex（EDGAR财报）与半导体产出（FRED）两个独立源均无恶化佐证时：收紧照常生效
  // （防守不过夜，历次审查教训"判定链修复均漏防守侧"），但标记分歧+运维邮件请人工核查
  // 是否为份额漂移误报（管理面板可用 ai_supply override 人工纠正）。宽松侧无需交叉：
  // calcAiSupplySignal 的宽松票本就要求三件套全绿才点火
  const usageDivergence = aiSubSignals.usageSignal === 'tight'
    && aiSubSignals.capexSignal != null && aiSubSignals.capexSignal !== 'tight'
    && aiSubSignals.semiSignal != null && aiSubSignals.semiSignal !== 'tight';
  if (usageDivergence && prevSnapshot?.usage_divergence !== 1) {
    // 第二源佐证（120c号）：Cloudflare Radar 全网 AI bot 流量趋势（与 OpenRouter 完全独立），
    // 只进核查邮件不进判定。Radar 同步回落 → 收紧可信；仍增长 → 份额漂移嫌疑增强
    const radarTrendPct = await fetchRadarAiBotTrend().catch(() => null);
    const radarLine = radarTrendPct === null
      ? '第二源（Cloudflare Radar AI bot 流量）未配置或不可用（配 CLOUDFLARE_API_TOKEN 启用）'
      : `第二源 Cloudflare Radar 全网 AI bot 流量 28日趋势 ${radarTrendPct > 0 ? '+' : ''}${radarTrendPct.toFixed(1)}%${radarTrendPct <= -3 ? '——独立源亦见回落，收紧可信度高' : radarTrendPct >= 3 ? '——独立源仍在增长，份额漂移误报嫌疑增强' : '——独立源大致持平'}`;
    console.warn(`[cron] ⚠️ USAGE DIVERGENCE: 模型调用量报收紧(${aiSupplyInputs.modelUsageTrendPct}%)但 capex(${aiSubSignals.capexSignal})/半导体(${aiSubSignals.semiSignal})均无恶化佐证——可能是 OpenRouter 份额漂移误报，请人工核查。${radarLine}`);
    sendOpsAlert(process.env.ADMIN_EMAIL, {
      stage: 'AI调用量与独立源分歧（可能为 OpenRouter 份额漂移误报）',
      error: `调用量趋势 ${aiSupplyInputs.modelUsageTrendPct}% 判收紧，但云厂商capex=${aiSubSignals.capexSignal}、半导体产出=${aiSubSignals.semiSignal}。${radarLine}。收紧已按防守优先生效；若核查确认为份额漂移，请在管理面板用 ai_supply override 纠正`,
    }).catch(() => {});
  }

  // 数据源故障降级保护（stale-keep）：指标全为 null 说明是拉取失败而非"数据显示中性"，
  // 沿用上一快照的自动信号，避免故障日产生虚假的"转中性/解除防守"信号变更与误发告警
  const fiscalStale = policyData.outlaysChangePct == null && !!prevSnapshot?.fiscal_auto_signal;
  // 行政 stale（2026-07-30 审查修复，M3）：EPU 双路全黑即 stale——油价事件层的两个分支
  // （飙升需 EPU 高位、暴跌需 EPU 有数护栏）在 EPU 全缺时都给不出结论，
  // 旧条件"|油价|≥20% 就算有结论"会让 EPU 故障日行政维错误落 neutral（虚假解除收紧）
  const adminStale = policyData.epuTradePercentile == null && policyData.epuDailyPercentile == null
    && !!prevSnapshot?.admin_auto_signal;
  // AI供需 stale：三件套全 null（调用量/capex/半导体产出通道全故障）时沿用上一快照。
  // 单季 capex 也计入"有数据"（2026-07-20 审查修复）：TTM 缺失但单季口径出数时，
  // N2 两季连负仍能给出数据驱动的收紧票，不应被 stale-keep 用旧信号覆盖。
  // N3 活动事件不算"数据缺失"（2026-07-30 审查修复，M1）：指引下修强制收紧是
  // 最高优先级判定，数据全断日也不得被上一快照的旧信号覆盖（与 payload 层同口径）
  const aiDataMissing = aiSupplyInputs.modelUsageTrendPct == null
    && aiSupplyInputs.capexYoY == null && aiSupplyInputs.semiIpYoy == null
    && aiSupplyInputs.capexQtrYoY == null
    && !capexGuidanceDowngrade;
  const aiSupplyStale = aiDataMissing && !!prevSnapshot?.ai_supply_auto_signal;
  const fiscalAutoEff = fiscalStale ? prevSnapshot.fiscal_auto_signal : fiscalAuto;
  const adminAutoEff = adminStale ? prevSnapshot.admin_auto_signal : adminAuto;
  const aiSupplyAutoEff = aiSupplyStale ? prevSnapshot.ai_supply_auto_signal : aiSupplyAuto;

  // 生效值 = 手动覆盖优先，否则自动判定（判定函数保证返回信号串）
  const fiscal = fiscalOverride?.signal || fiscalAutoEff;
  const admin = adminOverride?.signal || adminAutoEff;
  const aiSupply = aiSupplyOverride?.signal || aiSupplyAutoEff;
  // 否决器输入沿用上一快照（120号 M3，用户拍板）：倒挂天数/信用利差当日拉取失败（429/超时）
  // 时旧 fail-open 会放行 attack，次日恢复又收回——单日 attack↔neutral 翻转+一对反向邮件。
  // 对"只限制 attack、不触发防守"的否决器角色，昨日观测仍有效才是 fail-safe；
  // 真正的新库无历史时仍 null → fail-open。生效值同时入库，快照与 payloads 实时重算同口径
  const yieldCurveInvertedDaysEff = macroData.yieldCurveInvertedDays
    ?? prevSnapshot?.yield_curve_inverted_days ?? null;
  const creditSpread90dWidenBpEff = macroData.creditSpread90dWidenBp
    ?? prevSnapshot?.credit_spread_90d_widen_bp ?? null;
  // 实际利率否决器（120号①）：利率/12M截尾PCE 缺失日 fail-open（利率极少缺失；
  // 通胀月度序列有指标级 stale-keep 兜底）
  const decisionTreeSignal = applyRealRateVeto(
    applyCreditSpreadVeto(
      applyYieldCurveVeto(
        calcFinalSignal(aiSupply, monetary, fiscal, admin),
        yieldCurveInvertedDaysEff
      ),
      creditSpread90dWidenBpEff
    ),
    macroData.currentRate, macroData.trimmedPce12m
  );

  const locks = computeLocks(macroData, prevSnapshot, overrides);
  const lockActiveNow = locks.sahmLockActive || locks.reactiveAdjustmentLockActive;

  // 趋势状态（W5 趋势再入场）：SPY 日线≈SPX代理，约13个月窗口保证10个月末收盘；
  // 复权价优先（116号，2026-07-30 用户拍板）：与回测的 Tiingo 总回报口径对齐，
  // 消除生价 SMA 系统性偏高约0.5-0.7%造成的边界月档位漂移；
  // 拉取失败 → 全 null → applyTrendReentry fail-open（不降级，保持原防守行为）
  let trendState = { spxClose: null, spxMa10m: null, spxAboveSma10: null };
  try {
    trendState = calcTrendState(await getDailyCloses('SPY', daysAgoET(400), today, { adjustedPreferred: true }));
  } catch (err) {
    console.warn('[cron] trend state fetch failed (fail-open):', err.message);
  }

  let rawFinalSignal = lockActiveNow ? 'defense' : decisionTreeSignal;
  // W5/X1：上升趋势中树驱动与萨姆锁驱动的 defense 降级 reduce；应对式锁不受趋势否决
  rawFinalSignal = applyTrendReentry(rawFinalSignal, {
    sahmLockActive: locks.sahmLockActive,
    reactiveLockActive: locks.reactiveAdjustmentLockActive,
    spxAboveSma10: trendState.spxAboveSma10,
  });
  // 趋势地板（120号③）：跌破10月SMA时 attack/neutral 托底为 reduce（升档方向，迟滞即时放行）
  rawFinalSignal = applyTrendFloor(rawFinalSignal, trendState.spxAboveSma10);
  // 降档迟滞（V4）：升档即时，降档需持续满确认期才生效（含锁解除后的回落）。
  // 断档不计时（2026-07-30 审查修复，L2）：快照断档期间没有任何"候选档持续温和"的观测，
  // 日历差直接跨隙累计会让停摆 N 天后只观测 1-2 天就满足 30 天确认（过早退出防守，
  // 恰是迟滞要防的方向）——把 pendingSince 前移未观测的天数，只计入有快照的日子
  let pendingSince = prevSnapshot?.final_downgrade_pending_since ?? null;
  if (pendingSince && prevSnapshot?.date) {
    const gapDays = Math.floor((Date.parse(today) - Date.parse(prevSnapshot.date)) / 86400000);
    if (gapDays > 1) {
      const shifted = new Date(Date.parse(pendingSince) + (gapDays - 1) * 86400000);
      pendingSince = shifted.toISOString().slice(0, 10);
      console.warn(`[cron] snapshot gap of ${gapDays} days — downgrade confirm clock shifted to ${pendingSince}`);
    }
  }
  const hold = applyDowngradeHold(
    rawFinalSignal,
    prevSnapshot?.final_signal ?? null,
    pendingSince,
    today
  );
  const finalSignal = hold.signal;

  // 参考指标 stale-keep（114号）：FRED 凌晨维护窗口瞬时故障打成 null 的指标组沿用上一快照
  // （值+参考期整组，展示如实显示旧参考期）。必须位于四维信号/锁/曲线否决计算之后——
  // 只回填落库展示字段，判定链与信号级 stale 标志（上面按原始 null 判定）语义零变化
  const staleKeptGroups = staleKeepIndicators(macroData, policyData, prevSnapshot);
  if (staleKeptGroups.length) {
    console.warn(`[cron] stale-keep: 当日拉取失败，沿用上一快照参考指标组: ${staleKeptGroups.join(', ')}`);
  }

  // 新鲜度看门狗（114b号）：stale-keep 会无限沿用旧值，序列改名/停更这类永久失效会被静默掩盖。
  // 参考期超过该组新鲜度预算（月度100天/日频10天/EPUTRADE 160天）→ 运维告警（不砸主链路）
  const overdueIndicators = checkIndicatorFreshness(macroData, policyData, today);
  if (overdueIndicators.length) {
    const desc = overdueIndicators
      .map(o => `${o.name}(参考期${o.periodDate}，已${o.ageDays}天>预算${o.budgetDays}天)`).join('；');
    console.error(`[cron] 参考指标超龄未更新（疑似序列失效或持续故障）: ${desc}`);
    await sendOpsAlert(process.env.ADMIN_EMAIL, {
      stage: '参考指标超龄未更新（stale-keep 连续沿用旧值，须人工核查数据源）',
      error: desc,
      dataDate: today,
    }).catch(() => {});
  }

  await saveSignalSnapshot({
    date: today,
    monetarySignal: monetary,
    fiscalSignal: fiscal,
    adminSignal: admin,
    aiSupplySignal: aiSupply,
    finalSignal,
    fredRate: macroData.currentRate,
    fredRatePrev: macroData.prevRate,
    fredBalanceSheet: macroData.currentBalanceSheet,
    fredBalanceSheetPrev: macroData.prevBalanceSheet,
    creditSpread: macroData.creditSpread,
    creditSpreadPercentile: macroData.creditSpreadPercentile,
    creditSpread90dWidenBp: creditSpread90dWidenBpEff, // M3：入库生效值，payloads 实时重算同口径
    creditSpreadPeriodDate: macroData.creditSpreadPeriodDate,
    yieldCurveSpread: macroData.yieldCurveSpread,
    yieldCurveInvertedDays: yieldCurveInvertedDaysEff, // M3：同上
    yieldCurvePeriodDate: macroData.yieldCurvePeriodDate,
    fredCorePce: macroData.corePce,
    fredTrimmedPce: macroData.trimmedPce,
    fredUnemployment: macroData.unemployment,
    sahmValue: macroData.sahmValue,
    fredCorePcePrev: macroData.prevCorePce,
    fredTrimmedPcePrev: macroData.prevTrimmedPce,
    fredUnemploymentPrev: macroData.prevUnemployment,
    fredTrimmedPce1m: macroData.trimmedPce1m,
    fredTrimmedPce1mPrev: macroData.prevTrimmedPce1m,
    trimmedPce1mPeriodDate: macroData.trimmedPce1mPeriodDate,
    trimmedPce1mReleaseDate: macroData.trimmedPce1mReleaseDate,
    fredTrimmedPce12m: macroData.trimmedPce12m,
    fredTrimmedPce12mPrev: macroData.prevTrimmedPce12m,
    trimmedPce12mPeriodDate: macroData.trimmedPce12mPeriodDate,
    trimmedPce12mReleaseDate: macroData.trimmedPce12mReleaseDate,
    rateDecisionDate: macroData.rateDecisionDate,
    balanceSheetPeriodDate: macroData.balanceSheetPeriodDate,
    balanceSheetReleaseDate: macroData.balanceSheetReleaseDate,
    balanceSheetStatus: macroData.balanceSheetStatus,
    corePcePeriodDate: macroData.corePcePeriodDate,
    corePceReleaseDate: macroData.corePceReleaseDate,
    trimmedPcePeriodDate: macroData.trimmedPcePeriodDate,
    trimmedPceReleaseDate: macroData.trimmedPceReleaseDate,
    unemploymentPeriodDate: macroData.unemploymentPeriodDate,
    unemploymentReleaseDate: macroData.unemploymentReleaseDate,
    sahmPeriodDate: macroData.sahmPeriodDate,
    sahmReleaseDate: macroData.sahmReleaseDate,
    fiscalAutoSignal: fiscalAutoEff,
    fiscalOutlaysTtm: policyData.outlaysTtm,
    fiscalOutlaysTtmPrev: policyData.outlaysTtmPrev,
    fiscalOutlaysChangePct: policyData.outlaysChangePct,
    fiscalPeriodDate: policyData.fiscalPeriodDate,
    fiscalReleaseDate: policyData.fiscalReleaseDate,
    adminAutoSignal: adminAutoEff,
    epuTrade: policyData.epuTrade,
    epuTradePercentile: policyData.epuTradePercentile,
    epuTradePeriodDate: policyData.epuTradePeriodDate,
    epuDaily: policyData.epuDaily,
    epuDailyPercentile: policyData.epuDailyPercentile,
    epuDailyPeriodDate: policyData.epuDailyPeriodDate,
    oilWti: policyData.oilWti,
    oilChange30dPct: policyData.oilChange30dPct,
    oilPeriodDate: policyData.oilPeriodDate,
    oilSource: policyData.oilSource,
    oilLevelLow: policyData.oilLevelLow === null || policyData.oilLevelLow === undefined
      ? null : (policyData.oilLevelLow ? 1 : 0),
    aiSupplyAutoSignal: aiSupplyAutoEff,
    aiMarketSignal: aiSubSignals.usageSignal,   // 复用列：调用量子信号（原市场代理已移除）
    aiFundamentalSignal: aiSubSignals.semiSignal, // 复用列：半导体产出子信号
    smhSpyRelReturnPct: null,                   // 已移除SMH-SPY股价代理
    semiIpYoy: policyData.semiIpYoy,
    semiIpPeriodDate: policyData.semiIpPeriodDate,
    semiIpReleaseDate: policyData.semiIpReleaseDate,
    modelUsageTrendPct: chainData.modelUsageTrendPct,
    capexYoY: chainData.capexYoY,
    capexQtrYoY: chainData.capexQtrYoY,
    capexQtrEnd: chainData.capexQtrEnd,
    capexQtrPrevQtrYoY: chainData.capexQtrPrevQtrYoY,
    capexSignal: aiSubSignals.capexSignal, // capex子信号生效值（含N1/N2侦察兵规则），前端徽章与payload直读
    aiBubbleWarning: aiSupplyAutoEff === 'tight' ? 1 : 0, // 复用列：AI供需=收紧(供过于求)标记（stale日沿用上次判定，与 ai_supply_signal 同口径）
    sahmLockActive: locks.sahmLockActive ? 1 : 0,
    reactiveAdjustmentLockActive: locks.reactiveAdjustmentLockActive ? 1 : 0,
    reactiveAdjustmentLockTriggerBp: locks.reactiveAdjustmentLockTriggerBp,
    sahmLockSince: locks.sahmLockSince,
    reactiveAdjustmentLockSince: locks.reactiveAdjustmentLockSince,
    finalDowngradePendingSince: hold.pendingSince,
    spxClose: trendState.spxClose,
    spxMa10m: trendState.spxMa10m,
    spxAboveSma10: trendState.spxAboveSma10 === null ? null : (trendState.spxAboveSma10 ? 1 : 0),
    fiscalStale,
    adminStale,
    aiSupplyStale,
    monetaryStale,
    usageDivergence, // 120号②：OpenRouter份额漂移嫌疑标记（告警去重）
  });

  // S5 执行指令邮件（仅管理员，96号）：进/出全面防守是 S5 策略的交易边界，
  // 单独一封高优邮件给出具体操作指令（进=卖出存量TQQQ；出=立即全额买回，含恢复到reduce）。
  // 位置必须紧跟 saveSignalSnapshot：档位已落库后，后续任一步骤（产业链快照/日报/备份）崩溃
  // 都会让次日 prevFinal===finalSignal、这次边界切换的邮件永久丢失——命门指令最先发。
  // prevFinal 为 null（全新库首跑）且当日即 defense 时也要发：存量在不在场与库新旧无关。
  const prevFinal = prevSnapshot?.final_signal ?? null;
  if (process.env.ADMIN_EMAIL && prevFinal !== finalSignal) {
    const enteredDefense = finalSignal === 'defense' && prevFinal !== 'defense';
    const exitedDefense = prevFinal === 'defense' && finalSignal !== 'defense';
    if (enteredDefense || exitedDefense) {
      const r = await sendS5ActionAlert(process.env.ADMIN_EMAIL, {
        kind: enteredDefense ? 'enterDefense' : 'exitDefense',
        from: prevFinal ?? '—',
        to: finalSignal,
        dataDate: today,
      }).catch(err => { console.warn('[cron] S5 action email failed:', err.message); return { failed: 1 }; });
      // 三次重试全败=交易指令丢失，升级为运维告警（走另一封邮件再试三次，双通道降低同时失败概率）
      if (r?.failed) {
        await sendOpsAlert(process.env.ADMIN_EMAIL, {
          stage: `S5执行指令邮件发送失败（${enteredDefense ? '应卖出' : '应买回'}，请立即查看S5执行台）`,
          error: `档位 ${prevFinal} → ${finalSignal}`,
          dataDate: today,
        }).catch(() => {});
      }
    }
  }

  // 示警：最终信号变化 / 任一维度转收紧（用户策略：任一收紧=立即防守，必须果断）。
  // 位置紧跟快照落库与 S5 邮件（2026-07-30 审查修复，M6）：原在日报（2×LLM 60-120s）
  // 与 GitHub 备份之后，进程在这几分钟内崩溃/被平台重启会让订阅者告警永久丢失
  //（次日 prev===final 不再触发）——与 S5 邮件同理，通知先行、增值内容垫后
  const changes = detectSignalChanges(prevSnapshot, {
    finalSignal,
    monetary,
    fiscal,
    admin,
    aiSupply,
    sahmLockActive: locks.sahmLockActive,
    reactiveAdjustmentLockActive: locks.reactiveAdjustmentLockActive,
    reactiveAdjustmentLockTriggerBp: locks.reactiveAdjustmentLockTriggerBp,
  });
  if (changes.length > 0) {
    const subscribers = await getAlertSubscribers();
    if (subscribers.length > 0) {
      console.log(`[cron] ${changes.length} alert-worthy change(s), alerting ${subscribers.length} users`);
      await sendSignalAlert(subscribers, {
        finalSignal,
        changes,
        details: {
          monetary, fiscal, admin, aiSupply,
          fiscalOutlaysChangePct: policyData.outlaysChangePct,
          epuTradePercentile: policyData.epuTradePercentile,
          epuDailyPercentile: policyData.epuDailyPercentile,
          oilChange30dPct: policyData.oilChange30dPct,
          oilLevelLow: policyData.oilLevelLow, // 120号：邮件 dimDetail 复刻油价护栏需要
          semiIpYoy: policyData.semiIpYoy,
          modelUsageTrendPct: chainData.modelUsageTrendPct,
          capexYoY: chainData.capexYoY,
          rateChangeBp: locks.rateDiffBp,
          sahmValue: macroData.sahmValue,
        },
      });
    }
  }

  // 产业链快照独立容错：它的失败不应吞掉后面的示警邮件链
  try {
    await saveAiChainSnapshot({
    date: today,
    autoBottleneck: chainData.autoBottleneck,
    stageMetrics: JSON.stringify(chainData.stages),
    modelUsageTrendPct: chainData.modelUsageTrendPct,
    modelUsageLatestTokens: chainData.modelUsageLatestTokens,
    modelUsageAsOf: chainData.modelUsageAsOf,
    capexYoY: chainData.capexYoY,
    capexTtm: chainData.capexTtm,
    capexPrevTtm: chainData.capexPrevTtm,
    capexQtrYoY: chainData.capexQtrYoY,
    capexQtrSum: chainData.capexQtrSum,
    capexQtrPrevYearSum: chainData.capexQtrPrevYearSum,
    capexQtrEnd: chainData.capexQtrEnd,
    bubbleWarning: aiSupplyAutoEff === 'tight',
    bubbleReasons: JSON.stringify(
      [aiSubSignals.usageSignal === 'tight' && 'usage',
       aiSubSignals.capexSignal === 'tight' && 'capex',
       aiSubSignals.semiSignal === 'tight' && 'semiIp'].filter(Boolean)
    ),
  });
  } catch (err) {
    console.warn('[cron] ai chain snapshot save failed:', err.message);
  }

  console.log(`[cron] Signal updated: aiSupply=${aiSupply}, monetary=${monetary}, fiscal=${fiscal}, admin=${admin} → final=${finalSignal}`);

  // 预热自选股 EDGAR 基本面（24h缓存）：串行队列约每标的1~3秒，
  // 移到 cron 里跑，用户打开自选股页面时命中缓存不再叠加冷加载延时
  try {
    const symbols = await getAllWatchlistSymbols();
    await prewarmFundamentals(symbols.map(normalizeSymbol));
    console.log(`[cron] fundamentals prewarmed for ${symbols.length} watchlist symbols`);
  } catch (err) {
    console.warn('[cron] fundamentals prewarm failed:', err.message);
  }

  // capex 指引自动检测（前瞻信号，失败静默）：财报季检查四大云厂商新业绩8-K的
  // capex指引方向，明确下修自动录入N3事件+邮件；结果存档供前端参考展示。
  // 自动录入的override会在次日cron进入信号判定，当日已由其自身即时邮件通知。
  try {
    const guidance = await processCapexGuidance();
    if (guidance.checked) {
      console.log(`[guidance] checked ${guidance.checked} new earnings filing(s), ${guidance.autoEvents || 0} auto N3 event(s)`);
    }
  } catch (err) {
    console.warn('[cron] capex guidance detection failed:', err.message);
  }

  // AI 日报（增值内容，失败静默）：基于刚保存的快照生成中英双语解读
  // 日报 LLM 生成只在 primary 跑（120c号）：两实例各生成一遍=OpenRouter 成本×2，
  // 本机(replica)日报页展示的是本机库的旧报告、不对外服务；如需本机也生成，配 DAILY_REPORT_ON_REPLICA=1
  if ((process.env.INSTANCE_ROLE || 'primary') !== 'replica' || process.env.DAILY_REPORT_ON_REPLICA === '1') {
    await generateDailyReport(await buildSignalPayload().catch(() => null));
  } else {
    console.log('[cron] replica: daily report LLM generation skipped (set DAILY_REPORT_ON_REPLICA=1 to enable)');
  }

  // 数据库备份到 GitHub 私有仓库（收费产品数据兜底；未配环境变量则跳过）
  await backupDatabase();
}

// 统一错误中间件：asyncRoute 捕获的异常在此收口为 500，而不是 unhandledRejection 崩溃进程
app.use((err, req, res, next) => {
  console.error(`[api] ${req.method} ${req.path} failed:`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal server error' });
});

// 每天美东 21:00 执行（114b号，用户拍板）：盘后财报新闻稿/8-K(16:01-16:30)、电话会及其实录
// 媒体报道(18:00-21:00)、H.15日频利率序列晚间入库、当日SPY收盘价均已就绪，且完全避开
// FRED 美东凌晨维护窗口（此前 06:00 UTC=美东1-2点正撞上，7/25 大面积超时空窗的根因）。
// timezone 钉美东本地时钟，夏令时自动切换（EDT=北京次日09:00，EST=10:00）；
// cron 回调兜底 catch，防止未处理 rejection 终止进程
const alertCronFailure = (source, err) => {
  // 只打 message+stack，不打完整 err 对象：axios 错误对象携带 config.url（FRED api_key 在
  // query 里），整对象落日志等于把密钥写进平台日志
  console.error(`[${source}] daily update failed:`, err?.stack || err?.message || String(err));
  sendOpsAlert(process.env.ADMIN_EMAIL, {
    stage: `${source} 未捕获异常（当日快照可能未生成）`,
    error: err?.message || String(err),
  }).catch(() => {});
};

// 全局未处理 rejection 兜底（120号）：主链路各处已有 catch，这是最后一道网——
// 记录+告警但不退出（Node≥15 默认终止进程，两实例同代码会同死）。
// 已知潜在逃逸点：MCP SDK transport/server.close() 返回的 Promise 未被 await
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.stack || err?.message || String(err));
  sendOpsAlert(process.env.ADMIN_EMAIL, {
    stage: '未处理的 Promise rejection（进程存活，请排查来源）',
    error: err?.message || String(err),
  }).catch(() => {});
});

// 启动顺序（顶层 await）：先尝试从 GitHub 备份恢复丢失的 DB，再开始监听与首次更新。
// Railway 容器文件系统非持久化，重部署即丢库；恢复必须发生在任何 getDb() 之前——
// 若先 listen，首个 API 请求就可能用空库初始化 sql.js 内存句柄，随后 persist() 会把
// 恢复好的文件覆盖回空库（竞态）。恢复失败不阻塞启动（fail-open 空库起步）。
await restoreDatabaseIfMissing()
  .catch(err => console.warn('[startup] restore check failed:', err.message));

// cron 注册必须在 restore 完成之后（120号，与 listen 同理）：node-cron 注册即活，
// 启动恰落在 XX:19:5x / 20:59:5x 且 restore 尚在拉取时，看门狗/每日任务的 getDb()
// 会用空库初始化内存句柄，随后 restore 落盘的文件被下一次 persist() 整库覆盖
cron.schedule('0 21 * * *', () => runDailyUpdate().catch(err => alertCronFailure('cron', err)), { timezone: 'America/New_York' });

// 补更新看门狗（118号）：每小时检查快照是否过点未更新（21:00 任务被错过/中途失败时，
// 此前要等次日才有重试），过期即补跑——用户通常还没打开页面系统就已自愈。
// 注入 runDailyUpdate 后，/api/signal 与 /v1/signal 的访问触发共用同一控制器（30分钟冷却）
initCatchUp(() => runDailyUpdate().catch(err => alertCronFailure('catch-up', err)));
cron.schedule('20 * * * *', () => { maybeCatchUp().catch(() => {}); }, { timezone: 'America/New_York' });

// 管理员账户种子（2026-07-30 审查修复，H3）：配置 ADMIN_PASSWORD 时启动即确保管理员
// 账户存在，且公开注册接口拒绝注册 ADMIN_EMAIL——堵住"空库窗口内任何人抢注管理员
// 邮箱即获管理员权限"的身份抢注面（恢复失败 fail-open 空库启动时该窗口真实存在）
await ensureAdminUser().catch(err => console.warn('[startup] admin seed failed:', err.message));

const httpServer = app.listen(PORT, () => {
  console.log(`[server] Stock Sentinel backend running on http://localhost:${PORT}`);
  // 首次更新放在 listen 成功之后（2026-07-30 审查修复，M8）：端口被占（本机计划任务
  // 实例已在跑，又手动 npm run dev）时进程应立刻退出，而不是先跑一轮完整每日更新
  // （两进程各持独立 sql.js 内存副本，后 persist 者整库覆盖前者的写入）
  runDailyUpdate().catch(err => alertCronFailure('startup', err));
});
httpServer.on('error', err => {
  console.error(`[server] listen failed (${err.code}): ${err.message} — exiting`);
  process.exit(1);
});

// Railway 滚动重部署时向旧容器发 SIGTERM：优雅关闭并以 0 退出，
// 否则 npm 会在每次正常重部署时打出 "npm error signal SIGTERM" 误导为故障
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received (rolling redeploy), shutting down gracefully');
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref(); // 兜底：5秒内未排空连接也退出
});
