# 萨姆规则衰退信号 + 应对式利率调整锁定 设计文档

日期：2026-07-10

## 1. 背景

现有货币信号位（`backend/api/signal.js` `deriveSubSignals`）对利率方向的判断存在两个问题：

1. 降息不论幅度大小都判定为 `loose`，未区分"预防式降息"（正常周期性小幅降息，进攻信号）与"应对式降息"（经济衰退期大幅降息，防守信号）。
2. 加息侧已有"应对式加息 ≥50bp → tight"的判断，但小幅加息（1-49bp，即"加息减缓"）目前判为 `neutral`，未纳入进攻信号。
3. 缺少失业率驱动的独立衰退预警指标——萨姆规则（Sahm Rule）。萨姆规则触发是比"某天利率调整幅度"更早、更可靠的衰退信号，且衰退一旦确认，防守应持续到利率回落或调整幅度收窄为止，而不是每天独立判断。

本设计新增：萨姆规则数据接入 + 两个独立的"防守锁定"持久状态机（萨姆锁、应对式调整锁）+ 利率方向判断对称化 + 管理员应急清锁入口。

## 2. 利率方向判断对称化

配置常量 `RATE_REACTIVE_HIKE_BP` 重命名为 `RATE_REACTIVE_ADJUSTMENT_BP`（值不变，仍为 50），因为它现在同时衡量加息和降息两个方向。

`deriveSubSignals` 的 `rateSignal` 改为按调整幅度的绝对值统一判断，不再区分方向：

```
rateDiffBp = round((currentRate - prevRate) * 100)   // 正=加息，负=降息

数据缺失                                    → neutral
|rateDiffBp| >= RATE_REACTIVE_ADJUSTMENT_BP (50)  → tight   // 应对式加息 或 应对式降息
|rateDiffBp| < 50                                 → loose   // 暂停、预防式加息/降息（幅度<0.5%，含加息减缓）
```

边界：单次调整幅度恰好 50bp 记为 `tight`。

**行为变化**：原先"预防式加息<50bp + 资产负债表暂停"判为 `neutral` 的分支，现在会判为 `loose`。`backend/tests/signal.test.js` 中对应的既有测试需要同步更新为新预期值。

`calcMonetarySignal` 的宽松/收紧 AND/OR 合成逻辑不变，只是 `rateSignal` 的取值来源变了。

## 3. 萨姆规则数据接入

- `signal.config.js` 新增：
  - `FRED_SERIES.SAHM: 'SAHMREALTIME'`（圣路易斯联储官方实时萨姆规则序列，直接取值，不自行用 UNRATE 计算）
  - `SAHM_TRIGGER_THRESHOLD: 0.5`（触发衰退预警阈值，`>=` 即触发）
- `fetch-macro.js` 按现有 `UNRATE` 的抓取模式（`fetchSeries` + `latestValue`/`prevValue`/`latestDate` + `fetchReleaseDate`）新增拉取 `SAHMREALTIME`，返回 `sahmValue`、`sahmPeriodDate`、`sahmReleaseDate`。萨姆规则为月度数据，回看窗口沿用失业率的 400 天。

## 4. 两个独立的防守锁定状态机

两个锁触发条件不同，但共用同一套解锁规则，各自独立维护持久状态：

- **萨姆锁**（`sahmLockActive`）：触发条件 = 萨姆规则值 `>= SAHM_TRIGGER_THRESHOLD`
- **应对式调整锁**（`reactiveAdjustmentLockActive`）：触发条件 = 单次利率调整幅度 `|rateDiffBp| >= RATE_REACTIVE_ADJUSTMENT_BP`（**不限方向**，大幅加息或大幅降息都触发；原设计中只覆盖降息方向的"纾困降息锁"并入此锁）

新增配置 `ZERO_RATE_FLOOR_PCT: 0.25`（联邦基金利率目标上限低于等于此值，视为"降到底"）。

### 4.1 解锁规则（两个锁共用）

当天满足以下**任一**条件即解锁，解锁优先于触发（同一天触发条件和解锁条件都满足时，以解锁为准）：

```
零利率解锁：currentRate <= ZERO_RATE_FLOOR_PCT
小幅调整解锁：rateDiffBp !== 0 且 |rateDiffBp| < RATE_REACTIVE_ADJUSTMENT_BP
             （不区分方向，当天实际发生的调整——无论加息还是降息，只要幅度<0.5%且不为0，就解锁）
```

`rateDiffBp === 0`（无议息决议的日子，或议息会议决定暂停/不调整）**不触发解锁**——因为联邦基金利率只有联储真正开会决议调整时才会变动，"无会议日"和"开会但暂停"在数据上都表现为 `diff=0`，两者都不算"发生了一次小幅调整"，天然被 `rateDiffBp !== 0` 这个条件排除，不需要额外核对 FOMC 决议日历。这保证锁定状态不会因为"两次议息会议之间的普通日子"而被误解锁——只有联储下一次真正做出调整决定（无论加息还是降息，只要幅度<0.5%），或利率已经降到零利率区间，才会解锁。

