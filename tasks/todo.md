# 125号:AI生态接入(SEO/GEO)+第九轮审查修复+发布清单 — 2026-08-15 【已完成】

## 125e 三平台上架收官（2026-08-16 下午）
- [x] RapidAPI 已上架公开：https://rapidapi.com/SheldonZhuang/api/stock-sentinel（Finance/6端点/三档定价 BASIC 25/日·PRO $9.99 万/日·ULTRA $49.99 30万/月；Short+Long Description 按材料包填齐；PRO 配额从默认月口径改为 10,000/日与材料包一致）
- [x] Smithery 无需手动：下午复查已收录 sdzhuang/stock-sentinel-mcp（82分）且 Overview 已自动聚合新文案，无 SMH-SPY 旧字样（上午 404 判"需手动"系聚合延迟，guide 已更正）
- [⏸] GPT Store 暂缓：需 ChatGPT Plus，用户拍板等有 Plus 再做（隐私页+全字段材料已备好，listing-materials.md ③）
- 待观察：RapidAPI 网关转发按 IP 计入后端免费配额（25/日与后端 free 层同量级恰好对齐）；若 PRO/ULTRA 有订阅者，把网关代理密钥在管理后台签发绑定为 pro key（listing-materials.md ② 注）


用户目的：让搜索引擎与 AI Agent 找到并调用本项目全部接口工具，提高调用量；全面检查逻辑与代码错误（"推倒重建"经审查实证否决——核心逻辑全部正确，缺陷是局部的）。
已拍板：首页开放未登录只读（SEO/GEO 最大单变量）；禁用=封禁停发邮件。

## 盘点结论
工具层已齐（npm MCP v1.0.3+MCP Registry 已发布/远程MCP/smithery.yaml/openapi/SKILL.md），缺的是**发现层**——本轮补齐。

## 第九轮审查修复（10项+1拍板项，子代理实测验证非纸面推理）
- [x] 高危#1 usage-log 失败重插 slice(-0)=整个数组→故障期内存无界增长：单飞守卫+room>0有界重插
- [x] 高危#2 未匹配404原样入库（单IP 30天~594MB脏行/撑爆备份100MB上限/GROUP BY卡事件循环）：normalizeEndpoint——404归并_unmatched哨兵+动态段归一（/v1/stock/:symbol等），端点值域封闭
- [x] 高危#3 订阅到期编辑框UTC↔local双重换算每保存漂移一个时区（UTC+8实测-8h）：openEdit减getTimezoneOffset填本地墙钟；浏览器实测显示17:30(=UTC 09:30)、无操作保存库值不变
- [x] 中#4 insertCallLogs 5000条独立事务634ms阻塞：BEGIN/COMMIT+prepared statement(~32ms,20倍)
- [x] 中#5 调用总量把近30天v1/mcp双计：storage加web_30d，总量=底账+web明细
- [x] 中#6 并发flush竞态（persist临时文件同pid同名）：与#1同一单飞守卫
- [x] 低#7 今日配额UTC日切与全站美东不一致：7语言标签注明(UTC)（配额本身就是UTC，数字正确不改口径）
- [x] 低#8 独立来源列对web匿名恒为0（COUNT DISTINCT跳过NULL）：web埋点identifier记ip:归一IP
- [x] 低#9 normalizeExpiresAt接受'123'(公元123年)静默降级付费客户：用户订阅路径限2000-2100
- [x] 低#10 管理员可禁用自己→不可自解锁死：后端403+前端自己行隐藏按钮
- [x] 拍板项：getAlertSubscribers过滤disabled（禁用=封禁停邮）
- Safari兼容顺手修：remainingDays日期串改'T'分隔（空格分隔V8宽容Safari返回NaN）

## SEO 收录包
- [x] index.html：lang=zh-CN/title/description/keywords/canonical/OG全套/twitter card/JSON-LD(WebSite+SoftwareApplication)/theme-color
- [x] frontend/public/：robots.txt(禁/admin+指sitemap)/sitemap.xml(3公开页)/favicon.svg落地文件
- [x] 每路由标题：router afterEach按i18n设document.title（pageTitle.* 4键×7语言）
- [x] 首页开放只读：/去requiresAuth；HomeView未登录隐藏自选股+登录引导条(home.loginCta×7语言)；router.test.js守卫断言更新+标题测试

## GEO 包
- [x] frontend/public/llms.txt：AI爬虫一页读懂全部调用通道（API base/openapi/远程MCP/npm包/SKILL raw/track-record/配额/免责）
- [x] GET /v1/openapi.yaml：API宿主自发现，注册在计量前=发现流程免日配额（与MCP握手免费同原则），进程内缓存
- [x] openapi.yaml：info补GEO互链(网站/llms.txt/MCP坐标)+contact；5个端点补简要response schema（字段名对照真实payload核实）

## 测试与实测
- [x] 后端629/629（+8新：端点归一/有界重插/单飞/停邮/自锁403/范围校验/openapi端点）前端27/27
- [x] 浏览器实测：匿名首页停在/不跳登录+标题+CTA+无自选股+meta/JSON-LD在DOM；robots/sitemap/llms/favicon全200；admin标题+UTC列+自己行无禁用按钮+时区往返闭合

## 文档与发布清单
- [x] publishing-guide第五步：SEO/GEO产物表+用户侧提交清单（Search Console/Bing/RapidAPI/GPT Store可直接用/v1/openapi.yaml/Smithery确认）
- [x] admin-guide：口径修正(UTC)标注/调用总量web口径/禁用=封禁/自锁防护/埋点值域封闭；README：发现层行+public/目录树
- 用户侧待办（账号操作）：①Search Console提交sitemap ②Bing一键导入 ③RapidAPI上架 ④GPT Store建Action ⑤Smithery收录确认——步骤见publishing-guide第五步

## 明确不做
推倒重建（实证否决）；SSR/预渲染（公开首页+静态meta已覆盖，成本不成比例）；替用户在外部平台注册发布

---

# 123+124号:后台用户管理+API用量监控+文档同步 — 2026-08-15 【已完成】

目的（用户明确）：知道每个用户调用什么功能/调用量/是否付费/剩余额度或天数，越详细越好，
方便后台维护，**在用户最需要的方向加强资源投放**。

## 已拍板决策
- 订阅到期后绑定该用户的 pro key **自动降级为 free 配额**（key 不禁用，续费即恢复）
- 按次明细调用日志**保留 30 天**（每日清理）；按天聚合 api_usage 表不变仍 400 天

