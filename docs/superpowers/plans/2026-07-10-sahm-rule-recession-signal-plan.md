# 萨姆规则衰退信号 + 应对式利率调整锁定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增萨姆规则（失业率驱动的衰退预警）与应对式利率调整（大幅加息/降息）两个独立持久锁定状态机，触发后强制最终信号防守，直至利率降至零利率区间或转为小幅调整才解锁；同时把利率方向判断改为对称（加息/降息统一按调整幅度绝对值判定），并给管理员一个应急清锁入口。

**Architecture:** 后端在 `signal.js` 新增纯函数 `calcLockActive`（两个锁复用同一套判定逻辑），`fetch-macro.js` 新增萨姆规则数据拉取，`storage.js` 的 `signal_snapshots` 表新增锁状态列（路径依赖，每天基于前一条快照滚动推导），`server.js` 的 cron 和 `GET /api/signal` 在四维决策树结果之上叠加锁定强制覆盖。管理员清锁复用现有 `admin_signal_overrides` 表新增两个 type。前端 `MacroPanel.vue`/`SignalHero.vue` 展示锁状态，`mailer.js` 补充四种示警文案。

**Tech Stack:** Node.js + Express + sql.js（现有），Vue3 + vue-i18n（现有），Vitest（现有测试框架）。不引入新依赖。

---

## File Structure Overview

| 文件 | 改动类型 | 职责 |
|---|---|---|
| `backend/config/signal.config.js` | 改 | 常量重命名 + 萨姆/零利率阈值配置 |
| `backend/api/signal.js` | 改 | `rateSignal` 对称化 + 新增 `calcLockActive` + `detectSignalChanges` 扩展 |
| `backend/api/fetch-macro.js` | 改 | 新增萨姆规则数据拉取 |
| `backend/utils/storage.js` | 改 | 新增快照列 + `getAllOverrides` 支持新 type |
| `backend/server.js` | 改 | cron 里计算两个锁状态并存库 + API 响应叠加锁定覆盖 |
| `backend/utils/mailer.js` | 改 | 新增四种锁定示警文案 |
| `backend/api/admin.js` | 改 | 新增清锁 type 支持 |
| `frontend/src/components/AdminPanel.vue` | 改 | 新增清锁操作入口 |
| `frontend/src/components/MacroPanel.vue` | 改 | 新增萨姆规则展示行 |
| `frontend/src/components/SignalHero.vue` | 改 | 新增锁定横幅 |
| `frontend/src/i18n/locales/*.json`（7个） | 改 | 新增文案键 |
| `backend/tests/signal.test.js` | 改 | 更新既有用例 + 新增 `calcLockActive`/`detectSignalChanges` 测试 |
| `backend/tests/fetch-macro.test.js` | 改 | 新增萨姆规则拉取测试 |
| `backend/tests/alerts.test.js` | 改 | 新增锁定邮件文案测试 |

---

### Task 1: 配置常量重命名 + 新增阈值

**Files:**
- Modify: `backend/config/signal.config.js`

- [ ] **Step 1: 修改配置文件**

打开 `backend/config/signal.config.js`，把第 3-4 行：

```js
  // 利率判定：单次调整 >= 50bp 视为应对式加息（防守信号）
  RATE_REACTIVE_HIKE_BP: 50,
```

改为：

```js
  // 利率判定：单次调整幅度(绝对值) >= 50bp 视为应对式加息/应对式降息（防守信号），方向不限
  RATE_REACTIVE_ADJUSTMENT_BP: 50,

  // 零利率区间上限：利率目标上限降至此值以下视为"降到底"，是应对式调整锁/萨姆锁的解锁条件之一
  ZERO_RATE_FLOOR_PCT: 0.25,
```

在 `FRED_SERIES` 对象内（第 14-25 行），`UNEMPLOYMENT: 'UNRATE',` 这一行后面新增：

```js
    SAHM: 'SAHMREALTIME',           // 萨姆规则实时值（圣路易斯联储官方计算）
```

在 `FRED_SERIES` 对象结束后（原第 25 行 `},` 之后，第 27 行财政信号注释之前）新增：

```js
  // 萨姆规则：值 >= 阈值 视为经济进入衰退初期，触发衰退防守锁
  SAHM_TRIGGER_THRESHOLD: 0.5,
```

- [ ] **Step 2: 提交**

```bash
cd D:/sheldonproject/StockSentinel
git add backend/config/signal.config.js
git commit -m "refactor: 利率阈值常量重命名为方向不限，新增萨姆规则与零利率阈值配置"
```

---

### Task 2: `deriveSubSignals` 利率方向对称化

**Files:**
- Modify: `backend/api/signal.js:1-58`
- Test: `backend/tests/signal.test.js`

- [ ] **Step 1: 更新既有失败测试的预期值**

打开 `backend/tests/signal.test.js`，找到第 64-71 行：

```js
  it('中性：预防式加息 <50bp + 资产负债表暂停', () => {
    expect(calcMonetarySignal({
      currentRate: 4.5,
      prevRate: 4.25,
      currentBalanceSheet: 7200,
      prevBalanceSheet: 7200,
    })).toBe('neutral');
  });
```

改为：

```js
  it('宽松：预防式加息 <50bp（小幅加息/加息减缓）+ 资产负债表暂停', () => {
    expect(calcMonetarySignal({
      currentRate: 4.5,
      prevRate: 4.25,
      currentBalanceSheet: 7200,
      prevBalanceSheet: 7200,
    })).toBe('loose');
  });
```

再找到第 93-99 行：

```js
  it('49bp 加息视为预防式 neutral', () => {
    const { rateSignal } = deriveSubSignals({
      currentRate: 4.74, prevRate: 4.25,
      currentBalanceSheet: 7200, prevBalanceSheet: 7200,
    });
    expect(rateSignal).toBe('neutral');
  });
```

改为：

```js
  it('49bp 加息视为预防式 loose', () => {
    const { rateSignal } = deriveSubSignals({
      currentRate: 4.74, prevRate: 4.25,
      currentBalanceSheet: 7200, prevBalanceSheet: 7200,
    });
    expect(rateSignal).toBe('loose');
  });

  it('49bp 降息视为预防式 loose（对称）', () => {
    const { rateSignal } = deriveSubSignals({
      currentRate: 3.76, prevRate: 4.25,
      currentBalanceSheet: 7200, prevBalanceSheet: 7200,
    });
    expect(rateSignal).toBe('loose');
  });

  it('恰好 50bp 降息视为应对式 tight（对称）', () => {
    const { rateSignal } = deriveSubSignals({
      currentRate: 3.75, prevRate: 4.25,
      currentBalanceSheet: 7200, prevBalanceSheet: 7200,
    });
    expect(rateSignal).toBe('tight');
  });
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd D:/sheldonproject/StockSentinel/backend
npx vitest run tests/signal.test.js -t "预防式|49bp|50bp 降息"
```
Expected: FAIL（`neutral` 相关的两条断言现在与实现不符；新增的降息对称测试因实现未改而失败）

- [ ] **Step 3: 修改 `deriveSubSignals` 实现**

打开 `backend/api/signal.js`，把导入行（第 3-9 行）里的 `RATE_REACTIVE_HIKE_BP` 改名：

```js
const {
  SIGNAL, FINAL_SIGNAL, RATE_REACTIVE_ADJUSTMENT_BP, BALANCE_SHEET_PAUSE_THRESHOLD_PCT,
  FISCAL_TTM_CHANGE_THRESHOLD_PCT,
  EPU_PERCENTILE_TIGHT, EPU_PERCENTILE_LOOSE,
  AI_MARKET_REL_RETURN_THRESHOLD_PCT, AI_SEMI_IP_YOY_LOOSE_PCT, AI_SEMI_IP_YOY_TIGHT_PCT,
  AI_MODEL_USAGE_DECLINE_THRESHOLD_PCT, AI_CAPEX_YOY_TIGHT_PCT,
  SAHM_TRIGGER_THRESHOLD, ZERO_RATE_FLOOR_PCT,
} = cfg;
```

把第 36-58 行的 `deriveSubSignals` 函数体替换为：

