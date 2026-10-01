import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {ChartController,initialState} from '../src/lib/chart/controller';
import {ColumnStore} from '../src/lib/core/datastore';
import {Pyramid} from '../src/lib/core/pyramid';
import {Viewport} from '../src/lib/core/viewport';
import {DrawingEngine} from '../src/lib/drawing/engine';
import {ToolRegistry} from '../src/lib/drawing/registry';
import {registerDrawingBuiltins} from '../src/lib/drawing/builtins';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {IndicatorEngine} from '../src/lib/indicators/engine';
import {RangeMotion} from '../src/lib/interaction/range-motion';
import {LiveBarMotion} from '../src/lib/interaction/live-bar-motion';
import {MockFeed} from '../src/lib/feed/mock-feed';
import {emptyScene,layerOf} from '../src/lib/scene/types';
import {REVIEW_STORAGE_KEY} from '../src/lib/analysis/reviews';
import type {AnalysisObservation} from '../src/lib/analysis/types';
import type {ColumnView,DerivedSeries} from '../src/lib/core/types';
import type {DrawingHost,Anchor} from '../src/lib/drawing/types';

const minute=60000,epoch=Date.UTC(2026,8,23),at=(i:number)=>epoch+i*minute;
const id='analysis:fixture',sourceId='auto:structure';
let storage:Map<string,string>;const cleanup:(()=>void)[]=[];
beforeEach(()=>{
  storage=new Map();vi.stubGlobal('crypto',webcrypto);
  vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)});
  vi.stubGlobal('Worker',class{constructor(){throw Error('Use real main-thread indicator fallback in this host test');}});
  vi.stubGlobal('requestAnimationFrame',(cb:(time:number)=>void)=>{queueMicrotask(()=>cb(0));return 1;});
});
afterEach(()=>{for(const close of cleanup.splice(0))close();vi.restoreAllMocks();vi.unstubAllGlobals();});
function data(n=100){const s=new ColumnStore(n);for(let i=0;i<n;i++)s.appendBar({time:at(i),open:100+i/10,high:102+i/10,low:99+i/10,close:101+i/10,volume:100+i});return s;}
function observation():AnalysisObservation{return {id:sourceId,family:'structure',name:'固定三点结构',ruleVersion:'manual-fixture/1',direction:'bullish',state:'confirmed',time:at(20),availableAt:at(61),throughTime:at(100),
  points:[{label:'A',time:at(20),value:100},{label:'B',time:at(40),value:160},{label:'C',time:at(60),value:100}],events:[],evidence:['原自动证据'],counterEvidence:['人工修订应保持独立'],waitingFor:['后续观察']};}

/** DOM/layout services are shells only. Controller replay, indicator runtime,
 * scene transactions, editing gestures, persistence and undo stay production. */
