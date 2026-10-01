import {DEFAULT_APPEARANCE} from '../src/lib/chart/appearance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartController, initialState } from '../src/lib/chart/controller';
import { ColumnStore } from '../src/lib/core/datastore';
import { Pyramid } from '../src/lib/core/pyramid';
import { Viewport } from '../src/lib/core/viewport';
import { PaneLayout } from '../src/lib/core/pane-layout';
import { LiveBarMotion } from '../src/lib/interaction/live-bar-motion';
import { IndicatorRegistry, registerBuiltins } from '../src/lib/indicators/registry';
import { DrawingEngine } from '../src/lib/drawing/engine';
import { ToolRegistry } from '../src/lib/drawing/registry';
import { registerDrawingBuiltins } from '../src/lib/drawing/builtins';
import { DEFAULT_STYLE } from '../src/lib/drawing/types';
import { emptyScene, layerOf, type SceneDocument } from '../src/lib/scene/types';
import type {DerivedSeries,OverlayPlot} from '../src/lib/core/types';

vi.mock('../src/lib/render/axes',async original=>({...await original<typeof import('../src/lib/render/axes')>(),drawAxesBase:vi.fn()}));

const cleanup:(()=>void)[]=[];
beforeEach(()=>{const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)});});
afterEach(()=>{cleanup.splice(0).forEach(close=>close());vi.unstubAllGlobals();});
function scene(withDrawing=false):SceneDocument {
  const doc=emptyScene();doc.layers=[layerOf('series:candles','series','K线'),layerOf('macd','indicator','MACD','macd')];
  doc.indicators=[{instanceId:'macd',id:'macd',params:{fast:12,slow:26,signal:9},timeframe:'chart',hiddenPlots:[]}];
  if(withDrawing){doc.layers.push(layerOf('line','drawing','Trend','macd'));doc.drawings.push({id:'line',toolId:'trend-line',paneId:'macd',points:[{time:20*60000,value:20},{time:40*60000,value:80}],style:{...DEFAULT_STYLE},props:{},locked:false,hidden:false});}
  return doc;
}
function harness(doc=scene()){
  const store=new ColumnStore();for(let i=0;i<100;i++)store.appendBar({time:i*60000,open:100,high:110,low:90,close:100,volume:10});
  const registry=new IndicatorRegistry();registerBuiltins(registry);const tools=new ToolRegistry();registerDrawingBuiltins(tools);
  const renderer={begin:vi.fn(),setOpacity:vi.fn(),canvasLayer:vi.fn(),clip:vi.fn(),rect:vi.fn(),seg:vi.fn(),marker:vi.fn(),flush:vi.fn()};
  const calculations={derived:[] as DerivedSeries[],setReqs:vi.fn(),pending:false};
  const controller=Object.assign(Object.create(ChartController.prototype),{
    registry,store,pyramid:new Pyramid(store),viewport:new Viewport(100,{from:0,to:100,plotW:1000,plotH:600}),paneLayout:new PaneLayout(),
    renderer,engine:calculations,state:{...initialState,loading:false,smoothMotion:false},width:1088,height:626,
    panes:[],manualScales:new Map(),emptyPaneRanges:new Map(),fitEmptyPanes:new Set(),autoRanges:new Map(),projectionCache:new Map(),
    maximizedPane:null,drag:null,liveBarMotion:new LiveBarMotion(),generation:0,overlays:[],markerIndices:new Map(),studyMarkers:new Map(),
    externalOverlays:[],dataRevision:0,
    ctx:{},axisContext:{clearRect:vi.fn()},syncPaneControls:vi.fn(),publish:vi.fn(),
    reqs:[],syncedDocument:null,syncedInterval:'',calculationSignature:'',drawingRevision:0,
    sceneLookupDocument:null,layerLookup:new Map(),instanceLookup:new Map(),
  });
  const drawing=new DrawingEngine(tools,{
    paneAt:p=>controller.panes.find((pane:{top:number;height:number})=>p.y>=pane.top&&p.y<pane.top+pane.height)?.id??null,
    projection:id=>controller.drawingProjection(id),anchorAt:(p,id,snap)=>controller.drawingAnchor(p,id,snap),zoomTo:()=>{},
  },()=>{controller.dirty=true;},()=>doc);
  controller.drawing=drawing;drawing.setMarket('mock:STUDIES');const unsubscribe=drawing.subscribe(()=>controller.syncScene());calculations.setReqs.mockClear();
  const draw=()=>controller.draw();const pane=(id='macd')=>controller.panes.find((p:{id:string})=>p.id===id) as {id:string;top:number;height:number;min:number;max:number}|undefined;
  const line=():DerivedSeries=>({name:'DIF',values:Float64Array.from({length:100},(_,i)=>i-50),color:'#f5c518',pane:'sub',plot:'line',indicatorId:'macd',plotIndex:0});
  cleanup.push(()=>{unsubscribe();drawing.destroy();});return {controller,drawing,calculations,renderer,registry,draw,pane,line};
}

