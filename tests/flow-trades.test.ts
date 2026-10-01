import {afterEach,describe,expect,it,vi} from 'vitest';
import {parseAggregateTrade} from '../src/lib/flow/types';
import {TradeFlowStore} from '../src/lib/flow/store';
import {createTradeFlowSession,type FlowSocket} from '../src/lib/flow/session';

const raw=(id:number|string,time=100_000,price='100.10',quantity='2',maker=false)=>({a:id,T:time,p:price,q:quantity,m:maker});
const trade=(id:number|string,time=100_000,price='100.10',quantity='2',maker=false)=>parseAggregateTrade(raw(id,time,price,quantity,maker),'BTCUSDT')!;
const config={symbol:'BTCUSDT',tickSize:.1,timeframeMs:60_000};
class Socket implements FlowSocket {
  onopen:FlowSocket['onopen']=null;onmessage:FlowSocket['onmessage']=null;onclose:FlowSocket['onclose']=null;onerror:FlowSocket['onerror']=null;
  closed=false;open(){this.onopen?.(new Event('open'));}message(value:unknown){this.onmessage?.({data:JSON.stringify(value)} as MessageEvent);}
  break(){this.onclose?.({} as CloseEvent);}close(){this.closed=true;}
}
const settle=()=>vi.advanceTimersByTimeAsync(0);
afterEach(()=>vi.useRealTimers());

