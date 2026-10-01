# 可停靠工作区布局

当前模块调整单个行情图周围的工具面板、显示密度与辅助栏。左侧、右侧、底部可以同时显示不同面板；图表仍由同一个 `ChartController` 管理。这是 **UI 工作区布局**，不是多图表网格、具名 TradingView 图表布局，也不改变品种、行情源、指标配置或绘图场景。

## 模块与所有权

| 模块 | 职责 |
| --- | --- |
| [layout.ts](../../src/lib/workspace/layout.ts) | 布局类型、默认值、预设、持久化和纯尺寸计算 |
| [registry.ts](../../src/lib/workspace/registry.ts) | 与渲染框架无关的 `PanelRegistry<T>`，按 ID 注册面板元数据与组件引用 |
| [workspace-panels.ts](../../src/plugins/workspace-panels.ts) | 本应用实际的 Svelte 面板注册入口；目前注册自选、对象树、数据 |
| [panel-context.ts](../../src/components/layout/panel-context.ts) | 面板 props 与共享服务契约 |
| [WorkspaceDock.svelte](../../src/components/layout/WorkspaceDock.svelte) | 稳定图表槽、三个停靠区、保留已访问面板、分隔条与标签拖放 |
| [LayoutSettings.svelte](../../src/components/layout/LayoutSettings.svelte) | 布局设置原生弹窗：预设、位置、密度、尺寸、辅助栏开关 |
| [App.svelte](../../src/App.svelte) | 持有布局 Store、唯一图表实例、自选 Store 与报价服务；将状态和回调传给 Dock |

内置面板通过 [Watchlist](../../src/components/layout/panels/Watchlist.svelte)、[Objects](../../src/components/layout/panels/Objects.svelte)、[Data](../../src/components/layout/panels/Data.svelte) 三个适配组件复用既有界面。面板不自行建立第二个图表，也不因为移动位置重新创建行情连接。

## 单一 CSS Grid 与稳定图表槽

桌面 Dock 使用一个 Grid。列顺序为“左面板 / 分隔条 / 图表 / 分隔条 / 右面板”，行顺序为“主区域 / 分隔条 / 底部面板”。底部区域横跨全部列。未打开的停靠区及分隔条尺寸为零。

`children: Snippet` 始终渲染在唯一 `.chart-slot` 中，位置是第 1 行、第 3 列。切换预设、移动面板、收起侧栏只改变 Grid 尺寸及面板的 `grid-area`，不会按布局分支重新渲染一份 `ChartView`。因此布局操作只会让现有图表收到尺寸变化，不会更换它的 DOM、重建控制器或重新拉取市场数据。

不要在后续扩展中写成 `{#if analysis}<ChartView .../>{:else}<ChartView .../>{/if}`，也不要把图表包进随预设变化的 `{#key}`。图表的业务生命周期由 App / ChartView 管理；Dock 只负责可用空间。

## 面板保留与 `active`

Dock 在当前页面维护 `visited: string[]`。面板第一次真正显示时，将它的 ID 加入列表；随后统一使用 `{#each visited as id (id)}` 渲染，而不是在每个 zone 内分别实例化组件。

- 同一已访问面板换到另一停靠区，改变 `grid-area` 和 `zone`，保持同一组件实例。
- 切换区域内标签或收起区域，面板表面设置 `hidden` 和 `inert`，并收到 `active=false`，保留其本地过滤条件、滚动与草稿状态。
- 同时打开三个区域时，可以有三个不同面板各自 `active=true`；每个区域只有一个活动标签。
- `visited` 是页面内缓存，不写入布局 JSON。刷新后仅在面板再次打开时创建组件；插件若要求草稿跨刷新恢复，需要自己的业务存储。
- 插件取消注册或替换 `component` 引用时，其实际组件可能卸载或替换；保留承诺针对停靠、标签切换和显隐，不覆盖插件卸载。

`active` 是共享契约中的可选布尔值；当前 Dock 总会传入明确值。需要图形渲染、轮询或额外订阅的插件应在 `active=false` 时暂停这些工作，并用 Svelte effect 的清理函数释放资源。隐藏并不意味着组件已销毁，不能只依赖 `onDestroy` 停止后台计算。

## Svelte 面板契约

实际类型定义为：

```ts
interface WorkspacePanelProps {
  context: WorkspacePanelContext;
  active?: boolean;
  density: 'compact' | 'comfortable';
  zone: 'left' | 'right' | 'bottom';
  onClose: () => void;
}
```