## 交付清单（全部完成）
- [x] 数据层：users 加 disabled/subscription_expires_at（激活死列 is_subscribed）、api_keys 加 user_id、新表 api_call_logs（ts/user/key/渠道/端点/状态码 + 双索引）
- [x] 埋点：utils/usage-log.js 内存缓冲(上限5000)+10分钟批量落盘+每日清理；/v1（rateLimit挂归属）、/mcp（端点=工具名）、/api（web，公开路由带Bearer头时埋点侧轻量JWT解码归属）三渠道全覆盖
- [x] 订阅到期自动降级：resolveTier 联查 owner，pro+订阅失效→free 配额；禁用用户名下 key 401
- [x] 禁用语义：登录403（密码校验后判，防枚举侧信道）+ requireAuth兜底 + bump token_min_iat杀存量JWT + invalidateKeyCache 即时生效
- [x] 管理接口：GET/PATCH /api/admin/users（列表聚合统计/搜索/分页/编辑订阅与禁用）、GET users/:id/usage（按日/端点TOP/明细分页/渠道筛选）、GET endpoint-stats（全局功能热度）、api-keys 支持绑定 userId
- [x] 前端 UserPanel.vue：列表（订阅badge/剩余天数告警色/今日配额/调用量三列/最后调用）+ 行内编辑 + 行内详情（柱状图/端点TOP/明细）+ 功能热度表；i18n 7语言同提交同步（admin.users.* 45键）
- [x] 测试：后端 621/621（+13新：存储/路由/降级/禁用/日志）、前端 26/26 全绿
- [x] 浏览器实测：登录/列表/搜索/编辑订阅（bob设8-20到期→剩余5天橙色）/禁用（登录即403、行置灰）/详情三块/渠道筛选（8→4次）/中英切换全通过
- [x] 文档：新建 docs/admin-guide.md；pricing-and-ops.md（收款路径+基础设施表）；openapi.yaml（pro与订阅挂钩）；README（API表行/后台管理段/目录树）

## 审查节（实测抓到的 bug，已修）
1. **finish 事件时 Express 已重置 req.baseUrl**→端点串出现 `undefined/...`——改为中间件进入时捕获
2. **公开路由（/api/signal 等）不走 requireAuth**→登录用户 web 调用无法归属——埋点侧轻量 JWT verify（微秒级，失败按匿名计，绝不影响请求）
3. 诚实披露：web 渠道明细只有30天（无长期底账）；匿名 ip: 流量不伪造用户归属，只进功能热度的"独立来源"列

## 运维要点
- sql.js 全库导出特性 → 明细绝不逐条落盘；管理端读接口先 flushCallLogs 保证实时
- 改后台功能须同步 docs/admin-guide.md（本轮新约定）

---

# 121号:用户质询"7-29反弹无进攻信号/行政未宽松/30天迟滞是否过长"——数据核查+A系日频评估,维持现状 — 2026-08-04

- 核查结论:系统无故障。行政tight=EPU双指标仍>80分位(日频P88→82.6回落中,天级通道在走);油价30日+17.8%(从战时峰值回落但未达-20%宽松线);实际利率1.52%贴否决线(9月降息自然解除);SPY全程在10月SMA上方
- **纠错(已入lessons)**:上轮误称S5目标仓位100%——实际CAPE 41.51/30年分位P95.6,估值层激活→目标55%(用户实盘50%一致)。关键推论:**当前限制仓位的是估值层不是宏观档位,即使今天进攻目标仍是55%**
- **CAPE数据源补档(用户问询)**:multpl(Shiller同源)/30年360月滚动分位/当月值随收盘日更+系统24h缓存/fail-soft沿旧值;解除参考系P90≈CAPE 37-38(回落约9-10%或分母消化两三个季度)——已写入 s5-execution-playbook §五
- **30天降档迟滞A系日频评估(重跑,W4a搁置项落地)**:所有缩短方案更差——A14(趋势上14天)年化12.09→11.87%/08覆盖97.3→94.6%;A7→11.77%;A0即时→11.67%且假阳性4/10→6/18(2001-02/2008防守段碎片化往返,A0在2008-01防守提前293天退出后5月又重进)。**30天迟滞是正收益部件(熊市反弹中扛住防守),不是官僚确认期**;对当前的实际代价仅是"新钱进现金多等2-3周"。三档均未过硬约束,维持30天,用户"维持现状观察"确认

---

# 120c号:第二源接入+三条遗留观察清账(用户"最新建议执行",2026-08-04) — 2026-08-04

- [x] **AI需求第二源(Cloudflare Radar)**:GET /radar/ai/bots/timeseries(dateRange=12w,日频),28日均vs前28日均趋势%,与OpenRouter调用量同窗口口径。诚实定位:全网AI活动(爬虫+代理流量)的宏观代理而非推理API直测——**只进usage_divergence分歧核查邮件做独立佐证,不进判定链**(进判定属新增判定输入须另拍板)。Radar同步回落→收紧可信;仍增长→份额漂移嫌疑增强。未配token/失败→邮件如实注明第二源不可用(fail-open)。纯函数calcRadarTrendPct+4单测;12h缓存;**需用户配CLOUDFLARE_API_TOKEN(免费,仅Radar读权限,两实例都配)才激活**,README环境变量已注明
- [x] **replica日报LLM跳过**:generateDailyReport只在primary跑(OpenRouter成本减半);本机日报页显示本机库旧报告;DAILY_REPORT_ON_REPLICA=1可恢复
- [x] **S5手册重审记录**:120b六项变更对S5的影响逐条核定——否决器不改动作(attack/neutral同操作);趋势地板令reduce日增多(跌破趋势暂停定投),实跑S5a基线38.8→38.7%/含CAPE层40.1→40.0%/2022年-31.6→-31.7%,浮亏与假信号(4/9)不变;手册数字+admin.js速览(40.1→40.0,带快照日期注释)已同步
- [x] **playbook.note改i18n**:S5面板说明从后端硬编码中文直出改为前端7语言key(s5.playbookNote);后端字段保留给API消费者
- 测试:后端608/608(+4 radar) 前端26/26 全绿

---

# 120b号:三项判定参数变更+三条方法论建议落地(用户拍板,2026-08-04) — 2026-08-04

用户对120号"待拍板"清单全部批准；①实际利率护栏经诚实复核改为修正形式执行。测试604/604+26/26全绿，回测产物全链重跑，硬约束逐位保持(年化12.31%/回撤-16.2%/召回5/6/首防月份不变)。

## 已上线的判定变更(均全端同步:signal.js+config+回测镜像+7语言hint+SKILL/README/openapi/buildFacts/MCP×2+threshold-sync守卫)

