import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../src/lib/drawing/registry';
import { registerDrawingBuiltins } from '../src/lib/drawing/builtins';
import { DrawingEngine } from '../src/lib/drawing/engine';
import { AnchoredGesture, FreehandGesture } from '../src/lib/drawing/gestures';
import { DrawingStore, parseDrawingDocument } from '../src/lib/drawing/store';
import { indexForTime, timeForIndex } from '../src/lib/drawing/coordinates';
import { ColumnStore } from '../src/lib/core/datastore';
import { priceZoneTool } from '../src/plugins/price-zone/definition';
import { DEFAULT_STYLE } from '../src/lib/drawing/types';
import type { DrawingHost, Drawing, GestureInput } from '../src/lib/drawing/types';

const input=(x:number,y:number):GestureInput=>({pixel:{x,y},anchor:{time:x,value:y}});
const reg=()=>{const r=new ToolRegistry();registerDrawingBuiltins(r);return r;};
const host:DrawingHost={
  paneAt:p=>p.y<500?'main':'rsi',
  projection:id=>({pane:{id,top:id==='main'?0:500,height:500,width:1000},project:p=>({x:p.time,y:p.value}),indexAt:time=>time/60}),
  anchorAt:p=>({time:p.x,value:p.y}),zoomTo:vi.fn(),
};
const draw=(engine:DrawingEngine,id='trend-line',pane='main')=>{
  engine.selectTool(id);engine.pointerDown({x:100,y:100},pane);engine.pointerUp({x:100,y:100});
  engine.pointerMove({x:200,y:200});engine.pointerDown({x:200,y:200},pane);engine.pointerUp({x:200,y:200});
};
beforeEach(()=>{const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v)});});
afterEach(()=>vi.unstubAllGlobals());

describe('drawing gestures',()=>{
  it('supports click-click and drag without duplicate endpoint',()=>{
    for(const drag of [true,false]){
      const g=new AnchoredGesture(2);expect(g.pointer('down',input(10,10)).complete).toBe(false);
      if(drag){g.pointer('move',input(100,100));expect(g.pointer('up',input(100,100))).toEqual({points:[{time:10,value:10},{time:100,value:100}],complete:true});}
      else{g.pointer('up',input(10,10));g.pointer('move',input(100,100));expect(g.pointer('down',input(100,100)).points).toHaveLength(2);}
    }
  });
  it('supports three-anchor channels and four-anchor patterns',()=>{
    for(const count of [3,4]){const g=new AnchoredGesture(count);for(let i=0;i<count;i++){const result=g.pointer('down',input(i*30,i*20));expect(result.complete).toBe(i===count-1);g.pointer('up',input(i*30,i*20));}}
  });
  it('samples freehand paths and caps long strokes',()=>{
    const g=new FreehandGesture();g.pointer('down',input(0,0));for(let i=1;i<3000;i++)g.pointer('move',input(i*4,0));expect(g.pointer('up',input(12000,0)).points.length).toBeLessThanOrEqual(2048);
  });
});

