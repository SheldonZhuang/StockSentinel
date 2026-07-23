# 股哨兵 Stock Sentinel

美股投资进攻/防守信号判断与示警工具：四维数据驱动信号 + 公开 Track Record + 开放 API/MCP。

## 产品定位

股哨兵不做选股建议，只回答"现在是进攻时机还是防守时机"：

- **长线选股**遵循奥地利经济学派（供需决定价格），交由用户自行按"优质国家/龙头产业/龙头企业"原则选定标的。
- **短线时机**遵循政治经济学（政策扰乱市场价格），把 AI 供需与货币/财政/行政政策松紧转化为四档信号：🟢进攻 Attack / 🟡观望 Watch / 🟠减仓观望 Reduce / 🔴全面防守 Defense。
- 进攻 = 买在无人问津处；防守 = 卖在人声鼎沸时。
- 进攻信号采用非对称 AND 逻辑（详见下文），防守信号采用 OR 逻辑（宁可错杀）。

覆盖范围仅限美股（不含房产）。

## 信号计算

四维信号全部自动数据驱动（管理员可手动覆盖），每日 06:00 UTC cron 合成最终信号：

| 信号位 | 数据来源 | 判定规则 |
|---|---|---|
| AI供需（长线主线） | 现金流三件套，沿产业链资金流向：OpenRouter 模型调用量（需求侧）→ SEC EDGAR 云厂商资本开支（投资侧）→ FRED `IPG3344S` 半导体产出同比（供给侧） | 调用量 28日均vs前28日均 >+3% 宽松 / <−3% 收紧；capex 滚动4季同比 >+10% 宽松 / <0% 收紧，另有单季侦察兵规则（最新单季同比<0 拦截宽松；连续两季<0 直接收紧，比 TTM 提前 1-2 个季度）；半导体产出同比 >+5% 宽松 / <0% 收紧。三件套共识：任一环节收缩→收紧（供过于求预警），全链向上→宽松，其余中性 |
| 货币政策 | FRED `DFEDTARU` 利率 + `WALCL` 资产负债表（核心PCE/Trimmed PCE/失业率仅参考展示） | 按最近一次 FOMC 决议方向判定：加息（含渐进25bp）→收紧并保持到下次决议；降息或按兵不动→宽松。单次调整 ≥50bp（不论方向）触发应对式调整锁强制全面防守。QT 只拦截宽松评级不单票定罪（回测实证 QT 年份市场多数上涨） |
| 财政政策 | FRED `MTSO133FMS` 联邦月度支出 | "大市场小政府"原则：滚动12月**实际**（PCE平减）支出同比扩大 >5%→收紧（政府变大），收缩 >5%→宽松（政府瘦身）。用支出不用赤字：减税型赤字不应判收紧 |
| 行政政策 | FRED `EPUTRADE`（月度贸易专项）+ `USEPUINDXD`（日频EPU 7日均线）+ WTI 油价（战争冲击实时代理，期货优先） | 油价30天涨跌 ≥±20% 事件层优先：飙升且 EPU 高位且油价处高位（高于近2年中位，低位反弹不判战争冲击）→收紧；暴跌且 EPU 未高位→宽松。否则 EPU 双源10年百分位 >80→收紧，<50→宽松，双源一致才定档 |

**全局叠加（防守分级）**：

- **进攻（非对称）** = AI供需宽松（主动引擎发动）+ 货币/财政/行政均不收紧（中性即可，任一收紧即否决）+ 无锁 + 美债收益率曲线（10y−3m）未处倒挂确认期（连续倒挂 ≥63 个交易日否决进攻档准入）。
- **仅单维收紧 = 减仓观望**：停止加仓、提高警觉，不必减存量仓位（回测实证：单维收紧月份市场月均收益不低于其他月份）。
- **双维以上收紧或锁激活 = 全面防守**。例外：纯"货币+财政"双维共振（无行政维、无锁）只到减仓观望。
- **锁机制**：萨姆锁（`SAHMREALTIME` ≥0.5）与应对式调整锁（利率单次 ≥50bp）强制全面防守；解锁 = 利率降至 ≤0.25%（零利率区间无条件解锁），或锁龄满60天且触发条件已消失时出现 <50bp 小幅调整。
- **趋势再入场**：市场处上升趋势（最新收盘 ≥ 10个月末收盘SMA）时，决策树与萨姆锁驱动的全面防守降级为减仓观望（应对式调整锁不受趋势否决）。
- **降档迟滞**：升档（更防守方向）即时生效；降档（更宽松方向）需持续满30天确认期。

**可信度工程**：单维度数据源故障时沿用上一次有效判定（stale-keep，前端标灰"数据延迟"），不降级为中性，避免故障日误发"解除防守"警报。行情三层回退（Yahoo→Tiingo→TwelveData），EDGAR 数据带新鲜度校验与错季对齐。