| 字段 | 用法 |
| --- | --- |
| `context.controller` | 操作现有图表与绘图引擎；不要以此创建第二个控制器 |
| `context.chartState` | 当前行情和轻量读数快照。使用 `readings` 展示指标值，避免为了面板 UI 复制百万长度的派生数组 |
| `context.watchlistStore` | 当前应用共用的自选列表业务状态 |
| `context.quoteState`、`context.catalog` | 共用的公开报价快照与品种目录，面板无需重复建流或请求目录 |
| `context.onSelectSymbol(symbol)` | 经应用入口切换现货品种 |
| `context.onAddSymbol()`、`context.onRetryQuotes()`、`context.onWatchOrder(symbols)` | 打开添加品种界面、重试报价、告知应用当前自选顺序 |
| `context.onOpenLibrary()`、`context.onOpenProperties(ids)` | 进入统一指标库或属性编辑会话 |
| `context.onTreeSelection()` | 通知应用对象树选择，清理画布的快捷工具条选择状态 |
| `context.onOpenPanel(id)` | 打开或激活另一个已注册/已分配面板 |
| `active` | 当前实例是否正在显示；昂贵的插件工作据此启停 |
| `density` | 行高、间距等面板内部密度；不要用它修改行情或指标配置 |
| `zone` | 当前停靠位置，组件可据此选择横向/纵向排版，不应自行搬动外层 DOM |
| `onClose()` | 收起当前所在区域，不删除面板、不取消注册，也不等同于将该 ID 加入 `hidden` |

Context 会随当前行情、报价、目录等状态更新。它是应用提供的服务与读数对象，不是必须保持引用不变的单例；不要长期捕获第一次收到的 `chartState` 后继续展示旧品种。

## 注册一个新面板

下面是可按当前契约接入的“分析笔记”示例，示例文件尚未作为内置功能创建。先在 `src/plugins/notes/NotesPanel.svelte` 定义组件：

```svelte
<script lang="ts">
  import type { WorkspacePanelProps } from '../../components/layout/panel-context';

  let { context, active = true, density, zone, onClose }: WorkspacePanelProps = $props();
  let draft = $state('');
</script>

<section class:comfortable={density === 'comfortable'} data-zone={zone} data-active={active}>
  <header>
    <strong>{context.chartState.symbol} · {context.chartState.interval}</strong>
    <button onclick={onClose}>收起区域</button>
  </header>
  <textarea aria-label="分析笔记" placeholder="记录当前观察…" bind:value={draft}></textarea>
  <button onclick={() => context.onOpenPanel('objects')}>查看对象树</button>
</section>

<style>
  section { display:flex; flex-direction:column; gap:8px; width:100%; height:100%;
    min-width:0; min-height:0; padding:12px; box-sizing:border-box; }
  section.comfortable { gap:12px; padding:16px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  textarea { flex:1; min-width:0; min-height:48px; resize:none; }
</style>
```

然后在现有 [src/plugins/workspace-panels.ts](../../src/plugins/workspace-panels.ts) 中增加导入与注册。使用已经导出的 `workspacePanels`，不要另建一个不会被 App 订阅的 registry：

```ts
import NotesPanel from './notes/NotesPanel.svelte';

export const unregisterNotesPanel = workspacePanels.register({
  id: 'plugin:notes',
  title: '分析笔记',
  icon: 'text',
  component: NotesPanel,
  defaultZone: 'bottom',
});
```

注册后，App 订阅会更新活动栏，布局设置也会显示新面板；打开时使用已保存位置，否则采用 `defaultZone`。示例的 `draft` 在面板移动和收起时保留，但不跨页面刷新保存。

Registry 的规则：ID 唯一、非空、不含空白、长度不超过 128；标题与图标不能为空；`defaultZone` 必须是合法停靠区。重复注册会抛错，不能无声覆盖旧实现。`register()` 返回取消注册函数；`get()` 对未知 ID 返回 `undefined`；`list()` 和订阅返回复制的元数据，但 `component` 保持原引用。`subscribe()` 会立即通知一次，返回取消订阅函数；回调可以忽略参数。

已有保存位置优先于注册默认位置。例如，内置 `data` 注册为默认底部，但标准布局已经把它分配到右侧，所以标准布局中先在右侧打开；应用“多区分析”预设后才位于底部。`defaultZone` 不是强制位置。

## 布局偏好与 API

存储键是 `tvchart.workspace-layout.v1`，格式版本为 `1`。默认值：

```json
{
  "version": 1,
  "density": "compact",
  "drawingTools": true,
  "quoteHeader": true,
  "zones": {
    "left": { "size": 260, "open": false, "active": null, "panels": [] },
    "right": { "size": 320, "open": true, "active": "watchlist", "panels": ["watchlist", "objects", "data"] },
    "bottom": { "size": 220, "open": false, "active": null, "panels": [] }
  },
  "hidden": []
}
```

同一个 ID 只允许出现在一个 zone 的 `panels` 中。`hidden` 只是遮罩：被隐藏的 ID 仍保留原区域和标签位置；再次打开会移除遮罩并激活原区域。收起区域则只修改 `open`，不改变遮罩。

未知插件 ID 会正常保存。布局设置显示“未加载 · ID”，Dock 在尝试打开时显示未加载占位；插件之后用相同 ID 注册，可重新显示内容。预设只认识内置三个 ID，保留其他插件的原位置与隐藏状态；恢复默认也保留这些插件登记。

