import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WatchlistQuotes, WATCHLIST_QUOTE_STALE_MS } from '../src/lib/watchlist/quotes';
import type { WatchlistQuoteSnapshot } from '../src/lib/watchlist/types';

class Socket {
  static all: Socket[] = [];
  onopen: (()=>void)|null=null; onclose: (()=>void)|null=null; onerror: (()=>void)|null=null;
  onmessage: ((event:{data:string})=>void)|null=null;
  constructor(readonly url:string){Socket.all.push(this);}
  close(){this.onclose?.();}
  send(data:unknown){this.onmessage?.({data:JSON.stringify({data})});}
}
const row=(symbol='BTCUSDT',last=100,time=Date.now())=>({symbol,lastPrice:String(last),priceChange:'2',priceChangePercent:'2.04',highPrice:'120',lowPrice:'80',volume:'200',quoteVolume:'20000',closeTime:time});
const stream=(symbol='BTCUSDT',last=101,time=Date.now())=>({e:'24hrTicker',s:symbol,c:String(last),p:'3',P:'3.06',h:'120',l:'80',v:'201',q:'20100',E:time});
const response=(data:unknown,ok=true,status=200)=>Promise.resolve({ok,status,json:async()=>data});
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const cleanup:WatchlistQuotes[]=[];
const service=()=>{const quotes=new WatchlistQuotes();cleanup.push(quotes);return quotes;};
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(Date.UTC(2026,8,7));Socket.all=[];vi.stubGlobal('WebSocket',Socket);});
afterEach(()=>{for(const quotes of cleanup.splice(0))quotes.destroy();vi.useRealTimers();vi.unstubAllGlobals();});

it('clears an empty list without requesting the entire exchange ticker feed',async()=>{
  const fetch=vi.fn(()=>response([row()]));vi.stubGlobal('fetch',fetch);const quotes=service();expect(quotes.snapshot.status).toBe('loading');
  quotes.setSymbols([]);expect(quotes.snapshot.status).toBe('live');expect(fetch).not.toHaveBeenCalled();
  quotes.setSymbols(['BTCUSDT']);await settle();quotes.setSymbols([]);expect(quotes.snapshot.quotes).toEqual({});
  await vi.advanceTimersByTimeAsync(60000);expect(fetch).toHaveBeenCalledTimes(1);
});

it('uses futures all-symbol REST for large lists and one routed combined ticker stream',async()=>{
  const symbols=Array.from({length:45},(_,i)=>`AA${i}USDT`),fetch=vi.fn((url:string)=>response(symbols.map(s=>row(s))));vi.stubGlobal('fetch',fetch);
  const quotes=service();quotes.setSymbols(symbols);await settle();
  expect(fetch).toHaveBeenCalledTimes(1);expect(new URL(fetch.mock.calls[0][0]).search).toBe('');
  expect(Socket.all).toHaveLength(1);expect(Socket.all[0].url.startsWith('wss://fstream.binance.com/market/stream?streams=')).toBe(true);expect(Socket.all[0].url).toContain('aa0usdt@ticker/aa1usdt@ticker');
  expect(quotes.snapshot.status).toBe('live');expect(Object.keys(quotes.snapshot.quotes)).toHaveLength(45);
  expect(quotes.snapshot.quotes.AA0USDT).toMatchObject({last:100,change:2,changePercent:2.04,volume:200,quoteVolume:20000});
  for(const call of fetch.mock.calls as unknown[][]){expect(new URL(String(call[0])).hostname).toBe('fapi.binance.com');expect(String(call[0])).toContain('/fapi/v1/ticker/24hr');expect(call[1]).not.toHaveProperty('headers');}
  quotes.setSymbols([...symbols].reverse());expect(Socket.all).toHaveLength(1);expect(fetch).toHaveBeenCalledTimes(1);
});

it('uses supported single-symbol parameters for small watchlists and accepts object responses',async()=>{
  const fetch=vi.fn((url:string)=>response(row(new URL(url).searchParams.get('symbol')!)));vi.stubGlobal('fetch',fetch);const quotes=service();quotes.setSymbols(['BTCUSDT','ETHUSDT']);await settle();
  expect(fetch.mock.calls.map(call=>new URL(call[0]).search)).toEqual(['?symbol=BTCUSDT','?symbol=ETHUSDT']);expect(Object.keys(quotes.snapshot.quotes)).toEqual(['BTCUSDT','ETHUSDT']);expect(quotes.snapshot.status).toBe('live');
});

it('keeps newer websocket prices when the older REST response arrives later',async()=>{
  let resolve!:(value:unknown)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise(r=>resolve=r)));
  const quotes=service();quotes.setSymbols(['BTCUSDT']);Socket.all[0].onopen?.();
  Socket.all[0].send(stream('BTCUSDT',111,Date.now()+1));await vi.advanceTimersByTimeAsync(100);
  resolve({ok:true,json:async()=>[row('BTCUSDT',99,Date.now()-1000)]});await settle();
  expect(quotes.snapshot.quotes.BTCUSDT.last).toBe(111);
  Socket.all[0].send(stream('BTCUSDT',0));Socket.all[0].send({...stream(),c:'bad'});Socket.all[0].send(stream('ETHUSDT'));
  const copy=quotes.snapshot;copy.quotes.BTCUSDT.last=999;
  expect(quotes.snapshot.quotes.BTCUSDT.last).toBe(111);expect(quotes.snapshot.quotes.ETHUSDT).toBeUndefined();
});

