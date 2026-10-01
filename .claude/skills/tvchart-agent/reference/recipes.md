# Recipes

All snippets are tool arguments. Numbers come from bars you actually read.

## Swing pivots and levels (used by most recipes)

`get_structure {range:"visible"}` computes them exactly in the chart: confirmed pivots (`strength` bars each side, default 3; 3–5 intraday, 2–3 daily) labelled HH/HL/LH/LL with `legAtr`, ATR(14), levels clustered from pivots within `tolerance` × ATR (default 0.25) with touches and first/last touch, the least-squares trend channel and the nearest support/resistance. Refer back to a pivot by `{time:<pivot time>, price:"high"|"low"}`. Only fall back to reading `get_bars` rows when you need something the structure result does not give.

## Support / resistance

1. Take the top 2–4 `levels.items` from `get_structure` (more touches and recent touches first).
2. Draw them:
```json
{"group":"AI · 支撑阻力","drawings":[
  {"tool":"horizontal-line","points":[{"barsAgo":0,"value":84550}],"style":{"color":"#ef5350","dash":"dashed"},"name":"AI · 阻力 84,550（3 次触及）"},
  {"tool":"price-zone","points":[{"time":"<first touch>","value":82980},{"barsAgo":0,"offset":20,"value":82720}],"text":"需求区","props":{"intent":"支撑"},"style":{"color":"#26a69a","fillOpacity":0.12}}]}
```

## Trendline / channel

Two most recent `HL` pivots (uptrend) or `LH` pivots (downtrend) from `get_structure`; `trend` gives the regression channel if you prefer a statistical line:
```json
{"group":"AI · 趋势","drawings":[{"tool":"ray","points":[{"time":"<low 1>","price":"low"},{"time":"<low 2>","price":"low"}],"style":{"color":"#26a69a","width":2}}]}
```
Channel: `parallel-channel` with the two lows plus the highest high between them as the third point.

## Fibonacci

Uptrend pullback: `{"tool":"fib-retracement","points":[{"time":"<swing low>","price":"low"},{"time":"<swing high>","price":"high"}],"props":{"levels":"0,0.382,0.5,0.618,0.786,1"}}` — 0 sits at the high, 0.618 is the deep retracement. Extensions: add `1.272,1.618` to levels.

## Waves and hand-made structures

```json
{"tool":"analysis-path","points":[{"time":"<p0>","price":"low"},{"time":"<p1>","price":"high"},{"time":"<p2>","price":"low"},{"time":"<p3>","price":"high"},{"time":"<p4>","price":"low"},{"time":"<p5>","price":"high"}],
 "text":"0,1,2,3,4,5","style":{"color":"#9082ca"},"name":"AI · 五浪计数（主）"}
```

## Trade plan

`{"tool":"long-position","points":[{"barsAgo":0,"price":"close"},{"barsAgo":0,"offset":30,"value":<target>},{"barsAgo":0,"value":<stop>}]}` — the box shows R:R. Put the reasoning in a nearby `text` drawing or an overlay label, not in the name.

## Explain what the user points at / selected

- Hovered candle: `get_chart_state {include:["cursor","indicators"]}` → `cursor.bar` (+ `barsAgo`) and indicator outputs at that bar.
- Selected drawing(s): `get_chart_state {include:["selection"]}` → objects with points; `get_bars {range:"selection"}` for the bars inside.

## Mark indicator events

`get_indicator_data {ids:["macd"], range:{last:300}, maxPoints:300}` → find DIF/DEA crosses → one overlay:
`{"id":"macd-cross","kind":"markers","markers":[{"time":"…","side":"buy","text":"金叉"}, …]}`.

## Custom computed series

Compute from `get_bars` (e.g. VWAP, Keltner, regression ± 2σ) and send one `band` or `line` overlay per series; keep ids stable so re-running replaces them.

## Built-in detectors

`add_indicator {type:"pattern-harmonic"}` (or `pattern-huzi`, `pattern-confluence`, `analysis-structure`, `analysis-wyckoff`, `analysis-elliott`, `analysis-zones`, `analysis-order-blocks`, `analysis-vsa`, `analysis-candles`, …) → wait until `market.indicatorsPending` is false → `get_analysis {kind:"patterns", limit:10}`. Results carry points, zones, invalidation, targets and evidence text — cite them instead of re-deriving. Remove the layer afterwards with `delete_objects {ids:[<instance id>]}` if the user did not ask to keep it.

## Multi-timeframe context

`add_indicator {type:"ema", params:{period:50}, timeframe:"1h", name:"AI · 1h EMA50"}` shows closed 1h values on a lower-interval chart without switching the user's interval.

## Verify without vision

Each `draw`/`update_objects` result has `layout.issues`. For a full picture call `describe_chart` (object boxes, label boxes, issues, and an `ascii` rendering of the main pane: █ up candles, ░ down candles, │ wicks, ─ / \\ ┆ drawings, labels as text). Move a label that `covers N candles` by shifting its anchor above the highs / below the lows of that span, or into empty space to the right (`offset`).

## Clean up

`delete_objects {author:"agent"}` + `remove_overlays {all:true}`. Both deletions are undoable by the user.