function harness(){
  const store=data(),registry=new IndicatorRegistry();registerBuiltins(registry);
  const calls:{length:number;closedLength?:number;from:number;lastTime:number}[]=[];
  const compute=(cols:ColumnView,from:number):DerivedSeries[]=>{
    calls.push({length:cols.length,closedLength:cols.closedLength,from,lastTime:cols.col('time')[cols.length-1]});
    return [{name:'fixture',pane:'main',plot:'analysis',color:'#abc',values:Float64Array.from(cols.col('close').subarray(0,cols.length)),
      observations:(cols.closedLength??cols.length-1)>=61?[{...observation(),throughTime:at(cols.closedLength??cols.length-1)}]:[]}];
  };
  registry.register({id:'analysis-replay-probe',name:'Replay probe',category:'analysis',target:'main',inputs:[],calc:ctx=>compute(ctx.cols,ctx.from),createIncremental:()=>({update:compute})});
  const tools=new ToolRegistry();registerDrawingBuiltins(tools);
  const project=(p:Anchor)=>({x:(p.time-epoch)/minute*5,y:p.value});
  const coordinates:DrawingHost={paneAt:()=> 'main',projection:()=>({pane:{id:'main',top:0,height:500,width:1000},project,indexAt:t=>(t-epoch)/minute}),anchorAt:p=>({time:epoch+p.x/5*minute,value:p.y}),zoomTo:()=>{}};
  const doc=emptyScene();doc.indicators=[{id:'analysis-replay-probe',instanceId:id,params:{},timeframe:'chart',hiddenPlots:[]}];
  doc.layers=[layerOf('series:candles','series','K线'),layerOf(id,'indicator','分析证据')];
  const drawing=new DrawingEngine(tools,coordinates,()=>{},()=>structuredClone(doc));drawing.setMarket('mock:BTCUSDT');
  const engine=new IndicatorEngine(registry),host={style:{cursor:''},classList:{remove:()=>{},add:()=>{}},hasPointerCapture:()=>false,releasePointerCapture:()=>{},focus:()=>{}};
  const feed={disconnect:vi.fn()};
  const controller=Object.assign(Object.create(ChartController.prototype),{
    store,pyramid:new Pyramid(store),registry,drawing,engine,host,feed,dead:false,generation:1,marketRevision:0,dataRevision:0,drawingRevision:0,
    state:{...initialState,loading:false,source:'mock',symbol:'BTCUSDT',interval:'1m',smoothMotion:false,status:'ok'},
    viewport:new Viewport(store.length,{from:0,to:100,plotW:1000,plotH:500}),viewportMotion:new RangeMotion({min:0,max:100}),liveBarMotion:new LiveBarMotion(),
    manualScales:new Map(),autoRanges:new Map(),studyMarkers:new Map(),emptyPaneRanges:new Map(),fitEmptyPanes:new Set(),
    patternWindow:undefined,patternWindowPending:false,patternWindowQueued:'',lastBarConfirmed:true,historicalSnapshot:false,analysisReplay:false,replayCursor:0,replaySource:undefined,
    reqs:[{id:'analysis-replay-probe',instanceId:id,params:{},timeframe:'chart'}],calculationSignature:'',syncedDocument:null,syncedInterval:'',
    externalOverlays:[],overlays:[],markerIndices:new Map(),
    drag:null,pendingPointer:null,pointer:null,magnetPointer:null,magnetGuide:null,axes:null,panes:[],maximizedPane:null,
    paneControls:{querySelector:()=>null,replaceChildren:()=>{}},controlsKey:'',controlsLayoutKey:'',onPaneLayout:()=>{},
    tickTimes:[],frameTimes:[],publish:vi.fn(),selectedAnalysisKey:null,selectedPatternKey:null,selectedCandidateKey:null,
  });
  engine.onUpdate=range=>controller.onIndicatorUpdate(range);
  engine.init(store,controller.workerRequests(),true);
  const unsubscribe=drawing.subscribe(()=>controller.syncScene());
  cleanup.push(()=>{unsubscribe();controller.feed?.disconnect();engine.destroy();drawing.destroy();clearTimeout(controller.patternWindowTimer);});
  return {controller,drawing,engine,store,calls,tools,coordinates,project,feed};
}

describe('analysis navigation includes the observed structure',()=>{
  it('frames every wave anchor when the observation time is its last point',()=>{
    const h=harness(),record=h.engine.derived[0].observations![0];
    record.family='wave';record.time=at(60);record.availableAt=at(63);
    h.controller.selectAnalysis(id,sourceId,true);
    expect(h.controller.viewport.from).toBeLessThan(20);
    expect(h.controller.viewport.to).toBeGreaterThan(63);
    expect(h.controller.selectedAnalysisKey).toBe(`${id}:${sourceId}`);
  });
  it('includes an earlier structural reference without zooming out to speculative projection endpoints',()=>{
    const h=harness(),record=h.engine.derived[0].observations![0];
    record.lines=[{role:'boundary',points:[{label:'参考',time:at(5),value:110},{label:'事件',time:at(60),value:110}]},
      {role:'projection',points:[{label:'',time:at(60),value:110},{label:'投射',time:at(1000),value:300}]}];
    h.controller.selectAnalysis(id,sourceId,true);
    expect(h.controller.viewport.from).toBeLessThan(5);
    expect(h.controller.viewport.to).toBeGreaterThan(61);
    expect(h.controller.viewport.to).toBeLessThan(100);
  });
});

