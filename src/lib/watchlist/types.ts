import type {BinanceContractMetadata} from '../market/binance-contracts';
/** Multi-source market symbol metadata and rolling 24-hour statistics; no account data. */
export interface MarketSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  name?: string;
  source?: string;
  marketType?: string;
  exchangeLabel?: string;
  marketBadge?: string;
  updatedAt?: number;
  contractType?:'PERPETUAL';
  contract?:BinanceContractMetadata;
}
export interface TickerQuote {
  symbol: string;
  last: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  volume: number;
  quoteVolume: number;
  /** Exchange timestamp in milliseconds, retained when a quote becomes stale. */
  updatedAt: number;
}
export interface WatchlistDocument {
  version: 1;
  activeId: string;
  lists: { id: string; name: string; symbols: string[] }[];
}
export interface WatchlistQuoteSnapshot {
  quotes: Record<string, TickerQuote>;
  status: 'loading' | 'live' | 'stale' | 'error';
  error: string;
}
