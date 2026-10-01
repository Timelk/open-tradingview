import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {MarketDataService,createMarketDataHandler} from '../server/market-data';
import {MarketStore} from '../server/market-store';
import {createMarketDataClient,type RecordedMarketEvent} from '../src/lib/flow/persistence-client';
const epoch=Date.UTC(2026,0,1),cleanup:Array<()=>Promise<unknown>|void>=[];
async function directory(){const path=await mkdtemp(join(tmpdir(),'chart-resume-test-'));cleanup.unshift(()=>rm(path,{recursive:true,force:true}));return path;}
afterEach(async()=>{for(const run of cleanup.splice(0).reverse())await run();vi.useRealTimers();vi.restoreAllMocks();});
const checkpoint=(time:number,id=10):RecordedMarketEvent=>({kind:'depth-snapshot',origin:'checkpoint',time,receivedAt:time,lastUpdateId:id,bids:[{price:100,quantity:5}],asks:[{price:101,quantity:4}]});
const trade=(id:number,time:number):RecordedMarketEvent=>({kind:'aggTrade',receivedAt:time,trade:{symbol:'BTCUSDT',id:String(id),time,price:100,baseQuantity:2,quoteQuantity:200,aggressor:'buy'}});

describe('explicit same-dataset recording resume',()=>{
  it('retains old data, marks the real pause, and waits for a new book instead of extending the old one',async()=>{
    vi.useFakeTimers();vi.setSystemTime(epoch);const service=new MarketDataService({directory:await directory(),recordLive:false});cleanup.push(()=>service.close());
    const original=service.startRecording('BTCUSDT');service.store.append(original.id,[checkpoint(epoch),trade(7,epoch)]);
    vi.setSystemTime(epoch+1000);service.stopRecording(original.id);vi.setSystemTime(epoch+10_000);const resumed=service.resumeRecording(original.id);
    expect(resumed.id).toBe(original.id);expect(resumed.tradeCount).toBe(1);expect(resumed.state).toBe('recording');expect(service.store.list()).toHaveLength(1);
    expect(resumed.recordingPauses).toEqual([{fromTime:epoch+1000,toTime:epoch+10_000,notedAt:epoch+1000,reason:expect.any(String)}]);
    expect(service.store.replayBook(original.id,epoch+500).status).toBe('available');expect(service.store.replayBook(original.id,epoch+5000).status).toBe('gap');expect(service.store.replayBook(original.id,epoch+10_001).status).toBe('gap');
    vi.setSystemTime(epoch+10_010);service.store.append(original.id,[checkpoint(epoch+10_010,20),trade(10,epoch+10_010)]);
    expect(service.store.replayBook(original.id,epoch+10_011).status).toBe('available');expect(service.store.coverage(original.id).gaps.some(g=>g.channel==='depth'&&g.afterTime===epoch+1000&&g.beforeTime===epoch+10_000)).toBe(true);
    expect(service.store.coverage(original.id).gaps.some(g=>g.channel==='trades'&&g.fromId==='8'&&g.toId==='9')).toBe(true);
    service.store.append(original.id,[trade(8,epoch+2000),trade(9,epoch+3000)]);
    expect(service.store.coverage(original.id).gaps.some(g=>g.channel==='trades')).toBe(false);expect(service.store.replayBook(original.id,epoch+5000).status).toBe('gap');
  });
  it('is idempotent under repeated stop/resume and does not create duplicate pause records',async()=>{
    vi.useFakeTimers();vi.setSystemTime(epoch);const service=new MarketDataService({directory:await directory(),recordLive:false});cleanup.push(()=>service.close());const item=service.startRecording('BTCUSDT');
    vi.setSystemTime(epoch+100);const stopped=service.stopRecording(item.id);expect(service.stopRecording(item.id)).toEqual(stopped);
    vi.setSystemTime(epoch+1000);const first=service.resumeRecording(item.id);vi.setSystemTime(epoch+2000);expect(service.resumeRecording(item.id)).toEqual(first);expect(service.store.get(item.id).recordingPauses).toHaveLength(1);
  });
  it('never auto-restarts after a service interruption and preserves the pause across another restart',async()=>{
    vi.useFakeTimers();vi.setSystemTime(epoch);const dir=await directory(),store=new MarketStore(dir),item=store.create({symbol:'BTCUSDT',kind:'recording',tradeType:'aggTrades',state:'recording',source:'test recording'});
    store.append(item.id,[checkpoint(epoch),trade(7,epoch)]);store.close(); // Simulated interrupted service, without graceful stop.
    vi.setSystemTime(epoch+10_000);const request=vi.fn(async()=>Response.json([])),service=new MarketDataService({directory:dir,recordLive:false,fetch:request});cleanup.push(()=>service.close());
    const paused=service.store.get(item.id);expect(paused.state).toBe('stopped');expect(request).not.toHaveBeenCalled();expect(paused.recordingPauses?.[0]).toMatchObject({fromTime:epoch+1,notedAt:epoch+10_000});
    expect(service.store.replayBook(item.id,epoch).status).toBe('available');
    service.resumeRecording(item.id);expect(service.store.replayBook(item.id,epoch+5000).status).toBe('gap');
    vi.setSystemTime(epoch+11_000);await service.close();vi.setSystemTime(epoch+20_000);const reopened=new MarketDataService({directory:dir,recordLive:false});cleanup.push(()=>reopened.close());
    expect(reopened.store.get(item.id).state).toBe('stopped');expect(reopened.store.get(item.id).tradeCount).toBe(1);expect(reopened.store.get(item.id).recordingPauses).toHaveLength(2);
    reopened.resumeRecording(item.id);expect(reopened.store.replayBook(item.id,epoch+15_000).status).toBe('gap');
  });
  it('refuses archives, competing same-symbol recordings and closed-service operations',async()=>{
    const service=new MarketDataService({directory:await directory(),recordLive:false});cleanup.push(()=>service.close());
    const archive=service.store.create({symbol:'BTCUSDT',kind:'archive',tradeType:'aggTrades',state:'complete',source:'public file'});expect(()=>service.resumeRecording(archive.id)).toThrow('已停止');
    const first=service.startRecording('BTCUSDT');service.stopRecording(first.id);const second=service.startRecording('BTCUSDT');expect(()=>service.resumeRecording(first.id)).toThrow('另一录制');expect(service.store.get(first.id).state).toBe('stopped');
    service.stopRecording(second.id);service.resumeRecording(first.id);await service.close();expect(()=>service.resumeRecording(first.id)).toThrow('已关闭');
  });
  it('rolls a failed resume write back to stopped without claiming an observed interval',async()=>{
    vi.useFakeTimers();vi.setSystemTime(epoch);const service=new MarketDataService({directory:await directory(),recordLive:false});cleanup.push(()=>service.close());const item=service.startRecording('BTCUSDT');
    vi.setSystemTime(epoch+100);const stopped=service.stopRecording(item.id);vi.setSystemTime(epoch+1000);
    vi.spyOn(service.store,'append').mockImplementationOnce(()=>{throw Error('disk write failed');});expect(()=>service.resumeRecording(item.id)).toThrow('disk write failed');
    expect(service.store.get(item.id)).toMatchObject({state:'stopped',recordingPauses:stopped.recordingPauses,stoppedAt:stopped.stoppedAt});
  });
});

