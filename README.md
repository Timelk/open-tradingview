# open-tradingview

### Fluid charts. Visible market structure. Your own AI Agent.

A local crypto charting and analysis workspace with a custom WebGL renderer, three pattern families, technical indicators, structure and volume analysis, and an MCP bridge for your AI agent.

**Free to run locally · Public market data without an API key · English / 中文**

Early preview · MIT licensed · Built in the open

[中文](README.zh-CN.md) · [Quick start](#quick-start) · [Patterns](#three-pattern-families-one-chart) · [AI Agent](#let-your-ai-agent-work-on-the-chart) · [Developer guide](docs/developer-guide.md)

![Live crypto workspace with moving averages, Bollinger Bands, volume, MACD and RSI](docs/assets/screenshots/native-2026-10-01/workspace.png)

*Actual application screenshots, captured October 1, 2026. Market views use Binance public data; the separately labeled million-candle view uses simulation.*

## Start with the chart

- **Move through price action.** Pan, zoom, inspect candles, and resize indicator panes using the custom WebGL2/Canvas renderer.
- **Compare three approaches to patterns.** Classic structures, harmonic ratios, and price-volume confluence share the chart and evidence workspace.
- **Build your indicator view.** MA, EMA, Bollinger Bands, Volume, MACD, KDJ and RSI, with configurable inputs, styles, repeated instances and current or higher calculation intervals.
- **Connect price to structure and volume.** Inspect BOS/CHoCH, sweeps, supply/demand zones, FVGs, Order Blocks, VSA, Wyckoff and other native modules.
- **Find a market, then find a study.** Search symbols across supported sources; browse and preview indicators, signal strategies, patterns and analysis in one library.
- **Bring an AI Agent into the workflow.** Let your own agent read structured chart data, measure market structure, add editable annotations and undo its changes.

## Quick start

Use **Node.js 24+** and **pnpm 10.33.0**:

```sh
git clone https://github.com/Timelk/open-tradingview.git
cd open-tradingview
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1
```

Open the address printed in the terminal, usually `http://127.0.0.1:5173`. A fresh workspace starts with **Binance BTCUSDT perpetual, 15m**. Public market data requires no exchange account or API key.

1. Search a symbol from the toolbar.
2. Open **Indicators & Strategies** to add RSI or Bollinger Bands.
3. Choose **Three pattern families** or open **Analysis → Chart patterns**.
4. Open **Analysis → Structure & volume** to add a native analysis module.
5. Connect your AI client when you want it to inspect or annotate the chart.

The local Node service provides public data transport, SQLite archives and MCP. A static `dist/` deployment does not include these local services. [Run modes and storage](docs/developer-guide.md#running-the-project).

## A renderer built for chart interaction

The chart engine owns its data and rendering pipeline: TypedArray columns, multi-resolution OHLCV aggregation, incremental indicator calculations in a Worker, and WebGL2 drawing with Canvas fallback. The interface receives sampled readings rather than a component for every candle.

Price, volume and oscillator panes share the time axis while retaining their own scales. Resize panes, maximize a view, snap the crosshair, draw on the chart and organize objects without switching workspaces.

[Million-candle simulation](docs/assets/screenshots/native-2026-10-01/million-candles-simulation.png) · [Current verification and performance scope](docs/native-scope-validation-2026-10-01.md)

The synthetic million-candle test reached about **60 FPS** during continuous zoom on an Apple M5, 1600×1000/DPR1, with five indicators; frame P95 was about **4.3 ms**. Dense historical divergences use pixel-density rendering while retaining the full evidence archive. Performance depends on hardware, viewport, range and modules. [Measurement](docs/assets/screenshots/native-2026-10-01/render-performance.json).

## Three pattern families, one chart

| Family | What it adds |
| --- | --- |
| **Classic patterns** | Triangles, wedges, head-and-shoulders, double tops/bottoms, channels, flags and additional structures |
| **Harmonic patterns** | AB=CD and other Fibonacci-ratio families, completion zones and developing candidates |
| **Confluence patterns** | Trend breakouts and dual-divergence reversals with volume and initial risk/reward gates |

![Classic, harmonic and confluence detections with confirmation and invalidation states](docs/assets/screenshots/native-2026-10-01/pattern-analysis.png)

Inspect candidates, confirmed structures, breakouts, retests and invalidations. Click a result to locate its evidence, adjust detector inputs, or convert an observation into an editable drawing. Results describe explicit rules and loaded data coverage.

[Browse the three-family library](docs/assets/screenshots/native-2026-10-01/three-pattern-families.png).

## Indicators, structure and volume in context

A moving average describes a trend; a structure break, a sweep or a volume event adds context. Native analysis modules place those observations alongside the price chart, with their first-known time, anchors and supporting evidence.

![Market structure, BOS/CHoCH and Volume Spread Analysis on the live chart](docs/assets/screenshots/native-2026-10-01/structure-volume.png)

The library currently contains **7 classic indicators, 2 native signal strategies, 3 pattern families and 14 structure/volume modules**. Indicator instances can be repeated and configured independently; the current scene limit is 64 indicator instances.

Signal strategies mark conditions such as moving-average crosses or RSI thresholds. A future self-developed strategy/backtesting engine is on the roadmap.

## Search the market. Build the view.

Search by symbol, name or pair, filter by source and quote currency, preview a market and add it to your watchlist. Binance perpetual markets are the most complete path; OKX perpetual and Coinbase spot connectors have differing capabilities.

![Symbol search with source filters, live prices and market previews](docs/assets/screenshots/native-2026-10-01/symbol-search.png)

The **Indicators & Strategies** dialog brings search, favorites, native study categories, parameter defaults and real indicator previews together. Patterns and analysis appear on the actual chart after adding them.

![Native indicator and signal-strategy library with a real chart preview](docs/assets/screenshots/native-2026-10-01/indicator-library.png)

[Structure & volume library](docs/assets/screenshots/native-2026-10-01/structure-library.png).

## Let your AI Agent work on the chart

The local MCP bridge gives an agent structured access to candles, indicator outputs, patterns, market structure, drawings and the visible chart layout. It can measure levels, draw at precise time/price coordinates, add native indicators and create overlays through the same scene operations as the interface.

![Live AI client connection, measured support/resistance and an OLS trend annotation](docs/assets/screenshots/native-2026-10-01/ai-agent.png)

*These annotations were created through a real MCP client using the current chart's structure results. The support/resistance levels and fitted trend are measurements; the screenshot presents no trade execution.*

- Read and measure the current chart through 21 MCP tools.
- Group and edit AI annotations in the object tree.
- Undo a write, or turn off chart modification permission in the status bar.
- Use your own AI client; no hosted model account is built into the app.

For Claude Code, using the actual app port:

```sh
claude mcp add --transport http open-tradingview http://127.0.0.1:5173/mcp
```

Open `/llms.txt` on the running app for the integration guide. [AI connection screenshot](docs/assets/screenshots/native-2026-10-01/ai-agent-connection.png) · [MCP architecture](docs/architecture/agent-bridge.md).

## More native tools

Drawing tools, snapping, undo/redo, grouped layers, saved layouts, watchlists, historical analysis replay and local trade/depth archives are available. Binance USDT perpetual order flow includes the book, Delta/CVD, Footprint, Profile and observed depth heatmaps. Coverage and gaps are explicit. [Data storage](docs/market-data-storage.md).

## Roadmap

- [x] Native chart renderer, indicator panes and configurable workspace.
- [x] Classic, harmonic and confluence patterns; structure and volume analysis.
- [x] Symbol search, study library, drawings and a local AI Agent bridge.
- [ ] Improve rendering under dense historical evidence and large data ranges.
- [ ] Build linked multi-chart layouts, starting with two charts.
- [ ] Develop our own strategy calculation and backtesting engine as a separate future project phase.
- [ ] Expand connector coverage, analysis replay and shared research datasets.
- [x] Publish the first MIT-licensed source preview with clean-checkout validation.

The current application has one price chart with indicator panes and dockable panels. PineTS, Pine editing and strategy backtesting have been removed from this preview.

## Development and contribution

```sh
pnpm check
pnpm test
pnpm build
```

Useful contributions include reproducible interaction bugs, rendering benchmarks, study definitions, exchange connectors, translations and minimal data/evidence cases. Include the source, symbol, interval and steps when reporting a problem.

[Developer guide](docs/developer-guide.md) · [Drawing extensions](docs/architecture/drawing-tools.md) · [Layer workspace](docs/architecture/layer-workspace.md)

## License

Licensed under [MIT](LICENSE). Third-party dependencies retain their own licenses and original notices, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). PineTS and Monaco are no longer runtime dependencies.

open-tradingview is an independent project, unaffiliated with TradingView or any exchange. Trademarks belong to their respective owners.
