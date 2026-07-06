# AI供需信号位 + 产业链面板 + 观望文案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在股哨兵现有货币/财政/行政三信号位决策树基础上，新增第四个信号位（AI产业链供需卡脖子程度），新增静态产业链地图展示面板，并将"中性"档位文案统一改为"观望"（七语言同步）。

**Architecture:** AI供需信号位复用现有"管理员手动设定+有效期自动回归"模式（与财政/行政信号位完全一致），`calcFinalSignal` 从三元决策树扩展为四元（AND/OR 逻辑不变）。产业链面板是纯静态展示组件，通过一个公开只读接口获取当前"卡脖子环节"标记，与信号计算逻辑解耦。

**Tech Stack:** Node.js + Express + sql.js（后端），Vue3 + vue-i18n（前端），Vitest（测试）

---

## Task 1: 信号计算层扩展为四元决策树

**Files:**
- Modify: `backend/api/signal.js:73-86`
- Test: `backend/tests/signal.test.js`

- [ ] **Step 1: 写失败测试——四参数决策树的关键分支**

在 `backend/tests/signal.test.js` 文件末尾的 `describe('calcFinalSignal', ...)` 块内，替换现有的三参数调用为四参数调用，并新增AI供需相关分支。用下面的完整内容替换该文件从第98行到文件末尾（`describe('calcFinalSignal'` 开始到结尾）：

```javascript
// 决策树合成（四元：货币/财政/行政/AI供需）
describe('calcFinalSignal', () => {
  it('进攻：四个信号位全部宽松', () => {
    expect(calcFinalSignal('loose', 'loose', 'loose', 'loose')).toBe('attack');
  });

  it('防守：货币收紧', () => {
    expect(calcFinalSignal('tight', 'loose', 'loose', 'loose')).toBe('defense');
  });

  it('防守：财政收紧', () => {
    expect(calcFinalSignal('loose', 'tight', 'loose', 'loose')).toBe('defense');
  });

  it('防守：行政收紧', () => {
    expect(calcFinalSignal('loose', 'loose', 'tight', 'loose')).toBe('defense');
  });

  it('防守：仅AI供需收紧，其余三个宽松', () => {
    expect(calcFinalSignal('loose', 'loose', 'loose', 'tight')).toBe('defense');
  });

  it('防守：AI供需与货币同时收紧', () => {
    expect(calcFinalSignal('tight', 'loose', 'loose', 'tight')).toBe('defense');
  });

  it('防守：多个同时收紧', () => {
    expect(calcFinalSignal('tight', 'tight', 'tight', 'tight')).toBe('defense');
  });

  it('观望：货币宽松 财政观望 行政宽松 AI供需宽松（非全宽松）', () => {
    expect(calcFinalSignal('loose', 'neutral', 'loose', 'loose')).toBe('neutral');
  });

  it('观望：四个全观望', () => {
    expect(calcFinalSignal('neutral', 'neutral', 'neutral', 'neutral')).toBe('neutral');
  });

  it('观望：货币宽松 财政宽松 行政宽松 AI供需观望（非全宽松）', () => {
    expect(calcFinalSignal('loose', 'loose', 'loose', 'neutral')).toBe('neutral');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npm test -- signal.test.js`
Expected: FAIL —— `calcFinalSignal` 目前只接受3个参数，第4个参数 `aiSupply` 会被忽略，导致 "AI供需与货币同时收紧" 等新用例断言失败（返回 `attack` 或非预期值，因为当前实现不检查第4个参数）。

- [ ] **Step 3: 修改 `calcFinalSignal` 支持四参数**

打开 `backend/api/signal.js`，将第73-86行的整个函数替换为：

