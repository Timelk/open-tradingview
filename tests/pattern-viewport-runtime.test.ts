import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import type { ColumnName, ColumnView, DerivedSeries, ParamValues } from '../src/lib/core/types';
import { IndicatorRegistry, registerBuiltins } from '../src/lib/indicators/registry';
import { IndicatorRuntime, type IndicatorReq } from '../src/lib/indicators/runtime';
import { IndicatorEngine } from '../src/lib/indicators/engine';
import type { OutMsg } from '../src/lib/indicators/worker';

const minute=60_000,epoch=Date.parse('2026-08-15T00:00:00Z');
const at=(index:number)=>epoch+index*minute;
const bar=(i:number,value:number)=>({time:at(i),open:value,high:value+.1,low:value-.1,close:value,volume:10});
const params:ParamValues={pivotStrength:2,lookback:100,tolerance:.04,family:'三角形',multiScale:false};
const request:IndicatorReq={id:'pattern-huzi',instanceId:'huzi:viewport',params};
const ordinary:IndicatorReq={id:'ema',instanceId:'ema:ordinary',params:{period:9}};
const window=(from:number,to:number)=>({fromTime:at(from),toTime:at(to)});
const keys:ColumnName[]=['time','open','high','low','close','volume'];
function registry(){const reg=new IndicatorRegistry();registerBuiltins(reg);return reg;}
function fixture(){
  const anchors=[[0,100],[10,110],[20,90],[30,110],[40,98],[50,110],[55,106],[63,115],[70,115],[90,105],
    [2000,100],[2010,110],[2020,90],[2030,110],[2040,96],[2050,110],[2056,106]];
  const store=new ColumnStore(4096);let leg=0;
  for(let i=0;i<=2056;i++){
    while(leg+1<anchors.length-1&&i>anchors[leg+1][0])leg++;
    const a=anchors[leg],b=anchors[leg+1];store.appendBar(bar(i,a[1]+(b[1]-a[1])*(i-a[0])/(b[0]-a[0])));
  }
  return store;
}
const patterns=(series:DerivedSeries[])=>series.flatMap(item=>item.patterns??[]);
afterEach(()=>vi.unstubAllGlobals());

