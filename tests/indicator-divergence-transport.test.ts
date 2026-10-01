import {afterEach,describe,expect,it,vi} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import type {ColumnName,ColumnView,DerivedSeries} from '../src/lib/core/types';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {IndicatorRuntime,type IndicatorReq} from '../src/lib/indicators/runtime';
import {IndicatorEngine} from '../src/lib/indicators/engine';
import type {OutMsg} from '../src/lib/indicators/worker';

const minute=60_000,keys:ColumnName[]=['time','open','high','low','close','volume'];
const req:IndicatorReq={id:'rsi',instanceId:'rsi:independent',params:{period:7,divergenceStrength:2},timeframe:'chart',baseIntervalMs:minute};
const registry=()=>{const reg=new IndicatorRegistry();registerBuiltins(reg);return reg;};
const bar=(time:number,price:number)=>({time,open:price,high:price+.1,low:price-.1,close:price,volume:100});
function fixture(step=minute):ColumnStore {
  const anchors=[[0,100],[10,130],[20,90],[30,110],[40,85],[50,100],[60,82],[70,105],[80,105]];
  const store=new ColumnStore(256);let part=0;
  for(let i=0;i<=80;i++){
    while(part+1<anchors.length-1&&i>anchors[part+1][0])part++;
    const a=anchors[part],b=anchors[part+1],value=a[1]+(b[1]-a[1])*(i-a[0])/(b[0]-a[0]);
    store.appendBar(bar(i*step,value));
  }
  return store;
}
afterEach(()=>vi.unstubAllGlobals());

async function workerHarness(){
  vi.resetModules();
  const replies:OutMsg[]=[];
  const port={onmessage:null as ((event:{data:unknown})=>void)|null,postMessage(message:OutMsg,transfer:Transferable[]=[]){replies.push(structuredClone(message,{transfer}));}};
  vi.stubGlobal('self',port);await import('../src/lib/indicators/worker');
  class Worker {
    static current:Worker;requests:unknown[]=[];onmessage:((event:{data:OutMsg})=>void)|null=null;onerror:(()=>void)|null=null;
    constructor(){Worker.current=this;}
    postMessage(message:unknown,transfer:Transferable[]=[]){this.requests.push(structuredClone(message,{transfer}));}
    terminate(){}
    complete(){const request=this.requests.shift();expect(request).toBeDefined();port.onmessage!({data:request});this.onmessage?.({data:replies.at(-1)!});}
    deliver(data:OutMsg){this.onmessage?.({data});}
  }
  vi.stubGlobal('Worker',Worker);return {Worker,port,replies};
}

