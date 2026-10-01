import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneStore } from '../src/lib/scene/store';
import { emptyScene, layerOf } from '../src/lib/scene/types';
import { DEFAULT_STYLE, type DrawingHost } from '../src/lib/drawing/types';
import { DrawingEngine } from '../src/lib/drawing/engine';
import { ToolRegistry } from '../src/lib/drawing/registry';
import { registerDrawingBuiltins } from '../src/lib/drawing/builtins';

/** Reproduce Svelte's nested proxies, including unchanged points returned by map. */
function reactive<T extends object>(value:T,cache=new WeakMap<object,object>()):T {
  const existing=cache.get(value);if(existing)return existing as T;
  const proxy=new Proxy(value,{get(target,key,receiver){const result=Reflect.get(target,key,receiver);return result&&typeof result==='object'?reactive(result,cache):result;}});
  cache.set(value,proxy);return proxy;
}
function document(){
  const doc=emptyScene();
  doc.layers=[layerOf('drawing','drawing','Fibonacci'),layerOf('ma','indicator','MA')];
  doc.drawings=[{id:'drawing',toolId:'fib-retracement',paneId:'main',points:[{time:100,value:100},{time:200,value:200}],style:{...DEFAULT_STYLE},props:{levels:'0,0.5,1',enabled:true},locked:false,hidden:false}];
  doc.indicators=[{instanceId:'ma',id:'ma',params:{period:20,source:'close'},timeframe:'chart',hiddenPlots:[1]}];
  return doc;
}
beforeEach(()=>{const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)});});
afterEach(()=>vi.unstubAllGlobals());

describe('plain scene snapshots at the persistence boundary',()=>{
  it('accepts nested Proxy points, styles, props, params and arrays without retaining reactive references',()=>{
    const store=new SceneStore(),source=document();source.layers[0].intervals=['1m','1h'];
    store.replaceDocument(reactive(source));expect(()=>structuredClone(store.document)).not.toThrow();expect(store.document).toEqual(source);
    source.drawings[0].points[1].value=999;source.drawings[0].props.levels='changed';source.indicators[0].params.period=99;source.layers[0].intervals.push('1d');source.indicators[0].hiddenPlots.push(2);
    expect(store.document.drawings[0].points[1].value).toBe(200);expect(store.document.drawings[0].props.levels).toBe('0,0.5,1');expect(store.document.indicators[0].params.period).toBe(20);
    expect(store.document.layers[0].intervals).toEqual(['1m','1h']);expect(store.document.indicators[0].hiddenPlots).toEqual([1]);
    const update=reactive(structuredClone(store.document));update.drawings[0].points[0].value=110;update.drawings[0].props.levels='0,1';update.indicators[0].params.period=50;
    store.commitDocument(update);expect(()=>structuredClone(store.document)).not.toThrow();expect(store.document.indicators[0].params.period).toBe(50);
    update.drawings[0].points[0].value=888;expect(store.document.drawings[0].points[0].value).toBe(110);
    store.undo();expect(store.document.drawings[0].points[0].value).toBe(100);expect(store.document.indicators[0].params.period).toBe(20);
    store.redo();expect(store.document.drawings[0].points[0].value).toBe(110);
  });
  it('copies unchanged Proxy points in a coordinate patch and cancels an entire preview atomically',()=>{
    const store=new SceneStore();store.replaceDocument(document());const original=structuredClone(store.document);
    store.beginPreview();const proxied=reactive(structuredClone(store.document.drawings[0]));
    const points=proxied.points.map((p,i)=>i===0?{...p,value:150}:p);
    store.commit([{...proxied,points}]);expect(store.document.drawings[0].points).toEqual([{time:100,value:150},{time:200,value:200}]);
    expect(()=>structuredClone(store.document)).not.toThrow();expect(store.canUndo).toBe(false);
    store.finishPreview(false);expect(store.document).toEqual(original);expect(store.canUndo).toBe(false);
  });
  it.each(['coordinate','drawing prop','indicator param'] as const)('rejects non-finite %s values instead of coercing them into saved data',field=>{
    const store=new SceneStore();store.replaceDocument(document());const original=structuredClone(store.document),bad=reactive(structuredClone(original));
    if(field==='coordinate')bad.drawings[0].points[0].value=NaN;
    else if(field==='drawing prop')bad.drawings[0].props.invalid=Infinity;
    else bad.indicators[0].params.period=NaN;
    expect(()=>store.commitDocument(bad)).toThrow();expect(store.document).toEqual(original);expect(store.canUndo).toBe(false);expect(store.canRedo).toBe(false);
  });
});