```javascript
/**
 * 决策树：四个信号位 → 最终进攻/观望/防守
 * 进攻 = AND（四全宽松）
 * 防守 = OR（任一收紧）
 * 观望 = 其余
 */
export function calcFinalSignal(monetary, fiscal, admin, aiSupply) {
  // 防守：任一收紧
  if (
    monetary === SIGNAL.TIGHT ||
    fiscal === SIGNAL.TIGHT ||
    admin === SIGNAL.TIGHT ||
    aiSupply === SIGNAL.TIGHT
  ) {
    return FINAL_SIGNAL.DEFENSE;
  }

  // 进攻：四全宽松
  if (
    monetary === SIGNAL.LOOSE &&
    fiscal === SIGNAL.LOOSE &&
    admin === SIGNAL.LOOSE &&
    aiSupply === SIGNAL.LOOSE
  ) {
    return FINAL_SIGNAL.ATTACK;
  }

  // 观望
  return FINAL_SIGNAL.NEUTRAL;
}
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `cd backend && npm test -- signal.test.js`
Expected: PASS —— 所有测试（包括原有货币信号位测试和新的四参数决策树测试）全部通过。

- [ ] **Step 5: Commit**

```bash
cd "D:\sheldonproject\StockSentinel"
git add backend/api/signal.js backend/tests/signal.test.js
git commit -m "feat: calcFinalSignal 扩展为四元决策树，支持AI供需信号位"
```

---

## Task 2: 数据库表结构扩展

**Files:**
- Modify: `backend/utils/storage.js`

- [ ] **Step 1: 在 `initSchema()` 中为 `signal_snapshots` 表新增字段**

打开 `backend/utils/storage.js`，找到第45-61行的 `signal_snapshots` 表定义，在 `admin_signal TEXT NOT NULL,` 这一行之后（第50行后）新增一行：

```javascript
  db.run(`
    CREATE TABLE IF NOT EXISTS signal_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      monetary_signal TEXT NOT NULL,
      fiscal_signal TEXT NOT NULL,
      admin_signal TEXT NOT NULL,
      ai_supply_signal TEXT NOT NULL DEFAULT 'neutral',
      final_signal TEXT NOT NULL,
      fred_rate REAL,
      fred_rate_prev REAL,
      fred_balance_sheet REAL,
      fred_balance_sheet_prev REAL,
      fred_core_pce REAL,
      fred_trimmed_pce REAL,
      fred_unemployment REAL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
```

这替换原有的整个 `signal_snapshots` CREATE TABLE 语句（原第45-61行）。

- [ ] **Step 2: 新增 `ai_chain_bottleneck` 表**

在 `initSchema()` 函数内，第92-93行的 `alert_subscriptions` 表定义之后（该函数的最后一个 `db.run` 调用之后，第93行的 `)` 之后），新增：

```javascript

  db.run(`
    CREATE TABLE IF NOT EXISTS ai_chain_bottleneck (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stage TEXT NOT NULL,
      note TEXT,
      set_by TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
```

- [ ] **Step 3: 修改 `saveSignalSnapshot` 支持新字段**

找到第149-162行的 `saveSignalSnapshot` 函数，替换为：

```javascript
export async function saveSignalSnapshot(data) {
  await getDb();
  run(`
    INSERT INTO signal_snapshots
    (date, monetary_signal, fiscal_signal, admin_signal, ai_supply_signal, final_signal,
     fred_rate, fred_rate_prev, fred_balance_sheet, fred_balance_sheet_prev,
     fred_core_pce, fred_trimmed_pce, fred_unemployment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.date, data.monetarySignal, data.fiscalSignal, data.adminSignal, data.aiSupplySignal, data.finalSignal,
    data.fredRate, data.fredRatePrev, data.fredBalanceSheet, data.fredBalanceSheetPrev,
    data.fredCorePce, data.fredTrimmedPce, data.fredUnemployment,
  ]);
}
```

- [ ] **Step 4: 新增 `getBottleneck` / `setBottleneck` 函数**

找到文件末尾第218-229行的 `--- Alert Subscribers ---` 区块和 `export { getDb, persist };` 这一行。在 `export { getDb, persist };` 之前（第229行之前）插入新区块：

```javascript
// --- AI Chain Bottleneck ---

export async function getBottleneck() {
  await getDb();
  return get('SELECT * FROM ai_chain_bottleneck ORDER BY updated_at DESC LIMIT 1');
}

export async function setBottleneck(stage, note, setBy) {
  await getDb();
  run(
    'INSERT INTO ai_chain_bottleneck (stage, note, set_by) VALUES (?, ?, ?)',
    [stage, note || null, setBy || null]
  );
}

```

- [ ] **Step 5: 删除旧数据库文件，验证新表结构生效**

因为 sql.js 数据库文件已存在于 `backend/data/stock-sentinel.db`，`CREATE TABLE IF NOT EXISTS` 不会给已存在的表新增列。删除旧文件让它重新初始化（该文件已被 `.gitignore` 排除，删除不影响版本库）：

```bash
cd "D:\sheldonproject\StockSentinel"
rm -f backend/data/stock-sentinel.db
```

- [ ] **Step 6: 运行现有测试确认没有破坏**

Run: `cd backend && npm test`
Expected: PASS —— 27个原有测试全部通过（`auth.test.js` 和 `fetch-macro.test.js` mock 了 storage/axios，不受影响；`signal.test.js` 不涉及 storage）。

- [ ] **Step 7: Commit**

```bash
cd "D:\sheldonproject\StockSentinel"
git add backend/utils/storage.js
git commit -m "feat: 数据库新增 ai_supply_signal 字段和 ai_chain_bottleneck 表"
```

---

## Task 3: Admin API 支持 AI供需信号位类型

**Files:**
- Modify: `backend/api/admin.js`

- [ ] **Step 1: 修改 `VALID_TYPES` 常量**

打开 `backend/api/admin.js`，将第12行：

```javascript
const VALID_TYPES = ['fiscal', 'administrative'];
```

替换为：

```javascript
const VALID_TYPES = ['fiscal', 'administrative', 'ai_supply'];
```

- [ ] **Step 2: 修改 `GET /api/admin/signals` 返回值新增 AI供需字段**

将第15-26行的整个路由处理函数替换为：

```javascript
// GET /api/admin/signals — 当前财政/行政/AI供需信号位
router.get('/signals', requireAdmin, async (req, res) => {
  const [fiscal, administrative, aiSupply] = await Promise.all([
    getActiveAdminSignal('fiscal'),
    getActiveAdminSignal('administrative'),
    getActiveAdminSignal('ai_supply'),
  ]);
  res.json({
    fiscal: fiscal?.signal || 'neutral',
    fiscalMeta: fiscal || null,
    administrative: administrative?.signal || 'neutral',
    administrativeMeta: administrative || null,
    aiSupply: aiSupply?.signal || 'neutral',
    aiSupplyMeta: aiSupply || null,
  });
});
```

- [ ] **Step 3: 新增 `POST /api/admin/bottleneck` 路由**

在文件末尾的 `export default router;` 之前（第59行之前），新增：

```javascript
const VALID_STAGES = [
  'model', 'cloud', 'chip', 'memory', 'packaging', 'power',
];

// POST /api/admin/bottleneck — 设定当前AI产业链最卡脖子环节
router.post('/bottleneck', requireAdmin, async (req, res) => {
  const { stage, note } = req.body;
  if (!VALID_STAGES.includes(stage)) {
    return res.status(400).json({ error: `stage must be one of: ${VALID_STAGES.join(', ')}` });
  }
  await setBottleneck(stage, note || null, req.user.email);
  res.json({ ok: true, stage, note });
});

```

- [ ] **Step 4: 更新 import 语句**

将文件顶部第3-8行的 import 语句：

```javascript
import {
  setAdminSignal,
  getActiveAdminSignal,
  getAdminSignalHistory,
} from '../utils/storage.js';
```

替换为：

```javascript
import {
  setAdminSignal,
  getActiveAdminSignal,
  getAdminSignalHistory,
  setBottleneck,
} from '../utils/storage.js';
```

- [ ] **Step 5: 手动验证接口可用（后端需先启动）**

Run: `cd backend && npm run dev`（在一个终端后台运行），然后另开终端验证路由已注册且类型校验生效：

```bash
curl -s -X POST http://localhost:3001/api/admin/bottleneck -H "Content-Type: application/json" -d '{"stage":"packaging"}'
```

Expected: 因未带有效 JWT，返回 `{"error":"unauthorized"}`，HTTP 401 —— 说明路由已挂载且 `requireAdmin` 中间件生效（完整的鉴权+落库验证会在 Task 8 端到端测试中做）。

停止 dev server：在运行 `npm run dev` 的终端按 `Ctrl+C`。

- [ ] **Step 6: Commit**

```bash
cd "D:\sheldonproject\StockSentinel"
git add backend/api/admin.js
git commit -m "feat: admin API 支持 AI供需信号位设定和卡脖子环节设定"
```

---

## Task 4: server.js 集成AI供需信号位到每日信号计算

**Files:**
- Modify: `backend/server.js`

- [ ] **Step 1: 修改 import 语句引入 `getBottleneck`**

打开 `backend/server.js`，将第13-19行：

```javascript
import {
  getLatestSnapshot,
  saveSignalSnapshot,
  getSnapshotHistory,
  getActiveAdminSignal,
  getAlertSubscribers,
} from './utils/storage.js';
```

替换为：

```javascript
import {
  getLatestSnapshot,
  saveSignalSnapshot,
  getSnapshotHistory,
  getActiveAdminSignal,
  getAlertSubscribers,
  getBottleneck,
} from './utils/storage.js';
```

- [ ] **Step 2: 修改 `GET /api/signal` 返回值新增 `aiSupplySignal`**

将第34-60行的整个路由处理函数替换为：

```javascript
// GET /api/signal — 当前宏观信号 + 各信号位明细
app.get('/api/signal', async (req, res) => {
  const snapshot = await getLatestSnapshot();
  if (!snapshot) return res.json({ status: 'loading', message: 'No data yet, cron will run soon' });

  const [fiscalOverride, adminOverride, aiSupplyOverride] = await Promise.all([
    getActiveAdminSignal('fiscal'),
    getActiveAdminSignal('administrative'),
    getActiveAdminSignal('ai_supply'),
  ]);

  res.json({
    finalSignal: snapshot.final_signal,
    monetarySignal: snapshot.monetary_signal,
    fiscalSignal: fiscalOverride?.signal || snapshot.fiscal_signal,
    adminSignal: adminOverride?.signal || snapshot.admin_signal,
    aiSupplySignal: aiSupplyOverride?.signal || snapshot.ai_supply_signal,
    indicators: {
      rate: snapshot.fred_rate,
      ratePrev: snapshot.fred_rate_prev,
      balanceSheet: snapshot.fred_balance_sheet,
      balanceSheetPrev: snapshot.fred_balance_sheet_prev,
      corePce: snapshot.fred_core_pce,
      trimmedPce: snapshot.fred_trimmed_pce,
      unemployment: snapshot.fred_unemployment,
    },
    dataDate: snapshot.date,
    createdAt: snapshot.created_at,
  });
});
```

- [ ] **Step 3: 新增 `GET /api/bottleneck` 公开只读路由**

在 `GET /api/signal/history` 路由（第62-67行）之后，新增：

```javascript

// GET /api/bottleneck — 当前AI产业链最卡脖子环节（公开只读）
app.get('/api/bottleneck', async (req, res) => {
  const bottleneck = await getBottleneck();
  res.json(bottleneck || { stage: null, note: null });
});
```

- [ ] **Step 4: 修改 `runDailyUpdate` 读取AI供需信号位并传入决策树**

将第76-126行的 `runDailyUpdate` 函数中，第89-114行的部分替换为：

```javascript
  const [fiscalOverride, adminOverride, aiSupplyOverride] = await Promise.all([
    getActiveAdminSignal('fiscal'),
    getActiveAdminSignal('administrative'),
    getActiveAdminSignal('ai_supply'),
  ]);

  const fiscal = fiscalOverride?.signal || 'neutral';
  const admin = adminOverride?.signal || 'neutral';
  const aiSupply = aiSupplyOverride?.signal || 'neutral';
  const finalSignal = calcFinalSignal(monetary, fiscal, admin, aiSupply);

  const today = new Date().toISOString().slice(0, 10);
  const prevSnapshot = await getLatestSnapshot();

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
    fredCorePce: macroData.corePce,
    fredTrimmedPce: macroData.trimmedPce,
    fredUnemployment: macroData.unemployment,
  });

  console.log(`[cron] Signal updated: monetary=${monetary}, fiscal=${fiscal}, admin=${admin}, aiSupply=${aiSupply} → final=${finalSignal}`);
```

- [ ] **Step 5: 手动验证服务器可正常启动**

Run: `cd backend && node server.js`
Expected: 终端输出 `[server] Stock Sentinel backend running on http://localhost:3001`，没有报错抛出（FRED API 调用失败也应被 try/catch 捕获打印 `[cron] FRED fetch failed`，不影响服务器启动）。

按 `Ctrl+C` 停止服务器。

- [ ] **Step 6: Commit**

```bash
cd "D:\sheldonproject\StockSentinel"
git add backend/server.js
git commit -m "feat: server.js 集成AI供需信号位到每日信号计算和API响应"
```

---

## Task 5: 前端 API client 新增接口方法

**Files:**
- Modify: `frontend/src/api/client.js`

- [ ] **Step 1: 新增 `getBottleneck` / `setBottleneck` 方法**

打开 `frontend/src/api/client.js`，将第38-44行的 `// Admin` 区块替换为：

```javascript
  // Admin
  getAdminSignals: () => request('/admin/signals'),
  setAdminSignal: (type, signal, expiresAt, note) =>
    request('/admin/signals', { method: 'POST', body: JSON.stringify({ type, signal, expiresAt, note }) }),
  getAdminHistory: () => request('/admin/signal-history'),
  getReference: (category) => request(`/admin/reference?category=${category}`),

  // AI Chain Bottleneck
  getBottleneck: () => request('/bottleneck'),
  setBottleneck: (stage, note) =>
    request('/admin/bottleneck', { method: 'POST', body: JSON.stringify({ stage, note }) }),
};
```

注意：这替换了原文件末尾的 `};` 闭合括号，新增两个方法后保留原有闭合。

- [ ] **Step 2: 验证语法正确（无需运行测试，纯静态文件）**

Run: `cd frontend && node -e "require('fs').readFileSync('src/api/client.js', 'utf8')"`（仅验证文件可读，语法校验在 Task 9 构建时统一做）

Expected: 无输出、无报错。

- [ ] **Step 3: Commit**

```bash
cd "D:\sheldonproject\StockSentinel"
git add frontend/src/api/client.js
git commit -m "feat: 前端 API client 新增 getBottleneck/setBottleneck"
```

---

## Task 6: i18n 七语言文件——观望文案 + AI供需/产业链新词条

**Files:**
- Modify: `frontend/src/i18n/locales/zh.json`
- Modify: `frontend/src/i18n/locales/en.json`
- Modify: `frontend/src/i18n/locales/fr.json`
- Modify: `frontend/src/i18n/locales/de.json`
- Modify: `frontend/src/i18n/locales/es.json`
- Modify: `frontend/src/i18n/locales/ja.json`
- Modify: `frontend/src/i18n/locales/ko.json`

- [ ] **Step 1: 修改 `zh.json`**

打开 `frontend/src/i18n/locales/zh.json`，将整个文件内容替换为：

```json
{
  "app": {
    "title": "股哨兵",
    "subtitle": "美股进攻/防守信号"
  },
  "signal": {
    "attack": "进攻",
    "neutral": "观望",
    "defense": "防守",
    "loading": "数据加载中..."
  },
  "signalPos": {
    "monetary": "货币政策",
    "fiscal": "财政政策",
    "administrative": "行政政策",
    "aiSupply": "AI供需",
    "loose": "宽松",
    "neutral": "观望",
    "tight": "收紧"
  },
  "indicators": {
    "rate": "联邦基金利率",
    "balanceSheet": "美联储资产负债表",
    "corePce": "核心 PCE 同比",
    "trimmedPce": "Trimmed Mean PCE",
    "unemployment": "失业率",
    "dataDate": "数据日期",
    "unit": {
      "rate": "%",
      "balanceSheet": "亿美元",
      "pce": "%",
      "unemployment": "%"
    }
  },
  "watchlist": {
    "title": "自选股",
    "addPlaceholder": "输入股票代码，如 AAPL",
    "add": "添加",
    "remove": "移除",
    "empty": "暂无自选股，添加你关注的股票",
    "pricePercentile": "价格百分位",
    "pe": "市盈率 P/E",
    "ps": "市销率 P/S",
    "currentPrice": "当前价格",
    "dateRange": "计算区间",
    "presets": "快速添加",
    "mag7": "Mag 7",
    "etfs": "主要 ETF"
  },
  "timeline": {
    "title": "信号历史",
    "noHistory": "暂无历史记录"
  },
  "auth": {
    "login": "登录",
    "register": "注册",
    "logout": "退出",
    "email": "邮箱",
    "password": "密码",
    "loginTitle": "登录 股哨兵",
    "registerTitle": "注册账号",
    "noAccount": "还没有账号？注册",
    "hasAccount": "已有账号？登录",
    "loginSuccess": "登录成功",
    "registerSuccess": "注册成功"
  },
  "admin": {
    "title": "后台管理",
    "setSignal": "设定信号位",
    "type": "类型",
    "signal": "档位",
    "expiresAt": "有效期至",
    "note": "备注",
    "save": "保存",
    "reference": "参考素材",
    "fiscal": "财政",
    "administrative": "行政",
    "aiSupply": "AI供需",
    "history": "设定历史",
    "refresh": "刷新",
    "bottleneck": "当前卡脖子环节",
    "bottleneckStage": "环节",
    "bottleneckSave": "保存环节"
  },
  "settings": {
    "title": "设置",
    "emailAlerts": "邮件提醒",
    "emailAlertsDesc": "信号变更时发送邮件通知"
  },
  "lang": {
    "switch": "语言",
    "zh": "中文",
    "en": "English",
    "fr": "Français",
    "de": "Deutsch",
    "es": "Español",
    "ja": "日本語",
    "ko": "한국어"
  },
  "error": {
    "fetchFailed": "数据加载失败，显示上次缓存数据",
    "loginFailed": "邮箱或密码错误",
    "registerFailed": "注册失败，请重试"
  },
  "aiChain": {
    "title": "AI产业链资金流向",
    "currentBottleneck": "当前最卡脖子环节",
    "stages": {
      "model": "AI大模型",
      "cloud": "云厂商",
      "chip": "AI芯片",
      "memory": "存储/光模块",
      "packaging": "设备/封装/测试",
      "power": "电力能源"
    }
  }
}
```

- [ ] **Step 2: 修改 `en.json`**

打开 `frontend/src/i18n/locales/en.json`，将整个文件内容替换为：

```json
{
  "app": {
    "title": "Stock Sentinel",
    "subtitle": "US Stock Attack / Defense Signal"
  },
  "signal": {
    "attack": "Attack",
    "neutral": "Watch",
    "defense": "Defense",
    "loading": "Loading data..."
  },
  "signalPos": {
    "monetary": "Monetary Policy",
    "fiscal": "Fiscal Policy",
    "administrative": "Administrative Policy",
    "aiSupply": "AI Supply/Demand",
    "loose": "Loose",
    "neutral": "Watch",
    "tight": "Tight"
  },
  "indicators": {
    "rate": "Fed Funds Rate",
    "balanceSheet": "Fed Balance Sheet",
    "corePce": "Core PCE YoY",
    "trimmedPce": "Trimmed Mean PCE",
    "unemployment": "Unemployment Rate",
    "dataDate": "Data Date",
    "unit": {
      "rate": "%",
      "balanceSheet": "B USD",
      "pce": "%",
      "unemployment": "%"
    }
  },
  "watchlist": {
    "title": "Watchlist",
    "addPlaceholder": "Enter ticker, e.g. AAPL",
    "add": "Add",
    "remove": "Remove",
    "empty": "No stocks in watchlist yet",
    "pricePercentile": "Price Percentile",
    "pe": "P/E Ratio",
    "ps": "P/S Ratio",
    "currentPrice": "Current Price",
    "dateRange": "Date Range",
    "presets": "Quick Add",
    "mag7": "Mag 7",
    "etfs": "Major ETFs"
  },
  "timeline": {
    "title": "Signal History",
    "noHistory": "No history yet"
  },
  "auth": {
    "login": "Login",
    "register": "Register",
    "logout": "Logout",
    "email": "Email",
    "password": "Password",
    "loginTitle": "Login to Stock Sentinel",
    "registerTitle": "Create Account",
    "noAccount": "No account? Register",
    "hasAccount": "Have an account? Login",
    "loginSuccess": "Logged in",
    "registerSuccess": "Registration successful"
  },
  "admin": {
    "title": "Admin Panel",
    "setSignal": "Set Signal Position",
    "type": "Type",
    "signal": "Signal",
    "expiresAt": "Expires At",
    "note": "Note",
    "save": "Save",
    "reference": "Reference Materials",
    "fiscal": "Fiscal",
    "administrative": "Administrative",
    "aiSupply": "AI Supply/Demand",
    "history": "History",
    "refresh": "Refresh",
    "bottleneck": "Current Bottleneck Stage",
    "bottleneckStage": "Stage",
    "bottleneckSave": "Save Stage"
  },
  "settings": {
    "title": "Settings",
    "emailAlerts": "Email Alerts",
    "emailAlertsDesc": "Receive email when signal changes"
  },
  "lang": {
    "switch": "Language",
    "zh": "中文",
    "en": "English",
    "fr": "Français",
    "de": "Deutsch",
    "es": "Español",
    "ja": "日本語",
    "ko": "한국어"
  },
  "error": {
    "fetchFailed": "Failed to load data, showing cached results",
    "loginFailed": "Invalid email or password",
    "registerFailed": "Registration failed, please try again"
  },
  "aiChain": {
    "title": "AI Industry Chain Money Flow",
    "currentBottleneck": "Current Bottleneck Stage",
    "stages": {
      "model": "AI Foundation Models",
      "cloud": "Cloud Providers",
      "chip": "AI Chips",
      "memory": "Memory / Optical Modules",
      "packaging": "Equipment / Packaging / Testing",
      "power": "Power & Energy"
    }
  }
}
```

- [ ] **Step 3: 修改 `fr.json`**

打开 `frontend/src/i18n/locales/fr.json`，将整个文件内容替换为：

```json
{
  "app": { "title": "Stock Sentinel", "subtitle": "Signal Attaque / Défense Actions US" },
  "signal": { "attack": "Attaque", "neutral": "Attente", "defense": "Défense", "loading": "Chargement..." },
  "signalPos": { "monetary": "Politique Monétaire", "fiscal": "Politique Fiscale", "administrative": "Politique Administrative", "aiSupply": "Offre/Demande IA", "loose": "Accommodant", "neutral": "Attente", "tight": "Restrictif" },
  "indicators": { "rate": "Taux Fed", "balanceSheet": "Bilan Fed", "corePce": "PCE Core AoA", "trimmedPce": "PCE Écrêté", "unemployment": "Chômage", "dataDate": "Date des données", "unit": { "rate": "%", "balanceSheet": "Mrd USD", "pce": "%", "unemployment": "%" } },
  "watchlist": { "title": "Liste de Suivi", "addPlaceholder": "Entrer le symbole, ex. AAPL", "add": "Ajouter", "remove": "Supprimer", "empty": "Aucune action dans la liste", "pricePercentile": "Percentile Prix", "pe": "P/E", "ps": "P/S", "currentPrice": "Prix Actuel", "dateRange": "Plage de dates", "presets": "Ajout Rapide", "mag7": "Mag 7", "etfs": "ETF Principaux" },
  "timeline": { "title": "Historique des Signaux", "noHistory": "Pas d'historique" },
  "auth": { "login": "Connexion", "register": "S'inscrire", "logout": "Déconnexion", "email": "Email", "password": "Mot de passe", "loginTitle": "Connexion", "registerTitle": "Créer un compte", "noAccount": "Pas de compte ? S'inscrire", "hasAccount": "Déjà un compte ? Se connecter", "loginSuccess": "Connecté", "registerSuccess": "Inscription réussie" },
  "admin": { "title": "Administration", "setSignal": "Définir le Signal", "type": "Type", "signal": "Signal", "expiresAt": "Expire le", "note": "Note", "save": "Enregistrer", "reference": "Références", "fiscal": "Fiscal", "administrative": "Administratif", "aiSupply": "Offre/Demande IA", "history": "Historique", "refresh": "Actualiser", "bottleneck": "Étape la Plus Critique", "bottleneckStage": "Étape", "bottleneckSave": "Enregistrer l'Étape" },
  "settings": { "title": "Paramètres", "emailAlerts": "Alertes Email", "emailAlertsDesc": "Recevoir un email lors d'un changement de signal" },
  "lang": { "switch": "Langue", "zh": "中文", "en": "English", "fr": "Français", "de": "Deutsch", "es": "Español", "ja": "日本語", "ko": "한국어" },
  "error": { "fetchFailed": "Échec du chargement, affichage des données en cache", "loginFailed": "Email ou mot de passe invalide", "registerFailed": "Inscription échouée" },
  "aiChain": { "title": "Flux Financier de la Chaîne IA", "currentBottleneck": "Étape la Plus Critique Actuelle", "stages": { "model": "Modèles IA", "cloud": "Fournisseurs Cloud", "chip": "Puces IA", "memory": "Mémoire / Modules Optiques", "packaging": "Équipement / Packaging / Test", "power": "Énergie" } }
}
```

- [ ] **Step 4: 修改 `de.json`**

打开 `frontend/src/i18n/locales/de.json`，将整个文件内容替换为：

```json
{
  "app": { "title": "Stock Sentinel", "subtitle": "US-Aktien Angriff/Verteidigung Signal" },
  "signal": { "attack": "Angriff", "neutral": "Abwarten", "defense": "Verteidigung", "loading": "Laden..." },
  "signalPos": { "monetary": "Geldpolitik", "fiscal": "Fiskalpolitik", "administrative": "Verwaltungspolitik", "aiSupply": "KI Angebot/Nachfrage", "loose": "Locker", "neutral": "Abwarten", "tight": "Straff" },
  "indicators": { "rate": "Fed Zinssatz", "balanceSheet": "Fed Bilanz", "corePce": "Kern-PCE jährlich", "trimmedPce": "Gekürzter PCE", "unemployment": "Arbeitslosigkeit", "dataDate": "Datendatum", "unit": { "rate": "%", "balanceSheet": "Mrd USD", "pce": "%", "unemployment": "%" } },
  "watchlist": { "title": "Beobachtungsliste", "addPlaceholder": "Symbol eingeben, z.B. AAPL", "add": "Hinzufügen", "remove": "Entfernen", "empty": "Keine Aktien in der Liste", "pricePercentile": "Preis-Perzentile", "pe": "KGV", "ps": "KUV", "currentPrice": "Aktueller Preis", "dateRange": "Zeitraum", "presets": "Schnell hinzufügen", "mag7": "Mag 7", "etfs": "Haupt-ETFs" },
  "timeline": { "title": "Signalverlauf", "noHistory": "Kein Verlauf" },
  "auth": { "login": "Anmelden", "register": "Registrieren", "logout": "Abmelden", "email": "E-Mail", "password": "Passwort", "loginTitle": "Anmelden", "registerTitle": "Konto erstellen", "noAccount": "Kein Konto? Registrieren", "hasAccount": "Konto vorhanden? Anmelden", "loginSuccess": "Angemeldet", "registerSuccess": "Registrierung erfolgreich" },
  "admin": { "title": "Verwaltung", "setSignal": "Signal setzen", "type": "Typ", "signal": "Signal", "expiresAt": "Läuft ab am", "note": "Notiz", "save": "Speichern", "reference": "Referenzen", "fiscal": "Fiskal", "administrative": "Verwaltung", "aiSupply": "KI Angebot/Nachfrage", "history": "Verlauf", "refresh": "Aktualisieren", "bottleneck": "Aktueller Engpass", "bottleneckStage": "Stufe", "bottleneckSave": "Stufe speichern" },
  "settings": { "title": "Einstellungen", "emailAlerts": "E-Mail-Benachrichtigungen", "emailAlertsDesc": "E-Mail bei Signaländerung erhalten" },
  "lang": { "switch": "Sprache", "zh": "中文", "en": "English", "fr": "Français", "de": "Deutsch", "es": "Español", "ja": "日本語", "ko": "한국어" },
  "error": { "fetchFailed": "Laden fehlgeschlagen, zeige gecachte Daten", "loginFailed": "Ungültige E-Mail oder Passwort", "registerFailed": "Registrierung fehlgeschlagen" },
  "aiChain": { "title": "KI-Wertschöpfungskette Geldfluss", "currentBottleneck": "Aktueller Engpass", "stages": { "model": "KI-Modelle", "cloud": "Cloud-Anbieter", "chip": "KI-Chips", "memory": "Speicher / Optische Module", "packaging": "Ausrüstung / Packaging / Test", "power": "Energie" } }
}
```

- [ ] **Step 5: 修改 `es.json`**

打开 `frontend/src/i18n/locales/es.json`，将整个文件内容替换为：

```json
{
  "app": { "title": "Stock Sentinel", "subtitle": "Señal Ataque/Defensa Acciones EEUU" },
  "signal": { "attack": "Ataque", "neutral": "Observar", "defense": "Defensa", "loading": "Cargando..." },
  "signalPos": { "monetary": "Política Monetaria", "fiscal": "Política Fiscal", "administrative": "Política Administrativa", "aiSupply": "Oferta/Demanda IA", "loose": "Expansivo", "neutral": "Observar", "tight": "Restrictivo" },
  "indicators": { "rate": "Tasa Fed", "balanceSheet": "Balance Fed", "corePce": "PCE Subyacente", "trimmedPce": "PCE Recortado", "unemployment": "Desempleo", "dataDate": "Fecha de datos", "unit": { "rate": "%", "balanceSheet": "MM USD", "pce": "%", "unemployment": "%" } },
  "watchlist": { "title": "Lista de Seguimiento", "addPlaceholder": "Ingresar símbolo, ej. AAPL", "add": "Agregar", "remove": "Eliminar", "empty": "Sin acciones en la lista", "pricePercentile": "Percentil de Precio", "pe": "P/E", "ps": "P/S", "currentPrice": "Precio Actual", "dateRange": "Rango de Fechas", "presets": "Agregar Rápido", "mag7": "Mag 7", "etfs": "ETFs Principales" },
  "timeline": { "title": "Historial de Señales", "noHistory": "Sin historial" },
  "auth": { "login": "Iniciar Sesión", "register": "Registrarse", "logout": "Cerrar Sesión", "email": "Correo", "password": "Contraseña", "loginTitle": "Iniciar Sesión", "registerTitle": "Crear Cuenta", "noAccount": "¿Sin cuenta? Registrarse", "hasAccount": "¿Tienes cuenta? Iniciar sesión", "loginSuccess": "Sesión iniciada", "registerSuccess": "Registro exitoso" },
  "admin": { "title": "Administración", "setSignal": "Establecer Señal", "type": "Tipo", "signal": "Señal", "expiresAt": "Expira el", "note": "Nota", "save": "Guardar", "reference": "Referencias", "fiscal": "Fiscal", "administrative": "Administrativo", "aiSupply": "Oferta/Demanda IA", "history": "Historial", "refresh": "Actualizar", "bottleneck": "Cuello de Botella Actual", "bottleneckStage": "Etapa", "bottleneckSave": "Guardar Etapa" },
  "settings": { "title": "Configuración", "emailAlerts": "Alertas por Email", "emailAlertsDesc": "Recibir email cuando cambie la señal" },
  "lang": { "switch": "Idioma", "zh": "中文", "en": "English", "fr": "Français", "de": "Deutsch", "es": "Español", "ja": "日本語", "ko": "한국어" },
  "error": { "fetchFailed": "Error al cargar, mostrando datos en caché", "loginFailed": "Email o contraseña inválidos", "registerFailed": "Registro fallido" },
  "aiChain": { "title": "Flujo de Capital de la Cadena IA", "currentBottleneck": "Cuello de Botella Actual", "stages": { "model": "Modelos de IA", "cloud": "Proveedores de Nube", "chip": "Chips de IA", "memory": "Memoria / Módulos Ópticos", "packaging": "Equipos / Empaquetado / Pruebas", "power": "Energía" } }
}
```

- [ ] **Step 6: 修改 `ja.json`**

打开 `frontend/src/i18n/locales/ja.json`，将整个文件内容替换为：

```json
{
  "app": { "title": "ストック・センチネル", "subtitle": "米国株攻撃/防御シグナル" },
  "signal": { "attack": "攻撃", "neutral": "様子見", "defense": "防御", "loading": "読み込み中..." },
  "signalPos": { "monetary": "金融政策", "fiscal": "財政政策", "administrative": "行政政策", "aiSupply": "AI供需", "loose": "緩和", "neutral": "様子見", "tight": "引き締め" },
  "indicators": { "rate": "FF金利", "balanceSheet": "FRBバランスシート", "corePce": "コアPCE前年比", "trimmedPce": "トリム平均PCE", "unemployment": "失業率", "dataDate": "データ日付", "unit": { "rate": "%", "balanceSheet": "億ドル", "pce": "%", "unemployment": "%" } },
  "watchlist": { "title": "ウォッチリスト", "addPlaceholder": "ティッカーを入力、例: AAPL", "add": "追加", "remove": "削除", "empty": "銘柄がありません", "pricePercentile": "価格パーセンタイル", "pe": "PER", "ps": "PSR", "currentPrice": "現在価格", "dateRange": "期間", "presets": "クイック追加", "mag7": "Mag 7", "etfs": "主要ETF" },
  "timeline": { "title": "シグナル履歴", "noHistory": "履歴なし" },
  "auth": { "login": "ログイン", "register": "登録", "logout": "ログアウト", "email": "メール", "password": "パスワード", "loginTitle": "ログイン", "registerTitle": "アカウント作成", "noAccount": "アカウントなし？登録", "hasAccount": "アカウントあり？ログイン", "loginSuccess": "ログイン成功", "registerSuccess": "登録完了" },
  "admin": { "title": "管理パネル", "setSignal": "シグナル設定", "type": "タイプ", "signal": "シグナル", "expiresAt": "有効期限", "note": "メモ", "save": "保存", "reference": "参考資料", "fiscal": "財政", "administrative": "行政", "aiSupply": "AI供需", "history": "履歴", "refresh": "更新", "bottleneck": "現在の最大の制約要因", "bottleneckStage": "工程", "bottleneckSave": "工程を保存" },
  "settings": { "title": "設定", "emailAlerts": "メール通知", "emailAlertsDesc": "シグナル変更時にメールを受け取る" },
  "lang": { "switch": "言語", "zh": "中文", "en": "English", "fr": "Français", "de": "Deutsch", "es": "Español", "ja": "日本語", "ko": "한국어" },
  "error": { "fetchFailed": "読み込み失敗、キャッシュデータを表示", "loginFailed": "メールまたはパスワードが無効", "registerFailed": "登録失敗" },
  "aiChain": { "title": "AI産業チェーンの資金流動", "currentBottleneck": "現在の最大の制約要因", "stages": { "model": "AI大規模モデル", "cloud": "クラウドプロバイダー", "chip": "AIチップ", "memory": "メモリ／光モジュール", "packaging": "設備／パッケージング／テスト", "power": "電力エネルギー" } }
}
```

- [ ] **Step 7: 修改 `ko.json`**

打开 `frontend/src/i18n/locales/ko.json`，将整个文件内容替换为：

```json
{
  "app": { "title": "스톡 센티넬", "subtitle": "미국 주식 공격/방어 신호" },
  "signal": { "attack": "공격", "neutral": "관망", "defense": "방어", "loading": "로딩 중..." },
  "signalPos": { "monetary": "통화 정책", "fiscal": "재정 정책", "administrative": "행정 정책", "aiSupply": "AI 수급", "loose": "완화", "neutral": "관망", "tight": "긴축" },
  "indicators": { "rate": "FF 금리", "balanceSheet": "연준 대차대조표", "corePce": "핵심 PCE 전년비", "trimmedPce": "트리밍 PCE", "unemployment": "실업률", "dataDate": "데이터 날짜", "unit": { "rate": "%", "balanceSheet": "억 달러", "pce": "%", "unemployment": "%" } },
  "watchlist": { "title": "관심 종목", "addPlaceholder": "종목 코드 입력, 예: AAPL", "add": "추가", "remove": "삭제", "empty": "관심 종목이 없습니다", "pricePercentile": "가격 백분위", "pe": "PER", "ps": "PSR", "currentPrice": "현재 가격", "dateRange": "기간", "presets": "빠른 추가", "mag7": "Mag 7", "etfs": "주요 ETF" },
  "timeline": { "title": "신호 히스토리", "noHistory": "히스토리 없음" },
  "auth": { "login": "로그인", "register": "회원가입", "logout": "로그아웃", "email": "이메일", "password": "비밀번호", "loginTitle": "로그인", "registerTitle": "계정 만들기", "noAccount": "계정 없음? 가입", "hasAccount": "계정 있음? 로그인", "loginSuccess": "로그인 성공", "registerSuccess": "회원가입 성공" },
  "admin": { "title": "관리자 패널", "setSignal": "신호 설정", "type": "유형", "signal": "신호", "expiresAt": "만료일", "note": "메모", "save": "저장", "reference": "참고 자료", "fiscal": "재정", "administrative": "행정", "aiSupply": "AI 수급", "history": "히스토리", "refresh": "새로고침", "bottleneck": "현재 병목 단계", "bottleneckStage": "단계", "bottleneckSave": "단계 저장" },
  "settings": { "title": "설정", "emailAlerts": "이메일 알림", "emailAlertsDesc": "신호 변경 시 이메일 받기" },
  "lang": { "switch": "언어", "zh": "中文", "en": "English", "fr": "Français", "de": "Deutsch", "es": "Español", "ja": "日本語", "ko": "한국어" },
  "error": { "fetchFailed": "로딩 실패, 캐시 데이터 표시", "loginFailed": "이메일 또는 비밀번호가 잘못됨", "registerFailed": "회원가입 실패" },
  "aiChain": { "title": "AI 산업 체인 자금 흐름", "currentBottleneck": "현재 병목 단계", "stages": { "model": "AI 대형 모델", "cloud": "클라우드 제공업체", "chip": "AI 칩", "memory": "메모리 / 광모듈", "packaging": "장비 / 패키징 / 테스트", "power": "전력 에너지" } }
}
```

- [ ] **Step 8: 验证所有7个 JSON 文件语法正确**

Run:
```bash
cd "D:\sheldonproject\StockSentinel\frontend\src\i18n\locales"
for f in zh en fr de es ja ko; do node -e "JSON.parse(require('fs').readFileSync('$f.json', 'utf8')); console.log('$f.json OK')"; done
```

Expected: 每个文件输出 `<lang>.json OK`，没有 JSON 解析错误。

- [ ] **Step 9: Commit**

```bash
cd "D:\sheldonproject\StockSentinel"
git add frontend/src/i18n/locales/
git commit -m "feat: i18n七语言新增AI供需/产业链词条，中性文案改为观望"
```

---

## Task 7: AdminPanel.vue 新增 AI供需信号位和卡脖子环节设定

**Files:**
- Modify: `frontend/src/components/AdminPanel.vue`

- [ ] **Step 1: 信号位类型下拉框新增"AI供需"选项**

打开 `frontend/src/components/AdminPanel.vue`，将第11-14行：

```html
          <select v-model="form.type" class="input">
            <option value="fiscal">{{ $t('admin.fiscal') }}</option>
            <option value="administrative">{{ $t('admin.administrative') }}</option>
          </select>
```

替换为：

```html
          <select v-model="form.type" class="input">
            <option value="fiscal">{{ $t('admin.fiscal') }}</option>
            <option value="administrative">{{ $t('admin.administrative') }}</option>
            <option value="ai_supply">{{ $t('admin.aiSupply') }}</option>
          </select>
```

- [ ] **Step 2: 当前信号位展示区新增 AI供需一行**

将第40-51行的 `<!-- 当前信号位状态 -->` 区块：

```html
    <!-- 当前信号位状态 -->
    <section class="section">
      <h3>当前信号位</h3>
      <div v-if="currentSignals" class="current-signals">
        <div class="sig-row">
          <span>{{ $t('admin.fiscal') }}</span>
          <span :class="['sig-badge', currentSignals.fiscal]">{{ $t(`signalPos.${currentSignals.fiscal}`) }}</span>
          <span v-if="currentSignals.fiscalMeta?.expires_at" class="expires">到期: {{ currentSignals.fiscalMeta.expires_at }}</span>
        </div>
        <div class="sig-row">
          <span>{{ $t('admin.administrative') }}</span>
          <span :class="['sig-badge', currentSignals.administrative]">{{ $t(`signalPos.${currentSignals.administrative}`) }}</span>
          <span v-if="currentSignals.administrativeMeta?.expires_at" class="expires">到期: {{ currentSignals.administrativeMeta.expires_at }}</span>
        </div>
      </div>
    </section>
```

替换为：

```html
    <!-- 当前信号位状态 -->
    <section class="section">
      <h3>当前信号位</h3>
      <div v-if="currentSignals" class="current-signals">
        <div class="sig-row">
          <span>{{ $t('admin.fiscal') }}</span>
          <span :class="['sig-badge', currentSignals.fiscal]">{{ $t(`signalPos.${currentSignals.fiscal}`) }}</span>
          <span v-if="currentSignals.fiscalMeta?.expires_at" class="expires">到期: {{ currentSignals.fiscalMeta.expires_at }}</span>
        </div>
        <div class="sig-row">
          <span>{{ $t('admin.administrative') }}</span>
          <span :class="['sig-badge', currentSignals.administrative]">{{ $t(`signalPos.${currentSignals.administrative}`) }}</span>
          <span v-if="currentSignals.administrativeMeta?.expires_at" class="expires">到期: {{ currentSignals.administrativeMeta.expires_at }}</span>
        </div>
        <div class="sig-row">
          <span>{{ $t('admin.aiSupply') }}</span>
          <span :class="['sig-badge', currentSignals.aiSupply]">{{ $t(`signalPos.${currentSignals.aiSupply}`) }}</span>
          <span v-if="currentSignals.aiSupplyMeta?.expires_at" class="expires">到期: {{ currentSignals.aiSupplyMeta.expires_at }}</span>
        </div>
      </div>
    </section>
```

- [ ] **Step 3: 新增"当前卡脖子环节"设定区块**

在第71行的 `</section>`（参考素材 section 结束）之后、第73行的 `<!-- 设定历史 -->` 之前，新增：

```html

    <!-- 当前卡脖子环节 -->
    <section class="section">
      <h3>{{ $t('admin.bottleneck') }}</h3>
      <form @submit.prevent="saveBottleneckStage" class="signal-form">
        <div class="form-row">
          <label>{{ $t('admin.bottleneckStage') }}</label>
          <select v-model="bottleneckForm.stage" class="input">
            <option v-for="stage in bottleneckStages" :key="stage" :value="stage">
              {{ $t(`aiChain.stages.${stage}`) }}
            </option>
          </select>
        </div>
        <div class="form-row">
          <label>{{ $t('admin.note') }}</label>
          <input v-model="bottleneckForm.note" class="input" type="text" />
        </div>
        <button type="submit" class="save-btn" :disabled="bottleneckSaving">{{ $t('admin.bottleneckSave') }}</button>
        <span v-if="bottleneckMsg" class="save-msg">{{ bottleneckMsg }}</span>
      </form>
      <div v-if="currentBottleneck?.stage" class="current-signals">
        <div class="sig-row">
          <span>{{ $t('aiChain.currentBottleneck') }}</span>
          <span class="sig-badge loose">{{ $t(`aiChain.stages.${currentBottleneck.stage}`) }}</span>
        </div>
      </div>
    </section>
```

- [ ] **Step 4: 新增脚本逻辑**

在 `<script setup>` 区块（第95-129行），将第99-105行的 ref 声明：

```javascript
const form = ref({ type: 'fiscal', signal: 'neutral', expiresAt: '', note: '' });
const saving = ref(false);
const saveMsg = ref('');
const currentSignals = ref(null);
const history = ref([]);
const refDocs = ref([]);
const refLoading = ref(false);
```

替换为：

```javascript
const form = ref({ type: 'fiscal', signal: 'neutral', expiresAt: '', note: '' });
const saving = ref(false);
const saveMsg = ref('');
const currentSignals = ref(null);
const history = ref([]);
const refDocs = ref([]);
const refLoading = ref(false);

const bottleneckStages = ['model', 'cloud', 'chip', 'memory', 'packaging', 'power'];
const bottleneckForm = ref({ stage: 'packaging', note: '' });
const bottleneckSaving = ref(false);
const bottleneckMsg = ref('');
const currentBottleneck = ref(null);
```

然后在 `async function loadData() { ... }` 函数（第122-129行）之后新增：

```javascript

async function saveBottleneckStage() {
  bottleneckSaving.value = true;
  bottleneckMsg.value = '';
  try {
    await api.setBottleneck(bottleneckForm.value.stage, bottleneckForm.value.note || null);
    bottleneckMsg.value = '✓ 已保存';
    currentBottleneck.value = await api.getBottleneck();
  } catch (e) {
    bottleneckMsg.value = '✗ ' + e.message;
  } finally {
    bottleneckSaving.value = false;
  }
}
```

最后修改 `onMounted` 钩子（第144-147行）：

```javascript
onMounted(async () => {
  await loadData();
  await loadRef('fiscal');
});
```

替换为：

```javascript
onMounted(async () => {
  await loadData();
  await loadRef('fiscal');
  currentBottleneck.value = await api.getBottleneck().catch(() => null);
});
```

- [ ] **Step 5: 手动验证组件无语法错误（前端构建）**

Run: `cd frontend && npm run build`
Expected: 构建成功，无 Vue 模板编译错误或 JS 语法错误。若报错，检查上述模板/脚本替换是否有遗漏的闭合标签。

- [ ] **Step 6: Commit**

```bash
cd "D:\sheldonproject\StockSentinel"
git add frontend/src/components/AdminPanel.vue
git commit -m "feat: AdminPanel 新增AI供需信号位设定和卡脖子环节设定"
```

---

## Task 8: MacroPanel.vue 展示AI供需信号位

**Files:**
- Modify: `frontend/src/components/MacroPanel.vue`

- [ ] **Step 1: `positions` 计算属性新增第四项**

打开 `frontend/src/components/MacroPanel.vue`，将第58-65行：

```javascript
const positions = computed(() => {
  if (!signal.value) return [];
  return [
    { key: 'monetary', value: signal.value.monetarySignal },
    { key: 'fiscal', value: signal.value.fiscalSignal },
    { key: 'administrative', value: signal.value.adminSignal },
  ];
});
```

替换为：

```javascript
const positions = computed(() => {
  if (!signal.value) return [];
  return [
    { key: 'monetary', value: signal.value.monetarySignal },
    { key: 'fiscal', value: signal.value.fiscalSignal },
    { key: 'administrative', value: signal.value.adminSignal },
    { key: 'aiSupply', value: signal.value.aiSupplySignal },
  ];
});
```

- [ ] **Step 2: 手动验证前端构建通过**

Run: `cd frontend && npm run build`
Expected: 构建成功。

- [ ] **Step 3: Commit**

```bash
cd "D:\sheldonproject\StockSentinel"
git add frontend/src/components/MacroPanel.vue
git commit -m "feat: MacroPanel 展示AI供需信号位"
```

---

## Task 9: 新建 AiChainPanel.vue 产业链地图组件

**Files:**
- Create: `frontend/src/data/aiChain.js`
- Create: `frontend/src/components/AiChainPanel.vue`
- Modify: `frontend/src/views/HomeView.vue`

- [ ] **Step 1: 新建产业链静态数据文件**

创建 `frontend/src/data/aiChain.js`：

```javascript
// AI产业链资金流向地图（静态数据，管理员手动维护更新）
export const AI_CHAIN_STAGES = [
  {
    key: 'model',
    tickers: ['Anthropic', 'OpenAI', 'GOOGL'],
  },
  {
    key: 'cloud',
    tickers: ['GOOGL', 'AMZN', 'MSFT', 'META', 'NBIS'],
  },
  {
    key: 'chip',
    tickers: ['NVDA', 'AVGO', 'AMD', 'INTC'],
  },
  {
    key: 'memory',
    tickers: ['005930.KS', '000660.KS', 'MU', 'COHR', 'LITE'],
  },
  {
    key: 'packaging',
    tickers: ['TSM', 'LRCX', 'AMAT', 'KLAC'],
  },
  {
    key: 'power',
    tickers: ['BE'],
  },
];
```

- [ ] **Step 2: 新建 `AiChainPanel.vue` 组件**

创建 `frontend/src/components/AiChainPanel.vue`：

```vue
<template>
  <div class="ai-chain-panel">
    <div class="section-title">{{ $t('aiChain.title') }}</div>
    <div class="chain-flow">
      <div
        v-for="(stage, idx) in stages"
        :key="stage.key"
        :class="['chain-stage', { bottleneck: bottleneckStage === stage.key }]"
      >
        <div class="stage-header">
          <span class="stage-name">{{ $t(`aiChain.stages.${stage.key}`) }}</span>
          <span v-if="bottleneckStage === stage.key" class="bottleneck-tag">
            🔥 {{ $t('aiChain.currentBottleneck') }}
          </span>
        </div>
        <div class="stage-tickers">
          <span v-for="ticker in stage.tickers" :key="ticker" class="ticker-chip">{{ ticker }}</span>
        </div>
        <div v-if="idx < stages.length - 1" class="stage-arrow">↓</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { AI_CHAIN_STAGES } from '../data/aiChain.js';
import { api } from '../api/client.js';

const stages = AI_CHAIN_STAGES;
const bottleneckStage = ref(null);

onMounted(async () => {
  try {
    const data = await api.getBottleneck();
    bottleneckStage.value = data?.stage || null;
  } catch (e) {
    console.error('Failed to load bottleneck', e);
  }
});
</script>

<style scoped>
.ai-chain-panel { display: flex; flex-direction: column; gap: 12px; }

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: #eee;
  margin-bottom: 4px;
}

.chain-flow { display: flex; flex-direction: column; align-items: center; gap: 4px; }

.chain-stage {
  width: 100%;
  max-width: 480px;
  background: #111;
  border: 1px solid #222;
  border-radius: 10px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chain-stage.bottleneck {
  border-color: #5a3d1e;
  background: #1a140a;
}

.stage-header { display: flex; justify-content: space-between; align-items: center; }
.stage-name { font-size: 13px; color: #ccc; font-weight: 600; }
.bottleneck-tag { font-size: 11px; color: #facc15; }

.stage-tickers { display: flex; flex-wrap: wrap; gap: 6px; }
.ticker-chip {
  font-size: 11px;
  color: #6b9eff;
  background: #0d1a2e;
  border: 1px solid #1e3a5a;
  border-radius: 5px;
  padding: 2px 8px;
}

.stage-arrow { text-align: center; color: #444; font-size: 14px; }
</style>
```

- [ ] **Step 3: 在 `HomeView.vue` 中引入组件**

打开 `frontend/src/views/HomeView.vue`，将第1-24行整个文件内容替换为：

```vue
<template>
  <div class="home-view">
    <div class="workbench">
      <!-- 左栏：宏观信号面板 -->
      <div class="left-col">
        <MacroPanel />
      </div>
      <!-- 右栏：自选股面板 -->
      <div class="right-col">
        <WatchlistPanel />
      </div>
    </div>
    <!-- AI产业链地图 -->
    <div class="ai-chain-section">
      <AiChainPanel />
    </div>
    <!-- 首页底部：信号历史时间轴 -->
    <div class="timeline-section">
      <SignalTimeline />
    </div>
  </div>
</template>

<script setup>
import MacroPanel from '../components/MacroPanel.vue';
import WatchlistPanel from '../components/WatchlistPanel.vue';
import SignalTimeline from '../components/SignalTimeline.vue';
import AiChainPanel from '../components/AiChainPanel.vue';
</script>

<style scoped>
.home-view { display: flex; flex-direction: column; gap: 32px; }

.workbench {
  display: grid;
  grid-template-columns: 340px 1fr;
  gap: 24px;
}

.left-col, .right-col {
  background: #0d0d0d;
  border: 1px solid #1e1e1e;
  border-radius: 14px;
  padding: 20px;
  min-height: 400px;
}

.ai-chain-section {
  background: #0d0d0d;
  border: 1px solid #1e1e1e;
  border-radius: 14px;
  padding: 20px;
}

.timeline-section {
  background: #0d0d0d;
  border: 1px solid #1e1e1e;
  border-radius: 14px;
  padding: 20px;
}

@media (max-width: 768px) {
  .workbench { grid-template-columns: 1fr; }
}
</style>
```

- [ ] **Step 4: 手动验证前端构建通过**

Run: `cd frontend && npm run build`
Expected: 构建成功，无报错。

- [ ] **Step 5: Commit**

```bash
cd "D:\sheldonproject\StockSentinel"
git add frontend/src/data/aiChain.js frontend/src/components/AiChainPanel.vue frontend/src/views/HomeView.vue
git commit -m "feat: 新增AiChainPanel产业链地图展示组件"
```

---

## Task 10: 端到端验证

**Files:** 无代码改动，仅验证

- [ ] **Step 1: 运行完整后端测试套件**

Run: `cd backend && npm test`
Expected: PASS —— 全部测试通过（原有27个 + Task 1新增的6个AI供需相关分支 = 约33个测试全部通过）。

- [ ] **Step 2: 启动后端服务器**

Run: `cd backend && npm run dev`（保持在后台运行的终端窗口）

Expected: 输出 `[server] Stock Sentinel backend running on http://localhost:3001`，无报错。

- [ ] **Step 3: 验证 `/api/bottleneck` 公开接口可访问**

另开一个终端：

```bash
curl -s http://localhost:3001/api/bottleneck
```

Expected: 返回 `{"stage":null,"note":null}`（因为还没有设定过任何卡脖子环节数据）。

- [ ] **Step 4: 验证 `/api/signal` 返回包含 `aiSupplySignal` 字段**

```bash
curl -s http://localhost:3001/api/signal
```

Expected: 若FRED数据拉取成功，JSON响应体中包含 `"aiSupplySignal":"neutral"` 字段（因为还没有设定 admin override，默认回退到 `neutral`）。若返回 `{"status":"loading",...}`，说明cron首次执行还未完成或FRED调用失败，这是正常现象，不影响本次改动验证——可以直接跳到 Step 5 用浏览器测试前端展示逻辑（前端对 `status: 'loading'` 有专门处理，不会因为字段缺失而崩溃）。

- [ ] **Step 5: 启动前端开发服务器，浏览器验证**

另开一个终端：

```bash
cd "D:\sheldonproject\StockSentinel\frontend"
npm run dev
```

Expected: 输出本地访问地址（通常是 `http://localhost:5173`）。

在浏览器打开该地址，验证：
1. 注册/登录一个测试账号
2. 首页左栏信号位明细区展示4行（货币/财政/行政/AI供需），"中性"文案已变为"观望"
3. 首页新增的产业链面板区块正确展示6个环节及对应股票代码
4. 顶部主信号徽章文案为"进攻/观望/防守"（不再是"中性"）
5. 切换语言到 English，确认对应文案变为 "Watch"（而非 "Neutral"）

- [ ] **Step 6: 用管理员账号验证后台设定功能**

在浏览器中，用 `.env` 里配置的 `ADMIN_EMAIL` 对应账号登录，访问 `/admin` 路由，验证：
1. "设定信号位"表单的类型下拉框包含"AI供需"选项
2. 选择"AI供需" + "宽松"档位，保存后"当前信号位"展示区新增一行显示"AI供需：宽松"
3. "当前卡脖子环节"表单选择一个环节（如"设备/封装/测试"），保存后下方展示"当前最卡脖子环节：设备/封装/测试"
4. 返回首页，产业链面板对应的"设备/封装/测试"节点应显示🔥高亮标记

- [ ] **Step 7: 停止开发服务器**

在两个运行 `npm run dev` 的终端分别按 `Ctrl+C` 停止。

- [ ] **Step 8: 清理测试产生的数据库文件（可选，若不想保留手动测试数据）**

若希望恢复到干净状态供后续正式使用：

```bash
cd "D:\sheldonproject\StockSentinel"
rm -f backend/data/stock-sentinel.db
```

若想保留刚才手动验证时设定的信号位数据供继续开发调试参考，则跳过此步骤。

- [ ] **Step 9: 最终提交（若清理了数据库文件或有其他遗留改动）**

```bash
cd "D:\sheldonproject\StockSentinel"
git status
```

Expected: `backend/data/stock-sentinel.db` 不会出现在 `git status` 输出中（已被 `.gitignore` 排除）。若有其他未提交改动，逐一确认后提交；若无遗留改动，本任务无需额外 commit。

---

## Self-Review Notes

- **Spec覆盖检查**：设计文档第2/3/4/5/6/7/8/9节均已对应到 Task 1-9；第9节"范围之外"的三项（自动化数据源、定时抓取更新、实时报价联动）均未在计划中实现，符合设计。
- **占位符检查**：全文无 TBD/TODO，所有代码块均为完整可执行内容。
- **类型一致性检查**：`calcFinalSignal(monetary, fiscal, admin, aiSupply)` 的参数顺序在 Task 1（signal.js实现）、Task 4（server.js调用处）保持一致；`getBottleneck()`/`setBottleneck(stage, note, setBy)` 函数签名在 Task 2（定义）、Task 3（admin.js调用）、Task 4（server.js调用）、Task 7/9（前端api.getBottleneck/setBottleneck）保持一致；i18n key `aiChain.stages.*` 六个环节key（model/cloud/chip/memory/packaging/power）在 Task 3（后端VALID_STAGES）、Task 6（七语言翻译）、Task 7（AdminPanel下拉框）、Task 9（AiChainPanel展示）保持完全一致。
