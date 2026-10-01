---
name: tvchart-agent
description: Read and annotate the open-tradingview chart the user has open in this project through the `open-tradingview` MCP server — its full global state (K-line/OHLCV bars, indicator values, drawings, detected patterns, selection, crosshair bar), exact market structure (pivots, ATR, levels, trend channel), and drawing or marking it with any drawing tool, overlay, indicator. Use when the user asks to look at, analyze, explain, mark up, annotate, draw on or clean up "the chart" / "当前图表" / "我选中的" / "这根K线", or asks for support/resistance, trendlines, fibonacci, channels, wave counts, patterns or trade plans on their screen.
---

# open-tradingview chart agent

The `open-tradingview` MCP server relays calls to the chart page open in the user's browser through the app's local dev server. Every read is live; every write goes through the same scene store, undo history and persistence as the UI. The running app describes itself at `http://localhost:<port>/llms.txt` (this guide, live status and connection instructions); architecture: `docs/architecture/agent-bridge.md`.

## 0. Connect

- Tools missing → connect the MCP server, then retry:
  - HTTP (served by the dev server): `claude mcp add --transport http open-tradingview http://localhost:<port>/mcp`
  - stdio (auto-discovers the dev server; this repo's `.mcp.json` already declares it — approve via `/mcp`): `node mcp/server.ts` (Node ≥ 24)
  - The port is the one the app runs on (`pnpm dev` prints it). No authentication: local-only service.
- `NO_HUB` → the dev server is not running: ask the user to run `pnpm dev` (or start it in the background if they agree). `NO_CHART` → no page connected: ask them to open the app in a browser tab.
- `NOT_READY` → market data still loading: wait ~2 s and retry. `BUSY` → the user is mid-gesture or in a properties dialog: retry shortly. `LOCKED` / `WRITE_DISABLED` → the user locked objects or switched off "允许 AI 修改图表" in the status bar: tell them, never work around it.

## 1. The loop

1. **Orient** — `get_chart_state` (targets the chart the user is looking at). Use `include` to keep it small, e.g. `["market","viewport","selection","indicators"]`. Note `market.symbol/interval/timezone`, `viewport.panes` (ids + price ranges), `selection`, `cursor.bar` (the candle under the mouse), existing `drawings` (author `user` vs `agent`).
2. **Measure, don't eyeball** — `get_structure` returns exact swing pivots (HH/HL/LH/LL, leg size in ATR), ATR(14), support/resistance levels clustered from pivots (touches, first/last touch, distance), the regression trend channel and the nearest levels. Anchor lines to these numbers. Use `get_bars` only when you need raw candles (`range` = `"visible"` default, `"all"`, `"selection"`, `{last:n}`, `{from,to}`; rows are aggregated beyond `maxPoints` and `aggregation` says so). Indicator values: `get_indicator_data`. Detector output: `get_analysis` (needs a `pattern-*`/`analysis-*` layer; after `add_indicator` poll `get_chart_state {include:["market"]}` until `market.indicatorsPending` is false).
3. **Annotate** — pick the output form (table below). Batch one logical idea per call so it is one undo step, grouped as `group:"AI · <topic>"`. Never invent prices: every coordinate comes from a tool result.
4. **Verify** — every `draw`/`update_objects` result carries `layout` (`onScreen` per object and `issues`: off-screen, clipped label, overlapping labels, label covering candles). Fix issues (move points/labels with `update_objects`) before reporting. For a fuller check use `describe_chart` (text layout + character chart; works without vision); `capture_chart` returns an image and only helps models that can see images.
5. **Report** — say what you drew, with the key numbers, and how to remove it (`delete_objects {author:"agent"}` or the object tree).

## 2. Which chart

- Omit `chartId` to use the active chart: visible tab first, then focused window, then the most recent interaction. `list_charts` shows all tabs (also across several dev servers).
- Once you start a multi-step task, pin the `chartId` from the first result so a tab switch does not redirect later calls.
- "我选中的/selected" → `get_chart_state {include:["selection"]}`; `range:"selection"` reads the bars under the selected drawings' time span. To wait for the user to pick something: ask them, then `wait_for_event {types:["selection"], waitMs:25000, since:<next from a previous call or 0>}`.

## 3. Coordinates

- Times in results are ISO-8601 with the browser's offset (the wall clock on the user's axis). Inputs take ISO or epoch ms; an ISO string without an offset is browser-local time.
- Anchor = exactly one of `time` / `bar` (loaded index, `-1` = newest) / `barsAgo` (0 = newest), plus `value` or `price` (`open|high|low|close|hl2|hlc3|ohlc4`, snaps value **and** time to that candle). `offset:n` projects n bars past the resolved bar (future is fine).
- Prefer `{time, price:"high"}` with a pivot time from `get_structure`, or `{barsAgo, price:"low"}`: exact, no rounding drift.
- `paneId`: `main` (price), `volume`, or an indicator pane id from `viewport.panes` (values are that indicator's units, e.g. RSI 0–100).

## 4. Choosing the output form

| Need | Use | Persisted / editable |
|---|---|---|
| Lines, levels, zones, fib, channels, position plans, text notes, wave labels | `draw` with a drawing tool (`reference/drawing-tools.md`) | Saved per symbol, editable by the user, undoable |
| A computed series (regression, custom MA, bands), a custom oscillator in its own pane (`paneId:"new"`), buy/sell signal markers, icons on bars, many labels/boxes with free text and alpha colors | `set_overlay` (`reference/overlays.md`) | Session only (re-supplied while the page lives); stays aligned when history loads |
| A standard study (MA/EMA/BOLL/MACD/KDJ/RSI/VOL, strategies, pattern & analysis detectors) | `add_indicator` / `update_indicator` (`get_catalog {kind:"indicators"}`) | Saved, in the object tree |

Style: drawings take `#rrggbb` colors (`fillOpacity` for fills, `width` 1–8, `dash`, `fontSize` 12–32). Read `appearance.tone` (dark/light) and pick contrasting colors; the chart's own up/down colors are in `appearance`.

## 5. House rules

- Never edit, move or delete objects authored by the user unless explicitly asked; agent drawings carry `props.author = "agent"` (state shows `author`).
- Name things so the user can find them: `group:"AI · 支撑阻力"`, `name:"AI · 阻力 84,550"`. Re-using a group name adds to that group.
- Keep it readable: 3–8 objects per idea beats 40. Put numbers in labels only when they help; keep labels off the candles (the layout check tells you).
- `undo_redo` shares history with the user: only undo immediately after your own write.
- Clean up on request: `delete_objects {author:"agent"}` (drawings + their groups) and `remove_overlays {all:true}`.
- `set_view` changes what the user is looking at (symbol/interval/zoom): only do it when asked or clearly needed, and say so.

## 6. Performance and precision

- One call per idea: batch drawings (up to 200) and updates; write results already include placement feedback, so no extra verification round trip is needed unless there are issues.
- `get_chart_state` omits the verbose `layers` tree by default (ask with `include`); cap drawings with `maxDrawings`; freehand paths are sampled unless `points:"full"`.
- Prefer `get_structure` over pulling hundreds of bars; when you do need bars, `get_bars {range:{last:300}, maxPoints:300}` is cheap and 1M mock bars must be aggregated.
- `indicators.items[].outputs[].value` are the values at `indicators.valuesAt` (crosshair bar when hovering, else newest).
- Long calls (`set_view` market switch, `wait_for_event`) stream MCP progress notifications; clients that support resource subscriptions can subscribe to `tvchart://chart/active` for live selection/market/object changes.
- `locate` converts screenshot pixels (divide by `pixelsPerCssPx`) to time/value and back — useful when the user points at something in an image.

## References

- `reference/drawing-tools.md` — every tool id, point order and props.
- `reference/overlays.md` — overlay kinds with examples.
- `reference/recipes.md` — support/resistance, trendlines, fib, channels, waves, trade plans, indicator events, cleanup.
