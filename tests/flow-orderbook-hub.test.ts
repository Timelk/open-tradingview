import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createOrderBookHub,type SharedOrderBookLease} from '../src/lib/flow/orderbook-hub';
import {aggregateOrderBook} from '../src/lib/flow/orderbook-models';
import type {OrderBookSocket} from '../src/lib/flow/orderbook';

const identity={source:'binance',marketType:'usdm-perpetual',symbol:'BTCUSDT'};
const rest=(id=100)=>({lastUpdateId:id,bids:[['100.8','2'],['100.2','3'],['99.2','4']],asks:[['101.2','2'],['101.8','3'],['102.2','1']]});
const message=(patch:Record<string,unknown>={})=>({e:'depthUpdate',s:'BTCUSDT',U:99,u:101,pu:98,T:100,b:[],a:[],...patch});
const response=(body:unknown)=>({ok:true,status:200,json:async()=>body}) as Response;
async function flush(){for(let i=0;i<8;i++)await Promise.resolve();}
class Socket implements OrderBookSocket {
  static instances:Socket[]=[];
  onopen:((event:Event)=>void)|null=null;onmessage:((event:MessageEvent)=>void)|null=null;
  onclose:((event:CloseEvent)=>void)|null=null;onerror:((event:Event)=>void)|null=null;
  close=vi.fn();constructor(readonly url:string){Socket.instances.push(this);}
  open(){this.onopen?.({} as Event);}receive(value:unknown){this.onmessage?.({data:JSON.stringify(value)} as MessageEvent);}
  end(){this.onclose?.({} as CloseEvent);}
}
const leases:SharedOrderBookLease[]=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(1000);Socket.instances=[];});
afterEach(()=>{for(const lease of leases.splice(0))lease.release();vi.useRealTimers();});
function setup(extra:Parameters<typeof createOrderBookHub>[0]={}){
  const request=vi.fn<typeof fetch>().mockResolvedValue(response(rest()));
  const hub=createOrderBookHub({fetch:request,WebSocket:Socket,...extra});
  const acquire=(active=true)=>{const lease=hub.acquire(identity,{active});leases.push(lease);return lease;};
  const connect=async(lease:SharedOrderBookLease)=>{const socket=Socket.instances.at(-1)!;socket.open();socket.receive(message());await flush();expect(lease.snapshot().status).toBe('live');return socket;};
  return {hub,request,acquire,connect};
}

