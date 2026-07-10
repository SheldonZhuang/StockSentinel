# 萨姆规则衰退信号 + 纾困式降息锁定 设计文档

日期：2026-07-10

## 1. 背景

现有货币信号位（`backend/api/signal.js` `deriveSubSignals`）对利率方向的判断存在两个问题：

1. 降息不论幅度大小都判定为 `loose`，未区分"预防式降息"（正常周期性小幅降息，进攻信号）与"纾困式/应对式降息"（经济衰退期大幅降息，防守信号）。
2. 加息侧已有"应对式加息 ≥50bp → tight"的判断，但小幅加息（1-49bp，即"加息减缓"）目前判为 `neutral`，未纳入进攻信号。
3. 缺少失业率驱动的独立衰退预警指标——萨姆规则（Sahm Rule）。萨姆规则触发是比"某天降息幅度"更早、更可靠的衰退信号，且衰退一旦确认，防守应持续到利率降到零利率区间（0-0.25%）为止，而不是每天独立判断。

本设计新增：萨姆规则数据接入 + 两个独立的"衰退防守锁定"持久状态机 + 利率方向判断对称化。

## 2. 利率方向判断对称化

`deriveSubSignals` 的 `rateSignal` 改为按调整幅度的绝对值统一判断，不再区分方向：

```
rateDiffBp = round((currentRate - prevRate) * 100)   // 正=加息，负=降息

数据缺失         → neutral
|rateDiffBp| >= RATE_REACTIVE_HIKE_BP (50)  → tight   // 应对式加息 或 纾困式降息
|rateDiffBp| < 50                           → loose   // 暂停、小幅加息(加息减缓)、预防式降息
```

边界：单次调整幅度恰好 50bp 记为 `tight`（沿用现有 `>=50bp` 加息判定的边界写法，降息侧对称）。

**行为变化**：原先"预防式加息<50bp + 资产负债表暂停"判为 `neutral` 的分支，现在会判为 `loose`（因为小幅加息现在归入 `loose`）。这是本次需求的直接结果，`backend/tests/signal.test.js` 中对应的既有测试需要同步更新为新预期值。

`calcMonetarySignal` 的宽松/收紧 AND/OR 合成逻辑不变，只是 `rateSignal` 的取值来源变了。

不新增配置项——降息侧复用现有 `RATE_REACTIVE_HIKE_BP` 常量做绝对值比较，不再引入单独的降息阈值，避免同一概念用两个配置维护。

## 3. 萨姆规则数据接入

- `signal.config.js` 新增：
  - `FRED_SERIES.SAHM: 'SAHMREALTIME'`（圣路易斯联储官方实时萨姆规则序列，直接取值，不自行用 UNRATE 计算）
  - `SAHM_TRIGGER_THRESHOLD: 0.5`（触发衰退预警阈值，`>=` 即触发）
- `fetch-macro.js` 按现有 `UNRATE` 的抓取模式（`fetchSeries` + `latestValue`/`prevValue`/`latestDate` + `fetchReleaseDate`）新增拉取 `SAHMREALTIME`，返回 `sahmValue`、`sahmPeriodDate`、`sahmReleaseDate`。萨姆规则为月度数据，回看窗口沿用失业率的 400 天。

## 4. 两个独立的"衰退防守锁定"状态机

两个触发条件分开处理，各自维护独立的持久锁定状态，都以"利率降至 0-0.25%"为共同解锁条件：

- **萨姆锁**（`sahmLockActive`）：触发条件 = 萨姆规则值 `>= SAHM_TRIGGER_THRESHOLD`
- **纾困降息锁**（`bailoutCutLockActive`）：触发条件 = 单次降息幅度 `>= RATE_REACTIVE_HIKE_BP`（即 `rateDiffBp <= -50`，注意方向必须是降息，单次大幅加息不触发此锁）

新增配置 `ZERO_RATE_FLOOR_PCT: 0.25`（联邦基金利率目标上限低于等于此值，视为"降到底"）。

每日 cron 滚动推导（`todayLock` 基于"昨天快照里的锁状态"和"今天的触发/解锁条件"）：

```
若 currentRate <= ZERO_RATE_FLOOR_PCT:
    todayLock = false                          // 解锁优先于触发
否则:
    todayLock = yesterdayLock || triggerToday   // 一旦锁定，持续到解锁条件满足
```

两个锁各自独立跑一遍上述逻辑，互不影响。首次运行（无历史快照）时 `yesterdayLock` 视为 `false`。

新增 `signal.js` 导出函数：