- [x] **M1 WALCL改13周窗口**:QT/QE基线从相邻周观测改为13周前观测(baselineValue/lastTwoWeeklyAsOf双端同步),阈值0.25%/周→0.8%/13周——单周口径真实QT节奏下结构性失灵、被单周噪声随机干扰。回测实证:首防月份/年化逐位不变(防守共振以利率子信号为主,QT角色是拦宽松票)
- [x] **M2 曲线倒挂改窗口口径**:严格连续计数(单日转正清零)→"近63个交易日中倒挂≥51天(≈80%)"——2019型浅倒挂不再永不确认。fetch-macro计数/applyYieldCurveVeto/daily-replay curveRunLengths滑窗/前端ycStatus与清单(63→51)/ycInvertedDays标签7语言全部同步
- [x] **M3 否决器输入沿用上一快照**:倒挂天数/信用利差当日拉取失败时用prevSnapshot值再进否决器(生效值入库,payloads实时重算同口径)——消除单日attack↔neutral翻转+反向邮件对;真正新库仍fail-open
- [x] **①实际利率否决器(修正形式)**:用户问"逻辑合理吗"——诚实答复:原维度级形式(暂停只给neutral)已被V5评估证明在非对称进攻树下结构性无效;修正为第三进攻否决器 applyRealRateVeto:政策利率−12M截尾PCE≥1.5%时否决进攻(只拦attack,fail-open,月度回测attack不可达故为纯前瞻护栏,与信用利差否决器同一采纳逻辑)。前端清单+interpret.realRateOk×7语言
- [x] **②OpenRouter单点交叉验证**:复核发现宽松侧已有内建双源交叉(calcAiSupplySignal宽松票要求三件套全绿),单点风险在"假收紧"(份额漂移)。落地:调用量单独收紧而capex(EDGAR)/半导体(FRED)两独立源均无恶化佐证→收紧照常生效(防守不过夜)+usage_divergence标记+运维邮件请人工核查(管理面板override纠正路径);真二源(如Cloudflare Radar)仍为待办
- [x] **③趋势地板(先评估后采纳)**:M系曾否决"市场维投tight票"(-2.6pp),本条是更温和变体——跌破10月SMA时最终档位至少reduce(不投票不凑共振)。--eval-floor实证:头条口径年化/回撤/召回/假阳性逐位不变;新增12个reduce月(2010-06~09/2011-09/2012-01/2015-10/2016-02,03/2022-02/2023-10,11),**2022部分响应从05提前到02**(预期驱动顶的缺口首次被部分覆盖);诚实披露:减半仓执行口径年化9.11→8.07%(现行"停止加仓不减存量"语义无此成本)。applyTrendFloor接入server/payloads/daily-replay/月度回测默认基线(VARIANTS_DEFAULT.trendFloor)

## 产物刷新
- [x] run-backtest+bootstrap-ci+daily-replay全链重跑;SKILL减半仓口径9.1→8.1(趋势地板致reduce月170→182);doc-numbers/monthly-replay-drift/locks-drift/threshold-sync四道守卫全绿
- [x] 新增单测:applyRealRateVeto×3/applyTrendFloor×3/曲线窗口计数/13周基线/VARIANTS_DEFAULT守卫更新

---

# 120号:第八轮系统性深度审查(用户口称114号)——四路子代理并行审查,修复约40处,3项判定参数变更待拍板 — 2026-08-04

**审查方式**:四个子代理并行(判定逻辑/后端韧性安全/前端跨端一致性/回测文档诚实性),每条发现主会话亲自验证后修复。基线:后端592→597全绿,前端12→22全绿(修复前1个失败)。

## 已修复(bug/安全/文档口径,批量授权范围内)

**判定链bug(高/中危)**:
- [x] H1 catch-up跨午夜补跑违反118号"绝不提前跑"不变量——故障跨午夜恢复时会生成装着当日上午数据的"提前跑"快照。加守卫:期望快照日=今天(ET 21:45后)才允许补跑,否则只报overdue等正式cron。+2测试
- [x] M4 锁基线利率"重放":货币stale日快照fred_rate落null,次日??回退到序列前值,把上次FOMC调整当作当天新事件(锁龄恰跨60天时凭空解锁)。改宁缺勿假:prevSnapshot存在但fred_rate为null时端点差记null(台阶扫描照常工作)。+1测试
- [x] M5 117号暂定档复检×N3否决器组合缺口:复检把首晚误判cut纠正为maintain时只改档案行,已录入的90天N3收紧override无人撤销。补自动撤销('auto'清除哨兵,仅当活动override note含该symbol)+运维邮件请人工复核
- [x] L1 findNewEarningsFilings提前break可漏8-K(recent按受理时间排序,filingDate乱序行会截断循环)→continue全扫
- [x] L2 空库首跑把回看窗口内最长100天前的旧调整当"今天的事件"触发应对式锁→首跑限定台阶在近7天内(镜像computeLocksDaily同步,漂移测试守护)
- [x] L3 applyTrendReentry删除未使用的sahmLockActive参数(语义注释补全)

**后端韧性/安全(中危×4)**:
- [x] cron注册移到restore之后——启动恰落XX:19:5x且restore未完成时,看门狗getDb()用空库初始化句柄,restore落盘文件被下一次persist整库覆盖(全量数据丢失竞态)
- [x] restore补replica守卫(对称backupDatabase的H2):本机丢库时不再拉回云端primary的库(身份静默被替换)
- [x] auth限流补纯IP层(60/min)串联ip|email层:旋转邮箱可无限触发bcrypt打满CPU(每换邮箱一个新20/min桶)
- [x] /api内部只读路由补120/min保底限流:CORS只约束浏览器,脚本直打/api/signal绕开/v1配额体系(与"/mcp batch绕限流"同构);backtest/summary加进程内缓存(269KB每请求重复parse)
- [x] 低危×6:全局unhandledRejection兜底+mcp close() catch/分钟限流IPv6按/64归一(normalizeIpForQuota下沉共享)/退订token常数时间比较+JWT_SECRET缺失启动CRITICAL告警/replica不信任代理头(trust proxy按角色)/fundamentalsCache容量上限/saveGuidanceRecord改ON CONFLICT DO UPDATE保留manual_verified列

**前端跨端一致性+可访问性**:
- [x] hintGlobal 7语言补信用利差否决器(116c只补了openapi,悬停提示漏网——"提示与规则同提交"教训复发);capexGuidanceRefHint 7语言补③暂定档48h复检说明
- [x] 进攻清单补"无锁"项(toAttack文案列"无锁"清单却无此项自相矛盾)+interpret.locksOk×7语言
- [x] MacroPanel日期Intl格式化补timeZone:'UTC'——美洲用户所有决议日/参考期显示提前一天,月度参考期直接错月
- [x] SignalHero行政收紧归因+mailer邮件同构处复刻油价完整护栏(EPU高位+O1低位反弹;旧Math.abs连大跌都归因WTI);server.js details补oilLevelLow字段
- [x] 快照stale警示改按工作日≥3计(日历日3天在每个周一假日误弹"信号已失效"红横幅)
- [x] 萨姆<0.5不再显示绿"宽松"徽章(锁触发器不投维度票,语义过度)
- [x] a11y:16处hover-only提示触屏/键盘完全不可达(违反全设备可用要求)→MacroPanel指标行/AiChainPanel泡沫三格+指引块/S5卡stale标签改点击/回车展开(role=button+aria-expanded,title保留作鼠标捷径);WatchlistPanel加"指标说明"统一入口+✕删除按钮aria-label;App.vue主题/提醒按钮aria-pressed、语言select加label
- [x] AdminPanel:loadRef补请求序号防竞态(照WatchlistPanel loadSeq);API key掩码二次切片修正(后端已存前缀,直接显示)
- [x] client.js:200+非JSON改走统一错误路径(PARSE_FAIL哨兵区分合法JSON null),不再让组件null.length崩子树
- [x] 细节:percentileClass判undefined/默认endDate用本地日期(UTC致美洲晚间"明天")/9px排序箭头收敛fs-xs/✕按钮text-5→text-3(对比度2.8→3+)/stale卡opacity 0.55→0.75/text-4双主题微调达AA(4.4/3.9→4.5+)
- [x] **新增threshold-sync.test.js**:前端硬编码阈值(63/60/80/50/±20/±3/10/0/0.5)钉死后端signal.config.js快照,后端改阈值前端测试红灯(房哨兵554处漂移教训的自动化防线)
- [x] 修复s5panel过时测试:116号删{'$'}转义未同步测试,**前端测试自7/30红了5天无人发现**(前端测试不在提交必跑清单——流程洞,已入lessons)

