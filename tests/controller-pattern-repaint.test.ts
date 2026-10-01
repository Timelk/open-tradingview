import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ChartController,initialState} from '../src/lib/chart/controller';
import {ColumnStore} from '../src/lib/core/datastore';
import {Viewport} from '../src/lib/core/viewport';
import {Pyramid} from '../src/lib/core/pyramid';
import {PaneLayout} from '../src/lib/core/pane-layout';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {IndicatorEngine} from '../src/lib/indicators/engine';
import {RangeMotion} from '../src/lib/interaction/range-motion';
import {LiveBarMotion} from '../src/lib/interaction/live-bar-motion';
import {emptyScene,layerOf} from '../src/lib/scene/types';
import type {DerivedSeries} from '../src/lib/core/types';
import type {PatternCandidate,PatternMatch} from '../src/lib/patterns/types';
import type {OutMsg} from '../src/lib/indicators/worker';

class TestWorker{
  static current:TestWorker;onmessage:((event:{data:OutMsg})=>void)|null=null;
  constructor(){TestWorker.current=this;}postMessage(){}terminate(){}
  deliver(data:OutMsg){this.onmessage?.({data});}
}
const minute=60_000;
const point=(label:string,index:number,value:number)=>({label,time:index*minute,value});
const candidate:PatternCandidate={id:'developing',family:'huzi-triangle',name:'三角形',direction:'neutral',observedAt:63*minute,availableAt:43*minute,
  points:[point('A',10,110),point('B',20,90),point('C',30,110),point('D',40,98)],
  guides:[{role:'upper',points:[point('',10,110),point('',63,110)]},{role:'lower',points:[point('',10,86),point('',63,107)]}],
  ratios:[],description:'Observed fixture'};
const confirmed:PatternMatch={id:'confirmed',family:'huzi-triangle',name:'三角形',direction:'bullish',confirmedAt:63*minute,
  points:[...candidate.points,point('E',50,110)],guides:candidate.guides,zone:{low:109,high:111},invalidation:95,targets:[130],
  ratios:[],description:'Confirmed fixture',status:'confirmed'};
const cleanup:Array<()=>void>=[];
beforeEach(()=>{vi.stubGlobal('window',{devicePixelRatio:1});vi.stubGlobal('Worker',TestWorker);vi.stubGlobal('requestAnimationFrame',vi.fn(()=>1));});
afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());vi.unstubAllGlobals();});
function harness(){
  const store=new ColumnStore(128);for(let i=0;i<64;i++)store.appendBar({time:i*minute,open:100,high:112,low:88,close:100,volume:1});
  const registry=new IndicatorRegistry();registerBuiltins(registry);
  const doc=emptyScene();doc.indicators=[{id:'pattern-huzi',instanceId:'shape',params:{historyDisplay:'active'},timeframe:'chart',hiddenPlots:[]}];
  doc.layers=[layerOf('series:candles','series','K线'),layerOf('shape','indicator','胡子形态')];
  const ctx=new Proxy({globalAlpha:1,canvas:{width:888,height:426}} as Record<string,unknown>,{get(target,key){if(key in target)return target[String(key)];if(key==='measureText')return (s:string)=>({width:s.length*7});if(key==='getTransform')return ()=>({d:1});return ()=>{};}}) as unknown as CanvasRenderingContext2D;
  const renderer={begin:vi.fn(),setOpacity:vi.fn(),canvasLayer:vi.fn((paint:(ctx:CanvasRenderingContext2D)=>void)=>paint(ctx)),clip:vi.fn(),rect:vi.fn(),seg:vi.fn(),marker:vi.fn(),flush:vi.fn()};
  const engine=new IndicatorEngine(registry),viewport=new Viewport(store.length,{from:0,to:64,plotW:800,plotH:400});
  const controller=Object.assign(Object.create(ChartController.prototype),{
    registry,engine,store,viewport,pyramid:new Pyramid(store),paneLayout:new PaneLayout(),renderer,ctx,axisContext:ctx,
    drawing:{document:doc,paintLayers:doc.layers,effective:()=>({visible:true,locked:false,opacity:1,reason:''}),allHidden:false,hasGesture:false},
    state:{...initialState,source:'mock',interval:'1m',loading:false,smoothMotion:false},
    width:888,height:426,dpr:1,dead:false,dirty:false,overlayDirty:false,resizePending:false,
    drag:null,pointer:null,pendingPointer:null,viewportMotion:new RangeMotion({min:0,max:64}),liveBarMotion:new LiveBarMotion(),rangeMoving:false,
    panes:[],manualScales:new Map(),emptyPaneRanges:new Map(),fitEmptyPanes:new Set(),autoRanges:new Map(),projectionCache:new Map(),studyMarkers:new Map(),markerIndices:new Map(),
    maximizedPane:null,overlays:[],generation:0,patternWindowPending:false,patternWindowQueued:'',
    reqs:[{id:'pattern-huzi',instanceId:'shape',params:{},timeframe:'chart'}],syncedDocument:doc,drawingRevision:0,dataRevision:0,
    fpsStart:0,fpsFrames:0,lastPublish:0,frameTimes:[],fullFrameTimes:[],inputLatencies:[],presentedFrames:0,inputStarted:null,
    publish:vi.fn(),syncPaneControls:vi.fn(),drawOverlay:vi.fn(),
  });
  controller.patternWindow=controller.desiredPatternWindow();
  const req={id:'pattern-huzi',instanceId:'shape',params:{},patternWindow:controller.patternWindow};
  engine.onUpdate=range=>controller.onIndicatorUpdate(range);engine.init(store,[req]);
  const series:DerivedSeries[]=['看涨形态','看跌形态','观察中结构'].map((name,plotIndex)=>({
    name,plotIndex,indicatorId:'shape',plot:'patterns',pane:'main',color:'#98b7d8',values:new Float64Array(64).fill(NaN),
    ...(plotIndex<2?{patterns:[]}:{candidates:[candidate]}),
  }));
  cleanup.push(()=>engine.destroy());let frame=0;
  return {controller,engine,renderer,series,worker:TestWorker.current,req,tick:()=>controller.frame(++frame*16)};
}

