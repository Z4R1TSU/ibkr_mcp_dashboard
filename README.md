# IBKR MCP 持仓观察台

独立、单用户、只读的持仓看板。直接连接 IB 官方 MCP，不依赖 Codex 进程、Gateway、Flex 或 Schwab。没有交易接口，也没有内置账户或演示持仓。

## 这版能做什么

- 查看 IB 账户净值、现金、保证金、剩余流动性、持仓与未实现盈亏。
- 显示股票集中度、股票/期权盈亏贡献、空头期权到期日、行权资金需求与股票数量匹配。
- 独立采样 IB 行情，明确区分 REALTIME、DELAYED、FROZEN、FROZEN_DELAYED、无权限与未知状态。
- 本地累积净值快照；不把净值变化冒充 TWR/MWR 或当日收益。
- 本机免密访问、公网密码保护、加密 OAuth 存储、CSRF 防护、错误退避、旧快照保留、浏览器自动接收更新。

**不是逐笔实时终端。** 默认每轮完成后等待 60 秒再拉取账户；每轮额外采样 4 个 USD 股票/股票期权，按最久未更新优先。16 个标的至少需要 4 轮，加上网络时间。可调整 `QUOTE_BATCH_SIZE`，但更多调用会延长轮次，不能承诺 IB 源数据同步刷新。

## 本地启动

需要 Node.js 24 或更高版本。此工作区的实际 `.env` 已将账户状态放在项目之外的私有目录，不要覆盖它，也不要公开该目录。

全新安装：

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

访问 `http://127.0.0.1:8048`，**直接进入看板，无需输入看板密码**。本地示例配置启用 `ACCESS_MODE=local`；会话过期或服务重启后自动恢复，不会要求重新输入密码。页面隐藏密码设置和退出登录入口，并标注「本机免密」。

`localhost:8048` 也可打开，首页会自动跳转到配置的标准本机地址，以保持 OAuth 回调和 Cookie 一致。没有 IB 授权时，仍需点「连接 IB」完成 `mcp.read` 授权；本机免密不等于绕过 IB 身份验证。

共享电脑需要密码保护时，可设 `ACCESS_MODE=password`，重启服务后在同目录运行 `npm run show-login` 查看初始密码。没有配置 `ACCESS_MODE` 时也保持密码模式。公网 Compose 配置明确固定为密码模式。

已有运行环境：`npm run build && npm start`。`npm run dev` 会先构建前端再监视后端；改动前端后需重新构建，不提供 Vite 热更新。

## 授权如何工作

1. 服务向 IB OAuth 发现与动态注册端点请求独立客户端。
2. 浏览器跳转 IB 官方授权页，只请求 `mcp.read`。
3. 回调绑定当前看板会话（本机自动建立，公网经密码登录建立），并检查 state、PKCE。
4. access token、refresh token、客户端元数据保存在 AES-256-GCM 加密文件中。
5. SDK 在需要时尝试刷新令牌；撤权、失效、地区不可用等情况仍可能需要人工重新授权。**没有保证永久免登录。**

当前机器已用现有只读授权验证过真实读取；服务器的独立 OAuth 回调需要在实际 HTTPS 域名上完成一次联调。不要复制本机令牌到仓库，也不要让多个服务共用、竞争轮换同一个 refresh token。开发环境可以显式使用 `npm run import-codex -- '<已核实的钥匙串条目>'` 导入，但不推荐把该方式作为服务器长期方案。

MCP 固定地址：`https://api.ibkr.com/v1/api/mcp-public`。允许的工具在 `server/ibkr.ts` 中列明；前端无法指定任意 MCP 工具，也没有下单路由。

## 服务器部署

这份代码**尚未部署到你的服务器**。服务器常驻运行后，飞书机器人处理消息不再依赖 Mac 是否开机或休眠；上传 GitHub 本身不提供运行服务。保持只读边界，不启用任何下单能力。

### 完整持仓助手：飞书 + TradingAgents