**回测/文档诚实性**:
- [x] README"召回4/4"→"6场危机5场触发全面防守"(带快照日期);574用例数改不带数字表述;doc-numbers.test.js扩守护README召回行+禁硬编码用例数
- [x] 三处规则行补信用利差否决器:daily-report buildFacts(每日喂LLM的解读依据)/mcp/index.js/backend/api/mcp.js(116c只改了openapi.yaml)
- [x] T+1数字(12.82/12.13)从writeReport模板硬编码改动态读daily-replay-raw.json overall.dailyT1(缺字段降级提示);重跑daily-replay落盘dailyT1(12.78% vs T+0 12.09%)
- [x] 重跑run-backtest+bootstrap-ci:报告回到纯模板产物(此前是手工编辑与旧模板混合体);backtest-raw.json补generatedAt;SKILL.md数字同步(买持8.4%/子样本14.5%/CI[-0.4,+8.58]pp/快照日期2026-08-04);全量doc-numbers 9/9绿
- [x] signal.config.js FINAL_SIGNAL注释"四维全宽松"→非对称口径;s5-daily.mjs摩擦敏感性-0.2pp→实跑-0.1pp;daily-replay.mjs补信用利差否决器"结构性无操作未接线"备忘

## ⚠️ 判定参数/输入变更——按授权边界原则不自动执行,待用户拍板

- [ ] **M1 WALCL QT判定结构性失灵**:0.25%阈值套在单周环比上,真实QT节奏($5-22B/周≈0.1-0.25%)基本永不触发拦截,反被TGA波动等单周噪声随机打出tight/loose。建议改4周或13周窗口(阈值等比重标定)。影响:当前货币维可能loose→neutral
- [ ] **M2 曲线倒挂严格连续计数漏浅倒挂**:单日转正即清零,2019年型浅倒挂(多次短暂转正)永远攒不满63天,否决器整轮不点火。建议"近63交易日≥80%天数倒挂"或允许≤5天间断
- [ ] **M3 否决器输入fail-open×stale次序**:倒挂天数/信用利差当日拉取失败→null→放行attack,次日恢复→收回(单日attack↔neutral翻转+反向邮件对)。建议否决器输入沿用上一快照观测(对"只限attack"的角色这才是fail-safe)——属stale值进判定,114号同类项曾明确留给用户
- [ ] **方法论三缺口(专家评价,详见对话)**:①利率"水平盲"(5.5%高位长暂停判宽松)——建议实际利率>阈值时暂停只给neutral的attack护栏;②AI需求侧单点依赖OpenRouter——二源交叉应提为必做;③缺"市场自身"防守维(宽度/动量)——"宏观未动市场先崩"象限目前无人站岗

## 遗留观察(低优先,未修)
- 日报LLM生成replica也每天跑一遍(成本×2,正确性无碍);S5 playbook.note后端硬编码中文(仅管理员可见);S5手册版本行未随信用利差否决器补重审记录(不改S5动作)

---

# 119号:Railway日志EDGAR(BE)反复报错——companyconcept返回units:{USD:{}}空对象致.filter抛错无限重试 — 2026-08-04

**根因(已查实,live复现)**:SEC companyconcept API 对 BE(CIK0001664703) 的 Revenues 等科目
返回 `units:{USD:{}}`(空对象非数组,HTTP 200 非404);同公司 companyfacts 数据正常,是该端点
自身异常。空对象是真值,`(facts || [])` 拦不住 → TypeError → getFundamentals 按设计不缓存
失败 → 每次预热/请求无限重试刷日志。无数据污染:BE 的 P/S 一直正常降级为 null。

**修复(c57d103,红→绿TDD)**:三处改 `Array.isArray(x) ? x : []`——
- [x] sumTtmRevenue / fetchSharesOutstanding(fundamentals.js)
- [x] deriveQuarterlyCapex(fetch-ai-chain.js,同型隐患:`for...of {}` 抛 not iterable)
- [x] 新增 BE 实测形状测试用例×2;全量 592/592 通过;live 验证 getPsFromEdgar('BE') 不抛
- [x] 语义:非数组视同无数据 → null 正常缓存24h,BE 不再空转

**日志中其余条目均为已知常态,未动**:yahoo 429(数据中心IP限流,静默计数中)、
FMP 402(免费层配额,12h熔断)、FOMC 未入FRED(等官方序列)、guce.yahoo.com 重定向提示(无害)。

---

# 114号:参考指标大面积"暂无数据"——FRED凌晨维护窗口超时,加重试+指标级stale-keep — 2026-07-25

**追加(114c,文档归档+全端同步)**:README"可信度工程"改写为数据管道四层韧性(21点更新/重试/
组级stale-keep/看门狗)、SKILL.md开篇加更新时刻与periodDate解读规范(AI勿把参考期偏旧误判故障)、
openapi info加"更新节奏"段(客户端按*PeriodDate判新鲜度)。推送后Railway/Vercel自动部署。

**追加(114b,用户拍板)**:每日 cron 从 UTC 06:00(美东凌晨1-2点,正撞FRED维护窗口)改为
**美东 21:00**(`timezone: America/New_York`,夏令时自动切换,不再冬夏漂移1小时;北京次日9:00/10:00):
- 收益:盘后财报新闻稿/8-K(16:01-16:30)+电话会实录/媒体报道(18-21点,113号web源)当晚可抓;
  失业率/萨姆/PCE等上午8:30发布的月度数据**当天晚上入判定**(萨姆锁提前约15小时);
  H.15日频序列(曲线/信用利差)与SPY当日收盘价当天入判定(趋势/W5新鲜一天);完全避开FRED维护窗口。
- **新鲜度看门狗**(补stale-keep盲点):stale-keep会无限沿用旧值,序列改名/停更会被静默掩盖——
  有值但参考期超预算(月度100天/日频10天/EPUTRADE 160天)→运维邮件告警,人工核查数据源。
- 文档同步:README/capex追踪档(北京14:00→次日上午)/daily-replay可见性口径注释。
- 切换日两次快照(旧cron凌晨+新cron晚间覆盖),track record无断档。测试548/548。