### 4.2 判定函数

```js
export function calcLockActive({ triggerToday, rateDiffBp, currentRate, prevLockActive }) {
  const zeroFloorUnlock = currentRate !== null && currentRate <= ZERO_RATE_FLOOR_PCT;
  const smallAdjustmentUnlock = rateDiffBp !== null && rateDiffBp !== 0
    && Math.abs(rateDiffBp) < RATE_REACTIVE_ADJUSTMENT_BP;
  if (zeroFloorUnlock || smallAdjustmentUnlock) return false;
  return !!prevLockActive || !!triggerToday;
}
```

两个锁调用同一个函数，`triggerToday` 不同：

- `sahmLockActive = calcLockActive({ triggerToday: sahmValue >= SAHM_TRIGGER_THRESHOLD, rateDiffBp, currentRate, prevLockActive: prevSahmLockActive })`
- `reactiveAdjustmentLockActive = calcLockActive({ triggerToday: rateDiffBp !== null && Math.abs(rateDiffBp) >= RATE_REACTIVE_ADJUSTMENT_BP, rateDiffBp, currentRate, prevLockActive: prevReactiveLockActive })`

首次运行（无历史快照）时 `prevLockActive` 视为 `false`。`currentRate`/`rateDiffBp` 数据缺失时对应的解锁条件视为不满足（保守起见，缺数据不解锁）。

**萨姆锁的同日冲突**：萨姆值仍 `>=0.5`（仍触发）但当天利率发生了小幅调整（满足解锁条件）——按"解锁优先"规则，`smallAdjustmentUnlock` 为真直接返回 `false`，萨姆锁在这一天解除，不因萨姆值本身尚未回落而保持锁定。

### 4.3 锁定原因持久化

- **萨姆锁**：原因即"当前萨姆值"，该值每天都存在快照的 `sahm_value` 列里（不依赖锁状态），前端/邮件展示时直接读取即可，不需要额外字段。
- **应对式调整锁**：原因是"哪一天、以多大幅度触发的"，这是一次性事件，不是持续可观测的量，需要专门持久化。新增 `reactive_adjustment_lock_trigger_bp`：
  ```
  若今天触发（|rateDiffBp|>=50）：trigger_bp = 今天的 rateDiffBp
  否则若锁仍处于激活状态（沿用昨天）：trigger_bp = 昨天快照的 trigger_bp（原样carry forward）
  否则（锁未激活）：trigger_bp = null
  ```
  这样锁定期间任意一天查询，都能看到"当初触发时的调整幅度"，直到锁解除后清空，或被更新的一次触发覆盖（锁已激活期间又发生一次新的大幅调整，用最新一次的幅度覆盖）。

## 5. 最终信号合成叠加

现有四维决策树 `calcFinalSignal(aiSupply, monetary, fiscal, admin)` 保持不变。在 `server.js` 的 `runDailyUpdate` 和 `GET /api/signal` 中，决策树算出结果后再叠加一层强制覆盖：

```
finalSignal = calcFinalSignal(...)
if (effectiveSahmLockActive || effectiveReactiveAdjustmentLockActive) finalSignal = 'defense'
```

`effective*LockActive` = 锁的存储值，但若管理员设置了对应类型的应急清锁 override（见第 7 节）且未过期，则强制为 `false`。

锁解除只是移除这层强制覆盖，**不会**让最终信号直接变为进攻——回归四维决策树正常判定（若财政/行政/AI供需中仍有维度收紧，最终信号依然可能是防守或观望）。

## 6. 数据库改动

`signal_snapshots` 表新增列（`storage.js` 的 `SIGNAL_SNAPSHOT_NEW_COLUMNS` 迁移列表 + `initSchema` 建表语句 + `saveSignalSnapshot` 读写）：

```
sahm_value REAL
sahm_period_date TEXT
sahm_release_date TEXT
sahm_lock_active INTEGER
reactive_adjustment_lock_active INTEGER
reactive_adjustment_lock_trigger_bp REAL   -- 锁定期间持续携带触发当时的调整幅度，解锁后清空为 null
```

锁状态是路径依赖的（依赖前一天的值），只能在 cron 里结合 `getLatestSnapshot()`（已有的 `prevSnapshot`）计算后存入新快照行。

## 7. 管理员应急清锁

复用现有 `admin_signal_overrides` 表（`type`/`signal`/`expires_at`/`note`/`set_by`），新增两个 `type` 取值：`sahmLock`、`reactiveAdjustmentLock`，`signal` 固定填 `'cleared'`，`expiresAt` 可选（用于限制清锁的有效期，到期后自动恢复正常判定）。

