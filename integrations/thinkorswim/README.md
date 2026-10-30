# thinkorswim 只读行情

独立常驻采集器，使用正常网页登录获得的实盘 wsjson 会话。无需嘉信开发者账户。
账户、成本、保证金和盈亏仍来自 IB；本模块只查询行情。

已审查 Aloento/ThinkorSwim-API 的源码和 TECHNICAL.md，固定参考提交
83e4e3966a5208e74c418ed505e059629a07f0ef（0.13.1）。
采用握手、认证、行情参数和 RFC6902 增量协议；不安装完整交易客户端，不运行其冒烟、下单、写操作脚本。
实现自己的强制发送白名单。上游 Authenticator 产生的 EAT 不是 wsjson 会话 token，未照搬该续期路径。

## 部署

本机复用 .runtime/node 的 Node 24、.venv-tradingagents 的 Python 3.13 和固定 Python 依赖。
登录使用 playwright-core 1.64.0、现有 Chromium 1248 和受 Xauthority 保护的 Xvfb。
本机图形库位于 .runtime/tos-browser-libs 和 .runtime/tos-xvfb/root；系统安装了 x11-xkb-utils。
新服务器应安装 Chromium/Xvfb 所需库，并执行本目录 npm ci --ignore-scripts，
使用 playwright-core 的安装器准备匹配的 Chromium。不要依赖 /tmp 中的文件。

在项目根目录用 Node 24 执行 scripts/install-thinkorswim.mjs --dry-run 查看单元，
去掉 --dry-run 安装两个用户级 systemd 服务：

- thinkorswim-market.service：127.0.0.1:8051，行情缓存与只读 API。
- thinkorswim-login.service：127.0.0.1:8052，只接受看板的内部认证请求。

沿用已开启的 systemd 用户 linger。进程异常自动重启；授权失效保留旧缓存并明确标记 login_required。

## 登录与存储

打开现有 HTTPS 看板的 /tos-login/，或从“飞书与模型”进入“连接 thinkorswim 行情”。
默认使用轻量表单，一次提交账号与密码，由服务器浏览器填写嘉信原生页面。
双重验证显示手机批准或短信验证码步骤；是否信任设备由用户选择。
只有主动展开特殊验证的原生页面时才传截图，不逐键上传普通表单输入。
登录窗口限定同一个看板会话控制，30 分钟超时关闭。截图只在内存中传给用户浏览器，不保存或发给模型。

data/thinkorswim 为 0700，session.json、内部读取密钥为 0600，浏览器配置使用 0077 umask。
不记录 HTTP 输入、浏览器控制台、原始认证帧或 Token。没有保存账户密码的配置项。
模型只接收研究用 OHLCV，不接收 Schwab session token、Cookie 或 refresh token。
会话 token 到期后需重新打开正常登录流程；不承诺无人值守无限续期。

## 本地 API

除 /health 外均要求 Authorization: Bearer 加 data/thinkorswim/api-key.json 中的本地 key。
该 key 与券商 token 独立，不要粘贴到聊天。接口拒绝跨来源浏览器请求和非本机 Host。

| GET 路径 | 内容 |
| --- | --- |
| /v1/status | 连接、授权状态、数据项状态和帧计数 |
| /v1/quotes | AAPL、SPY 最新合并报价，含延迟标记及返回字段 |
| /v1/quotes?snapshot=1 | 最近一次 quotes/get 快照 |
| /v1/events | SSE 行情推送；断线后客户端应重连 |
| /v1/history?symbol=AAPL&asOf=2026-10-16 | 已结束的常规时段日线及口径元数据 |
| /v1/options | SPY 单个标准到期系列、最多 10 档执行价及报价 |

报价订阅自动覆盖当前 USD 股票、可匹配的标准股票期权及大盘 ETF。历史订阅覆盖持仓和基准，研究可按需请求其他字母代码的美股。
默认请求 YEAR5，实际长度以 count 和最早日期为准。无法匹配的资产继续使用原来源。
默认选择下一可交易日期的标准 SPY 合约，跳过当日到期；可配置 TOS_OPTION_EXPIRY。
receivedAt 是接收时间，sourceTime 缺失时保持 null。实际持仓通过 holdingGreeks 缓存提供 Delta。标准合约须精确匹配，且本次连接的 DELTA 字段尺度已通过标准 Call/Put 样本核验，再检查本合约 Delta 的符号与范围后才标记 per-share-feed-v1；否则保持 unverified。仅 Delta 获得此核验，不代表其他 Greeks 已核验。
未提供历史期权行情或 IV Rank。

