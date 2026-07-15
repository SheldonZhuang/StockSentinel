// /mcp 远程端点冒烟：initialize 握手 + tools/list 能力发现
// 不测 tools/call（依赖 DB/外部数据源）；限流分支由 public-api 既有测试覆盖
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import mcpRouter from '../api/mcp.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/mcp', mcpRouter);
  return app;
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

describe('POST /mcp (Streamable HTTP, stateless)', () => {
  it('initialize 返回服务器信息', async () => {
    const res = await request(makeApp())
      .post('/mcp')
      .set(MCP_HEADERS)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '0.0.0' },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo.name).toBe('stock-sentinel');
  });

  it('tools/list 返回全部6个工具', async () => {
    const res = await request(makeApp())
      .post('/mcp')
      .set(MCP_HEADERS)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    const names = res.body.result.tools.map(t => t.name).sort();
    expect(names).toEqual([
      'get_ai_chain',
      'get_backtest_summary',
      'get_current_signal',
      'get_daily_report',
      'get_signal_history',
      'get_stock_percentile',
    ]);
  });

  it('GET 返回 405（无状态模式仅支持 POST）', async () => {
    const res = await request(makeApp()).get('/mcp');
    expect(res.status).toBe(405);
  });
});
