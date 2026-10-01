# Public aggregate-trade flow

```ts
const session = createTradeFlowSession({
  symbol: 'BTCUSDT', tickSize: contract.tickSize, timeframeMs: 60_000,
  priceStepTicks: 10,
  onUpdate: snapshot => { /* render profile / footprint / coverage */ },
});
session.connect(); // only while the user enables/opens this module
session.setAggregation({ timeframeMs: 300_000, priceStepTicks: 20 });
session.disconnect(); // stops WS, retries, recovery, and outstanding fetch
```

Construction performs no I/O. A session belongs to one symbol; create a new session on symbol change. `subscribe()` returns an unsubscribe function. Call `disconnect()` when the owning UI closes/unmounts. Fixed-duration UTC bars use `timeframeMs`, with optional `sessionOffsetMs`; a calendar month must not be supplied as a guessed fixed duration.

`profile` contains all retained price levels; `footprint` contains the most recent configured bars, each with price levels and buy/sell/delta/total in both base and quote quantities. `aggregateCount` counts aggregate messages, not participants or individual fills. Data is derived from actual public aggregate trades, never from candle direction or simulated price allocation. `effectivePriceStep` may be coarser than the requested grouping when required to conserve volume within the bounded level budget.

Coverage is explicit: REST only bootstraps the most recent 1000 aggregates; ID gaps trigger at most three pages per recovery round and a 30-second cooldown. A missing period remains a gap, not a zero-volume bar. Buffers, retained events (default 20,000 / one hour), price levels and rendered footprint bars are bounded. Retention eviction resets the retained CVD anchor. First/last or gap-intersecting footprint bars are partial. ID continuity only describes the retained public stream, never full exchange history.

The `m` field means buyer-maker: `true` is aggressive selling. Public `q` includes RPI; optional `nq` is retained separately and never guessed when absent. This stream excludes insurance-fund/ADL trades, and no order-book information can be inferred from it. No account keys or order endpoints are used.

Sources verified 2026-09-23: [Binance public aggregate REST API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#compressedaggregate-trades-list), [official stream model](https://raw.githubusercontent.com/binance/binance-connector-python/master/clients/derivatives_trading_usds_futures/src/binance_sdk_derivatives_trading_usds_futures/websocket_streams/models/aggregate_trade_streams_response.py).
