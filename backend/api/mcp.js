// 远程 MCP 端点 /mcp（Streamable HTTP，无状态模式）：让 claude.ai、Smithery 等
// "填 URL 即连"的客户端直接使用，与 stdio 包（mcp/index.js）互为镜像。
// 工具描述与 mcp/index.js 保持一致；数据不经 HTTP 自调用，直接走内部函数（判定引擎单一来源）。
// 限流：仅 tools/call 计入 /v1 同款额度（initialize/tools/list 是发现流程，供扫描器与客户端握手）。
import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSignalPayload, buildAiChainPayload } from './payloads.js';
import { fetchStockData } from './fetch-stocks.js';
import { getSnapshotHistory, getLatestDailyReport } from '../utils/storage.js';
import { rateLimit } from './public.js';
import { ipRateLimit } from '../utils/ip-rate-limit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DISCLAIMER = 'For research reference only. Not investment advice. 仅供研究参考，不构成投资建议。';
const asText = payload => ({
  content: [{ type: 'text', text: JSON.stringify({ ...payload, disclaimer: DISCLAIMER }) }],
});

function buildServer() {
  const server = new McpServer({ name: 'stock-sentinel', version: '1.0.3' });

  server.tool(
    'get_current_signal',
    '获取美股当前进攻/防守信号。返回四档最终信号（attack进攻/neutral观望/reduce减仓观望/defense全面防守）、四个维度（AI供需/货币/财政/行政）各自的宽松/中性/收紧状态、以及全部参考指标（联邦基金利率、萨姆规则、联邦支出、WTI油价、EPU不确定性指数、收益率曲线、AI模型调用量等）。判定规则：进攻（非对称）=AI供需宽松且货币/财政/行政均不收紧（中性即可）且无锁且收益率曲线未处倒挂确认期（10y−3m连续倒挂≥3个月否决进攻准入）；仅单维收紧=减仓观望（语义：停止加仓提高警觉，非必须减存量仓位）；双维以上收紧或衰退锁激活=全面防守。仅供研究参考，不构成投资建议。',
    {},
    async () => {
      const payload = await buildSignalPayload();
      if (!payload) return asText({ error: 'warming_up', message: 'No snapshot yet, try again later' });
      return asText(payload);
    }
  );

  server.tool(
    'get_signal_history',
    '获取信号历史存档（公开可验证的 track record）：每日的最终档位与四维状态，按日期倒序。可用于回看信号在近期市场事件中的表现。',
    { limit: z.number().int().min(1).max(365).optional().describe('返回天数，默认90，最大365') },
    async ({ limit }) => {
      const rows = await getSnapshotHistory(Math.max(1, Math.min(limit || 90, 365)));
      return asText({
        history: rows.map(r => ({
          date: r.date,
          finalSignal: r.final_signal,
          aiSupply: r.ai_supply_signal,
          monetary: r.monetary_signal,
          fiscal: r.fiscal_signal,
          administrative: r.admin_signal,
        })),
      });
    }
  );

  server.tool(
    'get_ai_chain',
    '获取AI产业链资金流向状态：六个环节（AI大模型→云厂商→AI芯片→存储/光模块→设备封装→电力）按30天相对SPY强弱的排名、当前市场隐含的卡点环节、以及泡沫监测三指标（模型调用量趋势/云厂商资本开支/半导体产出同比，按现金流向排序）。',
    {},
    async () => asText(await buildAiChainPayload())
  );

  server.tool(
    'get_stock_percentile',
    '查询个股或ETF：当前价格在历史区间中的百分位（≥80%高位/≤20%低位）、真实市盈率P/E与市销率P/S（SEC EDGAR财报口径）。支持指数别名：US10Y(10年美债收益率)、VIX、SPX、NDX。',
    {
      // 与 /v1/stock/:symbol（public.js SYMBOL_RE）同一护栏：拦住 `/ ?` 等可改写下游行情源请求路径的字符
      symbol: z.string().regex(/^[A-Z0-9.^=-]{1,12}$/i, 'invalid symbol').describe('股票代码，如 NVDA、AAPL、QQQ、US10Y'),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('区间起点 YYYY-MM-DD，默认3年前'),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('区间终点 YYYY-MM-DD，默认今天'),
    },
    async ({ symbol, startDate, endDate }) => {
      const end = endDate || new Date().toISOString().slice(0, 10);
      const start = startDate || new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);
      return asText(await fetchStockData(symbol.toUpperCase(), start, end));
    }
  );

  server.tool(
    'get_backtest_summary',
    '获取信号系统的历史回测核心结论：26年月度重放，覆盖6场危机（2000互联网泡沫/2008金融危机/2020新冠/2022加息熊/2025关税战/2026美伊战争）的捕获情况与8段大规模上涨期的捕获率，以及"仅全面防守离场"策略与买入持有的全期对比（年化/最大回撤）。',
    {},
    async () => {
      const p = path.join(__dirname, '../backtest/backtest-raw.json');
      if (!fs.existsSync(p)) return asText({ error: 'not_available', message: 'Backtest has not been run on this deployment' });
      const { summary } = JSON.parse(fs.readFileSync(p, 'utf8'));
      return asText({ summary });
    }
  );

  server.tool(
    'get_daily_report',
    '获取AI生成的每日信号解读（中英双语）：今日档位、由哪些维度和数据驱动、距离进攻/防守的条件差距。',
    {},
    async () => {
      const report = await getLatestDailyReport();
      if (!report) return asText({ error: 'not_available', message: 'No daily report generated yet' });
      return asText({ date: report.date, zh: report.content_zh, en: report.content_en, model: report.model });
    }
  );

  return server;
}

const router = express.Router();

router.use(cors({
  origin: '*',
  exposedHeaders: ['mcp-session-id'],
  allowedHeaders: ['Content-Type', 'Accept', 'X-API-Key', 'mcp-session-id', 'mcp-protocol-version'],
}));

// 按 IP 保底限流（发现流程免业务额度，但仍需防匿名高频打满资源；与日额度计费正交）
router.use(ipRateLimit({ max: 60 }));

// JSON-RPC 请求体可能是单对象或批量数组；判断是否含 tools/call 决定是否计入每日额度。
// 修复：旧逻辑只看 req.body.method，数组批量时该字段为 undefined → 绕过限流与计费。
function bodyHasToolCall(body) {
  if (Array.isArray(body)) return body.some(m => m?.method === 'tools/call');
  return body?.method === 'tools/call';
}

router.post('/', (req, res, next) => {
  // 仅工具调用计入每日额度；握手与能力发现免费（Smithery/客户端扫描不吃配额）
  if (bodyHasToolCall(req.body)) return rateLimit(req, res, next).catch(next);
  next();
}, (req, res, next) => {
  (async () => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // 无状态：每请求新实例，无会话粘性，天然适配多实例部署
      enableJsonResponse: true,
    });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  })().catch(next);
});

// 无状态模式不支持 SSE 拉流与会话终止
const methodNotAllowed = (req, res) => res.status(405).json({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed: stateless server, POST only' },
  id: null,
});
router.get('/', methodNotAllowed);
router.delete('/', methodNotAllowed);

export default router;
