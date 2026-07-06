# 股哨兵 Stock Sentinel 实施计划

日期：2026-07-05

## 技术栈

- 后端：Node.js + Express + better-sqlite3 + node-cron + bcrypt + jsonwebtoken + axios + Resend
- 前端：Vue3 + Vite + vue-i18n
- 测试：Vitest
- 数据源：FRED API（宏观）+ Yahoo Finance（股票）+ Federal Register API（参考素材）

## 目录结构

```
StockSentinel/
├── backend/
│   ├── package.json
│   ├── server.js
│   ├── data/                          # SQLite 文件（gitignore）
│   ├── config/
│   │   └── signal.config.js
│   ├── api/
│   │   ├── fetch-macro.js
│   │   ├── fetch-stocks.js
│   │   ├── fetch-federal-register.js
│   │   ├── signal.js
│   │   ├── admin.js
│   │   ├── auth.js
│   │   └── watchlist.js
│   ├── utils/
│   │   ├── storage.js
│   │   └── mailer.js
│   └── tests/
│       ├── signal.test.js
│       ├── fetch-macro.test.js
│       └── auth.test.js
├── frontend/
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   └── src/
│       ├── main.js
│       ├── App.vue
│       ├── router.js
│       ├── i18n/
│       │   ├── index.js
│       │   └── locales/ (zh/en/fr/de/es/ja/ko.json)
│       ├── api/
│       │   └── client.js
│       └── components/
│           ├── SignalBadge.vue
│           ├── MacroPanel.vue
│           ├── WatchlistPanel.vue
│           ├── SignalTimeline.vue
│           └── AdminPanel.vue
└── .gitignore
```

## 分步实施

### Step 1: 后端脚手架 + package.json
- backend/package.json（所有依赖固定版本）
- backend/.env（已有 FRED_API_KEY，补充 JWT_SECRET/ADMIN_EMAIL/RESEND_API_KEY）

### Step 2: SQLite 存储模块（storage.js）
- WAL 模式
- 建表：users / signal_snapshots / watchlist / admin_signal_overrides / alert_subscriptions
- 测试：storage 初始化不报错

### Step 3: 信号配置（signal.config.js）
- 决策树规则参数、利率阈值（50bp）、资产负债表变化阈值（±0.25%）
- 固定回溯窗口：利率100天、资产负债表90天

### Step 4: FRED 宏观数据拉取（fetch-macro.js）
- 拉取 DFEDTARU（利率）、WALCL（资产负债表）、PCEPILFE（核心PCE）、PCETRIM6M680SFRBDAL（Trimmed Mean PCE）、UNRATE（失业率）
- 单函数 fetchMacroData()，返回结构化对象
- 测试：mock HTTP 响应，验证返回字段齐全

### Step 5: 货币信号位计算（signal.js）
- calcMonetarySignal(macroData) → 'loose' | 'neutral' | 'tight'
- calcFinalSignal(monetary, fiscal, admin) → 'attack' | 'neutral' | 'defense'
- 决策树：进攻=AND（三全宽松），防守=OR（任一收紧）
- 测试：覆盖所有组合分支（9种：3×3 minus 边界）

### Step 6: Yahoo Finance 股票数据（fetch-stocks.js）
- fetchStockData(symbol, startDate, endDate) → { pricePercentile, currentPE, currentPS }
- 价格百分位用历史收盘价计算
- 测试：mock yahooFinance，验证百分位计算

### Step 7: Federal Register 参考素材（fetch-federal-register.js）
- fetchFederalRegister(category) → 最近20条标题列表
- category: 'fiscal' | 'administrative'
- 关键词过滤：fiscal=["tax","budget","debt","deficit"]; admin=["tariff","trade","technology","export","import"]

### Step 8: Auth API（auth.js + Express 路由）
- POST /api/auth/register（邮箱+密码，bcrypt，返回JWT）
- POST /api/auth/login（bcrypt 校验，返回JWT）
- GET /api/auth/me（JWT 中间件保护）
- 测试：注册/登录/重复注册/密码错误各一个测试用例

### Step 9: Watchlist API（watchlist.js）
- GET /api/watchlist（用户自选股列表，含股票数据）
- POST /api/watchlist（添加股票）
- DELETE /api/watchlist/:symbol（删除）

### Step 10: Admin API（admin.js）
- GET /api/admin/signals（当前财政/行政信号位设定）
- POST /api/admin/signals（设定信号位+有效期，需 ADMIN_EMAIL）
- GET /api/admin/reference（抓取参考素材标题列表）
- GET /api/admin/signal-history（历史记录）

### Step 11: 邮件提醒（mailer.js）
- sendSignalAlert(users, oldSignal, newSignal)
- 用 Resend API 发送
- 测试：mock Resend，验证邮件内容格式正确

### Step 12: Cron + Express 主入口（server.js）
- 每日 UTC 06:00 执行完整数据拉取+信号计算+信号变更检测+邮件通知
- 应用启动时立即执行一次（首次初始化）
- GET /api/signal（返回当前宏观信号+各信号位明细+FRED 指标数值）
- 所有路由注册

### Step 13: 前端脚手架 + i18n
- frontend/package.json
- vite.config.js（proxy /api → localhost:3001）
- i18n 语言包：zh/en/fr/de/es/ja/ko（含所有 UI 文案）
- 自动检测 navigator.language

### Step 14: Vue3 组件
- SignalBadge.vue（文字徽章，三档显示）
- MacroPanel.vue（左栏：信号Badge + 三信号位明细 + FRED指标数值）
- WatchlistPanel.vue（右栏：自选股清单，价格百分位+P/E+P/S）
- SignalTimeline.vue（首页信号历史时间轴）
- AdminPanel.vue（/admin 路由，需 isAdmin）

### Step 15: App.vue + router.js
- 双栏布局（MacroPanel 左 + WatchlistPanel 右）
- 首页含 SignalTimeline
- /admin 路由（仅 admin 可见）
- 语言切换组件

## 测试覆盖目标

| 模块 | 测试用例 |
|------|---------|
| signal.js | 9种信号组合（进攻1/防守5/中性3）|
| fetch-macro.js | mock FRED API，字段齐全，容错 |
| auth.js | 注册、登录、重复注册、密码错误 |
| mailer.js | mock Resend，邮件格式正确 |
| fetch-stocks.js | 百分位计算正确性 |

## 环境变量

```
FRED_API_KEY=<已配置>
JWT_SECRET=<待生成>
ADMIN_EMAIL=<用户设定>
RESEND_API_KEY=<用户注册后提供>
PORT=3001
```