describe('empty study pane ranges and hidden pane recovery',()=>{
  it('keeps an empty pane range fixed when a drawing is moved and committed, preserving the new screen position',()=>{
    const h=harness(scene(true));h.draw();const before={...h.pane()!},projection=h.controller.drawingProjection('macd');
    const origin=projection.project({time:30*60000,value:50}),dy=-10/(before.max-before.min)*before.height;
    h.drawing.selectDrawing('line');expect(h.drawing.pointerDown(origin,'macd')).toBe(true);
    h.drawing.pointerMove({x:origin.x,y:origin.y+dy});h.draw();h.drawing.pointerUp({x:origin.x,y:origin.y+dy});h.draw();
    expect(h.drawing.document.drawings[0].points[0].value).toBeCloseTo(30);expect(h.drawing.document.drawings[0].points[1].value).toBeCloseTo(90);
    expect(h.pane()!.min).toBe(before.min);expect(h.pane()!.max).toBe(before.max);
    expect(h.controller.drawingProjection('macd').project({time:30*60000,value:60}).y).toBeCloseTo(origin.y+dy);
    h.drawing.undo();h.draw();expect(h.drawing.document.drawings[0].points[0].value).toBe(20);expect(h.drawing.state.canUndo).toBe(false);
  });
  it('explicit reset discards both manual and cached ranges and refits the current drawing anchors',()=>{
    const h=harness(scene(true));h.draw();h.drawing.selectDrawing('line');h.drawing.updateSelected({points:[{time:20*60000,value:70},{time:40*60000,value:130}]});
    h.controller.manualScales.set('macd',{min:0,max:200});h.draw();expect(h.pane()!.min).toBe(0);
    h.controller.resetPaneScale('macd');h.draw();expect(h.controller.manualScales.has('macd')).toBe(false);
    expect(h.pane()!.min).toBeCloseTo(65.2);expect(h.pane()!.max).toBeCloseTo(134.8);expect(h.controller.fitEmptyPanes.has('macd')).toBe(false);
    h.draw();expect(h.pane()!.min).toBeCloseTo(65.2);
  });
  it('retains a hidden maximized study pane and its scale, then restores data without recomputing the study',()=>{
    const h=harness();h.calculations.derived=[h.line()];h.draw();const before={...h.pane()!};h.controller.maximizedPane='macd';
    h.controller.toggleIndicator('macd',false);h.draw();expect(h.controller.layerStatus('macd').visible).toBe(false);expect(h.pane()).toBeDefined();expect(h.controller.maximizedPane).toBe('macd');
    expect(h.pane()!.min).toBe(before.min);expect(h.pane()!.max).toBe(before.max);
    h.controller.toggleIndicator('macd',true);h.draw();expect(h.controller.layerStatus('macd').visible).toBe(true);expect(h.pane()).toBeDefined();expect(h.calculations.setReqs).not.toHaveBeenCalled();
    h.drawing.removeLayers(['macd']);h.draw();expect(h.pane()).toBeUndefined();expect(h.controller.maximizedPane).toBeNull();
  });
  it('clears the empty range cache when real study data returns, then preserves the newly valid range on hide',()=>{
    const h=harness(scene(true));h.draw();const empty={...h.pane()!};h.calculations.derived=[h.line()];h.draw();const populated={...h.pane()!};
    expect(populated.min).not.toBe(empty.min);expect(h.controller.emptyPaneRanges.has('macd')).toBe(false);
    h.controller.toggleIndicator('macd',false);h.draw();expect(h.pane()!.min).toBe(populated.min);expect(h.pane()!.max).toBe(populated.max);
  });
});