## 研究接入及验收

默认 MARKET_DATA_PRIMARY=thinkorswim，独立报价、日报日线优先嘉信，不可用时使用 IB。
研究默认 TRADINGAGENTS_MARKET_VENDOR=thinkorswim，失败或样本不足时使用 TRADINGAGENTS_MARKET_FALLBACK（原配置，本机为 yfinance）。
日线默认口径 unknown，采集器与 Yahoo 同期 OHLCV 比对，检查日期覆盖、价格尺度和成交量；通过才标记 split 或 split_dividend，并保存核验记录。
校验失败保持 unknown，业务自动回退。日报仅使用拆股复权、未作分红复权的嘉信日线。
研究报告和网页逐项注明实际来源与回退原因，授权失效不阻塞原来源。
不会拼接不同来源、不同复权口径的日线。

使用 .venv-tradingagents/bin/python -I scripts/check-thinkorswim.py 查看安全摘要。
摘要仅含连接状态、实时报价标志、字段、历史条数和期权范围，不打印密钥。
登录后实际验收：

1. AAPL、SPY 快照与推送，isDelayed 是否明确为 false。
2. 日线起止日期、至少 200 根有效样本、交易日和时区。
3. 拆股和除息前后的价格与成交量，确认后才切换研究。
4. SPY 单个到期系列、受限执行价范围，核对 bid/ask、IV、Delta、成交量与持仓量。
5. 断线重连、订阅恢复、授权失效提示和重启恢复。

离线测试：npm run tos:test；研究回归：npm run research:test。

研究即时查询使用鉴权的本机 GET /v1/quote?symbol=GOOG，主动调用 quotes/get，支持未持有、未订阅的美股。请求使用快照接口支持的 BID、ASK、LAST、LAST_RTH、VOLUME；MARK 不在该请求字段列表中。最多 8 个待处理标的、2 个并发读取，相同标的合并请求。新响应不拼接旧推送字段，接收时间不冒充成交时间；断线、超时或无数据返回 503，调用方尝试 IB 备用报价。

## Delta 风险核验

Delta 是每股期权价格对正股价格的导数；先乘带符号张数和合约乘数，再乘正股现价得到金额敞口。
适配器不转换百分数。每次连接用标准合约样本确认同一 DELTA 字段的尺度：Call ∈ [0,1]、Put ∈ [-1,0]，且配对差在 [0.9,1.1]；保存样本依据。尺度核验在本次连接内共享，每个持仓仍独立检查标准合约、Delta 符号、范围和时间。Call/Put 可以使用不同 IV，配对差不能作为每份合约的有效性要求。重连清空核验状态。
2026-10-23 实际 APP、NBIS、ORCL 等持仓提供了尺度核验样本；缺失 Delta 仍保留为空。
字段时间只由该字段的快照或显式 patch 更新，心跳不延长 Delta 有效期。重连重新订阅；离线缓存不能标记为当前行情。
运行 `.venv-tradingagents/bin/python -I scripts/check-delta-risk.py` 可只读抽查最多 20 份持仓合约，不输出账户数值或凭据。

持仓 Greeks 订阅每 60 秒重新获取有界快照，主动确认数值未变的 Delta；替换订阅会清理旧订阅和 patch 基础。只有实际返回该字段才更新时间，失败时不续期，也不将源行情时间改成接收时间。

续订会等待替代订阅实际返回持仓 Delta 后再关闭旧订阅；初始空包、超时或失败不清除上一条有效记录，也不延长它的时间。风险页面将失败刷新与上次完整快照分开呈现。

登录浏览器保留官网原始网络行为：不使用 HTTP 路由拦截、WebSocket 过滤或请求改写，不禁用 Service Worker。通过被动的 WebSocket 接收事件识别登录成功，保存会话后立即结束登录窗口。独立行情采集器仍强制执行只读服务白名单。

登录状态保留最近 20 条认证请求的方法、来源、无查询参数的路径和状态码，不保留请求体、凭据、请求头或响应内容。原生浏览器支持登录弹出页；界面保留提交错误，支持密码管理器，同时出现账号和密码框时填齐后提交。

登录窗口使用普通 Chromium 进程启动，再附加画面和输入控制，不使用 Playwright 的测试启动参数。调试连接仅绑定随机回环端口，登录结束、取消或超时即关闭浏览器与端口；用于受信任的个人服务器。使用独立的 chromium-native-profile 私有目录，保留旧资料目录。当前普通启动支持直连或无认证代理；验证码、密码仍由用户正常输入。
