/** Frozen market data shared by chart analysis, recording, and connectors. */
import type {BarInput} from '../core/types';
import type {BinanceContractMetadata} from '../market/binance-contracts';
import type {MarketSourceId,MarketTypeId} from '../market/connectors';

export type MarketBar=BarInput;
export interface DatasetSnapshot {
  id?:string;source:MarketSourceId|'import';symbol:string;interval:string;
  bars:readonly MarketBar[];
  tickSize?:number;quoteCurrency?:string;timezone?:string;
  marketType?:MarketTypeId;contract?:BinanceContractMetadata;
  /** Optional exchange mark-price observations aligned by candle open time. */
  markPrices?:readonly {time:number;close:number}[];
}
