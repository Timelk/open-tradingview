import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAWING_TOOL_MIME } from '../src/lib/drawing/tool-transfer';
import { ChartController, initialState } from '../src/lib/chart/controller';
import { DrawingEngine } from '../src/lib/drawing/engine';
import { ToolRegistry } from '../src/lib/drawing/registry';
import { registerDrawingBuiltins } from '../src/lib/drawing/builtins';
import { Viewport } from '../src/lib/core/viewport';
import { RangeMotion } from '../src/lib/interaction/range-motion';
import type { Anchor, DrawingHost, Pixel } from '../src/lib/drawing/types';

/** A DOM shell only: lifecycle handlers, editing, persistence and undo use the
 * production controller/engine/store. EventTarget supplies actual listeners;
 * route() supplies window capture -> target delivery without a DOM dependency. */
class ElementShell extends EventTarget {
  style={cursor:''};title='';
  clientWidth=1088;clientHeight=626;
  classes=new Set<string>();
  classList={add:(name:string)=>{this.classes.add(name);},remove:(name:string)=>{this.classes.delete(name);}};
  focus=vi.fn();closest=()=>null;querySelector=()=>null;
  contains=(target:unknown)=>target===this;
  getBoundingClientRect=()=>({left:48,top:72,width:this.clientWidth,height:this.clientHeight});
  captured=new Set<number>();
  setPointerCapture=(id:number)=>{this.captured.add(id);};
  hasPointerCapture=(id:number)=>this.captured.has(id);
  releasePointerCapture:(id:number)=>void=id=>{this.captured.delete(id);};
}

const cleanup:(()=>void)[]=[];
beforeEach(()=>{
  const storage=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)});
  vi.stubGlobal('Node',ElementShell);vi.stubGlobal('Element',ElementShell);
});
afterEach(()=>{for(const close of cleanup.splice(0))close();vi.unstubAllGlobals();});

function harness(){
  const page=new EventTarget(),host=new ElementShell(),outside=new ElementShell();vi.stubGlobal('window',page);
  const registry=new ToolRegistry();registerDrawingBuiltins(registry);
  const projection={pane:{id:'main',top:0,height:600,width:1000},project:(p:Anchor)=>({x:p.time,y:p.value}),indexAt:(time:number)=>time};
  const coordinates:DrawingHost={paneAt:()=> 'main',projection:()=>projection,anchorAt:p=>({time:p.x,value:p.y}),zoomTo:()=>{}};
  const drawing=new DrawingEngine(registry,coordinates,()=>{});drawing.setMarket('mock:DRAG');
  const controller=Object.assign(Object.create(ChartController.prototype),{
    drawing,host,events:new AbortController(),state:{...initialState,loading:false},
    viewport:new Viewport(1000,{from:0,to:1000,plotW:1000,plotH:600}),viewportMotion:new RangeMotion({min:0,max:1000}),
    width:1088,height:626,dpr:1,panes:[{id:'main',top:0,height:600,min:0,max:600,series:[]}],
    renderer:{resize:vi.fn()},overlay:{width:1088,height:626},axisCanvas:{width:1088,height:626},
    ctx:{setTransform:vi.fn()},axisContext:{setTransform:vi.fn()},
    paneControls:new ElementShell(),manualScales:new Map(),drag:null,pendingPointer:null,inputStarted:null,
    drawingProjection:()=>projection,publish:vi.fn(),onDrawingSelection:vi.fn(),onOpenProperties:vi.fn(),
  });
  controller.bindEvents();
  function route(type:string,target:EventTarget,properties:Record<string,unknown>={}){
    const event=Object.assign(new Event(type,{bubbles:true,cancelable:true}),properties);
    // Keep the original target visible to window's capture listener.
    Object.defineProperty(event,'target',{value:target,configurable:true});
    page.dispatchEvent(event);if(target!==page)target.dispatchEvent(event);
    return event;
  }
  function pointer(type:string,point:Pixel,target:EventTarget=host,extra:Record<string,unknown>={}){
    const event=route(type,target,{pointerId:1,pointerType:'mouse',button:0,buttons:type==='pointerup'||type==='pointercancel'?0:1,clientX:point.x+48,clientY:point.y+72,...extra});
    // Browsers automatically release capture after up/cancel. release() below
    // also fires synchronously to exercise re-entry while finish is running.
    const id=typeof extra.pointerId==='number'?extra.pointerId:1;
    if((type==='pointerup'||type==='pointercancel')&&host.hasPointerCapture(id))host.releasePointerCapture(id);
    return event;
  }
  host.releasePointerCapture=vi.fn((id:number)=>{
    if(!host.captured.delete(id))return;
    route('lostpointercapture',host,{pointerId:id,pointerType:'mouse',button:0,buttons:1,clientX:48,clientY:72});
  });
  const key=(key:string,extra:Record<string,unknown>={})=>route('keydown',host,{key,code:key,ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,...extra});
  const points=()=>structuredClone(drawing.state.drawings[0]?.points??[]);
  const persisted=()=>JSON.parse(localStorage.getItem('tvchart.workspace.v2:mock:DRAG')!).drawings[0]?.points??[];
  const create=()=>{
    drawing.selectTool('fib-retracement');pointer('pointerdown',{x:100,y:100});pointer('pointermove',{x:190,y:190});pointer('pointerup',{x:200,y:200});
    expect(points()).toEqual([{time:100,value:100},{time:200,value:200}]);expect(drawing.state.activeTool).toBe('cursor');
  };
  cleanup.push(()=>{controller.events.abort();drawing.destroy();});
  return {controller,drawing,host,page,outside,pointer,route,key,points,persisted,create,registry,coordinates};
}

