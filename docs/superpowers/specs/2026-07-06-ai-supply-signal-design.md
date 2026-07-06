# AI供需信号位 + 产业链面板 + 观望文案 设计文档

日期：2026-07-06

## 1. 背景与目标

在现有货币/财政/行政三信号位决策树基础上，新增第四个信号位——AI供需信号位，衡量AI产业链资金流向反映出的供需紧张程度（"卡脖子"程度）。同时新增一个静态产业链地图面板供用户参考投资标的，并将"中性"档位文案改为"观望"。

## 2. AI供需信号位

### 2.1 语义

- **宽松（loose）**：AI产业链卡脖子现象持续或加剧——供不应求、龙头厂商定价权提升，反映AI资本开支超级周期仍在加速，利好AI产业链相关股票，支持"进攻"。
- **收紧（tight）**：卡脖子缓解、产能追上需求，可能预示周期见顶或转冷，支持"防守"。
- **观望（neutral）**：其余情况。

设计意图与货币信号位一致：这不是对AI板块估值高低的判断，而是对产业链供需紧张趋势方向的判断。

### 2.2 判定方式

与财政/行政信号位相同——**管理员人工设定**当前档位（宽松/观望/收紧）+ 有效期，到期自动回归观望。不接入自动化数据源计算，因为AI供需紧张程度不存在类似FRED利率的单一权威量化指标。

参考素材：管理员在设定信号位时，可参考"产业链面板"（见第3节）中标注的当前卡脖子环节和相关标的走势，自行判断。

### 2.3 决策树扩展

`calcFinalSignal` 从三元扩展为四元：

- **进攻**：货币、财政、行政、AI供需**四个信号位全部**为宽松（AND）
- **防守**：四个信号位中**任意一个**为收紧（OR）
- **观望**：其余情况

与现有防守用OR（宁可错杀）、进攻用AND（无人问津需四方面同时确认）的设计哲学完全一致。

## 3. 产业链面板（AiChainPanel）

### 3.1 内容

静态展示AI产业链资金流向地图（管理员定期手动更新维护）：

```
企业/个人用户付费
  ↓
AI大模型厂商：Anthropic / OpenAI / Google Gemini
  ↓
云厂商：Google / Amazon / 微软 / Meta + Newclouds（Nebius NBIUS）
  ↓
AI芯片厂商
  ├─ GPU训练芯片：英伟达（CUDA生态龙头）
  ├─ 定制ASIC推理芯片：博通(AVGO) / Google TPU / Arm
  └─ CPU：英伟达 / AMD / Intel
  ↓
存储：HBM——SK海力士 / 三星 / 美光
  ↓
先进封装与设备：TSMC(TSM) CoWoS / Lam Research(LRCX) / Applied Materials(AMAT) / 科磊(KLAC)
光模块：Coherent(COHR) / Lumentum(LITE) / Marvell / AAOI
  ↓
电力能源：Bloom Energy(BE)
```

每个环节展示：环节名称（i18n翻译）+ 代表性股票代码（不翻译，全球通用）。

### 3.2 当前卡脖子环节标记

管理员后台可设定当前"最卡脖子环节"（从产业链固定环节列表中选择一个，如"先进封装"），前端面板对应节点高亮显示。设定方式与信号位类似，但不需要"有效期"概念——直接覆盖式更新（无历史记录需求，因为这是当前状态标注而非信号档位）。

### 3.3 展示位置

首页 `HomeView.vue`，双栏工作台（宏观信号+自选股）下方、信号历史时间轴上方，新增独立卡片区域。

## 4. 观望文案

将 `signal.neutral` 和 `signalPos.neutral` 两个 i18n key 的显示文案从"中性"改为"观望"（及对应外语翻译）。范围覆盖：最终信号（进攻/观望/防守）和四个子信号位（货币/财政/行政/AI供需各自的宽松/观望/收紧）全部同步修改。

后端内部信号值仍为字符串 `'neutral'`，不改变代码逻辑，仅改前端展示文案。

各语言对照：

| 语言 | 中性 → |
|---|---|
| 中文 | 观望 |
| English | Watch |
| Français | Attente |
| Deutsch | Abwarten |
| Español | Observar |
| 日本語 | 様子見 |
| 한국어 | 관망 |

## 5. 数据模型改动

### 5.1 `signal_snapshots` 表

