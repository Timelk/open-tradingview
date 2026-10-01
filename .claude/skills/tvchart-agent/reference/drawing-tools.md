# Drawing tools (`draw`)

`get_catalog {kind:"tools"}` is authoritative (plugins can add tools). Point counts are exact; freehand tools take 2–2048 points. `text` sets the tool's `textProp`. Tools marked "labels" honour `style.fontSize`; "fill" tools use `style.fillOpacity`.

| id | points (in order) | props / notes |
|---|---|---|
| `trend-line` | A, B | Segment. |
| `ray` | origin, direction | From origin through the second point to the pane edge. |
| `extended-line` | A, B | Infinite line through both points. |
| `horizontal-line` | 1: the level (time irrelevant) | Full-width level with a price tag. labels |
| `vertical-line` | 1: the time (value irrelevant) | Full-height marker. |
| `parallel-channel` | A, B (base line), C (any point on the parallel) | fill |
| `fib-retracement` | P1, P2 | Level 1 at P1, level 0 at P2 — so `[swingLow, swingHigh]` measures pullbacks down from the high. `props.levels` = `"0,0.236,0.382,0.5,0.618,0.786,1"` (up to 24, extensions like `1.618` allowed). textProp = `levels`. labels |
| `abcd-pattern` | A, B, C, D | Labelled A–D. labels |
| `analysis-path` | 2–2048 vertices | Polyline with a label per vertex: `props.labels` / `text` = `"0,1,2,3,4,5"` or `"X,A,B,C,D"`. Best for wave counts and hand-made structures. |
| `triangle-pattern` | 3 vertices | Closed, fill |
| `long-position` | entry, target, stop | Entry time = box start, target time = box end; shows target/stop prices and R:R. fill, labels |
| `short-position` | entry, target, stop | Same for shorts (target below entry). fill, labels |
| `date-price-range` | corner, corner | Shows Δprice, %, bar count and duration. fill, labels |
| `brush` | 2–2048 | Free path without handles. |
| `rectangle` | corner, corner | fill |
| `ellipse` | corner, corner (bounding box) | fill |
| `arrow` | tail, head | |
| `text` | 1 | `text` / `props.text`. labels |
| `buy-marker` | 1 (arrow tip) | Up triangle under the point — anchor with `price:"low"`. Default green. |
| `sell-marker` | 1 (arrow tip) | Down triangle above the point — anchor with `price:"high"`. Default red. |
| `price-zone` (plugin) | corner, corner | `text` → `props.label`; `props.intent` = `观察` / `支撑` / `阻力`. fill, labels |

Not drawable through the agent: `cursor`, `pointer`, `eraser`, `zoom-region` (interaction tools).

## Common fields per drawing

```json
{"tool":"price-zone","points":[{"barsAgo":40,"value":82900},{"barsAgo":0,"offset":20,"value":83050}],
 "paneId":"main","text":"需求区","props":{"intent":"支撑"},
 "style":{"color":"#26a69a","fillOpacity":0.15,"width":1,"dash":"solid","fontSize":13},
 "name":"AI · 需求区 82,900–83,050","locked":false,"hidden":false,"intervals":["15m","1h"]}
```

`intervals` limits on which chart intervals the drawing shows (omit = all). Drawings are anchored in time/value, so they stay put across zoom, pan and interval changes and are shared by every interval of the same symbol.

## Editing (`update_objects`)

Per object: `points` (same count), `style` (merged), `props` (merged), `text`, `name`, `visible`, `locked`, `opacity` 0–1, `intervals` (`null` = all), `parentId` (group id or `null`), `order` (`front|back|forward|backward` among siblings). All updates of one call are one undo step.
