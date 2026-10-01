import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import type { ColumnName, ColumnView, IndicatorDef } from '../src/lib/core/types';
import { IndicatorEngine } from '../src/lib/indicators/engine';
import { IndicatorRegistry, registerBuiltins } from '../src/lib/indicators/registry';
import { IndicatorRuntime, type IndicatorReq } from '../src/lib/indicators/runtime';
import { TimeframeCache } from '../src/lib/indicators/timeframe';
import type { OutMsg } from '../src/lib/indicators/worker';
const keys: ColumnName[] = ['time','open','high','low','close','volume'];
const bar = (i: number, close = 100 + Math.sin(i / 2) * 8) => ({time:i*60_000,open:close,high:close+1,low:close-1,close,volume:i+1});
const registry = () => { const reg = new IndicatorRegistry(); registerBuiltins(reg); return reg; };
afterEach(() => vi.unstubAllGlobals());

async function harness() {
  vi.resetModules();
  const replies: OutMsg[] = [];
  const port = {onmessage:null as ((event:{data:unknown})=>void)|null,
    postMessage(message:OutMsg,transfer:Transferable[]=[]){replies.push(structuredClone(message,{transfer}));}};
  vi.stubGlobal('self',port);
  await import('../src/lib/indicators/worker');
  class Worker {
    static current:Worker;
    requests:unknown[]=[];
    onmessage:((event:{data:OutMsg})=>void)|null=null;
    onerror:(()=>void)|null=null;
    constructor(){Worker.current=this;}
    postMessage(message:unknown,transfer:Transferable[]=[]){this.requests.push(structuredClone(message,{transfer}));}
    terminate(){}
    complete(){const request=this.requests.shift();expect(request).toBeDefined();port.onmessage!({data:request});this.onmessage?.({data:replies.at(-1)!});}
  }
  vi.stubGlobal('Worker',Worker);
  return {Worker,replies};
}

describe('bounded realtime indicator worker pipeline',()=>{
  it('coalesces a quote burst while retaining all intervening candles and confirmed strategy signals',async()=>{
    const {Worker,replies}=await harness(),store=new ColumnStore(8),reg=registry();
    const reqs:IndicatorReq[]=[{id:'ema',params:{period:3},instanceId:'ema'}, {id:'strategy-ma-cross',params:{fast:2,slow:5,method:'SMA'},instanceId:'cross'}];
    for(let i=0;i<15;i++)store.appendBar(bar(i));
    const engine=new IndicatorEngine(reg);engine.init(store,reqs);const worker=Worker.current;
    for(let i=14;i<60;i++){
      if(i>14){store.appendBar(bar(i));engine.pushBar(true);}
      for(let tick=0;tick<25;tick++){store.updateLast(bar(i,100+Math.sin(i/2)*8+tick/100));engine.pushBar(false,tick===24);}
      expect(worker.requests).toHaveLength(1);
    }
    worker.complete();expect(worker.requests).toHaveLength(1);
    const batch=worker.requests[0] as {type:string;start:number;length:number;closedLength:number;columns:Record<ColumnName,Float64Array>};
    expect(batch).toMatchObject({type:'sync',start:14,length:60,closedLength:60});
    expect([...batch.columns.close]).toEqual([...store.col('close').slice(14,60)]);
    worker.complete();expect(worker.requests).toHaveLength(0);expect(replies).toHaveLength(2);
    const fresh=new IndicatorRuntime(reg);fresh.set(reqs);const expected=fresh.compute(store,0);
    engine.derived.forEach((series,j)=>{for(let i=0;i<store.length;i++){
      if(Number.isNaN(expected[j].values[i]))expect(series.values[i]).toBeNaN();
      else expect(series.values[i]).toBeCloseTo(expected[j].values[i],9);
    }});
    expect(engine.derived[1].values.some(Number.isFinite)).toBe(true);
    expect(engine.derived[2].values.some(Number.isFinite)).toBe(true);engine.destroy();
  });

  it('coalesces parameter changes with market changes without accepting an obsolete configuration',async()=>{
    const {Worker}=await harness(),store=new ColumnStore(),reg=registry();
    for(let i=0;i<8;i++)store.appendBar(bar(i));
    const engine=new IndicatorEngine(reg);engine.init(store,[{id:'ma',params:{period:2},instanceId:'old'}]);const worker=Worker.current;
    engine.setReqs([{id:'ema',params:{period:5},instanceId:'intermediate'}]);
    store.updateLast(bar(7,500));engine.pushBar(false);
    engine.setReqs([{id:'ma',params:{period:1},instanceId:'latest'}]);
    expect(worker.requests).toHaveLength(1);worker.complete();
    expect(engine.pending).toBe(true);expect(engine.derived).toEqual([]);expect(worker.requests).toHaveLength(1);
    worker.complete();expect(engine.pending).toBe(false);expect(engine.derived[0].indicatorId).toBe('latest');expect(engine.derived[0].values[7]).toBeCloseTo(500,10);
    engine.setReqs([{id:'ma',params:{period:1},instanceId:'latest'}]);expect(worker.requests).toHaveLength(0);engine.destroy();
  });

  it('ships the previous higher-timeframe preview in the next patch so no stale value leaks into history',async()=>{
    const {Worker,replies}=await harness(),store=new ColumnStore(),reg=registry();for(let i=0;i<12;i++)store.appendBar(bar(i,i+1));
    const engine=new IndicatorEngine(reg);engine.init(store,[{id:'ma',params:{period:1},timeframe:'5m',baseIntervalMs:60_000}]);const worker=Worker.current;worker.complete();
    expect(engine.derived[0].values[10]).toBe(10);expect(engine.derived[0].values[11]).toBe(12);
    store.updateLast(bar(11,999));engine.pushBar(false);worker.complete();expect(engine.derived[0].values[11]).toBe(999);
    store.appendBar(bar(12,20));engine.pushBar(true);worker.complete();
    const tail=replies.at(-1)!;if(tail.type!=='tail')throw new Error('expected tail');
    expect(tail.patches[0].start).toBe(11);expect([...tail.patches[0].values]).toEqual([10,20]);
    expect(engine.derived[0].values[11]).toBe(10);expect(engine.derived[0].values[12]).toBe(20);engine.destroy();
  });
});

