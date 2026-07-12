# 股哨兵 Stock Sentinel

美股投资进攻/防守信号判断与示警工具。

## 产品定位

股哨兵不做选股建议，只回答"现在是进攻时机还是防守时机"：

- **长线选股**遵循奥地利经济学派（供需决定价格），交由用户自行按"优质国家/龙头产业/龙头企业"原则选定标的。
- **短线时机**遵循政治经济学（政策扰乱市场价格），工具核心价值是把货币/财政/行政三方面政策松紧转化为清晰的 🟢进攻 / 🟡中性 / 🔴防守 三档信号。
- 进攻 = 买在无人问津处（政策松无可松）；
- 防守 = 卖在人声鼎沸时（政策开始收紧）。
- 进攻信号采用 AND 逻辑（三方面政策必须同时宽松），防守信号采用 OR 逻辑（宁可错杀）。

覆盖范围仅限美股（不含房产）。

## 信号计算

四维信号全部自动数据驱动（管理员可手动覆盖），每日通过决策树合成最终信号：

| 信号位 | 数据来源 | 判定规则 |
|---|---|---|
| AI供需（长线主线） | SMH−SPY 90天相对收益（三层行情回退）+ FRED `IPG3344S` 半导体产出同比 | 相对收益 ±8%、产出同比 >+5%/<0%，双源一致才定档；泡沫预警触发强制收紧 |
| 货币政策 | FRED `DFEDTARU` 利率 + `WALCL` 资产负债表（核心PCE/Trimmed PCE/失业率仅参考展示） | 单次调整 ≥50bp 应对式→收紧；资产负债表 ±0.25% 判 QE/QT |
| 财政政策 | FRED `MTSDS133FMS` 联邦月度赤字 | "大市场小政府"原则：滚动12月赤字同比扩大 >5%→收紧（政府扩张），收窄 >5%→宽松（政府收缩） |
| 行政政策 | FRED `EPUTRADE`（月度贸易专项）+ `USEPUINDXD`（日频EPU 7日均线）+ `DCOILWTICO`（WTI油价，战争冲击实时代理） | 油价30天涨跌 ≥±20% 事件层优先：飙升=战争/供给冲击→立即收紧；暴跌且EPU未处高位=战争结束/降级→立即宽松（EPU同时高企=危机需求型暴跌，不判宽松）；否则EPU双源10年百分位 >80→收紧，<50→宽松，一致才定档 |

**全局叠加（防守分级）**：进攻 = 四维全宽松（AND）；仅单维收紧 = 减仓观望（部分仓位）；双维以上收紧 = 全面防守；萨姆锁（`SAHMREALTIME` ≥0.5）与应对式调整锁（利率单次 ≥50bp）激活时强制全面防守，直到零利率或 <50bp 小幅调整解锁。

**泡沫监测**（按 AI 产业链现金流向排序）：模型调用量趋势（OpenRouter，7日/28日均量 <−10% 预警）→ 云厂商滚动4季资本开支（SEC EDGAR，同比 <0% 预警）→ 半导体产出同比。任一预警 → AI供需强制收紧。

**可信度工程**：单维度数据源故障时沿用上一次有效判定（stale-keep，前端标灰提示"数据延迟"），不降级为中性，避免故障日误发"解除防守"警报。

档位变化 / 任一维度转收紧 / 泡沫预警触发时，通过 [Resend](https://resend.com/) 邮件提醒订阅用户。

个股/ETF 维度展示自选标的的历史价格百分位位置，以及当前 P/E、P/S 快照（不做买卖建议）。

历史回测报告见 [docs/backtest-report.md](docs/backtest-report.md)。详细设计见 [docs/superpowers/specs/2026-07-05-stock-sentinel-design.md](docs/superpowers/specs/2026-07-05-stock-sentinel-design.md)。

## 技术栈

- **后端**：Node.js + Express + [sql.js](https://github.com/sql-js/sql.js)（WASM SQLite）+ node-cron + bcryptjs + JWT
- **前端**：Vue 3 + Vite + vue-i18n（中/英/法/德/西/日/韩 七语言）
- **测试**：Vitest
- **数据源**：FRED API（宏观/财政/行政/半导体产出）、行情三层回退 Yahoo→Tiingo→TwelveData（+FMP估值）、SEC EDGAR XBRL（云厂商capex）、OpenRouter（模型调用量）、Federal Register API（政策参考素材）

## 目录结构

```
StockSentinel/
├── backend/
│   ├── server.js              # Express 入口，路由 + cron 任务
│   ├── config/signal.config.js
│   ├── api/                   # fetch-macro / fetch-stocks / fetch-federal-register / signal / admin / auth / watchlist
│   ├── utils/                 # storage(sql.js 封装) / mailer(Resend)
│   └── tests/
└── frontend/
    └── src/
        ├── components/        # SignalBadge / MacroPanel / WatchlistPanel / SignalTimeline / AdminPanel
        ├── views/              # HomeView / LoginView / AdminView
        ├── i18n/locales/       # zh en fr de es ja ko
        └── stores/auth.js
```

## 本地运行

### 环境变量

在 `backend/.env` 中配置：

```
FRED_API_KEY=your_fred_api_key
JWT_SECRET=your_jwt_secret
ADMIN_EMAIL=your_admin_email
RESEND_API_KEY=your_resend_api_key
TIINGO_API_KEY=your_tiingo_key        # 行情备用源（可选）
TWELVEDATA_API_KEY=your_twelvedata_key # 行情备用源（可选）
FMP_API_KEY=your_fmp_key              # P/E、P/S 估值补全（可选）
OPENROUTER_API_KEY=your_openrouter_key # 模型调用量泡沫监测（可选）
PORT=3001
```

### 启动后端

```bash
cd backend
npm install
npm run dev      # node --watch server.js
npm test         # vitest run
```

### 启动前端

```bash
cd frontend
npm install
npm run dev       # http://localhost:5173，代理 /api 到 localhost:3001
npm run build
```

## 当前状态

MVP 已完成：信号计算、鉴权、自选股、后台管理、邮件提醒、多语言 UI，27/27 测试通过。

**MVP 范围之外**（后续迭代）：付费订阅墙的实际启用、个股估值指标扩展、移动端原生 App/小程序、Google OAuth 登录接入。