describe('worker results repaint without chart gestures',()=>{
  it('paints the initial asynchronous candidate on the next frame and then stays idle',()=>{
    const h=harness();h.tick();expect(h.renderer.begin).not.toHaveBeenCalled();
    h.worker.deliver({type:'full',tick:0,length:64,series:h.series});
    expect(h.controller.dirty).toBe(true);h.tick();
    expect(h.controller.candidateHits.map((hit:{candidate:PatternCandidate})=>hit.candidate.id)).toEqual(['developing']);
    expect(h.renderer.begin).toHaveBeenCalledTimes(1);expect(h.controller.drawOverlay).toHaveBeenCalledTimes(1);
    h.tick();h.tick();expect(h.renderer.begin).toHaveBeenCalledTimes(1);
    expect([h.controller.viewport.from,h.controller.viewport.to]).toEqual([0,64]);
  });

  it('withdraws a candidate and shows a newly confirmed shape from tail metadata without zoom or pointer input',()=>{
    const h=harness();h.worker.deliver({type:'full',tick:0,length:64,series:h.series});h.tick();
    h.worker.deliver({type:'tail',tick:1,length:64,patches:[
      {...h.series[0],patterns:[confirmed],start:63,values:Float64Array.of(NaN)},
      {...h.series[2],candidates:[],start:63,values:Float64Array.of(NaN)},
    ]});h.tick();
    expect(h.controller.candidateHits).toEqual([]);
    expect(h.controller.patternHits.map((hit:{pattern:PatternMatch})=>hit.pattern.id)).toEqual(['confirmed']);
    expect(h.controller.getPatternRows().map((row:{pattern:PatternMatch})=>row.pattern.id)).toEqual(['confirmed']);
    expect(h.renderer.begin).toHaveBeenCalledTimes(2);h.tick();expect(h.renderer.begin).toHaveBeenCalledTimes(2);
  });

  it('repaints a metadata-only viewport reply and clears pending state on an otherwise idle chart',()=>{
    const h=harness();h.worker.deliver({type:'full',tick:0,length:64,series:h.series});h.tick();
    h.engine.setReqs([{...h.req,patternWindow:{fromTime:0,toTime:80*minute}}]);h.controller.patternWindowPending=true;
    h.worker.deliver({type:'patterns',tick:1,length:64,patches:[{name:h.series[0].name,indicatorId:'shape',plotIndex:0,patterns:[confirmed]}]});
    expect(h.controller.state.indicatorsPending).toBe(false);expect(h.controller.patternWindowPending).toBe(false);h.tick();
    expect(h.controller.patternHits.map((hit:{pattern:PatternMatch})=>hit.pattern.id)).toEqual(['confirmed']);
    expect(h.renderer.begin).toHaveBeenCalledTimes(2);h.tick();expect(h.renderer.begin).toHaveBeenCalledTimes(2);
  });
});
