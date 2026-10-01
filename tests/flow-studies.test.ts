import {describe,expect,it} from 'vitest';
import {sessionRange,sessionDate,tpoStatistics,footprintImbalances,initialBalance} from '../src/lib/flow/studies';
import type {FlowPriceLevel} from '../src/lib/flow/types';
import type {HistoricalFlowAggregate} from '../src/lib/flow/persistence-client';
const level=(tick:number,buy:number,sell:number):FlowPriceLevel=>({tick,price:tick,priceEnd:tick+1,buyBase:buy,sellBase:sell,volumeBase:buy+sell,deltaBase:buy-sell,buyQuote:buy*tick,sellQuote:sell*tick,volumeQuote:(buy+sell)*tick,deltaQuote:(buy-sell)*tick,aggregateCount:2});

describe('explicit market sessions',()=>{
  it('maps exchange-independent session dates through IANA zones, including half-hour offsets and DST day lengths',()=>{
    const india=sessionRange('2026-09-23','Asia/Kolkata');
    expect(new Date(india.from).toISOString()).toBe('2026-09-22T18:30:00.000Z');
    expect(sessionDate(india.from,'Asia/Kolkata')).toBe('2026-09-23');
    const spring=sessionRange('2026-03-08','America/New_York'),fall=sessionRange('2026-11-01','America/New_York');
    expect(spring.to-spring.from+1).toBe(23*3600000);expect(fall.to-fall.from+1).toBe(25*3600000);
  });
  it('rejects nonexistent calendar dates and ambiguous or nonexistent DST opening times',()=>{
    expect(()=>sessionRange('2026-02-30','UTC')).toThrow();
    expect(()=>sessionRange('2026-03-08','America/New_York',150)).toThrow('不存在');
    expect(()=>sessionRange('2026-11-01','America/New_York',90)).toThrow('重复');
  });
});

describe('true traded TPO visits and footprint imbalances',()=>{
  it('derives POC/value area from visits and excludes single-print tails and untraded holes',()=>{
    const rows=[1,4,1,1,8,4,1].map((blocks,i)=>({tick:i,price:i,priceEnd:i+1,blocks}));
    const stats=tpoStatistics(rows,70);
    expect(stats).toMatchObject({totalVisits:20,poc:4,valueLow:3,valueHigh:7,singlePrints:[{price:2,priceEnd:4}]});
    const withHole=tpoStatistics([{tick:1,price:1,priceEnd:2,blocks:4},{tick:3,price:3,priceEnd:4,blocks:1},{tick:5,price:5,priceEnd:6,blocks:4}]);
    expect(withHole.singlePrints).toEqual([{price:3,priceEnd:4}]);
    expect(tpoStatistics([])).toMatchObject({totalVisits:0,singlePrints:[]});
  });
  it('compares diagonal aggressor quantities at adjacent real rows, instead of candle direction or missing-as-zero',()=>{
    const levels=[level(100,2,5),level(101,20,3),level(103,50,0)];
    const matches=footprintImbalances(levels,1,{mode:'diagonal',ratio:3,minVolume:10,unit:'base',allowZero:true});
    expect(matches).toEqual([{tick:101,buyRatio:4,sellRatio:undefined}]);
    expect(footprintImbalances(levels,1,{mode:'same',ratio:3,minVolume:10,unit:'base'})).toEqual([{tick:101,buyRatio:20/3,sellRatio:undefined}]);
    expect(footprintImbalances([level(103,50,0)],1,{mode:'same',ratio:3,minVolume:10,unit:'base',allowZero:true})[0].buyRatio).toBe(Infinity);
    expect(footprintImbalances(levels,1,{mode:'same',ratio:3,minVolume:25,unit:'base'})).toEqual([]);
  });
  it('uses quote minimums in quote mode and rejects invalid ratio settings',()=>{
    expect(footprintImbalances([level(100,2,0.5)],1,{mode:'same',ratio:3,minVolume:100,unit:'quote'})).toHaveLength(1);
    expect(footprintImbalances([level(100,2,0.5)],1,{mode:'same',ratio:NaN,minVolume:0,unit:'base'})).toEqual([]);
  });
});

describe('initial balance from its independent prefix aggregate',()=>{
  const from=Date.parse('2020-01-01T00:00:00Z'),duration=3600000;
  const result=(to=from+duration-1,gaps=0)=>({fromTime:from,toTime:to,priceRange:{low:99.2,high:107.4},snapshot:{totals:{aggregateCount:10},coverage:{gapCount:gaps},footprint:[]},coverage:{dataset:{kind:'archive',state:'complete',archiveDate:'2020-01-01',period:'daily'}}} as unknown as HistoricalFlowAggregate);
  it('keeps exact trade extremes even if ordinary footprint pagination has no early bars',()=>{
    expect(initialBalance(result(),from,duration,from+86400000-1)).toMatchObject({status:'complete',low:99.2,high:107.4});
    expect(initialBalance(result(from+1000),from,duration,from+1000).status).toBe('forming');
  });
  it('never labels an unfinished, missing-coverage or gapped IB complete',()=>{
    expect(initialBalance(result(undefined,1),from,duration,from+86400000).status).toBe('partial');
    const missing=result();missing.coverage.dataset={...missing.coverage.dataset,kind:'recording',fromTime:from+1000,recordedThrough:from+duration};
    expect(initialBalance(missing,from,duration,from+duration).status).toBe('partial');
    expect(initialBalance(undefined,from,duration,from).status).toBe('loading');
  });
  it('does not confuse depth/receipt coverage or a later trade witness with known complete trade coverage',()=>{
    const mixed=result();mixed.coverage.dataset={...mixed.coverage.dataset,kind:'recording',state:'recording',fromTime:from,recordedThrough:from+120*60000};
    mixed.snapshot.coverage.fromTime=from+20*60000;mixed.snapshot.coverage.throughTime=from+25*60000;
    expect(initialBalance(mixed,from,duration,from+120*60000).status).toBe('partial');
    mixed.tradeCoverage={fromTime:from,toTime:from+duration-1,complete:true,basis:'continuous-trade-ids',availableAt:from+65*60000,firstTradeTime:from-1000,lastTradeTime:from+65*60000,reason:'proof'};
    expect(initialBalance(mixed,from,duration,from+duration-1).status).toBe('partial');
    expect(initialBalance(mixed,from,duration,from+65*60000)).toMatchObject({status:'complete',low:99.2,high:107.4});
    mixed.coverage.dataset.recordingPauses=[{fromTime:from+30*60000,toTime:from+60*60000,notedAt:from+30*60000,reason:'L2 pause'}];
    expect(initialBalance(mixed,from,duration,from+65*60000).status).toBe('complete');
    mixed.tradeCoverage.complete=false;expect(initialBalance(mixed,from,duration,from+120*60000).status).toBe('partial');
  });

});
