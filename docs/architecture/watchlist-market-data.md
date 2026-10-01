# 自选列表与公开现货行情

自选列表持久化在 `tvchart.watchlists.v1`，每个列表单独保存符号顺序；行情报价不进入持久化文档。支持 12 个列表、每组 100 个品种、50 步撤销和跨页面同步。收到有效的其他页面更新后清空本页撤销记录，以免撤销覆盖远端编辑。损坏记录不会在载入时被默认值覆盖。

品种目录和报价均来自 Binance 现货公开接口，不使用账户密钥。

| 用途 | 默认官方入口 |
| --- | --- |
| REST 品种目录、24 小时报价、K 线 | `https://data-api.binance.vision` |
| Ticker / K 线实时流 | `wss://data-stream.binance.vision:443` |

Binance 的 [Market Data Only URLs](https://developers.binance.com/en/docs/products/spot/faqs/market_data_only) 明确列出上述域名：REST 支持 `/api/v3/exchangeInfo`、`/api/v3/ticker/24hr`、`/api/v3/klines` 等公开接口；WebSocket 支持相同的公开行情流。它们是 Binance 官方行情入口，无需认证，不提供用户数据流。`BinanceFeed` 仍允许通过 `restBase` / `wsBase` 显式覆盖默认值。

目录请求筛选 `permissions=SPOT` 与 `symbolStatus=TRADING`，响应再校验 `isSpotTradingAllowed`。合法符号支持 Unicode 字母和数字（交易所实际包含中文资产名称）；`BTCUSDT.P`、`BTCUSDT-PERP`、`BTCUSDT-SWAP` 等合约写法会被拒绝，`PERPUSDT` 作为现货代币符号可正常使用。格式合法不代表已经上架，UI 添加入口应使用公开目录确认品种。

24 小时报价是滚动窗口，不是 UTC 当日统计。REST 按每 20 个符号一批获取 FULL 字段，并每 30 秒补充刷新；Combined WebSocket 使用 `<symbol>@ticker`。过期判断使用原始交易所时间，超过 45 秒标为过期，网络失败保留最后已验证值及原时间。切换列表会取消旧请求、关闭旧连接，并用代际检查拒绝迟到结果；断流会退避重连并启用 REST 刷新。空列表不请求全市场行情。

2026-09-07 本机只读连通性验证：官方行情域名返回 1,362 个 TRADING 现货品种，BTCUSDT / ETHUSDT / SOLUSDT 的 24 小时报价有效，BTCUSDT 1m K 线有效，WebSocket 收到真实 `24hrTicker`。原 `api.binance.com` 与 `stream.binance.com:9443` 在同机 5 秒测试中超时，因此默认直接使用官方行情域名。
