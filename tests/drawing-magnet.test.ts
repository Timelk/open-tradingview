import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { ChartController,initialState } from '../src/lib/chart/controller';
import { ColumnStore } from '../src/lib/core/datastore';
import { Viewport } from '../src/lib/core/viewport';
import { RangeMotion } from '../src/lib/interaction/range-motion';
import { IndicatorRegistry,registerBuiltins } from '../src/lib/indicators/registry';
import { DrawingEngine } from '../src/lib/drawing/engine';
import { ToolRegistry } from '../src/lib/drawing/registry';
import { registerDrawingBuiltins } from '../src/lib/drawing/builtins';
import { emptyScene,layerOf } from '../src/lib/scene/types';
import type { Pixel } from '../src/lib/drawing/types';

class Surface extends EventTarget {
  style={cursor:''};title='';focus=vi.fn();closest=()=>null;querySelector=()=>null;contains=(target:unknown)=>target===this;
  classList={add:vi.fn(),remove:vi.fn()};captured=new Set<number>();
  getBoundingClientRect=()=>({left:30,top:50});
  setPointerCapture=(id:number)=>{this.captured.add(id);};hasPointerCapture=(id:number)=>this.captured.has(id);
  releasePointerCapture:(id:number)=>void=id=>{this.captured.delete(id);};
}
const cleanup:(()=>void)[]=[];
beforeEach(()=>{
  const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)});
  vi.stubGlobal('Element',Surface);vi.stubGlobal('Node',Surface);
});
afterEach(()=>{cleanup.splice(0).forEach(close=>close());vi.unstubAllGlobals();});
function harness(){
  const page=new EventTarget(),dom=Object.assign(new EventTarget(),{hidden:false}),host=new Surface(),outside=new Surface();
  vi.stubGlobal('window',page);vi.stubGlobal('document',dom);
  const store=new ColumnStore();for(let i=0;i<10;i++)store.appendBar({time:i*60000,open:100,high:140,low:60,close:120,volume:10});
  const registry=new IndicatorRegistry();registerBuiltins(registry);const tools=new ToolRegistry();registerDrawingBuiltins(tools);
  const ctx={canvas:{height:626},getTransform:()=>({d:1}),save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),setLineDash:vi.fn(),arc:vi.fn(),fill:vi.fn(),stroke:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),clearRect:vi.fn(),measureText:(text:string)=>({width:text.length*6})};
  const controller=Object.assign(Object.create(ChartController.prototype),{
    host,store,registry,viewport:new Viewport(10,{from:0,to:12,plotW:960,plotH:600}),viewportMotion:new RangeMotion({min:0,max:12}),
    width:1048,height:626,panes:[{id:'main',top:0,height:400,min:0,max:200,series:[]},{id:'rsi',top:400,height:200,min:0,max:100,series:[]}],
    state:{...initialState,loading:false,visible:10},manualScales:new Map(),paneControls:new Surface(),projectionCache:new Map(),generation:0,
    sceneLookupDocument:null,layerLookup:new Map(),instanceLookup:new Map(),overlays:[],events:new AbortController(),
    drag:null,pendingPointer:null,magnetPointer:null,magnetGuide:null,pointer:null,inputStarted:null,ctx,publish:vi.fn(),onDrawingSelection:vi.fn(),onOpenProperties:vi.fn(),
    axes:{ctx,plotW:960,plotH:600,axisW:88,axisH:26,paneTicks:[],xTicks:[],crosshair:null,hoverDot:null,lastPrice:null},
  });
  const defaults=()=>{const doc=emptyScene();doc.layers.push(layerOf('series:candles','series','K线'));return doc;};
  const drawing=new DrawingEngine(tools,{paneAt:p=>p.y<400?'main':'rsi',projection:id=>controller.drawingProjection(id),anchorAt:(p,id,snap,strength)=>controller.drawingAnchor(p,id,snap,strength),zoomTo:()=>{}},()=>{controller.dirty=true;controller.overlayDirty=true;},defaults);
  controller.drawing=drawing;drawing.setMarket('mock:MAGNET');const off=drawing.subscribe(()=>controller.refreshMagnetFeedback());controller.bindEvents();
  let modifiers={ctrlKey:false,metaKey:false};
  function route(type:string,target:EventTarget,properties:Record<string,unknown>={}){
    const event=Object.assign(new Event(type,{bubbles:true,cancelable:true}),properties);Object.defineProperty(event,'target',{value:target});
    page.dispatchEvent(event);if(target!==page)target.dispatchEvent(event);return event;
  }
  function pointer(type:string,p:Pixel,target:EventTarget=host,extra:Record<string,unknown>={}){
    return route(type,target,{...modifiers,pointerId:1,pointerType:'mouse',button:0,buttons:type==='pointerup'||type==='pointercancel'?0:1,clientX:p.x+30,clientY:p.y+50,...extra});
  }
  function key(type:'keydown'|'keyup',name:string,extra:Record<string,unknown>={}){
    if(name==='Meta')modifiers.metaKey=type==='keydown';if(name==='Control')modifiers.ctrlKey=type==='keydown';
    return route(type,host,{...modifiers,key:name,code:name,shiftKey:false,altKey:false,...extra});
  }
  host.releasePointerCapture=vi.fn((id:number)=>{if(host.captured.delete(id))route('lostpointercapture',host,{pointerId:id});});
  const hover=(p:Pixel)=>{pointer('pointermove',p);controller.flushPointer();};
  function create(){drawing.selectTool('trend-line');pointer('pointerdown',{x:160,y:240});pointer('pointermove',{x:320,y:120});pointer('pointerup',{x:320,y:120});return drawing.state.selected!.id;}
  function endpoint(id:string):Pixel{ctx.lineTo.mockClear();drawing.renderObject(ctx as unknown as CanvasRenderingContext2D,id);const point=ctx.lineTo.mock.calls[0];return {x:point[0],y:point[1]};}
  cleanup.push(()=>{controller.events.abort();off();drawing.destroy();});
  return {controller,drawing,page,dom,host,outside,ctx,pointer,key,hover,create,endpoint,route};
}

