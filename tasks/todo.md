# /mcp 远程端点（Streamable HTTP）— 2026-07-15

背景：Smithery URL 模式扫描要求远程 MCP 端点；现有 MCP 只有 stdio npm 包。
用户已拍板方案①：后端加 /mcp，同时解锁 claude.ai 等"填 URL 即连"客户端。

- [ ] backend 安装 @modelcontextprotocol/sdk + zod
- [ ] backend/api/mcp.js：无状态 StreamableHTTP，6 工具复用内部函数（payloads/storage/fetch-stocks），
      工具描述与 mcp/index.js 保持一致；仅 tools/call 走 /v1 同款限流（initialize/tools/list 免费供扫描）
- [ ] public.js 导出 rateLimit 供复用
- [ ] server.js 挂载 /mcp
- [ ] tests/mcp.test.js：initialize + tools/list 冒烟
- [ ] 本地 npm test 全绿
- [ ] push → Railway 部署 → curl 生产 /mcp 验证
- [ ] Smithery 重新发布 URL=https://stocksentinel-production-55ed.up.railway.app/mcp → 扫描通过 → 能力列表出现
- [ ] 更新 memory + 本文件复盘

## 复盘
（完成后填写）