describe('independent oscillator divergence runtime and transport',()=>{
  it('calculates a standalone custom-period RSI without any pattern layer and leaves secondary plots alone',()=>{
    const runtime=new IndicatorRuntime(registry()),store=fixture();
    runtime.set([req,{id:'macd',instanceId:'custom-macd',params:{fast:5,slow:12,signal:4}},{id:'kdj',instanceId:'custom-kdj',params:{n:5,m1:3,m2:3}}]);
    const out=runtime.compute(store,0);
    expect(out.find(series=>series.indicatorId===req.instanceId)?.divergences?.length).toBeGreaterThan(0);
    expect(out.filter(series=>series.plotIndex===0).every(series=>Array.isArray(series.divergences))).toBe(true);
    expect(out.filter(series=>(series.plotIndex??0)>0).every(series=>series.divergences===undefined)).toBe(true);
    expect(out.some(series=>series.patterns!==undefined)).toBe(false);
  });

  it('preserves sparse metadata in worker full results and omits it on forming ticks',async()=>{
    const {Worker,replies}=await workerHarness(),store=fixture(),engine=new IndicatorEngine(registry());
    engine.init(store,[req]);const worker=Worker.current;worker.complete();
    const initial=engine.derived[0].divergences;expect(initial?.length).toBeGreaterThan(0);
    expect(replies[0].type).toBe('full');
    store.updateLast(bar(80*minute,500));engine.pushBar(false);worker.complete();
    const tail=replies.at(-1)!;if(tail.type!=='tail')throw new Error('expected tail');
    expect(Object.hasOwn(tail.patches[0],'divergences')).toBe(false);
    expect(engine.derived[0].divergences).toBe(initial);
    // The oscillator itself remains live even while closed-pivot evidence is cached.
    expect(engine.derived[0].values[80]).toBeGreaterThan(engine.derived[0].values[79]);
    engine.destroy();
  });

  it('replaces metadata after historical closed-price correction and matches a fresh runtime',async()=>{
    const {port,replies}=await workerHarness(),store=fixture();
    port.onmessage!({data:{type:'init',...Object.fromEntries(keys.map(name=>[name,store.col(name).slice()])),length:store.length,capacity:store.capacity,reqs:[req]}});
    const full=replies.at(-1)!;if(full.type!=='full')throw new Error('expected full');
    const initial=full.series[0].divergences;expect(initial?.length).toBeGreaterThan(0);
    for(const name of ['open','high','low','close'] as const)store.col(name)[40]=name==='high'?105.1:name==='low'?104.9:105;
    const from=40;
    port.onmessage!({data:{type:'sync',columns:Object.fromEntries(keys.map(name=>[name,store.col(name).slice(from,store.length)])),start:from,length:store.length,capacity:store.capacity,tick:1}});
    const tail=replies.at(-1)!;if(tail.type!=='tail')throw new Error('expected tail');
    expect(Object.hasOwn(tail.patches[0],'divergences')).toBe(true);
    const fresh=new IndicatorRuntime(registry());fresh.set([req]);
    expect(tail.patches[0].divergences).toEqual(fresh.compute(store,0)[0].divergences);
    expect(tail.patches[0].divergences).not.toEqual(initial);
  });

  it('transmits a newly confirmed divergence only after its final right-side candle closes',async()=>{
    const {Worker,replies}=await workerHarness(),store=fixture(),nextPrice=store.col('close')[63];
    store.length=63;
    const engine=new IndicatorEngine(registry());engine.init(store,[req]);const worker=Worker.current;worker.complete();
    expect(engine.derived[0].divergences?.some(item=>item.points[1].time===60*minute)).toBe(false);
    store.appendBar(bar(63*minute,nextPrice));engine.pushBar(true);worker.complete();
    const tail=replies.at(-1)!;if(tail.type!=='tail')throw new Error('expected tail');
    expect(Object.hasOwn(tail.patches[0],'divergences')).toBe(true);
    expect(engine.derived[0].divergences?.find(item=>item.points[1].time===60*minute)?.confirmedAt).toBe(63*minute);
    engine.destroy();
  });

  it('distinguishes omitted metadata, an empty replacement, and explicit undefined in engine tails',async()=>{
    const {Worker}=await workerHarness(),store=fixture(),engine=new IndicatorEngine(registry());
    engine.init(store,[req]);const worker=Worker.current;worker.complete();
    const series=engine.derived[0],initial=series.divergences;
    const identity={name:series.name,indicatorId:series.indicatorId,plotIndex:0,plot:series.plot,pane:series.pane,color:series.color,start:80,values:Float64Array.of(series.values[80])};
    worker.deliver({type:'tail',tick:1,length:81,patches:[identity]});expect(series.divergences).toBe(initial);
    worker.deliver({type:'tail',tick:2,length:81,patches:[{...identity,divergences:[]}]});expect(series.divergences).toEqual([]);
    worker.deliver({type:'tail',tick:3,length:81,patches:[{...identity,divergences:undefined}]});expect(series.divergences).toBeUndefined();
    engine.destroy();
  });

  it('retains oscillator evidence through pattern-only window updates without retransmitting ordinary arrays',async()=>{
    const {Worker,replies}=await workerHarness(),store=fixture(),engine=new IndicatorEngine(registry());
    const pattern:IndicatorReq={id:'pattern-huzi',instanceId:'unrelated-pattern',params:{},patternWindow:{fromTime:0,toTime:40*minute}};
    engine.init(store,[req,pattern]);const worker=Worker.current;worker.complete();
    const primary=engine.derived.find(series=>series.indicatorId===req.instanceId)!,initial=primary.divergences;
    engine.setReqs([req,{...pattern,patternWindow:{fromTime:40*minute,toTime:80*minute}}]);worker.complete();
    const response=replies.at(-1)!;expect(response.type).toBe('patterns');
    if(response.type!=='patterns')throw new Error('expected pattern metadata reply');
    expect(response.patches.some(patch=>patch.indicatorId===req.instanceId)).toBe(false);
    expect(primary.divergences).toBe(initial);
    store.updateLast(bar(80*minute,104));engine.pushBar(false);worker.complete();
    const tick=replies.at(-1)!;if(tick.type!=='tail')throw new Error('expected tail');
    expect(Object.hasOwn(tick.patches.find(patch=>patch.indicatorId===req.instanceId)!,'divergences')).toBe(false);
    expect(primary.divergences).toBe(initial);engine.destroy();
  });

  it('matches main-thread fallback and clears disabled oscillator annotations',async()=>{
    const {Worker}=await workerHarness(),store=fixture(),workerEngine=new IndicatorEngine(registry());
    workerEngine.init(store,[req]);Worker.current.complete();const expected=workerEngine.derived[0].divergences;
    vi.stubGlobal('Worker',class{constructor(){throw new Error('worker unavailable');}});
    const mainEngine=new IndicatorEngine(registry());mainEngine.init(store,[req]);
    expect(mainEngine.mode).toBe('main');expect(mainEngine.derived[0].divergences).toEqual(expected);
    mainEngine.setReqs([{...req,params:{...req.params,showDivergences:false}}]);expect(mainEngine.derived[0].divergences).toBeUndefined();
    workerEngine.destroy();mainEngine.destroy();
  });

  it('keeps higher-timeframe divergence source anchors identical to direct source-timeframe calculation',()=>{
    const source=fixture(5*minute),base=new ColumnStore(512);
    for(let i=0;i<source.length;i++)for(let offset=0;offset<(i===source.length-1?1:5);offset++)
      base.appendBar(bar(i*5*minute+offset*minute,source.col('close')[i]));
    const direct=new IndicatorRuntime(registry());direct.set([{...req,baseIntervalMs:5*minute}]);
    const expected=direct.compute(source,0)[0].divergences;expect(expected?.length).toBeGreaterThan(0);
    const higher=new IndicatorRuntime(registry());higher.set([{...req,timeframe:'5m'}]);
    const out=higher.compute(base,0);expect(out[0].divergences).toEqual(expected);
    const original=out[0].divergences;
    for(let offset=1;offset<5;offset++){
      base.appendBar(bar(400*minute+offset*minute,105+offset));
      expect(higher.compute(base,base.length-1)[0].divergences).toBe(original);
    }
    const sourceClosed:ColumnView={length:source.length,closedLength:source.length,intervalMs:5*minute,col:name=>source.col(name)};
    source.updateLast(bar(400*minute,109));
    const closedDirect=new IndicatorRuntime(registry());closedDirect.set([{...req,baseIntervalMs:5*minute}]);
    const closedBase:ColumnView={length:base.length,closedLength:base.length,intervalMs:minute,col:name=>base.col(name)};
    expect(higher.compute(closedBase,base.length-1)[0].divergences).toEqual(closedDirect.compute(sourceClosed,0)[0].divergences);
  });

  it('reuses closed evidence on large-history ticks and processes a new close without rescanning history',()=>{
    const size=100_000,capacity=size+2,arrays={} as Record<ColumnName,Float64Array>,values=new Float64Array(capacity).fill(50);
    for(const name of keys)arrays[name]=Float64Array.from({length:capacity},(_,i)=>name==='time'?i*minute:100+i*.001);
    let reads=0;
    const proxies=Object.fromEntries(keys.map(name=>[name,new Proxy(arrays[name],{get(array,key){if(typeof key==='string'&&/^\d+$/.test(key))reads++;return Reflect.get(array,key,array);}})])) as Record<ColumnName,Float64Array>;
    const cols:ColumnView={length:size,closedLength:size-1,intervalMs:minute,col:name=>proxies[name]},reg=new IndicatorRegistry();
    reg.register({id:'rsi',name:'RSI',target:'sub',inputs:[],calc:()=>[{name:'RSI(14)',values,pane:'sub',plot:'line',color:'#abc'}]});
    const runtime=new IndicatorRuntime(reg);runtime.set([{id:'rsi',instanceId:'large',params:{period:14}}]);
    const original=runtime.compute(cols,0)[0].divergences;reads=0;
    for(let i=0;i<40;i++)expect(runtime.compute(cols,size-1)[0].divergences).toBe(original);
    expect(reads).toBeLessThan(3000);
    reads=0;cols.length++;cols.closedLength!++;
    runtime.compute(cols,size);
    expect(reads).toBeLessThan(3000);
  });
});
