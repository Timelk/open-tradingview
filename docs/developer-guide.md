# Developer guide

This guide describes the current native charting and analysis application. For the product overview, see the [README](../README.md); the [native-scope validation](native-scope-validation-2026-10-01.md) records the checks and screenshots for this release preparation.

## Running the project

Use **Node.js 24+** and **pnpm 10.33.0**, pinned by `packageManager`. The [workspace configuration](../pnpm-workspace.yaml) allows esbuild to validate its platform binary during installation. Local data services use Node's built-in SQLite; the stdio MCP process uses Node's native TypeScript type stripping.

From the project directory:

```sh
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1
```

Open the address printed by Vite. The default development port is 5173; an occupied port can change it. A fresh browser profile opens **Binance BTCUSDT, 15m, USDⓈ-M perpetual**. Subsequent visits restore the saved market selection.

Public candles and order flow do not require an exchange account or API key. Select the simulated market source to explore the interface without exchange connectivity; its deterministic candles are synthetic data.

Run the development checks when changing code:

```sh
pnpm check
pnpm test
pnpm build
```

To preview the production build, stop the development server first, then run:

```sh
pnpm preview --host 127.0.0.1
```

Use one local server at a time for the same market database: its cross-process writer lock prevents concurrent writers. See the release preparation record above for the completed checks, rather than treating these commands as fresh validation results.

### Optional network configuration

Basic chart use needs no environment file. The [environment example](../.env.example) contains optional `HTTP_PROXY` / `HTTPS_PROXY` settings for local server networking; configure these in a local environment file only when needed.

The [Vite configuration](../vite.config.ts) mounts the public market bridge, archive/recording service, depth sampler and agent bridge in development and preview mode. Serving only `dist/` does not provide their APIs, SQLite services or MCP endpoints. These bridges are designed for loopback, same-origin local access.

## Architecture

| Area | Implementation | Responsibility |
| --- | --- | --- |
| Interface | [App.svelte](../src/App.svelte), [components](../src/components/) | Chart controls, symbol search, indicator library, analysis panels and drawings |
| Chart coordination | [controller.ts](../src/lib/chart/controller.ts) | Market feeds, viewport, scene, rendering and interaction |
| Data core | [core](../src/lib/core/) | TypedArray columns, OHLCV aggregation pyramid, scales and viewport |
| Rendering | [render](../src/lib/render/), [backend.ts](../src/lib/render/backend.ts) | WebGL2 price/indicator primitives, Canvas2D drawings and axes, and fallback rendering |
| Native studies | [indicators](../src/lib/indicators/), [study catalog](../src/lib/studies/catalog.ts) | Incremental calculations, higher-timeframe aggregation, Worker/main-thread execution and discovery |
| Pattern analysis | [patterns](../src/lib/patterns/) | Classic, harmonic and confluence pattern families, confirmation states and evidence |
| Structure and volume | [analysis](../src/lib/analysis/), [flow](../src/lib/flow/) | Market structure, zones, volume observations and supported order-flow data |
| Market sources | [connectors.ts](../src/lib/market/connectors.ts), [feed](../src/lib/feed/) | Source capabilities, public feeds and simulation |
| Scene and drawings | [scene](../src/lib/scene/), [drawing](../src/lib/drawing/) | Objects, layers, groups, transactions, shared undo and registered tools |
| Historical data | [history](../src/lib/history/) | Frozen market datasets and browser caching for historical analysis |
| Local services | [server](../server/) | Public data bridging, archive import, recording, aggregation and SQLite |
| AI bridge | [agent](../src/lib/agent/), [MCP](../mcp/) | Read and annotate the active browser chart through the native scene operations |

The chart core owns candle arrays; Svelte receives interface state and sampled readings. Rendering chooses an aggregation level for the visible range. Native calculations update the dirty tail where supported instead of recalculating the entire history on each quote. The ordinary indicator engine can fall back to its main-thread path.

The library derives its entries from the actual registry. It exposes all three pattern families, structure/volume modules, classic indicators and native signal studies. Signal studies annotate the chart; they do not place orders.

## Local storage

| Location | Contents and lifetime |
| --- | --- |
| Browser localStorage | Scene/drawing documents, layout, appearance, watchlist, favorites, market and connector preferences; scoped to the browser origin |
| Browser IndexedDB | Historical market datasets through [history/persistence.ts](../src/lib/history/persistence.ts); database name `tvchart-script-workspace` is retained for compatibility with existing cached data |
| `.data/market/market.sqlite` | Imported public trades and explicit local trade/L2 recordings; survives server restarts |
| `.data/depth/depth-samples.sqlite` | Recent sampled order-book history; default 15-second cadence, two-day retention and three watched symbols |
| `.data/agent-bridge/hubs/` | Runtime discovery records for local MCP processes |