```js
/**
 * 分解利率和资产负债表子信号
 */
export function deriveSubSignals(macroData) {
  const { currentRate, prevRate, currentBalanceSheet, prevBalanceSheet } = macroData;

  // 利率方向判断：按调整幅度绝对值统一处理，加息/降息对称
  let rateSignal;
  if (currentRate === null || prevRate === null) {
    rateSignal = 'neutral';
  } else {
    const rateDiffBp = Math.round((currentRate - prevRate) * 100); // 转换为 bp，正=加息，负=降息
    if (Math.abs(rateDiffBp) >= RATE_REACTIVE_ADJUSTMENT_BP) {
      rateSignal = 'tight'; // 应对式加息 或 应对式降息
    } else {
      rateSignal = 'loose'; // 暂停、预防式加息/降息（幅度<50bp，含加息减缓）
    }
  }

  const balanceSheetSignal = deriveBalanceSheetStatus(currentBalanceSheet, prevBalanceSheet);

  return { rateSignal, balanceSheetSignal };
}
```

- [ ] **Step 4: 运行测试确认全部通过**

```bash
cd D:/sheldonproject/StockSentinel/backend
npx vitest run tests/signal.test.js
```
Expected: PASS（全部用例，包括 `calcMonetarySignal` 描述块里第 73-80 行"降息 + QT 同时发生"的用例——该用例断言结果仍是 `tight`，因为触发条件是 QT 收缩 OR，不受本次改动影响，应保持通过不需要改）

- [ ] **Step 5: 提交**

```bash
git add backend/api/signal.js backend/tests/signal.test.js
git commit -m "feat: 利率信号位判断对称化，加息/降息统一按调整幅度绝对值判定"
```

---

### Task 3: 萨姆规则数据接入（`fetch-macro.js`）

**Files:**
- Modify: `backend/api/fetch-macro.js`
- Test: `backend/tests/fetch-macro.test.js`

- [ ] **Step 1: 写失败测试**

打开 `backend/tests/fetch-macro.test.js`，在第 27 行 `describe('fetchMacroData', () => {` 的第一个 `it` 块（第 28-74 行）里，`mockResolvedValueOnce` 链要新增一次调用（萨姆规则的 `fetchSeries`），并在 `mockResolvedValue`（兜底，供 `fetchReleaseDate` 用）前再插入一次 `mockResolvedValueOnce`（萨姆规则的 `fetchReleaseDate`）。把第 31-39 行改为：

```js
    axios.get
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } }) // rate
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } }) // balance sheet
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } }) // core PCE
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } }) // trimmed PCE 1M
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } }) // trimmed PCE 6M
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } }) // trimmed PCE 12M
      .mockResolvedValueOnce({ data: { observations: makeObs([4.75, 4.25, 4.0]) } }) // unemployment
      .mockResolvedValueOnce({ data: { observations: makeObs([0.6, 0.4, 0.2]) } }) // sahm
      .mockResolvedValue({ data: { observations: [{ date: '2024-01-01', value: '4.75', realtime_start: '2024-01-15' }] } });
```

在第 51 行 `expect(data).toHaveProperty('unemployment');` 之后新增：

```js
    expect(data).toHaveProperty('sahmValue');
    expect(data.sahmValue).toBe(0.6);
    expect(data.sahmPeriodDate).toBe('2024-01-01');
    expect(data.sahmReleaseDate).toBe('2024-01-15');
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd D:/sheldonproject/StockSentinel/backend
npx vitest run tests/fetch-macro.test.js
```
Expected: FAIL — `data.sahmValue` 是 `undefined`，`toBe(0.6)` 断言失败

- [ ] **Step 3: 实现萨姆规则拉取**

打开 `backend/api/fetch-macro.js`，第 74-75 行新增一行拉取起点（放在 `unStart` 定义之后）：

```js
  const unStart = daysAgoET(400);
  const sahmStart = daysAgoET(400);
```

第 77-85 行的 `Promise.all` 数组新增一个 fetch，改为：

```js
  const [rateObs, bsObs, corePceObs, trimmedPce1mObs, trimmedPceObs, trimmedPce12mObs, unrateObs, sahmObs] = await Promise.all([
    fetchSeries(FRED_SERIES.RATE, rateStart, apiKey),
    fetchSeries(FRED_SERIES.BALANCE_SHEET, bsStart, apiKey),
    fetchSeries(FRED_SERIES.CORE_PCE, pceStart, apiKey, 'pc1'),       // 同比变动百分比
    fetchSeries(FRED_SERIES.TRIMMED_MEAN_PCE_1M, pceStart, apiKey),   // 本身就是年化变动率
    fetchSeries(FRED_SERIES.TRIMMED_MEAN_PCE, pceStart, apiKey),       // 本身就是年化变动率
    fetchSeries(FRED_SERIES.TRIMMED_MEAN_PCE_12M, pceStart, apiKey),  // 本身就是同比变动率
    fetchSeries(FRED_SERIES.UNEMPLOYMENT, unStart, apiKey),
    fetchSeries(FRED_SERIES.SAHM, sahmStart, apiKey),
  ]);
```

第 94 行 `const unemploymentPeriodDate = latestDate(unrateObs);` 之后新增：

```js
  const sahmPeriodDate = latestDate(sahmObs);
```

第 95-101 行的第二个 `Promise.all`（发布日期查询）新增一项，改为：

```js
  const [corePceReleaseDate, trimmedPce1mReleaseDate, trimmedPceReleaseDate, trimmedPce12mReleaseDate, unemploymentReleaseDate, sahmReleaseDate] = await Promise.all([
    corePcePeriodDate ? fetchReleaseDate(FRED_SERIES.CORE_PCE, corePcePeriodDate, apiKey) : null,
    trimmedPce1mPeriodDate ? fetchReleaseDate(FRED_SERIES.TRIMMED_MEAN_PCE_1M, trimmedPce1mPeriodDate, apiKey) : null,
    trimmedPcePeriodDate ? fetchReleaseDate(FRED_SERIES.TRIMMED_MEAN_PCE, trimmedPcePeriodDate, apiKey) : null,
    trimmedPce12mPeriodDate ? fetchReleaseDate(FRED_SERIES.TRIMMED_MEAN_PCE_12M, trimmedPce12mPeriodDate, apiKey) : null,
    unemploymentPeriodDate ? fetchReleaseDate(FRED_SERIES.UNEMPLOYMENT, unemploymentPeriodDate, apiKey) : null,
    sahmPeriodDate ? fetchReleaseDate(FRED_SERIES.SAHM, sahmPeriodDate, apiKey) : null,
  ]);
```

在 return 对象里（第 116 行 `prevUnemployment: prevValue(unrateObs),` 之后）新增：

```js
    sahmValue: latestValue(sahmObs),
```

在 return 对象末尾（第 135-136 行 `unemploymentPeriodDate,` / `unemploymentReleaseDate,` 之后）新增：

```js
    sahmPeriodDate,
    sahmReleaseDate,
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd D:/sheldonproject/StockSentinel/backend
npx vitest run tests/fetch-macro.test.js
```
Expected: PASS（全部用例。注意第二个 `it('latest value 取第一条有效观测')` 用例第 78-91 行用 `mockResolvedValue`（无 `Once`）统一兜底所有调用，不受影响，天然通过）

- [ ] **Step 5: 提交**

```bash
git add backend/api/fetch-macro.js backend/tests/fetch-macro.test.js
git commit -m "feat: 新增萨姆规则(SAHMREALTIME)数据拉取"
```

---

### Task 4: `calcLockActive` 锁定判定函数

**Files:**
- Modify: `backend/api/signal.js`
- Test: `backend/tests/signal.test.js`

- [ ] **Step 1: 写失败测试**

在 `backend/tests/signal.test.js` 顶部的 import（第 1-6 行）里加入 `calcLockActive`：

```js
import {
  calcMonetarySignal, calcFinalSignal, deriveSubSignals, deriveBalanceSheetStatus,
  calcFiscalSignal, calcAdminSignal, deriveAiSupplySubSignals, calcAiSupplySignal,
  calcBubbleWarning, calcLockActive,
} from '../api/signal.js';
```

在文件末尾（第 311 行 `});` 之后，`calcFinalSignal` 描述块结束后）新增：