describe('OHLC magnet strengths and visible guidance',()=>{
  it('shows all four OHLC candidates and highlights each nearest actual price under strong mode',()=>{
    const h=harness();h.drawing.setMagnetMode('strong');
    for(const [y,field,value] of [[204,'open',100],[117,'high',140],[285,'low',60],[165,'close',120]] as const){
      h.hover({x:407,y});const guide=h.controller.magnetFeedback;
      expect(guide.points.map((p:{field:string})=>p.field)).toEqual(['open','high','low','close']);expect(guide.target.field).toBe(field);expect(guide.target.anchor).toEqual({time:300000,value});expect(guide.target.pixel.x).toBe(400);
    }
  });
  it('keeps the existing weak 14px threshold while strong mode follows the hovered candle cell',()=>{
    const h=harness();h.drawing.setMagnetMode('weak');h.hover({x:407,y:174});expect(h.controller.magnetFeedback.target.field).toBe('close');
    h.hover({x:407,y:175});expect(h.controller.magnetFeedback.target).toBeNull();expect(h.controller.magnetFeedback.points).toHaveLength(4);
    h.hover({x:415,y:160});expect(h.controller.magnetFeedback.target).toBeNull();h.drawing.setMagnetMode('strong');h.hover({x:439,y:210});expect(h.controller.magnetFeedback.index).toBe(5);
    h.hover({x:441,y:210});expect(h.controller.magnetFeedback.index).toBe(6);
  });
  it('does not snap to future blank space, another pane, or a hidden candle series',()=>{
    const h=harness();h.drawing.setMagnetMode('strong');
    for(const p of [{x:760,y:210},{x:800,y:210},{x:-1,y:210},{x:400,y:450}]){h.hover(p);expect(h.controller.magnetFeedback).toBeNull();}
    h.hover({x:400,y:175});expect(h.controller.magnetFeedback.target).not.toBeNull();h.drawing.updateLayers(['series:candles'],{visible:false});expect(h.controller.magnetFeedback).toBeNull();
  });
  it.each(['Meta','Control'] as const)('%s changes pointer feedback and crosshair immediately without another mouse move',modifier=>{
    const h=harness();h.hover({x:407,y:175});expect(h.controller.magnetFeedback).toBeNull();h.controller.overlayDirty=false;
    const down=h.key('keydown',modifier);expect(down.defaultPrevented).toBe(false);expect(h.drawing.state.magnet).toBe(false);expect(h.drawing.state.effectiveMagnetStrength).toBe('strong');expect(h.controller.overlayDirty).toBe(true);
    expect(h.controller.magnetFeedback.target.anchor).toEqual({time:300000,value:120});h.controller.drawOverlay();
    expect(h.controller.axes.crosshair.y).toBe(160);expect(Number(h.controller.axes.crosshair.price.replace(/,/g,''))).toBe(120);
    expect(h.ctx.arc).toHaveBeenCalledWith(400,160,6,0,Math.PI*2);expect(h.ctx.fillText.mock.calls.some(call=>String(call[0]).includes('C · 强吸'))).toBe(true);
    h.key('keyup',modifier);expect(h.drawing.state.effectiveMagnet).toBe(false);expect(h.controller.magnetFeedback).toBeNull();h.controller.drawOverlay();expect(h.controller.axes.crosshair.y).toBe(175);
  });
  it('temporarily reverses permanent modes and restores their original strength',()=>{
    const h=harness();for(const mode of ['weak','strong'] as const){h.drawing.setMagnetMode(mode);h.hover({x:407,y:164});h.key('keydown','Meta');
      expect(h.drawing.state).toMatchObject({magnet:true,magnetStrength:mode,magnetModifier:true,effectiveMagnet:false});expect(h.controller.magnetFeedback).toBeNull();
      h.key('keyup','Meta');expect(h.drawing.state).toMatchObject({magnet:true,magnetStrength:mode,effectiveMagnet:true,effectiveMagnetStrength:mode});expect(h.controller.magnetFeedback.target.field).toBe('close');}
  });
  it('keeps temporary mode while either modifier remains held and does not intercept copy or menu keys',()=>{
    const h=harness();h.hover({x:407,y:175});h.key('keydown','Meta');h.key('keydown','Control');h.key('keyup','Meta');expect(h.drawing.state.effectiveMagnet).toBe(true);
    expect(h.key('keydown','c',{code:'KeyC'}).defaultPrevented).toBe(false);h.key('keyup','Control');expect(h.drawing.state.effectiveMagnet).toBe(false);
    expect(h.key('keydown','F10',{shiftKey:true}).defaultPrevented).toBe(false);expect(h.key('keydown','ContextMenu').defaultPrevented).toBe(false);
  });
  it('keeps the selected permanent strength when its toggle is off, and lets modifier override it temporarily',()=>{
    const h=harness();h.drawing.setMagnetStrength('weak');h.hover({x:407,y:175});h.key('keydown','Meta');
    expect(h.drawing.state).toMatchObject({magnet:false,magnetStrength:'weak',effectiveMagnet:true,effectiveMagnetStrength:'strong'});
    h.key('keyup','Meta');h.drawing.setMagnetStrength('strong');expect(h.drawing.state.effectiveMagnet).toBe(false);h.drawing.setOption('magnet',true);
    expect(h.drawing.state).toMatchObject({magnet:true,magnetStrength:'strong',effectiveMagnetStrength:'strong'});expect(h.drawing.state.canUndo).toBe(false);
  });
  it('restores permanent weak snapping after visibility changes without leaving stale hover feedback',()=>{
    const h=harness();h.drawing.setMagnetMode('weak');h.hover({x:407,y:164});h.key('keydown','Control');expect(h.drawing.state.effectiveMagnet).toBe(false);
    h.dom.hidden=true;h.dom.dispatchEvent(new Event('visibilitychange'));expect(h.drawing.state).toMatchObject({magnet:true,magnetStrength:'weak',magnetModifier:false,effectiveMagnet:true});expect(h.controller.magnetFeedback).toBeNull();
    h.key('keyup','Control');h.dom.hidden=false;h.dom.dispatchEvent(new Event('visibilitychange'));h.hover({x:407,y:164});expect(h.controller.magnetFeedback.strength).toBe('weak');expect(h.controller.magnetFeedback.target.field).toBe('close');
  });
});

