import {afterEach,describe,expect,it,vi} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import {FLOW_COLUMNS,type BarInput,type ColumnName,type ColumnView,type DerivedSeries} from '../src/lib/core/types';
import {klineFlow} from '../src/lib/feed/binance-feed';
import {FlowCalculator} from '../src/lib/analysis/flow';
import {TimeframeCache} from '../src/lib/indicators/timeframe';
import {IndicatorRuntime} from '../src/lib/indicators/runtime';
import {IndicatorEngine} from '../src/lib/indicators/engine';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import type {OutMsg} from '../src/lib/indicators/worker';

const minute=60_000,day=86_400_000,epoch=Date.UTC(2026,8,23);
const keys:ColumnName[]=['time','open','high','low','close','volume'];
const bar=(i:number,extra:Partial<BarInput>={}):BarInput=>({time:epoch+i*minute,open:100,high:102,low:99,close:101,volume:10,...extra});
const flowBar=(i:number,buy=7):BarInput=>bar(i,{quoteVolume:1000,tradeCount:20,takerBuyBase:buy,takerBuyQuote:buy*100});
function store(bars:BarInput[],capacity=2){const s=new ColumnStore(capacity);bars.forEach(b=>s.appendBar(b));return s;}
function registry(){const r=new IndicatorRegistry();registerBuiltins(r);return r;}
function values(series:DerivedSeries[],n:number){return series.map(s=>[...s.values.slice(0,n)]);}
function columns(s:ColumnStore,start=0,end=s.length){return {...Object.fromEntries(keys.map(k=>[k,s.col(k).slice(start,end)])),
  flow:Object.fromEntries(FLOW_COLUMNS.filter(k=>s.flow(k)).map(k=>[k,s.flow(k)!.slice(start,end)]))};}
afterEach(()=>vi.unstubAllGlobals());

describe('exchange flow fields preserve meaning and optionality',()=>{
  it('maps base quantity and quote turnover independently without inferring from candle direction',()=>{
    expect(klineFlow(10,'1234.5',12,'7','900')).toEqual({quoteVolume:1234.5,tradeCount:12,takerBuyBase:7,takerBuyQuote:900});
    const s=store([bar(0,{...klineFlow(10,'1234.5',12,'7','900'),open:110,high:111,low:99,close:100})]);
    expect(new FlowCalculator('delta',{unit:'base'}).update(s,0)[0].values[0]).toBe(4);
    expect(new FlowCalculator('delta',{unit:'quote'}).update(s,0)[0].values[0]).toBe(565.5);
  });
  it('retains a real zero while missing, impossible, or malformed flow is unavailable',()=>{
    expect(klineFlow(0,'0',0,'0','0')).toEqual({quoteVolume:0,tradeCount:0,takerBuyBase:0,takerBuyQuote:0});
    expect(klineFlow(10,undefined,null,undefined,'')).toEqual({});
    expect(klineFlow(10,'100',1.2,'11','101')).toEqual({quoteVolume:100});
    expect(klineFlow(10,'NaN',Infinity,'-1',-10)).toEqual({});
  });
  it('rejects booleans and blank strings instead of coercing unknown data to numeric zero',()=>{
    expect(klineFlow(10,' ',false,false,[])).toEqual({});
  });
  it('does not allocate absent extension columns or backfill old candles with invented zero',()=>{
    const s=store([bar(0),bar(1)]);
    expect(FLOW_COLUMNS.every(k=>s.flow(k)===undefined)).toBe(true);
    s.appendBar(flowBar(2));
    expect([...s.flow('takerBuyBase')!.slice(0,3)]).toEqual([NaN,NaN,7]);
    expect([...s.flow('quoteVolume')!.slice(0,3)]).toEqual([NaN,NaN,1000]);
    expect(s.flow('takerBuyBase')!.slice(3).every(Number.isNaN)).toBe(true);
  });
  it('grows optional arrays with data intact and clears an omitted field on candle replacement',()=>{
    const s=store([flowBar(0)],1);s.appendBar(flowBar(1,3));
    expect([...s.flow('takerBuyBase')!.slice(0,2)]).toEqual([7,3]);
    s.updateLast(bar(1));expect(s.flow('takerBuyBase')![1]).toBeNaN();
    s.length=0;s.appendBar(bar(50));
    expect(s.flow('takerBuyBase')![0]).toBeNaN();
  });
});