**根因(已查实)**:云端(Railway)与本机日志同现 `timeout of 15000ms exceeded`/502——每日
cron 定在 UTC 06:00 = 美东凌晨1-2点,恰是 FRED 夜间维护/高延迟窗口;fetchMacroData 一次并发
10路请求,独立降级序列(核心PCE/截尾PCE 1M/6M/失业率/萨姆/信用利差/收益率曲线,加 fetch-policy
的日频EPU/半导体产出)超时即静默 null 落库,页面整天显示"—"。非 API key、非限流(429会显示状态码)。
必须成功的利率/资产负债表当天恰好抢通,12M截尾PCE云端偶然成功,故呈"部分有部分无"。

**方案(两层,均不改判定语义)**:
- [ ] ① fetchSeries/fetchReleaseDate 加重试:超时/429/5xx 重试2次(4s/8s退避),env可配
      (FRED_FETCH_RETRIES/FRED_RETRY_DELAY_MS);fetch-policy 复用同函数自动受益
- [ ] ② 指标级 stale-keep(backend/utils/stale-keep.js 纯函数):保存快照前,值仍为 null 的
      参考指标组(值+参考期+发布日整组)沿用上一快照——月度/日频序列昨日观测依然有效,
      参考期如实显示旧日期。放在四维信号/锁/曲线否决计算**之后**,判定链与既有信号级
      stale-keep 语义零变化
- [ ] 测试:现有 mock 计数用例设 FRED_FETCH_RETRIES=0;新增重试用例+stale-keep 单测
- [ ] 全量测试通过后 commit+push(Railway/Vercel 自动部署,startup runDailyUpdate 会当天回填)
- [ ] 验证:云端 /api/signal 缺失字段恢复;本机重启后端同步恢复

**诚实披露(不在本次范围,留观察)**:萨姆值/曲线倒挂天数当日拉取失败时,锁触发与进攻否决
仍按 null fail-open(既有行为)。stale-keep 只回填展示层;若要让防守侧判定也用昨日值,
属判定输入变更,须单独醒目告知用户拍板(授权边界原则)。

---

# 113号:capex 指引检测补源(电话会/媒体)+ 财报后单公司 capex 快报 — 2026-07-23

**追加(113c,文档归档+全端同步)**:Q2追踪档(电话会指引/新闻稿时差两项人工追踪转自动化+GOOGL
闭环结果)、SKILL.md N3描述、openapi /ai-chain摘要、README(499→534,移除已自动化的待办)。
**云端自愈迁移**:云Railway库在新代码部署前已把GOOGL落成旧语义none且标已处理——增加自愈:
旧none无source的遗留档不算已处理(窗口内重检)+saveGuidanceRecord改upsert覆盖;推送后Railway
重启触发startup runDailyUpdate,云端GOOGL自动补齐($195-205B/单季$44.9B/TTM+97.7%),实测通过。
+2真实临时库测试(自愈语义/upsert),536/536。前端Vercel、云后端Railway均随push自动部署。

**追加(113b,用户拍板)**:放开 web 源自动录 N3,web 检索升为与新闻稿同等高度的必需源:
- 双源每次财报都跑、互相补齐字段(新闻稿口径优先,缺什么 web 补什么;来源URL常驻入档);
  任一源失败不落档、窗口内重试。none = 双源均未见指引。
- N3 自动录入:新闻稿 cut/high 即刻录(不等 web,防守不过夜);web 源 cut/high 须过
  **佐证门槛**(管理层原话一手来源 或 ≥2独立来源)——落地用户"数据源汇总得出明确下修"
  的表述,防单条媒体标题党/LLM幻觉误发全员减仓邮件(误报下修代价不对称,仅对 cut 设防)。
- web 达标下修可覆盖新闻稿非下修方向(电话会披露新闻稿未提的下修正是补源要抓的)。
- 测试 534/534(新增8:佐证门槛纯函数×4、达标/未达标/方向覆盖/press-cut-不等-web);
  发现并修复测试 mock 泄漏(getActiveAdminSignal 的 mockResolvedValue 穿透 clearAllMocks)。

背景:用户问"capex指引检测 GOOGL: 新闻稿未给指引(2026-07-22)"是为什么,并要求
财报后立即更新各云厂商:TTM capex 及同比、单季 capex 及同比、本财年指引、未来指引,
数据源扩展到电话会实录/PPT/媒体报道。

**根因(已查实,非 bug)**:实拉 GOOGL 8-K (0001652044-26-000066) EX-99 新闻稿全文,
不含 "expect"/"guidance"/"outlook"/"195" 任何前瞻表述,只有历史数字(Q2 capex $44,924M)。
LLM 判 none 正确;$195-205B 指引是 CFO 电话会口头给的——新闻稿单源覆盖不到
(代码"已知局限"注释早有声明)。本次补源。

**方案**:新 8-K 检测后两层增强:
1. 指引兜底:新闻稿无指引 → OpenRouter web 插件检索电话会/媒体报道二次判定,
   产出方向/本财年指引/未来指引/引用/来源URL;失败沿用"不落档、窗口内重试"语义。
2. 单公司快报:EDGAR XBRL 历史序列 + 新季度值(FMP 优先,LLM 提取兜底,理智带校验)
   → 单季额度/同比、TTM 额度/同比入档展示。

**判定层边界(遵守"新增判定输入须醒目告知"原则)**:新闻稿源 cut/high 自动 N3 不变;
**web 源 cut/high 只展示+醒目日志,不自动建 N3**(媒体转述幻觉风险),待用户拍板。

- [x] fetch-ai-chain.js 导出单公司 capex 序列(EDGAR+FMP 备源复用)
- [x] fetch-guidance.js:LLM#1 扩展 + web 兜底 + 快报计算 + 主流程整合
- [x] storage.js:capex_guidance_records 新列(CREATE+ALTER 双处,防新库缺列)
- [x] payloads.js 透出新字段
- [x] AiChainPanel 指引行升级为快报卡;i18n 7 语种同步(none 文案+hint 补源语义)
- [x] docs/capex-signal-rules.md 规则同步
- [x] 测试补全,全量通过
- [x] 回填 GOOGL:删 none 记录重跑,验证 $195-205B 入档

## Review

- 全量测试 526/526 通过(fetch-guidance 21 个,新增 9 个:web 兜底×4、快报纯函数×5)。
  前端 build 通过,7 语种 JSON 解析校验通过。
- GOOGL 回填实测(真实调用):direction=raise/high,source=web,
  FY指引 "$195-205B, raised from $180-190B"(CFO 原话入档),
  未来指引 "capex to increase significantly in 2027",3 个来源URL;
  单季 $44.9B(+100.1%),TTM $132.4B(+97.7%),qtr_end 2026-06-30。
  单季值与新闻稿 $44,924M 精确一致(FMP 结构化源命中)。
- 判定层零改动:N3 自动录入仍仅限新闻稿源 cut/high;web 源 cut 只醒目日志+红色芯片,
  是否放开 web 源自动录 N3 待用户拍板(docs/capex-signal-rules.md N3 节已留档)。
- 语义升级:前端 none 文案由"新闻稿未给指引"改为"未检测到指引"(新闻稿+网络检索双源均无
  才落 none;web 检索失败不落档、10天窗口每日重试)。