describe('time-window pattern scanning',()=>{
  it('keeps a fixed loaded evidence pool while viewport interest changes and candidates stay live',()=>{
    const store=fixture(),runtime=new IndicatorRuntime(registry());runtime.set([ordinary,request]);
    const latest=runtime.compute(store,0),candidates=latest.find(s=>s.candidates)?.candidates;
    expect(candidates?.length).toBeGreaterThan(0);
    expect(patterns(latest).some(p=>p.points[0].time===at(10))).toBe(true);
    runtime.set([ordinary,{...request,patternWindow:window(20,70)}]);
    const historical=runtime.compute(store,store.length,true),old=patterns(historical).find(p=>p.points[0].time===at(10));
    expect(old).toBeDefined();
    expect(old!.confirmedAt).toBeLessThanOrEqual(at(71));
    expect(historical[0].patternScan).toMatchObject({scope:'latest',throughTime:at(2055),knowledgeThroughTime:at(2056)});
    expect(historical[0].patterns).toBe(latest.find(s=>s.plot==='patterns')?.patterns);
    expect(historical.find(s=>s.candidates)?.candidates).toBe(candidates);
    expect(historical.find(s=>s.candidates)?.candidates?.[0].observedAt).toBe(at(2056));
  });

  it('uses the explicit closed prefix for replay, never the viewport or hidden backing columns',()=>{
    const store=fixture(),runtime=new IndicatorRuntime(registry());
    const prefix=(n:number):ColumnView=>({length:n,closedLength:n,intervalMs:minute,col:name=>store.col(name)});
    runtime.set([{...request,patternWindow:window(20,70)}]);
    expect(patterns(runtime.compute(prefix(53),0)).some(p=>p.points[0].time===at(10))).toBe(false);
    expect(patterns(runtime.compute(prefix(71),53)).some(p=>p.points[0].time===at(10))).toBe(true);
    runtime.set([{...request,patternWindow:window(20,52)}]);
    expect(patterns(runtime.compute(prefix(71),71,true)).some(p=>p.points[0].time===at(10))).toBe(true);
    const rewind=runtime.compute(prefix(53),0);expect(patterns(rewind).some(p=>p.points[0].time===at(10))).toBe(false);
    expect(rewind[0].patternScan?.knowledgeThroughTime).toBe(at(53));
  });

  it('keeps old confirmed geometry cached across outside quotes and newly closed candles while previews remain live',()=>{
    const store=fixture(),runtime=new IndicatorRuntime(registry());runtime.set([{...request,patternWindow:window(20,70)}]);
    const initial=runtime.compute(store,0),geometry=initial[0].patterns,scan=initial[0].patternScan;
    expect(initial[2].candidates?.length).toBeGreaterThan(0);
    store.updateLast({...bar(2056,107),high:140});
    const tick=runtime.compute(store,2056);
    expect(tick[0].patterns).toBe(geometry);expect(tick[0].patternScan).toBe(scan);expect(tick[2].candidates).toEqual([]);
    store.appendBar(bar(2057,107));
    const closed=runtime.compute(store,2057);
    expect(closed[0].patterns).toEqual(geometry);expect(closed[0].patternScan?.knowledgeThroughTime).toBe(at(2057));
  });

  it('bounds large viewport tile count and per-tile evidence and discloses partial coverage',()=>{
    const store=new ColumnStore(32768);for(let i=0;i<20002;i++)store.appendBar(bar(i,100));
    const runtime=new IndicatorRuntime(registry());runtime.set([{...request,patternWindow:window(0,20001)}]);
    const scan=runtime.compute(store,0)[0].patternScan!;
    expect(scan.scope).toBe('viewport');expect(scan.bars).toBeLessThanOrEqual(8*10000);
    expect(scan.knowledgeThroughTime).toBe(at(20001));expect(scan.tileCount).toBe(8);expect(scan.scanTruncated).toBe(true);
    for(const range of scan.evidenceRanges??[])expect((range.throughTime-range.fromTime)/minute+1).toBeLessThanOrEqual(10000);
  });

  it('interprets a viewport in source timestamps on higher-timeframe patterns',()=>{
    const source=fixture(),base=new ColumnStore(16384);
    for(let i=0;i<source.length;i++){
      source.col('time')[i]=at(i*5);
      for(let offset=0;offset<(i===source.length-1?1:5);offset++)base.appendBar(bar(i*5+offset,source.col('close')[i]));
    }
    const patternWindow=window(20*5,70*5),direct=new IndicatorRuntime(registry()),higher=new IndicatorRuntime(registry());
    direct.set([{...request,patternWindow,baseIntervalMs:5*minute}]);
    const expected=patterns(direct.compute(source,0));
    higher.set([{...request,patternWindow,timeframe:'5m',baseIntervalMs:minute}]);
    const initial=higher.compute(base,0);
    expect(expected.length).toBeGreaterThan(0);expect(patterns(initial)).toEqual(expected);
    expect(initial[0].patternScan?.knowledgeThroughTime).toBe(at(2056*5));
    const scan=initial[0].patternScan,preview=initial[2].candidates;
    higher.set([{...request,patternWindow:window(20*5,52*5),timeframe:'5m',baseIntervalMs:minute}]);
    const before=higher.compute(base,base.length,true);
    expect(patterns(before)).toEqual(expected);expect(before[2].candidates).toBe(preview);
    expect(before[0].patternScan).toBe(scan);
  });

  it('does not reconstruct or recompute ordinary indicators on a pattern-window-only request',()=>{
    const reg=registry(),create=vi.fn(()=>({update:vi.fn(()=>[{name:'probe',values:new Float64Array(4096),color:'#fff',pane:'main' as const,plot:'line' as const}])}));
    reg.register({id:'probe',name:'probe',target:'main',inputs:[],calc:()=>[],createIncremental:create});
    const runtime=new IndicatorRuntime(reg),store=fixture(),probe={id:'probe',params:{}};
    runtime.set([probe,request]);runtime.compute(store,0);
    const update=create.mock.results[0].value.update;expect(update).toHaveBeenCalledTimes(1);
    runtime.set([probe,{...request,patternWindow:window(20,70)}]);
    runtime.compute(store,store.length,true);
    expect(create).toHaveBeenCalledTimes(1);expect(update).toHaveBeenCalledTimes(1);
  });

  it('ships only sparse pattern metadata for a window request and merges it without replacing ordinary series',async()=>{
    vi.resetModules();const messages:OutMsg[]=[],sizes:number[][]=[];
    const port={onmessage:null as ((event:{data:unknown})=>void)|null,postMessage(message:OutMsg,transfer:Transferable[]=[]){sizes.push(transfer.map(b=>(b as ArrayBuffer).byteLength));messages.push(structuredClone(message,{transfer}));}};
    vi.stubGlobal('self',port);await import('../src/lib/indicators/worker');
    class ClientWorker {
      static current:ClientWorker;onmessage:((event:{data:OutMsg})=>void)|null=null;sent:unknown[]=[];
      constructor(){ClientWorker.current=this;}postMessage(message:unknown){this.sent.push(message);}terminate(){}
      deliver(message:OutMsg){this.onmessage?.({data:message});}
    }
    vi.stubGlobal('Worker',ClientWorker);
    const store=fixture(),reqs=[ordinary,request],engine=new IndicatorEngine(registry());engine.init(store,reqs);
    const columns=Object.fromEntries(keys.map(key=>[key,store.col(key).slice()]));
    port.onmessage!({data:{type:'init',...columns,length:store.length,capacity:store.capacity,reqs}});
    ClientWorker.current.deliver(messages.at(-1)!);
    const ema=engine.derived.find(s=>s.indicatorId===ordinary.instanceId)!,values=ema.values;
    engine.setReqs([ordinary,{...request,patternWindow:window(20,70)}]);
    const sent=ClientWorker.current.sent.at(-1) as Record<string,unknown>;
    expect(sent.type).toBe('pattern-window');expect(sent).not.toHaveProperty('columns');
    port.onmessage!({data:sent});const response=messages.at(-1)!;
    expect(response.type).toBe('patterns');expect(sizes.at(-1)).toEqual([]);
    if(response.type!=='patterns')throw Error('Expected metadata-only response');
    expect(response.patches).toHaveLength(3);
    expect(response.patches.every(p=>p.indicatorId===request.instanceId&&!Object.hasOwn(p,'values'))).toBe(true);
    ClientWorker.current.deliver(response);
    expect(engine.pending).toBe(false);
    expect(engine.derived.find(s=>s.indicatorId===ordinary.instanceId)).toBe(ema);expect(ema.values).toBe(values);
    expect(patterns(engine.derived).some(p=>p.points[0].time===at(10))).toBe(true);
    engine.destroy();
  });

  it('coalesces viewport requests without discarding an in-flight ordinary indicator quote',()=>{
    class ClientWorker {
      static current:ClientWorker;onmessage:((event:{data:OutMsg})=>void)|null=null;sent:unknown[]=[];
      constructor(){ClientWorker.current=this;}postMessage(message:unknown){this.sent.push(message);}terminate(){}
      deliver(message:OutMsg){this.onmessage?.({data:message});}
    }
    vi.stubGlobal('Worker',ClientWorker);
    const store=fixture(),reg=registry(),runtime=new IndicatorRuntime(reg),reqs=[ordinary,request];runtime.set(reqs);
    const initial=runtime.compute(store,0),engine=new IndicatorEngine(reg);engine.init(store,reqs);
    ClientWorker.current.deliver({type:'full',tick:0,length:store.length,series:initial});
    store.updateLast(bar(2056,107));engine.pushBar(false);
    engine.setReqs([ordinary,{...request,patternWindow:window(20,52)}]);
    engine.setReqs([ordinary,{...request,patternWindow:window(20,70)}]);
    expect(ClientWorker.current.sent).toHaveLength(2);
    const identity=initial.find(s=>s.indicatorId===ordinary.instanceId)!;
    ClientWorker.current.deliver({type:'tail',tick:1,length:store.length,patches:[{...identity,start:2056,values:Float64Array.of(123)}]});
    expect(engine.derived.find(s=>s.indicatorId===ordinary.instanceId)!.values[2056]).toBe(123);
    const latest=ClientWorker.current.sent.at(-1) as {type:string;tick:number;reqs:IndicatorReq[]};
    expect(latest.type).toBe('pattern-window');expect(latest.tick).toBe(3);
    expect(latest.reqs[1].patternWindow).toEqual(window(20,70));
    expect(engine.pending).toBe(true);engine.destroy();
  });
});
