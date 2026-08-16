# 三平台上架材料包（逐字段复制粘贴，2026-08-16）

> 配套 publishing-guide.md 第三步/第五步。登录动作只能账号所有者完成；
> 以下每个字段都可直接粘贴，无需再组织文字。

---

## ① Smithery 描述替换（已收录，需修一处过时文案）

现状：https://smithery.ai/servers/sdzhuang/stock-sentinel-mcp 已收录（82/100，6 工具齐全），
但 Overview 描述还是一个月前的旧框架文案（含已移除的 "SMH-SPY relative return"）。

登录 Smithery → 该 server 页 → Edit/Settings → Description 整段替换为：

```
Daily US stock market attack/defense signals from a data-driven 4-dimension macro framework:
AI supply-demand (model usage + cloud capex + semiconductor output, the cash-flow chain),
monetary (FOMC decision direction), fiscal (real federal outlays), and administrative policy
(EPU + oil shock). 4 tiers: attack / watch / reduce / defense, with recession locks,
attack-admission vetoes (yield curve, credit spread, real rates) and a public 26-year backtest
+ tamper-evident daily track record. For research reference only — not investment advice.
```

---

## ② RapidAPI 上架（publishing-guide 3b，全字段）

登录 https://rapidapi.com（GitHub 登录）→ My APIs → Add New API：

| 字段 | 粘贴内容 |
|---|---|
| API Name | `Stock Sentinel — US Stock Attack/Defense Signals` |
| Short Description | `Daily US market attack/defense signal (4 tiers) from a 4-dimension macro framework, with 26-year backtest and public track record. Research only.` |
| Category | `Finance` |
| Specs 导入 | **Use OpenAPI URL**：`https://stocksentinel-production-55ed.up.railway.app/v1/openapi.yaml`（或上传仓库 `backend/openapi.yaml`） |
| Base URL | `https://stocksentinel-production-55ed.up.railway.app/v1` |
| Tags | `stocks, macro, market-timing, signals, ai, investing-research` |

Long Description（About 页）：

```
Stock Sentinel answers one question every day: is now an attack window or a defense window
for US equities?

• 4 data-driven dimensions: AI supply-demand (model usage + cloud capex + semiconductor
  output), monetary (FOMC decision direction), fiscal (real federal outlays), administrative
  policy (EPU + oil shock).
• 4 output tiers: attack / watch / reduce / defense. Attack uses asymmetric AND logic with
  three veto gates (yield-curve inversion, credit-spread widening, real rates); defense
  fires on OR logic with recession locks (Sahm rule, ±50bp reactive moves).
• Updated daily at 21:00 US Eastern after earnings and closing prices land.
• Verifiable: 26-year monthly backtest covering 6 crises, plus a public tamper-evident
  daily track record at https://stock-sentinel-eight.vercel.app/track-record
• 6 endpoints: current signal, signal history, AI-chain bottleneck ranking, stock price
  percentile (+real P/E & P/S from SEC EDGAR), backtest summary, bilingual AI daily report.

All output is for research reference only — not investment advice.
```

Plans & Pricing（三档，与 pricing-and-ops.md 定价一致）：

| Plan | 价格 | 配额 |
|---|---|---|
| BASIC | $0 | 25 请求/日（Rate limit 25/day） |
| PRO | $9.99/月 | 10,000 请求/日 |
| ULTRA | $49.99/月 | 300,000 请求/月 |

注意：RapidAPI 会用自己的网关转发请求。上架后如需按 RapidAPI 订阅者区分配额，
把 RapidAPI 生成的代理密钥当作一个 pro key 在管理后台签发绑定即可（量小时先不折腾）。

最后点 **Make API Public**。

---

## ③ GPT Store（publishing-guide 3c，全字段）

前提：ChatGPT Plus。登录 https://chatgpt.com → GPTs → Create → Configure：

| 字段 | 粘贴内容 |
|---|---|
| Name | `Stock Sentinel 股哨兵` |
| Description | `US stock attack/defense macro signal system — 4-dimension data-driven framework with 26-year backtest and public track record. 美股进攻/防守四维信号。For research only, not investment advice.` |
| Instructions | 粘贴仓库 `skills/stock-sentinel/SKILL.md` **全文**（就是为此准备的） |
| Conversation starters | `现在是进攻还是防守时机？` / `What's today's US market signal?` / `AI产业链现在卡点在哪个环节？` / `Show the track record for the past 90 days` |
| Actions → Import from URL | `https://stocksentinel-production-55ed.up.railway.app/v1/openapi.yaml` |
| Authentication | API Key → Custom → Header name `X-API-Key` → 填管理后台签发的一个 free key |
| **Privacy policy**（发布到 Everyone 必填） | `https://stock-sentinel-eight.vercel.app/privacy.html` ✅ 已上线（2026-08-16） |

右上 Create → 可见范围 **Everyone**。

---

## 发布后回填

每完成一项，回 publishing-guide 第五步清单打 ✅（日期+链接），保持文档与现实一致。
