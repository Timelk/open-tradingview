import type {BookLevel,BookStatus} from './orderbook';
import type {SharedBookSnapshot} from './orderbook-hub';

export type BookUnit='base'|'quote';
export interface AggregatedBookLevel {
  price:number;quantityBase:number;quantityQuote:number;quantity:number;
  cumulativeBase:number;cumulativeQuote:number;cumulative:number;
  addedBase:number;subtractedBase:number;addedQuote:number;subtractedQuote:number;added:number;subtracted:number;
}
export interface AggregatedBook {
  status:BookStatus;revision:number;unit:BookUnit;priceStep:number;bids:AggregatedBookLevel[];asks:AggregatedBookLevel[];
  /** Changes may include a removed price bucket with no remaining current size. */
  deltas:{bids:AggregatedBookLevel[];asks:AggregatedBookLevel[]};
  bestBid:number|null;bestAsk:number|null;mid:number|null;spread:number|null;spreadBps:number|null;
  /** (bid-ask)/(bid+ask), measured only over returned current price buckets. */
  imbalance:number|null;
  range:{limitPerSide:number;bidLevels:number;askLevels:number;bidBase:number;askBase:number;bidQuote:number;askQuote:number;bidLow:number|null;askHigh:number|null};
  changeWindow:{/** False means deliberately not computed, never observed zero activity. */included?:false;windowMs:number;fromTime:number;throughTime:number;covered:boolean;truncated:boolean;
    bidAddedBase:number;bidSubtractedBase:number;askAddedBase:number;askSubtractedBase:number;
    bidAddedQuote:number;bidSubtractedQuote:number;askAddedQuote:number;askSubtractedQuote:number};
}
export interface AggregateOrderBookOptions {priceStep:number;limit?:number;unit?:BookUnit;windowMs?:number;now?:number;
  /** Stock-only profiles do not need change-window scans or delta aggregation. */includeChanges?:boolean}
const finite=(n:number)=>Number.isFinite(n);
const blank=(price:number):AggregatedBookLevel=>({price,quantityBase:0,quantityQuote:0,quantity:0,cumulativeBase:0,cumulativeQuote:0,cumulative:0,
  addedBase:0,subtractedBase:0,addedQuote:0,subtractedQuote:0,added:0,subtracted:0});
function bucket(price:number,step:number,side:'bid'|'ask'):number {
  const ratio=price/step,epsilon=Number.EPSILON*Math.max(1,Math.abs(ratio))*8;
  return side==='bid'?Math.floor(ratio+epsilon):Math.ceil(ratio-epsilon);
}
const bucketPrice=(index:number,step:number)=>Number((index*step).toPrecision(15));

/** Bids aggregate downward, asks upward, preserving non-crossing display bins.
 * Quote notional is always sum(source price * source quantity), never bucket
 * price * total quantity. Cumulative depth walks outward from the best price. */
