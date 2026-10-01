# 原生图表分析首期范围与验证 · 2026-10-01

当前首期重点：自研图表渲染、经典/谐波/量价共振三类形态、原生指标、结构量价、商品搜索、指标与信号策略弹框，以及AI Agent协作。PineTS、Pine编辑、脚本库、策略回测与专属账户规则查询已移除。项目沿用维护者 GitHub 仓库已有的 MIT 许可。

## 移除和保留

- 删除Pine执行Worker、sandbox、模板、编辑器、脚本持久化服务、回测报告与成交账本接入，以及对应MCP脚本工具。
- 移除PineTS与Monaco运行依赖，删除闲置许可资产；当前7个直接运行依赖，生产闭包100个节点的许可字段已核对。
- 原生均线交叉/RSI信号策略保留，用于图表标注；不构成成交模拟。
- 行情缓存改为[history/persistence.ts](../src/lib/history/persistence.ts)，行情与图形类型独立，保留旧数据库名以续读既有行情数据。
- 旧Pine图层和面板只读忽略，其他手工绘图与保存数据保留；没有清空浏览器库。
- MCP保留21个图表工具，包括行情/指标/结构/形态/布局读取、精确绘图、叠加层、指标操作、截图及撤销。

## 已执行检查

最终全量类型检查0错误/0警告；完整测试 **176个文件、1771项通过**；构建成功，产物没有Pine运行包或Monaco资源。此前移除阶段175文件1765项通过；密集绘制回归已加入最终完整测试。

原生库包含7个经典指标、2个信号策略、3个形态模块与14个结构量价模块。库分类与旧布局/收藏无损兼容有对应回归覆盖。

## 截图证据

全部截图从实际运行应用直接获取。除明确标注的百万模拟场景外，图表与搜索使用真实Binance公开数据。

| 场景 | 截图 |
| --- | --- |
| 原生指标渲染与完整工作台 | [workspace.png](assets/screenshots/native-2026-10-01/workspace.png) |
| 三类形态共同识别 | [pattern-analysis.png](assets/screenshots/native-2026-10-01/pattern-analysis.png) |
| 三类形态目录 | [three-pattern-families.png](assets/screenshots/native-2026-10-01/three-pattern-families.png) |
| 结构与量价图表 | [structure-volume.png](assets/screenshots/native-2026-10-01/structure-volume.png) |
| 结构量价模块目录 | [structure-library.png](assets/screenshots/native-2026-10-01/structure-library.png) |
| 商品搜索与行情预览 | [symbol-search.png](assets/screenshots/native-2026-10-01/symbol-search.png) |
| 原生指标与策略弹框 | [indicator-library.png](assets/screenshots/native-2026-10-01/indicator-library.png) |
| 真实AI客户端与图表标注 | [ai-agent.png](assets/screenshots/native-2026-10-01/ai-agent.png) |
| AI接入与权限状态 | [ai-agent-connection.png](assets/screenshots/native-2026-10-01/ai-agent-connection.png) |
| 百万根模拟全览 | [million-candles-simulation.png](assets/screenshots/native-2026-10-01/million-candles-simulation.png) |

AI标注使用真实HTTP MCP会话，按当前可见K线的get_structure结果绘制最近支撑、阻力和OLS趋势中心线；没有补造价格或伪造连接状态。取图后临时标注已撤销，演示客户端已断开。拟合线不是预测。

旧Pine相关截图与架构说明移入未发布的历史资料，当前README全部使用新范围截图。

## 渲染实测与当前边界

渲染验证使用独立Chromium，而非截图工具的受限帧节奏。环境：Apple M5，1600×1000，DPR1，WebGL2 + Worker，MA/VOL/MACD/BOLL/RSI五指标，百万模拟数据全览，180帧连续缩放。

初测约9.47fps，单帧绘制样本P95约112ms。profile确认颜色对比、文字宽度、标签碰撞及大量历史证据投影的CPU开销。修复复验约 **60.00fps**，绘制/整帧P95约 **4.3ms**、tick P95约0.2ms。

缩远视图使用像素密度绘制：完整档案17565条仍保留，当前投影186条代表；每个时间桶保留牛/熊代表，选中证据额外保留，近端不启用聚合。颜色、文字宽度按层复用，碰撞通过精确空间索引查询。原始记录见 [render-performance.json](assets/screenshots/native-2026-10-01/render-performance.json)。不关闭背离，也不修改FPS计数来获得结果。

百万模拟数据证明的是数据容量与聚合路径，不表示默认加载了百万根真实行情。任何性能结果都只对应其明确场景。

## 后续发布

自研策略与回测引擎属于后续独立阶段。首版源码仓库为 [Timelk/open-tradingview](https://github.com/Timelk/open-tradingview)，保留原有 MIT 初始化提交，并在其后提交经过筛选的当前源码、文档与截图。本地研究资料、运行数据及早期 Git 历史不进入首版。