| API | 行为 |
| --- | --- |
| `defaultWorkspaceLayout()` | 返回独立的默认对象 |
| `loadWorkspaceLayout(storage?)` | 纯读取；版本、尺寸、重复 ID 等无效时返回默认值，不立即覆盖坏记录 |
| `store.snapshot` / `subscribe(listener)` | 返回隔离快照；订阅立即通知并返回解除函数 |
| `openPanel(id, defaultZone = 'right')` | 取消该面板隐藏、打开区域并激活；只有新 ID 使用默认区域 |
| `togglePanel(id, defaultZone = 'right')` | 当前已显示的活动面板会收起整个区域；其他情况按打开处理 |
| `setPlacement(id, zone \| 'hidden')` | 移到目标区并激活，或保留位置只隐藏 |
| `setZoneOpen(zone, open)` | 单独收起/打开区域；空区域不占空白空间 |
| `setSize(zone, px, persist = true)` | 调整并限制尺寸；`false` 只更新内存和订阅 |
| `setDensity(value)` / `setChrome(patch)` | 改列表密度、左侧绘图工具、顶部行情摘要 |
| `applyPreset(name)` / `reset()` | 应用内置预设，或恢复默认密度与辅助栏等偏好 |
| `save()` / `destroy()` | 保存当前偏好；或结束模型使用并清空订阅 |

修改方法返回的是内存状态是否改变；不能据此推断存储写入成功。`save()` 返回写入是否成功，`store.error` 提供失败说明。存储不可用时仍允许页面内操作。正常操作会即时保存；拖动尺寸使用 `persist=false` 连续预览，松手、取消指针或失焦结束调整时统一 `save()`，避免每一帧写浏览器存储。

布局设置弹窗本身是即时设置，不使用绘图属性的“取消恢复”事务。Esc、外部点击或完成会关闭弹窗并保存现有布局。打开布局设置会取消正在进行的绘图手势；隐藏左侧工具栏也会退回选择工具，这与重建图表是不同操作。

## 三个预设

| 预设 | 左侧 | 右侧 | 底部 | 辅助栏 |
| --- | --- | --- | --- | --- |
| `standard` 标准 | 默认收起 | 自选 / 对象树 / 数据，活动为自选 | 默认收起 | 绘图工具与行情摘要显示 |
| `analysis` 多区分析 | 对象树 | 自选 | 数据 | 绘图工具与行情摘要显示 |
| `focus` 专注图表 | 收起 | 收起 | 收起 | 绘图工具与行情摘要隐藏 |

`focus` 保留当前分配、尺寸和密度，只收起区域与辅助栏；之后可通过永远可用的应用活动栏或布局设置重新打开面板。`standard` / `analysis` 会重排内置面板并采用预设尺寸，但保留当前密度；`reset()` 恢复紧凑密度。右侧活动栏和设置入口不属于可隐藏的布局字段。

## 尺寸约束和小屏

模型限制左/右区域为 180–800px，底部为 120–600px。`resolveDockSizes(layout, { width, height, minChartWidth?, minChartHeight? })` 返回 `left/right/bottom/chartWidth/chartHeight/suppressed`，只计算显示尺寸，不修改布局对象。中心至少保留 320px 宽、180px 高；窗口本身更小时，将可用空间优先全部给图表。

当前 Dock 先为分隔条预留最多横向 10px、纵向 5px，再把其余尺寸传入 resolver。空间不足时可能压缩或临时抑制区域；窗口扩大后仍按保存的原尺寸恢复。用户主动拖动某一侧时，另一侧可能联动缩小，以保留中心空间。

Dock 容器可用宽度小于 900px 时，UI 使用覆盖式面板：Grid 中的停靠尺寸归零，图表保留完整空间；一次展示最近启用区域中的一个面板。`mobileOpen` 与 `focusedZone` 是 App 的暂态导航，不覆盖持久化的区域 `open`、位置和尺寸。再次回到大窗口时，可以恢复多个区域同时显示。

## 与市场、绘图和自选业务的隔离

| 保存内容 | 存储范围 |
| --- | --- |
| UI 停靠、密度、辅助栏 | `tvchart.workspace-layout.v1` |
| 当前行情源 / 品种 / 周期 | `tvchart.market-selection.v1` |
| 指标、绘图、对象分组和图层 | `tvchart.workspace.v2:<source>:<symbol>` |
| 自选列表内容 | `tvchart.watchlists.v1` |

布局模型不读取或修改 `SceneDocument`、K 线列、指标派生数组或自选品种集合。把对象树从右侧移到底部只改变显示位置；不会切换品种，也不会重新添加指标。现有每品种独立 SceneDocument 的业务语义仍保留，多图表同步和布局级指标配置不由本模块实现。

## 验证依据

模型和注册表已有 [workspace-layout.test.ts](../../tests/workspace-layout.test.ts) 与 [workspace-panel-registry.test.ts](../../tests/workspace-panel-registry.test.ts) 共 29 项测试，覆盖损坏数据纯读恢复、重复 ID、隐藏恢复、未知插件、预设、尺寸预览保存、存储失败、订阅隔离及小屏不改偏好。

UI 最终验收应单独观察：切换预设和拖动停靠时图表 DOM/控制器引用不变；每个已访问面板只有一个实例；面板移位后草稿/筛选/滚动不丢失；隐藏面板不可聚焦；左右与底部分隔条尺寸正确；小屏覆盖面板关闭后可从活动栏恢复。这些运行时验证不由模型单测代替。