describe('shared current order book',()=>{
  it('shares one source connection and revision without a view release clearing another view',async()=>{
    const h=setup(),a=h.acquire(),b=h.acquire();expect(Socket.instances).toHaveLength(1);
    const socket=await h.connect(a);expect(h.request).toHaveBeenCalledOnce();expect(b.snapshot().revision).toBe(a.snapshot().revision);
    a.release();expect(socket.close).not.toHaveBeenCalled();expect(b.snapshot().status).toBe('live');
    socket.receive(message({U:102,u:102,pu:101,b:[['100.8','4']]}));expect(b.snapshot().revision).toBe(2);
    b.release();expect(socket.close).toHaveBeenCalledOnce();expect(h.hub.size).toBe(0);
  });

  it('pauses only the requesting lease until every active consumer is paused',async()=>{
    const h=setup(),a=h.acquire(),b=h.acquire(),socket=await h.connect(a);
    a.setActive(false);expect(a.snapshot().status).toBe('paused');expect(a.snapshot().bids).toEqual([]);
    expect(b.snapshot().status).toBe('live');expect(socket.close).not.toHaveBeenCalled();
    b.setActive(false);expect(socket.close).toHaveBeenCalledOnce();expect(b.snapshot().status).toBe('paused');
    a.setActive(true);expect(Socket.instances).toHaveLength(2);expect(a.snapshot().status).toBe('connecting');expect(b.snapshot().status).toBe('paused');
  });

  it('isolates market identities and does not silently subscribe spot or unsupported markets to futures',()=>{
    const h=setup(),a=h.acquire();const alias=h.hub.acquire({...identity,symbol:'BTC/USDT'});leases.push(alias);expect(alias.key).toBe(a.key);expect(Socket.instances).toHaveLength(1);
    for(const next of [{...identity,marketType:'spot'},{...identity,source:'okx'},{source:'cn-a',marketType:'cn-equity',symbol:'600519.SH'}]){
      const lease=h.hub.acquire(next);leases.push(lease);expect(lease.snapshot().status).toBe('unsupported');
    }
    expect(Socket.instances).toHaveLength(1);
  });

  it('publishes stale and disconnect states immediately while keeping old history explicitly segmented',async()=>{
    const h=setup(),a=h.acquire(),seen=vi.fn(),off=a.subscribe(seen),socket=await h.connect(a);
    const initial=a.snapshot().history[0];await vi.advanceTimersByTimeAsync(5000);
    expect(a.snapshot()).toMatchObject({status:'stale',bids:[],asks:[]});expect(seen.mock.calls.at(-1)![0].status).toBe('stale');
    expect(a.snapshot().history).toHaveLength(1);
    socket.receive(message({U:102,u:102,pu:101,T:6100,b:[['100.8','4']]}));
    expect(a.snapshot().status).toBe('live');expect(a.snapshot().history.at(-1)!.segmentId).not.toBe(initial.segmentId);
    expect(a.snapshot().segmentId).toBe(a.snapshot().coverage.segmentId);expect(a.snapshot().history.at(-1)!.segmentId).toBe(a.snapshot().segmentId);
    expect(a.snapshot().changes).toEqual([]);socket.end();expect(a.snapshot().status).toBe('resyncing');expect(a.snapshot().bids).toEqual([]);off();
  });

  it('does not count REST, its initial bridge, duplicate diffs or gaps as added liquidity',async()=>{
    const h=setup(),a=h.acquire(),socket=await h.connect(a);expect(a.snapshot().changes).toEqual([]);
    socket.receive(message({U:102,u:102,pu:101,T:200,b:[['100.2','4']]}));
    socket.receive(message({U:103,u:103,pu:102,T:300,b:[['100.2','2']]}));
    socket.receive(message({U:103,u:103,pu:102,T:300,b:[['100.2','999']]}));
    const model=aggregateOrderBook(a.snapshot(),{priceStep:1,unit:'base',windowMs:5000});
    expect(model.changeWindow).toMatchObject({bidAddedBase:1,bidSubtractedBase:2,bidAddedQuote:100.2,bidSubtractedQuote:200.4});
    expect(model.bids[0]).toMatchObject({added:1,subtracted:2});
    socket.receive(message({U:110,u:110,pu:109,b:[['100.2','500']]}));expect(a.snapshot().changes).toEqual([]);expect(a.snapshot().status).toBe('resyncing');
  });

  it('switches 1/5/30-second change windows without subscribing again',async()=>{
    const h=setup(),a=h.acquire(),socket=await h.connect(a);
    await vi.advanceTimersByTimeAsync(1000);socket.receive(message({U:102,u:102,pu:101,b:[['100.2','5']]}));
    await vi.advanceTimersByTimeAsync(2000);socket.receive(message({U:103,u:103,pu:102,b:[['100.2','2']]}));
    await vi.advanceTimersByTimeAsync(500);
    const small=aggregateOrderBook(a.snapshot(),{priceStep:1,windowMs:1000}),large=aggregateOrderBook(a.snapshot(),{priceStep:1,windowMs:5000});
    expect(small.changeWindow).toMatchObject({bidAddedBase:0,bidSubtractedBase:3,covered:true});
    expect(large.changeWindow).toMatchObject({bidAddedBase:2,bidSubtractedBase:3,covered:false});
    aggregateOrderBook(a.snapshot(),{priceStep:1,windowMs:30_000});expect(Socket.instances).toHaveLength(1);expect(h.request).toHaveBeenCalledOnce();
  });

  it('keeps a bounded ring of actual sampled revisions with source and receipt timestamps, never filling silence',async()=>{
    const h=setup({historySamples:3,historyIntervalMs:1000}),a=h.acquire(),socket=await h.connect(a);
    for(let i=0;i<5;i++){await vi.advanceTimersByTimeAsync(1100);socket.receive(message({U:102+i,u:102+i,pu:101+i,T:200+i,b:[['100.2',String(i+1)]]}));}
    const history=a.snapshot().history;expect(history).toHaveLength(3);
    expect(a.snapshot().historyCoverage).toMatchObject({fromTime:4300,throughTime:6500,samples:3,intervalMs:1000,maxSamples:3,levelsPerSide:80});
    expect(history.map(sample=>sample.eventTime)).toEqual([202,203,204]);
    expect(history.every(sample=>sample.time===sample.receivedAt&&sample.availableAt===sample.receivedAt&&sample.time<=Date.now())).toBe(true);
    expect(history.map(sample=>sample.revision)).toEqual([4,5,6]);
    await vi.advanceTimersByTimeAsync(2000);expect(a.snapshot().history).toEqual(history);
    expect(()=>{a.snapshot().bids[0].quantity=999;}).toThrow();expect(a.snapshot().bids[0].quantity).not.toBe(999);
  });

  it('starts fresh after explicit reconnect and reports bounded delta retention loss',async()=>{
    const h=setup({maxChangeLevels:100});h.request.mockResolvedValue(response({...rest(),bids:[...rest().bids,['1','1']]}));
    const a=h.acquire(),socket=await h.connect(a);
    const levels=Array.from({length:101},(_,i)=>[String(50+i*.01),'1']);
    socket.receive(message({U:102,u:102,pu:101,b:levels}));expect(a.snapshot().changeCoverage.truncated).toBe(true);
    expect(aggregateOrderBook(a.snapshot(),{priceStep:1}).changeWindow).toMatchObject({covered:false,truncated:true});
    await a.reconnect();expect(a.snapshot().status).toBe('connecting');expect(a.snapshot().changes).toEqual([]);expect(Socket.instances).toHaveLength(2);
  });

  it('does not label the first observation outside the REST depth boundary as added liquidity',async()=>{
    const h=setup(),a=h.acquire(),socket=await h.connect(a);
    socket.receive(message({U:102,u:102,pu:101,b:[['50','1000']],a:[]}));
    expect(a.snapshot().changes).toEqual([]);
    socket.receive(message({U:103,u:103,pu:102,b:[['50','1002']],a:[]}));
    expect(a.snapshot().changes[0].levels).toEqual([{side:'bid',price:50,addedBase:2,removedBase:0,addedQuote:100,removedQuote:0}]);
  });
});

