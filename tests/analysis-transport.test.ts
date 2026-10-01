import {afterEach,describe,expect,it,vi} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import type {BarInput,ColumnName,ColumnView,DerivedSeries} from '../src/lib/core/types';
import type {AnalysisObservation} from '../src/lib/analysis/types';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {IndicatorRuntime,type IndicatorReq} from '../src/lib/indicators/runtime';
import {IndicatorEngine} from '../src/lib/indicators/engine';
import type {OutMsg} from '../src/lib/indicators/worker';
import {ChartController,initialState} from '../src/lib/chart/controller';
import {Viewport} from '../src/lib/core/viewport';
import {emptyScene,layerOf} from '../src/lib/scene/types';

const minute=60_000,epoch=Date.UTC(2026,8,23),at=(i:number)=>epoch+i*minute;
const keys:ColumnName[]=['time','open','high','low','close','volume'];
const normal=(i:number,interval=minute):BarInput=>({time:epoch+i*interval,open:110-i*.2,high:111-i*.2,low:109-i*.2,close:110.4-i*.2,volume:100});
const doji=(i:number,interval=minute):BarInput=>({time:epoch+i*interval,open:105,high:107,low:103,close:105.05,volume:100});
const request:IndicatorReq={id:'analysis-candles',instanceId:'analysis:doji',params:{family:'Doji',lookback:100,dojiBody:.1}};
const ordinary:IndicatorReq={id:'ema',instanceId:'ema:stable',params:{period:5}};
function registry(){const r=new IndicatorRegistry();registerBuiltins(r);return r;}
function fixture(interval=minute){const s=new ColumnStore(128);for(let i=0;i<24;i++)s.appendBar(i>=22?doji(i,interval):normal(i,interval));return s;}
function columns(s:ColumnStore,start=0,end=s.capacity){return Object.fromEntries(keys.map(k=>[k,s.col(k).slice(start,end)]));}
const observations=(series:DerivedSeries[])=>series.flatMap(line=>line.observations??[]);
const closed=(s:ColumnStore,n=s.length):ColumnView=>({length:s.length,closedLength:n,col:key=>s.col(key)});

async function server(){
  vi.resetModules();const messages:OutMsg[]=[],transfers:number[][]=[];
  const port={onmessage:null as ((event:{data:unknown})=>void)|null,postMessage(message:OutMsg,transfer:Transferable[]=[]){
    transfers.push(transfer.map(item=>(item as ArrayBuffer).byteLength));messages.push(structuredClone(message,{transfer}));
  }};
  vi.stubGlobal('self',port);await import('../src/lib/indicators/worker');
  return {messages,transfers,send(message:unknown){port.onmessage!({data:message});return messages.at(-1)!;}};
}
class ClientWorker {
  static current:ClientWorker;sent:unknown[]=[];onmessage:((event:{data:OutMsg})=>void)|null=null;onerror:null=null;
  constructor(){ClientWorker.current=this;}terminate(){}
  postMessage(message:unknown,transfer:Transferable[]=[]){this.sent.push(structuredClone(message,{transfer}));}
  deliver(message:OutMsg){this.onmessage?.({data:message});}
}
afterEach(()=>vi.unstubAllGlobals());

