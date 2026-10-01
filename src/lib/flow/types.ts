export interface AggregateTrade {
  symbol:string;id:string;time:number;price:number;baseQuantity:number;quoteQuantity:number;
  aggressor:'buy'|'sell';normalBaseQuantity?:number;
}
export interface FlowAggregation {tickSize:number;timeframeMs:number;priceStepTicks?:number;sessionOffsetMs?:number}
export interface FlowStoreOptions extends FlowAggregation {symbol:string;maxTrades?:number;maxAgeMs?:number;maxPriceLevels?:number;maxFootprintBars?:number}
export interface FlowAmounts {
  buyBase:number;sellBase:number;deltaBase:number;volumeBase:number;
  buyQuote:number;sellQuote:number;deltaQuote:number;volumeQuote:number;
  aggregateCount:number;
}
export interface FlowPriceLevel extends FlowAmounts {tick:number;price:number;priceEnd:number}
export interface FlowGap {fromId:string;toId:string;afterTime:number;beforeTime:number}
export interface FlowFootprintBar extends FlowAmounts {time:number;endTime:number;partial:boolean;levels:FlowPriceLevel[];cvdBase:number;cvdQuote:number}
export interface FlowCoverage {
  fromTime?:number;throughTime?:number;fromId?:string;throughId?:string;
  retainedTrades:number;evictedTrades:number;rejectedTrades:number;conflictingDuplicates:number;
  gaps:FlowGap[];gapCount:number;continuous:boolean;completeHistory:false;
  source:'Binance USDⓈ-M aggTrade'|'Binance USDⓈ-M trades';scope:'retained-public-aggregates'|'persisted-selected-range';
  normalQuantityTrades:number;normalQuantityBase?:number;
  cvdAnchorTime?:number;note:string;
}
export interface TradeFlowSnapshot {
  symbol:string;revision:number;aggregation:FlowAggregation;effectivePriceStepTicks:number;effectivePriceStep:number;
  profile:FlowPriceLevel[];footprint:FlowFootprintBar[];totals:FlowAmounts;coverage:FlowCoverage;
}
export type TradeFlowStatus='idle'|'connecting'|'loading'|'live'|'partial'|'reconnecting'|'stopped'|'error';
export interface TradeFlowSessionSnapshot extends TradeFlowSnapshot {status:TradeFlowStatus;message:string;reconnectAttempts:number;bufferDropped:number;updatedAt:number}

const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function aggregateId(v:unknown):string|undefined {
  if(typeof v==='number')return Number.isSafeInteger(v)&&v>=0?String(v):undefined;
  if(typeof v==='string'&&/^\d{1,25}$/.test(v))return BigInt(v).toString();
}
/** Public REST rows omit s/e, while combined WS wraps the event in data.
 * Buyer-maker=true means the aggressor is SELL, never candle direction. */
export function parseAggregateTrade(raw:unknown,symbol:string):AggregateTrade|undefined {
  if(object(raw)&&object(raw.data))raw=raw.data;
  if(!object(raw)||raw.s!==undefined&&raw.s!==symbol||raw.e!==undefined&&raw.e!=='aggTrade'||typeof raw.m!=='boolean')return;
  const id=aggregateId(raw.a),price=Number(raw.p),baseQuantity=Number(raw.q),time=Number(raw.T);
  if(id===undefined||raw.p==null||raw.q==null||raw.T==null||!Number.isFinite(price)||price<=0||!Number.isFinite(baseQuantity)||baseQuantity<=0||!Number.isSafeInteger(time)||time<0||!Number.isFinite(price*baseQuantity))return;
  const normal=raw.nq===undefined?undefined:Number(raw.nq);
  return {symbol,id,time,price,baseQuantity,quoteQuantity:price*baseQuantity,aggressor:raw.m?'sell':'buy',
    ...(normal!==undefined&&Number.isFinite(normal)&&normal>=0&&normal<=baseQuantity?{normalBaseQuantity:normal}:{})};
}
