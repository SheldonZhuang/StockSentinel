# 让 Railway 云端连上本地 moomoo OpenD（行情数据源接通指南）

## 为什么云端现在连不上（根因）

moomoo/富途不提供云端行情 API——所有行情必须经过 **OpenD 网关程序**，而 OpenD 只能运行在
你登录过 moomoo 账号的电脑上（当前在你本地 Windows，监听 `127.0.0.1:33333` 的 WebSocket）。
Railway 容器在美西机房：

- 容器里的 `127.0.0.1` 指向容器自身（没有 OpenD）；
- 你家电脑在运营商 NAT 后面，没有公网可达地址；
- 所以**无论重试多少次都不可能连上**——这是网络拓扑问题，不是配置或代码 bug。

要接通，必须给云端一条到你电脑 OpenD 的网络通道。两条路线：

## 路线 A（推荐）：Cloudflare Tunnel 把本地 OpenD 暴露给云端

原理：你电脑上跑一个 `cloudflared` 客户端，主动向 Cloudflare 建立出站隧道（无需路由器端口
转发、无需公网 IP），Railway 通过一个固定域名访问隧道，流量转发到本地 33333 端口。

1. 本地安装 cloudflared 并登录（需要一个托管在 Cloudflare 的域名）：
   ```powershell
   winget install Cloudflare.cloudflared
   cloudflared tunnel login
   cloudflared tunnel create moomoo-opend
   ```
2. 配置 `%USERPROFILE%\.cloudflared\config.yml`：
   ```yaml
   tunnel: moomoo-opend
   credentials-file: C:\Users\Administrator\.cloudflared\<tunnel-id>.json
   ingress:
     - hostname: opend.你的域名.com
       service: ws://127.0.0.1:33333
     - service: http_status:404
   ```
3. DNS 绑定并常驻运行（注册为 Windows 服务，开机自启）：
   ```powershell
   cloudflared tunnel route dns moomoo-opend opend.你的域名.com
   cloudflared service install
   ```
4. **必须**在 OpenD 设置里启用 WebSocket 私钥（否则等于把行情网关裸奔到公网）；
5. Railway → Variables 设置：
   - `MOOMOO_WS_HOST=opend.你的域名.com`
   - `MOOMOO_WS_PORT=443`（经 Cloudflare 走 wss）或隧道直连端口
   - `MOOMOO_WS_KEY=<OpenD 设置里的 WebSocket 私钥>`

注意：futu-api 的 `start(host, port, ssl, key)` 第三参是 SSL 开关——走 Cloudflare 443 需要
wss。如果实测 futu-api 对 wss 支持有问题，退而求其次用"隧道 TCP 模式"（`cloudflared access tcp`）
或路线 B。

## 路线 B：frp / Tailscale 打洞

- **Tailscale**（最省事）：本地电脑与……Railway 不支持直接装 Tailscale 客户端到托管容器，
  需用其 userspace 模式打包进镜像，改动较大，暂不推荐。
- **frp**：租一台最便宜的 VPS 跑 frps，本地跑 frpc 把 33333 映射到 VPS 公网端口，
  Railway 配 `MOOMOO_WS_HOST=<VPS IP>`。同样必须开 OpenD WebSocket 私钥 + VPS 防火墙
  只放行 Railway 出口 IP。

## 路线 C（不推荐，列出供知情）：在 Railway 容器里直接跑 Linux 版 OpenD

OpenD 有 Linux 命令行版，理论上可打包进部署镜像。不推荐的原因：
- 首次登录需要手机验证码/设备验证，容器每次重启都是"新设备"，无法自动过验证；
- 云机房 IP 登录券商账户有风控风险（账号安全审查、异地登录锁定）；
- 账号凭据要放进云端环境变量，泄漏面扩大。

## 现状与兜底

- 未接通期间**产品功能不受影响**：行情走 Yahoo→Tiingo→TwelveData 回退链（moomoo 的
  增量价值是 LV3 实时行情质量与美股盘中快照，不是可用性）。
- 代码侧已做：连接失败指数退避（60s→6h 封顶，不再每分钟刷屏）；失败日志现在会打印
  实际目标 host:port 并区分"本机 OpenD 未开"与"云端无通道"两种场景。
- 常驻风险提示：路线 A/B 都要求你的电脑 24 小时开机运行 OpenD；电脑关机时云端自动
  回落到备用行情源，属预期降级。