describe('magnet changes do not break drawing transactions',()=>{
  it('updates an active endpoint on modifier down/up, then commits exactly one snapped edit',()=>{
    const h=harness(),id=h.create(),original=structuredClone(h.drawing.document.drawings[0]);h.pointer('pointerdown',{x:320,y:120});h.pointer('pointermove',{x:407,y:175});
    expect(h.endpoint(id)).toEqual({x:407,y:175});h.key('keydown','Meta');expect(h.endpoint(id)).toEqual({x:400,y:160});expect(h.drawing.document.drawings[0]).toEqual(original);
    h.key('keyup','Meta');expect(h.endpoint(id)).toEqual({x:407,y:175});h.key('keydown','Meta');h.pointer('pointerup',{x:407,y:175},h.outside);h.key('keyup','Meta');
    expect(h.drawing.document.drawings[0].points[1]).toEqual({time:300000,value:120});h.drawing.undo();expect(h.drawing.document.drawings[0]).toEqual(original);h.drawing.undo();expect(h.drawing.document.drawings).toEqual([]);
  });
  it('snaps newly drawn endpoints under held modifiers without writing transient settings to the scene',()=>{
    const h=harness();h.drawing.selectTool('trend-line');h.key('keydown','Control');h.pointer('pointerdown',{x:407,y:220});h.pointer('pointermove',{x:487,y:175});h.pointer('pointerup',{x:487,y:175});h.key('keyup','Control');
    expect(h.drawing.document.drawings[0].points).toEqual([{time:300000,value:100},{time:360000,value:120}]);expect(h.drawing.document).not.toHaveProperty('magnetModifier');expect(h.drawing.state.magnet).toBe(false);
    h.drawing.undo();expect(h.drawing.document.drawings).toEqual([]);
  });
  it('keeps whole-object movement free so temporary snapping cannot distort or jump the shape',()=>{
    const h=harness();h.create();h.key('keydown','Control');h.pointer('pointerdown',{x:240,y:180});expect(h.drawing.canSnapPointer).toBe(false);
    h.pointer('pointermove',{x:280,y:190});expect(h.controller.magnetFeedback).toBeNull();h.pointer('pointerup',{x:280,y:190});h.key('keyup','Control');
    expect(h.drawing.document.drawings[0].points).toEqual([{time:150000,value:75},{time:270000,value:135}]);
  });
  it('retains Ctrl/Cmd undo and redo while modifier tracking is active',()=>{
    const h=harness();h.create();const original=structuredClone(h.drawing.document.drawings[0]);h.pointer('pointerdown',{x:320,y:120});h.pointer('pointermove',{x:407,y:175});h.key('keydown','Control');h.pointer('pointerup',{x:407,y:175});
    const edited=structuredClone(h.drawing.document.drawings[0]);expect(h.key('keydown','z',{code:'KeyZ'}).defaultPrevented).toBe(true);expect(h.drawing.document.drawings[0]).toEqual(original);
    h.key('keydown','z',{code:'KeyZ',shiftKey:true});expect(h.drawing.document.drawings[0]).toEqual(edited);h.key('keyup','Control');expect(h.drawing.state.magnetModifier).toBe(false);
  });
  it.each(['blur','hidden'] as const)('%s commits the displayed held-key endpoint, then restores permanent state and clears feedback',boundary=>{
    const h=harness();h.create();h.pointer('pointerdown',{x:320,y:120});h.pointer('pointermove',{x:407,y:175});h.key('keydown','Meta');
    if(boundary==='blur')h.route('blur',h.page);else{h.dom.hidden=true;h.dom.dispatchEvent(new Event('visibilitychange'));}
    expect(h.drawing.document.drawings[0].points[1]).toEqual({time:300000,value:120});expect(h.drawing.state).toMatchObject({magnet:false,magnetModifier:false,effectiveMagnet:false});expect(h.controller.magnetFeedback).toBeNull();expect(h.controller.drag).toBeNull();
    h.key('keyup','Meta');h.dom.hidden=false;h.dom.dispatchEvent(new Event('visibilitychange'));expect(h.drawing.state.effectiveMagnet).toBe(false);
  });
  it('cancels an edited preview for the menu without accidentally committing it or keeping snap feedback',()=>{
    const h=harness();h.create();const original=structuredClone(h.drawing.document.drawings[0]);h.pointer('pointerdown',{x:320,y:120});h.pointer('pointermove',{x:407,y:175});h.key('keydown','Meta');
    h.controller.cancelInteractionForMenu();expect(h.drawing.document.drawings[0]).toEqual(original);expect(h.controller.drag).toBeNull();expect(h.host.hasPointerCapture(1)).toBe(false);expect(h.controller.magnetFeedback).toBeNull();expect(h.controller.onDrawingSelection).toHaveBeenLastCalledWith(null);
    h.pointer('pointerup',{x:407,y:175},h.outside);expect(h.drawing.document.drawings[0]).toEqual(original);h.drawing.undo();expect(h.drawing.document.drawings).toEqual([]);
  });
});

