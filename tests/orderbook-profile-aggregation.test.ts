import {describe,expect,it} from 'vitest';
import {aggregateOrderBook} from '../src/lib/flow/orderbook-models';
import type {SharedBookSnapshot} from '../src/lib/flow/orderbook-hub';
function fixture():SharedBookSnapshot{return {
  identity:{source:'binance',symbol:'BTCUSDT',marketType:'usdm-perpetual'},key:'fixture',symbol:'BTCUSDT',supported:true,status:'live',revision:2,segmentId:1,
  updatedAt:10000,lastReceivedAt:10000,lastUpdateId:2,capturedAt:10000,
  bids:[{price:100.8,quantity:2},{price:100.2,quantity:3},{price:99.2,quantity:4}],asks:[{price:101.2,quantity:2},{price:101.8,quantity:3},{price:102.2,quantity:1}],history:[],
  coverage:{fromTime:0,throughTime:10000,receivedFromTime:0,receivedThroughTime:10000,segmentId:1,depthPerSide:1000},
  historyCoverage:{fromTime:null,throughTime:null,samples:0,intervalMs:1000,maxSamples:300,levelsPerSide:100},changeCoverage:{fromTime:0,throughTime:10000,truncated:false},
  changes:[{receivedAt:9000,eventTime:8999,revision:2,segmentId:1,levels:[{side:'bid',price:100.2,addedBase:5,removedBase:1,addedQuote:501,removedQuote:100.2},{side:'ask',price:101.2,addedBase:2,removedBase:3,addedQuote:202.4,removedQuote:303.6}]}],
};}
const stock=(value:ReturnType<typeof aggregateOrderBook>)=>({status:value.status,revision:value.revision,unit:value.unit,priceStep:value.priceStep,
  bids:value.bids.map(({price,quantityBase,quantityQuote,quantity,cumulativeBase,cumulativeQuote,cumulative})=>({price,quantityBase,quantityQuote,quantity,cumulativeBase,cumulativeQuote,cumulative})),
  asks:value.asks.map(({price,quantityBase,quantityQuote,quantity,cumulativeBase,cumulativeQuote,cumulative})=>({price,quantityBase,quantityQuote,quantity,cumulativeBase,cumulativeQuote,cumulative})),
  bestBid:value.bestBid,bestAsk:value.bestAsk,mid:value.mid,spread:value.spread,spreadBps:value.spreadBps,imbalance:value.imbalance,range:value.range});
describe('stock-only depth profile aggregation',()=>{
  it.each(['base','quote'] as const)('keeps %s grouping, source notionals, cumulative levels and displayed range identical',unit=>{
    const book=fixture(),options={priceStep:1,limit:2,unit,windowMs:5000,now:10000};
    expect(stock(aggregateOrderBook(book,{...options,includeChanges:false}))).toEqual(stock(aggregateOrderBook(book,options)));
    const profile=aggregateOrderBook(book,{...options,includeChanges:false});
    expect(profile.bids[0]).toMatchObject({price:100,quantityBase:5});expect(profile.bids[0].quantityQuote).toBeCloseTo(502.2);
    expect(profile.asks[0]).toMatchObject({price:102,quantityBase:5});expect(profile.asks[0].quantityQuote).toBeCloseTo(507.8);
    expect(profile.deltas).toEqual({bids:[],asks:[]});expect(profile.changeWindow).toMatchObject({included:false,covered:false,truncated:false});
  });
  it('never reads changes or their coverage in the explicit stock-only path',()=>{
    const book=fixture();Object.defineProperty(book,'changes',{get(){throw Error('changes must not be scanned');}});Object.defineProperty(book,'changeCoverage',{get(){throw Error('change coverage must not be scanned');}});
    expect(()=>aggregateOrderBook(book,{priceStep:1,includeChanges:false})).not.toThrow();
    expect(()=>aggregateOrderBook(book,{priceStep:1})).toThrow('change coverage');
  });
  it('keeps default Book/Delta semantics and explicit true output unchanged',()=>{
    const book=fixture(),normal=aggregateOrderBook(book,{priceStep:1,now:10000,windowMs:5000});
    expect(aggregateOrderBook(book,{priceStep:1,now:10000,windowMs:5000,includeChanges:true})).toEqual(normal);
    expect(normal.changeWindow).not.toHaveProperty('included');expect(normal.changeWindow).toMatchObject({covered:true,bidAddedBase:5,bidSubtractedBase:1,askAddedBase:2,askSubtractedBase:3});
    expect(normal.bids[0]).toMatchObject({added:5,subtracted:1});expect(normal.deltas.bids).toHaveLength(1);
  });
  it('retains unavailable-book semantics without accessing retained changes',()=>{
    const book={...fixture(),status:'paused' as const};Object.defineProperty(book,'changes',{get(){throw Error('must not read retained deltas');}});
    const profile=aggregateOrderBook(book,{priceStep:.1,includeChanges:false});expect(profile.bids).toEqual([]);expect(profile.asks).toEqual([]);expect(profile.bestBid).toBeNull();expect(profile.imbalance).toBeNull();
  });
});
