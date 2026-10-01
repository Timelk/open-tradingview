# Overlays (`set_overlay`)

Overlays are chart outputs owned by the agent session: they render like indicator/script outputs, appear in the object tree as "AI · …" layers (owner `agent`), take part in autoscale, and can be hidden by the user. They are **not saved**: a page reload drops them (the layer shows "等待外部数据源" until re-supplied). Use `draw` for anything the user should keep.

- `id` (`[\w.-]{1,64}`) is stable: calling again with the same id replaces it. Layer id = `agent:<id>`.
- Stored in time space and re-aligned automatically when older history is prepended or bars reload; they follow the symbol across intervals.
- Colors: `line`/`hist`/`band` render on the GPU and take `#rrggbb` only; `markers`/`shapes`/`objects` take any CSS color, alpha allowed (`#26a69a80`, `rgba(38,166,154,.3)`).
- `paneId`: `main` (default), an existing pane id, or `"new"` for a separate pane named `agent-pane:<id>` (custom oscillators); later overlays can join it with `paneId:"agent-pane:<id>"`, and `draw` can annotate it too.
- Limits: 50,000 series points; 2,000 markers/shapes/objects per overlay.

## line / hist / band

```json
{"id":"regression","kind":"line","name":"AI · 回归中轴","color":"#ffb74d","width":2,
 "points":[{"time":"2026-09-29T09:00:00+09:00","value":83120},{"barsAgo":0,"value":83610}]}
```
`fill` joins sparse points: `linear` (default for line/band — two points give a straight line across every bar between), `step`, `none` (default for hist). Values land on the nearest loaded bar; points outside loaded data are dropped.

`band`: `points` = lower edge, `upper` = upper edge, shaded between.

`hist`: bars grow from 0, so use it in a sub pane (`paneId:"new"` or an oscillator pane); on `main` the bars would reach down to price 0.

## markers (signal arrows with tooltips)

```json
{"id":"macd-cross","kind":"markers","markers":[
  {"time":"2026-09-30T14:15:00+09:00","side":"buy","text":"DIF 上穿"},
  {"barsAgo":3,"side":"sell","price":"close"}]}
```
Default value: bar low for `buy`, bar high for `sell`.

## shapes (icons and labels on bars)

```json
{"id":"pivots","kind":"shapes","shapes":[
  {"barsAgo":12,"shape":"triangledown","location":"abovebar","color":"#ef5350","size":"tiny"},
  {"barsAgo":30,"shape":"labelup","location":"belowbar","text":"HL","color":"#26a69a","textColor":"#ffffff"},
  {"time":1790733600000,"shape":"diamond","location":"absolute","value":83500}]}
```
`shape`: circle, square, diamond, triangleup, triangledown, arrowup, arrowdown, cross, xcross, labelup, labeldown, flag. `location`: abovebar, belowbar, top, bottom, absolute (needs `value` or `price`). `size`: auto, tiny, small, normal, large, huge.

## objects (labels, boxes, lines with free text)

```json
{"id":"notes","kind":"objects","objects":[
  {"kind":"label","at":{"barsAgo":20,"price":"low"},"yloc":"belowbar","style":"label_up","text":"波段低点\n82,724","fill":"#26a69a"},
  {"kind":"box","from":{"barsAgo":40,"value":83050},"to":{"barsAgo":0,"offset":10,"value":82900},"text":"观察区","fill":"rgba(38,166,154,.12)","color":"#26a69a","textAlign":"left","textValign":"top"},
  {"kind":"line","from":{"barsAgo":60,"value":84550},"to":{"barsAgo":0,"offset":15,"value":84550},"color":"#ef5350","lineStyle":"dashed","width":1}]}
```
Label `style`: label_down (above the point, default), label_up (below), label_left, label_right, label_center, none (text only), circle, square, diamond, triangleup/down, arrowup/down. `yloc`: price (default), abovebar, belowbar. `fontSize` 8–32, `fontWeight` normal/bold, `textAlign`, `textValign`.

## Removing

`remove_overlays {ids:["notes"]}` or `{all:true}` (current symbol only).