describe('Delta and CVD causal cumulative semantics',()=>{
  it('splits signed delta into the correct histogram and preserves exact zero',()=>{
    const s=store([flowBar(0,7),flowBar(1,3),flowBar(2,5),bar(3,{volume:0,takerBuyBase:0})]);
    expect(values(new FlowCalculator('delta',{unit:'base'}).update(s,0),4)).toEqual([[4,NaN,0,0],[NaN,-4,NaN,NaN]]);
  });
  it('never uses base quantities when quote-volume data is unavailable',()=>{
    const s=store([bar(0,{takerBuyBase:7})]);
    const quote=new FlowCalculator('delta',{unit:'quote'}).update(s,0);
    expect(quote.every(line=>Number.isNaN(line.values[0]))).toBe(true);
    expect(quote[0].dataWarning).toContain('1 根');
  });
  it('replaces a live cumulative candle contribution, including corrections, without counting it twice',()=>{
    const s=store([flowBar(0,7),flowBar(1,6)]),calc=new FlowCalculator('cvd',{reset:'loaded'});
    expect(values(calc.update(s,0),2)).toEqual([[4,6]]);
    s.updateLast(flowBar(1,9));expect(values(calc.update(s,1),2)).toEqual([[4,12]]);
    expect(values(calc.update(s,1),2)).toEqual([[4,12]]);
    s.updateLast(flowBar(1,5));expect(values(calc.update(s,1),2)).toEqual([[4,4]]);
    s.appendBar(flowBar(2,2));expect(values(calc.update(s,2),3)).toEqual([[4,4,-2]]);
  });
  it('keeps CVD unknown after a missing flow candle until that candle is explicitly repaired',()=>{
    const s=store([flowBar(0),bar(1),flowBar(2)]),calc=new FlowCalculator('cvd',{reset:'loaded'});
    const first=calc.update(s,0);
    expect(values(first,3)).toEqual([[4,NaN,NaN]]);expect(first[0].dataWarning).toContain('1 根');
    s.flow('takerBuyBase')![1]=5;
    const repaired=calc.update(s,1);expect(values(repaired,3)).toEqual([[4,4,8]]);
    expect(repaired[0].dataWarning).toBeUndefined();
  });
  it('does not bridge a timestamp gap even when both observed candles carry valid flow',()=>{
    const s=store([flowBar(0),flowBar(1),flowBar(3),flowBar(4)]);
    const out=new FlowCalculator('cvd',{reset:'loaded'}).update(s,0);
    expect(values(out,4)).toEqual([[4,8,NaN,NaN]]);expect(out[0].dataWarning).toContain('覆盖不完整');
  });
  it('waits for a complete UTC-day anchor if history starts partway through a day',()=>{
    const s=store([flowBar(1438),flowBar(1439),flowBar(1440,3),flowBar(1441,8)]);
    const result=new FlowCalculator('cvd',{reset:'utc-day'}).update(s,0);
    expect(values(result,4)).toEqual([[NaN,NaN,-4,2]]);
  });
  it('starts at a known UTC midnight, resets the following day, and never invents a missing midnight',()=>{
    const input=[flowBar(0),flowBar(1),flowBar(1440,3),flowBar(1441,8),flowBar(2881)];
    const output=new FlowCalculator('cvd',{}).update(store(input),0);
    expect(values(output,5)).toEqual([[4,8,-4,2,NaN]]);
  });
  it('rebuilds cleanly on prepend or shorter reset and matches a fresh full calculation',()=>{
    const calc=new FlowCalculator('cvd',{reset:'loaded'}),late=store([flowBar(10),flowBar(11,3)]);
    calc.update(late,0);
    const prepended=store([flowBar(8,9),flowBar(9,5),flowBar(10),flowBar(11,3)]);
    expect(values(calc.update(prepended,0),4)).toEqual(values(new FlowCalculator('cvd',{reset:'loaded'}).update(prepended,0),4));
    const replacement=store([bar(0)]),out=calc.update(replacement,0);
    expect(out[0].values[0]).toBeNaN();expect(out[0].dataWarning).toContain('1 根');
  });
});