export function aggregateOrderBook(snapshot:SharedBookSnapshot,options:AggregateOrderBookOptions):AggregatedBook {
  const {priceStep}=options;if(!finite(priceStep)||priceStep<=0)throw Error('Price step must be positive and finite');
  const unit=options.unit==='quote'?'quote':'base',limit=Number.isFinite(options.limit)?Math.max(1,Math.min(1000,Math.round(options.limit!))):40;
  const now=finite(options.now??NaN)?options.now!:snapshot.capturedAt,windowMs=Number.isFinite(options.windowMs)?Math.max(1,Math.min(300_000,Math.round(options.windowMs!))):5000;
  const fromTime=now-windowMs,live=snapshot.status==='live',includeChanges=options.includeChanges!==false,maps={bid:new Map<number,AggregatedBookLevel>(),ask:new Map<number,AggregatedBookLevel>()};
  const changes={bid:new Map<number,AggregatedBookLevel>(),ask:new Map<number,AggregatedBookLevel>()};
  const row=(map:Map<number,AggregatedBookLevel>,index:number)=>{let value=map.get(index);if(!value){value=blank(bucketPrice(index,priceStep));map.set(index,value);}return value;};
  for(const [side,levels] of [['bid',live?snapshot.bids:[]],['ask',live?snapshot.asks:[]]] as const){
    for(const {price,quantity} of levels){
      if(!finite(price)||price<=0||!finite(quantity)||quantity<=0)continue;
      const value=row(maps[side],bucket(price,priceStep,side));value.quantityBase+=quantity;value.quantityQuote+=price*quantity;
    }
  }
  const changeWindow:AggregatedBook['changeWindow']={windowMs,fromTime,throughTime:now,...(!includeChanges?{included:false as const}:{}),
    covered:includeChanges&&live&&snapshot.changeCoverage.fromTime!==null&&snapshot.changeCoverage.fromTime<=fromTime,
    truncated:includeChanges&&snapshot.changeCoverage.truncated&&snapshot.changeCoverage.fromTime!==null&&snapshot.changeCoverage.fromTime>fromTime,
    bidAddedBase:0,bidSubtractedBase:0,askAddedBase:0,askSubtractedBase:0,bidAddedQuote:0,bidSubtractedQuote:0,askAddedQuote:0,askSubtractedQuote:0};
  for(const batch of live&&includeChanges?snapshot.changes:[]){
    if(batch.receivedAt<fromTime||batch.receivedAt>now||batch.segmentId!==snapshot.coverage.segmentId)continue;
    for(const change of batch.levels){
      const index=bucket(change.price,priceStep,change.side),value=row(changes[change.side],index);
      value.addedBase+=change.addedBase;value.subtractedBase+=change.removedBase;value.addedQuote+=change.addedQuote;value.subtractedQuote+=change.removedQuote;
      const side=change.side;changeWindow[`${side}AddedBase`]+=change.addedBase;changeWindow[`${side}SubtractedBase`]+=change.removedBase;
      changeWindow[`${side}AddedQuote`]+=change.addedQuote;changeWindow[`${side}SubtractedQuote`]+=change.removedQuote;
    }
  }
  const sort=(map:Map<number,AggregatedBookLevel>,side:'bid'|'ask')=>[...map.values()].sort((a,b)=>side==='bid'?b.price-a.price:a.price-b.price);
  const finish=(rows:AggregatedBookLevel[])=>{let base=0,quote=0;return rows.map(item=>{
    base+=item.quantityBase;quote+=item.quantityQuote;
    return {...item,quantity:unit==='quote'?item.quantityQuote:item.quantityBase,cumulativeBase:base,cumulativeQuote:quote,cumulative:unit==='quote'?quote:base,
      added:unit==='quote'?item.addedQuote:item.addedBase,subtracted:unit==='quote'?item.subtractedQuote:item.subtractedBase};
  });};
  for(const side of ['bid','ask'] as const)for(const [index,delta] of changes[side]){
    const current=maps[side].get(index);if(current)Object.assign(current,{addedBase:delta.addedBase,subtractedBase:delta.subtractedBase,addedQuote:delta.addedQuote,subtractedQuote:delta.subtractedQuote});
  }
  const bids=finish(sort(maps.bid,'bid').slice(0,limit)),asks=finish(sort(maps.ask,'ask').slice(0,limit));
  const bidBase=bids.at(-1)?.cumulativeBase??0,askBase=asks.at(-1)?.cumulativeBase??0,bidQuote=bids.at(-1)?.cumulativeQuote??0,askQuote=asks.at(-1)?.cumulativeQuote??0;
  const price=(levels:BookLevel[],side:'bid'|'ask')=>levels.length?(side==='bid'?Math.max(...levels.map(level=>level.price)):Math.min(...levels.map(level=>level.price))):null;
  const bestBid=live?price(snapshot.bids,'bid'):null,bestAsk=live?price(snapshot.asks,'ask'):null,mid=bestBid!==null&&bestAsk!==null?(bestBid+bestAsk)/2:null;
  const spread=bestBid!==null&&bestAsk!==null?bestAsk-bestBid:null,total=unit==='quote'?bidQuote+askQuote:bidBase+askBase;
  return {status:snapshot.status,revision:snapshot.revision,unit,priceStep,bids,asks,deltas:{bids:finish(sort(changes.bid,'bid')),asks:finish(sort(changes.ask,'ask'))},bestBid,bestAsk,mid,spread,
    spreadBps:spread!==null&&mid!==null&&mid>0?spread/mid*10000:null,imbalance:total>0?(unit==='quote'?bidQuote-askQuote:bidBase-askBase)/total:null,
    range:{limitPerSide:limit,bidLevels:bids.length,askLevels:asks.length,bidBase,askBase,bidQuote,askQuote,bidLow:bids.at(-1)?.price??null,askHigh:asks.at(-1)?.price??null},changeWindow};
}
