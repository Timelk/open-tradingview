import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore} from '../server/market-store';
import {initialBalance} from '../src/lib/flow/studies';
import type {AggregateTrade} from '../src/lib/flow/types';
const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function harness(){const dir=await mkdtemp(join(tmpdir(),'aggregate-'));cleanups.push(()=>rm(dir,{recursive:true,force:true}));const store=new MarketStore(dir);cleanups.push(async()=>store.close());const dataset=store.create({symbol:'BTCUSDT',kind:'recording',tradeType:'aggTrades',state:'recording',source:'test'});return{store,id:dataset.id};}
const trade=(id:number,time:number,price:number,side:'buy'|'sell'='buy'):AggregateTrade=>({symbol:'BTCUSDT',id:String(id),time,price,baseQuantity:2,quoteQuantity:price*2,aggressor:side});

describe('full selected-range SQL aggregation',()=>{
  it('conserves all selected volume despite footprint bar truncation and keeps CVD anchored before hidden bars',async()=>{
    const{store,id}=await harness();store.writeTrades(id,[trade(1,1000,100),trade(2,61000,101,'sell'),trade(3,121000,100),trade(4,181000,103),trade(5,241000,101,'sell')]);
    const result=await store.aggregate(id,{from:0,to:300000,tickSize:1,timeframeMs:60000,maxBars:2,tpoBlockMs:60000});
    expect(result).toMatchObject({totalBars:5,returnedBars:2,footprintTruncated:true});
    expect(result.snapshot.totals).toMatchObject({volumeBase:10,buyBase:6,sellBase:4,deltaBase:2,aggregateCount:5});
    expect(result.snapshot.profile.reduce((sum,p)=>sum+p.volumeBase,0)).toBe(10);
    expect(result.snapshot.footprint.map(p=>p.time)).toEqual([180000,240000]);
    expect(result.snapshot.footprint.map(p=>p.cvdBase)).toEqual([4,2]);
    expect(result.snapshot.footprint.reduce((sum,p)=>sum+p.volumeBase,0)).toBe(4);
    expect(result.snapshot.coverage).toMatchObject({retainedTrades:5,evictedTrades:0,scope:'persisted-selected-range'});
    expect(result.tpo.totalBlocks).toBe(5);
  });

  it('uses price tick rounding before coarse bins and dynamically bounds cells without dropping trades',async()=>{
    const{store,id}=await harness();const trades=Array.from({length:1000},(_,i)=>trade(i+1,1000+i*1000,.1+i*.01));store.writeTrades(id,trades);
    const result=await store.aggregate(id,{from:0,to:1100000,tickSize:.01,priceStepTicks:1,timeframeMs:1000,maxBars:500});
    expect(result.snapshot.effectivePriceStepTicks).toBeGreaterThan(1);expect(result.snapshot.profile.length).toBeLessThanOrEqual(61);
    expect(result.snapshot.profile.reduce((sum,p)=>sum+p.volumeBase,0)).toBe(2000);
    expect(result.snapshot.footprint.reduce((sum,b)=>sum+b.levels.length,0)).toBeLessThanOrEqual(30500);
    expect(result.snapshot.totals.aggregateCount).toBe(1000);expect(result.totalBars).toBe(1000);
  });

  it('limits aggregation to requested times, exposes ID gaps and never resets post-gap CVD to zero',async()=>{
    const{store,id}=await harness();store.writeTrades(id,[trade(1,1000,100),trade(3,121000,102),trade(4,181000,103)]);
    const result=await store.aggregate(id,{from:0,to:180000,tickSize:1,timeframeMs:60000,maxBars:10});
    expect(result.snapshot.totals.aggregateCount).toBe(2);expect(result.snapshot.coverage.gapCount).toBe(1);
    expect(result.snapshot.footprint.at(-1)!.cvdBase).toBeNaN();expect(result.coverage.gaps[0]).toMatchObject({fromId:'2',toId:'2'});
    store.writeTrades(id,[trade(2,61000,101)]);
    const repaired=await store.aggregate(id,{from:0,to:180000,tickSize:1,timeframeMs:60000});expect(repaired.snapshot.coverage.gapCount).toBe(0);expect(repaired.snapshot.footprint.at(-1)!.cvdBase).toBe(6);
  });

  it('handles empty ranges, cancellation, malformed bucket parameters and individual trade provenance',async()=>{
    const{store,id}=await harness();store.update({...store.get(id),tradeType:'trades'});
    const empty=await store.aggregate(id,{from:0,to:1000,tickSize:1,timeframeMs:1000});expect(empty.snapshot.profile).toEqual([]);expect(empty.snapshot.totals.volumeBase).toBe(0);expect(empty.snapshot.coverage.source).toBe('Binance USDⓈ-M trades');
    expect(()=>store.aggregate(id,{from:10,to:0,tickSize:1,timeframeMs:1000})).toThrow();
    expect(()=>store.aggregate(id,{from:0,to:100,tickSize:0,timeframeMs:1000})).toThrow();
    const abort=new AbortController();const pending=store.aggregate(id,{from:0,to:1000,tickSize:1,timeframeMs:1000},abort.signal);abort.abort();await expect(pending).rejects.toThrow('取消');
  });

  it('keeps count, cells, profile, CVD and gaps in one read snapshot while the recorder appends and repairs concurrently',async()=>{
    const{store,id}=await harness(),initial=40_000,missing=20_000;
    for(let start=1;start<=initial;start+=1000)store.writeTrades(id,Array.from({length:1000},(_,i)=>start+i).filter(i=>i!==missing).map(i=>trade(i,i*1000,100+i%200)));
    let settled=false;
    const reading=store.aggregate(id,{from:0,to:100_000_000,tickSize:1,timeframeMs:1000,maxBars:200});void reading.then(()=>{settled=true;},()=>{settled=true;});
    let writes=0;
    for(let batch=0;batch<30&&!settled;batch++){
      if(batch===5)store.writeTrades(id,[trade(missing,missing*1000,100+missing%200)]);
      const start=initial+batch*200+1;store.writeTrades(id,Array.from({length:200},(_,i)=>trade(start+i,(start+i)*1000,100+(start+i)%200)));writes++;
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    const result=await reading,total=result.snapshot.totals;
    expect(writes).toBeGreaterThan(0);
    expect(total.aggregateCount).toBe(result.coverage.dataset.tradeCount);
    expect(result.snapshot.revision).toBe(total.aggregateCount);
    expect(result.snapshot.profile.reduce((sum,row)=>sum+row.aggregateCount,0)).toBe(total.aggregateCount);
    expect(result.snapshot.profile.reduce((sum,row)=>sum+row.volumeBase,0)).toBe(total.volumeBase);
    expect(result.totalBars).toBe(total.aggregateCount);
    for(const bar of result.snapshot.footprint)expect(bar.levels.reduce((sum,row)=>sum+row.volumeBase,0)).toBe(bar.volumeBase);
    if(result.snapshot.coverage.gapCount)expect(result.snapshot.footprint.at(-1)!.cvdBase).toBeNaN();
    else expect(result.snapshot.footprint.at(-1)!.cvdBase).toBe(total.deltaBase);
  });
  it('anchors TPO visits and footprint buckets to the explicit session origin and returns exact traded extrema',async()=>{
    const{store,id}=await harness();store.writeTrades(id,[trade(1,35000,100.12),trade(2,65000,100.12),trade(3,95000,104.87)]);
    const result=await store.aggregate(id,{from:30000,to:100000,tickSize:.01,priceStepTicks:100,timeframeMs:60000,tpoBlockMs:60000,sessionOffsetMs:30000});
    expect(result.snapshot.footprint.map(bar=>bar.time)).toEqual([30000,90000]);
    expect(result.tpo.rows.find(row=>row.price===100)?.blocks).toBe(1);
    expect(result.priceRange).toEqual({low:100.12,high:104.87});
    expect(result.snapshot.aggregation.sessionOffsetMs).toBe(30000);
    const prefix=await store.aggregate(id,{from:30000,to:35000,tickSize:.01,timeframeMs:60000,sessionOffsetMs:30000});
    expect(prefix.priceRange).toEqual({low:100.12,high:100.12});
    expect(prefix.snapshot.totals.aggregateCount).toBe(1);
    const negative=await store.aggregate(id,{from:0,to:100000,tickSize:1,timeframeMs:60000,sessionOffsetMs:90000});
    expect(negative.snapshot.footprint.map(bar=>bar.time)).toEqual([30000,90000]);
  });

  it('requires actual continuous trade witnesses for recording IB, independent from depth and receive clocks',async()=>{
    const{store,id}=await harness(),from=1_000_000,minute=60_000,through=from+60*minute-1;
    store.append(id,[{kind:'depth-snapshot',time:from,receivedAt:from,lastUpdateId:1,bids:[{price:100,quantity:1}],asks:[{price:101,quantity:1}]},{kind:'gap',time:from+120*minute,receivedAt:from+120*minute,channel:'depth',reason:'depth marker'}]);
    store.writeTrades(id,[trade(2,from+20*minute,100),trade(3,from+25*minute,101)]);
    // The stream's broad metadata does not prove any trade interval.
    const query={from,to:through,tickSize:1,timeframeMs:60*minute,maxBars:1,sessionOffsetMs:from};
    let result=await store.aggregate(id,query);expect(result.coverage.dataset.fromTime).toBe(from);
    expect(result.coverage.dataset.recordedThrough).toBeGreaterThanOrEqual(from+120*minute);
    expect(result.snapshot.coverage.gapCount).toBe(0);expect(result.tradeCoverage?.complete).toBe(false);expect(initialBalance(result,from,60*minute,from+120*minute).status).toBe('partial');
    store.writeTrades(id,[trade(1,from-1000,99),trade(5,from+65*minute,102)]);
    result=await store.aggregate(id,query);expect(result.tradeCoverage).toMatchObject({complete:false,basis:'unproven'});
    // Fill the real missing trade ID. L2 gaps remain but no longer invalidate
    // trade coverage; the nearest right witness is known only at minute 65.
    store.writeTrades(id,[trade(4,from+40*minute,100.5)]);
    result=await store.aggregate(id,query);expect(result.tradeCoverage).toMatchObject({complete:true,basis:'continuous-trade-ids',availableAt:from+65*minute});
    expect(result.snapshot.coverage.gapCount).toBe(0);expect(result.coverage.dataset.gapCount).toBe(1);
    expect(initialBalance(result,from,60*minute,through).status).toBe('partial');
    expect(initialBalance(result,from,60*minute,from+65*minute).status).toBe('complete');
    expect(result.priceRange).toEqual({low:100,high:101}); // Witness prices are not aggregated into IB.
  });

});