describe('higher-timeframe flow aggregation',()=>{
  it('sums both base and quote flow and replaces one tail snapshot rather than adding it again',()=>{
    const s=store(Array.from({length:7},(_,i)=>flowBar(i))),cache=new TimeframeCache(5*minute);
    cache.update(s,0);
    expect([...cache.store.flow('takerBuyBase')!.slice(0,2)]).toEqual([35,14]);
    expect([...cache.store.flow('quoteVolume')!.slice(0,2)]).toEqual([5000,2000]);
    s.updateLast(flowBar(6,9));cache.update(s,6);cache.update(s,6);
    expect(cache.store.flow('takerBuyBase')![1]).toBe(16);
    expect(cache.store.flow('takerBuyQuote')![1]).toBe(1600);
    s.appendBar(flowBar(7,1));cache.update(s,7);expect(cache.store.flow('takerBuyBase')![1]).toBe(17);
  });
  it('makes a bucket unknown when any constituent flow is unknown, retaining other valid units',()=>{
    const s=store([flowBar(0),bar(1,{quoteVolume:1000,takerBuyQuote:700}),flowBar(2),flowBar(3),flowBar(4)]);
    const cache=new TimeframeCache(5*minute);cache.update(s,0);
    expect(cache.store.flow('takerBuyBase')![0]).toBeNaN();
    expect(cache.store.flow('takerBuyQuote')![0]).toBe(3500);
    expect(cache.store.flow('quoteVolume')![0]).toBe(5000);
  });
  it('does not mistake a timestamp gap within a bucket for a complete aggregate',()=>{
    const s=store([0,1,3,4,5].map(i=>flowBar(i))),cache=new TimeframeCache(5*minute);
    cache.update(s,0);
    expect(cache.store.flow('takerBuyBase')![0]).toBeNaN();
    expect(cache.store.flow('quoteVolume')![0]).toBeNaN();
  });
  it('handles late schema introduction and reset without reusing old known flow values',()=>{
    const s=store([bar(0),bar(1)]),cache=new TimeframeCache(5*minute);cache.update(s,0);
    s.appendBar(flowBar(2));cache.update(s,2);expect(cache.store.flow('takerBuyBase')![0]).toBeNaN();
    const complete=store([flowBar(0),flowBar(1),flowBar(2)]);cache.update(complete,0);
    expect(cache.store.flow('takerBuyBase')![0]).toBe(21);
    const empty=store([bar(0)]);cache.update(empty,0);expect(cache.store.flow('takerBuyBase')?.[0]??NaN).toBeNaN();
  });
  it('maps a live HTF flow preview only to the current chart candle and matches full recomputation',()=>{
    const s=new ColumnStore(),r=new IndicatorRuntime(registry());
    const req=[{id:'flow-cvd',instanceId:'flow:five',params:{unit:'quote',reset:'loaded'},timeframe:'5m',baseIntervalMs:minute}];
    r.set(req);
    for(let i=0;i<14;i++){
      s.appendBar(flowBar(i,i%2?3:7));r.compute(s,i);
      s.updateLast(flowBar(i,8));const actual=r.compute(s,i),fresh=new IndicatorRuntime(registry());fresh.set(req);
      expect(values(actual,s.length)).toEqual(values(fresh.compute(s,0),s.length));
    }
    const vals=r.compute(s,13)[0].values;
    expect(vals.slice(0,5).every(Number.isNaN)).toBe(true);
    expect(vals[5]).toBe(3000);expect(vals[12]).toBe(6000);expect(vals[13]).toBe(8400);
  });
});