当前完整助手的迁移路径是 Linux 上的 Node.js 24+、Python 3.11+ 和 [lark-cli](https://github.com/larksuite/cli)。现有 Docker 镜像只包含看板，**没有 lark-cli、Python 研究环境或完整助手的环境变量配置**，不能仅运行下文 Compose 命令就获得飞书研究能力。

```bash
git clone https://github.com/Z4R1TSU/ibkr_mcp_dashboard.git
cd ibkr_mcp_dashboard
npm ci
cp .env.example .env
```

迁移前逐项完成：

1. 在服务器私下配置 `.env`，保持权限 0600；公网看板使用 `ACCESS_MODE=password`、可信 HTTPS 的 `PUBLIC_URL` 和私有持久化 `DATA_DIR`。用 HTTPS 反向代理连接仅监听本机的应用端口，不把默认的本机免密模式暴露到公网。
2. 在运行服务的专用系统用户下安装并配置 lark-cli，连接**已有的持仓助手应用**，使用同名或新的独立 profile，并设置 `FEISHU_ENABLED=true`、`FEISHU_PROFILE`、`FEISHU_CLI_PATH` 和对应应用的 `FEISHU_BOT_OPEN_ID`。不要为了迁移新建另一只机器人。已注册的 `/research` 属于飞书应用，无需随服务器重建。
3. 单独配置原有 `MODEL_PROVIDER / MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME`，确认服务器可以访问该模型网关。尤其是 AIDP 模式，不能仅凭 Mac 上可用就认定服务器网络和授权也可用；不要擅自更换模型。
4. 安装 Python 3.11+ 后运行 `npm run research:setup`，再运行 `npm run build`。用运行服务的同一系统用户安装研究环境，确保研究子进程能够访问它。
5. 在服务器重新完成 IB 的独立只读授权，并在管理员私聊重新绑定助手。IB 令牌、模型密钥、飞书 CLI 配置、持仓缓存、研究报告和聊天记忆均不通过 Git 迁移；不要复制整份状态让两台机器争用同一 refresh token。
6. 切换时先停止 Mac 上的旧实例，再让服务器实例接收同一机器人的消息。单个账户只运行一个服务进程，不共享状态目录、不启用多副本。用服务器的进程管理器保持 `npm start` 常驻并开机启动，不再使用 macOS 专用的 `npm run service:install`。
7. 先验证看板、飞书连接及 `/research help`，再手动验证一次研究；只有客户端收到帮助和研究报告，才算完整迁移完成。Discord Rich Presence 依赖本机 Discord 客户端，不会因上传代码而变成服务器端能力。

### 仅看板：Docker Compose

以下配置仅部署看板。需要 Docker Compose 及指向服务器的域名；只公开 HTTPS 反向代理，不公开应用的 8048 端口。

1. 仅上传本项目源代码与锁文件；排除 `.env`、`data/`、`node_modules/`、`dist/`，不上传工作区的私有状态。
2. 安装 Docker 与 Compose，配置 DNS，开放入站 80/443；SSH 仅对管理来源开放。
3. 创建服务配置并修改域名：

```bash
cp .env.server.example .env.server
docker compose --env-file .env.server up -d --build
docker compose --env-file .env.server exec app npm run show-login
```

4. 在浏览器访问配置的 HTTPS 域名，使用初始看板密码登录，立即改密码，再完成 IB 只读授权。
5. 检查页面的数据源时间、行情源状态，以及故障后的过期标识。浏览器关闭不影响服务器采集。

`PUBLIC_URL` 由域名自动生成，也是 OAuth 回调的基址。修改域名后需重新授权。若坚持直接使用公网 IP，需要为该 IP 配置浏览器信任的 TLS 证书，并对应修改代理与 `PUBLIC_URL`；不要把 HTTPS 换成明文 HTTP。也可先用 SSH 隧道私下验收，而不是提前暴露持仓页面。

部署配置已提供，但本机没有 Docker，**未执行镜像构建、公网 TLS 或服务器 OAuth 回调验证**。Caddy 默认配置不启用请求访问日志，避免记录授权回调查询参数；若以后启用日志，务必脱敏 `/auth/ibkr/callback`。

## 数据与金融口径

| 项目 | 口径 |
| --- | --- |
| 账户净值、现金、保证金 | 直接使用 IB 账户摘要；不以独立行情重估净值 |
| 持仓未实现盈亏 | 直接使用 IB 持仓接口；不是今日盈亏 |
| 账户未实现盈亏 | 使用 BASE 汇总行；不再加一次 USD 等币种行 |
| 集中度 | 正市值股票 / 账户净值；前三项同口径 |
| 构成图 | 各类持仓绝对市值 / 全部持仓绝对市值；不含现金，不是 Delta 敞口 |
| 期权识别 | 从 IB 描述的合约代码解析到期日、类型、执行价和明确的乘数；原始 asset_class 保留 |
| 卖 Put 金额 | 执行价 × 空头张数 × 乘数；未抵扣权利金、未考虑保护性组合，不是亏损或保证金 |
| Call 股票匹配 | 同标的同币种持股数量依到期日分配，避免重复覆盖；不代表券商认定的备兑 |
| 缺失值 | 保留 null，显示为 —；不填零、不生成假行情 |
| 多币种 | 保留原币种；没有验证 FX 口径前，跨币种合计暂停 |
| 报价 | 仅已知支持的 USD 股票/股票期权使用默认 SMART；其他资产不猜交易所 |
| 行情时间 | fetchedAt 仅为拉取时间；lastTradeAt 仅为 IB 返回的最近成交时间，标记价可能没有源时间 |

账户摘要、持仓、余额是分次调用，不是原子快照；差额独立显示，不为凑平强行归因。调整期权的交割资产需要另核实；本版不提供 Greeks、压力测试、分红现金流或税务计算。

## 安全和运行边界

- 本机免密模式只能绑定回环地址，要求本机 HTTP URL 与监听端口一致；公网地址、通配监听和端口不匹配会拒绝启动。
- 本机模式检查连接来源、Host、Origin、浏览器请求来源和代理转发头，拒绝外部站点及代理请求。本机用户或进程可以直接读取数据，不能用此模式保护共享电脑上的账户隐私。
- 不要通过隧道、改写 Host 或剥离转发头把免密端口公开；公网部署必须使用 `ACCESS_MODE=password`。部署环境继续使用 Secure、HttpOnly、SameSite Cookie。
- 本机账户读取与 SSE 自动建立会话；刷新及 IB 授权等 POST 仍需来源检查和 CSRF。密码模式保留登录限速及修改密码后的全会话撤销。
- 内部会话默认 8 小时：本机过期/重启会自动恢复，无密码操作；密码模式过期/重启仍需登录。这与 IB OAuth 独立，不改变或延长 IB 的授权有效期。
- 状态目录权限 0700，文件 0600。OAuth 文件加密，但密钥也在该目录；**不能抵御服务器/整目录被攻破**，需保护系统、磁盘和备份。
- 持仓缓存是私有明文 JSON，便于可靠恢复，不能作为静态文件发布。默认保留至多 1,440 个采集净值点且不超过 7 天。
- 收到失败不清空持仓，显示旧数据及错误；账户或报价失效不会被包装成“实时”。
- 当前只支持一个服务进程、一个账户授权、一个管理员，不要水平扩容共享状态目录。
- 飞书支持专用机器人私聊、日报和状态提醒；Schwab 数据源与自动交易不在本版范围。

## 飞书持仓助手

通过独立的 lark-cli profile 接收飞书长连接事件，凭据由 CLI 管理，不复制到应用源码。
运行环境需同时安装 Node.js 24+ 和 [lark-cli](https://github.com/larksuite/cli)。
本机已创建专用 profile：ibkr-portfolio，对应应用“持仓助手”。

1. 新环境运行 lark-cli config init --new --name ibkr-portfolio，按官方页面完成应用创建。
2. 配置 FEISHU_ENABLED=true、FEISHU_PROFILE=ibkr-portfolio。非交互启动时可把 FEISHU_CLI_PATH 设为可执行文件绝对路径。
3. 应用需要发送消息、接收私聊权限，并订阅 im.message.receive_v1。收件表情需要 im:message.reactions:write_only（或已具备覆盖该接口的 im:message 权限）。创建流程通常已配置；连接失败时检查飞书后台。
4. 启动服务，打开看板左下角“飞书与模型”。将显示的 15 分钟一次性绑定指令私聊发送给机器人。
5. 私聊仅处理绑定用户的消息；群聊按看板中的群和成员权限处理，必须真实 @ 机器人。机器人消息与过期事件会忽略。

| 命令 | 行为 |
| --- | --- |
| 帮助 / 测试 | 查看命令 |
| 看板 / 打开看板 / 查看账户看板 | 聊天内卡片：净值、现金、未实现盈亏、剩余流动性、持仓分布、净值轨迹 |
| 摘要 / 持仓 / 风险 / 到期 | 根据账户快照回答，带采集时间 |
| 今年换汇 / 换汇记录 | 查询本年货币交易，包含双向换汇、成交汇率和手续费原值 |
| 状态 / 模型状态 | 查看 IB、推送与模型状态 |
| 刷新 | 请求采集，30 秒限流 |
| 连接 IB | 返回看板入口 |
| 订阅日报北京时间 11:00 发送 / 取消日报 | 支持自然时间表述，保存订阅时区 |
| 开启提醒 / 关闭提醒 | 授权、数据过期与恢复提醒，默认关闭 |
| 推送一次 | 立即发送账户摘要 |
| 偏好 具体要求 / 查看偏好 / 清除偏好 | 持久化供模型参考的偏好 |

时区由 FEISHU_TIMEZONE 配置，默认 Asia/Shanghai。日报每 30 秒检查一次，停机后仅补发一小时内错过的当天日报；每天最多一次。状态不变时不重复提醒。消息 ID 和推送记录持久化，发送使用幂等键。

普通回复与日报使用飞书富文本（post），渲染 Markdown 的标题、加粗、列表和代码块。长回答优先按段落或换行分段，代码块跨消息时重新封闭。飞书富文本并非完整的网页 Markdown 渲染器。

通过权限、时效和去重检查的消息会立即收到“收到”（Get）表情，包括正在排队的消息。表情仅表示已接收；最终结果仍以回复为准。无权限消息、重复事件、未绑定时的无效指令不加表情。表情接口最多等待 5 秒，失败不阻止回答，原因显示在看板“飞书与模型”。

看板卡片可在手机和电脑的飞书聊天内查看，不需要公开本机服务。卡片展示发送时的快照，不自动更新；再次发送“看板”查看最新缓存，发送“刷新”重新采集。净值轨迹使用最近 180 个有效采集点，最多展示 60 点，保留首尾；持仓分布按股票、期权、其他的绝对市值统计，不含现金，跨币种或缺失市值时不画分布。快照时间、过期状态和本机网页访问限制会在卡片中说明。卡片发送失败时回退到账户摘要；群聊沿用原有权限与 @ 校验。Card 2.0 需要飞书客户端 7.20 或更高版本。

本机免密地址仅能在同一台电脑打开；手机接收消息不受影响。首次/失效的 IB 授权仍需在服务所在电脑的看板完成。服务器部署时改用可信 HTTPS 域名。

现有 Dockerfile 只打包看板，未包含 lark-cli。部署机器人时先使用安装了 lark-cli 的 Node 运行环境，并单独完成服务器端的飞书 profile 与 IB 授权配置；不要直接复制本机钥匙串。

### 日报内容与保存

日报仅私聊发送给绑定的账户管理员，不发到群。使用最近一场已完成的美股常规交易日：例如北京时间周二上午回顾周一美股，交易日按纽约时区及实际返回的交易日日线选择，不用北京时间自然日截断。日报包括相邻交易日账户净值差、官方 TWR 单日收益率、大盘 ETF 和当前持仓股票前五的价格表现、行情复盘。

金额按“净值变动口径”展示，同时用 TWR 检查明显不一致；出现差异时提示可能有入出金或其他调整，不把入金当成交易盈利。大盘用 SPY、QQQ、DIA、IWM 代表不同指数风格，分别展示较前收和常规时段开收盘涨跌。所有账户与行情数据只来自 IB MCP，不接 Flex、其他行情源或新闻源，不编写未经证实的新闻原因。

发送“日报”或“推送一次”可在私聊查看。看板“飞书与模型”提供预览；每个交易日的报告及计算数据保存到私有 DATA_DIR/daily-reports，文件权限 0600。同样的数据会复用报告，数据变化时重新生成。

### 群聊访问设置

以后启用新群：先在飞书群里添加“持仓助手”，再打开看板左下角“飞书与模型”，点击“刷新已加入的群”，选择权限后保存。无需重启服务。

每个群可设置“关闭群聊”“仅我可用”“全群成员可用”“指定成员可用”。指定成员可按姓名勾选，也可填写 open_id；账户管理员在已开启的群中始终可查询。成员列表需要 im:chat.members:read 权限；群 @ 事件需要 im:message.group_at_msg:readonly 权限。FEISHU_BOT_OPEN_ID 应填写这个应用的机器人 open_id，用于核验真实 @。

群聊只提供查询，订阅、偏好、绑定和 IB 授权仅在管理员私聊中管理。群内问答不附带管理员的私聊偏好。群配置保存在私有 feishu-bot.json；管理接口沿用看板会话和 CSRF 校验。

### 换汇与入金口径

询问平均换汇成本、与当前汇率相比赚亏多少时，程序先计算本年 CNH 买入 USD 的加权成本，再通过 USD.CNH 合约的 CASH/IDEALPRO 报价取得买卖中间价。合约必须唯一匹配，CFD 不参与；报价缓存 30 秒，仅使用标记为 REALTIME 或 DELAYED 的有效买卖价。报价缺失、冻结或状态未知时明确不计算当前百分比。

以 CNH 计价的纯汇率变化率为（当前 CNH/USD 汇率 ÷ 历史买入加权成本 − 1）×100%。这是本年买入价格的比较，不等于扣除所有反向换汇后的剩余美元成本，也不等于当前账户全部美元资产或账户总收益。结果不包含投资收益、利息和未确认的费用。程序计算结果会提供给模型解释；模型失败时仍返回这些已核实结果。

“今年换汇”读取 get_account_trades 的 YEAR_TO_DATE 响应，按交易 ID 去重并按时间列出全部返回的 CASH 记录，缓存 5 分钟。时间显示为北京时间，查询年度边界按 IB 的 UTC 口径。CNH↔USD 分开汇总买入、卖出及相抵净额，不能当成入金总额；手续费币种未提供时不猜测或扣减。当前 MCP 没有入出金流水，累计入金本金仍需 IB 账单核对。自由问答提及换汇/入金/出金/汇率时会补充这些历史数据。

### 模型接入配置

MODEL_PROVIDER 默认为 chat-completions。本机目前使用 aidp，模型为 gpt-5.6-sol。
在 aidp 模式下，MODEL_BASE_URL 填完整地址 https://aidp.bytedance.net/api/modelhub/online/v2/crawl（不含查询参数），MODEL_API_KEY 单独保存密钥。
请求时自动将密钥编码为 ak 参数，生成 X-TT-LOGID，并按 AIDP 格式发送文本数组；不追加 /chat/completions，也不发送 Bearer 认证或 store 字段。
MODEL_MAX_TOKENS 控制 AIDP 推理与回答的合计额度，当前设为 32768。示例中的 500 对分析问题可能全部耗在推理上而没有正文；遇到额度耗尽、空回答或格式错误会分别记录原因，并返回已核实的数据，不把推理内容当答案。
可运行 node --import tsx scripts/probe-model.ts 测试简单问答，或添加 --portfolio-fixture 使用虚构账户验证完整流程。测试不发送真实持仓或飞书消息，也不打印密钥。

为 TradingAgents 接入验证模型协议，可运行 `node --import tsx scripts/probe-trading-model.ts`。它复用当前 MODEL 配置，最多发送 3 次模型请求，检查原生工具调用、工具结果回传和 JSON Schema 输出；会消耗模型额度，但只发送虚构测试数据，不访问 IB 账户、不发送飞书消息、不启动研究任务。协议测试通过不等于 TradingAgents 已完成接入。

以下说明适用于默认的 chat-completions 模式：

在本机 .env 中填写 MODEL_BASE_URL、MODEL_API_KEY、MODEL_NAME，重启服务即可启用。BASE_URL 是包含 /v1 等路径的 API 基址，程序追加 /chat/completions。例如供应商给出的完整地址是 https://your-provider.example/v1/chat/completions，则填写 https://your-provider.example/v1。

采用 [Chat Completions 请求/响应格式](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)，使用 model、messages、stream=false、store=false，读取 choices[0].message.content。供应商需兼容这些字段。MODEL_TIMEOUT_SECONDS 默认 300 秒。远程接口要求 HTTPS；允许回环 HTTP 连接本地模型，若本地模型忽略 API Key，可填任意非空占位值。

未配置模型时，自由问答提示待配置；账户命令和主动推送照常可用。配置模型后，自由问答和日报复盘会向指定接口发送所需账户事实，不发送 IB 令牌或飞书凭据。模型不执行交易。MEMORY_ENABLED=true 时，保留最多 20 轮对话，并限制每个会话历史为 200000 字符；超长时移除更早轮次。私聊与各群分别保存，群内不带私聊偏好。聊天记录在本机加密保存，可用“清空上下文”清除当前会话。群聊清空仅限账户管理员。

绑定与推送设置保存在私有 DATA_DIR/feishu-bot.json（0600），一次性绑定指令在未绑定期间保存在 feishu-pairing.txt（0600）。不要把私有状态目录公开或加入仓库。

## TradingAgents 只读研究

固定命令是 `/research`，**不是依赖“深度研究”关键词的隐式触发**。在管理员私聊发送 `/research AAPL`，或在已授权群聊中 @ 持仓助手后发送同一命令。普通自然语言问题仍使用原有问答，不会悄悄启动多轮研究。

| 命令 | 行为 |
| --- | --- |
| `/research AAPL` | 使用原版 TradingAgents 后台研究指定股票；股票代码不要求已持有 |
| `/research status` | 查看当前聊天最近一次研究的状态、阶段与模型调用数 |
| `/research report` | 最近一次研究完成后，获取完整中文报告 |
| `/research cancel` | 由发起人或账户管理员停止当前聊天的研究 |
| `/research` 或 `/research help` | 查看帮助 |

### 飞书原生斜杠指令面板

原生 Slash Command 注册与消息处理是两层能力：注册让 `/research` 出现在机器人单聊输入 `/` 后的候选面板中；研究仍使用上述固定命令和原有权限检查。只注册 `research` 一个根指令，股票代码及 `help / status / report / cancel` 是后续参数，不单独注册带空格的指令。

按[飞书官方接入说明](https://open.larkoffice.com/document/mcp_open_tools/agent-best-practices/agent-supports-slash-commands)，应用需要 `application:app_slash_command:read` 和 `application:app_slash_command:write` 权限；新增权限后需发布应用版本。以下命令仅用于维护当前机器人的指令面板，不应由模型调用，也不在每次服务启动时自动执行。将 `ibkr-portfolio` 换成实际 `FEISHU_PROFILE`。

```bash
lark-cli --profile ibkr-portfolio application +slash-command-list --as bot
```

仅在列表中不存在 `research` 时创建；已有指令时保留其 `command_id`，不要删除重建或覆盖其他指令：

```bash
lark-cli --profile ibkr-portfolio application +slash-command-create --as bot \
  --command research \
  --description 'TradingAgents 只读研究：输入股票代码（如 AAPL）；输入 help 查看用法。绝不下单。'
lark-cli --profile ibkr-portfolio application +slash-command-list --as bot
```

客户端要求 PC 7.70+、移动端 7.71+；注册后先等待约 5 分钟，叠加客户端缓存最长可能约 8 分钟。在与持仓助手的管理员单聊中输入 `/`，选择 `research`，追加 `help` 并发送；应返回命令帮助，不启动研究、不调用模型。通过后再输入 `/research AAPL`。指令列表查询成功和模拟文本消息测试均不能替代这一步客户端端到端验收；若点击面板后的消息没有被处理，应检查实际消息类型和内容，而不是放宽账户或群聊权限。

### 只读约束与运行配置

**绝不下单。** 只调用公开研究数据工具，工具名称使用白名单；研究子进程不接收 IB、飞书或真实模型密钥，也没有订单、撤单、转账、Shell 或 MCP 工具。TradingAgents 的 Trader / Portfolio Manager 节点只生成研究文本；报告中的 Buy / Sell、价格和仓位都是研究方案，不会执行。既有 IB 只读接口没有变动。

四类分析师（技术面、基本面、新闻、市场情绪）、多空研究、研究汇总及风险讨论均运行原版 Python 工作流。快慢模型都绑定到持仓助手同一组 `MODEL_PROVIDER / MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME`，不会另选模型或要求第二份模型密钥。AIDP 协议由仅监听回环地址、每任务随机令牌保护的桥接转换；固定使用 Chat Completions，避免 SDK 按模型名称自动改走 Responses API。

研究启动时仅复制所需账户事实，不刷新或修改账户；没有快照仍可研究公开标的，未知数量或金额不会变为零，期权保留合约字段，过期快照在报告中注明。公开数据使用上游默认数据源；无密钥或不可达的数据源可能缺失，不能将缺失解释为“没有风险”。研究日期使用纽约日期；不是历史回测。

研究独立于普通聊天队列，每次只执行一个任务，不定时运行、不自动重跑。群聊沿用现有 @ 与成员权限，结果返回原聊天前再次检查权限；私聊与各群的报告和研究记忆相互隔离。默认总时限 1800 秒、模型请求上限 100 次；每次模型调用仍使用现有超时和 token 上限。模型请求串行发送；遇到 HTTP 429 最多等待重试 3 次，遵循不超过 120 秒的 Retry-After，否则使用 15/30/60 秒退避；过长的 Retry-After 直接报告限流，不提前重试。重试也计入总请求预算，取消会中止等待。达到限制会明确失败或停止，不把部分输出当完整报告。服务重启后不恢复未完成任务，以免重复消耗模型额度。

首次安装（本机服务，Python 3.11+）：

```bash
npm run research:setup
npm run build
```

安装使用项目独立 `.venv-tradingagents`，固定上游提交 `8b22d43d01d9ddda5d686d093d5385884622f3de`（0.5.2）并校验源码归档哈希，不修改系统 Python。部署时重启现有看板服务；研究命令默认开启，但只有收到固定命令才调用模型。可用 `TRADINGAGENTS_ENABLED=false` 关闭，`TRADINGAGENTS_PYTHON` 指定兼容的独立解释器，`TRADINGAGENTS_TIMEOUT_SECONDS` 与 `TRADINGAGENTS_MAX_CALLS` 调整总预算。现有精简 Docker 镜像未内置 Python 研究环境，不能仅设置开关就使用此功能。

完整报告、工作流产物与最近任务状态保存在私有 `DATA_DIR/research`；目录 0700、任务文件 0600。报告包含账户事实，不应公开该目录。`node --import tsx scripts/probe-tradingagents.ts AAPL` 可用当前模型跑完整公开标的联调，**会产生多次模型请求**，但不读取真实持仓、不发飞书消息；结果写入临时目录。普通离线测试不会自动调用真实模型。

## Discord 动态活动卡片

看板左下角打开“Discord 动态状态”。创建自己的 [Discord Application](https://discord.com/developers/applications)，在 General Information 中复制 Application ID，填入看板并设置入市日期。点击“刷新预览”核对内容，再开启同步并保存。本机 Discord 桌面端需要运行并已登录，Discord 的活动分享设置需要允许展示。

活动展示账户净值、入市天数、累计 TWR 和上一美股交易日 TWR。累计收益从配置的入市日期开始，使用 IB 累计收益序列按几何比例换算，不能用入出金或持仓未实现盈亏替代。入市天数按北京时间自然日期之差计算，起始日为 0 天。净值使用账户基准币种；不会把非美元账户标成 USD。缺失收益显示“—”，预览中说明原因。

同步最多每分钟更新一次变化内容，收益数据每 5 分钟刷新；每 10 秒检查连接和账户新鲜度。Discord 重启后会自动重连；账户过期时显示带采集时间的灰色旧快照，无快照时显示灰色等待卡片。关闭同步或服务退出会清除本应用活动，Mac 离线后本地 Rich Presence 也会消失。同步状态仅表示 Discord RPC 确认，其他人是否可见取决于 Discord 的活动分享设置，无法限制到单个文字频道。

后续迁移时，`PresenceData` 负责数据汇总，`DiscordBridge` 只负责本机 RPC。受现有登录保护的 `GET /api/discord/summary` 提供四项汇总及日期，不包含持仓明细。当前版本在同一进程运行；迁移时让 Mac 同步程序经私网读取服务器摘要，保留 Discord 桌面端在 Mac。远程访问需独立配置鉴权与 HTTPS，不能暴露本机免密接口。

## 本金与本地业绩历史

Discord 设置可保存已确认的 USD 投入本金及确认日期。配置后“总”按（当前账户净值 − USD 投入本金）÷ USD 投入本金计算，不再依赖 IB 的历史累计收益接口；它不是 TWR。新入出金后需要更新本金。换汇买入总额不能直接视作本金，必须扣除反向换汇并核对其他资金进出。未配置本金时仍显示历史累计 TWR。

业绩采集独立于 Discord 开关运行。`DATA_DIR/performance-history.json` 按账户、日期保存净值、前一日期和单日 TWR，原子写入、权限 0600；首次会恢复本目录已有日报中的有效数据。IB 返回较旧日期不会删除较新的本地记录，后续完整修订会更新对应日期。`pa-performance-latest.json` 保存最近一次原始响应以便核对。

“今日净值变动”使用 IB 当前净值与本地上一交易日收盘净值比较。存在当日入出金时，净值差不等于投资盈亏；上一交易日 TWR 单独展示。收益日期和来源均保留，不用缺失值覆盖已知历史。

## macOS 登录自启

构建完成并停止手动启动的服务后，运行 `npm run service:install`。安装器配置 `local.ibkr-mcp-dashboard` 登录启动项，验证健康接口后才报告成功；启动失败会停用该启动项。服务由 launchd 管理，异常退出后重启，运行日志位于 `~/Library/Logs/IBKRDashboard`。日志不能放在受 macOS 后台访问限制的 Documents 目录。登录自启不能让本地 RPC 在 Mac 关机后继续运行。

## 服务器专属离线快照

可将带日期的短摘要手动保存在 Discord 的服务器专属人称代词栏。它由 Discord 保存，在线活动关闭或 Mac 离线后仍保留，且不会更改主要个人资料。此方式不是自动更新接口，必须同时更新日期和数值；例如 `M/D·N天·USD金额·总收益率·昨收益率`。现有 Rich Presence 可在看板中单独启停。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

测试覆盖期权识别、BASE 去重、跨币种与缺失字段、空头符号、重复覆盖、源时间和抓取时间区分、加密落盘、只读白名单、鉴权、CSRF、授权回调与退出失效。真实 IB 请求仅在运行服务/诊断脚本时进行，单元测试不连接账户。

健康检查 `GET /api/health` 只表示进程在线，不表示 IB 数据新鲜。`GET /api/portfolio` 可查看账户采集状态：本机模式允许直接访问，密码模式需要先登录；不要在公共监控中暴露该响应。

### 本机免密更新（2026-09-26）

- 21 项自动测试、TypeScript 检查及生产构建通过。
- 新增测试覆盖无密码进入、CSRF 保留、重启后自动建立新会话、本机地址兼容、外部 Host/Origin/连接来源/代理请求拦截及公网模式不变。
- 自动会话更新不导出、不清除、不重新申请已有 IB 只读授权。

### 本次验收记录（2026-09-25）

- TypeScript 类型检查、前后端生产构建通过；18 项自动测试全部通过。
- 本机服务已验证真实 IB 持仓、独立行情、连续自动刷新、重启后历史恢复、手动刷新及 SSE 数据传递。
- 已验证未登录读取被拒绝，登录后可以读取，响应不含 OAuth 凭据，私有状态目录及文件权限正确。
- 当前浏览器控制工具不可用，未完成交互式视觉验收；没有将 HTML/JS 返回成功当成浏览器视觉验收。
- 当前机器没有 Docker，未实际构建容器，也未部署公网、验证服务器 TLS 或服务器上的独立 OAuth 回调。