type EditKind='endpoint'|'body';

describe('analytical pattern interaction does not hijack chart navigation',()=>{
  const attach=(h:ReturnType<typeof harness>,x=400,y=250)=>{
    h.controller.patternHits=[{instanceId:'pattern-study',pattern:{id:'triangle'},bounds:{left:x-12,right:x+12,top:y-12,bottom:y+12},segments:[]}];
    h.controller.selectPattern=vi.fn();h.controller.onPatternSelection=vi.fn();
  };
  it('keeps wheel zoom on a pattern and opens settings only on double click',()=>{
    const h=harness();attach(h);h.controller.state.smoothMotion=false;
    const before=h.controller.viewport.span;
    h.route('wheel',h.host,{clientX:448,clientY:322,deltaY:-100,deltaX:0,deltaMode:0});
    expect(h.controller.viewport.span).toBeLessThan(before);
    expect(h.controller.onOpenProperties).not.toHaveBeenCalled();
    h.pointer('pointerdown',{x:400,y:250});
    expect(h.controller.selectPattern).toHaveBeenCalledWith('pattern-study','triangle',false);
    expect(h.controller.onPatternSelection).toHaveBeenCalledOnce();
    expect(h.controller.onOpenProperties).not.toHaveBeenCalled();
    h.route('dblclick',h.host,{clientX:448,clientY:322});
    expect(h.controller.onOpenProperties).toHaveBeenCalledWith(['pattern-study']);
  });
  it('lets hand-drawing endpoints keep their drag and persistence priority',()=>{
    const h=harness();h.create();attach(h,200,200);
    h.pointer('pointerdown',{x:200,y:200});h.pointer('pointermove',{x:240,y:220});h.pointer('pointerup',{x:260,y:230});
    expect(h.controller.selectPattern).not.toHaveBeenCalled();
    expect(h.points()[1]).toEqual({time:260,value:230});
    expect(h.persisted()[1]).toEqual({time:260,value:230});
  });
});
function grab(points:Anchor[],kind:EditKind):Pixel {
  return kind==='endpoint'?{x:points[1].time,y:points[1].value}:{x:(points[0].time+points[1].time)/2,y:(points[0].value+points[1].value)/2};
}
function moved(points:Anchor[],kind:EditKind,dx:number,dy:number):Anchor[]{return points.map((p,i)=>kind==='body'||i===1?{time:p.time+dx,value:p.value+dy}:{...p});}