---

# 日度粒度历史重放（daily-replay.mjs）— 2026-07-18

目标：复刻线上每日 cron 判定路径，2000-01-01~2026-06-30 逐交易日推进，测出真实日级时点
（月度采样把日频油价/EPU/台阶锁/30天降档确认全部抹平）。不改线上代码与 VARIANTS_DEFAULT。

- [x] 通读 run-backtest.js / signal.js / server.js(computeLocks+runDailyUpdate) / fetch-macro / fetch-policy
- [x] 新建 backend/backtest/daily-replay.mjs：日频输入(利率台阶/USEPUINDXD/油价/SPY/T10Y3M)
      + 月度输入按发布日阶梯化(MTS次月15/SAHM次月首周五/EPUTRADE月后1月/PCEPI次次月初)
      + 锁按日演进(60天锁龄快照差+台阶) + 30天降档确认(真日历日) + 货币决议口径(日历2025+，此前台阶近似)
- [x] 六场危机日级时点表(vs月度) + 整体指标对照 + 翻转诊断
- [x] 纯函数单测(发布日阶梯/日度锁状态机/利率窗口口径)，npm test 全绿
- [x] 汇报结论：线上真实滞后 vs 月度口径，应更新哪些成绩单数字
- [x] 追加：O系油价水平护栏评估(--eval-oil)——O1(低于2年中位抑制飙升tight)消除2009-03/05
      两段误火(+21.9pp段内挽回)、2020-06段+1.0pp，六危机时点逐日不变、2022-03-23俄乌保住，
      日度年化11.31→12.13%、假阳性6/12→4/10；O2a/O2b/O3敏感性全过(12.13~12.16%)；
      月度同款开关逐位无变化(单代理口径下飙升tight分支结构性冗余，单测锁定该不变式)
- [x] 追加(96号)：S5日度精化 backend/backtest/s5-daily.mjs——日度S5a XIRR 38.8%(月度37.0)、
      往返7→9次、假信号4次/踏空110.7%；V4迟滞把raw的20次往返压回9次(XIRR 36.0→38.8)；
      T+1次日执行不吃亏反而41.3%(信号日超跌次日反弹，9样本弱统计不构成刻意延迟依据)；
      2022年-59.4→-45.3%(T+0)/-36.5%(T+1)；浮亏月度口径-8.8%系采样美化，日度盯市-28.3%
      (2002-04/2008-01两个解锁窗买回再卖各-27%/-23%，月度采样跳过)；+14个测试
- [x] 修复主会话遗留：daily-replay默认O1的 lookbackObs/windowObs 字段名错配(护栏静默失效)
      + ??吞掉显式null基线——改===undefined判缺省、oilLevelLowAsOf容错别名，回归测试锁定
- [x] 追加(用户核对S5后)：A趋势条件化确认期(30→14/7/0天,仅SPX≥SMA时)——信号层三档全败硬约束
      (年化12.13→11.91/11.80/11.71、08覆盖97.3→94.6/94.1/91.4)，S5传导同样全败(XIRR 38.8→
      37.1/36.2/35.8、2008年-21.2→-36.1%——2007-12熊市反弹站上SMA提前买回吃1月暴跌)：
      **再入场延迟是保护不是成本，V型踏空=熊市反弹保险的保费，A全档否决**；
      B新钱规则：N1(reduce照买TQQQ)+0.2pp XIRR但浮亏-28.3→-57.2%(2000-05顶部买入)不推荐；
      N2(reduce买QQQ)收益持平、浮亏-29.0%几乎不变、闲置月74%→25%——心理最优解可选；
      现行(攒现金)仍是风险调整后默认。--eval-trendhold + s5-daily A/B/A×B 表全可复现


---

# 第六轮全面审查（专家视角重审 + 逻辑/代码纠错）— 2026-07-17

背景：用户要求以顶级美股投资专家视角重新审视"进攻/防守判断"项目目标，
全面检查逻辑与代码错误，修复后同步 GitHub。基线：209/209 测试通过，工作树干净。

- [x] 四路并行子代理审查：信号方法论 / 后端代码 / 回测正确性 / 前端+MCP+文档一致性
- [x] 核实代理 findings，逐条验证后修复高/中严重度问题（30个文件，+603/−212）
- [x] npm test 全绿：backend 234/234（209→234，新增25个）+ frontend 5/5 + build 通过
- [x] 回测重跑：危机表改实际曝险路径口径，头部数字基本不变（年化11.3% vs 8.5%）
- [x] 专家视角设计建议整理成 docs/methodology-review-2026-07-17.md（规则改动待用户拍板）
- [x] commit + push GitHub
- [x] 复盘写回本文件 + 更新 memory

## 复盘

**本轮最重发现（线上高危）**：货币维度用日频序列"昨天vs前天"差值判方向——DFEDTARU
两次议息之间天天重复同值，差值恒为0，加息周期约95%的天数被判"宽松"，与 SKILL.md/回测
宣称的"加息周期全程收紧"三方分裂。教训：**"文档说A、回测测B、线上跑C"的三方分裂，
只有把线上真实取数路径当作独立审计对象才能发现**——前五轮都审了判定函数本身（纯函数
没错），漏了喂给它的数据语义（prevValue=昨天≠上一档利率）。

**第二教训（回测诚实度）**：危机表 savedPct 假设"从首次信号一路防守到底部"，但防守
片段会中途解除（2008年防守覆盖率实际仅66.7%）。对外展示的门面数字必须与 NAV 模拟同
口径；"能算出来"和"按实际曝险路径算"是两回事。修复后 2008"躲掉54%"→"少亏35.5pp"。

**第三教训（房哨兵模式重演）**：前端又手抄了后端阈值且已漂移5处（调用量预警键名不一致
导致红色预警永不显示、油价徽章还是无护栏旧规则）。凡是判定类展示，优先用后端算好的
子信号字段（aiMarketSignal/aiFundamentalSignal 已有），前端只渲染不重算。

**其余高危**：全局CORS白名单短路 /v1、/mcp 预检（浏览器端付费API全挂而服务端调用正常，
所以一直没暴露）；限流桶跨路由共享（刷/v1会误封登录）；用量Map/表无界增长。

**待用户拍板**（docs/methodology-review-2026-07-17.md）：趋势确认层（10月均线否决器，
预期拦住2007-10/2008-12/2019-12三个最贵错误）、应对式锁解锁方向约束、reduce档语义
（回测证明reduce月均+1.3%高于其余档，照建议减仓在统计上跑输不动）、AI调用量窗口错配
（现行参数下attack档结构性不可达）、线上真实决策树从未被整体回测。

---

# 追加：用户拍板"一并执行"方法论建议（2026-07-17 晚）