```js
// 衰退防守锁定判定：萨姆锁/应对式调整锁复用同一套判定逻辑
describe('calcLockActive', () => {
  it('触发进入锁定：萨姆值超阈值', () => {
    expect(calcLockActive({
      triggerToday: true, rateDiffBp: 0, currentRate: 4.25, prevLockActive: false,
    })).toBe(true);
  });

  it('触发进入锁定：大幅加息', () => {
    expect(calcLockActive({
      triggerToday: true, rateDiffBp: 75, currentRate: 5.0, prevLockActive: false,
    })).toBe(true);
  });

  it('触发进入锁定：大幅降息', () => {
    expect(calcLockActive({
      triggerToday: true, rateDiffBp: -75, currentRate: 3.5, prevLockActive: false,
    })).toBe(true);
  });

  it('锁定期间维持：触发条件当天不满足，但 prevLockActive 为真', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: 0, currentRate: 4.0, prevLockActive: true,
    })).toBe(true);
  });

  it('零利率解锁：currentRate <= 0.25 时无论其他条件如何都解锁', () => {
    expect(calcLockActive({
      triggerToday: true, rateDiffBp: 60, currentRate: 0.25, prevLockActive: true,
    })).toBe(false);
  });

  it('小幅调整解锁：非零且<50bp 的降息', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: -25, currentRate: 3.0, prevLockActive: true,
    })).toBe(false);
  });

  it('小幅调整解锁：非零且<50bp 的加息（不限方向）', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: 25, currentRate: 3.5, prevLockActive: true,
    })).toBe(false);
  });

  it('rateDiffBp === 0（无决议日/暂停决议）不解锁，锁定持续', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: 0, currentRate: 3.5, prevLockActive: true,
    })).toBe(true);
  });

  it('解锁优先级：触发条件和小幅调整解锁条件同天满足时，解锁生效', () => {
    expect(calcLockActive({
      triggerToday: true, rateDiffBp: 25, currentRate: 3.5, prevLockActive: false,
    })).toBe(false);
  });

  it('解锁优先级：触发条件和零利率解锁同天满足时，解锁生效', () => {
    expect(calcLockActive({
      triggerToday: true, rateDiffBp: -60, currentRate: 0.25, prevLockActive: false,
    })).toBe(false);
  });

  it('数据缺失：currentRate 为 null 时零利率解锁不生效', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: 0, currentRate: null, prevLockActive: true,
    })).toBe(true);
  });

  it('数据缺失：rateDiffBp 为 null 时小幅调整解锁不生效', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: null, currentRate: 3.5, prevLockActive: true,
    })).toBe(true);
  });

  it('无锁定、无触发、无解锁 → 保持未锁定', () => {
    expect(calcLockActive({
      triggerToday: false, rateDiffBp: 0, currentRate: 4.25, prevLockActive: false,
    })).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd D:/sheldonproject/StockSentinel/backend
npx vitest run tests/signal.test.js -t "calcLockActive"
```
Expected: FAIL with "calcLockActive is not a function" 或 import 报错

- [ ] **Step 3: 实现 `calcLockActive`**

打开 `backend/api/signal.js`，在 `deriveBalanceSheetStatus` 函数（第 64-71 行）之后新增：

```js
/**
 * 衰退防守锁定判定：萨姆锁 / 应对式调整锁 复用同一套逻辑
 * 解锁优先于触发：零利率区间(<=0.25%) 或 当天发生非零小幅调整(<50bp，不限方向) 即解锁；
 * rateDiffBp===0（无议息决议日 或 决议暂停）不触发小幅调整解锁，避免锁定被普通日子误解除
 * @returns {boolean}
 */
export function calcLockActive({ triggerToday, rateDiffBp, currentRate, prevLockActive }) {
  const zeroFloorUnlock = currentRate !== null && currentRate !== undefined
    && currentRate <= ZERO_RATE_FLOOR_PCT;
  const smallAdjustmentUnlock = rateDiffBp !== null && rateDiffBp !== undefined && rateDiffBp !== 0
    && Math.abs(rateDiffBp) < RATE_REACTIVE_ADJUSTMENT_BP;
  if (zeroFloorUnlock || smallAdjustmentUnlock) return false;
  return !!prevLockActive || !!triggerToday;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd D:/sheldonproject/StockSentinel/backend
npx vitest run tests/signal.test.js
```
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add backend/api/signal.js backend/tests/signal.test.js
git commit -m "feat: 新增calcLockActive衰退防守锁定判定函数"
```

---

### Task 5: `detectSignalChanges` 扩展锁定示警事件

**Files:**
- Modify: `backend/api/signal.js:158-185`
- Test: `backend/tests/alerts.test.js`

- [ ] **Step 1: 写失败测试**

打开 `backend/tests/alerts.test.js`，在 `basePrev`（第 5-12 行）新增两个字段：

```js
const basePrev = {
  final_signal: 'neutral',
  monetary_signal: 'loose',
  fiscal_signal: 'neutral',
  admin_signal: 'neutral',
  ai_supply_signal: 'loose',
  ai_bubble_warning: 0,
  sahm_lock_active: 0,
  reactive_adjustment_lock_active: 0,
};
```

在 `baseCurrent`（第 14-22 行）新增两个字段：

```js
const baseCurrent = {
  finalSignal: 'neutral',
  monetary: 'loose',
  fiscal: 'neutral',
  admin: 'neutral',
  aiSupply: 'loose',
  bubbleWarning: false,
  bubbleReasons: [],
  sahmLockActive: false,
  reactiveAdjustmentLockActive: false,
};
```

在 `describe('detectSignalChanges', ...)` 块末尾（第 66 行 `});` 前，"多事件同时发生"用例之后）新增：

```js
  it('萨姆锁 0→1 → sahmLockOn 事件', () => {
    const changes = detectSignalChanges(basePrev, { ...baseCurrent, sahmLockActive: true });
    expect(changes).toContainEqual({ kind: 'sahmLockOn' });
  });

  it('萨姆锁持续为1 → 不重复示警', () => {
    const prev = { ...basePrev, sahm_lock_active: 1 };
    expect(detectSignalChanges(prev, { ...baseCurrent, sahmLockActive: true })).toEqual([]);
  });

  it('萨姆锁 1→0 → sahmLockOff 事件', () => {
    const prev = { ...basePrev, sahm_lock_active: 1 };
    const changes = detectSignalChanges(prev, { ...baseCurrent, sahmLockActive: false });
    expect(changes).toContainEqual({ kind: 'sahmLockOff' });
  });

  it('应对式调整锁 0→1 → reactiveAdjustmentLockOn 事件，附带触发幅度', () => {
    const changes = detectSignalChanges(basePrev, {
      ...baseCurrent, reactiveAdjustmentLockActive: true, reactiveAdjustmentLockTriggerBp: -75,
    });
    expect(changes).toContainEqual({ kind: 'reactiveAdjustmentLockOn', bp: -75 });
  });

  it('应对式调整锁持续为1 → 不重复示警', () => {
    const prev = { ...basePrev, reactive_adjustment_lock_active: 1 };
    expect(detectSignalChanges(prev, { ...baseCurrent, reactiveAdjustmentLockActive: true })).toEqual([]);
  });

  it('应对式调整锁 1→0 → reactiveAdjustmentLockOff 事件', () => {
    const prev = { ...basePrev, reactive_adjustment_lock_active: 1 };
    const changes = detectSignalChanges(prev, { ...baseCurrent, reactiveAdjustmentLockActive: false });
    expect(changes).toContainEqual({ kind: 'reactiveAdjustmentLockOff' });
  });
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd D:/sheldonproject/StockSentinel/backend
npx vitest run tests/alerts.test.js -t "锁"
```
Expected: FAIL — 新增的 `kind` 事件目前不会被 `detectSignalChanges` 产出，`toContainEqual` 断言失败

- [ ] **Step 3: 实现扩展**

打开 `backend/api/signal.js`，在 `detectSignalChanges` 函数（第 158-185 行）里，第 180-184 行（泡沫预警检测之后、`return changes;` 之前）新增：

```js
  if (!prevSnapshot.sahm_lock_active && current.sahmLockActive) {
    changes.push({ kind: 'sahmLockOn' });
  } else if (prevSnapshot.sahm_lock_active && !current.sahmLockActive) {
    changes.push({ kind: 'sahmLockOff' });
  }

  if (!prevSnapshot.reactive_adjustment_lock_active && current.reactiveAdjustmentLockActive) {
    changes.push({ kind: 'reactiveAdjustmentLockOn', bp: current.reactiveAdjustmentLockTriggerBp ?? null });
  } else if (prevSnapshot.reactive_adjustment_lock_active && !current.reactiveAdjustmentLockActive) {
    changes.push({ kind: 'reactiveAdjustmentLockOff' });
  }
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd D:/sheldonproject/StockSentinel/backend
npx vitest run tests/alerts.test.js
```
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add backend/api/signal.js backend/tests/alerts.test.js
git commit -m "feat: detectSignalChanges新增萨姆锁/应对式调整锁的On/Off示警事件"
```

---

### Task 6: 数据库 schema 扩展

**Files:**
- Modify: `backend/utils/storage.js`

- [ ] **Step 1: 新增迁移列**

打开 `backend/utils/storage.js`，在 `SIGNAL_SNAPSHOT_NEW_COLUMNS` 数组（第 29-71 行）末尾，`'ai_bubble_warning INTEGER',` 之后新增：