describe('analysis replay uses actual prefix state',()=>{
  it('freezes only confirmed bars and gives the indicator engine no future candles',()=>{
    const h=harness();h.controller.lastBarConfirmed=false;
    const frozen=h.controller.beginAnalysisReplay();
    expect(frozen.bars).toHaveLength(99);
    expect(h.controller.getAnalysisReplayState()).toEqual({active:true,cursor:59,total:99,time:at(58)});
    expect(h.controller.store.length).toBe(59);expect(h.calls.at(-1)).toMatchObject({length:59,closedLength:59,lastTime:at(58)});
    expect(h.engine.derived[0].observations).toEqual([]);
    expect(h.feed.disconnect).toHaveBeenCalled();expect(h.controller.state).toMatchObject({historicalSnapshot:true,analysisReplay:true,paused:true,following:false});
    frozen.bars[70].close=99999;h.controller.seekAnalysisReplay(71);
    expect(h.controller.store.col('close')[70]).toBe(108); // Returned snapshot is not the replay source.
  });
  it('advances nearby cursors incrementally, including each closed candle, and rebuilds on backward seeks',()=>{
    const h=harness();h.controller.beginAnalysisReplay();
    const start=h.controller.getAnalysisReplayState().cursor,prefixStore=h.controller.store;
    const init=vi.spyOn(h.engine,'init'),push=vi.spyOn(h.engine,'pushBar');h.calls.length=0;
    h.controller.seekAnalysisReplay(start+3);
    expect(h.controller.store).toBe(prefixStore);expect(init).not.toHaveBeenCalled();expect(push).toHaveBeenCalledTimes(3);
    expect(push.mock.calls).toEqual([[true,true],[true,true],[true,true]]);
    expect(h.calls.map(c=>c.closedLength)).toEqual([start+1,start+2,start+3]);
    expect(h.controller.getAnalysisReplayState().time).toBe(at(start+2));
    h.controller.seekAnalysisReplay(35);
    expect(h.controller.store).not.toBe(prefixStore);expect(init).toHaveBeenCalledTimes(1);
    expect(h.calls.at(-1)).toMatchObject({length:35,closedLength:35,lastTime:at(34)});
    expect(h.engine.derived[0].observations).toEqual([]);expect(h.controller.getAnalysisReplayState().total).toBe(100);
  });
  it('clamps the cursor to actual source bounds instead of exposing empty or invented future bars',()=>{
    const h=harness();h.controller.beginAnalysisReplay();h.controller.seekAnalysisReplay(-100);
    expect(h.controller.getAnalysisReplayState()).toMatchObject({cursor:1,time:at(0),total:100});
    h.controller.seekAnalysisReplay(10000);
    expect(h.controller.getAnalysisReplayState()).toMatchObject({cursor:100,time:at(99),total:100});expect(h.controller.store.length).toBe(100);
  });
  it('drops live session overlays when freezing historical bars and never restores future output during playback',()=>{
    const h=harness();h.controller.setOverlayGroup('agent',[{id:'agent:live-line',name:'Live observation',kind:'line',pane:'main',color:'#abcdef',values:Float64Array.from(h.store.col('close').subarray(0,h.store.length))}]);
    expect(h.controller.overlays).toHaveLength(1);
    h.controller.beginAnalysisReplay();expect(h.controller.overlays).toEqual([]);
    h.controller.seekAnalysisReplay(100);expect(h.controller.overlays).toEqual([]);
    h.controller.seekAnalysisReplay(45);expect(h.controller.overlays).toEqual([]);
  });
  it('returns through the real market-loading path and clears the replay cursor/source and paused flags',async()=>{
    const h=harness();h.controller.beginAnalysisReplay();
    const fresh=data(120);vi.spyOn(MockFeed.prototype,'loadStore').mockReturnValue(fresh);
    vi.spyOn(MockFeed.prototype,'connect').mockResolvedValue();vi.spyOn(MockFeed.prototype,'disconnect').mockImplementation(()=>{});
    const market=vi.spyOn(h.controller,'setMarket');
    h.controller.followLatest();expect(market).toHaveBeenCalledWith('mock','BTCUSDT','1m');
    await market.mock.results[0].value;
    expect(h.controller.getAnalysisReplayState()).toMatchObject({active:false,cursor:0,total:0,time:at(119)});
    expect(h.controller.state).toMatchObject({analysisReplay:false,historicalSnapshot:false,paused:false,following:true,loading:false});
    expect(h.controller.store).toBe(fresh);expect(h.calls.at(-1)).toMatchObject({length:120,closedLength:119});
  });
});