- [x] 货币维度口径确认：用户明确"每次FOMC会议结果vs上一次"——与已上线实现一致，无需改动
- [x] 无回测依赖批：调用量窗口28v28+阈值±3%、收益率曲线参考+倒挂63日否决进攻、reduce语义降级、七语言前端同步（commit 0928d65）
- [x] 六变体回测评估（--eval 可复现）：V3+V4采纳（年化11.3→11.7、2008覆盖94.4%、2020覆盖100%），V1/V2/V5/V6否决
- [x] V3+V4上线：calcLockActive锁存期60天 + applyDowngradeHold降档30天确认，快照3新列，回测复用同函数（单一来源零漂移）
- [x] 测试 backend 267/267 + frontend 5/5 + build 全绿；回测重跑定稿
- [x] commit + push

## 复盘（追加）

**两个假设被数据证伪，记录以防复议**：①"趋势确认层(10月SMA)能拦住三大错误时点"——实测2007-10
拦不住（市场刚见顶价格仍在均线上方），年化-1.0pp否决；②"半导体产出代理能让2000泡沫更早示警"——
实测泡沫首年semi同比+43~52%投的是宽松票，2019年误防守-12.2pp否决。教训：听起来最有道理的改进
（趋势过滤是教科书级方案）也必须过回测，本项目的"先评估后拍板"惯例再次证明必要。

**采纳的反而是两个"朴素"机制**：最短锁存期（60天）+ 降档迟滞（升即降缓30天）——不预测任何东西，
只是让系统"慢一点撒手"，就同时修好了2007-10/2019-12两个最贵的错误且年化+0.5pp。

**单一来源纪律**：回测的锁与迟滞直接复用线上 calcLockActive/applyDowngradeHold（月度按30天/月换算），
复用后数字与评估期逐位一致——避免了"回测测A线上跑B"第七轮重演。

---

# 追加2：用户问"2010起跑输买入持有"——归因与W5改进（2026-07-18）

- [x] 逐段归因：2010后13段全面防守全部假阳性；跑输2.3pp/年=假阳性-1.07+迟滞多扛-0.90+真危机损耗0
- [x] W系5变体评估：W5趋势再入场唯一帕累托改进采纳；W1/W3杀召回、W2/W4b打穿08覆盖否决
- [x] W5上线（calcTrendState+applyTrendReentry，快照3列，回测同函数）+定稿重跑
- [x] 新基线：全期12.2%、2010起12.9%（差距2.3→1.7pp/年）、防守占比25%、假阳性6/8、08保护不变
- [x] W2+W4b（全期12.9%/2010起15.0%反超买持，代价08少亏58→46pp）留作用户决策项
- [x] 测试288/288+5/5+build全绿，commit+push

## 复盘（追加2）

**归因先于开药方的价值**：直觉答案（"防守系统跑输长牛是宿命"）只对了一半——三桶分解显示54%来自
假阳性、46%来自迟滞尾巴，真危机时机损耗为0。假阳性可修，宿命论会让人错过12.3→12.9的改进。

**W5与被否决的V1是同一均线的两个方向**：V1"趋势之下禁解锁"（收紧方向）-1.0pp被否；W5"趋势之上
不空仓"（放松方向）+0.5pp采纳。同一指标，用在"何时更防守"失败、用在"何时别过度防守"成功——
因为系统的病是防守过度（假阳性89%）而不是防守不足（召回5/6）。对症下药比指标本身重要。

---

# 追加3：核心准确率审计与X1+X3采纳 + moomoo云端接通方案（2026-07-18，93号）

- [x] 准确率成绩单(accuracy-report.mjs可复现)：>15%危机线召回5/5=100%；精确率双口径28.6%严格/71.4%危机重叠；月度混淆矩阵F1 0.55
- [x] 每个错误归因到根：2004-08阈值噪声(X3修)/2024-08萨姆首次假阳性移民失真(X1修)/2018-12与2024-09属"不可安全消除"(与2008顶前入场同构)/2000与2022滞后=框架无估值维的结构盲区
- [x] X1(萨姆锁过趋势门)+X3(纯货币财政共振降reduce)采纳上线：新基线12.4%/-16.2%，纯误报3→2段，危机表零变化；X1b/X2/X4否决
- [x] 回测复用线上calcFinalSignal/applyTrendReentry(单一来源)；357/357全绿
- [x] moomoo保留：根因=OpenD在本地而云端无通道(拓扑问题非bug)；写docs/moomoo-cloud-setup.md(Cloudflare Tunnel/frp两路线)；失败日志区分场景+指数退避
- [x] commit+push

## 复盘（追加3）

**"100%准确率"的结构性反例找到了实证**：2007-09与2024-09在系统特征空间完全同构（联储-50bp+
市场创新高附近）——一个随后-55%，一个随后+20%。任何砍掉2024假阳性的规则同时砍掉2008顶前入场
（X1b实测：08少亏58.1→50.7pp）。准确率的提升空间在"滞后天数"（需要估值/情绪第5维）而非"对错"。

**精确率的表述口径很重要**：严格口径28.6%听起来很差，但危机重叠口径71.4%——把"晚到的正确信号"
记成"错误"是自我抹黑。对外TrackRecord应报双口径。

---

# 追加4：96-100号收束（2026-07-19）

- [x] S5产品化全链路：执行台面板(仅管理员)+边界指令邮件+日度精化(XIRR 40.1%含CAPE层)
- [x] CAPE层用户确认启用(P3档,>90分位→55%仓);O1油价护栏上线
- [x] A再入场加速证伪、B新钱变体N1/N2用户均否决——S5最终形态定稿(五参数表)
- [x] Railway降噪三件套(yahoo429去重/SIGTERM优雅关闭/废弃提示);用户已删MOOMOO_WS_PORT
- [x] 100号：全部决定同步手册/面板/邮件/memory并推送

## 复盘（追加4）

**S5最终形态的五个参数全部有"被否掉的对照"**：全卖(vs半卖)/退防即买回(vs等观望)/一次性买回
(vs分期)/减仓攒现金(vs照买/买QQQ)/30天确认固定(vs趋势条件化)——每行都是一次完整评估的结晶。
执行手册因此不只是规则，是"为什么不是别的规则"的判例汇编，用户动摇时可自查。

**用户否决N2的理由（核心标的只用TQQQ）提示了偏好维度**：数字近中性时用户选择标的纯粹性
而非资金利用率——未来提案时"多一个标的"本身就是成本。

## 115号/112号（2026-07-30 静默运行期周检 + MSFT/META 财报核对）

- [x] 周检发现 7/27-29 三天快照断档：计划任务 72h 执行上限+不重启是根因；已改不限时+每5分钟自拉起×10+解除电池限制
- [x] MSFT FY26Q4 指引记录误档预览稿（$190B/分析师$220B）→ 修正为 maintain/~$175B 会计重述（实际计划不变）
- [x] 检索 prompt 加时间护栏（只采信财报后报道）+ 会计口径护栏（名义变化实际不变判 maintain）
- [x] 云端 Railway 独立实例同被污染 → 启动自愈补丁（按 accession 幂等定点覆盖），push 部署后公网实测收敛
- [x] Q2 结果表补 MSFT/META；三家合计 $111.8B/≈+99.6% 仍翻倍，只待 AMZN（>$47B 即触发"继续加速"锚点）
- [x] 规则文档/README/SKILL/lessons 归档（112号）

