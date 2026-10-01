import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore} from '../server/market-store';
import {HeatmapScheduler,HeatmapBusyError} from '../server/market-heatmap';
import {Level2Book} from '../src/lib/flow/orderbook';
import type {RecordedMarketEvent} from '../src/lib/flow/persistence-client';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(events:RecordedMarketEvent[]=[]){
  const path=await mkdtemp(join(tmpdir(),'heatmap-')),store=new MarketStore(path);
  cleanup.push(async()=>{store.close();await rm(path,{recursive:true,force:true});});
  const info=store.create({symbol:'BTCUSDT',kind:'recording',tradeType:'aggTrades',state:'recording',source:'test'});
  for(let i=0;i<events.length;i+=1000)store.append(info.id,events.slice(i,i+1000));
  return {store,id:info.id};
}
const snapshot=(time:number,receivedAt=time,lastUpdateId=10,origin:'rest'|'checkpoint'='checkpoint',quantity=5):RecordedMarketEvent=>({kind:'depth-snapshot',time,receivedAt,lastUpdateId,origin,bids:[{price:100,quantity}],asks:[{price:101,quantity:4}]});
const diff=(time:number,receivedAt=time,u=11,pu=u-1):RecordedMarketEvent=>({kind:'depth-diff',time,receivedAt,U:u,u,pu,bids:[{price:100,quantity:u}],asks:[]});
async function equivalent(store:MarketStore,id:string,from:number,to:number,samples=160){
  const expected=Array.from({length:samples},(_,i)=>{const time=Math.round(from+(to-from)*i/(samples-1));return {time,book:store.replayBook(id,time,10)};});
  const actual=await store.heatmap(id,from,to,samples,10);expect(actual.samples).toEqual(expected);return actual;
}
describe('multi-sample heatmap replay equivalence',()=>{
  it('preserves both clocks, REST bridging and late checkpoint visibility',async()=>{
    const {store,id}=await fixture([snapshot(100,100,10,'rest'),{...diff(110,110,12,9),U:10} as RecordedMarketEvent,
      {kind:'gap',time:130,receivedAt:130,reason:'网络缺口'},snapshot(150,160,30)]);
    await equivalent(store,id,90,180);
    expect((await store.heatmap(id,90,180,4,10)).samples.map(sample=>sample.book.status)).toEqual(['unavailable','available','gap','available']);
  });
  it.each(['receipt','event'] as const)('rebuilds when a lower seq becomes available late through its %s clock',async clock=>{
    const late=clock==='receipt'?diff(10,50,11):diff(50,10,11);
    const {store,id}=await fixture([snapshot(0),late,diff(20,20,12,11)]);
    const result=await equivalent(store,id,0,60,61);
    expect(result.samples[25].book.status).toBe('gap');expect(result.samples[50].book).toMatchObject({status:'available',lastUpdateId:12,time:20});
  });
  it('selects the latest eligible snapshot by seq, not event or receive time ordering',async()=>{
    const {store,id}=await fixture([snapshot(0),diff(10,10,11),snapshot(5,70,1000),diff(30,30,1001,1000),snapshot(20,40,2000)]);
    await equivalent(store,id,0,100,101);
    expect(store.replayBook(id,39).status).toBe('gap');expect(store.replayBook(id,70).lastUpdateId).toBe(2000);
  });
  it('preserves explicit gaps, ignored trade gaps, staleness and quantity deletion',async()=>{
    const {store,id}=await fixture([snapshot(0),diff(10,10,11),{...diff(12,12,10),bids:[{price:100,quantity:0}]} as RecordedMarketEvent,
      {kind:'gap',channel:'trades',time:15,receivedAt:15,reason:'trade-only'},diff(20,20,12),
      {...diff(25,25,13),bids:[{price:100,quantity:0}]} as RecordedMarketEvent,
      {kind:'gap',channel:'depth',time:30,receivedAt:30,reason:'depth stop'},snapshot(50,50,100),diff(60,60,101)]);
    await equivalent(store,id,0,70,71);expect(store.replayBook(id,26).bids).toEqual([]);
  });
  it('preserves pause boundaries and the stopped recording cutoff',async()=>{
    const {store,id}=await fixture([snapshot(0),diff(20,20,11),snapshot(80,80,100)]);
    store.update({...store.get(id),state:'stopped',stoppedAt:100,recordingPauses:[{fromTime:30,toTime:70,notedAt:70,reason:'manual pause'}]});
    await equivalent(store,id,0,120,121);
    expect(store.replayBook(id,40).status).toBe('gap');expect(store.replayBook(id,101).status).toBe('unavailable');
  });
  it('counts all eligible events before returning a gap, preserving the 25000-event truncation priority',async()=>{
    const events:RecordedMarketEvent[]=[snapshot(0),{kind:'gap',time:1,receivedAt:1,reason:'early gap'}];
    for(let i=2;i<=25001;i++)events.push(diff(i,i,i+10));
    const {store,id}=await fixture(events),result=await equivalent(store,id,24999,25001,3);
    expect(result.samples.map(sample=>sample.book.status)).toEqual(['gap','gap','truncated']);
  });
  it('does not resubmit the complete verified diff prefix for every normal sample',async()=>{
    const {store,id}=await fixture([snapshot(0),...Array.from({length:1000},(_,i)=>diff(i+1,i+1,i+11))]);
    const spy=vi.spyOn(Level2Book.prototype,'apply');
    const actual=await store.heatmap(id,0,1000,160,10),work=spy.mock.calls.length;
    spy.mockRestore();expect(work).toBe(1001);
    expect(actual.samples).toEqual(Array.from({length:160},(_,i)=>{const time=Math.round(1000*i/159);return {time,book:store.replayBook(id,time,10)};}));
  });
  it('observes newly appended historical checkpoints after yielding without reusing a stale cursor',async()=>{
    const {store,id}=await fixture([snapshot(0,0,10,'checkpoint',1)]);
    const changed=new Promise<void>(resolve=>setImmediate(()=>{store.append(id,[snapshot(0,0,20,'checkpoint',9)]);resolve();}));
    const output=await store.heatmap(id,0,0,32,10);await changed;
    expect(output.samples.slice(0,8).every(sample=>sample.book.bids[0]?.quantity===1)).toBe(true);
    expect(output.samples.slice(8).every(sample=>sample.book.bids[0]?.quantity===9)).toBe(true);
  });
});
describe('cancellable bounded heatmap work',()=>{
  it('cancels before replay and stops an active replay at a scheduling boundary',async()=>{
    const {store,id}=await fixture([snapshot(0),...Array.from({length:5000},(_,i)=>diff(i+1,i+1,i+11))]);
    const before=new AbortController();before.abort();await expect(store.heatmap(id,0,5000,160,10,before.signal)).rejects.toHaveProperty('name','AbortError');
    const spy=vi.spyOn(Level2Book.prototype,'apply'),active=new AbortController();setImmediate(()=>active.abort());
    await expect(store.heatmap(id,0,5000,160,10,active.signal)).rejects.toHaveProperty('name','AbortError');expect(spy.mock.calls.length).toBeLessThan(5000);
    expect((await store.heatmap(id,0,0,2,10)).samples).toHaveLength(2);
  });
  it('allows one active and two waiting jobs, removes aborted waiting work, and releases admission',async()=>{
    const queue=new HeatmapScheduler();let release!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;}),first=queue.run(async()=>{await held;return 1;}),abort=new AbortController();
    const second=queue.run(async()=>2,abort.signal),third=queue.run(async()=>3);
    await expect(queue.run(async()=>4)).rejects.toBeInstanceOf(HeatmapBusyError);
    abort.abort();await expect(second).rejects.toHaveProperty('name','AbortError');
    const replacement=queue.run(async()=>4);release();expect(await Promise.all([first,third,replacement])).toEqual([1,3,4]);queue.close();
  });
  it('cancels active and pending work on store close without touching the closed database later',async()=>{
    const {store,id}=await fixture([snapshot(0),...Array.from({length:1000},(_,i)=>diff(i+1,i+1,i+11))]);
    const first=store.heatmap(id,0,1000,160,10),second=store.heatmap(id,0,1000,160,10);
    const outcomes=Promise.allSettled([first,second]);setImmediate(()=>store.close());
    for(const result of await outcomes){expect(result.status).toBe('rejected');if(result.status==='rejected')expect(result.reason.name).toBe('AbortError');}
  });
});