describe('independent manual correction and persisted review scope',()=>{
  it('copies actual anchors, supports endpoint and body dragging, and never mutates automatic evidence',()=>{
    const h=harness(),source=h.engine.derived[0].observations![0],before=structuredClone(source);
    const ids=h.controller.copyObservationToDrawing('analysis',id,sourceId);
    expect(ids).toHaveLength(2);expect(h.drawing.state.drawings).toHaveLength(1);
    const copy=h.drawing.state.drawings[0];expect(copy.toolId).toBe('analysis-path');expect(copy.props.manual).toBe(true);
    expect(h.controller.getAnalysisRows().filter((row:{visible:boolean})=>row.visible)).toEqual([]);
    const endpoint=h.project(copy.points[1]);
    expect(h.drawing.pointerDown(endpoint,'main')).toBe(true);h.drawing.pointerMove({x:endpoint.x+30,y:endpoint.y-10});h.drawing.pointerUp({x:endpoint.x+40,y:endpoint.y-20});
    expect(h.drawing.state.drawings[0].points[1]).toEqual({time:at(48),value:140});
    const edited=structuredClone(h.drawing.state.drawings[0].points),a=h.project(edited[0]),b=h.project(edited[1]),middle={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    expect(h.drawing.pointerDown(middle,'main')).toBe(true);h.drawing.pointerMove({x:middle.x+10,y:middle.y+5});h.drawing.pointerUp({x:middle.x+20,y:middle.y+10});
    expect(h.drawing.state.drawings[0].points).toEqual(edited.map(p=>({time:p.time+4*minute,value:p.value+10})));
    expect(source).toEqual(before);expect(h.engine.derived[0].observations![0]).toBe(source);
    const reloaded=new DrawingEngine(h.tools,h.coordinates,()=>{});reloaded.setMarket('mock:BTCUSDT');
    expect(reloaded.state.drawings[0].points).toEqual(h.drawing.state.drawings[0].points);reloaded.destroy();
  });
  it('undoing the copy restores automatic visibility, and redo hides only the copied source again',()=>{
    const h=harness(),raw=structuredClone(h.engine.derived[0].observations);
    h.controller.copyObservationToDrawing('analysis',id,sourceId);expect(h.controller.getAnalysisRows().filter((row:{visible:boolean})=>row.visible)).toEqual([]);
    h.drawing.undo();expect(h.drawing.state.drawings).toEqual([]);expect(h.controller.getAnalysisRows().filter((row:{visible:boolean})=>row.visible)).toHaveLength(1);
    expect(h.controller.getObservationReview('analysis',id,sourceId)?.decision).toBe('manual');
    h.drawing.redo();expect(h.drawing.state.drawings).toHaveLength(1);expect(h.controller.getAnalysisRows().filter((row:{visible:boolean})=>row.visible)).toEqual([]);
    expect(h.engine.derived[0].observations).toEqual(raw);
  });
  it('persists rejection separately and isolates market, interval, instance, and record kind',()=>{
    const h=harness();h.controller.setObservationReview('analysis',id,sourceId,'rejected','不是该形态');
    expect(h.controller.getAnalysisRows().filter((row:{visible:boolean})=>row.visible)).toEqual([]);expect(storage.has(REVIEW_STORAGE_KEY)).toBe(true);
    expect(h.controller.getObservationReview('pattern',id,sourceId)).toBeUndefined();
    expect(h.controller.getObservationReview('analysis','another-instance',sourceId)).toBeUndefined();
    h.controller.state.interval='5m';expect(h.controller.getObservationReview('analysis',id,sourceId)).toBeUndefined();
    h.controller.state.interval='1m';h.controller.state.symbol='ETHUSDT';expect(h.controller.getObservationReview('analysis',id,sourceId)).toBeUndefined();
    h.controller.state.symbol='BTCUSDT';expect(h.controller.getObservationReview('analysis',id,sourceId)?.note).toBe('不是该形态');
    const restored=harness();expect(restored.controller.getObservationReview('analysis',id,sourceId)?.decision).toBe('rejected');
    restored.controller.restoreObservation('analysis',id,sourceId);expect(restored.controller.getAnalysisRows().filter((row:{visible:boolean})=>row.visible)).toHaveLength(1);
    const after=harness();expect(after.controller.getObservationReview('analysis',id,sourceId)).toBeUndefined();
  });
  it('does not permit manual conversion or review mutation through a locked source layer',()=>{
    const h=harness();h.drawing.updateLayers([id],{locked:true});
    expect(()=>h.controller.copyObservationToDrawing('analysis',id,sourceId)).toThrow('解锁');
    expect(()=>h.controller.setObservationReview('analysis',id,sourceId,'rejected')).toThrow('解锁');
    expect(()=>h.controller.restoreObservation('analysis',id,sourceId)).toThrow('解锁');
    expect(h.drawing.state.drawings).toEqual([]);expect(h.controller.getAnalysisRows()).toHaveLength(1);
  });
});

it('visible flow query uses real candle coverage and never empty overscroll or a future bucket',()=>{
  const h=harness();vi.spyOn(Date,'now').mockReturnValue(at(99)+30_000);
  h.controller.viewport.from=-20;h.controller.viewport.to=200;
  expect(h.controller.getVisibleAnalysisTimeRange()).toEqual({from:at(0),to:at(99)+30_000});
  h.controller.viewport.from=10.2;h.controller.viewport.to=20.1;
  expect(h.controller.getVisibleAnalysisTimeRange()).toEqual({from:at(10),to:at(22)-1});
  h.controller.viewport.from=120;expect(h.controller.getVisibleAnalysisTimeRange()).toBeUndefined();
  h.controller.viewport.from=-100;h.controller.viewport.to=-10;expect(h.controller.getVisibleAnalysisTimeRange()).toBeUndefined();
});

it('manual copy and restore disclose persistence failure while keeping editable memory state',()=>{
  const h=harness();vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{throw Error('quota');}});
  const ids=h.controller.copyObservationToDrawing('analysis',id,sourceId);
  expect(ids.length).toBeGreaterThan(0);expect(h.drawing.document.drawings).toHaveLength(1);
  expect(h.controller.analysisPersistenceWarning()).toContain('无法保存');
  expect(h.controller.analysisPersistenceWarning()).toContain('存储失败');
  expect(h.controller.restoreObservation('analysis',id,sourceId)).toContain('存储失败');
  expect(h.controller.getAnalysisRows().some((r:{visible:boolean})=>r.visible)).toBe(true);
});

it('deleting all manual shapes restores automatic output even when the empty source group remains',()=>{
  const h=harness(),ids=h.controller.copyObservationToDrawing('analysis',id,sourceId);
  h.drawing.removeLayers(ids.slice(1));
  expect(h.drawing.document.layers.some(layer=>layer.id===ids[0])).toBe(true);
  expect(h.drawing.document.drawings).toHaveLength(0);
  expect(h.controller.getAnalysisRows().some((r:{visible:boolean})=>r.visible)).toBe(true);
  h.drawing.undo();expect(h.controller.getAnalysisRows().some((r:{visible:boolean})=>r.visible)).toBe(false);
});