```js
export function calcRecessionLock({ triggerToday, currentRate, prevLockActive }) {
  if (currentRate !== null && currentRate <= ZERO_RATE_FLOOR_PCT) return false;
  return !!prevLockActive || !!triggerToday;
}
```

`sahmLock` 的 `triggerToday` = `sahmValue >= SAHM_TRIGGER_THRESHOLD`；`bailoutCutLock` 的 `triggerToday` = `rateDiffBp <= -RATE_REACTIVE_HIKE_BP`。`currentRate` 缺失时解锁判断跳过（沿用 `prevLockActive || triggerToday`，不视为满足解锁）。

## 5. 最终信号合成叠加

现有四维决策树 `calcFinalSignal(aiSupply, monetary, fiscal, admin)` 保持不变。在 `server.js` 的 `runDailyUpdate` 和 `GET /api/signal` 中，决策树算出结果后再叠加一层强制覆盖：

```
finalSignal = calcFinalSignal(...)
if (sahmLockActive || bailoutCutLockActive) finalSignal = 'defense'
```

这是信号级别的 override（类似现有 AI 泡沫预警对 `aiSupply` 维度的强制收紧，但本次是在决策树之上、最终信号这一层生效，不改变四个维度各自展示的独立数值）。

## 6. 数据库改动

`signal_snapshots` 表新增列（`storage.js` 的 `SIGNAL_SNAPSHOT_NEW_COLUMNS` 迁移列表 + `initSchema` 建表语句 + `saveSignalSnapshot` 读写）：

```
sahm_value REAL
sahm_period_date TEXT
sahm_release_date TEXT
sahm_lock_active INTEGER
bailout_cut_lock_active INTEGER
bailout_cut_bp REAL          -- 触发纾困锁那天的降息幅度，非触发日为 null，供前端/邮件展示
```

锁状态是路径依赖的（依赖前一天的值），只能在 cron 里结合 `getLatestSnapshot()`（已有的 `prevSnapshot`）计算后存入新快照行，`GET /api/signal` 直接读快照里存的值，不做实时重算（与 `fiscal_auto_signal` 等自动判定字段的读取模式一致，但锁没有手动 override 概念）。

## 7. API 响应扩展

`GET /api/signal` 的 `indicators` 新增：

```
sahmValue, sahmPeriodDate, sahmReleaseDate,
sahmLockActive, bailoutCutLockActive, bailoutCutBp
```

顶层 `finalSignal` 按第5节规则叠加锁定覆盖后返回。

## 8. 示警邮件

`detectSignalChanges`（`signal.js`）新增两种变化类型，规则与现有"任一维度转 tight"一致（从 false→true 才示警，锁定期间不重复提醒）：

```
{ kind: 'sahmLock' }         // sahmLockActive: false → true
{ kind: 'bailoutCutLock', bp }  // bailoutCutLockActive: false → true，附带触发当日的降息幅度
```

`mailer.js` 的 `buildAlertEmail` 补充这两种 `kind` 的文案行（中英双语，与现有 `dimTight`/`bubble` 同结构）。

## 9. 前端展示

- `MacroPanel.vue` 的 `monetary` 分组新增一行：萨姆规则数值（带 `>=0.5` 阈值参考），复用现有 `signalBadge` 展示机制（锁定时显示红色徽章）。
- `SignalHero.vue` 新增一个横幅，与现有 AI 泡沫预警横幅（`bubble-banner`）同构：当 `sahmLockActive || bailoutCutLockActive` 为真时，显示"⚠️ 衰退防守锁定中，等待降息至 0-0.25% 解锁"，区分具体是哪个锁触发（萨姆规则 / 纾困式降息）。
- `i18n`：在 `zh/en/fr/de/es/ja/ko` 七个语言包的 `indicators` 和新横幅文案键位补充对应翻译（沿用现有 `indicators.unemployment` 等键位的组织方式）。

## 10. 测试计划

`backend/tests/signal.test.js` 新增：

- `deriveSubSignals` 对称阈值：|diff|>=50bp 加息/降息都 tight；<50bp 加息/降息/暂停都 loose；更新原有"预防式加息<50bp→neutral"用例为新预期值 `loose`
- `calcRecessionLock`：触发进入锁定、锁定期间维持（即使触发条件当天不满足）、利率降到 0.25% 以下解锁、数据缺失时的降级行为
- 决策树叠加锁定覆盖：锁定为真时 `finalSignal` 强制 `defense`，即使四维全宽松
- `detectSignalChanges` 新增两种 kind 的 false→true 触发、true→true 不重复触发

不新增端到端/前端测试（现有项目前端无自动化测试，遵循现状）。
