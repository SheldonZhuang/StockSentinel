# /mcp 远程端点（Streamable HTTP）— 2026-07-15

背景：Smithery URL 模式扫描要求远程 MCP 端点；现有 MCP 只有 stdio npm 包。
用户已拍板方案①：后端加 /mcp，同时解锁 claude.ai 等"填 URL 即连"客户端。

- [x] backend 安装 @modelcontextprotocol/sdk + zod
- [x] backend/api/mcp.js：无状态 StreamableHTTP，6 工具复用内部函数
- [x] public.js 导出 rateLimit 供复用
- [x] server.js 挂载 /mcp
- [x] tests/mcp.test.js：initialize + tools/list 冒烟
- [x] 本地 npm test 全绿（195/195）
- [x] push → Railway 部署 → curl 生产 /mcp 验证（initialize/tools/list/tools/call 全通）
- [x] Smithery 重新发布 URL → 扫描 SUCCESS（Capabilities found: 6 tools）→ 页面完整
- [x] 更新 memory + 本文件复盘

## 复盘
- Smithery 2026 起 URL 模式只认 Streamable HTTP MCP，旧 smithery.yaml(stdio+commandFunction)
  仅存量兼容，新条目不再扫描它——smithery.yaml 可以从仓库删除（无害，留着也行）。
- /new 向导不能覆盖已有条目（报 ID 已存在）；更新 URL 要走服务器页 Releases → Publish 弹窗。
- Smithery 的 React 表单必须用真实鼠标事件（puppeteer click），JS 合成 click/input 事件
  对开关类控件无效（表单不进 dirty 状态，Save 不亮）。
- 扫描日志的两个 Warning 无害：resources/prompts Method not found（只暴露 tools）、
  no config schema（可选 API key 未声明；以后想让用户在 Smithery 界面填 key 再补 configSchema）。