**示警**：档位变化 / 任一维度转收紧 / 泡沫预警 / 锁触发与解除时，通过 [Resend](https://resend.com/) 邮件提醒订阅用户；进/出全面防守另发 S5 执行指令邮件（仅管理员）。

历史回测报告见 [docs/backtest-report.md](docs/backtest-report.md)（防守分级召回 4/4，2008 年精确到顶部前 11 天）。S5 执行手册见 [docs/s5-execution-playbook.md](docs/s5-execution-playbook.md)。

## 面向 AI 时代：开放API / MCP / Skill

任何 AI 客户端或第三方开发者都可以调用信号系统：

| 通道 | 位置 | 说明 |
|---|---|---|
| **开放 REST API** | `/v1/*`（[OpenAPI 规范](docs/openapi.yaml)） | `X-API-Key` 鉴权；免key试用 25次/日/IP，free 250/日，pro 10000/日；密钥在管理后台签发 |
| **MCP Server** | [`mcp/`](mcp/) | Claude Desktop/Cursor 等一行配置接入，6个工具（当前信号/历史/产业链/个股/回测/日报） |
| **Claude Skill** | [`skills/stock-sentinel/`](skills/stock-sentinel/SKILL.md) | 教 AI 正确理解四维框架与解读规范 |
| **AI 日报** | `/v1/daily-report` | 每日 cron 后 LLM 自动生成中英双语信号解读（经 OpenRouter，可配 `AI_REPORT_MODEL`） |
| **公开 Track Record** | 网站 `/track-record` | 每日信号档位不可篡改存档 + 回测成绩，供任何人验证 |

> 所有输出均附免责声明：仅供研究参考，不构成投资建议。

## 技术栈

- **后端**：Node.js + Express + [sql.js](https://github.com/sql-js/sql.js)（WASM SQLite）+ node-cron + bcryptjs + JWT
- **前端**：Vue 3 + Vite + vue-i18n（中/英/法/德/西/日/韩 七语言）
- **测试**：Vitest（499 用例）
- **数据源**：FRED API（宏观/财政/行政/半导体产出/收益率曲线）、行情三层回退 Yahoo→Tiingo→TwelveData（+FMP估值）、SEC EDGAR XBRL（云厂商capex，双口径）、OpenRouter（模型调用量）、Federal Register API（政策参考素材）
- **部署**：Railway（后端）+ Vercel（前端）；数据库每日备份至 GitHub 私有仓库

## 目录结构

```
StockSentinel/
├── backend/
│   ├── server.js              # Express 入口，路由 + cron 任务
│   ├── config/                # signal.config / ai-chain.config / fomc-meetings
│   ├── api/                   # signal / fetch-macro / fetch-policy / fetch-ai-chain / market-data / payloads / mcp / public ...
│   ├── backtest/              # 历史回测引擎与变体守卫
│   ├── utils/                 # storage(sql.js 封装) / mailer(Resend) / backup(GitHub)
│   └── tests/
├── frontend/
│   └── src/
│       ├── components/        # SignalHero / MacroPanel / AiChainPanel / WatchlistPanel / SignalTimeline / AdminPanel ...
│       ├── views/             # HomeView / LoginView / AdminView / TrackRecordView
│       ├── i18n/locales/      # zh en fr de es ja ko
│       └── stores/auth.js
├── mcp/                       # MCP Server（stdio）
├── skills/stock-sentinel/     # Claude Skill
└── docs/                      # 回测报告 / S5手册 / OpenAPI / 方法论评审
```

## 本地运行

### 环境变量

在 `backend/.env` 中配置：

```
FRED_API_KEY=your_fred_api_key
JWT_SECRET=your_jwt_secret
ADMIN_EMAIL=your_admin_email
RESEND_API_KEY=your_resend_api_key
TIINGO_API_KEY=your_tiingo_key         # 行情备用源（可选）
TWELVEDATA_API_KEY=your_twelvedata_key # 行情备用源（可选）
FMP_API_KEY=your_fmp_key               # P/E、P/S 估值补全（可选）
OPENROUTER_API_KEY=your_openrouter_key # 模型调用量监测 + AI日报（可选）
GITHUB_BACKUP_REPO=owner/private-repo  # 数据库每日备份（可选）
GITHUB_BACKUP_TOKEN=fine_grained_pat   # 仅需该仓库 Contents 读写（可选）
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

信号体系已过六轮专家复查与多轮方法论审查（判定逻辑 v2、防守分级、收益率曲线否决、趋势再入场、降档迟滞、capex 单季侦察兵与指引下修事件 N3 均已实证定案），534 测试用例全过，每日云端自动运行并公开存档。capex 指引自动检测为双源（EDGAR 新闻稿 + web 检索电话会/媒体），财报后单公司 capex 快报（单季/TTM 额度同比、本财年/未来指引）自动入档。

**后续迭代**：付费订阅墙的实际启用、移动端原生 App/小程序、Google OAuth 登录接入。
