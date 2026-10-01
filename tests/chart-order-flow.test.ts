import {afterEach,describe,expect,it,vi} from 'vitest';
import {ChartOrderFlow,type ChartOrderFlowOptions} from '../src/lib/flow/chart-order-flow';
import type {SharedBookSnapshot,SharedOrderBookLease,OrderBookIdentity} from '../src/lib/flow/orderbook-hub';
import type {DatasetInfo,DepthHeatmap,ReplaySnapshot} from '../src/lib/flow/persistence-client';
import type {TradeFlowSessionOptions,TradeFlowSession} from '../src/lib/flow/session';
import type {TradeFlowSessionSnapshot} from '../src/lib/flow/types';

const market={source:'binance',marketType:'usdm-perpetual',symbol:'BTCUSDT',tickSize:.1};
const dataset:DatasetInfo={id:'archive',symbol:'BTCUSDT',kind:'recording',tradeType:'aggTrades',state:'stopped',source:'binance',createdAt:1000,fromTime:1000,throughTime:9000,tradeCount:20,depthCount:50,gapCount:0};
const book=(identity:OrderBookIdentity=market):SharedBookSnapshot=>({identity,key:identity.symbol,symbol:identity.symbol,supported:true,status:'live',bids:[{price:100,quantity:2}],asks:[{price:101,quantity:3}],updatedAt:9000,lastReceivedAt:9100,lastUpdateId:20,revision:1,segmentId:1,capturedAt:10000,history:[],changes:[],
  coverage:{fromTime:9000,throughTime:9000,receivedFromTime:9100,receivedThroughTime:9100,segmentId:1,depthPerSide:1000},changeCoverage:{fromTime:9100,throughTime:9100,truncated:false},historyCoverage:{fromTime:null,throughTime:null,samples:0,intervalMs:1000,maxSamples:150,levelsPerSide:100}});
const frame=(at=9000):ReplaySnapshot=>({datasetId:dataset.id,at,book:{status:'available',bids:[{price:100,quantity:2}],asks:[{price:101,quantity:3}],time:at-100,lastUpdateId:20},trades:[],coverage:{dataset,gaps:[],gapsTruncated:false,note:'recorded'}});
const heatmap=():DepthHeatmap=>({datasetId:dataset.id,fromTime:1000,toTime:9000,samples:[{time:1000,book:{status:'available',bids:[{price:100,quantity:2}],asks:[{price:101,quantity:3}],time:950,lastUpdateId:1}}],note:'recorded'});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}
const cleanup:Array<()=>void>=[];afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());vi.unstubAllGlobals();});
function harness(){
  const leases:Array<SharedOrderBookLease&{push:(value:SharedBookSnapshot)=>void;callbacks:Array<(value:SharedBookSnapshot)=>void>}>=[];
  const acquire=vi.fn((identity:OrderBookIdentity)=>{
    let value=book(identity);const listeners=new Set<(value:SharedBookSnapshot)=>void>(),callbacks:Array<(value:SharedBookSnapshot)=>void>=[];
    const lease={key:identity.symbol,snapshot:()=>value,subscribe:(fn:(value:SharedBookSnapshot)=>void)=>{listeners.add(fn);callbacks.push(fn);fn(value);return()=>listeners.delete(fn);},
      setActive:vi.fn(),reconnect:vi.fn(async()=>{}),release:vi.fn(),callbacks,push:(next:SharedBookSnapshot)=>{value=next;listeners.forEach(fn=>fn(next));}};
    leases.push(lease);return lease;
  });
  const client={datasets:vi.fn(async()=>[dataset]),heatmap:vi.fn(async()=>heatmap()),replay:vi.fn(async(_id:string,at:number)=>frame(at))};
  const trades:Array<{options:TradeFlowSessionOptions;connect:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>}>=[];
  const createTrades=vi.fn((options:TradeFlowSessionOptions)=>{const session={options,connect:vi.fn(),disconnect:vi.fn()};trades.push(session);return session as unknown as TradeFlowSession;});
  const storage={getItem:vi.fn(()=>null),setItem:vi.fn()},paint=vi.fn();
  const flow=new ChartOrderFlow(paint,{acquire,client:client as unknown as ChartOrderFlowOptions['client'],createTrades,storage,now:()=>10000});
  cleanup.push(()=>flow.destroy());flow.configure(market);return {flow,acquire,leases,client,trades,createTrades,storage,paint};
}