describe('order-book display aggregation',()=>{
  it('bins bids downward and asks upward, sums exact source notionals and scopes cumulative imbalance to shown rows',async()=>{
    const h=setup(),a=h.acquire();await h.connect(a);
    const base=aggregateOrderBook(a.snapshot(),{priceStep:1,limit:1,unit:'base'});
    expect(base.bids[0]).toMatchObject({price:100,quantityBase:5,quantity:5,cumulative:5});
    expect(base.asks[0]).toMatchObject({price:102,quantityBase:5,quantity:5,cumulative:5});
    expect(base.bids[0].quantityQuote).toBeCloseTo(502.2,10);expect(base.asks[0].quantityQuote).toBeCloseTo(507.8,10);
    expect(base.spread).toBeCloseTo(.4);expect(base.bestBid).toBe(100.8);expect(base.bestAsk).toBe(101.2);expect(base.imbalance).toBe(0);
    const quote=aggregateOrderBook(a.snapshot(),{priceStep:1,limit:2,unit:'quote'});
    expect(quote.bids[1].cumulativeBase).toBe(9);expect(quote.bids[1].cumulative).toBeCloseTo(899);
    expect(quote.range).toMatchObject({bidLevels:2,askLevels:2,bidBase:9,askBase:6});
    expect(quote.imbalance).toBeCloseTo((899-610)/(899+610));
  });

  it('retains removals for vanished levels, handles decimal steps and rejects invalid bucket widths',async()=>{
    const h=setup(),a=h.acquire(),socket=await h.connect(a);
    socket.receive(message({U:102,u:102,pu:101,b:[['100.8','0']],a:[]}));
    const model=aggregateOrderBook(a.snapshot(),{priceStep:.1});expect(model.bestBid).toBe(100.2);
    expect(model.deltas.bids.find(level=>level.price===100.8)?.subtractedQuote).toBeCloseTo(201.6);
    expect(model.bids[0].price).toBe(100.2);expect(model.asks[0].price).toBe(101.2);
    expect(()=>aggregateOrderBook(a.snapshot(),{priceStep:0})).toThrow();expect(()=>aggregateOrderBook(a.snapshot(),{priceStep:NaN})).toThrow();
  });
});