describe('public aggTrade semantics and bounded price/time aggregation',()=>{
  it('maps buyer maker to aggressive SELL and keeps quote/base and optional RPI quantities distinct',()=>{
    const sell=parseAggregateTrade({...raw(1,10,'100.25','2',true),nq:'1.5'},'BTCUSDT')!;
    expect(sell.aggressor).toBe('sell');expect(sell.baseQuantity).toBe(2);expect(sell.quoteQuantity).toBe(200.5);expect(sell.normalBaseQuantity).toBe(1.5);
    expect(parseAggregateTrade({data:{...raw(2),s:'BTCUSDT',e:'aggTrade'}},'BTCUSDT')?.aggressor).toBe('buy');
    expect(parseAggregateTrade({...raw(3),s:'ETHUSDT'},'BTCUSDT')).toBeUndefined();
    expect(parseAggregateTrade({...raw(4),m:'true'},'BTCUSDT')).toBeUndefined();
    expect(parseAggregateTrade({...raw(5),nq:'5'},'BTCUSDT')?.normalBaseQuantity).toBeUndefined();
    expect(parseAggregateTrade(raw('9007199254740993123'),'BTCUSDT')?.id).toBe('9007199254740993123');
    expect(parseAggregateTrade(raw(Number.MAX_SAFE_INTEGER+1),'BTCUSDT')).toBeUndefined();
    expect(parseAggregateTrade({...raw(1),T:null},'BTCUSDT')).toBeUndefined();
  });
  it('deduplicates REST/WS overlap and repairs out-of-order IDs without double-counting profile or footprint',()=>{
    const store=new TradeFlowStore(config);
    store.ingest([trade(10,60_010,'100.10','2'),trade(12,120_010,'100.20','4',true)]);
    expect(store.snapshot().coverage.gapCount).toBe(1);
    store.ingest([trade(11,90_000,'100.10','3',true),trade(10,60_010,'100.10','2')]);
    const snapshot=store.snapshot();expect(snapshot.coverage.continuous).toBe(true);expect(snapshot.coverage.retainedTrades).toBe(3);
    expect(snapshot.totals).toMatchObject({buyBase:2,sellBase:7,deltaBase:-5,volumeBase:9,aggregateCount:3});
    expect(snapshot.profile.reduce((v,p)=>v+p.volumeBase,0)).toBe(9);expect(snapshot.footprint.flatMap(b=>b.levels).reduce((v,p)=>v+p.volumeBase,0)).toBe(9);
    expect(snapshot.footprint.at(-1)?.cvdBase).toBe(-5);expect(snapshot.totals.volumeQuote).toBeCloseTo(901.3);
    expect(snapshot.profile.find(p=>p.price===100.10000000000001)?.volumeBase??snapshot.profile.find(p=>Math.abs(p.price-100.1)<1e-9)?.volumeBase).toBe(5);
    expect(snapshot.footprint.every(b=>b.partial)).toBe(true);expect(snapshot.coverage.completeHistory).toBe(false);
  });
  it('reaggregates retained raw events for new tick bins/timeframe without fabricating extra quantity',()=>{
    const store=new TradeFlowStore(config);store.ingest([trade(1,60_000,'100.1','2'),trade(2,120_000,'100.2','3',true),trade(3,180_001,'100.3','4')]);
    const total=store.snapshot().totals;
    store.setAggregation({priceStepTicks:10,timeframeMs:300_000});
    const next=store.snapshot();expect(next.profile).toHaveLength(1);expect(next.footprint).toHaveLength(1);expect(next.totals).toEqual(total);expect(next.profile[0].price).toBe(100);
    store.setAggregation({tickSize:.01,priceStepTicks:1,timeframeMs:60_000});
    expect(store.snapshot().profile).toHaveLength(3);expect(store.snapshot().totals).toEqual(total);
    expect(()=>store.setAggregation({tickSize:1e-30})).toThrow();expect(store.snapshot().aggregation.tickSize).toBe(.01);
  });
  it('coarsens excess levels while conserving volumes and bounds retained events/footprint bars',()=>{
    const store=new TradeFlowStore({...config,maxTrades:100,maxPriceLevels:8,maxFootprintBars:3,maxAgeMs:172_800_000});
    store.ingest(Array.from({length:150},(_,i)=>trade(i,i*60_000,String(100+i*.1),'1',i%2===0)));
    const snap=store.snapshot();expect(snap.profile.length).toBeLessThanOrEqual(8);expect(snap.coverage.retainedTrades).toBe(100);expect(snap.coverage.evictedTrades).toBe(50);expect(snap.footprint).toHaveLength(3);
    expect(snap.totals.volumeBase).toBe(100);expect(snap.profile.reduce((sum,v)=>sum+v.volumeBase,0)).toBe(100);expect(snap.effectivePriceStepTicks).toBeGreaterThan(1);
    expect(store.ingest([trade(1,60_000)])).toBe(0);expect(store.size).toBe(100);
  });
  it('reports gaps/conflicting duplicate evidence and never overwrites existing quantities',()=>{
    const store=new TradeFlowStore(config);store.ingest([trade(1),trade(3)]);store.ingest([trade(1,100_000,'100.10','200')]);
    const snap=store.snapshot();expect(snap.totals.volumeBase).toBe(4);expect(snap.coverage.conflictingDuplicates).toBe(1);expect(snap.coverage.gaps[0]).toMatchObject({fromId:'2',toId:'2'});expect(snap.coverage.continuous).toBe(false);
  });
  it('marks only fully covered interior fixed-time bars complete and resets retained CVD after eviction',()=>{
    const store=new TradeFlowStore({...config,maxAgeMs:120_000});store.ingest([trade(1,30_000,'100','1'),trade(2,60_000,'100','2'),trade(3,120_000,'100','3',true)]);
    const first=store.snapshot();expect(first.footprint.find(b=>b.time===60_000)?.partial).toBe(false);
    store.ingest([trade(4,180_001,'100','4')]);const next=store.snapshot();expect(next.coverage.cvdAnchorTime).toBe(120_000);expect(next.footprint.at(-1)?.cvdBase).toBe(1);
  });
  it('keeps full-capacity rolling appends incremental instead of rebuilding every retained trade',()=>{
    const store=new TradeFlowStore({...config,maxTrades:100,maxAgeMs:172_800_000});
    const rebuild=vi.spyOn(store as unknown as {rebuild:()=>void},'rebuild');
    for(let id=0;id<1200;id++)store.ingest([{...trade(id,id*1000,'100.1',String(id%5+1),id%2===0),normalBaseQuantity:1}]);
    const snap=store.snapshot(),retained=Array.from({length:100},(_,i)=>trade(i+1100,(i+1100)*1000,'100.1',String((i+1100)%5+1),(i+1100)%2===0));
    expect(rebuild).not.toHaveBeenCalled();expect(snap.coverage.retainedTrades).toBe(100);expect(snap.coverage.evictedTrades).toBe(1100);expect(snap.coverage.continuous).toBe(true);
    expect(snap.coverage.normalQuantityTrades).toBe(100);expect(snap.coverage.normalQuantityBase).toBe(100);
    expect(snap.totals.volumeBase).toBe(retained.reduce((sum,t)=>sum+t.baseQuantity,0));expect(snap.totals.volumeQuote).toBeCloseTo(retained.reduce((sum,t)=>sum+t.quoteQuantity,0));
    expect(snap.profile.reduce((sum,p)=>sum+p.volumeBase,0)).toBe(snap.totals.volumeBase);expect(snap.footprint.at(-1)?.cvdBase).toBe(snap.totals.deltaBase);
    // Snapshots may read coverage endpoints, but must not walk the raw tape to
    // re-count normal quantity or rediscover every adjacent aggregate ID.
    const internal=store as unknown as {records:unknown[]};let rawReads=0;
    internal.records=new Proxy(internal.records,{get(target,key,receiver){if(typeof key==='string'&&/^\d+$/.test(key))rawReads++;return Reflect.get(target,key,receiver);}});
    store.snapshot();store.snapshot();expect(rawReads).toBeLessThanOrEqual(4);
    store.setAggregation({priceStepTicks:2});expect(rebuild).toHaveBeenCalledTimes(1);expect(store.snapshot().totals.volumeBase).toBe(snap.totals.volumeBase);
  });
  it('evicts by age incrementally and removes obsolete adjacent gaps without rescanning the retained tape',()=>{
    const store=new TradeFlowStore({...config,maxAgeMs:60_000}),rebuild=vi.spyOn(store as unknown as {rebuild:()=>void},'rebuild');
    store.ingest([trade(1,0),trade(3,1000),trade(5,2000)]);expect(store.gaps().map(g=>g.fromId)).toEqual(['2','4']);
    store.ingest([trade(4,1500)]);expect(store.gaps().map(g=>g.fromId)).toEqual(['2']);
    store.ingest([trade(6,61_001)]);expect(store.gaps()).toEqual([]);expect(store.snapshot().coverage.fromId).toBe('4');
    for(let id=7;id<400;id++)store.ingest([trade(id,61_001+(id-6)*1000)]);
    expect(rebuild).not.toHaveBeenCalled();expect(store.snapshot().coverage.retainedTrades).toBe(61);expect(store.snapshot().totals.aggregateCount).toBe(61);expect(store.snapshot().coverage.continuous).toBe(true);
  });
  it('does not publish continuous CVD through missing IDs, and restores it after an actual repair',()=>{
    const store=new TradeFlowStore(config);store.ingest([trade(1,1000,'100','1'),trade(2,61_000,'100','2'),trade(4,121_000,'100','4'),trade(5,181_000,'100','5')]);
    const broken=store.snapshot();expect(broken.footprint.find(b=>b.time===0)?.cvdBase).toBe(1);
    expect(broken.footprint.filter(b=>b.time>=60_000).every(b=>Number.isNaN(b.cvdBase)&&Number.isNaN(b.cvdQuote))).toBe(true);
    store.ingest([trade(3,91_000,'100','3',true)]);const repaired=store.snapshot();expect(repaired.coverage.continuous).toBe(true);expect(repaired.footprint.at(-1)?.cvdBase).toBe(9);expect(repaired.footprint.at(-1)?.cvdQuote).toBe(900);
    store.ingest([trade(4,121_000,'100','400')]);const conflict=store.snapshot();expect(conflict.coverage.continuous).toBe(false);expect(Number.isNaN(conflict.footprint.at(-1)!.cvdBase)).toBe(true);
    expect(conflict.totals.volumeBase).toBe(15);
  });
});