describe('flow worker transport',()=>{
  it('transports optional flow in independent buffers without detaching the live ColumnStore',()=>{
    class CaptureWorker {
      static instance:CaptureWorker;sent:any[]=[];onmessage:((event:{data:unknown})=>void)|null=null;onerror:null=null;
      constructor(){CaptureWorker.instance=this;}terminate(){}
      postMessage(message:unknown,transfer:Transferable[]=[]){this.sent.push(structuredClone(message,{transfer}));}
    }
    vi.stubGlobal('Worker',CaptureWorker);
    const s=store([flowBar(0),flowBar(1)]),engine=new IndicatorEngine(registry());
    engine.init(s,[{id:'flow-cvd',params:{reset:'loaded'}}]);
    const worker=CaptureWorker.instance,init=worker.sent[0];
    expect([...init.flow.takerBuyBase.slice(0,2)]).toEqual([7,7]);
    expect(s.flow('takerBuyBase')![0]).toBe(7);expect(s.col('time')[0]).toBe(epoch);
    worker.onmessage!({data:{type:'full',tick:0,length:2,series:[]}});
    s.updateLast(flowBar(1,9));engine.pushBar(false);
    const sync=worker.sent.at(-1);expect(sync.type).toBe('sync');
    expect(sync.start).toBe(1);expect([...sync.columns.flow.takerBuyBase]).toEqual([9]);
    expect(s.flow('takerBuyBase')![1]).toBe(9);engine.destroy();
  });
  it('computes real full/tail worker messages, clears recovered warnings, and preserves flow through growth and re-init',async()=>{
    vi.resetModules();const output:OutMsg[]=[];
    const port={postMessage:(message:OutMsg,transfer:Transferable[]=[])=>output.push(structuredClone(message,{transfer})),
      onmessage:null as ((event:{data:unknown})=>void)|null};
    vi.stubGlobal('self',port);await import('../src/lib/indicators/worker');
    const s=store([flowBar(0),bar(1)],2),reqs=[{id:'flow-cvd',instanceId:'real-flow',params:{reset:'loaded'}}];
    port.onmessage!({data:{type:'init',...columns(s,0,s.capacity),capacity:s.capacity,length:s.length,reqs}});
    const full=output.at(-1)!;if(full.type!=='full')throw Error('expected full');
    expect(values(full.series,2)).toEqual([[4,NaN]]);expect(full.series[0].dataWarning).toContain('1 根');
    s.updateLast(flowBar(1,6));
    port.onmessage!({data:{type:'sync',columns:columns(s,1),start:1,capacity:s.capacity,length:s.length,tick:1}});
    const repaired=output.at(-1)!;if(repaired.type!=='tail')throw Error('expected tail');
    expect([...repaired.patches[0].values]).toEqual([6]);
    expect(Object.hasOwn(repaired.patches[0],'dataWarning')).toBe(true);expect(repaired.patches[0].dataWarning).toBeUndefined();
    s.appendBar(flowBar(2,9));
    port.onmessage!({data:{type:'sync',columns:columns(s,2),start:2,capacity:s.capacity,length:s.length,tick:2}});
    const grown=output.at(-1)!;if(grown.type!=='tail')throw Error('expected tail');
    expect([...grown.patches[0].values]).toEqual([14]);
    const unknown=store([bar(0)]);
    port.onmessage!({data:{type:'init',...columns(unknown,0,unknown.capacity),capacity:unknown.capacity,length:1,reqs}});
    const reset=output.at(-1)!;if(reset.type!=='full')throw Error('expected full');
    expect(reset.series[0].values[0]).toBeNaN();expect(reset.series[0].dataWarning).toContain('1 根');
    expect(values(full.series,2)).toEqual([[4,NaN]]);
  });
});
