import { it,expect,vi,afterEach } from 'vitest';
import { SceneStore } from '../src/lib/scene/store';
import { emptyScene,layerOf } from '../src/lib/scene/types';
import { DrawingEngine } from '../src/lib/drawing/engine';
import { ToolRegistry } from '../src/lib/drawing/registry';
import { registerDrawingBuiltins } from '../src/lib/drawing/builtins';

it('batches live property changes into one undo step and cancels without damaging redo',()=>{
  const store=new SceneStore(),doc=emptyScene();doc.layers.push(layerOf('price','series','K线'));store.replaceDocument(doc);
  store.beginPreview();
  for(const opacity of [.8,.5,.2])store.commitDocument({...store.document,layers:store.document.layers.map(l=>({...l,opacity}))});
  expect(store.document.layers[0].opacity).toBe(.2);expect(store.canUndo).toBe(false);
  store.finishPreview(true);expect(store.canUndo).toBe(true);store.undo();expect(store.document.layers[0].opacity).toBe(1);
  store.beginPreview();store.commitDocument({...store.document,layers:store.document.layers.map(l=>({...l,name:'临时'}))});store.finishPreview(false);
  expect(store.document.layers[0].name).toBe('K线');expect(store.canRedo).toBe(true);store.redo();expect(store.document.layers[0].opacity).toBe(.2);
});
afterEach(()=>vi.unstubAllGlobals());
it('does not persist modal preview and saves only the confirmed properties',()=>{
  const setItem=vi.fn();vi.stubGlobal('localStorage',{getItem:()=>null,setItem});const registry=new ToolRegistry();registerDrawingBuiltins(registry);
  const engine=new DrawingEngine(registry,{paneAt:()=>null,projection:()=>null,anchorAt:()=>null,zoomTo:()=>{}},()=>{},()=>({...emptyScene(),layers:[layerOf('price','series','K线')]}));
  engine.setMarket('test');engine.selectLayers(['price']);
  const edit=engine.beginPropertyEdit(['price']);engine.updateLayers(['price'],{name:'预览名称'});
  expect(setItem).not.toHaveBeenCalled();edit.cancel();expect(engine.document.layers[0].name).toBe('K线');expect(setItem).not.toHaveBeenCalled();
  const saved=engine.beginPropertyEdit(['price']);engine.updateLayers(['price'],{name:'已确认'});saved.commit();
  expect(setItem).toHaveBeenCalledOnce();engine.undo();expect(engine.document.layers[0].name).toBe('K线');engine.destroy();
});

it('keeps a property session bound to its original market and selection',()=>{
  vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}});const registry=new ToolRegistry();registerDrawingBuiltins(registry);
  const engine=new DrawingEngine(registry,{paneAt:()=>null,projection:()=>null,anchorAt:()=>null,zoomTo:()=>{}},()=>{},()=>({...emptyScene(),layers:[layerOf('price','series','K线')]}));
  engine.setMarket('A');engine.selectLayers(['price']);const edit=engine.beginPropertyEdit(['price']);engine.updateLayers(['price'],{name:'A 预览'});
  engine.setMarket('B');expect(edit.valid()).toBe(false);edit.cancel();expect(engine.document.layers[0].name).toBe('K线');
  engine.setMarket('A');expect(engine.document.layers[0].name).toBe('K线');engine.destroy();
});