describe('external overlay ownership at the renderer boundary',()=>{
  function plots(owner:string,color:string):OverlayPlot[]{
    return [{id:`${owner}:line`,name:`${owner} curve`,kind:'line',pane:'main',color,values:Float64Array.from({length:100},(_,i)=>100+i/100)},
      {id:`${owner}:signal`,name:`${owner} observation`,kind:'markers',pane:'main',color,values:new Float64Array(),
        markers:[{index:50,time:50*60000,value:100,side:'sell'}]}];
  }
  it('removes only one producer and leaves indicators and the other producer rendered',()=>{
    const h=harness();h.calculations.derived=[h.line()];
    h.controller.setOverlayGroup('first',plots('first','#0000ff'));
    h.controller.setOverlayGroup('second',plots('second','#ff00ff'));h.draw();
    expect(h.controller.markerLayouts).toHaveLength(2);
    h.renderer.seg.mockClear();h.controller.setOverlayGroup('first',[]);h.draw();
    expect(h.renderer.seg.mock.calls.some(call=>call[4]==='#0000ff')).toBe(false);
    expect(h.renderer.seg.mock.calls.some(call=>call[4]==='#ff00ff')).toBe(true);
    expect(h.controller.markerLayouts).toHaveLength(1);
    expect(h.controller.markerLayouts[0].candidate).toMatchObject({sourceLayerId:'second:signal',kind:'signal'});
    expect(h.drawing.document.layers.some(layer=>layer.id.startsWith('first:'))).toBe(false);
    h.renderer.canvasLayer.mockClear();h.controller.setOverlayGroup('second',[]);h.draw();
    expect(h.controller.markerLayouts).toEqual([]);expect(h.controller.shapeLayouts).toEqual([]);
    expect(h.renderer.begin).toHaveBeenLastCalledWith(DEFAULT_APPEARANCE.background,false,false);
    expect(h.renderer.canvasLayer).not.toHaveBeenCalled();
    expect(h.drawing.document.indicators.map(indicator=>indicator.id)).toEqual(['macd']);
  });
  it('keeps unrelated saved layers when an external producer publishes or removes its session output',()=>{
    const doc=scene();doc.layers.push(layerOf('saved-observation','overlay','Saved research','main'));
    const h=harness(doc);h.controller.setOverlayGroup('first',plots('first','#0000ff'));
    h.controller.setOverlayGroup('first',[]);
    expect(h.drawing.document.layers.some(layer=>layer.id==='saved-observation')).toBe(true);
  });
});

describe('study creation API',()=>{
  it('returns independent instance IDs, selects the created study and records each addition once',()=>{
    const h=harness(),before=structuredClone(h.drawing.document);const first=h.controller.addIndicator('ma'),second=h.controller.addIndicator('ma');
    expect(first).toEqual(expect.any(String));expect(second).toEqual(expect.any(String));expect(second).not.toBe(first);
    expect(h.drawing.state.scene.selectedIds).toEqual([second]);expect(h.drawing.document.indicators.filter(i=>i.id==='ma')).toHaveLength(2);
    h.drawing.undo();expect(h.drawing.document.indicators.some(i=>i.instanceId===second)).toBe(false);expect(h.drawing.document.indicators.some(i=>i.instanceId===first)).toBe(true);
    h.drawing.undo();expect(h.drawing.document).toEqual(before);expect(h.drawing.state.canUndo).toBe(false);
  });
  it('returns null for unavailable/loading/invalid requests and failed transactions without adding partial layers',()=>{
    const h=harness(),before=structuredClone(h.drawing.document);expect(h.controller.addIndicator('missing')).toBeNull();expect(h.controller.addIndicator('ma','invalid')).toBeNull();
    h.controller.state.loading=true;expect(h.controller.addIndicator('ma')).toBeNull();h.controller.state.loading=false;
    h.registry.register({id:'broken-volume',name:'Broken',target:'volume',inputs:[{key:'period',label:'Period',type:'int',def:NaN}],calc:()=>[]});
    expect(h.controller.addIndicator('broken-volume')).toBeNull();expect(h.drawing.document).toEqual(before);expect(h.drawing.state.canUndo).toBe(false);expect(h.calculations.setReqs).not.toHaveBeenCalled();
  });
});