describe('drawing engine document lifecycle',()=>{
  it('commits creation, edits once per drag and preserves undo/redo',()=>{
    const e=new DrawingEngine(reg(),host,()=>{});e.setMarket('mock:BTCUSDT');draw(e);
    expect(e.state.drawings).toHaveLength(1);const original=e.state.drawings[0];
    e.pointerDown({x:200,y:200},'main');e.pointerMove({x:240,y:160});e.pointerMove({x:260,y:150});e.pointerUp({x:260,y:150});
    expect(e.state.drawings[0].points[1]).toEqual({time:260,value:150});
    e.undo();expect(e.state.drawings[0]).toEqual(original);e.redo();expect(e.state.drawings[0].points[1].time).toBe(260);
    e.deleteSelected(); // Undo/redo cancels selection; no accidental delete.
    expect(e.state.drawings).toHaveLength(1);e.destroy();
  });
  it('cancels incomplete drawing and uncommitted edits without saving',()=>{
    const e=new DrawingEngine(reg(),host,()=>{});e.setMarket('mock:A');e.selectTool('trend-line');e.pointerDown({x:10,y:10},'main');e.pointerUp({x:10,y:10});e.cancel();expect(e.state.drawings).toHaveLength(0);
    draw(e);const original=e.state.drawings[0];e.pointerDown({x:200,y:200},'main');e.pointerMove({x:400,y:20});e.cancel();expect(e.state.drawings[0]).toEqual(original);e.destroy();
  });
  it('isolates markets, restores documents and retains pane identity',()=>{
    const r=reg(),e=new DrawingEngine(r,host,()=>{});e.setMarket('mock:A');draw(e,'trend-line','rsi');const doc=e.exportJSON();
    e.setMarket('mock:B');expect(e.state.drawings).toHaveLength(0);expect(()=>e.importJSON(doc)).toThrow('其他市场');
    e.setMarket('mock:A');expect(e.state.drawings[0].paneId).toBe('rsi');e.destroy();
    const restored=new DrawingEngine(r,host,()=>{});restored.setMarket('mock:A');expect(restored.state.drawings[0].paneId).toBe('rsi');restored.destroy();
  });
  it('supports hide/lock, deletion and reversible clear',()=>{
    const e=new DrawingEngine(reg(),host,()=>{});e.setMarket('mock:A');draw(e);const id=e.state.drawings[0].id;
    e.setDrawingFlags(id,{locked:true});e.deleteSelected();expect(e.state.drawings).toHaveLength(1);
    e.setDrawingFlags(id,{hidden:true});expect(e.pointerDown({x:150,y:150},'main')).toBe(false);
    e.setDrawingFlags(id,{hidden:false,locked:false});e.clear();expect(e.state.drawings).toHaveLength(0);e.undo();expect(e.state.drawings).toHaveLength(1);e.destroy();
  });
  it('transient region zoom uses host commands without saving a fake drawing',()=>{
    const zoom=vi.fn(),e=new DrawingEngine(reg(),{...host,zoomTo:zoom},()=>{});e.setMarket('mock:A');draw(e,'zoom-region');expect(zoom).toHaveBeenCalledOnce();expect(e.state.drawings).toHaveLength(0);e.destroy();
  });
  it('registers a custom renderer/gesture without modifying the engine',()=>{
    const r=reg();r.register(priceZoneTool);
    r.register({...priceZoneTool,id:'one-click-custom',createGesture:()=>({pointer:(_phase,i)=>({points:[i.anchor,{time:i.anchor.time+20,value:i.anchor.value+30}],complete:true})})});
    const e=new DrawingEngine(r,host,()=>{});e.setMarket('mock:A');e.selectTool('one-click-custom');e.pointerDown({x:30,y:40},'main');expect(e.state.drawings[0].points).toHaveLength(2);
    expect(r.get('one-click-custom')!.build(e.state.drawings[0],host.projection('main')!)).toHaveLength(3);
    expect(()=>r.register(priceZoneTool)).toThrow('Duplicate');e.destroy();
  });
  it('contains a broken plugin gesture and allows switching back to working tools',()=>{
    const r=reg();r.register({...priceZoneTool,id:'broken-plugin',createGesture:()=>{throw Error('plugin failure');}});
    const e=new DrawingEngine(r,host,()=>{});e.setMarket('mock:A');e.selectTool('broken-plugin');
    expect(()=>e.pointerDown({x:10,y:10},'main')).not.toThrow();expect(e.state.error).toContain('plugin failure');
    draw(e);expect(e.state.drawings).toHaveLength(1);expect(e.state.error).toBe('');e.destroy();
  });
  it('validates imports atomically and prevents mutable state from leaking',()=>{
    const r=reg(),e=new DrawingEngine(r,host,()=>{});e.setMarket('mock:A');draw(e);const state=e.state;
    state.drawings[0].points[0].value=999;expect(e.state.drawings[0].points[0].value).toBe(100);
    const doc=JSON.parse(e.exportJSON());doc.drawings[0].style.color='not-a-color';expect(()=>e.importJSON(JSON.stringify(doc))).toThrow();expect(e.state.drawings).toHaveLength(1);
    const duplicate=JSON.parse(e.exportJSON());duplicate.drawings.push(duplicate.drawings[0]);expect(()=>parseDrawingDocument(JSON.stringify(duplicate),r)).toThrow();e.destroy();
  });
});

describe('time anchors and history snapshots',()=>{
  it('maps fractional timestamps and dates outside loaded data without scanning history',()=>{
    const store=new ColumnStore();for(const time of [1000,2000,4000])store.appendBar({time,open:1,high:2,low:0,close:1,volume:1});
    for(const time of [0,1000,1500,3000,4000,6000])expect(timeForIndex(store,indexForTime(store,time,1000),1000)).toBeCloseTo(time);
  });
  it('copies committed documents and clears redo on a new branch',()=>{
    const store=new DrawingStore(),drawing:Drawing={id:'a',toolId:'horizontal-line',paneId:'main',points:[{time:1,value:2}],style:{...DEFAULT_STYLE},props:{},locked:false,hidden:false};
    store.commit([drawing]);drawing.points[0].value=99;expect(store.items[0].points[0].value).toBe(2);
    store.undo();expect(store.canRedo).toBe(true);store.commit([]);expect(store.canRedo).toBe(false);
  });
});


describe('built-in tool geometry',()=>{
  it('all registered renderers produce finite geometry for completed objects',()=>{
    for(const tool of reg().list().filter(t=>!t.mode)){
      const count=tool.freehand?6:tool.points??2;
      const d:Drawing={id:'test',toolId:tool.id,paneId:'main',points:Array.from({length:count},(_,i)=>({time:100+i*50,value:100+i%2*60})),style:{...DEFAULT_STYLE},props:Object.fromEntries((tool.fields??[]).map(f=>[f.key,f.default])),locked:false,hidden:false};
      const primitives=tool.build(d,host.projection('main')!);
      expect(primitives.length).toBeGreaterThan(0);
      for(const p of primitives){const pts=p.kind==='path'?p.points:p.kind==='text'?[p.at]:[p.a,p.b];expect(pts.every(v=>Number.isFinite(v.x)&&Number.isFinite(v.y))).toBe(true);}
    }
  });
  it('upward vertical extended lines and vertical channels remain visible',()=>{
    const r=reg(),d:Drawing={id:'test',toolId:'extended-line',paneId:'main',points:[{time:100,value:200},{time:100,value:100}],style:{...DEFAULT_STYLE},props:{},locked:false,hidden:false};
    const line=r.get(d.toolId)!.build(d,host.projection('main')!)[0];
    expect(line.kind==='path'&&line.points[0].y<0&&line.points[1].y>500).toBe(true);
    d.points.push({time:150,value:150});const channel=r.get('parallel-channel')!.build(d,host.projection('main')!)[0];
    expect(channel.kind==='path'&&channel.points[2].x!==channel.points[0].x).toBe(true);
  });
});
