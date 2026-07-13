# Stock Sentinel MCP Server

让 Claude Desktop / Cursor / 任何 MCP 客户端直接调用**股哨兵**——美股进攻/防守四维信号系统。

> 仅供研究参考，不构成投资建议。For research reference only, not investment advice.

## 提供的工具

| 工具 | 说明 |
|---|---|
| `get_current_signal` | 当前四档信号（进攻/观望/减仓观望/全面防守）+ 四维状态 + 全部参考指标 |
| `get_signal_history` | 信号历史存档（公开 track record，最多365天） |
| `get_ai_chain` | AI产业链六环节资金流向排名 + 卡点 + 泡沫监测 |
| `get_stock_percentile` | 个股/ETF 价格百分位 + 真实 P/E、P/S（SEC EDGAR 口径） |
| `get_backtest_summary` | 26年回测结论（6场危机捕获 + 8段牛市捕获率 + 策略vs买入持有） |
| `get_daily_report` | AI 生成的每日中英双语信号解读 |

## 快速接入（Claude Desktop）

在 `claude_desktop_config.json` 中加入：

```json
{
  "mcpServers": {
    "stock-sentinel": {
      "command": "npx",
      "args": ["-y", "stock-sentinel-mcp"],
      "env": {
        "STOCKSENTINEL_API_URL": "https://你的后端域名",
        "STOCKSENTINEL_API_KEY": "sk_ss_xxx（可选，提升额度）"
      }
    }
  }
}
```

重启 Claude Desktop 后直接提问：*"现在美股该进攻还是防守？为什么？"*

## 额度

- 无 key：每日 25 次/IP（试用）
- free key：每日 250 次
- pro key：每日 10000 次

## 本地开发

```bash
STOCKSENTINEL_API_URL=http://localhost:3001 node index.js
```

判定引擎与完整文档见主仓库根目录。