The IndexedDB implementation uses the `datasets` store. Its historical database name does not describe a current interface feature, and old browser data is not cleared to rename it.

Stopping the local server stops explicit recordings; restarting does not automatically resume them. Closing a sidebar or browser does not stop a recording while the server remains running: use the stop control. The separate depth sampler restores its watched symbols on restart and preserves unsampled gaps. See [market data storage](market-data-storage.md).

Changing the port changes the browser origin and therefore which browser preferences are visible; project SQLite files remain separate. Export drawings and layouts before moving between origins or browser profiles. The AI bridge also distinguishes saved native drawings from session-only overlays, which must be supplied again after a page refresh.

## Implementation boundaries

- The workspace currently has one main price chart, multiple indicator panes and dockable panels. Independent multi-chart grids are a roadmap item.
- Binance USDⓈ-M has the most complete public-data path. Other connectors expose different candle, history and order-flow capabilities; declare and display only what each connector supplies.
- Pattern detections and structure/volume observations are rule-based analysis. Candidate, confirmation, invalidation and data-coverage states remain distinct.
- Historical L2 requires data actually sampled or recorded. Current candles cannot reconstruct unobserved order books; public L2 is aggregated depth, not a per-order queue.
- Large synthetic datasets demonstrate chart behavior; device-specific measurements belong to their recorded validation conditions.

## Connecting an AI client

Start the application and keep its chart open. The local server exposes `/mcp`, `/llms.txt` and `/llms-full.txt`. For a Claude Code HTTP connection, substitute the actual port:

```sh
claude mcp add --transport http open-tradingview http://127.0.0.1:5173/mcp
```

For stdio, run this from the repository root in bash/zsh:

```sh
claude mcp add open-tradingview -- node "$PWD/mcp/server.ts"
```

Other clients can launch `node` with the quoted absolute path to [mcp/server.ts](../mcp/server.ts). The repository's [.mcp.json](../.mcp.json) supplies the project configuration for Claude Code. Stdio discovers running local hubs; HTTP is tied to the configured port.

The [project skill](../.claude/skills/tvchart-agent/SKILL.md) and shared tool definitions generate the live guide. Public names use `open-tradingview`; `tvchart.*` browser keys, `tvchart://` resources, `tvchart_guide`, the skill directory and `TVCHART_*` discovery settings retain their compatibility names.

The bridge reads candles, indicators, drawings, selection, chart structure and native analysis. It can add/edit native drawings and studies, supply computed overlays, and adjust the view. Scene changes follow the interface's validation and undo path. Local AI writes are enabled by default; turn off “Allow AI to edit the chart” in the status bar for read-only use. The bridge has no account authentication and rejects non-loopback/cross-origin requests. See [agent bridge architecture](architecture/agent-bridge.md) for capabilities and the local trust model.

## Extension entry points

- **Indicator or analysis study:** register an `IndicatorDef` in the [indicator registry](../src/lib/indicators/registry.ts). Its input schema supplies controls, and the study catalog supplies discovery. An optional incremental calculator must handle replacement of the current candle and retain a reference `calc` implementation.
- **Drawing tool:** register through [drawing-tools.ts](../src/plugins/drawing-tools.ts). The [price-zone example](../src/plugins/price-zone/) includes a tool and Svelte editor. See [drawing architecture](architecture/drawing-tools.md).
- **Workspace panel:** define metadata in the [panel catalog](../src/lib/workspace/panel-catalog.ts) and connect the component in [workspace-panels.ts](../src/plugins/workspace-panels.ts). Panels receive the native chart/watchlist/analysis context. See [workspace layout](architecture/workspace-layout.md).
- **Market source:** implement and register `MarketConnector` in [connectors.ts](../src/lib/market/connectors.ts), declaring the capabilities it actually supplies.
- **AI tool:** add the method to [protocol.ts](../src/lib/agent/protocol.ts), implement it in [chart-adapter.ts](../src/lib/agent/chart-adapter.ts), expose it in [mcp/tools.ts](../mcp/tools.ts), and update the project skill. Registered drawing tools are already discoverable through the catalog.

Use the [scene entry point](../src/lib/scene/index.ts) and [layer workspace architecture](architecture/layer-workspace.md) for transactions and object operations.

## License status

The project's own license is **pending**. Consult [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for dependency attribution and the release preparation record for outstanding publication decisions. The current guide does not assign a license to the application.
