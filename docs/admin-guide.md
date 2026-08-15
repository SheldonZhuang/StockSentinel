# 后台管理功能说明（Admin Guide）

> 路径：网站 `/admin`（仅 `ADMIN_EMAIL` 账号可见）。所有接口挂 `requireAdmin`（JWT + 管理员邮箱校验）。
> 本文档与代码同步维护；改动后台功能时须同步更新本文（123/124号约定）。

## 模块总览

| 模块 | 作用 | 后端接口 |
|---|---|---|
| S5 执行台 | 当前档位→S5 策略持仓状态与今日动作（仅管理员） | `GET /api/admin/s5` |
| 信号位设定 | 手动覆盖财政/行政/AI供需/capex指引下修（N3 事件） | `GET/POST /api/admin/signals` |
| 锁应急清除 | 萨姆锁/应对式调整锁误触发时人工清锁与撤销 | `POST /api/admin/lock-override` |
| 参考素材 | Federal Register / 英伟达新闻 / TrendForce 检索 | `GET /api/admin/reference` |
| 卡点设定 | AI 产业链最卡脖子环节（手动优先，否则自动） | `POST /api/admin/bottleneck` |
| 设定历史 | 全部 override 操作审计 | `GET /api/admin/signal-history` |
| 开放API密钥 | 签发/禁用/绑定归属用户 | `GET/POST/PATCH /api/admin/api-keys` |
| **用户管理与API用量监控（123号）** | 见下文 | `/api/admin/users*`、`/api/admin/endpoint-stats` |
| 手动备份 | 触发 GitHub 数据库备份验证链路 | `POST /api/admin/backup` |

## 用户管理与 API 用量监控（2026-08-15，123号）

目的：看清**每个用户在用什么功能、用量多少、是否付费、剩余多少额度/天数**，
并从全局看出**哪些功能最被需要**，指导资源投放方向。

### 用户列表

`GET /api/admin/users?search=<邮箱模糊>&page=<n>`（每页 50）

每行字段：

| 字段 | 说明 | 口径 |
|---|---|---|
| 注册时间 | `users.created_at` | |
| 订阅状态 | 订阅中 / 已过期 / 免费 | `is_subscribed=1 且(无到期时间 或 到期在未来)` = 订阅中（`isSubscriptionActive` 单一口径） |
| 剩余时间 | 订阅到期倒计时 | ≤7 天橙色告警，已过期红色 |
| 今日API用量/配额 (UTC) | 名下 key 今日开放API调用 / 生效配额档 | **UTC 日切**（与配额本身同口径，与全站美东展示不同，故标签注明）；生效档 = 最高 key 档，pro 需订阅有效否则按 free 计 |
| 近7天/近30天 | 全渠道（web+v1+mcp）调用次数 | `api_call_logs` 明细表（保留30天） |
| 调用总量 | 开放API历史底账 + 近30天 **web** 明细 | `api_usage`（400天，已含近30天的 v1/mcp）+ web_30d——125号审查#5修正：旧口径把全渠道30天整个相加，v1/mcp 被双计 |
| 最后调用 | 全渠道最近一次调用时间 | |

操作：**启用/禁用**（禁用即时生效：bump `token_min_iat` 杀存量 JWT + 名下 key 视同禁用 +
登录返回 403 + **停发一切示警邮件**；禁用=封禁，125号拍板。管理员不能禁用自己——后端 403 +
前端隐藏按钮，防不可自解的自锁）、**编辑订阅**（设到期时间即视为订阅用户，范围限 2000-2100
防垃圾值静默降级付费客户；清空+取消勾选=退回免费）。

### 用户用量详情（行内展开）

`GET /api/admin/users/:id/usage?days=7|30&channel=web|v1|mcp&page=<n>`

- **按日调用量**：柱状图（渠道可筛选）
- **端点 TOP**：该用户最常用的功能（最多20条）
- **调用明细**：逐次日志（时间/渠道/端点/状态码，每页100条），429/4xx/5xx 标红——
  用户反复撞 429 是升级 pro 的销售信号

### 全局功能热度

`GET /api/admin/endpoint-stats?days=7|30`

近周期各端点调用量、独立用户数、独立来源数（含匿名 IP 与未绑定 key 流量）。
**这是"在用户最需要的方向加强资源投放"的直接依据**：调用量高且独立用户多的端点值得优先投入；
高调用量但全是匿名试用流量的端点是转化漏斗的入口。

### 订阅与到期语义（2026-08-15 用户拍板）

- 订阅纯手动管理（与 Stripe Payment Links 手动签发流程配套）：管理员在用户管理里设到期时间。
- **到期自动降级**：pro key 绑定了归属用户且订阅过期 → 配额自动按 free（250/日）计，
  key 本身不禁用（客户续费、管理员改到期时间即恢复，生效延迟上界 = key 缓存 5 分钟）。
- 无归属用户的存量 pro key 行为不变（永久 pro），管理员可随时在密钥表绑定用户使其纳入订阅管理。

### 调用明细埋点实现（改动前必读）

- 三渠道埋点：`/v1`（rateLimit 后挂 `req.usageMeta`）、`/mcp`（端点=工具名 `tool:<name>`）、
  `/api`（web，公开路由带 Bearer 头时埋点侧轻量 JWT 解码归属到人，identifier 记归一 IP；
  登录/注册路由不记）。**三渠道即全部可调用通道**：stdio MCP 包与 GPT Actions 都走 /v1，
  远程 MCP 走 /mcp，Skill 是教学文档不产生调用。
- **写路径必须批量**：sql.js persist 是 O(库体积) 全库导出，明细在内存缓冲
  （`utils/usage-log.js`，上限5000条丢最旧），10分钟批量落库一次（单事务+prepared statement，
  125号实测比逐条快20倍）；管理端读接口先 flush 保证实时。flush 有单飞守卫（并发共享同一
  Promise，防 persist 临时文件竞态）；失败重插有界（只回插缓冲容得下的部分）。
- **端点值域封闭**（125号审查#2）：未匹配路由的 404 归并 `_unmatched` 哨兵、已知动态段归一
  （`/v1/stock/:symbol` 等）——否则攻击者旋转随机路径 30 天可造 ~594MB 脏行拖垮 persist
  与 GitHub 备份。
- 端点串在中间件**进入时**捕获——`finish` 事件触发时 Express 已重置 `req.baseUrl`（实测教训）。
- 保留期 30 天（每日清理）；按天聚合的 `api_usage` 计费底账不受影响仍 400 天。

## 管理员鉴权

- 管理员 = `ADMIN_EMAIL` 环境变量邮箱（非库内角色位）；配 `ADMIN_PASSWORD` 时启动种子账户并封锁抢注。
- 前端 `/admin` 路由守卫 `requiresAdmin`；后端每个接口独立 `requireAdmin`，前端守卫只是体验层。