describe.each(['endpoint','body'] as const)('controller %s drag lifecycle after initial creation',kind=>{
  it('commits the second and third edits at release, persists coordinates and adds one undo step each',()=>{
    const h=harness();h.create();const history=[h.points()];
    for(const [dx,dy] of [[80,40],[30,25]]){
      const before=h.points(),p=grab(before,kind);h.pointer('pointerdown',p);
      h.pointer('pointermove',{x:p.x+dx-12,y:p.y+dy-8});
      expect(h.points()).toEqual(before); // An in-progress preview is not history.
      h.pointer('pointerup',{x:p.x+dx,y:p.y+dy});
      const expected=moved(before,kind,dx,dy);expect(h.points()).toEqual(expected);expect(h.persisted()).toEqual(expected);history.push(expected);
      h.route('lostpointercapture',h.host,{pointerId:1});
      expect(h.points()).toEqual(expected);expect(h.controller.drag).toBeNull();
    }
    const restored=new DrawingEngine(h.registry,h.coordinates,()=>{});restored.setMarket('mock:DRAG');
    expect(restored.state.drawings[0].points).toEqual(history[2]);restored.destroy();
    h.drawing.undo();expect(h.points()).toEqual(history[1]);h.drawing.undo();expect(h.points()).toEqual(history[0]);h.drawing.undo();expect(h.points()).toEqual([]);
  });

  it('keeps editing after early capture loss, then saves external-target and window releases',()=>{
    const h=harness();h.create();const history=[h.points()];
    for(const target of [h.outside,h.page]){
      const before=h.points(),p=grab(before,kind);h.pointer('pointerdown',p);h.pointer('pointermove',{x:p.x+15,y:p.y+10});
      h.host.releasePointerCapture(1);
      expect(h.drawing.hasGesture).toBe(true);expect(h.points()).toEqual(before);
      h.pointer('pointermove',{x:p.x+35,y:p.y+20},target);
      h.pointer('pointerup',{x:p.x+50,y:p.y+30},target);
      const expected=moved(before,kind,50,30);expect(h.points()).toEqual(expected);expect(h.persisted()).toEqual(expected);history.push(expected);
      h.pointer('pointerup',{x:900,y:550},target);h.route('lostpointercapture',h.host,{pointerId:1});
      expect(h.points()).toEqual(expected);
    }
    h.drawing.undo();expect(h.points()).toEqual(history[1]);h.drawing.undo();expect(h.points()).toEqual(history[0]);h.drawing.undo();expect(h.points()).toEqual([]);
  });

  it('keeps an active edit through a real controller resize and commits against the new projection',()=>{
    const h=harness();h.create();const before=h.points(),p=grab(before,kind),v=h.controller.viewport as Viewport;
    // This projection scales with the real viewport resized by the controller;
    // screen coordinates after the resize no longer equal stored world values.
    h.coordinates.projection=()=>({pane:{id:'main',top:0,height:v.plotH,width:v.plotW},
      project:a=>({x:a.time*v.plotW/1000,y:a.value*v.plotH/600}),indexAt:time=>time});
    h.coordinates.anchorAt=a=>({time:a.x*1000/v.plotW,value:a.y*600/v.plotH});
    h.controller.drawingProjection=h.coordinates.projection;
    h.pointer('pointerdown',p);h.pointer('pointermove',{x:p.x+20,y:p.y+10});
    h.host.clientWidth=1288;h.host.clientHeight=746;h.controller.resize();
    expect(h.controller.renderer.resize).toHaveBeenCalledWith(1288,746,1);
    expect(v.plotW).toBe(1200);expect(v.plotH).toBe(720);
    expect(h.drawing.hasGesture).toBe(true);expect(h.controller.drag?.kind).toBe('drawing');expect(h.host.hasPointerCapture(1)).toBe(true);
    expect(h.points()).toEqual(before);expect(h.persisted()).toEqual(before);
    const projection=h.coordinates.projection('main')!;
    h.pointer('pointermove',projection.project({time:p.x+60,value:p.y+35}));
    h.pointer('pointerup',projection.project({time:p.x+70,value:p.y+40}));
    expect(h.points()).toEqual(moved(before,kind,70,40));expect(h.persisted()).toEqual(h.points());
    expect(h.controller.drag).toBeNull();h.drawing.undo();expect(h.points()).toEqual(before);h.drawing.undo();expect(h.points()).toEqual([]);
  });

  it.each(['Escape','pointercancel'] as const)('%s rolls back only the current preview and immediately permits another drag',cancel=>{
    const h=harness();h.create();const before=h.points(),p=grab(before,kind);
    h.pointer('pointerdown',p);h.pointer('pointermove',{x:p.x+40,y:p.y+20});h.host.releasePointerCapture(1);
    if(cancel==='Escape')h.key('Escape');else h.pointer('pointercancel',{x:p.x+40,y:p.y+20},h.outside);
    h.pointer('pointerup',{x:p.x+50,y:p.y+30},h.outside);
    expect(h.points()).toEqual(before);expect(h.persisted()).toEqual(before);expect(h.controller.drag).toBeNull();expect(h.drawing.hasGesture).toBe(false);
    h.pointer('pointerdown',p);h.pointer('pointermove',{x:p.x+25,y:p.y+15});h.pointer('pointerup',{x:p.x+30,y:p.y+20});
    expect(h.points()).toEqual(moved(before,kind,30,20));
    h.drawing.undo();expect(h.points()).toEqual(before);h.drawing.undo();expect(h.points()).toEqual([]);
  });
});