it('aborts an obsolete symbol request and ignores its socket and late REST results',async()=>{
  const pending:{resolve:(value:unknown)=>void;signal:AbortSignal}[]=[];
  vi.stubGlobal('fetch',vi.fn((_url:string,opts:{signal:AbortSignal})=>new Promise(resolve=>pending.push({resolve,signal:opts.signal}))));
  const quotes=service();quotes.setSymbols(['BTCUSDT']);const oldPacket=Socket.all[0].onmessage;
  quotes.setSymbols(['ETHUSDT']);expect(pending[0].signal.aborted).toBe(true);
  pending[1].resolve({ok:true,json:async()=>[row('ETHUSDT',50)]});await settle();
  pending[0].resolve({ok:true,json:async()=>[row('BTCUSDT',100)]});oldPacket?.({data:JSON.stringify({data:stream('BTCUSDT')})});await settle();
  expect(Object.keys(quotes.snapshot.quotes)).toEqual(['ETHUSDT']);expect(quotes.snapshot.quotes.ETHUSDT.last).toBe(50);
});

it('retains original timestamps and marks disconnected data stale, then retries without invented prices',async()=>{
  const initialTime=Date.now(),fetch=vi.fn().mockImplementationOnce(()=>response([row('BTCUSDT',100,initialTime)])).mockRejectedValue(new Error('offline'));vi.stubGlobal('fetch',fetch);
  const quotes=service();quotes.setSymbols(['BTCUSDT']);Socket.all[0].onopen?.();await settle();
  await vi.advanceTimersByTimeAsync(WATCHLIST_QUOTE_STALE_MS+1000);
  expect(quotes.snapshot.status).toBe('stale');expect(quotes.snapshot.quotes.BTCUSDT.updatedAt).toBe(initialTime);expect(quotes.snapshot.quotes.BTCUSDT.last).toBe(100);
  fetch.mockImplementation(()=>response([row('BTCUSDT',105)]));quotes.retry();await settle();
  expect(quotes.snapshot.status).toBe('live');expect(quotes.snapshot.quotes.BTCUSDT.last).toBe(105);
});

it('continues with a public REST fallback while the ticker stream reconnects',async()=>{
  const fetch=vi.fn().mockImplementationOnce(()=>response([row()])).mockImplementation(()=>response([row('BTCUSDT',102)]));vi.stubGlobal('fetch',fetch);
  const quotes=service();quotes.setSymbols(['BTCUSDT']);await settle();Socket.all[0].onopen?.();Socket.all[0].close();
  expect(quotes.snapshot.status).toBe('stale');await vi.advanceTimersByTimeAsync(1000);
  expect(Socket.all).toHaveLength(2);expect(quotes.snapshot.status).toBe('live');expect(quotes.snapshot.quotes.BTCUSDT.last).toBe(102);
});

it('isolates an invalid or delisted perpetual instead of blocking valid neighbours',async()=>{
  const fetch=vi.fn((url:string)=>{const symbol=new URL(url).searchParams.get('symbol')!;return symbol==='DELISTEDUSDT'?response({code:-1121},false,400):response(row(symbol));});vi.stubGlobal('fetch',fetch);
  const quotes=service();quotes.setSymbols(['BTCUSDT','DELISTEDUSDT']);await settle();
  expect(fetch).toHaveBeenCalledTimes(2);expect(quotes.snapshot.quotes.BTCUSDT.last).toBe(100);expect(quotes.snapshot.quotes.DELISTEDUSDT).toBeUndefined();expect(quotes.snapshot.status).toBe('stale');
});

it('surfaces initial failures and cancels all future network work on destruction',async()=>{
  const fetch=vi.fn().mockRejectedValue(new Error('network unavailable'));vi.stubGlobal('fetch',fetch);
  const quotes=service(),states:WatchlistQuoteSnapshot[]=[];quotes.subscribe(value=>states.push(value));quotes.setSymbols(['BTCUSDT','BTCUSDT.P']);await settle();
  expect(quotes.snapshot.status).toBe('error');expect(quotes.snapshot.quotes).toEqual({});expect(Socket.all[0].url).not.toContain('.p');
  quotes.destroy();const calls=fetch.mock.calls.length,count=states.length;await vi.advanceTimersByTimeAsync(120000);
  expect(fetch).toHaveBeenCalledTimes(calls);expect(states).toHaveLength(count);expect(Socket.all).toHaveLength(1);
});

it('does not overlap a reconnect snapshot with an already pending REST request',async()=>{
  const fetch=vi.fn(()=>new Promise(()=>{}));vi.stubGlobal('fetch',fetch);const quotes=service();quotes.setSymbols(['BTCUSDT']);Socket.all[0].close();
  await vi.advanceTimersByTimeAsync(4000);expect(fetch).toHaveBeenCalledTimes(1);
});
