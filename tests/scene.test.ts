import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { emptyScene,layerOf,type SceneDocument } from '../src/lib/scene/types';
import { effectiveLayer,orderedLayers,validateStructure } from '../src/lib/scene/model';
import { groupLayers,moveToGroup,reorderLayers,ungroup,deleteLayers,placeRelative } from '../src/lib/scene/commands';
import { parseSceneDocument } from '../src/lib/scene/serialization';
import { DrawingStore } from '../src/lib/drawing/store';
import { ToolRegistry } from '../src/lib/drawing/registry';
import { registerDrawingBuiltins } from '../src/lib/drawing/builtins';
import { DrawingEngine } from '../src/lib/drawing/engine';
import { DEFAULT_STYLE,type DrawingHost } from '../src/lib/drawing/types';
function document():SceneDocument {
  const doc=emptyScene();doc.layers=[layerOf('price','series','K线'),layerOf('ma','indicator','MA'),layerOf('a','drawing','矩形'),layerOf('b','drawing','趋势线')];
  doc.indicators=[{id:'ma',instanceId:'ma',params:{period:20},timeframe:'chart',hiddenPlots:[]}];
  doc.drawings=['a','b'].map(id=>({id,toolId:'trend-line',paneId:'main',points:[{time:1,value:10},{time:2,value:20}],style:{...DEFAULT_STYLE},props:{},hidden:false,locked:false}));return doc;
}

describe('scene hierarchy and visual order',()=>{
  it('inherits group lock, hidden state, opacity and interval intersections',()=>{
    const result=groupLayers(document(),['a','ma'],'小时分析'),doc=result.document;
    const group=doc.layers.find(l=>l.id===result.id)!;group.locked=true;group.opacity=.5;group.intervals=['1h','4h'];
    doc.layers.find(l=>l.id==='a')!.opacity=.4;doc.layers.find(l=>l.id==='a')!.intervals=['1h'];
    expect(effectiveLayer(doc,'a','1h')).toMatchObject({visible:true,locked:true,opacity:.2});
    expect(effectiveLayer(doc,'a','4h').visible).toBe(false);expect(effectiveLayer(doc,'a','1m').visible).toBe(false);
    group.visible=false;expect(effectiveLayer(doc,'ma','1h').reason).toBe('分组已隐藏');
  });
  it('moves mixed drawing/indicator groups as contiguous paint blocks',()=>{
    const {document:doc,id}=groupLayers(document(),['ma','a'],'group');
    expect(orderedLayers(doc).map(l=>l.id)).toEqual(['price','b','ma','a']);
    expect(orderedLayers(reorderLayers(doc,[id],'back')).map(l=>l.id)).toEqual(['ma','a','price','b']);
    expect(orderedLayers(placeRelative(document(),['a'],'price',false)).map(l=>l.id)).toEqual(['a','price','ma','b']);
  });
  it('rejects cycles and cross-pane grouping without mutating input',()=>{
    const {document:doc,id}=groupLayers(document(),['a'],'outer');
    const nested=groupLayers(doc,['a'],'inner');const before=JSON.stringify(nested.document);
    expect(()=>moveToGroup(nested.document,[id],nested.id)).toThrow('自身');expect(JSON.stringify(nested.document)).toBe(before);
    doc.layers.find(l=>l.id==='b')!.paneId='rsi';expect(()=>groupLayers(doc,['a','b'],'bad')).toThrow('同一窗格');
  });
  it('ungroups without losing inherited visibility or opacity and protects locked descendants from delete',()=>{
    const {document:doc,id}=groupLayers(document(),['a','ma'],'g');doc.layers.find(l=>l.id===id)!.opacity=.5;doc.layers.find(l=>l.id===id)!.visible=false;
    const flattened=ungroup(doc,id);expect(flattened.layers.find(l=>l.id==='a')).toMatchObject({visible:false,opacity:.5,parentId:null});
    doc.layers.find(l=>l.id==='ma')!.locked=true;expect(deleteLayers(doc,[id],'1m').layers).toHaveLength(doc.layers.length);
  });
  it('one undo restores both indicator parameters and layer metadata',()=>{
    const store=new DrawingStore();store.replaceDocument(document());const changed=structuredClone(store.document);changed.indicators[0].params.period=50;changed.layers[1].intervals=['1h'];store.commitDocument(changed);
    store.undo();expect(store.document.indicators[0].params.period).toBe(20);expect(store.document.layers[1].intervals).toBeNull();
    store.redo();expect(store.document.indicators[0].params.period).toBe(50);
  });
  it('loads old execution metadata without enabling removed settings or discarding user objects',()=>{
    const reg=new ToolRegistry();registerDrawingBuiltins(reg);const old=document();
    old.layers.push({...layerOf('pine:retired:trades-buy','overlay','Old output'),scriptMarkerChoice:'obsolete'} as SceneDocument['layers'][number]);
    old.layers.push(layerOf('external-observation','overlay','Unrelated overlay'));
    const stored=JSON.stringify(old),parsed=parseSceneDocument(stored,reg),store=new DrawingStore();
    store.replaceDocument(parsed);
    expect(store.document.drawings).toEqual(old.drawings);
    expect(store.document.indicators).toEqual(old.indicators);
    expect(store.document.layers.map(layer=>layer.id)).toEqual(old.layers.map(layer=>layer.id));
    expect(store.document.layers.at(-2)).not.toHaveProperty('scriptMarkerChoice');
    expect(JSON.stringify(old)).toBe(stored);
  });
  it('migrates v1 coordinates intact and rejects malformed v2 documents atomically',()=>{
    const reg=new ToolRegistry();registerDrawingBuiltins(reg);const original=document(),defaults=document();defaults.drawings=[];defaults.layers=defaults.layers.filter(l=>l.kind!=='drawing');
    const upgraded=parseSceneDocument(JSON.stringify({version:1,drawings:original.drawings}),reg,defaults);
    expect(upgraded.version).toBe(2);expect(upgraded.drawings[0].points).toEqual(original.drawings[0].points);expect(upgraded.indicators).toHaveLength(1);
    const broken=structuredClone(upgraded);broken.layers.find(l=>l.id==='a')!.parentId='missing';expect(()=>validateStructure(broken)).toThrow();
  });
});

describe('scene-aware drawing selection',()=>{
  beforeEach(()=>vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}}));afterEach(()=>vi.unstubAllGlobals());
  it('respects group visibility and keeps topmost drawing hit testing aligned with paint order',()=>{
    const reg=new ToolRegistry();registerDrawingBuiltins(reg);
    const host:DrawingHost={paneAt:()=> 'main',projection:()=>({pane:{id:'main',top:0,height:100,width:100},project:a=>({x:a.time,y:a.value}),indexAt:t=>t}),anchorAt:p=>({time:p.x,value:p.y}),zoomTo:()=>{}};
    const engine=new DrawingEngine(reg,host,()=>{},document);engine.setMarket('mock:A');engine.pointerDown({x:1.5,y:15},'main');expect(engine.state.selected?.id).toBe('b');engine.cancel();
    engine.reorderLayers(['a'],'front');engine.selectLayers([]);engine.pointerDown({x:1.5,y:15},'main');expect(engine.state.selected?.id).toBe('a');engine.cancel();
    engine.selectLayers(['a','b']);engine.createGroup('g');const id=engine.state.scene.selectedIds[0];engine.updateLayers([id],{visible:false});engine.selectLayers([]);expect(engine.pointerDown({x:1.5,y:15},'main')).toBe(false);engine.destroy();
  });
});