describe('analytical observation metadata transport',()=>{
  it('delivers full evidence, omits it for quotes, and transmits closed discoveries and explicit removal through real tail messages',async()=>{
    const worker=await server(),s=fixture();vi.stubGlobal('Worker',ClientWorker);
    const engine=new IndicatorEngine(registry()),updates=vi.fn();engine.onUpdate=updates;
    engine.init(s,[request]);const client=ClientWorker.current;
    const full=worker.send(client.sent.at(-1));client.deliver(full);
    if(full.type!=='full')throw Error('expected full');
    const initial=full.series[0].observations!;
    expect(initial).toHaveLength(1);expect(initial[0].time).toBe(at(22));expect(initial[0].availableAt).toBe(at(23));
    expect(initial[0].evidence.length).toBeGreaterThan(0);expect(initial[0].counterEvidence.length).toBeGreaterThan(0);
    expect(initial[0].ruleVersion).toContain('candlestick');
    const initialGeometry=engine.derived[0].observations,initialValues=engine.derived[0].values;
    expect(worker.transfers.at(-1)).toEqual([s.length*8]);

    s.updateLast({...doji(23),high:120,low:90});engine.pushBar(false);
    const quote=worker.send(client.sent.at(-1));client.deliver(quote);
    if(quote.type!=='tail')throw Error('expected quote tail');
    expect(Object.hasOwn(quote.patches[0],'observations')).toBe(false);
    expect(Object.hasOwn(quote.patches[0],'patternScan')).toBe(false);
    expect(engine.derived[0].observations).toBe(initialGeometry);expect(engine.derived[0].values).toBe(initialValues);

    engine.pushBar(false,true);const confirmed=worker.send(client.sent.at(-1));client.deliver(confirmed);
    if(confirmed.type!=='tail')throw Error('expected closed tail');
    expect(Object.hasOwn(confirmed.patches[0],'observations')).toBe(true);
    expect(confirmed.patches[0].observations).toHaveLength(2);
    expect(observations(engine.derived).map(o=>o.time)).toEqual([at(23),at(22)]);
    expect(updates).toHaveBeenLastCalledWith({from:23,length:24});
    expect(initial).toHaveLength(1); // A previously delivered snapshot stays immutable.

    s.updateLast(normal(23));engine.pushBar(false,true);
    const corrected=worker.send(client.sent.at(-1));client.deliver(corrected);
    if(corrected.type!=='tail')throw Error('expected correction tail');
    expect(corrected.patches[0].observations?.map(o=>o.time)).toEqual([at(22)]);

    // A historical correction is an explicit sync patch; [] must clear the
    // old observation, unlike omitted metadata in a quote-only patch.
    const replacement=normal(22);for(const name of keys)s.col(name)[22]=replacement[name];
    const removed=worker.send({type:'sync',columns:columns(s,22,s.length),start:22,length:s.length,capacity:s.capacity,closedLength:24,tick:10});
    client.deliver(removed);if(removed.type!=='tail')throw Error('expected removal tail');
    expect(Object.hasOwn(removed.patches[0],'observations')).toBe(true);expect(removed.patches[0].observations).toEqual([]);
    expect(engine.derived[0].observations).toEqual([]);expect(updates).toHaveBeenLastCalledWith({from:22,length:24});
    engine.destroy();
  });

  it('does not mark an FVG filled from the forming candle but publishes the closed invalidation with original anchors intact',async()=>{
    const worker=await server(),s=new ColumnStore(128);
    for(let i=0;i<22;i++)s.appendBar(normal(i));
    const legs=[{open:105,high:106,low:104,close:105.8},{open:106,high:110,low:105,close:109},
      {open:110,high:112,low:109,close:111},{open:110,high:111,low:105,close:107}];
    legs.forEach((leg,i)=>s.appendBar({time:at(i+22),volume:150,...leg}));
    const req={id:'analysis-zones',instanceId:'zone:fill',params:{family:'FVG'}};
    const initial=worker.send({type:'init',...columns(s),length:s.length,capacity:s.capacity,reqs:[req]});
    if(initial.type!=='full')throw Error('expected full');
    const before=initial.series[0].observations!.find(o=>o.time===at(24))!;
    expect(before.state).toBe('confirmed');expect(before.zone).toMatchObject({low:106,high:109});
    const closedMessage=worker.send({type:'bar',bar:{...legs[3],time:at(25),volume:150},isNew:false,length:s.length,capacity:s.capacity,closedLength:s.length,tick:1});
    if(closedMessage.type!=='tail')throw Error('expected tail');
    const after=closedMessage.patches[0].observations!.find(o=>o.id===before.id)!;
    expect(after.state).toBe('invalidated');expect(after.invalidatedAt).toBe(at(26));
    expect(after.availableAt).toBe(before.availableAt);expect(after.points).toEqual(before.points);
    expect(before.state).toBe('confirmed');expect(after.events.at(-1)?.time).toBe(at(25));
  });

  it('uses metadata-only viewport messages without rewinding known observations or replacing an ordinary indicator array',async()=>{
    const worker=await server(),s=fixture();vi.stubGlobal('Worker',ClientWorker);
    const engine=new IndicatorEngine(registry()),updates=vi.fn();engine.onUpdate=updates;
    engine.init(s,[ordinary,request]);const client=ClientWorker.current;
    client.deliver(worker.send(client.sent.at(-1)));
    const ema=engine.derived.find(s=>s.indicatorId===ordinary.instanceId)!,emaValues=ema.values;
    const analytical=engine.derived.find(s=>s.indicatorId===request.instanceId)!,values=analytical.values;
    expect(analytical.observations).toHaveLength(1);
    engine.setReqs([ordinary,{...request,patternWindow:{fromTime:at(0),toTime:at(20)}}]);
    const outgoing=client.sent.at(-1) as {type:string};expect(outgoing.type).toBe('pattern-window');
    expect(outgoing).not.toHaveProperty('columns');
    const response=worker.send(outgoing);if(response.type!=='patterns')throw Error('expected metadata-only message');
    expect(worker.transfers.at(-1)).toEqual([]);expect(response.patches).toHaveLength(1);
    // Screen bounds are spatial interest, not a replay cutoff. The chart
    // controller clips this already-known Doji outside the visible window.
    expect(response.patches[0]).toMatchObject({indicatorId:request.instanceId});
    expect(response.patches[0].observations?.map(o=>o.time)).toEqual([at(22)]);
    expect(response.patches[0]).not.toHaveProperty('values');
    client.deliver(response);
    expect(engine.pending).toBe(false);expect(analytical.observations?.map(o=>o.time)).toEqual([at(22)]);expect(analytical.values).toBe(values);
    expect(engine.derived.find(s=>s.indicatorId===ordinary.instanceId)).toBe(ema);expect(ema.values).toBe(emaValues);
    expect(updates).toHaveBeenLastCalledWith({from:s.length,length:s.length});
    engine.setReqs([ordinary,request]);const restore=worker.send(client.sent.at(-1));client.deliver(restore);
    expect(analytical.observations).toHaveLength(1);expect(analytical.patternScan?.scope).toBe('latest');
    expect(ema.values).toBe(emaValues);engine.destroy();
  });

  it('keeps source-time evidence unchanged inside an unfinished higher-timeframe candle and publishes at its actual close',()=>{
    const source=fixture(5*minute),base=new ColumnStore(256),req={...request,timeframe:'5m',baseIntervalMs:minute};
    for(let i=0;i<source.length;i++)for(let j=0;j<(i===source.length-1?1:5);j++){
      const b=i>=22?doji(i,5*minute):normal(i,5*minute);base.appendBar({...b,time:b.time+j*minute,volume:20});
    }
    const direct=new IndicatorRuntime(registry());direct.set([{...request,baseIntervalMs:5*minute}]);
    const higher=new IndicatorRuntime(registry());higher.set([req]);
    const expected=observations(direct.compute(source,0)),initial=higher.compute(base,0),geometry=initial[0].observations;
    expect(geometry).toEqual(expected);expect(geometry).toHaveLength(1);
    expect(geometry![0].time).toBe(at(110));expect(geometry![0].availableAt).toBe(at(115));
    base.updateLast({...doji(23,5*minute),high:120,low:90,volume:20});
    expect(higher.compute(base,base.length-1)[0].observations).toBe(geometry);
    for(let j=1;j<5;j++){
      base.appendBar({...doji(23,5*minute),time:at(115+j),volume:20});
      expect(higher.compute(base,base.length-1)[0].observations).toBe(geometry);
    }
    const completed=higher.compute(closed(base),base.length-1)[0].observations!;
    expect(completed).toHaveLength(2);expect(completed[0].time).toBe(at(115));expect(completed[0].availableAt).toBe(at(120));
    expect(completed.every(item=>item.availableAt<=at(120)&&item.points.every(p=>p.time<=item.availableAt))).toBe(true);
    expect(geometry).toHaveLength(1);
  });

  it('distinguishes an ordinary historical viewport from a real closed-prefix replay',()=>{
    const s=fixture(),runtime=new IndicatorRuntime(registry());
    runtime.set([{...request,patternWindow:{fromTime:at(0),toTime:at(21)}}]);
    const known=observations(runtime.compute(s,0));expect(known).toHaveLength(1);
    runtime.set([{...request,patternWindow:{fromTime:at(0),toTime:at(22)}}]);
    const result=observations(runtime.compute(s,s.length,true));
    expect(result).toHaveLength(1);expect(result[0].time).toBe(at(22));expect(result[0].availableAt).toBe(at(23));
    expect(result[0].throughTime).toBe(at(23));
    expect(result).toEqual(known);
    // Future arrays may physically exist, but explicit replay closure is the
    // actual knowledge boundary; no screen position may override it.
    expect(observations(runtime.compute(closed(s,22),0))).toEqual([]);
    const replay=observations(runtime.compute(closed(s,23),22));
    expect(replay).toEqual(known);expect(replay.every(o=>o.availableAt<=at(23))).toBe(true);
  });
});

