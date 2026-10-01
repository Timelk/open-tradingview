import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingEngine } from '../src/lib/drawing/engine';
import { ToolRegistry } from '../src/lib/drawing/registry';
import { registerDrawingBuiltins } from '../src/lib/drawing/builtins';
import { primitiveHit } from '../src/lib/drawing/primitives';
import type { DrawingHost, Primitive } from '../src/lib/drawing/types';

const host:DrawingHost={
  paneAt:()=> 'main',
  projection:()=>({pane:{id:'main',top:0,height:600,width:1000},project:p=>({x:p.time,y:p.value}),indexAt:time=>time}),
  anchorAt:p=>({time:p.x,value:p.y}),zoomTo:()=>{},
};
function engine(){const registry=new ToolRegistry();registerDrawingBuiltins(registry);const e=new DrawingEngine(registry,host,()=>{});e.setMarket('mock:A');return e;}
function rectangle(e:DrawingEngine,x:number,y:number,size:number){
  e.selectTool('rectangle');e.pointerDown({x,y},'main');e.pointerMove({x:x+size,y:y+size});e.pointerUp({x:x+size,y:y+size});
  return e.state.selected!.id;
}
beforeEach(()=>{vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}});});
afterEach(()=>vi.unstubAllGlobals());

describe('grabbing the visible fill of a drawing',()=>{
  it.each(['rect','ellipse'] as const)('grabs a filled %s interior but preserves hollow interiors and outside space',kind=>{
    // Reversed corner order is normal when drawing up and to the left.
    const shape:Primitive={kind,a:{x:300,y:300},b:{x:100,y:100},fill:'#4d91ff'};
    expect(primitiveHit({x:200,y:200},shape,7,.12)).toBe(true);
    expect(primitiveHit({x:200,y:200},shape,7,0)).toBe(false);
    expect(primitiveHit({x:200,y:200},{...shape,fill:undefined},7,.12)).toBe(false);
    expect(primitiveHit({x:310,y:310},shape,7,.12)).toBe(false);
    expect(primitiveHit({x:100,y:200},shape,7,0)).toBe(true);
  });
  it('respects concave filled polygons without grabbing empty cutouts or open paths',()=>{
    const path:Primitive={kind:'path',closed:true,fill:'#4d91ff',points:[
      {x:100,y:100},{x:300,y:100},{x:300,y:300},{x:240,y:300},
      {x:240,y:160},{x:160,y:160},{x:160,y:300},{x:100,y:300},
    ]};
    expect(primitiveHit({x:130,y:240},path,7,.12)).toBe(true);
    expect(primitiveHit({x:200,y:240},path,7,.12)).toBe(false);
    expect(primitiveHit({x:130,y:240},path,7,0)).toBe(false);
    expect(primitiveHit({x:130,y:240},{...path,fill:undefined},7,.12)).toBe(false);
    expect(primitiveHit({x:130,y:240},{...path,closed:false},7,.12)).toBe(false);
  });
  it('moves the foremost filled rectangle from its interior and preserves one undo step',()=>{
    const e=engine();const lower=rectangle(e,100,100,300),upper=rectangle(e,150,150,200);
    e.selectLayers([]);
    expect(e.pointerDown({x:220,y:220},'main')).toBe(true);
    expect(e.state.selected?.id).toBe(upper);
    e.pointerMove({x:240,y:190});e.pointerMove({x:250,y:180});e.pointerUp({x:250,y:180});
    expect(e.state.selected?.points).toEqual([{time:180,value:110},{time:380,value:310}]);
    expect(e.state.drawings.find(d=>d.id===lower)?.points).toEqual([{time:100,value:100},{time:400,value:400}]);
    e.undo();expect(e.state.drawings.find(d=>d.id===upper)?.points).toEqual([{time:150,value:150},{time:350,value:350}]);
    e.destroy();
  });
  it('lets an unfilled upper rectangle interior pass through to the drawing underneath',()=>{
    const e=engine();const lower=rectangle(e,100,100,300);rectangle(e,150,150,200);
    e.updateSelected({style:{fillOpacity:0}});e.selectLayers([]);
    expect(e.pointerDown({x:220,y:220},'main')).toBe(true);
    expect(e.state.selected?.id).toBe(lower);e.cancel();e.destroy();
  });
});

describe('single-anchor placement by dragging',()=>{
  it.each(['horizontal-line','vertical-line','text','buy-marker'])('%s previews while pressed and commits at the release position',id=>{
    const e=engine();e.selectTool(id);
    e.pointerDown({x:100,y:100},'main');
    expect(e.state.drawings).toHaveLength(0);expect(e.state.placing).toBe(true);
    e.pointerMove({x:170,y:180});
    expect(e.state.drawings).toHaveLength(0);
    // Release may be newer than the last move sample and must win.
    e.pointerUp({x:180,y:190});
    expect(e.state.drawings).toHaveLength(1);
    expect(e.state.selected?.points).toEqual([{time:180,value:190}]);
    expect(e.state.placing).toBe(false);
    e.undo();expect(e.state.drawings).toHaveLength(0);e.destroy();
  });
  it('supports a normal click and cancelling a pressed single-anchor tool',()=>{
    const e=engine();e.selectTool('horizontal-line');
    e.pointerDown({x:100,y:100},'main');e.pointerMove({x:150,y:200});e.cancel();
    expect(e.state.drawings).toHaveLength(0);expect(e.state.canUndo).toBe(false);
    e.pointerDown({x:150,y:200},'main');e.pointerUp({x:150,y:200});
    expect(e.state.selected?.points).toEqual([{time:150,value:200}]);e.destroy();
  });
});
