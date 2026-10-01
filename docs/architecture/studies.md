# 指标与策略目录、图表管理与扩展

顶部“指标与策略”（快捷键 `/`）、图表工具栏计数和右侧添加入口共用 `StudyLibrary`。目录读取 `IndicatorRegistry`，所有添加动作都经过 `ChartController.addIndicator()`，创建独立的工作区实例。收藏按定义 ID 保存，实例参数、样式、周期、图层和历史仍属于 `SceneDocument v2`。

## 职责

| 模块 | 职责 |
| --- | --- |
| `components/studies/StudyLibrary.svelte` | 原生模态、搜索、分类、收藏、连续添加与反馈 |
| `lib/studies/catalog.ts`、`favorites.ts` | 目录元数据、搜索规范化、收藏持久化 |
| `components/studies/ChartStudies.svelte` | 各窗格的指标标题、读数、悬停操作与对象树定位 |
| `components/workspace/ObjectPropertiesDialog.svelte` | 输入、样式、可见性、图层和事务预览 |
| `components/workspace/StudyStyleEditor.svelte` | 每条输出的显示、颜色、线宽/标记大小 |
| `lib/indicators/registry.ts`、`strategies.ts` | 定义注册和内置计算器 |
| `lib/indicators/runtime.ts`、`worker.ts`、`engine.ts` | 多实例增量计算、已收盘周期映射、结果补丁 |
| `lib/chart/controller.ts` | 实例操作、显示样式、稀疏标记索引、稳定窗格布局 |

## 新增一个定义

沿用 `IndicatorDef` 的 `inputs`、`calc` 和可选 `createIncremental`，加上目录元数据即可出现于目录；无需为每个定义编写单独添加面板。

```ts
registry.register({
  id: 'my-study',
  name: 'My Study',
  title: '自定义分析',
  description: '解释输出及适用场景。',
  kind: 'indicator', // 或 strategy
  source: 'custom',
  tags: ['趋势'],
  target: 'main',
  inputs: [],
  calc: ({ cols }) => [{
    name: 'Close', values: cols.col('close').slice(0, cols.length),
    color: '#4d91ff', pane: 'main', plot: 'line',
  }],
});
```

需要 Worker 计算的定义应加入控制器与 Worker 都加载的共享注册流程。目前任意运行时函数不会被序列化发给 Worker；只注册在主线程的自定义定义依赖现有主线程回退。大数据定义应提供持久化增量计算器，避免每个 tick 全量计算。

目录点击返回唯一 `instanceId`，同一定义可添加多次。默认主图指标叠加主图；重复添加独立副图指标会分配独立 `paneId`。实例复制保留参数与样式。隐藏实例保留窗格及标题，可在原处恢复；删除最后实例后移除无其他内容的窗格。

## 输出样式与策略信号

实例可选 `plotStyles` 按 `plotIndex` 保存 `{ color?, width? }`；旧 v2 文档不需要迁移。线颜色/宽度和标记颜色/大小只影响绘制，不触发指标重算。柱状输出的柱宽由缩放决定，属性页显示“自动”。`hiddenPlots` 控制单条输出。

策略复用同一实例/计算/样式链，输出 `plot: 'markers'`、固定 `markerSide: 'buy' | 'sell'`，无信号处为 NaN。内置双均线交叉、RSI 阈值回归只使用已收盘柱，在下一根确认；标记价格为此前收盘价，不代表成交结果。没有自动下单或收益回测。

高周期标记仅映射到确认时的一个基础柱，不铺满整段时间桶。索引更新使用 Worker 实际应用的 `{from,length}`，而非主行情最新长度，因此积压消息不会让后到信号被跳过。渲染只二分查找可见范围，并在超大范围显示时限制标记密度。

## 交互与历史

点击标题选择实例；双击或齿轮打开相同属性弹窗。悬停或键盘聚焦标题显示隐藏、设置、删除、更多操作。锁定状态继承分组。所有样式/输入变更即时预览，取消还原，确定只产生一步撤销。

纯绘图副窗格在没有数据驱动范围时保留既有坐标比例，避免移动绘图后纵轴随之移动。点击“自动”可显式重新适配锚点。
