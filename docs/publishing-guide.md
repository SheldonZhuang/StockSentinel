# 发布与分发指南（外部动作逐步教程）

> 本文是股哨兵 AI 变现体系的外部发布操作手册。代码侧全部就绪（commit 3718af5），
> 以下动作需要账号所有者本人完成。每一步都写明"在哪里、点什么、输入什么"。

---

## 第一步：发布 MCP 包到 npm（约10分钟，一次性）

包名 `stock-sentinel-mcp` 已确认未被占用。

1. **注册 npm 账号**（已有可跳过）：浏览器打开 https://www.npmjs.com/signup，填用户名/邮箱/密码，
   收邮件点验证链接。
2. **本机登录**：打开终端（PowerShell），执行：
   ```
   npm login
   ```
   会自动打开浏览器让你授权，登录刚注册的账号即可。终端显示 `Logged in as 你的用户名` 表示成功。
3. **发布**：
   ```
   cd D:\sheldonproject\StockSentinel\mcp
   npm publish
   ```
   首次发布可能要求邮箱二次验证码（OTP），照提示输入。
4. **验证**：浏览器打开 `https://www.npmjs.com/package/stock-sentinel-mcp` 能看到页面即成功。
   此后全世界用户都可以用 `npx -y stock-sentinel-mcp` 一键运行。
5. **以后更新**：改动 mcp/ 代码后，把 `mcp/package.json` 里的 `"version"` 加一位（如 1.0.0 → 1.0.1），
   再 `npm publish` 即可。

---

## 第二步：找到 Railway 后端域名并告诉 Claude（约3分钟）

1. 浏览器打开 https://railway.app → 登录 → 进入 StockSentinel 后端项目
2. 点后端服务卡片 → **Settings** 标签 → **Networking / Public Networking** 区域
3. 看到形如 `xxx.up.railway.app` 的域名就是它（若显示"Generate Domain"按钮，点一下生成）
4. **把这个域名发给 Claude**，Claude 会替换以下三处占位符并推送：
   - `docs/openapi.yaml` 的 `YOUR-BACKEND-DOMAIN`
   - `mcp/README.md` 的 "你的后端域名"
   - MCP 包默认 API 地址（然后发一个 1.0.1 版本）

---

## 第三步：提交三个分发渠道（每个约15~30分钟）

### 3a. MCP 目录（免费流量，最对口的用户群）

- **Smithery**（最大的MCP目录）：打开 https://smithery.ai → 右上角 GitHub 登录 →
  "Add Server" → 填 GitHub 仓库地址 `https://github.com/SheldonZhuang/StockSentinel`（子目录 mcp/）
  和 npm 包名 `stock-sentinel-mcp` → 提交等审核
- **官方社区列表**：打开 https://github.com/modelcontextprotocol/servers → 点 `README.md` →
  右上角铅笔图标（Fork并编辑）→ 在 Community Servers 区按字母序加一行：
  ```
  - [Stock Sentinel](https://github.com/SheldonZhuang/StockSentinel/tree/main/mcp) - US stock attack/defense macro signal system (4-dimension framework, backtested)
  ```
  → 页面底部 "Propose changes" → "Create pull request"，等维护者合并

### 3b. RapidAPI（API 市场，自带计费系统！）

1. 打开 https://rapidapi.com → Sign Up（GitHub 登录最快）
2. 右上角头像 → **My APIs** → **Add New API**
3. 填：API Name `Stock Sentinel — US Stock Attack/Defense Signals`；Category `Finance`；
   选择 **"Use OpenAPI file"** → 上传仓库里的 `docs/openapi.yaml`（第二步替换域名后的版本）
4. 在 **Plans & Pricing** 页配置套餐（RapidAPI 代收钱，你只需绑收款账户）：
   - BASIC 免费：25 请求/日（引流）
   - PRO：如 $9.99/月 1万请求
   - ULTRA：如 $49.99/月 30万请求
5. 点 **Make API Public** 上架。RapidAPI 用户调用时平台会转发请求到你的 Railway 域名

### 3c. GPT Store（ChatGPT 生态）

前提：ChatGPT Plus 订阅。

1. 打开 https://chatgpt.com → 左栏 **GPTs** → 右上 **Create**
2. **Configure** 标签填：
   - Name: `Stock Sentinel 股哨兵`
   - Description: `US stock attack/defense macro signal system. 美股进攻/防守四维信号。For research only.`
   - Instructions: 把仓库里 `skills/stock-sentinel/SKILL.md` 的全文粘贴进去（就是为此准备的）
3. 底部 **Actions** → **Create new action** → **Import from URL** 填：
   `https://raw.githubusercontent.com/SheldonZhuang/StockSentinel/main/docs/openapi.yaml`
   （或直接把 yaml 内容粘贴进 Schema 框）
4. Authentication 选 **API Key** → Auth Type: Custom → Header name: `X-API-Key` →
   填一个你在管理后台签发的 free key
5. 右上 **Create** → 可见范围选 **Everyone**（发布到 GPT Store）

---

## 第四步：Stripe 计费（先不做）

触发条件：有人真的来问付费了。到时两条路选其一：
- **省事路线**：直接用 RapidAPI 的内置计费（3b已配好，平台抽成约20%）
- **自营路线**：Stripe Payment Links（不用写代码：Stripe后台建一个订阅链接，
  用户付款后你在管理后台给他签发 pro key）。真到量大了再做自动化。

---

## 静默运行期（现在 → 1~3个月后）

系统已自动积累公开 Track Record（网站 /track-record）。这期间：
- Railway 保持运行即可（每日 cron 自动出信号+日报）
- 每周花2分钟看一眼 /track-record 是否连续（Claude 已设周一巡检提醒）
- 攒够记录后，这一页就是所有渠道定价的依据
