# 全局 UI 主题与图表样式

图表外观预设（终端灰 / 经典深色 / 清晰浅色 / 午夜蓝 / 暖纸色 / 自定义）是**唯一的主题开关**：切换预设时，图表、工具栏、绘图栏、面板、弹窗、菜单和画布浮层一起换肤。外观仍只属于展示偏好（`tvchart.chart-appearance.v1`），不进入行情、指标或场景状态。

## 数据流

```
ChartAppearance ──► uiThemeFor()  ──► UiTheme (tokens + tone)
      │                                   │
      │                                   ├─► applyUiTheme()  → :root 自定义属性、data-theme / data-tone、color-scheme
      │                                   └─► canvasInkFor()  → 画布手柄、吸附引导线的墨色
      └─► deriveOverlaySurface()  → --chart-glass-*（图表内的毛玻璃浮层）
```

| 位置 | 职责 |
| --- | --- |
| [theme.ts](../../src/lib/ui/theme.ts) | 每个预设一套手调色板；自定义预设按图表背景推导（层级、可读文字、强调色） |
| [main.ts](../../src/main.ts) | 首次绘制前读取已保存外观并 `applyUiTheme`，避免深色闪烁 |
| [controller.ts](../../src/lib/chart/controller.ts) `syncAppearanceSurface` | 每次预览 / 保存外观都重新应用主题与画布墨色 |
| [app.css](../../src/app.css) | token 默认值与派生色（`--accent-soft`、`--up-line`…）、圆角 / 阴影 / 动效刻度 |

## Token 约定

组件样式**只引用 token，不写十六进制**。层级从后到前：`--bg` 页面 < `--bg-panel` 工具栏与面板 < `--surface-raised` 弹窗、菜单、卡片；`--surface-sunken` 用于输入框等下凹区域。

| 类别 | Token |
| --- | --- |
| 文字 | `--text-strong`、`--text`、`--text-dim`、`--text-muted` |
| 线与交互 | `--line`（发丝线）、`--line-strong`、`--bg-hover`、`--bg-active`、`--selected`、`--focus` |
| 语义色 | `--accent`、`--accent-strong`、`--on-accent`、`--up`、`--down`、`--warn`，各带 `-soft`（15% 底色）与 `-line`（50% 描边）派生色 |
| 形状 | `--radius-xs / sm / md / lg / xl`（3 / 5 / 7 / 10 / 14px） |
| 层级阴影 | `--shadow-sm`（控件）、`--shadow-md`（弹出层）、`--shadow-lg`（模态）；浅色主题通过 `--shadow-strength` 自动变淡 |
| 叠加墨色 | `--ink`：深色主题为白、浅色主题为深灰；半透明叠加一律写 `color-mix(in srgb, var(--ink) 8%, transparent)` |

`var(--x, #fallback)` 中的兜底值在 token 恒有定义时不会生效，保留只是防御；新代码不要再新增兜底色。

画布代码拿不到 CSS 变量，因此：图表内容用 `ChartAppearance` 与 `deriveOverlaySurface()`；手柄 / 引导线用 `canvasInkFor()`；成交标记与热图悬停卡片带 `tone` 参数，浅色图表使用纸色卡片。外部叠加层可提供自定义颜色，按其自身样式渲染。

## K 线圆角

`ChartAppearance.candleRadius`（0–4px，默认 1.5）。实体用 GPU 三角扇（`GLRenderer.roundRect / roundRing`，每个圆角 1–4 段，随半径自适应），Canvas2D 回退用 `roundRect`。有效半径不超过实体宽度的 35% 与高度的一半，小于 0.5px 时退回直角矩形，所以极密的 K 线不会因圆角而变糊或变慢。填充蜡烛画一个圆角轮廓；边框色与实体色不同时再叠一层内填充；空心蜡烛用圆角环。

## 图标与字体

- 图标：Lucide 子集（ISC）+ 项目自绘交易图元，全部在 24px 网格、1.5px 线宽。绘图工具共用一个母题：每个用户放置的锚点都是实心小圆点。目录由 [build-icons.mjs](../../scripts/design/build-icons.mjs) 生成，测试保证代码里引用的每个图标名都存在。许可见 `src/lib/ui/icons/LUCIDE-LICENSE.txt` 与 `THIRD_PARTY_NOTICES.md`。
- 字体：`@fontsource-variable/ibm-plex-sans` 与 `@fontsource/ibm-plex-mono`（OFL），按 unicode-range 拆分，只下载用到的字形。画布文字使用 [fonts.ts](../../src/lib/render/fonts.ts) 的同一字体栈，字体就绪后触发一次重绘。