```js
  'sahm_value REAL',
  'sahm_period_date TEXT',
  'sahm_release_date TEXT',
  'sahm_lock_active INTEGER',
  'reactive_adjustment_lock_active INTEGER',
  'reactive_adjustment_lock_trigger_bp REAL',
```

- [ ] **Step 2: 同步建表语句**

在 `initSchema` 函数里 `signal_snapshots` 的 `CREATE TABLE` 语句（第 108-166 行）中，`ai_bubble_warning INTEGER,` 那一行（第 163 行）之后新增：

```sql
      sahm_value REAL,
      sahm_period_date TEXT,
      sahm_release_date TEXT,
      sahm_lock_active INTEGER,
      reactive_adjustment_lock_active INTEGER,
      reactive_adjustment_lock_trigger_bp REAL,
```

- [ ] **Step 3: 扩展 `saveSignalSnapshot`**

在 `saveSignalSnapshot` 函数（第 282-319 行）里，INSERT 语句的列清单（第 285-300 行）末尾 `ai_bubble_warning)` 改为：

```sql
     model_usage_trend_pct, capex_yoy, ai_bubble_warning,
     sahm_value, sahm_period_date, sahm_release_date,
     sahm_lock_active, reactive_adjustment_lock_active, reactive_adjustment_lock_trigger_bp)
```

VALUES 占位符（第 301 行）末尾补 6 个 `?`，改为：

```sql
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

（原有 54 个占位符 + 新增 6 个 = 60 个）

参数数组（第 302-318 行）末尾 `data.modelUsageTrendPct, data.capexYoY, data.aiBubbleWarning,` 那一行改为：

```js
    data.modelUsageTrendPct, data.capexYoY, data.aiBubbleWarning,
    data.sahmValue, data.sahmPeriodDate, data.sahmReleaseDate,
    data.sahmLockActive, data.reactiveAdjustmentLockActive, data.reactiveAdjustmentLockTriggerBp,
  ]);
