import {afterEach,describe,expect,it,vi} from 'vitest';
import {createOrderBookSession,Level2Book,MAX_BOOK_BUFFER_EVENTS,type BookDepthEvent,type OrderBookSocket} from '../src/lib/flow/orderbook';

const rows=(values:number[][])=>values.map(([price,quantity])=>({price,quantity}));
const event=(patch:Partial<BookDepthEvent>={}):BookDepthEvent=>({firstUpdateId:99,lastUpdateId:102,previousUpdateId:98,time:1000,bids:rows([[100,7]]),asks:rows([[102,0]]),...patch});
const rest=(id=100)=>({lastUpdateId:id,bids:[['100','5'],['99','8']],asks:[['101','4'],['102','6']]});
const message=(patch:Record<string,unknown>={})=>({e:'depthUpdate',s:'BTCUSDT',U:99,u:102,pu:98,T:1000,b:[['100','7']],a:[['102','0']],...patch});
function deferred(){let resolve!:(value:Response)=>void;const promise=new Promise<Response>(r=>resolve=r);return{promise,resolve};}
const response=(body:unknown,status=200)=>({ok:status===200,status,json:async()=>body}) as Response;
async function flush(){for(let i=0;i<8;i++)await Promise.resolve();}
class Socket implements OrderBookSocket {
  static instances:Socket[]=[];
  onopen:((event:Event)=>void)|null=null;onmessage:((event:MessageEvent)=>void)|null=null;
  onclose:((event:CloseEvent)=>void)|null=null;onerror:((event:Event)=>void)|null=null;
  close=vi.fn();constructor(readonly url:string){Socket.instances.push(this);}
  open(){this.onopen?.({} as Event);}receive(raw:unknown){this.onmessage?.({data:JSON.stringify(raw)} as MessageEvent);}
  end(){this.onclose?.({} as CloseEvent);}
}
const cleanup:Array<()=>void>=[];
function harness(){
  Socket.instances=[];const first=deferred(),request=vi.fn< typeof fetch >(()=>first.promise),updates=vi.fn();
  const session=createOrderBookSession({symbol:'BTC/USDT',limit:2,fetch:request,WebSocket:Socket,onUpdate:updates});
  cleanup.push(()=>session.disconnect());return{session,request,updates,first,socket:()=>Socket.instances.at(-1)!};
}
afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());vi.useRealTimers();});

describe('pure sequence-checked L2 book',()=>{
  it('bridges the snapshot watermark, replaces absolute quantities, removes zero levels and ignores duplicates',()=>{
    const book=new Level2Book();book.load({lastUpdateId:100,bids:rows([[99,8],[100,5]]),asks:rows([[102,6],[101,4]])});
    expect(book.ready).toBe(false);
    expect(book.apply(event({firstUpdateId:95,lastUpdateId:99}))).toBe('stale');
    expect(book.apply(event())).toBe('applied');expect(book.ready).toBe(true);
    expect(book.levels()).toEqual({bids:rows([[100,7],[99,8]]),asks:rows([[101,4]])});
    expect(book.apply(event())).toBe('stale');expect(book.levels().bids[0].quantity).toBe(7);
    expect(book.apply(event({firstUpdateId:103,lastUpdateId:105,previousUpdateId:102,bids:rows([[100,2]]),asks:rows([[104,0],[101,3]])}))).toBe('applied');
    expect(book.levels(1)).toEqual({bids:rows([[100,2]]),asks:rows([[101,3]])});
  });

  it('rejects a missing initial bridge or later pu gap before changing the book',()=>{
    const book=new Level2Book();book.load({lastUpdateId:100,bids:rows([[100,5]]),asks:rows([[101,4]])});
    expect(book.apply(event({firstUpdateId:101}))).toBe('gap');expect(book.ready).toBe(false);
    expect(book.apply(event({firstUpdateId:98,lastUpdateId:100}))).toBe('applied');
    const original=book.levels();
    expect(book.apply(event({firstUpdateId:104,lastUpdateId:107,previousUpdateId:103,bids:rows([[100,99]])}))).toBe('gap');
    expect(book.levels()).toEqual(original);expect(book.lastUpdateId).toBe(100);
  });
});

