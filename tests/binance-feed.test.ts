import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BinanceFeed, nextOpenTime } from '../src/lib/feed/binance-feed';
import {futuresInfo,futuresSymbol} from './fixtures/binance-contracts';
import type { BarEvent, FeedStatus } from '../src/lib/core/types';

class Socket {
  static all:Socket[]=[];
  onopen:(()=>void)|null=null;onclose:(()=>void)|null=null;onerror:(()=>void)|null=null;onmessage:((e:{data:string})=>void)|null=null;
  constructor(readonly url:string){Socket.all.push(this);}
  close(){this.onclose?.();}
  sendBar(time:number,close=102,confirmed=false){this.onmessage?.({data:JSON.stringify({k:{t:time,o:'100',h:'110',l:'90',c:String(close),v:'12',x:confirmed}})});}
}
const row=(time:number)=>[time,'100','110','90','101','10'];
const response=(rows:unknown)=>Promise.resolve({ok:true,json:async()=>rows});
const stubFetch=(request:typeof fetch)=>vi.stubGlobal('fetch',((url:RequestInfo|URL,options?:RequestInit)=>String(url).includes('/exchangeInfo')?response(futuresInfo()):request(url,options)) as typeof fetch);
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
beforeEach(()=>{vi.useFakeTimers();Socket.all=[];vi.stubGlobal('WebSocket',Socket);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('Binance snapshot / live recovery',()=>{
  it('loads verified futures filters and refuses spot, delivery and stopped contracts before requesting bars',async()=>{
    const btc=futuresSymbol(),request=vi.fn(async()=>({ok:true,json:async()=>({symbols:[{...btc,status:'SETTLING'},futuresSymbol('ETHUSDT')]})}));vi.stubGlobal('fetch',request);
    await expect(new BinanceFeed({symbol:'BINANCE:BTCUSDT.P'}).loadBulk()).rejects.toThrow('不是当前可交易');expect(request).toHaveBeenCalledOnce();expect(Socket.all).toHaveLength(0);
    expect(()=>new BinanceFeed({symbol:'ETHBTC'})).toThrow('USDT');expect(()=>new BinanceFeed({symbol:'BTCUSDT_260925'})).toThrow('USDT');
  });
  it('updates the open candle, ignores old/invalid ticks, and backfills a gap in order',async()=>{
    const fetch=vi.fn().mockImplementationOnce(()=>response([row(60000)]))
      .mockImplementationOnce(()=>response([row(60000)]))
      .mockImplementationOnce(()=>response([row(60000),row(120000),row(180000)]));
    stubFetch(fetch as unknown as typeof globalThis.fetch);
    const feed=new BinanceFeed({apiKey:'reserved-never-transmitted'}),events:BarEvent[]=[],statuses:FeedStatus[]=[];
    feed.onBar(b=>events.push(b));feed.onStatus(s=>statuses.push(s));
    await feed.loadBulk();await feed.connect();
    expect(feed.contract).toMatchObject({marketType:'usdm-perpetual',symbol:'BTCUSDT',tickSize:.1,minNotional:100,marketStepSize:.002});
    expect(new URL(String(fetch.mock.calls[0][0])).hostname).toBe('fapi.binance.com');
    expect(Socket.all[0].url.startsWith('wss://fstream.binance.com/market/ws/')).toBe(true);
    expect(statuses.at(-1)).toBe('reconnecting');
    const ws=Socket.all[0];ws.onopen?.();await settle();
    expect(statuses.at(-1)).toBe('ok');events.length=0;
    ws.sendBar(60000,103);await settle();ws.sendBar(0);ws.sendBar(60000,200);await settle();
    expect(events).toHaveLength(1);expect(events[0].isNew).toBe(false);
    ws.sendBar(60000,103,true);await settle();expect(events.at(-1)).toMatchObject({time:60000,isNew:false,confirmed:true});
    ws.sendBar(180000,104);await settle();
    expect(events.filter(b=>b.isNew).map(b=>b.time)).toEqual([120000,180000]);
    expect(events.at(-1)?.close).toBe(104);
    expect(String(fetch.mock.calls[2][0])).toContain('startTime=60000');
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('headers');
    feed.disconnect();
  });
  it('paginates more than 1000 missing candles and cancels reconnection after disconnect',async()=>{
    const base=60000;
    const fetch=vi.fn().mockImplementationOnce(()=>response([row(base)]))
      .mockImplementationOnce(()=>response(Array.from({length:1000},(_,i)=>row(base+i*60000))))
      .mockImplementationOnce(()=>response([row(base+1000*60000)]));
    stubFetch(fetch as unknown as typeof globalThis.fetch);
    const feed=new BinanceFeed(),events:BarEvent[]=[];feed.onBar(b=>events.push(b));
    await feed.loadBulk();await feed.connect();Socket.all[0].onopen?.();await settle();
    expect(events.filter(b=>b.isNew)).toHaveLength(1000);
    expect(String(fetch.mock.calls[2][0])).toContain('startTime=60060000');
    Socket.all[0].close();feed.disconnect();await vi.advanceTimersByTimeAsync(60000);
    expect(Socket.all).toHaveLength(1);
  });
  it('buffers live updates during recovery, and ignores an in-flight result after disconnect',async()=>{
    let finish:(v:unknown)=>void=()=>{};
    const fetch=vi.fn().mockImplementationOnce(()=>response([row(60000)]))
      .mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    stubFetch(fetch as unknown as typeof globalThis.fetch);
    const feed=new BinanceFeed(),events:BarEvent[]=[];feed.onBar(b=>events.push(b));
    await feed.loadBulk();await feed.connect();const ws=Socket.all[0];ws.onopen?.();ws.sendBar(120000);
    expect(events).toHaveLength(0);feed.disconnect();finish({ok:true,json:async()=>[row(60000),row(120000)]});await settle();
    expect(events).toHaveLength(0);
  });
  it('retries with backoff and reports connected only after websocket opens and recovery completes',async()=>{
    stubFetch(vi.fn(()=>response([row(60000)])) as unknown as typeof globalThis.fetch);
    const feed=new BinanceFeed(),statuses:FeedStatus[]=[];feed.onStatus(s=>statuses.push(s));
    await feed.loadBulk();await feed.connect();Socket.all[0].close();
    await vi.advanceTimersByTimeAsync(999);expect(Socket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);expect(Socket.all).toHaveLength(2);
    expect(statuses).not.toContain('ok');Socket.all[1].onopen?.();await settle();expect(statuses.at(-1)).toBe('ok');feed.disconnect();
  });
  it.each(['wss://fstream.binance.com/ws','wss://fstream.binance.com/ws/','wss://fstream.binance.com/market','wss://fstream.binance.com/market/ws/','wss://fstream.binance.com/public/ws'])('joins saved stream base %s once and receives live candle events through the public bridge',async wsBase=>{
    vi.stubGlobal('location',{hostname:'127.0.0.1',origin:'http://127.0.0.1:5173',protocol:'http:'});
    const request=vi.fn((_url:RequestInfo|URL,_options?:RequestInit)=>response([row(60000)]));stubFetch(request as unknown as typeof globalThis.fetch);
    const feed=new BinanceFeed({wsBase,restBase:'https://fapi.binance.com///'}),events:BarEvent[]=[];feed.onBar(event=>events.push(event));
    await feed.loadBulk();await feed.connect();const socket=Socket.all[0];
    expect(socket.url).toBe('ws://127.0.0.1:5173/api/market-public/binance/stream?stream=btcusdt%40kline_1m');
    expect(String(request.mock.calls[0][0])).toContain('/api/market-public/binance/rest/fapi/v1/klines?');
    socket.onopen?.();await settle();events.length=0;socket.sendBar(60000,102);await settle();socket.sendBar(60000,103);await settle();
    expect(events.map(event=>event.close)).toEqual([102,103]);expect(events.every(event=>event.confirmed===false)).toBe(true);feed.disconnect();
  });
  it('cancels only stale socket recovery when reconnecting, preserving a separate history request',async()=>{
    let recoverySignal:AbortSignal|undefined,historySignal:AbortSignal|undefined,finishHistory!:(value:unknown)=>void;
    const request=vi.fn((url:RequestInfo|URL,options?:RequestInit)=>{
      const query=new URL(String(url)).searchParams;
      if(query.has('startTime'))return new Promise((_resolve,reject)=>{recoverySignal=options!.signal!;recoverySignal.addEventListener('abort',()=>reject(recoverySignal!.reason),{once:true});});
      if(query.has('endTime'))return new Promise(resolve=>{historySignal=options!.signal!;finishHistory=resolve;});
      return response([row(60000)]);
    });stubFetch(request as unknown as typeof globalThis.fetch);
    const feed=new BinanceFeed();await feed.loadBulk();await feed.connect();Socket.all[0].onopen?.();await settle();
    const history=feed.loadBefore(60000,1);await settle();expect(recoverySignal?.aborted).toBe(false);expect(historySignal?.aborted).toBe(false);
    Socket.all[0].close();expect(recoverySignal?.aborted).toBe(true);expect(historySignal?.aborted).toBe(false);
    finishHistory({ok:true,json:async()=>[row(0)]});expect((await history)[0].time).toBe(0);feed.disconnect();
  });
  it('does not let a queued old socket open event cancel the replacement socket handshake timeout',async()=>{
    stubFetch(vi.fn(()=>response([row(60000)])) as unknown as typeof globalThis.fetch);
    const feed=new BinanceFeed();await feed.loadBulk();await feed.connect();const staleOpen=Socket.all[0].onopen!;Socket.all[0].close();
    await vi.advanceTimersByTimeAsync(1000);expect(Socket.all).toHaveLength(2);staleOpen();await settle();
    await vi.advanceTimersByTimeAsync(12000);expect(Socket.all.length).toBeGreaterThan(2);feed.disconnect();
  });
  it('reconnects a handshake-only silent stream even after REST recovery reported connected',async()=>{
    stubFetch(vi.fn(()=>response([row(60000)])) as unknown as typeof globalThis.fetch);
    const feed=new BinanceFeed(),statuses:FeedStatus[]=[];feed.onStatus(status=>statuses.push(status));
    await feed.loadBulk();await feed.connect();Socket.all[0].onopen?.();await settle();expect(statuses.at(-1)).toBe('ok');
    await vi.advanceTimersByTimeAsync(89999);expect(Socket.all).toHaveLength(1);expect(statuses.at(-1)).toBe('ok');
    await vi.advanceTimersByTimeAsync(1);expect(statuses.at(-1)).toBe('reconnecting');await vi.advanceTimersByTimeAsync(1000);expect(Socket.all).toHaveLength(2);
    feed.disconnect();expect(vi.getTimerCount()).toBe(0);
  });
  it('refreshes silence only on valid current candles and cancels every timer on disconnect',async()=>{
    stubFetch(vi.fn(()=>response([row(60000)])) as unknown as typeof globalThis.fetch);
    const feed=new BinanceFeed({staleAfterMs:10000}),statuses:FeedStatus[]=[];feed.onStatus(status=>statuses.push(status));
    await feed.loadBulk();await feed.connect();const socket=Socket.all[0];socket.onopen?.();await settle();
    await vi.advanceTimersByTimeAsync(9000);socket.sendBar(60000,103);await settle();await vi.advanceTimersByTimeAsync(9000);expect(statuses.at(-1)).toBe('ok');
    socket.sendBar(0,103);socket.sendBar(60000,999);socket.onmessage?.({data:'not JSON'});
    await vi.advanceTimersByTimeAsync(1000);expect(statuses.at(-1)).toBe('reconnecting');
    feed.disconnect();const count=Socket.all.length;await vi.advanceTimersByTimeAsync(300000);expect(Socket.all).toHaveLength(count);expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps an independent history request alive when the silent stream watchdog closes its socket',async()=>{
    let finishHistory!:(value:unknown)=>void,historySignal:AbortSignal|undefined;
    stubFetch(vi.fn((url:RequestInfo|URL,options?:RequestInit)=>{
      const query=new URL(String(url)).searchParams;
      if(query.has('endTime')&&!query.has('startTime'))return new Promise(resolve=>{historySignal=options!.signal!;finishHistory=resolve;});
      return response([row(60000)]);
    }) as unknown as typeof globalThis.fetch);
    const feed=new BinanceFeed({staleAfterMs:10000});await feed.loadBulk();await feed.connect();Socket.all[0].onopen?.();await settle();
    const history=feed.loadBefore(60000,1);await settle();await vi.advanceTimersByTimeAsync(10000);expect(historySignal?.aborted).toBe(false);
    finishHistory({ok:true,json:async()=>[row(0)]});expect((await history)[0].time).toBe(0);feed.disconnect();
  });
  it('calendar month boundaries use real UTC months',()=>{
    expect(nextOpenTime(Date.UTC(2024,1,1),'1M')).toBe(Date.UTC(2024,2,1));
    expect(nextOpenTime(0,'4h')).toBe(14400000);
  });
  it('preserves explicit REST and websocket endpoint overrides',async()=>{
    const fetch=vi.fn((_url:string)=>response([row(60000)]));stubFetch(fetch as unknown as typeof globalThis.fetch);
    const feed=new BinanceFeed({restBase:'https://example.test',wsBase:'wss://example.test:9443/custom/ws///',symbol:'ETHUSDT'});
    await feed.loadBulk();await feed.connect();
    expect(String(fetch.mock.calls[0][0])).toContain('https://example.test/fapi/v1/klines?');
    expect(Socket.all[0].url).toBe('wss://example.test:9443/custom/ws/ethusdt@kline_1m');feed.disconnect();
  });
});
