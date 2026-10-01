import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChartController, initialState } from '../src/lib/chart/controller';
import { ColumnStore } from '../src/lib/core/datastore';
import { Viewport } from '../src/lib/core/viewport';
import { IndicatorRegistry, registerBuiltins } from '../src/lib/indicators/registry';
import { emptyScene, layerOf } from '../src/lib/scene/types';
import { normalizeDocument } from '../src/lib/scene/model';
import type { PatternMatch } from '../src/lib/patterns/types';
import type { DerivedSeries } from '../src/lib/core/types';

const minute=60_000,epoch=Date.parse('2026-08-15T00:00:00Z');
const at=(i:number)=>epoch+i*minute;
function match(id:string,index:number,status:PatternMatch['status']='confirmed'):PatternMatch {
  return {id,family:'huzi-triangle',name:'三角形',direction:'bullish',status,confirmedAt:at(index+10),
    points:[{label:'A',time:at(index),value:100},{label:'B',time:at(index+4),value:90},{label:'C',time:at(index+8),value:99}],
    zone:{low:99,high:101},invalidation:80,targets:[120],ratios:[],description:'fixture'};
}
function harness(){
  const store=new ColumnStore(1024);for(let i=0;i<600;i++)store.appendBar({time:at(i),open:100,high:101,low:99,close:100,volume:1});
  const registry=new IndicatorRegistry();registerBuiltins(registry);
  const doc=emptyScene();doc.indicators=[
    {id:'pattern-huzi',instanceId:'pattern:mounted',params:{lookback:1500,pivotStrength:3,maxPatterns:50,historyDisplay:'active',showCandidates:true},timeframe:'chart',hiddenPlots:[]},
    {id:'ema',instanceId:'ema:mounted',params:{period:9},timeframe:'chart',hiddenPlots:[]},
  ];
  doc.layers=doc.indicators.map(i=>layerOf(i.instanceId,'indicator',i.id));
  const patterns=[match('old',10),match('visible',120),match('invalid',150,'invalidated'),match('future',320)];
  const derived:DerivedSeries[]=[{name:'看涨形态',indicatorId:'pattern:mounted',plotIndex:0,plot:'patterns',pane:'main',color:'#abc',values:new Float64Array(1024),patterns}];
  const engine={pending:false,derived,setReqs:vi.fn()};engine.setReqs.mockImplementation(()=>{engine.pending=true;});
  const controller=Object.assign(Object.create(ChartController.prototype),{
    registry,store,engine,viewport:new Viewport(store.length,{from:100,to:200,plotW:800,plotH:500}),
    drawing:{document:doc,effective:()=>({visible:true,locked:false,opacity:1,reason:''})},
    reqs:doc.indicators.map(i=>({id:i.id,instanceId:i.instanceId,params:i.params,timeframe:i.timeframe})),
    state:{...initialState,source:'binance',symbol:'BTCUSDT',interval:'1m',loading:false,status:'ok',following:false},
    dead:false,generation:1,drawingRevision:0,patternWindow:undefined,patternWindowQueued:'',patternWindowPending:false,
    syncedDocument:doc,syncedInterval:'1m',publish:vi.fn(),loadPatternHistory:vi.fn(async()=>{}),
  });
  controller.calculationSignature=JSON.stringify(controller.workerRequests());
  return {controller,engine,doc};
}
afterEach(()=>vi.useRealTimers());