function controllerHarness(){
  const s=fixture(),reg=registry(),runtime=new IndicatorRuntime(reg);runtime.set([request]);
  const series=runtime.compute(s,0),original=series[0].observations![0];
  const invalid:AnalysisObservation={...structuredClone(original),id:'invalidated-observation',state:'invalidated',invalidatedAt:at(24)};
  series[0].observations=[original,invalid];const doc=emptyScene();
  doc.indicators=[{id:request.id,instanceId:request.instanceId!,params:{...request.params,showInvalidated:false},timeframe:'chart',hiddenPlots:[]}];
  doc.layers=[layerOf(request.instanceId!,'indicator','分析')];
  const engine={pending:false,derived:series},drawing={document:doc,
    effective:(id:string)=>({visible:doc.layers.find(l=>l.id===id)?.visible??false,locked:false,opacity:1,reason:''}),selectLayers:vi.fn()};
  const controller=Object.assign(Object.create(ChartController.prototype),{registry:reg,store:s,engine,drawing,
    viewport:new Viewport(s.length,{from:0,to:24,plotW:800,plotH:500}),state:{...initialState,interval:'1m',source:'binance',loading:false},
    patternWindowPending:false,selectedAnalysisKey:null,selectedPatternKey:'old-pattern',selectedCandidateKey:'old-candidate',
    autoRanges:new Map(),rangeMoving:false,dirty:false,overlayDirty:false,publish:vi.fn(),focusTimeRange:vi.fn(),
  });
  return {controller,engine,doc,original,drawing};
}
describe('controller analytical selection and visibility',()=>{
  it('hides invalidated observations by default without mutating shared worker geometry',()=>{
    const {controller,engine,doc,original}=controllerHarness(),geometry=engine.derived[0].observations;
    const before=structuredClone(geometry);
    expect(controller.getAnalysisRows().map((row:{observation:AnalysisObservation})=>row.observation.id)).toEqual([original.id]);
    doc.indicators[0].params.showInvalidated=true;
    expect(controller.getAnalysisRows()).toHaveLength(2);
    expect(engine.derived[0].observations).toBe(geometry);expect(geometry).toEqual(before);
  });
  it('selects and publishes sparse evidence while preserving source anchors and scheduling chart redraw',()=>{
    const {controller,engine,original,drawing}=controllerHarness(),before=structuredClone(engine.derived[0].observations);
    controller.selectAnalysis(request.instanceId,original.id,true);
    expect(controller.selectedAnalysisKey).toBe(`${request.instanceId}:${original.id}`);
    expect(controller.selectedPatternKey).toBeNull();expect(controller.selectedCandidateKey).toBeNull();
    expect(drawing.selectLayers).toHaveBeenCalledWith([request.instanceId]);
    expect(controller.focusTimeRange).toHaveBeenCalledWith(original.time,original.availableAt);
    expect(controller.dirty).toBe(true);expect(controller.overlayDirty).toBe(true);expect(controller.publish).toHaveBeenCalled();
    expect(engine.derived[0].observations).toEqual(before);
  });
  it('keeps hidden-layer records inspectable, but removes results while new parameter calculations are pending',()=>{
    const {controller,engine,doc}=controllerHarness();doc.layers[0].visible=false;
    expect(controller.getAnalysisRows()[0].visible).toBe(false);
    expect(controller.getAnalysisStudies()[0]).toMatchObject({count:1,visible:false,pending:false});
    engine.pending=true;expect(controller.getAnalysisRows()).toEqual([]);
    controller.patternWindowPending=true;expect(controller.getAnalysisRows()).toHaveLength(1);
    expect(controller.getAnalysisRows()[0].visible).toBe(false);
  });
});