describe('failed commits preserve the entire transaction state',()=>{
  it('does not add a phantom undo step or erase redo when copying a next document fails',()=>{
    const store=new SceneStore(),a=document();store.replaceDocument(a);
    const b=structuredClone(a);b.layers[0].name='B';store.commitDocument(b);
    const c=structuredClone(b);c.layers[0].name='C';store.commitDocument(c);store.undo();
    const bad=structuredClone(b);Object.defineProperty(bad.drawings[0].props,'broken',{enumerable:true,get(){throw Error('reactive read failed');}});
    expect(()=>store.commitDocument(bad)).toThrow('reactive read failed');expect(store.document).toEqual(b);expect(store.canRedo).toBe(true);
    store.redo();expect(store.document).toEqual(c);store.undo();expect(store.document).toEqual(b);store.undo();expect(store.document).toEqual(a);expect(store.canUndo).toBe(false);
  });
  it('rejects an uncloneable property before history changes, including the undo/redo chain',()=>{
    const store=new SceneStore(),a=document();store.replaceDocument(a);const b=structuredClone(a);b.layers[0].name='B';store.commitDocument(b);store.undo();
    const bad=structuredClone(a);bad.drawings[0].props.levels=(()=> 'invalid') as unknown as string;
    expect(()=>store.commitDocument(bad)).toThrow();expect(store.document).toEqual(a);expect(store.canUndo).toBe(false);expect(store.canRedo).toBe(true);
    store.redo();expect(store.document).toEqual(b);store.undo();expect(store.document).toEqual(a);expect(store.canUndo).toBe(false);
  });
  it('keeps a preview session cancellable after a failed document replacement',()=>{
    const store=new SceneStore(),original=document();store.replaceDocument(original);store.beginPreview();
    const preview=structuredClone(original);preview.drawings[0].points[0].value=150;store.commitDocument(reactive(preview));
    const bad=structuredClone(original);bad.drawings[0].props.levels=(()=> 'invalid') as unknown as string;
    expect(()=>store.replaceDocument(bad)).toThrow();expect(store.isPreviewing).toBe(true);expect(store.document).toEqual(preview);
    store.finishPreview(false);expect(store.document).toEqual(original);expect(store.canUndo).toBe(false);
  });
});

it('saves a coordinate-dialog style Proxy patch, commits once and restores the previous coordinates on undo',()=>{
  const registry=new ToolRegistry();registerDrawingBuiltins(registry);
  const host:DrawingHost={paneAt:()=> 'main',projection:()=>({pane:{id:'main',top:0,height:600,width:1000},project:p=>({x:p.time,y:p.value}),indexAt:t=>t}),anchorAt:p=>({time:p.x,value:p.y}),zoomTo:()=>{}};
  const engine=new DrawingEngine(registry,host,()=>{});engine.setMarket('mock:PROXY');engine.importJSON(JSON.stringify(document()));engine.selectDrawing('drawing');
  const original=engine.state.selected!,session=engine.beginPropertyEdit(['drawing']),form=reactive(original);
  const points=form.points.map((p,i)=>i===0?{...p,time:110,value:120}:p);
  expect(()=>engine.updateSelected({points,props:reactive({levels:'0,1'})})).not.toThrow();
  expect(engine.state.selected!.points).toEqual([{time:110,value:120},{time:200,value:200}]);expect(()=>structuredClone(engine.document)).not.toThrow();
  session.commit();expect(JSON.parse(localStorage.getItem('tvchart.workspace.v2:mock:PROXY')!).drawings[0].points).toEqual(engine.state.selected!.points);
  engine.undo();expect(engine.state.drawings[0]).toEqual(original);engine.destroy();
});