用途：FRED 数据异常导致误触发时（例如利率数据抓取错误被误判为大幅降息），管理员可在后台手动清除锁定，作为应急阀门，避免锁被卡死到"利率真的降到零利率区间"那一天。

生效方式与现有 fiscal/administrative override 一致——在 `GET /api/signal` 和 cron 两处都检查（`getAllOverrides()` 需要扩展支持这两个新 type）：只要清锁 override 未过期，`effectiveLockActive` 强制为 `false`，且这个 `false` 会随当天快照存入，成为次日 `prevLockActive` 的起点——也就是说清锁只需生效一次，若清锁生效当天触发条件已经不存在了，锁不会再自动恢复；若底层数据问题持续（次日又重新满足触发条件），会重新触发锁定，需要管理员在 override 有效期内继续观察或延长清锁。

后台管理界面（`admin.js` / 前端管理页）参照现有财政/行政信号位设定 UI 新增一组清锁操作入口。

## 8. API 响应扩展

`GET /api/signal` 的 `indicators` 新增：

```
sahmValue, sahmPeriodDate, sahmReleaseDate,
sahmLockActive,                       // 已应用 override 覆盖后的 effective 值
reactiveAdjustmentLockActive,         // 已应用 override 覆盖后的 effective 值
reactiveAdjustmentLockTriggerBp,
sahmLockOverridden, reactiveAdjustmentLockOverridden,  // 是否处于管理员清锁状态，供前端展示"已被管理员清除"标记
```

顶层 `finalSignal` 按第 5 节规则叠加锁定覆盖后返回。

## 9. 示警邮件

`detectSignalChanges`（`signal.js`）新增变化类型，均基于 effective 锁定值的跳变：

```
{ kind: 'sahmLockOn' }                          // sahmLockActive: false → true
{ kind: 'sahmLockOff' }                         // sahmLockActive: true → false（转向进攻的关键时点）
{ kind: 'reactiveAdjustmentLockOn', bp }        // reactiveAdjustmentLockActive: false → true，附带触发当日的调整幅度
{ kind: 'reactiveAdjustmentLockOff' }           // reactiveAdjustmentLockActive: true → false
```

锁定期间维持 `true` 不重复提醒，与现有"任一维度转 tight"逻辑一致。

`mailer.js` 的 `buildAlertEmail` 补充这四种 `kind` 的文案行（中英双语，与现有 `dimTight`/`bubble` 同结构）。

## 10. 前端展示

- `MacroPanel.vue` 的 `monetary` 分组新增一行：萨姆规则数值（带 `>=0.5` 阈值参考），复用现有 `signalBadge` 展示机制（锁定时显示红色徽章）。
- `SignalHero.vue` 新增一个横幅，与现有 AI 泡沫预警横幅（`bubble-banner`）同构：当 `sahmLockActive || reactiveAdjustmentLockActive` 为真时，显示"⚠️ 防守锁定中"+触发原因（萨姆规则数值 或 应对式调整幅度），等待"利率降至 0-0.25% 或转为小幅调整"解锁；若该锁处于管理员清锁状态，额外标注"已被管理员手动清除"。
- `i18n`：在 `zh/en/fr/de/es/ja/ko` 七个语言包的 `indicators` 和新横幅文案键位补充对应翻译（沿用现有 `indicators.unemployment` 等键位的组织方式）。

## 11. 测试计划

`backend/tests/signal.test.js` 新增：

- `deriveSubSignals` 对称阈值：|diff|>=50bp 加息/降息都 tight；<50bp 加息/降息/暂停都 loose；更新原有"预防式加息<50bp→neutral"用例为新预期值 `loose`
- `calcLockActive`：
  - 触发进入锁定（萨姆值超阈值 / 大幅加息 / 大幅降息，三种触发场景）
  - 锁定期间维持（即使触发条件当天不满足，`prevLockActive=true` 时继续锁定）
  - 零利率解锁（`currentRate<=0.25` 时无论其他条件如何都解锁）
  - 小幅调整解锁（非零且<50bp 的调整，无论加息还是降息方向）
  - `rateDiffBp===0`（无决议日/暂停决议）不解锁，锁定持续
  - 解锁优先级：触发条件和解锁条件同天满足时，解锁生效
  - 数据缺失时的降级行为（不解锁、不误触发）
- 决策树叠加锁定覆盖：任一锁激活时 `finalSignal` 强制 `defense`，即使四维全宽松；解锁后回归决策树原判定（不强制进攻）
- `detectSignalChanges` 新增四种 kind 的跳变触发（含 On/Off 两个方向）、维持不变时不重复触发

不新增端到端/前端测试（现有项目前端无自动化测试，遵循现状）。管理员清锁的 override 读取逻辑测试覆盖 `getAllOverrides` 扩展后的两个新 type 分支。
