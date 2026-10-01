import {afterEach,describe,expect,it,vi} from 'vitest';
import {BinanceFeed} from '../src/lib/feed/binance-feed';
import type {BarEvent} from '../src/lib/core/types';
import {futuresInfo} from './fixtures/binance-contracts';
const base=Date.UTC(2025,0,1),step=60_000;
const row=(i:number)=>[base+i*step,'100','110','90','101','12'];
const response=(rows:unknown)=>Promise.resolve(new Response(JSON.stringify(rows)));
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
class Socket {
  static last:Socket;
  onopen:(()=>void)|null=null;onclose:(()=>void)|null=null;onerror:(()=>void)|null=null;onmessage:((e:{data:string})=>void)|null=null;
  constructor(){Socket.last=this;}
  close(){this.onclose?.();}
  tick(time:number){this.onmessage?.({data:JSON.stringify({k:{t:time,o:'100',h:'110',l:'90',c:'102',v:'15'}})});}
}
function paged(rows:unknown[][]){return vi.fn((input:RequestInfo|URL)=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith('/exchangeInfo'))return response(futuresInfo());
  const end=url.searchParams.get('endTime'),start=url.searchParams.get('startTime'),limit=Number(url.searchParams.get('limit'));
  if(start!==null)return response(rows.filter(r=>Number(r[0])>=Number(start)).slice(0,limit));
  return response((end!==null?rows.filter(r=>Number(r[0])<=Number(end)):rows).slice(-limit));
});}
afterEach(()=>vi.unstubAllGlobals());

describe('Binance read-only older chart history',()=>{
  it('walks strictly backward with pages <=1000 and returns one ordered continuous range',async()=>{
    const request=paged(Array.from({length:2500},(_,i)=>row(i)));vi.stubGlobal('fetch',request);
    const feed=new BinanceFeed({restBase:'https://example.test',symbol:'ETHUSDT',limit:50});
    const received:BarEvent[]=[];feed.onBar(event=>received.push(event));const status=vi.fn();feed.onStatus(status);
    const result=await feed.loadBefore(base+2500*step,2105);
    expect(result).toHaveLength(2105);expect(result[0].time).toBe(base+395*step);expect(result.at(-1)!.time).toBe(base+2499*step);
    const urls=request.mock.calls.map(call=>new URL(String(call[0])));
    expect(urls.map(url=>url.searchParams.get('limit'))).toEqual(['1000','1000','105']);
    expect(urls.map(url=>Number(url.searchParams.get('endTime')))).toEqual([base+2500*step-1,base+1500*step-1,base+500*step-1]);
    expect(urls.every(url=>url.pathname==='/fapi/v1/klines'&&!url.searchParams.has('startTime')&&url.searchParams.get('symbol')==='ETHUSDT')).toBe(true);
    expect(result.every((bar,i)=>!i||bar.time===result[i-1].time+step)).toBe(true);
    expect(received).toEqual([]);expect(status).not.toHaveBeenCalled();feed.disconnect();
  });

  it('keeps the snapshot/live cursor intact while history loads',async()=>{
    const rows=Array.from({length:2002},(_,i)=>row(i)),request=paged(rows);vi.stubGlobal('fetch',request);vi.stubGlobal('WebSocket',Socket);
    const feed=new BinanceFeed({limit:2}),events:BarEvent[]=[];feed.onBar(event=>events.push(event));
    const snapshot=await feed.loadBulk();expect(snapshot[0].time).toBe(base+2000*step);
    await feed.loadBefore(snapshot[0].time,1500);expect(events).toEqual([]);
    await feed.connect();Socket.last.onopen?.();await flush();
    const recovery=request.mock.calls.map(call=>new URL(String(call[0]))).find(url=>url.searchParams.has('startTime'));
    expect(recovery?.searchParams.get('startTime')).toBe(String(base+2001*step));
    Socket.last.tick(base+2002*step);await flush();
    expect(events.at(-1)).toMatchObject({time:base+2002*step,isNew:true,close:102});feed.disconnect();
  });

  it('stops cleanly at the beginning of available history',async()=>{
    const request=paged([row(0),row(1),row(2)]);vi.stubGlobal('fetch',request);
    const feed=new BinanceFeed();expect(await feed.loadBefore(base+3*step,1500)).toHaveLength(3);expect(request).toHaveBeenCalledOnce();feed.disconnect();
  });

  it.each([
    ['repeated timestamp',[row(1),row(1),row(2)]],
    ['internal gap',[row(0),row(2)]],
    ['boundary gap',[row(0),row(1)]],
    ['overlapping current candle',[row(1),row(2),row(3)]],
  ])('rejects %s instead of fabricating continuity',async(_label,rows)=>{
    vi.stubGlobal('fetch',vi.fn(()=>response(rows)));const feed=new BinanceFeed();
    await expect(feed.loadBefore(base+3*step,3)).rejects.toThrow(/Unordered|gap|overlap/);feed.disconnect();
  });

  it('rejects an in-flight response after disconnect even if fetch ignores abort',async()=>{
    let finish:(value:Response)=>void=()=>{};let signal:AbortSignal|undefined;
    const request=vi.fn((_input:RequestInfo|URL,options?:RequestInit)=>{signal=options?.signal as AbortSignal;return new Promise<Response>(resolve=>{finish=resolve;});});vi.stubGlobal('fetch',request);
    const feed=new BinanceFeed(),pending=feed.loadBefore(base+3*step,3);feed.disconnect();expect(signal?.aborted).toBe(true);
    finish(new Response(JSON.stringify([row(0),row(1),row(2)])));
    await expect(pending).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
    await expect(feed.loadBefore(base+3*step)).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
  });

  it('uses real calendar boundaries when prepending monthly candles',async()=>{
    vi.stubGlobal('fetch',vi.fn(()=>response([Date.UTC(2024,0,1),Date.UTC(2024,1,1)].map(time=>[time,100,110,90,101,10]))));
    const feed=new BinanceFeed({interval:'1M'});expect(await feed.loadBefore(Date.UTC(2024,2,1),2)).toHaveLength(2);feed.disconnect();
  });
});
