#!/usr/bin/env node
// Stock Sentinel MCP Server — 让任何 MCP 客户端（Claude Desktop/Cursor/ChatGPT等）
// 直接调用美股进攻/防守信号系统。薄壳设计：全部数据来自托管的开放API（/v1/*），
// 判定引擎单一来源，不在客户端侧复制任何逻辑。
//
// 环境变量：
//   STOCKSENTINEL_API_URL  后端地址（默认 http://localhost:3001）
//   STOCKSENTINEL_API_KEY  可选，提升每日请求额度
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = (process.env.STOCKSENTINEL_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const API_KEY = process.env.STOCKSENTINEL_API_KEY || '';

async function callApi(path) {
  const res = await fetch(`${API_URL}/v1${path}`, {
    headers: API_KEY ? { 'X-API-Key': API_KEY } : {},
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
  }
  return body;
}

const asText = body => ({ content: [{ type: 'text', text: body }] });

const server = new McpServer({
  name: 'stock-sentinel',
  version: '1.0.0',
});

server.tool(
  'get_current_signal',
  '获取美股当前进攻/防守信号。返回四档最终信号（attack进攻/neutral观望/reduce减仓观望/defense全面防守）、四个维度（AI供需/货币/财政/行政）各自的宽松/中性/收紧状态、以及全部参考指标（联邦基金利率、萨姆规则、联邦支出、WTI油价、EPU不确定性指数、AI模型调用量等）。判定规则：进攻=四维全宽松且无锁；仅单维收紧=减仓观望；双维以上收紧或衰退锁激活=全面防守。仅供研究参考，不构成投资建议。',
  {},
  async () => asText(await callApi('/signal'))
);

server.tool(
  'get_signal_history',
  '获取信号历史存档（公开可验证的 track record）：每日的最终档位与四维状态，按日期倒序。可用于回看信号在近期市场事件中的表现。',
  { limit: z.number().int().min(1).max(365).optional().describe('返回天数，默认90，最大365') },
  async ({ limit }) => asText(await callApi(`/signal/history?limit=${limit || 90}`))
);

server.tool(
  'get_ai_chain',
  '获取AI产业链资金流向状态：六个环节（AI大模型→云厂商→AI芯片→存储/光模块→设备封装→电力）按30天相对SPY强弱的排名、当前市场隐含的卡点环节、以及泡沫监测三指标（模型调用量趋势/云厂商资本开支/半导体产出同比，按现金流向排序）。',
  {},
  async () => asText(await callApi('/ai-chain'))
);

server.tool(
  'get_stock_percentile',
  '查询个股或ETF：当前价格在历史区间中的百分位（≥80%高位/≤20%低位）、真实市盈率P/E与市销率P/S（SEC EDGAR财报口径）。支持指数别名：US10Y(10年美债收益率)、VIX、SPX、NDX。',
  {
    symbol: z.string().max(12).describe('股票代码，如 NVDA、AAPL、QQQ、US10Y'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('区间起点 YYYY-MM-DD，默认3年前'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('区间终点 YYYY-MM-DD，默认今天'),
  },
  async ({ symbol, startDate, endDate }) => {
    const qs = new URLSearchParams();
    if (startDate) qs.set('startDate', startDate);
    if (endDate) qs.set('endDate', endDate);
    return asText(await callApi(`/stock/${encodeURIComponent(symbol)}?${qs}`));
  }
);

server.tool(
  'get_backtest_summary',
  '获取信号系统的历史回测核心结论：26年月度重放，覆盖6场危机（2000互联网泡沫/2008金融危机/2020新冠/2022加息熊/2025关税战/2026美伊战争）的捕获情况与8段大规模上涨期的捕获率，以及"仅全面防守离场"策略与买入持有的全期对比（年化/最大回撤）。',
  {},
  async () => asText(await callApi('/backtest/summary'))
);

server.tool(
  'get_daily_report',
  '获取AI生成的每日信号解读（中英双语）：今日档位、由哪些维度和数据驱动、距离进攻/防守的条件差距。',
  {},
  async () => asText(await callApi('/daily-report'))
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[stock-sentinel-mcp] connected, API: ${API_URL}`);