新增字段：`ai_supply_signal TEXT`

### 5.2 `admin_signal_overrides` 表

无需改表结构（`type` 字段本身是自由字符串）。新增支持 `type='ai_supply'` 的记录，复用现有 `setAdminSignal`/`getActiveAdminSignal`/`getAdminSignalHistory` 函数。

### 5.3 新增 `ai_chain_bottleneck` 表

```sql
CREATE TABLE IF NOT EXISTS ai_chain_bottleneck (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage TEXT NOT NULL,
  note TEXT,
  set_by TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
)
```

只保留最新一条记录的语义（每次设定视为覆盖当前状态，查询时取 `updated_at` 最新一行）。

## 6. 后端接口改动

### 6.1 `backend/api/signal.js`

`calcFinalSignal(monetary, fiscal, admin, aiSupply)` — 新增第四个参数，AND/OR判断逻辑同步扩展。

### 6.2 `backend/server.js`

- `runDailyUpdate()`：读取 `getActiveAdminSignal('ai_supply')`，传入 `calcFinalSignal`，快照保存新增 `aiSupplySignal` 字段
- `GET /api/signal`：响应体新增 `aiSupplySignal` 字段

### 6.3 `backend/api/admin.js` 与 `backend/server.js`

- `admin.js`：`VALID_TYPES` 新增 `'ai_supply'`；新增 `POST /api/admin/bottleneck`（管理员设定当前卡脖子环节，需鉴权）
- `server.js`：新增 `GET /api/bottleneck`（公开只读，与 `GET /api/signal` 同级，供产业链面板和后台管理面板共用读取，数据本身不敏感无需鉴权）

### 6.4 `backend/utils/storage.js`

新增 `getBottleneck()` / `setBottleneck(stage, note, setBy)`

## 7. 前端改动

### 7.1 `AdminPanel.vue`

- 信号位类型下拉框新增"AI供需"选项
- 当前信号位展示区新增一行
- 新增"当前卡脖子环节"设定区块（下拉框选环节 + 备注 + 保存按钮，无有效期字段），读取调用公开的 `GET /api/bottleneck`，保存调用 `POST /api/admin/bottleneck`

### 7.2 `MacroPanel.vue`

`positions` 计算属性新增第四项：`{ key: 'aiSupply', value: signal.value.aiSupplySignal }`

### 7.3 新建 `AiChainPanel.vue`

- 静态产业链层级列表（写死在组件内或抽成 `frontend/src/data/aiChain.js` 常量），每层展示环节名称（i18n）+ 股票代码列表（不翻译）
- 组件挂载时请求 `GET /api/bottleneck`，将返回的 `stage` 与本地层级列表匹配，对应节点加高亮样式

### 7.4 `HomeView.vue`

双栏工作台下方新增 `<AiChainPanel />`，时间轴上方。

### 7.5 `frontend/src/api/client.js`

新增 `getBottleneck()`、`setBottleneck(stage, note)`（管理员用）

### 7.6 i18n 七语言文件

- `signal.neutral` / `signalPos.neutral` 文案替换（见第4节对照表）
- `signalPos.aiSupply` 新增（信号位标签，"AI供需"及各语言翻译）
- `admin.aiSupply` 新增（下拉框选项文案）
- `aiChain.*` 新增命名空间：面板标题、各层级名称、"当前卡脖子"标签

## 8. 测试

`backend/tests/signal.test.js` 新增 `calcFinalSignal` 四参数分支测试（不穷举3^4=81种组合，覆盖关键边界，约6-8个用例）：

1. 进攻：四个信号位全部宽松
2. 防守：仅AI供需收紧，其余三个宽松
3. 防守：AI供需与货币同时收紧
4. 观望：AI供需宽松，其余两个宽松一个观望（未凑齐四全宽松）
5. 观望：四个全观望
6. 防守优先级：AI供需收紧 + 货币宽松 + 财政宽松 + 行政宽松（验证OR优先于AND，不会因三个宽松而判进攻）

## 9. 范围之外

- AI供需信号位不接入任何自动化数据源计算（明确为人工设定，与本设计一致）
- 产业链面板内容不做定时自动抓取更新，由管理员手动维护
- 不做产业链环节与实际股价的实时联动展示（不接入Yahoo Finance为该面板拉取实时报价）