describe('interrupted/re-entrant release boundaries',()=>{
  it.each(['blur','buttons-zero'] as const)('%s commits the last pressed position, not an unrelated returning pointer',boundary=>{
    const h=harness();h.create();const before=h.points();h.pointer('pointerdown',{x:200,y:200});h.pointer('pointermove',{x:260,y:235});h.host.releasePointerCapture(1);
    if(boundary==='blur')h.route('blur',h.page);else h.pointer('pointermove',{x:900,y:550},h.outside,{buttons:0});
    expect(h.points()).toEqual(moved(before,'endpoint',60,35));expect(h.persisted()).toEqual(h.points());expect(h.controller.drag).toBeNull();
    h.pointer('pointerup',{x:900,y:550},h.outside);h.drawing.undo();expect(h.points()).toEqual(before);h.drawing.undo();expect(h.points()).toEqual([]);
  });
  it('clears gesture ownership before callbacks can synchronously re-enter pointerup or release capture',()=>{
    const h=harness();h.create();const before=h.points();
    const callback=vi.fn(()=>{h.host.releasePointerCapture(1);h.pointer('pointerup',{x:900,y:550},h.page);});h.controller.onDrawingSelection=callback;
    h.pointer('pointerdown',{x:200,y:200});h.pointer('pointermove',{x:240,y:230});h.pointer('pointerup',{x:250,y:240});
    expect(callback).toHaveBeenCalledOnce();expect(h.points()).toEqual(moved(before,'endpoint',50,40));
    h.drawing.undo();expect(h.points()).toEqual(before);h.drawing.undo();expect(h.points()).toEqual([]);
  });
  it('ignores a different pointer cancel/up without discarding the owning pointer edit',()=>{
    const h=harness();h.create();const before=h.points();h.pointer('pointerdown',{x:200,y:200});h.pointer('pointermove',{x:250,y:230});h.host.releasePointerCapture(1);
    h.pointer('pointercancel',{x:600,y:500},h.outside,{pointerId:2});h.pointer('pointerup',{x:600,y:500},h.outside,{pointerId:2});
    expect(h.drawing.hasGesture).toBe(true);expect(h.points()).toEqual(before);
    h.pointer('pointerup',{x:260,y:240},h.outside);expect(h.points()).toEqual(moved(before,'endpoint',60,40));
    h.drawing.undo();expect(h.points()).toEqual(before);h.drawing.undo();expect(h.points()).toEqual([]);
  });
  it('does not resurrect a cancelled edit when an undo shortcut is followed by mouse release',()=>{
    const h=harness();h.create();h.pointer('pointerdown',{x:200,y:200});h.pointer('pointermove',{x:250,y:230});
    h.key('z',{ctrlKey:true});expect(h.controller.drag).toBeNull();expect(h.drawing.hasGesture).toBe(false);expect(h.points()).toEqual([]);
    h.pointer('pointerup',{x:260,y:240},h.outside);expect(h.points()).toEqual([]);
    h.drawing.redo();expect(h.points()).toEqual([{time:100,value:100},{time:200,value:200}]);
  });
  it('cancels an unfinished three-point tool on blur without saving a partial drawing',()=>{
    const h=harness();h.drawing.selectTool('parallel-channel');h.pointer('pointerdown',{x:100,y:100});h.pointer('pointermove',{x:200,y:200});
    h.route('blur',h.page);expect(h.points()).toEqual([]);expect(h.drawing.hasGesture).toBe(false);expect(h.controller.drag).toBeNull();
    expect(h.drawing.state.canUndo).toBe(false);h.pointer('pointerup',{x:220,y:220},h.outside);expect(h.points()).toEqual([]);
  });
});


