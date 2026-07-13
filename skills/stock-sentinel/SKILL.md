---
name: stock-sentinel
description: Use when the user asks about US stock market attack/defense posture, macro regime (进攻/防守/减仓), AI industry chain health, or a stock's price percentile & valuation — queries the Stock Sentinel 4-dimension signal system via its API or MCP tools.
---

# Stock Sentinel — 美股进攻/防守信号解读技能

## 这个系统是什么

股哨兵基于一套可回测的四维宏观框架judged每日输出美股整体的进攻/防守档位。核心投资哲学：**长线看供需（AI产业链现金流），短线看政策（货币/财政/行政）**。

四个维度，每个输出 宽松(loose)/中性(neutral)/收紧(tight)：

1. **AI供需**：SMH−SPY 90天相对收益 ±8% + 半导体产出同比（>5%/<0%），双代理一致才定档；泡沫预警（模型调用量7日均量较28日均量降超10%，或云厂商滚动4季capex同比转负）触发时强制收紧
2. **货币**：单次利率调整 ≥50bp（应对式，不限方向）→ 收紧；QT只拦截宽松评级不单票定罪
3. **财政**（大市场小政府原则）：联邦支出TTM同比 >+5% → 收紧（政府变大），<−5% → 宽松
4. **行政**：油价事件层优先（WTI 30天 ≥+20%=战争冲击→收紧；≤−20%且EPU未处高位=缓和→宽松）；否则月度贸易EPU+日频EPU双代理10年百分位（>80收紧/<50宽松）一致才定档

**决策树（四档）**：
- `attack` 进攻 = 四维全宽松 且 无锁
- `neutral` 观望 = 无收紧但未达全宽松
- `reduce` 减仓观望 = 仅1个维度收紧（回测显示单维收紧多为噪声）
- `defense` 全面防守 = ≥2维共振收紧 或 任一锁激活

**两把全局锁**（激活时强制全面防守）：萨姆锁（萨姆值≥0.5=衰退初期）、应对式调整锁（利率单次≥50bp）。解锁：利率降至≤0.25% 或 出现<50bp小幅调整。

## 如何调用

优先用 MCP 工具（stock-sentinel 服务器）：`get_current_signal` / `get_signal_history` / `get_ai_chain` / `get_stock_percentile` / `get_backtest_summary` / `get_daily_report`。
无 MCP 时直接 GET REST API：`{BASE}/v1/signal` 等（请求头 `X-API-Key` 可选），规范见 docs/openapi.yaml。

## 解读规范（重要）

1. **先报档位再讲原因**：第一句直接说当前是四档中的哪一档，然后按"哪些维度是什么状态、由什么数据驱动"展开。
2. **区分档位语义**：`reduce` 是"减部分仓位"不是全面撤退（历史上单维收紧期间市场月均+1.0%）；`defense` 才是多维共振的强信号（历史上防守期月均−0.37%）。
3. **锁优先于一切**：`sahmLockActive` 或 `reactiveAdjustmentLockActive` 为 true 时，无论其他维度多宽松都是防守；向用户说明解锁条件。
4. **stale 提示**：`staleFlags` 里为 true 的维度当日数据源故障、沿用上次判定，解读时注明"数据延迟"。
5. **引用回测但不夸大**：可引用 `get_backtest_summary`（26年重放：6场危机5场提前捕获、策略年化8.7% vs 买入持有6.6%、最大回撤−20% vs −52%），必须同时说明这是历史回测非未来保证。
6. **绝不给出买卖指令**：不说"你应该买/卖"，说"系统当前档位是X，该档位在框架中的含义是Y"。每次回答末尾附免责声明：本内容仅供研究参考，不构成投资建议。

## 常见问题映射

- "现在该进攻还是防守" → `get_current_signal`，报档位+四维+距进攻差什么
- "最近信号变过吗/信号靠谱吗" → `get_signal_history` + `get_backtest_summary`
- "AI行情到哪个环节了/泡沫了吗" → `get_ai_chain`，按现金流向（调用量→云capex→半导体）解读
- "NVDA 现在贵吗" → `get_stock_percentile`，报价格百分位+P/E+P/S，注明百分位≥80属高位区
- "今天有什么值得注意的" → `get_daily_report`