describe('runtime reuse and aggregation cost',()=>{
  it('retains existing calculators when adding or reordering other studies',()=>{
    const reg=new IndicatorRegistry(),calls:{period:number;from:number}[]=[],created:number[]=[];
    const definition:IndicatorDef={id:'spy',name:'spy',target:'main',inputs:[],calc:()=>[],createIncremental(params){
      const period=Number(params.period);created.push(period);const values=new Float64Array(64);
      return {update(cols,from){calls.push({period,from});return [{name:'spy',pane:'main',plot:'line',color:'#fff',values}];}};
    }};
    reg.register(definition);const runtime=new IndicatorRuntime(reg),store=new ColumnStore();for(let i=0;i<20;i++)store.appendBar(bar(i));
    const first={id:'spy',instanceId:'first',params:{period:2}},second={id:'spy',instanceId:'second',params:{period:3}};
    runtime.set([first]);const original=runtime.compute(store,0)[0].values;
    runtime.set([second,first]);const next=runtime.compute(store,19);
    expect(created).toEqual([2,3]);expect(calls.slice(-2)).toEqual([{period:3,from:0},{period:2,from:19}]);expect(next[1].values).toBe(original);
    runtime.set([first]);runtime.compute(store,19);expect(created).toEqual([2,3]);
  });

  it('replaces a day-bucket live candle without rereading every historical minute',()=>{
    const store=new ColumnStore();for(let i=0;i<1400;i++)store.appendBar(bar(i,i));
    let reads=0;
    const cols:ColumnView={length:store.length,col(name){return new Proxy(store.col(name),{get(target,key){if(typeof key==='string' && /^\d+$/.test(key))reads++;return Reflect.get(target,key,target);}});}};
    const cache=new TimeframeCache(86_400_000);cache.update(cols,0);reads=0;
    store.updateLast({...bar(1399,4),high:4,low:-10,volume:3});cache.update(cols,1399);
    expect(reads).toBeLessThan(20);expect(cache.store.col('high')[0]).toBe(1399);expect(cache.store.col('low')[0]).toBe(-10);
    expect(cache.store.col('volume')[0]).toBe(1399*1400/2+3);
    store.appendBar(bar(1400,8));cols.length=store.length;cache.update(cols,1400);
    const fresh=new TimeframeCache(86_400_000);fresh.update(store,0);
    for(const key of keys)expect([...cache.store.col(key).slice(0,cache.store.length)]).toEqual([...fresh.store.col(key).slice(0,fresh.store.length)]);
  });

  it('marks the last higher-timeframe bucket closed only when its last base candle is confirmed',()=>{
    const reg=new IndicatorRegistry(),seen:number[]=[];
    reg.register({id:'closed',name:'closed',target:'main',inputs:[],calc({cols}){seen.push(cols.closedLength!);return [];}});
    const runtime=new IndicatorRuntime(reg),store=new ColumnStore();for(let i=0;i<10;i++)store.appendBar(bar(i));
    runtime.set([{id:'closed',params:{},timeframe:'5m',baseIntervalMs:60_000}]);
    runtime.compute({length:10,closedLength:9,col:name=>store.col(name)},0);
    runtime.compute({length:10,closedLength:10,col:name=>store.col(name)},9);
    store.appendBar(bar(10));runtime.compute({length:11,closedLength:11,col:name=>store.col(name)},10);
    expect(seen).toEqual([1,2,2]);
  });
});