## 复盘（追加5）

**"数据修对了"在多实例架构下是个陷阱**：本机手改数据库只修了一个实例，云端 Railway
有独立数据库、当晚被同样污染——发现纯属偶然（检查前端是否要更新时顺手 curl 了公网接口）。
正确姿势是项目已有的启动自愈补丁模式（代码携带修正、幂等、部署即全实例收敛）。
今后任何数据修正先问一句：还有哪个实例有同样的坏数据？

**MSFT 会计变更是未来误报的定时雷**：FY27 起含租赁口径媒体数字系统性变低，"capex 下降"
类报道会周期性出现。护栏已写进 prompt 与规则文档，但 web 检索的 LLM 判定不是铁板——
若未来 MSFT 被自动判 cut，第一反应先查是否口径问题（EDGAR 现金口径免疫，可交叉验证）。

## 116号（2026-07-30 系统性深度审查·第二轮，用户口称"114"，因114/115已用改编116）

- [x] 四路并行代码审查：信号判定逻辑 / 后端基础设施与安全 / 前端一致性与i18n / 回测引擎（共54条发现）
- [x] 以投资专家视角重新审视框架：骨架不动；三条框架外建议（信用利差进攻否决/回测置信区间/对外数字单一来源化）供拍板
- [x] 逐条验证并修复：判定链9处（决议日闪变/N3绕迟滞/stale边界×3/锁龄/僵尸override/宽松票全链齐备/断档迟滞）+ 基建13处（Resend错误语义/双实例角色/管理员种子/N3域名白名单/邮件顺序前移/mcp批量/IP塌缩等）+ 前端12处（双护栏hints×7语言/错误态×2/降档横幅/归因修正等）+ 回测口径5处
- [x] 全量 556 测试通过；完整报告 docs/systematic-review-2026-07-30.md
- [x] 开工时无未部署遗漏（working tree clean 且与 origin 同步）；本轮改动已推送部署

## 复盘（追加6）

**"防护机制在组合边界上反噬规则本身"是一族缺陷**：stale-keep 盖掉 N3、override 重置锁龄、
迟滞时钟跨断档累计、佐证门槛由同一 LLM 输出自证——每条单看都是好机制，两两组合的边界没人看过。
以后新增任何防护机制，评审清单里加一问：它与已有的每个机制在故障日叠加时谁赢？

**邮件库的失败语义必须实测不能靠假设**：Resend SDK 从不 reject，三套精心设计的重试/升级链路
全是死代码，单测还全绿（mock 按想象的 reject 语义写）。教训：对外部 SDK 的错误路径，
先读一遍它的源码再写错误处理；mock 语义要对着真实 SDK 校准。


## 116b号（2026-07-30 三条建议+待议项全部执行，用户拍板）

- [x] 信用利差进攻否决：+60bp/90日阈值（1990年起分布P96实证）；只否决attack不触发防守；cron/payload/前端清单/7语言/SKILL/README全同步；9条新单测
- [x] 回测置信区间：块自助（12月块×10000次），策略−买持年化差90%区间[−0.39,+8.65]pp、P(优势>0)≈93%；复现守卫+报告/SKILL入档
- [x] 对外数字单一来源化：tests/doc-numbers.test.js 把 SKILL/报告数字与引擎json逐一对比，漂移即红灯
- [x] T+1执行敏感性实测：T+1年化12.82% vs T+0 12.13%——头条口径反而保守0.7pp，写入报告局限
- [x] 趋势门价格口径统一（用户单独授权）：复权价源优先，与回测口径对齐
- [x] computeLocks抽出api/locks.js + 8场景漂移测试（线上vs回放镜像逐位对比）
- [x] REPLAY_END自动滚动到最近收官月（防日/月对照错窗）
- [x] 备份AES-256-GCM加密（本机.env已生成钥匙；**用户待办：同钥配到Railway+密码管理器留底**）
- [x] API key哈希化（sha256+前缀展示；存量key与usage底账启动迁移自动脱敏，已冒烟验证）
- [x] JWT吊销（POST /api/auth/logout-all）+ 一键退订（List-Unsubscribe RFC 8058 + /api/unsubscribe）
- [x] Railway已加ADMIN_PASSWORD（用户完成）；574测试全过；全端部署


## 116c号（2026-07-30 收尾批次）

- [x] 月度回测漂移测试：replayMonth vs 线上calc*逐位对比（货币20组合/财政10点/行政48组合），漂移即红灯——第四节承诺清单至此全部清零
- [x] 管理面板补"清除覆盖(回自动)"与"撤销清锁覆盖"按钮（后端auto哨兵此前无界面入口），7语言
- [x] openapi.yaml：进攻档双否决器/降档迟滞/staleFlags(含monetary) 补档
- [x] Railway已加BACKUP_ENCRYPTION_KEY（用户完成）——备份加密全端启用，无剩余用户待办
- [x] 578测试全过，推送部署


## 117号（2026-07-31 Q2检查点提前执行 + AMZN档修正 + 暂定档复检机制）

- [x] AMZN 7/30盘后：Q2现金capex $53.1B/+64.9%；全年指引上修~$200B→~$220B（内存/硬件通胀+AI需求）；AWS backlog $4960亿；2028算力部分预锁
- [x] 四家出齐：Q2合计$164.9B/+87.0%——突破$158.8B"继续加速"锚点，连续第三季加速(+64.0→+80.5→+87.0%)；META"第一个减速者"预测被证伪
- [x] 护栏首战复盘：时间护栏拦住了预览稿类污染，但AMZN档中了新变体"旧指引回声"（两实例分别记consensus推算/旧计划maintained）——N3安全性未破（maintain/raise不触发下修）
- [x] 三层修复：117号启动自愈补丁（两实例定点修正+manual_verified定档）/ 暂定档48小时复检机制（web源每日重检自动纠正，press_release与人工定档豁免）/ prompt加"maintain须本次重申，否则none次日重试"
- [x] 文档归档（Q2结果表/规则文档/SKILL）；579测试全过；推送部署
- [ ] 8/8检查点：EDGAR四家10-Q/10-K落齐后共同季翻新2026Q2、N1/N2首次实战翻新、填系统口径行


## 118号（2026-07-31 快照补更新，用户口称115号）

- [x] 审视修正：用户提议"每次打开就刷新"改为"过点未更新才补跑"——提前跑会生成数据不完整的早产快照污染track record（美东21:00是有意设计）
- [x] utils/catch-up.js：期望快照日期（ET 21:45分界）+ 触发/30分钟冷却/互斥控制器（11条单测）
- [x] 双触发源：每小时看门狗cron（用户没打开页面也自愈——顺带修复"21:00失败要等次日才重试"的旧缺口）+ /api/signal与/v1/signal访问触发
- [x] 前端：catchUp横幅（7语言）+ 30秒轮询x10次，新快照落库自动刷新
- [x] README可信度工程第⑤层/SKILL/openapi归档；590测试全过；推送部署