describe('public order-book session lifecycle',()=>{
  it('is opt-in, buffers websocket updates before REST and only then publishes a live sorted book',async()=>{
    const h=harness(),seen=vi.fn(),off=h.session.subscribe(seen);
    expect(h.request).not.toHaveBeenCalled();expect(Socket.instances).toHaveLength(0);expect(seen.mock.calls[0][0].status).toBe('idle');
    await h.session.connect();await h.session.connect();expect(Socket.instances).toHaveLength(1);
    expect(h.socket().url).toBe('wss://fstream.binance.com/public/ws/btcusdt@depth@100ms');
    expect(h.session.snapshot()).toMatchObject({status:'connecting',bids:[],asks:[],lastUpdateId:null});
    h.socket().open();expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0][0]).toBe('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000');
    expect(h.request.mock.calls[0][1]).toMatchObject({credentials:'omit',redirect:'error'});
    expect(h.request.mock.calls[0][1]).not.toHaveProperty('headers');
    h.socket().receive(message({U:95,u:99}));h.socket().receive(message());
    expect(h.session.snapshot().status).toBe('connecting');
    h.first.resolve(response(rest()));await flush();
    expect(h.session.snapshot()).toEqual({symbol:'BTCUSDT',status:'live',bids:rows([[100,7],[99,8]]),asks:rows([[101,4]]),updatedAt:1000,lastUpdateId:102,revision:1,segmentId:1,lastReceivedAt:expect.any(Number)});
    const copy=h.session.snapshot();copy.bids[0].quantity=999;expect(h.session.snapshot().bids[0].quantity).toBe(7);
    off();const calls=seen.mock.calls.length;h.socket().receive(message({U:103,u:103,pu:102,T:1100,b:[['100','3']],a:[]}));
    expect(seen).toHaveBeenCalledTimes(calls);expect(h.session.snapshot().bids[0].quantity).toBe(3);
  });

  it('waits for a bridging stream event even after a successful snapshot',async()=>{
    const h=harness();await h.session.connect();h.socket().open();h.first.resolve(response(rest()));await flush();
    expect(h.session.snapshot()).toMatchObject({status:'connecting',bids:[],lastUpdateId:null});
    h.socket().receive(message({U:100,u:100,pu:99}));expect(h.session.snapshot().status).toBe('live');
  });

  it('clears a broken live book and restores it only after a fresh snapshot and continuous buffered chain',async()=>{
    vi.useFakeTimers();const h=harness(),second=deferred();h.request.mockImplementationOnce(()=>h.first.promise).mockImplementationOnce(()=>second.promise);
    await h.session.connect();h.socket().open();h.socket().receive(message());h.first.resolve(response(rest()));await flush();
    expect(h.session.snapshot().status).toBe('live');
    h.socket().receive(message({U:105,u:107,pu:104,T:2000,b:[['100','9']],a:[]}));
    expect(h.session.snapshot()).toMatchObject({status:'resyncing',bids:[],asks:[],updatedAt:0,lastUpdateId:null});
    expect(h.session.snapshot().warning).toContain('缺口');expect(h.request).toHaveBeenCalledTimes(1);
    h.socket().receive(message({U:108,u:109,pu:107,T:2100,b:[['99','0']],a:[['101','6']]}));
    await vi.advanceTimersByTimeAsync(500);expect(h.request).toHaveBeenCalledTimes(2);
    second.resolve(response(rest(106)));await flush();
    expect(h.session.snapshot()).toMatchObject({status:'live',bids:rows([[100,9]]),asks:rows([[101,6],[102,6]]),lastUpdateId:109,updatedAt:2100});
  });

  it('aborts pending bootstrap and ignores old callbacks and late replies after disconnect',async()=>{
    const h=harness();await h.session.connect();h.socket().open();const oldMessage=h.socket().onmessage!,oldClose=h.socket().onclose!;
    const signal=h.request.mock.calls[0][1]!.signal!;h.session.disconnect();expect(signal.aborted).toBe(true);
    oldMessage({data:JSON.stringify(message())} as MessageEvent);oldClose({} as CloseEvent);
    h.first.resolve(response(rest()));await flush();
    expect(h.session.snapshot()).toEqual({symbol:'BTCUSDT',status:'idle',bids:[],asks:[],updatedAt:0,lastUpdateId:null,revision:0,segmentId:2,lastReceivedAt:0});
    expect(h.socket().close).toHaveBeenCalledTimes(1);expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('bounds pre-snapshot buffering and never silently exposes a partially dropped order book',async()=>{
    vi.useFakeTimers();const h=harness();await h.session.connect();h.socket().open();
    const signal=h.request.mock.calls[0][1]!.signal!;
    for(let i=0;i<=MAX_BOOK_BUFFER_EVENTS;i++)h.socket().receive(message({U:100+i,u:100+i,pu:99+i,b:[],a:[]}));
    expect(signal.aborted).toBe(true);expect(h.session.snapshot()).toMatchObject({status:'resyncing',bids:[],lastUpdateId:null});
    expect(h.session.snapshot().warning).toContain('缓冲');
    h.first.resolve(response(rest()));await flush();expect(h.session.snapshot().status).toBe('resyncing');
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('retries network failures with a bounded backoff and supports manual recovery after exhaustion',async()=>{
    vi.useFakeTimers();const h=harness();h.request.mockResolvedValue(response({},429));
    await h.session.connect();h.socket().open();await flush();expect(h.session.snapshot().status).toBe('resyncing');
    for(const delay of [500,1000,2000,4000,8000,16000])await vi.advanceTimersByTimeAsync(delay);
    expect(h.request).toHaveBeenCalledTimes(7);expect(h.session.snapshot().status).toBe('error');
    await vi.advanceTimersByTimeAsync(120_000);expect(h.request).toHaveBeenCalledTimes(7);
    h.request.mockResolvedValue(response(rest()));await h.session.connect();h.socket().open();h.socket().receive(message());await flush();
    expect(h.session.snapshot().status).toBe('live');
  });

  it('ignores unrelated symbols/types, but invalid matching depth data forces a resync',async()=>{
    vi.useFakeTimers();const h=harness();await h.session.connect();h.socket().open();h.socket().receive(message());h.first.resolve(response(rest()));await flush();
    h.socket().receive(message({s:'ETHUSDT',U:500,u:501,pu:499}));h.socket().receive(message({st:2,U:500,u:501,pu:499}));
    expect(h.session.snapshot().status).toBe('live');expect(h.session.snapshot().lastUpdateId).toBe(102);
    h.socket().receive(message({U:103,u:103,pu:102,b:[['100','-1']]}));
    expect(h.session.snapshot()).toMatchObject({status:'resyncing',bids:[],lastUpdateId:null});
    expect(h.session.snapshot().warning).toContain('格式');
  });

  it('reconnects through a fresh socket and discards the disconnected book immediately',async()=>{
    vi.useFakeTimers();const h=harness();await h.session.connect();h.socket().open();h.socket().receive(message());h.first.resolve(response(rest()));await flush();
    const old=h.socket();old.end();expect(h.session.snapshot()).toMatchObject({status:'resyncing',bids:[],asks:[]});
    await vi.advanceTimersByTimeAsync(500);expect(Socket.instances).toHaveLength(2);expect(h.socket()).not.toBe(old);
    expect(h.session.snapshot().status).toBe('resyncing');h.session.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);expect(Socket.instances).toHaveLength(2);
  });

  it('marks quiet data stale using receipt time, and only a valid new revision restores live status',async()=>{
    vi.useFakeTimers();vi.setSystemTime(0);const h=harness();await h.session.connect();h.socket().open();h.socket().receive(message());h.first.resolve(response(rest()));await flush();
    expect(h.session.snapshot()).toMatchObject({status:'live',revision:1,lastReceivedAt:0});
    await vi.advanceTimersByTimeAsync(5000);expect(h.session.snapshot()).toMatchObject({status:'stale',bids:[],asks:[],revision:1});
    h.socket().receive(message());expect(h.session.snapshot().status).toBe('stale');
    h.socket().receive(message({U:103,u:103,pu:102,T:5500,b:[['100','9']],a:[]}));
    expect(h.session.snapshot()).toMatchObject({status:'live',revision:2,lastReceivedAt:5000,updatedAt:5500});
  });

  it('supports explicit manual reconnect before retry exhaustion and resets its baseline',async()=>{
    vi.useFakeTimers();const h=harness();h.request.mockResolvedValue(response(rest()));
    await h.session.connect();h.socket().open();h.socket().receive(message());await flush();const original=h.socket();
    await h.session.reconnect();expect(original.close).toHaveBeenCalledOnce();expect(h.session.snapshot().status).toBe('connecting');
    expect(h.session.snapshot().bids).toEqual([]);expect(Socket.instances).toHaveLength(2);
    h.socket().open();h.socket().receive(message());await flush();expect(h.session.snapshot()).toMatchObject({status:'live',revision:2});
  });

  it('emits absolute old-to-new quantity changes only after the initial bridge, never for duplicates or gaps',async()=>{
    vi.useFakeTimers();Socket.instances=[];const updates:import('../src/lib/flow/orderbook').BookAppliedUpdate[]=[];
    const session=createOrderBookSession({symbol:'BTCUSDT',fetch:vi.fn().mockResolvedValue(response(rest())),WebSocket:Socket,now:()=>1234,onApplied:update=>updates.push(update)});
    cleanup.push(()=>session.disconnect());await session.connect();const socket=Socket.instances[0];socket.open();socket.receive(message());await flush();
    expect(updates).toHaveLength(1);expect(updates[0]).toMatchObject({baseline:true,levels:[],receivedAt:1234});
    socket.receive(message({U:103,u:103,pu:102,b:[['100','2'],['99','9']],a:[['101','0']]}));
    expect(updates[1].levels).toEqual([
      {side:'bid',price:100,addedBase:0,removedBase:5,addedQuote:0,removedQuote:500},
      {side:'bid',price:99,addedBase:1,removedBase:0,addedQuote:99,removedQuote:0},
      {side:'ask',price:101,addedBase:0,removedBase:4,addedQuote:0,removedQuote:404},
    ]);
    socket.receive(message({U:103,u:103,pu:102}));socket.receive(message({U:106,u:106,pu:105}));
    expect(updates).toHaveLength(2);expect(session.snapshot().status).toBe('resyncing');
  });

  it('uses explicit transport bases and an injected wall clock without rewriting custom hosts',async()=>{
    Socket.instances=[];const request=vi.fn().mockResolvedValue(response(rest()));
    const session=createOrderBookSession({symbol:'BTCUSDT',fetch:request,WebSocket:Socket,restBase:'https://example.test/api/',wsBase:'wss://example.test/feed/',now:()=>456});
    cleanup.push(()=>session.disconnect());await session.connect();const socket=Socket.instances[0];expect(socket.url).toBe('wss://example.test/feed/btcusdt@depth@100ms');
    socket.open();socket.receive(message());await flush();expect(request.mock.calls[0][0]).toBe('https://example.test/api/fapi/v1/depth?symbol=BTCUSDT&limit=1000');
    expect(session.snapshot().lastReceivedAt).toBe(456);
  });

  it('does not label an old buffered bridge live when REST bootstrap completes after the freshness deadline',async()=>{
    vi.useFakeTimers();vi.setSystemTime(0);const h=harness();await h.session.connect();h.socket().open();h.socket().receive(message());
    await vi.advanceTimersByTimeAsync(6000);h.first.resolve(response(rest()));await flush();
    expect(h.session.snapshot()).toMatchObject({status:'stale',bids:[],asks:[],revision:1,lastReceivedAt:0});
  });
});

describe('L2 book price horizon',()=>{
  const seed=(horizon:number)=>{
    const book=new Level2Book();book.horizon=horizon;
    book.load({lastUpdateId:100,bids:rows([[100,5],[99,8]]),asks:rows([[101,4],[102,6]])});
    expect(book.apply(event({firstUpdateId:99,lastUpdateId:101,previousUpdateId:98,bids:rows([[100,5]]),asks:rows([[101,4]])}))).toBe('applied');
    return book;
  };
  const next=(book:Level2Book,patch:Partial<BookDepthEvent>)=>book.apply(event({firstUpdateId:book.lastUpdateId!+1,lastUpdateId:book.lastUpdateId!+1,previousUpdateId:book.lastUpdateId!,...patch}));

  it('learns levels beyond the REST horizon from diffs, exactly, while ignoring dust outside ±horizon',()=>{
    const book=seed(.1);// mid 100.5 → [90.45, 110.55]
    expect(next(book,{bids:rows([[92,50],[1,999]]),asks:rows([[109,30],[900,7]])})).toBe('applied');
    const levels=book.levels(50);
    expect(levels.bids).toEqual(rows([[100,5],[99,8],[92,50]]));expect(levels.asks).toEqual(rows([[101,4],[102,6],[109,30]]));
  });

  it('always applies removals, even outside the horizon, so a learned level never goes stale',()=>{
    const book=seed(.1);next(book,{bids:rows([[92,50]])});
    expect(book.levels(50).bids.map(l=>l.price)).toContain(92);
    next(book,{bids:rows([[92,0]])});expect(book.levels(50).bids.map(l=>l.price)).not.toContain(92);
  });

  it('without a horizon it keeps every level as before (default is unchanged)',()=>{
    const book=seed(0);next(book,{bids:rows([[1,999]]),asks:rows([[900,7]])});
    expect(book.levels(50).bids.at(-1)).toEqual({price:1,quantity:999});expect(book.levels(50).asks.at(-1)).toEqual({price:900,quantity:7});
  });

  it('prunes far levels instead of resetting when the book grows past its cap',()=>{
    const book=seed(.5);// wide horizon so 9,000 levels are all learned
    const bids=Array.from({length:9000},(_,i)=>({price:99-i*.001,quantity:1})),asks=Array.from({length:9000},(_,i)=>({price:102+i*.001,quantity:1}));
    expect(next(book,{bids,asks})).toBe('applied');// > 8,000 → pruned outside ±50% only; all inside stay
    expect(book.levels(20_000).bids.length).toBeGreaterThan(8000);
    // Price runs far away: the old levels fall outside the horizon and are dropped on the next big diff.
    const far=Array.from({length:1500},(_,i)=>({price:160+i*.01,quantity:1}));
    expect(next(book,{bids:rows([[159,3]]),asks:far})).toBe('applied');
    expect(book.ready).toBe(true);
  });

  it('exposes more than 1,000 levels through a session limit, clamped to the book cap',async()=>{
    Socket.instances=[];
    const many=Array.from({length:1500},(_,i)=>[String(100-i*.01),'1']),asks=Array.from({length:1500},(_,i)=>[String(101+i*.01),'1']);
    const request=vi.fn<typeof fetch>().mockResolvedValue(response({lastUpdateId:100,bids:many,asks}));
    const session=createOrderBookSession({symbol:'BTCUSDT',limit:5000,horizonRatio:.2,fetch:request,WebSocket:Socket});cleanup.push(()=>session.disconnect());
    await session.connect();const socket=Socket.instances.at(-1)!;socket.open();await flush();
    socket.receive(message({U:99,u:101,pu:98,b:[['95.5','9']],a:[['500','1']]}));await flush();
    const snapshot=session.snapshot();
    expect(snapshot.bids.length).toBeGreaterThan(1000);expect(snapshot.asks.length).toBeLessThanOrEqual(1500);// 500 is 4× the mid: not learned
    expect(createOrderBookSession({symbol:'BTCUSDT',limit:99_999,fetch:request,WebSocket:Socket}).snapshot().bids).toEqual([]);
  });
});