describe('study style APIs',()=>{
  it('updates the rendered color/width without mutating derived data or rerunning calculations',()=>{
    const h=harness(),line=h.line();h.calculations.derived=[line];h.controller.setIndicatorPlotStyle('macd',0,{color:'#abcdef',width:3});h.draw();
    expect(h.renderer.seg.mock.calls.some(call=>call[4]==='#abcdef'&&call[6]===3)).toBe(true);expect(line.color).toBe('#f5c518');expect(h.calculations.derived[0]).toBe(line);expect(h.calculations.setReqs).not.toHaveBeenCalled();
    h.renderer.seg.mockClear();h.controller.toggleIndicatorPlot('macd',0);h.draw();expect(h.renderer.seg.mock.calls.some(call=>call[4]==='#abcdef')).toBe(false);
    h.drawing.undo();expect(h.drawing.document.indicators[0].hiddenPlots).toEqual([]);expect(h.drawing.document.indicators[0].plotStyles?.['0']).toEqual({color:'#abcdef',width:3});
    h.drawing.undo();expect(h.drawing.document.indicators[0].plotStyles).toBeUndefined();expect(h.drawing.state.canUndo).toBe(false);
  });
  it('respects an inherited group lock for style and per-output visibility changes',()=>{
    const doc=scene();doc.layers.push(layerOf('group','group','Locked','macd',{locked:true}));doc.layers.find(l=>l.id==='macd')!.parentId='group';
    const h=harness(doc),before=structuredClone(h.drawing.document);h.controller.setIndicatorPlotStyle('macd',0,{color:'#abcdef',width:3});h.controller.toggleIndicatorPlot('macd',0);
    expect(h.drawing.document).toEqual(before);expect(h.drawing.state.canUndo).toBe(false);expect(h.calculations.setReqs).not.toHaveBeenCalled();
  });
  it('ignores invalid styles and plot indexes without clearing existing redo history',()=>{
    const h=harness();h.controller.setIndicatorPlotStyle('macd',0,{width:2});h.drawing.undo();const before=structuredClone(h.drawing.document);
    for(const index of [-1,64,.5,NaN]){h.controller.setIndicatorPlotStyle('macd',index,{width:3});h.controller.toggleIndicatorPlot('macd',index);}
    for(const width of [0,9,NaN,Infinity])h.controller.setIndicatorPlotStyle('macd',0,{width});
    for(const color of ['red','#abc','#gggggg'])h.controller.setIndicatorPlotStyle('macd',0,{color});
    h.controller.setIndicatorPlotStyle('missing',0,{width:3});expect(h.drawing.document).toEqual(before);expect(h.drawing.state.canUndo).toBe(false);expect(h.drawing.state.canRedo).toBe(true);
    h.drawing.redo();expect(h.drawing.document.indicators[0].plotStyles).toEqual({'0':{width:2}});
  });
  it('uses the property session for combined color/width/visibility preview, cancel and a single confirmed undo',()=>{
    const h=harness();h.drawing.selectLayers(['macd']);const before=structuredClone(h.drawing.document),cancel=h.drawing.beginPropertyEdit(['macd']);
    h.controller.setIndicatorPlotStyle('macd',0,{color:'#abcdef'});h.controller.toggleIndicatorPlot('macd',1);cancel.cancel();expect(h.drawing.document).toEqual(before);
    const confirm=h.drawing.beginPropertyEdit(['macd']);h.controller.setIndicatorPlotStyle('macd',0,{color:'#abcdef'});h.controller.setIndicatorPlotStyle('macd',0,{width:4});h.controller.toggleIndicatorPlot('macd',1);confirm.commit();
    expect(h.drawing.document.indicators[0].plotStyles).toEqual({'0':{color:'#abcdef',width:4}});expect(h.drawing.document.indicators[0].hiddenPlots).toEqual([1]);
    h.drawing.undo();expect(h.drawing.document).toEqual(before);expect(h.drawing.state.canUndo).toBe(false);expect(h.calculations.setReqs).not.toHaveBeenCalled();
  });
});
