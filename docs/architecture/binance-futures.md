# Binance USDT 永续：公开行情与历史数据

当前 Binance 路径默认打开 BTCUSDT USDT 本位永续合约、15 分钟图表。图表、历史行情、订单流与形态分析使用公开接口，**不需要交易所 API Key**。Pine 执行与策略回测模块、只供其使用的账户手续费/杠杆档位签名接口已经移除。

## 市场与公开数据

合约目录从公开 `exchangeInfo` 中筛选 `status=TRADING`、`contractType=PERPETUAL`、`quoteAsset=USDT`、`marginAsset=USDT`，并要求具有实现需要的价格、数量和最小名义金额规则。最小报价与数量步长来自 filters，不按 precision 字段推算。

- 实时与历史价格来自 Binance USDⓈ-M 永续 K 线；自选报价使用同一市场。
- 日期范围历史仍读取按 K 线时间对齐的公开标记价格，保留明确的行情来源与数据集指纹。
- 盘口、成交与深度热图使用公开 aggTrade 与 L2 数据。未采集或未录制的区间保持缺口，不从 OHLCV 推算历史盘口。
- 分页、完整性校验、取消与单次 20,000 根历史范围限制仍由行情模块处理，独立于已移除的执行引擎。
- 网络、地区限制或数据缺失产生错误或不可用状态；模拟行情是用户单独选择的模式。

实现入口：[合约目录](../../src/lib/market/binance-contracts.ts)、[实时行情](../../src/lib/feed/binance-feed.ts)、[历史与标记价格](../../src/lib/history/binance-history.ts)、[公开行情桥接](../../server/public-market.ts)。档案、录制与采样的区别见 [行情存储指南](../market-data-storage.md)。

## 本地服务与可选网络代理

Vite 开发/预览服务提供公开行情桥接、SQLite 行情存储、深度采样与本机 MCP。纯静态 `dist/` 本身不提供这些本地服务。桥接要求回环与同源访问，不是公网账户认证系统。

[环境模板](../../.env.example) 只包含可选 `HTTP_PROXY` / `HTTPS_PROXY` 网络代理配置。公开 HTTP 代理初始化由 [binance-proxy.ts](../../server/binance-proxy.ts) 保留；公开 WebSocket 连接使用各服务的代理对象。无需配置 Binance 账户密钥。

原 `/api/binance-futures/rules`、签名 `leverageBracket` / `commissionRate` 读取及浏览器账户规则适配器已删除。公开 `exchangeInfo`、K 线、标记价格、资金费率、成交与深度接口继续保留。

## 存储命名与旧数据兼容

现货与永续的同名品种使用不同市场身份。当前显式标记 `marketType: 'usdm-perpetual'`；旧 Binance 数据缺少市场标记时按 `spot` 解释。

| 位置 | 当前命名或身份 |
| --- | --- |
| 行情选择 | `tvchart.market-selection.usdm.v1` |
| 自选列表 | `tvchart.watchlists.usdm-perpetual.v1` |
| 历史缓存键 | `binance:usdm-perpetual:v1:…`，同时校验市场、品种与标记价格 |
| 场景与数据集 | 使用市场身份；数据集指纹包含计价单位、报价步长、规则与标记价格 |

[中性历史缓存模块](../../src/lib/history/persistence.ts) 只处理 `datasets`，保留既有浏览器数据库名称/版本来续读历史数据；旧脚本记录不会被这个迁移过程删除或重新执行。新的源码已不包含脚本工作区逻辑。

旧行情和旧绘图不会被改写成永续数据。带面值前缀的合约也不自动复用其他品种价格或数量单位。兼容入口：[市场身份](../../src/lib/market/identity.ts)、[数据集指纹](../../src/lib/history/datasets.ts)、[市场选择](../../src/lib/chart/market-selection.ts)、[自选存储](../../src/lib/watchlist/store.ts)。

## 历史资料范围

2026-10-01 之前的 Pine、模拟回测、账户规则验收与研究记录保留为历史资料，描述其记录时的实现。它们不代表当前应用仍提供脚本执行、策略回测或账户元数据接口；未来自研能力以新实现与新验收为准。