describe('controller pattern viewport orchestration',()=>{
  it('debounces rapid pans to the final window and leaves ordinary indicator requests untouched',()=>{
    vi.useFakeTimers();const {controller,engine}=harness();
    for(const from of [40,200,400]){
      controller.viewport.from=from;controller.viewport.to=from+100;controller.schedulePatternWindow();vi.advanceTimersByTime(100);
    }
    const expected=controller.desiredPatternWindow();
    expect(engine.setReqs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(121);
    expect(engine.setReqs).toHaveBeenCalledTimes(1);
    const requests=engine.setReqs.mock.calls[0][0];
    expect(requests.find((r:{id:string})=>r.id==='pattern-huzi').patternWindow).toEqual(expected);
    const ordinary=requests.find((r:{id:string})=>r.id==='ema');
    expect(ordinary).not.toHaveProperty('patternWindow');expect(ordinary.params).toEqual({period:9});
    const pattern=requests.find((r:{id:string})=>r.id==='pattern-huzi');
    expect(pattern.params).toEqual({lookback:1500,pivotStrength:3});
    expect(controller.loadPatternHistory).toHaveBeenCalledTimes(1);
  });

  it('cancels an abandoned scan when a pan returns to the already displayed window before debounce',()=>{
    vi.useFakeTimers();const {controller,engine}=harness();
    controller.patternWindow=controller.desiredPatternWindow();
    controller.viewport.from=300;controller.viewport.to=400;controller.schedulePatternWindow();
    vi.advanceTimersByTime(100);
    controller.viewport.from=100;controller.viewport.to=200;controller.schedulePatternWindow();
    vi.advanceTimersByTime(300);
    expect(engine.setReqs).not.toHaveBeenCalled();expect(controller.loadPatternHistory).not.toHaveBeenCalled();
    expect(controller.patternWindowQueued).toBe('');expect(controller.patternWindowTimer).toBeUndefined();
  });

  it('preserves visible results during a window request but never re-enables stale parameters via a queued pan timer',()=>{
    vi.useFakeTimers();const {controller,engine,doc}=harness();
    expect(controller.getPatternRows().map((row:{pattern:PatternMatch})=>row.pattern.id)).toEqual(['visible']);
    controller.schedulePatternWindow();vi.advanceTimersByTime(220);
    expect(controller.patternWindowPending).toBe(true);
    expect(controller.getPatternRows().map((row:{pattern:PatternMatch})=>row.pattern.id)).toEqual(['visible']);
    // Another small pan is waiting when a computational parameter changes.
    controller.viewport.from=110;controller.viewport.to=210;controller.schedulePatternWindow();
    controller.drawing.document={...doc,indicators:doc.indicators.map(i=>i.id==='pattern-huzi'?{...i,params:{...i.params,pivotStrength:6}}:i)};
    controller.syncScene();
    expect(engine.pending).toBe(true);expect(controller.patternWindowPending).toBe(false);
    expect(controller.getPatternRows()).toEqual([]);
    vi.advanceTimersByTime(220);
    expect(controller.patternWindowPending).toBe(false);
    expect(controller.getPatternRows()).toEqual([]);
  });

  it('filters to actual visible times and hides invalidated history even while the worker result arrays are reused',()=>{
    const {controller,engine}=harness(),geometry=engine.derived[0].patterns;
    expect(controller.getPatternRows().map((row:{pattern:PatternMatch})=>row.pattern.id)).toEqual(['visible']);
    expect(controller.getPatternStudies()[0]).toMatchObject({count:1,filteredInvalidated:1,outsideViewport:2});
    controller.viewport.from=300;controller.viewport.to=360;
    expect(controller.getPatternRows().map((row:{pattern:PatternMatch})=>row.pattern.id)).toEqual(['future']);
    expect(engine.derived[0].patterns).toBe(geometry);
    expect(engine.setReqs).not.toHaveBeenCalled();
  });

  it('keeps still-visible budgeted shapes while zooming into the same immutable evidence',()=>{
    const {controller,engine,doc}=harness();doc.indicators[0].params.maxPatterns=6;
    engine.derived[0].patterns=Array.from({length:80},(_,i)=>match(`dense-${i}`,i*6));
    controller.viewport.from=0;controller.viewport.to=500;
    let previous=controller.getPatternRows().map((r:{pattern:PatternMatch})=>r.pattern);
    for(const [from,to] of [[10,450],[40,400],[80,350],[100,300]]){
      controller.viewport.from=from;controller.viewport.to=to;
      // Worker metadata transfer may allocate new arrays for the same facts.
      engine.derived[0].patterns=structuredClone(engine.derived[0].patterns);
      const next=controller.getPatternRows().map((r:{pattern:PatternMatch})=>r.pattern);
      for(const p of previous)if(p.points.at(-1)!.time>=at(from)&&p.points[0].time<=at(to))expect(next.map((p:PatternMatch)=>p.id)).toContain(p.id);
      expect(next.length).toBeLessThanOrEqual(6);previous=next;
    }
    const removed=previous[0].id;
    engine.derived[0].patterns=engine.derived[0].patterns.map(p=>p.id===removed?{...p,status:'invalidated' as const}:p);
    expect(controller.getPatternRows().map((r:{pattern:PatternMatch})=>r.pattern.id)).not.toContain(removed);
  });

  it('migrates saved pattern defaults to active history and fifty drawings without changing ordinary studies',()=>{
    const {doc}=harness();doc.indicators[0].params={maxPatterns:12,showInvalidated:false,pivotStrength:7};
    const ordinary=doc.indicators[1],normalized=normalizeDocument(doc);
    // The layer is a classic-pattern (Huzi) study saved before the scale / boundary inputs: they are filled once.
    expect(normalized.indicators[0].params).toEqual({maxPatterns:50,historyDisplay:'active',patternDisplayVersion:3,pivotStrength:7,
      minStructureBars:20,earlyMinBars:80,flagPoleRatio:1.5,boundarySearch:true,largeScales:true,extraStructures:true});
    expect(normalized.indicators[1]).toBe(ordinary);
    expect(normalizeDocument(normalized).indicators[0].params).toBe(normalized.indicators[0].params);
  });

  it('publishes real-time visible pattern and candidate counts in readings without blanking during window scans',()=>{
    const {controller,engine}=harness();
    engine.derived.push(
      {name:'看跌形态',indicatorId:'pattern:mounted',plotIndex:1,plot:'patterns',pane:'main',color:'#f88',values:new Float64Array(1024).fill(NaN),patterns:[]},
      {name:'观察中结构',indicatorId:'pattern:mounted',plotIndex:2,plot:'patterns',pane:'main',color:'#8bf',values:new Float64Array(1024).fill(NaN),patterns:[],candidates:[
        {id:'cand-visible',family:'huzi-triangle',name:'观察中三角形',direction:'bullish',observedAt:at(140),points:[{label:'A',time:at(115),value:100},{label:'B',time:at(140),value:98}],ratios:[],description:'观察中'},
        {id:'cand-future',family:'huzi-triangle',name:'观察中三角形',direction:'bearish',observedAt:at(340),points:[{label:'A',time:at(315),value:100},{label:'B',time:at(340),value:98}],ratios:[],description:'观察中'},
      ]},
    );
    const emaValues=new Float64Array(1024).fill(NaN);emaValues[598]=100.25;
    engine.derived.push({name:'EMA',indicatorId:'ema:mounted',plotIndex:0,plot:'line',pane:'main',color:'#fa0',values:emaValues});
    Object.assign(controller,{
      renderer:{mode:'canvas2d'},onState:vi.fn(),readingKey:'',dataRevision:1,marketRevision:1,
      historicalSnapshot:false,lastBarConfirmed:false,pointer:null,overlays:[],
      barAt:(idx:number)=>({time:at(idx),open:100,high:101,low:99,close:100,volume:1}),
      publish:ChartController.prototype['publish'],
    });
    controller.publish(100);
    const firstPatternReading=controller.state.readings.find((r:{id:string})=>r.id==='pattern:mounted');
    expect(firstPatternReading?.values.map((v:{name:string;value:number;unit?:string})=>({name:v.name,value:v.value,unit:v.unit}))).toEqual([
      {name:'看涨形态',value:1,unit:'count'},
      {name:'看跌形态',value:0,unit:'count'},
      {name:'观察中结构',value:1,unit:'count'},
    ]);
    // Unconfirmed last bar falls back to previous confirmed bar for line indicators instead of flashing NaN.
    const emaReading=controller.state.readings.find((r:{id:string})=>r.id==='ema:mounted');
    expect(emaReading?.values[0].value).toBe(100.25);
    // Viewport pan updates visible pattern/candidate counts immediately.
    controller.viewport.from=250;controller.viewport.to=290;
    controller.publish(200);
    expect(controller.state.readings.find((r:{id:string})=>r.id==='pattern:mounted')?.values.map((v:{value:number})=>v.value)).toEqual([0,0,0]);
    // Background window scan (engine.pending && patternWindowPending) keeps existing readings without blanking.
    controller.viewport.from=300;controller.viewport.to=360;
    engine.pending=true;controller.patternWindowPending=true;
    controller.publish(300);
    expect(controller.state.readings.find((r:{id:string})=>r.id==='pattern:mounted')?.values.map((v:{value:number})=>v.value)).toEqual([1,0,1]);
  });
});