describe('chart order-flow coordination',()=>{
  it('uses one lease for terminal plus both overlays and releases only when their combined demand ends',()=>{
    const h=harness();expect(h.acquire).not.toHaveBeenCalled();const closeA=h.flow.panel(),closeB=h.flow.panel();
    expect(h.acquire).toHaveBeenCalledOnce();h.flow.settings({heatmap:true,profile:true});closeA();closeB();expect(h.leases[0].release).not.toHaveBeenCalled();
    h.flow.settings({heatmap:false});expect(h.leases[0].release).not.toHaveBeenCalled();h.flow.settings({profile:false});expect(h.leases[0].release).toHaveBeenCalledOnce();
    expect(h.flow.snapshot().book).toBeUndefined();closeA();expect(h.leases[0].release).toHaveBeenCalledOnce();
  });
  it('pauses, resumes and reconnects without a stale live book or a redundant fresh reconnect',()=>{
    const h=harness();h.flow.panel();h.flow.pause(true);expect(h.flow.snapshot()).toMatchObject({running:false,book:undefined});
    h.flow.reconnect();expect(h.acquire).toHaveBeenCalledTimes(2);expect(h.leases[1].reconnect).not.toHaveBeenCalled();
    h.flow.reconnect();expect(h.leases[1].reconnect).toHaveBeenCalledOnce();
    h.leases[1].push({...book(),status:'stale',bids:[],asks:[]});expect(h.flow.snapshot().book?.status).toBe('stale');
  });
  it('isolates old-market callbacks and suspends live streams while the chart uses historical candles',()=>{
    const h=harness();h.flow.panel();const old=h.leases[0];h.flow.configure({...market,symbol:'ETHUSDT'});
    expect(old.release).toHaveBeenCalledOnce();expect(h.flow.snapshot().book?.symbol).toBe('ETHUSDT');
    old.callbacks[0](book());expect(h.flow.snapshot().book?.symbol).toBe('ETHUSDT');
    h.flow.configure({...market,symbol:'ETHUSDT',chartHistorical:true});expect(h.flow.snapshot().book).toBeUndefined();expect(h.leases[1].release).toHaveBeenCalledOnce();
    h.flow.configure({...market,symbol:'ETHUSDT',chartHistorical:false});expect(h.acquire).toHaveBeenCalledTimes(3);
  });
  it('persists display settings and switches units/aggregation without creating another subscription',()=>{
    const h=harness();h.flow.panel();h.flow.settings({unit:'quote',priceStepTicks:10,windowMs:30000});
    expect(h.acquire).toHaveBeenCalledOnce();expect(h.flow.aggregate()?.bids[0].quantity).toBe(200);
    expect(JSON.parse(h.storage.setItem.mock.calls.at(-1)![1])).toMatchObject({unit:'quote',priceStepTicks:10,windowMs:30000});
  });
  it('opens the real trade profile only for a visible DOM and prevents late trade callbacks after leaving it',()=>{
    const h=harness();h.flow.settings({heatmap:true,view:'dom'});expect(h.createTrades).not.toHaveBeenCalled();const off=h.flow.panel();
    expect(h.createTrades).toHaveBeenCalledOnce();expect(h.trades[0].connect).toHaveBeenCalledOnce();
    expect(h.trades[0].options).toMatchObject({symbol:'BTCUSDT',timeframeMs:1000,maxFootprintBars:30});
    const snapshot={symbol:'BTCUSDT',status:'live'} as TradeFlowSessionSnapshot;h.trades[0].options.onUpdate!(snapshot);expect(h.flow.snapshot().trades).toBe(snapshot);
    off();expect(h.trades[0].disconnect).toHaveBeenCalledOnce();expect(h.flow.snapshot().trades).toBeUndefined();
    h.trades[0].options.onUpdate!(snapshot);expect(h.flow.snapshot().trades).toBeUndefined();expect(h.leases[0].release).not.toHaveBeenCalled();
    h.flow.panel();h.flow.configure({...market,tickSize:.01});expect(h.createTrades).toHaveBeenCalledTimes(3);expect(h.trades[2].options.tickSize).toBe(.01);expect(h.acquire).toHaveBeenCalledOnce();
  });
  it('updates DOM trades without repainting the price chart or recomputing unchanged depth',()=>{
    const h=harness();h.flow.panel();h.flow.settings({view:'dom',heatmap:true,profile:true});
    const subscriber=vi.fn();h.flow.subscribe(subscriber);subscriber.mockClear();h.paint.mockClear();
    const first=h.flow.aggregate(200),trades={symbol:'BTCUSDT',status:'live'} as TradeFlowSessionSnapshot;
    h.trades[0].options.onUpdate!(trades);
    expect(h.flow.snapshot().trades).toBe(trades);expect(subscriber).toHaveBeenCalledOnce();expect(h.paint).not.toHaveBeenCalled();
    expect(h.flow.aggregate(200)).toBe(first);
    h.flow.settings({unit:'quote'});const quote=h.flow.aggregate(200);expect(quote).not.toBe(first);expect(quote?.bids[0].quantity).toBe(200);
    h.paint.mockClear();h.leases[0].push({...book(),revision:2,bids:[{price:100,quantity:4}]});
    expect(h.paint).toHaveBeenCalledOnce();expect(h.flow.aggregate(200)).not.toBe(quote);expect(h.flow.aggregate(200)?.bids[0].quantity).toBe(400);
    h.flow.settings({view:'delta'});expect(h.flow.aggregate(200)).not.toBe(quote);
  });
  it('loads actual archived depth without inventing historical receipt times or delta changes',async()=>{
    const h=harness();h.flow.panel();await h.flow.loadArchive(dataset);
    expect(h.leases[0].release).toHaveBeenCalledOnce();expect(h.flow.snapshot()).toMatchObject({mode:'history',error:'',archive:{pending:false,cursor:9000}});
    expect(h.flow.snapshot().book).toMatchObject({lastReceivedAt:0,updatedAt:8900,history:[],changes:[],historyCoverage:{samples:0},coverage:{receivedFromTime:null,receivedThroughTime:null}});
    expect(h.flow.aggregate()?.changeWindow.covered).toBe(false);h.flow.live();expect(h.acquire).toHaveBeenCalledTimes(2);expect(h.flow.snapshot().archive).toBeUndefined();
  });
  it('aborts older seeks and ignores their late replies after a newer cursor or market is selected',async()=>{
    const h=harness();await h.flow.loadArchive(dataset);const first=deferred<ReplaySnapshot>(),second=deferred<ReplaySnapshot>();
    h.client.replay.mockImplementationOnce(()=>first.promise).mockImplementationOnce(()=>second.promise);
    const a=h.flow.seek(3000),b=h.flow.seek(4000);const signal=(h.client.replay.mock.calls[1] as unknown[])[3] as AbortSignal;
    expect(signal.aborted).toBe(true);expect(h.flow.snapshot().book).toBeUndefined();second.resolve(frame(4000));await b;first.resolve(frame(3000));await a;
    expect(h.flow.snapshot()).toMatchObject({archive:{cursor:4000,pending:false},book:{updatedAt:3900}});
    const later=deferred<ReplaySnapshot>();h.client.replay.mockImplementationOnce(()=>later.promise);const pending=h.flow.seek(5000);h.flow.configure({...market,symbol:'ETHUSDT'});later.resolve(frame(5000));await pending;
    expect(h.flow.snapshot().mode).toBe('live');expect(h.flow.snapshot().archive).toBeUndefined();expect(h.flow.snapshot().market?.symbol).toBe('ETHUSDT');
  });
  it('rejects future replay data and retries the same historical cursor explicitly',async()=>{
    const h=harness();await h.flow.loadArchive(dataset);h.client.replay.mockImplementationOnce(async()=>frame(5000));await h.flow.seek(4000);
    expect(h.flow.snapshot().error).toContain('游标之后');expect(h.flow.snapshot().book).toBeUndefined();
    h.flow.reconnect();await flush();expect(h.flow.snapshot().error).toBe('');expect(h.flow.snapshot().book?.updatedAt).toBe(3900);
    h.client.replay.mockImplementationOnce(async()=>({...frame(4000),book:{...frame(4000).book,time:4100}}));await h.flow.seek(4000);expect(h.flow.snapshot().book).toBeUndefined();expect(h.flow.snapshot().error).toContain('游标之后');
  });
  it('retries failed archive loading and also fetches heatmap data when a seek supersedes initial loading',async()=>{
    const h=harness();h.client.heatmap.mockRejectedValueOnce(Error('offline'));await h.flow.loadArchive(dataset);expect(h.flow.snapshot().error).toBe('offline');
    h.flow.reconnect();await flush();expect(h.flow.snapshot().archive?.heatmap).toBeDefined();expect(h.flow.snapshot().error).toBe('');
    const slow=deferred<DepthHeatmap>();h.client.heatmap.mockImplementationOnce(()=>slow.promise);const loading=h.flow.loadArchive(dataset);await h.flow.seek(4000);
    expect(h.flow.snapshot().archive?.heatmap).toBeDefined();expect(h.flow.snapshot().archive?.cursor).toBe(4000);slow.resolve(heatmap());await loading;
    expect(h.flow.snapshot().archive?.cursor).toBe(4000);
  });
  it('rejects a mismatched archive response and a destroyed coordinator never publishes a late result',async()=>{
    const h=harness();h.client.replay.mockImplementationOnce(async()=>({...frame(),datasetId:'wrong'}));await h.flow.loadArchive(dataset);
    expect(h.flow.snapshot().book).toBeUndefined();expect(h.flow.snapshot().error).toContain('不一致');
    const slow=deferred<ReplaySnapshot>();h.client.replay.mockImplementationOnce(()=>slow.promise);const loading=h.flow.loadArchive(dataset);h.flow.destroy();const calls=h.paint.mock.calls.length;slow.resolve(frame());await loading;expect(h.paint).toHaveBeenCalledTimes(calls);
    h.flow.panel();h.flow.configure({...market,symbol:'ETHUSDT'});expect(h.acquire).not.toHaveBeenCalled();
  });
});