```

- [ ] **Step 4: 扩展 `getAllOverrides` 支持清锁 type**

在 `getAllOverrides` 函数（第 363-370 行）里新增两个 type 的查询：

```js
export async function getAllOverrides() {
  const [fiscal, administrative, aiSupply, sahmLockClear, reactiveAdjustmentLockClear] = await Promise.all([
    getActiveAdminSignal('fiscal'),
    getActiveAdminSignal('administrative'),
    getActiveAdminSignal('ai_supply'),
    getActiveAdminSignal('sahmLock'),
    getActiveAdminSignal('reactiveAdjustmentLock'),
  ]);
  return { fiscal, administrative, aiSupply, sahmLockClear, reactiveAdjustmentLockClear };
}
```

- [ ] **Step 5: 验证 schema 迁移可跑通**

现有 `.db` 文件在开发环境下会通过 `migrateSchema()` 自动补列，不需要手写迁移脚本。运行一次现有测试套件确认没有因为 schema 改动而报错：

```bash
cd D:/sheldonproject/StockSentinel/backend
npx vitest run
```
Expected: PASS（本任务不涉及新测试，只是验证现有测试在 schema 变化后仍能跑通——`storage.js` 目前没有专门的测试文件，改动通过后续 Task 里对 `server.js` 集成行为的验证间接覆盖）

- [ ] **Step 6: 提交**

```bash
git add backend/utils/storage.js
git commit -m "feat: signal_snapshots新增萨姆规则与应对式调整锁字段，getAllOverrides支持清锁type"
```

---

### Task 7: `admin.js` 支持清锁 override

**Files:**
- Modify: `backend/api/admin.js`

- [ ] **Step 1: 扩展 `VALID_TYPES` 和信号值校验**

打开 `backend/api/admin.js`，第 14-15 行：

```js
const VALID_SIGNALS = ['loose', 'neutral', 'tight'];
const VALID_TYPES = ['fiscal', 'administrative', 'ai_supply'];
```

改为：

```js
const VALID_SIGNALS = ['loose', 'neutral', 'tight'];
const VALID_TYPES = ['fiscal', 'administrative', 'ai_supply'];
const VALID_LOCK_TYPES = ['sahmLock', 'reactiveAdjustmentLock'];
const LOCK_CLEAR_SIGNAL = 'cleared';
```

- [ ] **Step 2: 新增清锁路由**

在 `POST /api/admin/signals` 路由（第 36-49 行）之后新增一个独立路由：

```js
// POST /api/admin/lock-override — 应急清除萨姆锁/应对式调整锁（FRED数据异常误触发时用）
router.post('/lock-override', requireAdmin, async (req, res) => {
  const { type, expiresAt, note } = req.body;

  if (!VALID_LOCK_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_LOCK_TYPES.join(', ')}` });
  }

  await setAdminSignal(type, LOCK_CLEAR_SIGNAL, expiresAt || null, note || null, req.user.email);
  res.json({ ok: true, type, expiresAt: expiresAt || null });
});
```

- [ ] **Step 3: 手动验证路由注册无误**

```bash
cd D:/sheldonproject/StockSentinel/backend
node -e "import('./api/admin.js').then(() => console.log('admin.js loaded OK')).catch(e => { console.error(e); process.exit(1); })"
```
Expected: 输出 `admin.js loaded OK`，无报错

- [ ] **Step 4: 提交**

```bash
git add backend/api/admin.js
git commit -m "feat: 新增管理员应急清锁API POST /api/admin/lock-override"
```

---

### Task 8: `server.js` 集成锁定计算与最终信号覆盖

**Files:**
- Modify: `backend/server.js`

- [ ] **Step 1: 更新 import**

打开 `backend/server.js`，第 15-25 行的 `signal.js` import 新增 `calcLockActive`，并新增一行导入 `signal.config.js`（该文件是 `export default {...}` 默认导出，所以整体导入后取属性，不能用命名导入）：

```js
import {
  calcMonetarySignal,
  calcFinalSignal,
  calcFiscalSignal,
  calcAdminSignal,
  calcAiSupplySignal,
  deriveAiSupplySubSignals,
  deriveSubSignals,
  calcBubbleWarning,
  calcLockActive,
  detectSignalChanges,
} from './api/signal.js';
import signalCfg from './config/signal.config.js';
```

- [ ] **Step 2: 抽出共享的锁计算辅助函数**

在 `runDailyUpdate` 函数定义（第 217 行）之前新增一个模块级辅助函数：

```js
/**
 * 根据当天 macroData 和前一条快照，计算两个锁的 effective 状态（应用管理员清锁 override 后）
 * @returns {{sahmValue, rateDiffBp, sahmLockActive, reactiveAdjustmentLockActive, reactiveAdjustmentLockTriggerBp,
 *            sahmLockOverridden, reactiveAdjustmentLockOverridden}}
 */
function computeLocks(macroData, prevSnapshot, overrides) {
  const { currentRate, prevRate, sahmValue } = macroData;
  const rateDiffBp = currentRate !== null && prevRate !== null
    ? Math.round((currentRate - prevRate) * 100)
    : null;

  const prevSahmLockActive = prevSnapshot ? !!prevSnapshot.sahm_lock_active : false;
  const prevReactiveLockActive = prevSnapshot ? !!prevSnapshot.reactive_adjustment_lock_active : false;
  const prevTriggerBp = prevSnapshot ? prevSnapshot.reactive_adjustment_lock_trigger_bp : null;

  const sahmTrigger = sahmValue !== null && sahmValue !== undefined
    && sahmValue >= signalCfg.SAHM_TRIGGER_THRESHOLD;
  const reactiveTrigger = rateDiffBp !== null && Math.abs(rateDiffBp) >= signalCfg.RATE_REACTIVE_ADJUSTMENT_BP;

  const rawSahmLockActive = calcLockActive({
    triggerToday: sahmTrigger, rateDiffBp, currentRate, prevLockActive: prevSahmLockActive,
  });
  const rawReactiveLockActive = calcLockActive({
    triggerToday: reactiveTrigger, rateDiffBp, currentRate, prevLockActive: prevReactiveLockActive,
  });

  let reactiveAdjustmentLockTriggerBp = null;
  if (reactiveTrigger) {
    reactiveAdjustmentLockTriggerBp = rateDiffBp;
  } else if (rawReactiveLockActive) {
    reactiveAdjustmentLockTriggerBp = prevTriggerBp;
  }

  const sahmLockOverridden = !!overrides.sahmLockClear;
  const reactiveAdjustmentLockOverridden = !!overrides.reactiveAdjustmentLockClear;

  return {
    sahmValue,
    rateDiffBp,
    sahmLockActive: sahmLockOverridden ? false : rawSahmLockActive,
    reactiveAdjustmentLockActive: reactiveAdjustmentLockOverridden ? false : rawReactiveLockActive,
    reactiveAdjustmentLockTriggerBp: reactiveAdjustmentLockOverridden ? null : reactiveAdjustmentLockTriggerBp,
    sahmLockOverridden,
    reactiveAdjustmentLockOverridden,
  };
}
```

- [ ] **Step 3: `GET /api/signal` 叠加锁定覆盖**

在 `GET /api/signal` 路由（第 60-141 行）里，第 64 行：

```js
  const { fiscal: fiscalOverride, administrative: adminOverride, aiSupply: aiSupplyOverride } = await getAllOverrides();
```

改为：

```js
  const overrides = await getAllOverrides();
  const { fiscal: fiscalOverride, administrative: adminOverride, aiSupply: aiSupplyOverride } = overrides;
```

第 66-69 行之后（`aiSupplySignal` 赋值之后）新增：

**背景说明**：锁状态已经在 cron 里算好并直接存入了当天快照的 `sahm_lock_active`/`reactive_adjustment_lock_active` 列（存的是 effective 值，即已经应用过当天 override 的结果，见 Step 4）。但 `GET /api/signal` 每次请求都要重新应用"当前"的 override（因为 override 可能在 cron 跑完之后才被管理员设置或过期），所以这里不调用 `computeLocks`（那是给 cron 用的、依赖 `rateDiffBp`/`prevSnapshot` 重新推导锁状态的函数），而是直接读快照里存的锁状态原始值，再叠加当前实时查到的 override：

```js
  const rawSahmLockActive = !!snapshot.sahm_lock_active;
  const rawReactiveLockActive = !!snapshot.reactive_adjustment_lock_active;
  const sahmLockOverridden = !!overrides.sahmLockClear;
  const reactiveAdjustmentLockOverridden = !!overrides.reactiveAdjustmentLockClear;
  const sahmLockActive = sahmLockOverridden ? false : rawSahmLockActive;
  const reactiveAdjustmentLockActive = reactiveAdjustmentLockOverridden ? false : rawReactiveLockActive;
```

第 71-73 行：

```js
  res.json({
    // 读取时实时重算，避免 override 在 cron 之后变化导致与快照不一致
    finalSignal: calcFinalSignal(aiSupplySignal, snapshot.monetary_signal, fiscalSignal, adminSignal),
```

改为：

```js
  const decisionTreeSignal = calcFinalSignal(aiSupplySignal, snapshot.monetary_signal, fiscalSignal, adminSignal);
  const finalSignal = (sahmLockActive || reactiveAdjustmentLockActive) ? 'defense' : decisionTreeSignal;

  res.json({
    // 读取时实时重算决策树，再叠加衰退防守锁定强制覆盖，避免 override 在 cron 之后变化导致与快照不一致
    finalSignal,
```

在 `indicators` 对象末尾（第 136 行 `aiBubbleWarning: !!snapshot.ai_bubble_warning,` 之后）新增：

```js
      sahmValue: snapshot.sahm_value,
      sahmPeriodDate: snapshot.sahm_period_date,
      sahmReleaseDate: snapshot.sahm_release_date,
      sahmLockActive,
      reactiveAdjustmentLockActive,
      reactiveAdjustmentLockTriggerBp: reactiveAdjustmentLockActive ? snapshot.reactive_adjustment_lock_trigger_bp : null,
      sahmLockOverridden,
      reactiveAdjustmentLockOverridden,
```

- [ ] **Step 4: `runDailyUpdate` 计算并存储锁状态**

在 `runDailyUpdate` 函数（第 217-357 行）里，找到第 241 行：

```js
  const { fiscal: fiscalOverride, administrative: adminOverride, aiSupply: aiSupplyOverride } = await getAllOverrides();
```

改为：

```js
  const overrides = await getAllOverrides();
  const { fiscal: fiscalOverride, administrative: adminOverride, aiSupply: aiSupplyOverride } = overrides;
```

锁定计算需要用到 `prevSnapshot`（第 250 行才获取），所以把 `prevSnapshot` 的获取提前到锁定计算之前。将第 247-250 行原文：

```js
  const finalSignal = calcFinalSignal(aiSupply, monetary, fiscal, admin);

  const today = todayET();
  const prevSnapshot = await getLatestSnapshot();
```

整体替换为：

```js
  const decisionTreeSignal = calcFinalSignal(aiSupply, monetary, fiscal, admin);

  const today = todayET();
  const prevSnapshot = await getLatestSnapshot();

  const locks = computeLocks(macroData, prevSnapshot, overrides);
  const finalSignal = (locks.sahmLockActive || locks.reactiveAdjustmentLockActive) ? 'defense' : decisionTreeSignal;
```

在 `saveSignalSnapshot` 调用（第 252-307 行）里，第 265 行 `fredUnemployment: macroData.unemployment,` 之后新增：

```js
    sahmValue: macroData.sahmValue,
```

第 286 行 `unemploymentReleaseDate: macroData.unemploymentReleaseDate,` 之后新增：

```js
    sahmPeriodDate: macroData.sahmPeriodDate,
    sahmReleaseDate: macroData.sahmReleaseDate,
```

第 306 行 `aiBubbleWarning: bubble.warning ? 1 : 0,` 之后新增（注意这里存的是"应用 override 前"的原始判定值 `rawSahmLockActive`/`rawReactiveLockActive` 逻辑已经封装在 `computeLocks` 里，但 `computeLocks` 返回的是"应用 override 后"的 effective 值——存库应该存 **effective 值**，因为下一天的 `prevLockActive` 推导要基于"实际生效的锁状态"，管理员清锁之后应该真的从"未锁定"重新开始判断，这与设计文档第 7 节"清锁只需生效一次，其 false 会随当天快照存入，成为次日 prevLockActive 的起点"一致）：

```js
    sahmLockActive: locks.sahmLockActive ? 1 : 0,
    reactiveAdjustmentLockActive: locks.reactiveAdjustmentLockActive ? 1 : 0,
    reactiveAdjustmentLockTriggerBp: locks.reactiveAdjustmentLockTriggerBp,
```

- [ ] **Step 5: 示警事件传入锁定跳变数据**

在 `detectSignalChanges` 调用（第 326-334 行）：

```js
  const changes = detectSignalChanges(prevSnapshot, {
    finalSignal,
    monetary,
    fiscal,
    admin,
    aiSupply,
    bubbleWarning: bubble.warning,
    bubbleReasons: bubble.reasons,
  });
```

改为：

```js
  const changes = detectSignalChanges(prevSnapshot, {
    finalSignal,
    monetary,
    fiscal,
    admin,
    aiSupply,
    bubbleWarning: bubble.warning,
    bubbleReasons: bubble.reasons,
    sahmLockActive: locks.sahmLockActive,
    reactiveAdjustmentLockActive: locks.reactiveAdjustmentLockActive,
    reactiveAdjustmentLockTriggerBp: locks.reactiveAdjustmentLockTriggerBp,
  });
```

- [ ] **Step 6: 邮件 details 补充锁定数值**

在 `sendSignalAlert` 调用的 `details` 对象（第 342-353 行）末尾新增：

```js
        details: {
          monetary, fiscal, admin, aiSupply,
          fiscalDeficitChangePct: policyData.deficitTtmChangePct,
          epuTradePercentile: policyData.epuTradePercentile,
          smhSpyRelReturnPct: policyData.smhSpyRelReturnPct,
          semiIpYoy: policyData.semiIpYoy,
          modelUsageTrendPct: chainData.modelUsageTrendPct,
          capexYoY: chainData.capexYoY,
          rateChangeBp: locks.rateDiffBp,
          sahmValue: macroData.sahmValue,
        },
```

（`rateChangeBp` 原来是通过 `macroData.currentRate`/`prevRate` 手动重算的，现在 `computeLocks` 已经算好了 `rateDiffBp`，直接复用，避免重复计算逻辑）

- [ ] **Step 7: 运行现有测试确认无回归**

```bash
cd D:/sheldonproject/StockSentinel/backend
npx vitest run
```
Expected: PASS（`server.js` 本身没有单元测试文件，此步骤运行全量测试确认其他模块未被间接破坏）

- [ ] **Step 8: 本地启动验证（需要 `.env` 配置 `FRED_API_KEY`）**

```bash
cd D:/sheldonproject/StockSentinel/backend
node server.js
```

观察终端输出，确认 cron 首次运行日志包含 `[cron] Signal updated: ...` 且没有抛出异常。启动后按 Ctrl+C 停止。若本机没有配置 `FRED_API_KEY`，跳过此步骤（`fetchMacroData` 会 throw，cron 会捕获并打印 `[cron] FRED fetch failed`，属于既有容错行为，不是本次改动引入的问题）。

- [ ] **Step 9: 提交**

```bash
git add backend/server.js
git commit -m "feat: server.js集成萨姆锁/应对式调整锁计算，最终信号叠加防守强制覆盖"
```

---

### Task 9: `mailer.js` 新增锁定示警文案

**Files:**
- Modify: `backend/utils/mailer.js`
- Test: `backend/tests/alerts.test.js`

- [ ] **Step 1: 写失败测试**

在 `backend/tests/alerts.test.js` 的 `describe('buildAlertEmail', ...)` 块（第 69-98 行）末尾（第 97 行 `});` 之前）新增：

```js
  it('萨姆锁触发 On → 邮件正文含衰退防守文案', () => {
    const { html } = buildAlertEmail({
      finalSignal: 'defense',
      changes: [{ kind: 'sahmLockOn' }],
      details: { monetary: 'loose', fiscal: 'loose', admin: 'loose', aiSupply: 'loose', sahmValue: 0.6 },
    });
    expect(html).toContain('萨姆规则');
  });

  it('萨姆锁解除 Off → 邮件正文含解除文案', () => {
    const { html } = buildAlertEmail({
      finalSignal: 'neutral',
      changes: [{ kind: 'sahmLockOff' }],
      details: { monetary: 'loose', fiscal: 'loose', admin: 'loose', aiSupply: 'loose' },
    });
    expect(html).toContain('解除');
  });

  it('应对式调整锁触发 On → 邮件正文含调整幅度', () => {
    const { html } = buildAlertEmail({
      finalSignal: 'defense',
      changes: [{ kind: 'reactiveAdjustmentLockOn', bp: -75 }],
      details: { monetary: 'tight', fiscal: 'loose', admin: 'loose', aiSupply: 'loose' },
    });
    expect(html).toContain('-75');
  });

  it('应对式调整锁解除 Off → 邮件正文含解除文案', () => {
    const { html } = buildAlertEmail({
      finalSignal: 'neutral',
      changes: [{ kind: 'reactiveAdjustmentLockOff' }],
      details: { monetary: 'loose', fiscal: 'loose', admin: 'loose', aiSupply: 'loose' },
    });
    expect(html).toContain('解除');
  });
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd D:/sheldonproject/StockSentinel/backend
npx vitest run tests/alerts.test.js -t "萨姆锁|应对式调整锁"
```
Expected: FAIL — `buildAlertEmail` 目前不认识这四种 `kind`，`lines` 数组不会包含对应文案，`html` 不含"萨姆规则"/"解除"/"-75"

- [ ] **Step 3: 实现文案**

打开 `backend/utils/mailer.js`，在 `buildAlertEmail` 函数（第 30-80 行）里，第 33-43 行的 `for (const c of changes)` 循环内新增分支，改为：

```js
  const lines = [];
  for (const c of changes) {
    if (c.kind === 'final') {
      lines.push(`⚡ 最终信号变更 Signal changed: <strong>${SIGNAL_LABELS[c.from]}</strong> → <strong>${SIGNAL_LABELS[c.to]}</strong>`);
    } else if (c.kind === 'dimTight') {
      lines.push(`🔴 ${DIM_LABELS[c.dim]} 转为收紧 turned TIGHT${dimDetail(c.dim, details)}`);
    } else if (c.kind === 'bubble') {
      const reasons = (c.reasons || []).map(r => BUBBLE_REASON_LABELS[r] || r).join('；');
      lines.push(`⚠️ AI泡沫预警触发 Bubble warning triggered：${reasons}`);
    } else if (c.kind === 'sahmLockOn') {
      const sahmStr = details.sahmValue != null ? `（当前值 ${Number(details.sahmValue).toFixed(2)}）` : '';
      lines.push(`🔴 萨姆规则触发，进入衰退防守锁定 Sahm Rule triggered, recession defense lock activated${sahmStr}`);
    } else if (c.kind === 'sahmLockOff') {
      lines.push(`🟢 萨姆规则衰退防守锁定已解除 Sahm Rule recession defense lock released`);
    } else if (c.kind === 'reactiveAdjustmentLockOn') {
      const bpStr = c.bp != null ? `（单次调整 ${c.bp}bp）` : '';
      lines.push(`🔴 应对式利率调整触发，进入衰退防守锁定 Reactive rate adjustment triggered, recession defense lock activated${bpStr}`);
    } else if (c.kind === 'reactiveAdjustmentLockOff') {
      lines.push(`🟢 应对式利率调整防守锁定已解除 Reactive rate adjustment defense lock released`);
    }
  }
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd D:/sheldonproject/StockSentinel/backend
npx vitest run tests/alerts.test.js
```
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add backend/utils/mailer.js backend/tests/alerts.test.js
git commit -m "feat: mailer.js新增萨姆锁/应对式调整锁的On/Off示警邮件文案"
```

---

### Task 10: 前端 API client 扩展

**Files:**
- Modify: `frontend/src/api/client.js`

- [ ] **Step 1: 新增清锁 API 方法**

打开 `frontend/src/api/client.js`，在 `// Admin` 分组（第 39-44 行）末尾新增：

```js
  setLockOverride: (type, expiresAt, note) =>
    request('/admin/lock-override', { method: 'POST', body: JSON.stringify({ type, expiresAt, note }) }),
```

- [ ] **Step 2: 手动验证语法**

```bash
cd D:/sheldonproject/StockSentinel/frontend
node --input-type=module -e "$(cat src/api/client.js)" 2>&1 | head -5
```
Expected: 无语法错误输出（该文件不依赖浏览器 API，可以直接用 node 解析校验语法；`fetch`/`localStorage` 未定义的运行时错误可以忽略，只要不是 SyntaxError）

- [ ] **Step 3: 提交**

```bash
git add frontend/src/api/client.js
git commit -m "feat: 前端api client新增setLockOverride清锁方法"
```

---

### Task 11: i18n 文案（7个语言包）

**Files:**
- Modify: `frontend/src/i18n/locales/zh.json`
- Modify: `frontend/src/i18n/locales/en.json`
- Modify: `frontend/src/i18n/locales/fr.json`
- Modify: `frontend/src/i18n/locales/de.json`
- Modify: `frontend/src/i18n/locales/es.json`
- Modify: `frontend/src/i18n/locales/ja.json`
- Modify: `frontend/src/i18n/locales/ko.json`

- [ ] **Step 1: zh.json 新增文案**

打开 `frontend/src/i18n/locales/zh.json`，在 `indicators` 对象（第 23-56 行）里，`"unemployment": "失业率",` 那一行（第 31 行）之后新增：

```json
    "sahm": "萨姆规则",
```

`"unit"` 对象（第 42-47 行）里，`"unemployment": "%"` 之后新增：

```json
      "sahm": "%"
```

在顶层新增 `recessionLock` 对象（放在 `"interpret"` 对象之后、`"auth"` 对象之前，即第 85 行 `},` 之后）：

```json
  "recessionLock": {
    "banner": "防守锁定中",
    "sahmReason": "萨姆规则 {value}（阈值 ≥0.5）",
    "reactiveReason": "应对式利率调整 {bp}bp",
    "waitCondition": "等待利率降至0-0.25%或转为小幅调整解锁",
    "overridden": "已被管理员手动清除"
  },
```

在 `admin` 对象（第 99-117 行）末尾（`"bottleneckAuto": "自动识别（跟随环节排名）"` 之后）新增：

```json
    "clearLock": "清除锁定",
    "clearSahmLock": "清除萨姆锁",
    "clearReactiveLock": "清除应对式调整锁",
    "lockOverrideNote": "应急阀门：若判定为数据异常导致误触发，可手动清除"
```

**注意**：由于 JSON 不允许尾随逗号，插入这些字段时要确认该字段是否是对象里的最后一个——`admin` 对象目前最后一个字段是 `"bottleneckAuto": "..."`（无尾逗号），插入新字段时需要在 `"bottleneckAuto": "..."` 后面加逗号，新增字段之间用逗号分隔，最后一个新增字段不加逗号。

- [ ] **Step 2: 运行 JSON 校验**

```bash
cd D:/sheldonproject/StockSentinel/frontend
node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/zh.json', 'utf-8')); console.log('zh.json OK')"
```
Expected: 输出 `zh.json OK`，无 SyntaxError

- [ ] **Step 3: en.json 新增文案**

打开 `frontend/src/i18n/locales/en.json`，对应位置新增（`"unemployment": "Unemployment Rate",` 之后）：

```json
    "sahm": "Sahm Rule",
```

`unit` 对象里新增：

```json
      "sahm": "%"
```

顶层新增 `recessionLock`：

```json
  "recessionLock": {
    "banner": "Defense Lock Active",
    "sahmReason": "Sahm Rule {value} (threshold ≥0.5)",
    "reactiveReason": "Reactive rate adjustment {bp}bp",
    "waitCondition": "Waiting for rate to reach 0-0.25% or a small adjustment to unlock",
    "overridden": "Manually cleared by admin"
  },
```

`admin` 对象末尾新增：

```json
    "clearLock": "Clear Lock",
    "clearSahmLock": "Clear Sahm Lock",
    "clearReactiveLock": "Clear Reactive Adjustment Lock",
    "lockOverrideNote": "Emergency valve: manually clear if data anomaly caused a false trigger"
```

- [ ] **Step 4: 运行 JSON 校验**

```bash
cd D:/sheldonproject/StockSentinel/frontend
node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/en.json', 'utf-8')); console.log('en.json OK')"
```
Expected: 输出 `en.json OK`

- [ ] **Step 5: fr/de/es/ja/ko.json 新增文案**

这五个语言包结构是单行紧凑格式（每个顶层 key 一行）。分别在对应文件里，找到 `indicators` 那一行的 `"unemployment": "..."`片段后面插入 `"sahm": "..."`，在 `unit` 子对象里插入 `"sahm": "%"`，并在文件末尾（`aiChain` 那一行）之后新增一行 `recessionLock`，在 `admin` 片段末尾插入清锁文案键。

`fr.json` 第 4 行（`indicators` 行）里 `"unemployment": "Chômage",` 之后插入 `"sahm": "Règle de Sahm",`；`unit` 里插入 `"sahm": "%"`；`admin` 片段（第 10 行）`"bottleneckAuto": "Automatique (selon classement)"` 之后插入 `, "clearLock": "Effacer le verrou", "clearSahmLock": "Effacer le verrou Sahm", "clearReactiveLock": "Effacer le verrou d'ajustement réactif", "lockOverrideNote": "Vanne d'urgence : effacer manuellement si une anomalie de données a causé un déclenchement erroné"`；文件末尾（`aiChain` 那一行，第 14 行）之后新增第 15 行：

```json
  "recessionLock": { "banner": "Verrou de Défense Actif", "sahmReason": "Règle de Sahm {value} (seuil ≥0.5)", "reactiveReason": "Ajustement de taux réactif {bp}bp", "waitCondition": "En attente que le taux atteigne 0-0.25% ou qu'un ajustement mineur déverrouille", "overridden": "Effacé manuellement par l'administrateur" },
```

`de.json` 对应插入：`indicators` 里 `"unemployment": "Arbeitslosigkeit",` 后插入 `"sahm": "Sahm-Regel",`；`unit` 里插入 `"sahm": "%"`；`admin` 末尾插入 `, "clearLock": "Sperre aufheben", "clearSahmLock": "Sahm-Sperre aufheben", "clearReactiveLock": "Reaktive Anpassungssperre aufheben", "lockOverrideNote": "Notventil: manuell aufheben, wenn eine Datenanomalie einen Fehlauslöser verursacht hat"`；文件末尾新增：

```json
  "recessionLock": { "banner": "Verteidigungssperre Aktiv", "sahmReason": "Sahm-Regel {value} (Schwelle ≥0.5)", "reactiveReason": "Reaktive Zinsanpassung {bp}bp", "waitCondition": "Warten, bis der Zinssatz 0-0.25% erreicht oder eine kleine Anpassung entsperrt", "overridden": "Manuell vom Administrator aufgehoben" },
```

`es.json` 对应插入：`indicators` 里 `"unemployment": "Desempleo",` 后插入 `"sahm": "Regla de Sahm",`；`unit` 里插入 `"sahm": "%"`；`admin` 末尾插入 `, "clearLock": "Borrar Bloqueo", "clearSahmLock": "Borrar Bloqueo Sahm", "clearReactiveLock": "Borrar Bloqueo de Ajuste Reactivo", "lockOverrideNote": "Válvula de emergencia: borrar manualmente si una anomalía de datos causó un disparo falso"`；文件末尾新增：

```json
  "recessionLock": { "banner": "Bloqueo de Defensa Activo", "sahmReason": "Regla de Sahm {value} (umbral ≥0.5)", "reactiveReason": "Ajuste de tasa reactivo {bp}bp", "waitCondition": "Esperando que la tasa llegue a 0-0.25% o un ajuste menor para desbloquear", "overridden": "Borrado manualmente por el administrador" },
```

`ja.json` 对应插入：`indicators` 里 `"unemployment": "失業率",` 後插入 `"sahm": "サム・ルール",`；`unit` 里插入 `"sahm": "%"`；`admin` 末尾插入 `, "clearLock": "ロック解除", "clearSahmLock": "サムロック解除", "clearReactiveLock": "対応的調整ロック解除", "lockOverrideNote": "緊急バルブ：データ異常による誤トリガーの場合は手動で解除"`；文件末尾新增：

```json
  "recessionLock": { "banner": "防御ロック中", "sahmReason": "サム・ルール {value}（閾値 ≥0.5）", "reactiveReason": "対応的利率調整 {bp}bp", "waitCondition": "利率が0-0.25%に達するか、小幅調整でロック解除を待機中", "overridden": "管理者により手動解除済み" },
```

`ko.json` 对应插入：`indicators` 里 `"unemployment": "실업률",` 뒤에 `"sahm": "삼 법칙",`；`unit` 里插入 `"sahm": "%"`；`admin` 末尾插入 `, "clearLock": "잠금 해제", "clearSahmLock": "삼 법칙 잠금 해제", "clearReactiveLock": "대응적 조정 잠금 해제", "lockOverrideNote": "긴급 밸브: 데이터 이상으로 오작동 시 수동 해제"`；文件末尾新增：

```json
  "recessionLock": { "banner": "방어 잠금 활성화", "sahmReason": "삼 법칙 {value}（기준 ≥0.5）", "reactiveReason": "대응적 금리 조정 {bp}bp", "waitCondition": "금리가 0-0.25%에 도달하거나 소폭 조정으로 잠금이 해제될 때까지 대기 중", "overridden": "관리자에 의해 수동으로 해제됨" },
```

- [ ] **Step 6: 运行全部 JSON 校验**

```bash
cd D:/sheldonproject/StockSentinel/frontend
for f in src/i18n/locales/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f', 'utf-8')); console.log('$f OK')"; done
```
Expected: 7 个文件全部输出 `OK`，没有任何 SyntaxError

- [ ] **Step 7: 提交**

```bash
git add frontend/src/i18n/locales/
git commit -m "i18n: 新增萨姆规则/衰退防守锁定/管理员清锁 七语言文案"
```

---

### Task 12: `MacroPanel.vue` 展示萨姆规则数值

**Files:**
- Modify: `frontend/src/components/MacroPanel.vue:102-140`

- [ ] **Step 1: 在 monetary 分组新增萨姆规则行**

打开 `frontend/src/components/MacroPanel.vue`，在 `groups` computed（第 84-168 行）的 `monetary` 分组里，第 130-134 行（`trimmedPce12m` 那一项）之后，`unemployment` 那一项（第 135-139 行）之前，新增：

```js
        {
          key: 'sahm', value: ind.sahmValue, unit: '%',
          change: null,
          signalBadge: ind.sahmLockActive ? 'tight' : null,
          periodDate: ind.sahmPeriodDate, releaseDate: ind.sahmReleaseDate, periodIsMonth: true,
        },
```

- [ ] **Step 2: 手动浏览器验证**

启动前端开发服务器：

```bash
cd D:/sheldonproject/StockSentinel/frontend
npm run dev
```

打开浏览器访问 `http://localhost:5173`，登录后查看左栏宏观信号面板的"货币政策"分组，确认新增了"萨姆规则"这一行（数值可能显示为 `—`，因为后端可能还没有真实萨姆规则数据，这是正常的——只要这一行渲染出来、不报错即可）。确认无误后按 Ctrl+C 停止开发服务器。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/components/MacroPanel.vue
git commit -m "feat: MacroPanel新增萨姆规则数值展示"
```

---

### Task 13: `SignalHero.vue` 新增防守锁定横幅

**Files:**
- Modify: `frontend/src/components/SignalHero.vue`

- [ ] **Step 1: 新增横幅模板**

打开 `frontend/src/components/SignalHero.vue`，在第 22-25 行的泡沫预警横幅之后新增：

```html
      <!-- 衰退防守锁定横幅 -->
      <div v-if="lockInfo" class="lock-banner">
        ⚠️ {{ $t('recessionLock.banner') }}：{{ lockInfo.reasonText }}
        <template v-if="lockInfo.overridden"> · {{ $t('recessionLock.overridden') }}</template>
        <div class="lock-wait">{{ $t('recessionLock.waitCondition') }}</div>
      </div>
```

- [ ] **Step 2: 新增 `lockInfo` computed**

在 `<script setup>` 块里，`dimDetail` 函数（第 105-117 行）之后新增：

```js
const lockInfo = computed(() => {
  const ind = props.signal?.indicators;
  if (!ind) return null;
  if (ind.sahmLockActive) {
    return {
      overridden: !!ind.sahmLockOverridden,
      reasonText: t('recessionLock.sahmReason', { value: ind.sahmValue != null ? ind.sahmValue.toFixed(2) : '—' }),
    };
  }
  if (ind.reactiveAdjustmentLockActive) {
    return {
      overridden: !!ind.reactiveAdjustmentLockOverridden,
      reasonText: t('recessionLock.reactiveReason', { bp: ind.reactiveAdjustmentLockTriggerBp ?? '—' }),
    };
  }
  return null;
});
```

- [ ] **Step 3: 新增样式**

在 `<style scoped>` 块里，`.bubble-banner`（第 176-184 行）之后新增：

```css
.lock-banner {
  text-align: center;
  font-size: var(--fs-md);
  color: var(--red);
  background: var(--red-bg);
  border: 1px solid var(--red-border);
  border-radius: 8px;
  padding: 8px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.lock-wait { font-size: var(--fs-xs); color: var(--text-4); }
```

- [ ] **Step 4: 手动浏览器验证**

```bash
cd D:/sheldonproject/StockSentinel/frontend
npm run dev
```

浏览器访问确认页面正常渲染、无 JS 报错（`lockInfo` 在没有锁定数据时应为 `null`，横幅不显示，这是当前预期状态，因为后端还没有真实锁定触发）。确认无误后按 Ctrl+C 停止。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components/SignalHero.vue
git commit -m "feat: SignalHero新增衰退防守锁定横幅"
```

---

### Task 14: `AdminPanel.vue` 新增清锁操作入口

**Files:**
- Modify: `frontend/src/components/AdminPanel.vue`

- [ ] **Step 1: 新增清锁表单模板**

打开 `frontend/src/components/AdminPanel.vue`，在"设定信号位"section（第 5-36 行）之后新增一个新 section：

```html
    <!-- 衰退防守锁定应急清除 -->
    <section class="section">
      <h3>{{ $t('recessionLock.banner') }}</h3>
      <p class="lock-note">{{ $t('admin.lockOverrideNote') }}</p>
      <form @submit.prevent="clearLock" class="signal-form">
        <div class="form-row">
          <label>{{ $t('admin.type') }}</label>
          <select v-model="lockForm.type" class="input">
            <option value="sahmLock">{{ $t('admin.clearSahmLock') }}</option>
            <option value="reactiveAdjustmentLock">{{ $t('admin.clearReactiveLock') }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>{{ $t('admin.expiresAt') }}</label>
          <input type="datetime-local" v-model="lockForm.expiresAt" class="input" />
        </div>
        <div class="form-row">
          <label>{{ $t('admin.note') }}</label>
          <input v-model="lockForm.note" class="input" type="text" />
        </div>
        <button type="submit" class="save-btn" :disabled="lockSaving">{{ $t('admin.clearLock') }}</button>
        <span v-if="lockMsg" class="save-msg">{{ lockMsg }}</span>
      </form>
    </section>
```

- [ ] **Step 2: 新增表单状态与提交逻辑**

在 `<script setup>` 块里，`saveMsg`（第 139 行）之后新增：

```js
const lockForm = ref({ type: 'sahmLock', expiresAt: '', note: '' });
const lockSaving = ref(false);
const lockMsg = ref('');
```

在 `saveSignal` 函数（第 153-165 行）之后新增：

```js
async function clearLock() {
  lockSaving.value = true;
  lockMsg.value = '';
  try {
    await api.setLockOverride(lockForm.value.type, lockForm.value.expiresAt || null, lockForm.value.note || null);
    lockMsg.value = '✓ 已清除';
  } catch (e) {
    lockMsg.value = '✗ ' + e.message;
  } finally {
    lockSaving.value = false;
  }
}
```

- [ ] **Step 3: 新增样式**

在 `<style scoped>` 块里，`.signal-form`（第 220 行）之前新增：

```css
.lock-note { font-size: var(--fs-sm); color: var(--text-4); margin: 0 0 10px 0; }
```

- [ ] **Step 4: 手动浏览器验证**

```bash
cd D:/sheldonproject/StockSentinel/frontend
npm run dev
```

用管理员账号登录，进入后台管理页，确认新增的"防守锁定中"清锁表单正常渲染，选择类型后点击"清除锁定"按钮能正常发起请求（后端 `POST /api/admin/lock-override` 应返回 `{ ok: true, ... }`，界面显示"✓ 已清除"）。确认无误后按 Ctrl+C 停止。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components/AdminPanel.vue
git commit -m "feat: AdminPanel新增萨姆锁/应对式调整锁应急清除入口"
```

---

### Task 15: 全量测试 + 最终验证

**Files:**
- 无新文件改动，仅验证

- [ ] **Step 1: 运行后端全量测试**

```bash
cd D:/sheldonproject/StockSentinel/backend
npx vitest run
```
Expected: PASS（全部测试套件，包括本次新增和修改的所有用例）

- [ ] **Step 2: 检查前端能否正常构建**

```bash
cd D:/sheldonproject/StockSentinel/frontend
npm run build
```
Expected: 构建成功，无编译错误（Vite 会做基本的语法/引用检查，能捕获模板里引用了不存在变量等问题）

- [ ] **Step 3: 端到端手动验证（本地开发环境，需要有效 `FRED_API_KEY`）**

```bash
cd D:/sheldonproject/StockSentinel/backend
node server.js
```

等待 cron 首次运行完成（观察日志里的 `[cron] Signal updated: ...`），然后另开一个终端：

```bash
curl http://localhost:3001/api/signal | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).indicators.sahmValue, JSON.parse(d).indicators.sahmLockActive, JSON.parse(d).indicators.reactiveAdjustmentLockActive))"
```

Expected: 输出萨姆规则数值（非 `undefined`）和两个锁的布尔值（`false`，因为正常市场环境下不应触发）。确认无误后 Ctrl+C 停止 `server.js`。

- [ ] **Step 4: 清理测试产生的临时数据库文件（如果本地验证过程中生成了新的 `.db` 文件且不希望保留）**

```bash
cd D:/sheldonproject/StockSentinel
git status backend/data/
```

如果 `git status` 显示 `backend/data/stock-sentinel.db` 有变化且该文件本来就不在版本控制范围内（检查 `.gitignore`），不需要额外处理。如果意外被 git 追踪，不要提交它。

- [ ] **Step 5: 最终提交（如有遗留的文档更新）**

若前面各任务的提交已覆盖所有改动，此步骤跳过。若有遗漏的小改动，统一提交：

```bash
cd D:/sheldonproject/StockSentinel
git status
git add -A
git status
```

确认 `git status` 输出干净或只包含预期变更后再提交。

---

## Spec Coverage Checklist（自查）

- [x] 第2节 利率对称化 → Task 2
- [x] 第3节 萨姆规则数据接入 → Task 3
- [x] 第4节 锁定状态机（含4.1解锁规则、4.2判定函数、4.3原因持久化） → Task 4, 6, 8
- [x] 第5节 最终信号叠加 → Task 8
- [x] 第6节 数据库改动 → Task 6
- [x] 第7节 管理员应急清锁 → Task 6 (getAllOverrides), 7 (API), 14 (UI)
- [x] 第8节 API响应扩展 → Task 8
- [x] 第9节 示警邮件 → Task 5 (detectSignalChanges), 9 (mailer文案)
- [x] 第10节 前端展示 → Task 11 (i18n), 12 (MacroPanel), 13 (SignalHero), 14 (AdminPanel清锁)
- [x] 第11节 测试计划 → 贯穿 Task 2/3/4/5/9，Task 15 做全量验证