describe('read-only context picking',()=>{
  it('picks visible objects only and never substitutes an old selection for a blank hit',()=>{
    const h=harness(),id=h.create();expect(h.controller.contextTargetAt({x:240,y:180})).toMatchObject({region:'plot',paneId:'main',drawingId:id});
    expect(h.controller.contextTargetAt({x:800,y:350}).drawingId).toBeNull();const picked=h.drawing.hitDrawing({x:240,y:180})!;picked.points[0].value=999;expect(h.drawing.document.drawings[0].points[0].value).toBe(80);
    h.drawing.setDrawingFlags(id,{hidden:true});expect(h.controller.contextTargetAt({x:240,y:180}).drawingId).toBeNull();
  });
  it('returns unsnapped anchors and distinguishes price/time/separator regions',()=>{
    const h=harness();h.drawing.setMagnetMode('strong');h.hover({x:407,y:175});const guide=h.controller.magnetFeedback;
    expect(h.controller.contextTargetAt({x:407,y:175}).anchor).toEqual({time:305250,value:112.5});expect(h.controller.magnetFeedback).toEqual(guide);
    expect(h.controller.contextTargetAt({x:970,y:210})).toMatchObject({region:'price',paneId:'main',drawingId:null,anchor:{value:95}});
    expect(h.controller.contextTargetAt({x:400,y:610})).toMatchObject({region:'time',paneId:'main',anchor:null});expect(h.controller.contextTargetAt({x:400,y:400})).toMatchObject({region:'separator',paneId:'main',anchor:null});expect(h.controller.contextTargetAt({x:-20,y:20})).toBeNull();
    h.controller.maximizedPane='main';expect(h.controller.maximizedPaneId).toBe('main');expect(h.controller.contextTargetAt({x:400,y:180}).maximized).toBe(true);
  });
  it('keeps crosshair price and projected time lines visible in the right-side projection zone, across pane separators, and in pointer tool mode',()=>{
    const h=harness();
    h.hover({x:800,y:200});h.controller.drawOverlay();
    expect(h.controller.axes.crosshair).toMatchObject({x:800,y:200,price:'100.00'});
    expect(h.controller.axes.crosshair.time).toContain(':10:00');
    expect(h.controller.axes.hoverDot).toBeNull();
    h.hover({x:958,y:200});h.controller.drawOverlay();
    expect(h.controller.axes.crosshair.x).toBeLessThanOrEqual(960);
    h.hover({x:800,y:400});h.controller.drawOverlay();
    expect(h.controller.axes.crosshair).not.toBeNull();
    h.drawing.selectTool('pointer');h.controller.drawOverlay();
    expect(h.drawing.crosshair).toBe(true);expect(h.controller.axes.crosshair).not.toBeNull();
    h.drawing.selectTool('eraser');h.controller.drawOverlay();
    expect(h.drawing.crosshair).toBe(false);expect(h.controller.axes.crosshair).toBeNull();
  });
});