describe('released book retention',()=>{
  it('keeps sampled history across a quick re-acquire (interval switch) and retires after the grace period',async()=>{
    const {hub,acquire,connect}=setup({retainMs:60_000});
    const first=acquire();await connect(first);
    const sampled=first.snapshot().history.length;expect(sampled).toBeGreaterThan(0);
    first.release();expect(hub.size).toBe(1);
    vi.advanceTimersByTime(5_000);
    const again=acquire();expect(hub.size).toBe(1);
    expect(again.snapshot().history.length).toBeGreaterThanOrEqual(sampled);
    again.release();vi.advanceTimersByTime(59_999);expect(hub.size).toBe(1);
    vi.advanceTimersByTime(1);expect(hub.size).toBe(0);
  });
  it('retires immediately without a grace period (default)',async()=>{
    const {hub,acquire,connect}=setup();const lease=acquire();await connect(lease);lease.release();expect(hub.size).toBe(0);
  });
});

describe('pooled heatmap history',()=>{
  it('pools raw levels into decade-relative bins, bids floored and asks ceiled, nearest first',async()=>{
    const {poolLevels}=await import('../src/lib/flow/orderbook-hub');
    expect(poolLevels([{price:100.8,quantity:2},{price:100.2,quantity:3},{price:99.2,quantity:4}],1,'bid')).toEqual([{price:100,quantity:5},{price:99,quantity:4}]);
    expect(poolLevels([{price:101.2,quantity:2},{price:101.8,quantity:3},{price:102.2,quantity:1}],1,'ask')).toEqual([{price:102,quantity:5},{price:103,quantity:1}]);
    expect(poolLevels([{price:0,quantity:1},{price:5,quantity:0}],1,'bid')).toEqual([]);
  });
  it('keeps the full maintained depth in history samples when enabled',async()=>{
    const {acquire,connect}=setup({historyBinRatio:.01,historyLevels:5});
    const lease=acquire();await connect(lease);
    const sample=lease.snapshot().history.at(-1)!;// mid ≈ 100 → decade 100 → 1.0 bins
    expect(sample.bids.map(level=>level.price)).toEqual([100,99]);expect(sample.asks.map(level=>level.price)).toEqual([102,103]);
    expect(sample.bids[0].quantity).toBe(5);expect(Object.isFrozen(sample.bids)).toBe(true);
  });
});

describe('bounded depth window',()=>{
  const snapshotOf=(bids:string[][],asks:string[][])=>({lastUpdateId:100,bids,asks});
  it('exposes bookLevels rows per side and cuts live and history at ±depthRangeRatio of the mid',async()=>{
    const bids=Array.from({length:400},(_,i)=>[(100-i*.1).toFixed(1),'1']),asks=Array.from({length:400},(_,i)=>[(100.2+i*.1).toFixed(1),'2']);
    const request=vi.fn<typeof fetch>().mockResolvedValue(response(snapshotOf(bids,asks)));
    const hub=createOrderBookHub({fetch:request,WebSocket:Socket,bookLevels:300,depthRangeRatio:.1,historySamples:5,historyIntervalMs:100,historyLevels:1000,historyBinRatio:1e-3});
    const lease=hub.acquire(identity);leases.push(lease);Socket.instances.at(-1)!.open();Socket.instances.at(-1)!.receive(message());await flush();
    const snapshot=lease.snapshot(),mid=(snapshot.bids[0].price+snapshot.asks[0].price)/2;
    expect(snapshot.bids.length).toBeLessThanOrEqual(300);expect(snapshot.asks.length).toBeLessThanOrEqual(300);
    expect(snapshot.bids.every(l=>l.price>=mid*.9)).toBe(true);expect(snapshot.asks.every(l=>l.price<=mid*1.1)).toBe(true);
    expect(snapshot.coverage.depthPerSide).toBe(300);
    const sample=snapshot.history.at(-1)!;expect(sample.bids.length).toBeGreaterThan(0);
    // Pooled to 1e-3 of the decade (100 → 0.1): floor for bids, ceil for asks, all inside the window.
    expect(sample.bids.every(l=>l.price>=mid*.9-.1)).toBe(true);expect(sample.asks.every(l=>l.price<=mid*1.1+.1)).toBe(true);
  });
  it('keeps the previous unbounded behavior when no range or depth is requested',async()=>{
    const h=setup(),lease=h.acquire();await h.connect(lease);
    expect(lease.snapshot().coverage.depthPerSide).toBe(1000);expect(lease.snapshot().bids.map(l=>l.price)).toEqual([100.8,100.2,99.2]);
  });
});