describe('resumed recorder network lifecycle',()=>{
  class Socket {
    static list:Socket[]=[];onopen:((e:Event)=>void)|null=null;onmessage:((e:MessageEvent)=>void)|null=null;onclose:((e:CloseEvent)=>void)|null=null;onerror:((e:Event)=>void)|null=null;
    constructor(readonly url:string){Socket.list.push(this);}close=vi.fn();open(){this.onopen?.({} as Event);}break(){this.onclose?.({} as CloseEvent);}
  }
  it('starts only on explicit resume and requests trades after the persisted cursor',async()=>{
    vi.useFakeTimers();vi.setSystemTime(epoch);Socket.list=[];const dir=await directory(),old=new MarketDataService({directory:dir,recordLive:false}),item=old.startRecording('BTCUSDT');old.store.append(item.id,[trade(7,epoch)]);await old.close();
    vi.setSystemTime(epoch+10_000);const calls:string[]=[],request:typeof fetch=async url=>{calls.push(String(url));return Response.json(String(url).includes('aggTrades')?[{a:8,p:'100',q:'1',T:epoch+10_000,m:false}]:{lastUpdateId:10,T:epoch+10_000,bids:[['100','1']],asks:[['101','1']]});};
    const service=new MarketDataService({directory:dir,fetch:request,WebSocket:Socket as unknown as typeof WebSocket,flushMs:50});cleanup.push(()=>service.close());
    expect(Socket.list).toHaveLength(0);service.resumeRecording(item.id);expect(Socket.list).toHaveLength(2);Socket.list.find(s=>s.url.includes('/market/'))!.open();await vi.advanceTimersByTimeAsync(60);
    expect(calls.find(c=>c.includes('aggTrades'))).toContain('fromId=8');expect(service.store.get(item.id).tradeCount).toBe(2);
    service.resumeRecording(item.id);expect(Socket.list).toHaveLength(2);service.stopRecording(item.id);expect(Socket.list.every(s=>s.close.mock.calls.length===1)).toBe(true);
  });
  it('cancels pending recovery on stop and ignores a late REST response',async()=>{
    vi.useFakeTimers();vi.setSystemTime(epoch);Socket.list=[];let release!:(r:Response)=>void;
    const service=new MarketDataService({directory:await directory(),fetch:()=>new Promise<Response>(done=>release=done),WebSocket:Socket as unknown as typeof WebSocket,flushMs:50});cleanup.push(()=>service.close());
    const item=service.startRecording('BTCUSDT');Socket.list.find(s=>s.url.includes('/market/'))!.open();service.stopRecording(item.id);release(Response.json([{a:1,p:'100',q:'2',T:epoch,m:false}]));await vi.advanceTimersByTimeAsync(100);
    expect(service.store.get(item.id).state).toBe('stopped');expect(service.store.get(item.id).tradeCount).toBe(0);
  });
  it('does not let immediate open/close flapping reset the bounded reconnect budget',async()=>{
    vi.useFakeTimers();vi.setSystemTime(epoch);Socket.list=[];const service=new MarketDataService({directory:await directory(),fetch:async()=>Response.json([]),WebSocket:Socket as unknown as typeof WebSocket});cleanup.push(()=>service.close());
    const item=service.startRecording('BTCUSDT');
    for(let attempt=0;attempt<7;attempt++){const socket=Socket.list.filter(s=>s.url.includes('/market/')).at(-1)!;socket.open();socket.break();await vi.advanceTimersByTimeAsync(attempt<6?500*2**attempt:60_000);}
    expect(Socket.list.filter(s=>s.url.includes('/market/'))).toHaveLength(7);expect(service.store.get(item.id).warning).toMatch(/重连|L2/);service.stopRecording(item.id);
  });
});

describe('local explicit resume route and client',()=>{
  it('uses the existing dataset route and refuses malformed cancelled request bodies',async()=>{
    const dir=await directory(),handler=createMarketDataHandler({directory:dir,recordLive:false}),server=createServer((req,res)=>handler(req,res,()=>res.end()));
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    cleanup.push(async()=>{await new Promise<void>(done=>server.close(()=>done()));await handler.close();});
    const client=createMarketDataClient((input,init)=>fetch(base+input,init)),item=await client.startRecording('BTCUSDT');await client.stopRecording(item.id);
    const malformed=await fetch(`${base}/api/market-data/recordings/${item.id}/resume`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});expect(malformed.status).toBe(400);
    expect((await client.coverage(item.id)).dataset.state).toBe('stopped');const resumed=await client.resumeRecording(item.id);expect(resumed.id).toBe(item.id);expect(resumed.state).toBe('recording');
    expect((await client.datasets()).filter(d=>d.kind==='recording')).toHaveLength(1);
  });
});