describe('quick tool drops',()=>{
  it('accepts entry and drop without waiting for a subsequent dragover',()=>{
    const h=harness();
    const dataTransfer={types:[DRAWING_TOOL_MIME],dropEffect:'none',getData:()=> 'horizontal-line'};
    const properties={clientX:208,clientY:212,dataTransfer};
    const entered=h.route('dragenter',h.host,properties);
    expect(entered.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe('copy');
    h.route('drop',h.host,properties);
    expect(h.points()).toEqual([{time:160,value:140}]);
    expect(h.drawing.state.drawings[0].toolId).toBe('horizontal-line');
    expect(h.host.classes.has('tool-drop-target')).toBe(false);
  });
  it('does not accept external text or create drawings while locked',()=>{
    const h=harness();
    const external=h.route('dragenter',h.host,{clientX:208,clientY:212,dataTransfer:{types:['text/plain']}});
    expect(external.defaultPrevented).toBe(false);
    h.drawing.setOption('locked',true);
    const dataTransfer={types:[DRAWING_TOOL_MIME],getData:()=> 'horizontal-line'};
    expect(h.route('dragenter',h.host,{clientX:208,clientY:212,dataTransfer}).defaultPrevented).toBe(false);
    h.route('drop',h.host,{clientX:208,clientY:212,dataTransfer});
    expect(h.points()).toEqual([]);
  });
});

describe('two finger chart gestures',()=>{
 it('cancels an unfinished drawing edit and zooms around the two-finger midpoint without moving drawing anchors',()=>{const h=harness();h.create();const before=h.points();h.pointer('pointerdown',{x:200,y:200},h.host,{pointerType:'touch',pointerId:11});h.pointer('pointermove',{x:215,y:215},h.host,{pointerType:'touch',pointerId:11});h.pointer('pointerdown',{x:600,y:200},h.host,{pointerType:'touch',pointerId:12});expect(h.points()).toEqual(before);const span=h.controller.viewport.span;h.pointer('pointermove',{x:800,y:200},h.host,{pointerType:'touch',pointerId:12});h.controller.flushPointer();expect(h.controller.viewport.span).toBeLessThan(span);h.pointer('pointerup',{x:800,y:200},h.host,{pointerType:'touch',pointerId:12});const final=h.controller.viewport.span;h.pointer('pointermove',{x:300,y:200},h.host,{pointerType:'touch',pointerId:11});h.controller.flushPointer();expect(h.controller.viewport.span).toBe(final);h.pointer('pointerup',{x:300,y:200},h.host,{pointerType:'touch',pointerId:11});expect(h.points()).toEqual(before);expect(h.host.captured.size).toBe(0);});
});

it('does not show temporary magnet feedback for a screenshot modifier chord',()=>{const h=harness();h.key('Control',{ctrlKey:true});expect(h.drawing.magnetModifierHeld).toBe(true);h.key('Shift',{ctrlKey:true,shiftKey:true});expect(h.drawing.magnetModifierHeld).toBe(false);});