describe('opt-in buffered public session',()=>{
  it('does no I/O before connect, merges bootstrap/stream overlap and unsubscribes immediately',async()=>{
    vi.useFakeTimers();const sockets:Socket[]=[],updates:unknown[]=[],urls:string[]=[];
    let resolve!:(value:Response)=>void;
    const request=vi.fn(()=>new Promise<Response>(done=>{resolve=done;}));
    const session=createTradeFlowSession({...config,request:request as typeof fetch,onUpdate:s=>updates.push(s),socketFactory:url=>{urls.push(url);const socket=new Socket();sockets.push(socket);return socket;}});
    expect(request).not.toHaveBeenCalled();expect(sockets).toHaveLength(0);
    session.connect();sockets[0].open();sockets[0].message({...raw(11),s:'BTCUSDT',e:'aggTrade'});sockets[0].message({...raw(10),s:'BTCUSDT',e:'aggTrade'});
    resolve(Response.json([raw(10)]));await settle();
    expect(urls[0]).toBe('wss://fstream.binance.com/market/ws/btcusdt@aggTrade');expect(session.snapshot().totals.aggregateCount).toBe(2);expect(session.snapshot().status).toBe('live');
    const old=sockets[0].onmessage;session.disconnect();old?.({data:JSON.stringify({...raw(12),s:'BTCUSDT'})} as MessageEvent);await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0].closed).toBe(true);expect(session.snapshot().status).toBe('stopped');expect(session.snapshot().totals.aggregateCount).toBe(2);expect(sockets).toHaveLength(1);
  });
  it.each(['wss://fstream.binance.com/ws/','wss://fstream.binance.com/market/ws','wss://custom.test/proxy/ws///'])('accepts an already suffixed stream base %s without duplicating ws',async wsBase=>{
    vi.useFakeTimers();const socket=new Socket(),urls:string[]=[],request=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>Response.json([raw(1)]));
    const session=createTradeFlowSession({...config,restBase:'https://custom.test/proxy///',wsBase,request:request as typeof fetch,socketFactory:url=>{urls.push(url);return socket;}});
    session.connect();socket.open();await settle();
    expect(urls[0]).not.toContain('/ws/ws/');expect(urls[0]).toBe(wsBase.replace(/\/+$/,'')+'/btcusdt@aggTrade');
    expect(String(request.mock.calls[0][0])).toContain('https://custom.test/proxy/fapi/v1/aggTrades?');session.disconnect();
  });
  it('repairs a detected gap with inclusive fromId, before declaring retained coverage continuous',async()=>{
    vi.useFakeTimers();const socket=new Socket(),request=vi.fn(async(url:RequestInfo|URL)=>Response.json(String(url).includes('fromId=2')?[raw(2),raw(3)]:[raw(1)]));
    const session=createTradeFlowSession({...config,request:request as typeof fetch,socketFactory:()=>socket});session.connect();socket.open();await settle();
    socket.message({...raw(3),s:'BTCUSDT'});await settle();
    expect(request.mock.calls.some(([url])=>String(url).includes('fromId=2'))).toBe(true);expect(session.snapshot().coverage.gapCount).toBe(0);expect(session.snapshot().totals.aggregateCount).toBe(3);session.disconnect();
  });
  it('retains a failed-repair gap, bounds calls, and does not pretend a rate-limit failure is zero volume',async()=>{
    vi.useFakeTimers();const socket=new Socket(),request=vi.fn(async(url:RequestInfo|URL)=>String(url).includes('fromId=')?new Response('',{status:429}):Response.json([raw(1)]));
    const session=createTradeFlowSession({...config,request:request as typeof fetch,maxRecoveryPages:2,socketFactory:()=>socket});session.connect();socket.open();await settle();await vi.advanceTimersByTimeAsync(30_001);
    socket.message({...raw(5),s:'BTCUSDT'});await settle();for(let id=7;id<15;id++)socket.message({...raw(id),s:'BTCUSDT'});await settle();
    expect(request).toHaveBeenCalledTimes(2);expect(session.snapshot().status).toBe('partial');expect(session.snapshot().coverage.gapCount).toBeGreaterThan(0);expect(session.snapshot().coverage.completeHistory).toBe(false);session.disconnect();
  });
  it('reconnects with a bounded backoff and preserves/de-duplicates retained raw trades',async()=>{
    vi.useFakeTimers();const sockets:Socket[]=[],request=vi.fn(async()=>Response.json([raw(1),raw(2)]));
    const session=createTradeFlowSession({...config,request:request as typeof fetch,maxReconnectAttempts:1,socketFactory:()=>{const socket=new Socket();sockets.push(socket);return socket;}});
    session.connect();sockets[0].open();await settle();sockets[0].break();expect(session.snapshot().status).toBe('reconnecting');await vi.advanceTimersByTimeAsync(1000);sockets[1].open();await settle();
    expect(session.snapshot().totals.aggregateCount).toBe(2);sockets[1].break();expect(session.snapshot().status).toBe('error');await vi.advanceTimersByTimeAsync(60_000);expect(sockets).toHaveLength(2);session.disconnect();
  });
  it('ignores a stale REST response after disconnect while preserving explicitly accepted stream data',async()=>{
    vi.useFakeTimers();const socket=new Socket();let resolve!:(value:Response)=>void;
    const session=createTradeFlowSession({...config,request:(()=>new Promise<Response>(done=>{resolve=done;})) as typeof fetch,socketFactory:()=>socket});session.connect();socket.open();session.disconnect();resolve(Response.json([raw(1)]));await settle();expect(session.snapshot().coverage.retainedTrades).toBe(0);expect(session.snapshot().status).toBe('stopped');
  });
  it('aggregates every burst trade before throttling notifications, and limits large recovery to the page budget',async()=>{
    vi.useFakeTimers();const socket=new Socket(),updates:unknown[]=[];
    const request=vi.fn(async(url:RequestInfo|URL)=>{
      const from=new URL(String(url)).searchParams.get('fromId');
      return Response.json(from?Array.from({length:1000},(_,i)=>raw(Number(from)+i)):[raw(1)]);
    });
    const session=createTradeFlowSession({...config,request:request as typeof fetch,socketFactory:()=>socket,publishMs:100,onUpdate:s=>updates.push(s),maxRecoveryPages:2});
    session.connect();socket.open();await settle();const before=updates.length;
    for(let id=2;id<=101;id++)socket.message({...raw(id),s:'BTCUSDT'});
    expect(session.snapshot().totals.aggregateCount).toBe(101);expect(updates.length).toBe(before);
    await vi.advanceTimersByTimeAsync(100);expect(updates.length).toBe(before+1);
    socket.message({...raw(5000),s:'BTCUSDT'});await settle();
    expect(request).toHaveBeenCalledTimes(3);expect(session.snapshot().status).toBe('partial');expect(session.snapshot().coverage.gaps[0]).toMatchObject({fromId:'2102',toId:'4999'});session.disconnect();
  });
});
