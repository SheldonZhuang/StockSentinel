# 定价体系（2026-07 定稿）

> 原则：信号是日更低频数据，单次调用边际成本≈0——**订阅分档配额为主体，不做纯按量计费**；
> 年付打折锁定现金流。所有档位均含免责声明与"仅供研究参考"定位。

## 三层客群

| 客群 | 通道 | 档位 | 定价 |
|---|---|---|---|
| AI / 开发者 | 开放API / MCP / GPT | FREE | $0，25 请求/日（无key试用）→ 签发 free key 250/日 |
| | | PRO | $9.99/月，10,000 请求/日 |
| | RapidAPI 上架同价 | ULTRA | $49.99/月（RapidAPI 档），300,000/月 |
| 个人投资者 | 网站 + 邮件提醒 | Free | 信号查看 + Track Record |
| | | Pro | $9.9/月 或 **$79/年**（≈8折） |
| 机构 / 再分发 | 年度授权（人工谈） | Enterprise | $999+/年起，含 pro key、数据再分发许可、优先支持 |

## 收款路径（按启用顺序）

1. **RapidAPI 内置计费**（已具备）：平台代收，抽成≈20%，零开发——API 收入的第一入口
2. **Stripe Payment Links**（有真实付费意向时启用）：Stripe 后台建订阅链接 → 用户付款
   → 管理后台手动签发 pro key；量大后再做 webhook 自动化
3. **企业合同**：线下签，人工开 key

## 基础设施对照表（收费前置条件）

| 项 | 状态 |
|---|---|
| 限流计数持久化 + 按key用量底账 | ✅ 已上线（api_usage 表，60秒批量落盘） |
| 正常运行监控 | ✅ UptimeRobot 已配置（5分钟/次） |
| 数据库每日备份到 GitHub 私有仓库 | ✅ 代码已上线，见下方配置步骤 |
| CDN / 密钥哈希 / 正式SLA | 暂缓（等机构客户） |

---

## 数据库备份配置（一次性，约10分钟）

代码已内置：每日 cron 自动把 SQLite 备份到你的 GitHub 私有仓库（dated 文件 + latest.db 滚动）。
只需配三个东西：

### ① 建私有仓库
GitHub 右上角 ➕ → New repository → 名称 `stocksentinel-backup` → 选 **Private** → Create。

### ② 生成细粒度令牌（PAT）
1. GitHub 右上角头像 → Settings → 左栏最底 **Developer settings**
2. **Personal access tokens → Fine-grained tokens → Generate new token**
3. 填写：Token name `stocksentinel-backup`；Expiration 选 1 年；
   Repository access 选 **Only select repositories** → 勾 `stocksentinel-backup`
4. Permissions → Repository permissions → **Contents** 选 **Read and write**（其余全不动）
5. Generate → **复制 `github_pat_` 开头的令牌**（只显示一次）

### ③ Railway 加环境变量
Railway → 后端服务 → **Variables** → 添加三条：

```
GITHUB_BACKUP_REPO=SheldonZhuang/stocksentinel-backup
GITHUB_BACKUP_TOKEN=github_pat_xxxxxxxx（②复制的）
DB_PATH=/app/data/stock-sentinel.db
```

> `DB_PATH` 这条很重要：你的 Volume 挂在 `/app/data`，显式指定后数据库确定落在持久卷上，
> 重部署不丢数据。保存后 Railway 会自动重启服务。

### ④ 验证（30秒）
重启完成后，用管理员账号获取 token 调用手动备份端点，或直接等次日 cron。
最简单的验证：第二天打开 `stocksentinel-backup` 仓库，看到 `backups/latest.db` 即成功。