describe('server-sampled heatmap history',()=>{
  function withDepth(respond:(url:string)=>Response|Promise<Response>){
    const depthRequest=vi.fn(async(input:RequestInfo|URL)=>respond(String(input)));
    const flow=new ChartOrderFlow(vi.fn(),{acquire:vi.fn(()=>({key:'k',snapshot:()=>book(),subscribe:(fn:(value:SharedBookSnapshot)=>void)=>{fn(book());return()=>{};},setActive:vi.fn(),reconnect:vi.fn(async()=>{}),release:vi.fn()})) as unknown as ChartOrderFlowOptions['acquire'],
      storage:{getItem:()=>null,setItem:()=>{}},now:()=>100_000,depthRequest:depthRequest as unknown as typeof fetch});
    cleanup.push(()=>flow.destroy());flow.configure(market);flow.settings({heatmap:true});return {flow,depthRequest};
  }
  const ok=(body:unknown)=>new Response(JSON.stringify(body),{status:200});
  it('watches once, debounces, fetches the padded visible range and stores frozen pre-bucketed samples',async()=>{
    vi.useFakeTimers();cleanup.push(()=>vi.useRealTimers());
    const {flow,depthRequest}=withDepth(url=>url.endsWith('/watch')?ok({symbol:'BTCUSDT'}):ok({strideMs:10_000,samples:[{time:40_000,bids:[[100,2]],asks:[[125,3],[150,0]]}]}));
    for(let i=0;i<5;i++)flow.requestDepthHistory(60_000,90_000,25);
    await vi.advanceTimersByTimeAsync(260);
    expect(depthRequest).toHaveBeenCalledTimes(2);
    const url=new URL(String(depthRequest.mock.calls[1][0]),'http://x');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({symbol:'BTCUSDT',from:'45000',to:'90000',step:'25'});
    const history=flow.snapshot().depthHistory!;
    expect(history).toMatchObject({symbol:'BTCUSDT',step:25,strideMs:10_000});expect(history.samples[0].asks).toEqual([{price:125,quantity:3}]);
    expect(Object.isFrozen(history.samples[0].bids)).toBe(true);
    flow.requestDepthHistory(60_000,90_000,25);await vi.advanceTimersByTimeAsync(260);expect(depthRequest).toHaveBeenCalledTimes(2);// covered and fresh
    flow.requestDepthHistory(60_000,90_000,10);await vi.advanceTimersByTimeAsync(260);expect(depthRequest).toHaveBeenCalledTimes(3);// new bucket → refetch, already watched
  });
  it('backs off when the local sampler is unavailable and never asks for other sources or with the heatmap off',async()=>{
    vi.useFakeTimers();cleanup.push(()=>vi.useRealTimers());
    const {flow,depthRequest}=withDepth(()=>new Response('{}',{status:503}));
    flow.requestDepthHistory(60_000,90_000,25);await vi.advanceTimersByTimeAsync(260);expect(depthRequest).toHaveBeenCalledTimes(1);
    flow.requestDepthHistory(0,90_000,25);await vi.advanceTimersByTimeAsync(260);expect(depthRequest).toHaveBeenCalledTimes(1);// backoff
    flow.settings({heatmap:false});flow.requestDepthHistory(0,1,25);
    flow.configure({...market,source:'okx'});flow.settings({heatmap:true});flow.requestDepthHistory(0,90_000,25);
    await vi.advanceTimersByTimeAsync(260);expect(depthRequest).toHaveBeenCalledTimes(1);
  });
});
