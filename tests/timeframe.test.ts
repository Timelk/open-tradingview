import { describe,it,expect } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import { IndicatorRegistry,registerBuiltins } from '../src/lib/indicators/registry';
import { IndicatorRuntime } from '../src/lib/indicators/runtime';
import { TimeframeCache } from '../src/lib/indicators/timeframe';
const bar=(i:number,value=i+1)=>({time:i*60000,open:value,high:value+1,low:value-1,close:value,volume:10});
function setup(){const reg=new IndicatorRegistry();registerBuiltins(reg);return new IndicatorRuntime(reg);}

describe('causal realtime multi-timeframe indicators',()=>{
  it('aggregates OHLCV into UTC buckets and removes replaced tick extremes',()=>{
    const base=new ColumnStore();for(let i=0;i<7;i++)base.appendBar(bar(i));
    const cache=new TimeframeCache(300000);cache.update(base,0);
    expect(cache.store.length).toBe(2);expect(cache.store.col('close')[0]).toBe(5);expect(cache.store.col('volume')[0]).toBe(50);
    base.updateLast(bar(6,100));cache.update(base,6);expect(cache.store.col('high')[1]).toBe(101);
    base.updateLast(bar(6,7));cache.update(base,6);expect(cache.store.col('high')[1]).toBe(8);expect(cache.store.col('volume')[1]).toBe(20);
  });
  it('does not project future high-timeframe closes into earlier bars',()=>{
    const base=new ColumnStore();for(let i=0;i<12;i++)base.appendBar(bar(i));
    const runtime=setup();runtime.set([{id:'ma',instanceId:'five',params:{period:1},timeframe:'5m',baseIntervalMs:60000}]);
    const values=runtime.compute(base,0)[0].values;
    expect([...values.slice(0,5)].every(Number.isNaN)).toBe(true);
    expect([...values.slice(5,10)]).toEqual([5,5,5,5,5]);expect(values[10]).toBe(10);
    base.updateLast(bar(11,999));const live=runtime.compute(base,11)[0].values;expect(live[11]).toBe(999);expect(live[10]).toBe(10);
    base.appendBar(bar(12,20));const advanced=runtime.compute(base,12)[0].values;expect(advanced[11]).toBe(10);expect(advanced[12]).toBe(20);expect(runtime.dirtyFrom).toBe(11);
  });
  it('does not treat an initial partial higher-timeframe bucket as complete history',()=>{
    const base=new ColumnStore();for(let i=2;i<12;i++)base.appendBar(bar(i));
    const runtime=setup();runtime.set([{id:'ma',params:{period:1},timeframe:'5m',baseIntervalMs:60000}]);
    const values=runtime.compute(base,0)[0].values;
    expect([...values.slice(0,8)].every(Number.isNaN)).toBe(true);expect(values[8]).toBe(10);
  });
  it('updates explicitly fixed studies immediately when their timeframe equals the chart',()=>{
    const base=new ColumnStore();for(let i=0;i<5;i++)base.appendBar(bar(i));const runtime=setup();
    runtime.set([{id:'ma',instanceId:'live',params:{period:1},timeframe:'chart'},{id:'ma',instanceId:'fixed',params:{period:1},timeframe:'1m',baseIntervalMs:60000}]);
    const values=runtime.compute(base,0);expect(values[0].values[4]).toBe(5);expect(values[1].values[4]).toBe(5);
    base.updateLast(bar(4,100));const updated=runtime.compute(base,4);expect(updated[0].values[4]).toBe(100);expect(updated[1].values[4]).toBe(100);
  });
  it('isolates duplicate instances and incrementally matches a fresh computation',()=>{
    const base=new ColumnStore(),runtime=setup();
    const reqs=[{id:'ma',instanceId:'ma-a',params:{period:2},timeframe:'chart'}, {id:'ma',instanceId:'ma-b',params:{period:2},timeframe:'5m',baseIntervalMs:60000}];runtime.set(reqs);
    for(let i=0;i<31;i++){
      base.appendBar(bar(i));runtime.compute(base,i);base.updateLast(bar(i,i+4));
      const out=runtime.compute(base,i),fresh=setup();fresh.set(reqs);const expected=fresh.compute(base,0);
      expect(out.map(s=>s.indicatorId)).toEqual(['ma-a','ma-b']);
      out.forEach((s,j)=>{for(let k=0;k<=i;k++){const a=s.values[k],b=expected[j].values[k];if(Number.isNaN(b))expect(a).toBeNaN();else expect(a).toBeCloseTo(b,8);}});
    }
  });
});
