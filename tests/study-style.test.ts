import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyScene, layerOf, type IndicatorPlotStyle } from '../src/lib/scene/types';
import { SceneStore } from '../src/lib/scene/store';
import { parseSceneDocument } from '../src/lib/scene/serialization';
import { DrawingEngine } from '../src/lib/drawing/engine';
import { ToolRegistry } from '../src/lib/drawing/registry';
import type { DrawingHost } from '../src/lib/drawing/types';

function document(){
  const doc=emptyScene();doc.layers.push(layerOf('study','indicator','MACD','macd'));
  doc.indicators.push({instanceId:'study',id:'macd',params:{fast:12,slow:26,signal:9},timeframe:'chart',hiddenPlots:[]});return doc;
}
const styles:Record<string,IndicatorPlotStyle>={'0':{color:'#AABBCC',width:1.5},'2':{color:'#ef5350'},'63':{width:8}};
beforeEach(()=>{const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)});});
afterEach(()=>vi.unstubAllGlobals());

describe('indicator style document compatibility',()=>{
  it('keeps older v2 indicators unchanged when no plot overrides were saved',()=>{
    const old=document(),parsed=parseSceneDocument(JSON.stringify(old),new ToolRegistry()),store=new SceneStore();store.replaceDocument(parsed);
    expect(parsed).toEqual(old);expect(store.document).toEqual(old);expect(store.document.indicators[0]).not.toHaveProperty('plotStyles');
  });
  it('round-trips independent output overrides and hidden plots through the existing v2 format',()=>{
    const doc=document();doc.indicators[0].plotStyles=styles;doc.indicators[0].hiddenPlots=[1];
    const parsed=parseSceneDocument(JSON.stringify(doc),new ToolRegistry()),store=new SceneStore();store.replaceDocument(parsed);
    expect(store.document).toEqual(doc);expect(JSON.parse(JSON.stringify(store.document)).indicators[0].plotStyles).toEqual(styles);
  });
  it('copies Proxy style maps and values into isolated plain snapshots',()=>{
    const store=new SceneStore(),doc=document(),style={color:'#123456',width:3};
    doc.indicators[0].plotStyles=new Proxy({'0':new Proxy(style,{})},{});store.replaceDocument(doc);
    expect(()=>structuredClone(store.document)).not.toThrow();style.color='#654321';style.width=6;
    expect(store.document.indicators[0].plotStyles).toEqual({'0':{color:'#123456',width:3}});
    const next={...store.document,indicators:store.document.indicators.map(i=>({...i,plotStyles:new Proxy({'2':new Proxy({color:'#ef5350',width:4},{})},{})}))};
    store.commitDocument(next);expect(()=>structuredClone(store.document)).not.toThrow();store.undo();expect(store.document.indicators[0].plotStyles).toEqual({'0':{color:'#123456',width:3}});
  });
  it('allows clearing individual inherited fields without persisting undefined values',()=>{
    const store=new SceneStore(),doc=document();doc.indicators[0].plotStyles={'0':{color:undefined,width:undefined},'1':{color:'#123456',width:undefined}};
    store.replaceDocument(doc);expect(store.document.indicators[0].plotStyles).toEqual({'0':{},'1':{color:'#123456'}});
  });
});

describe('invalid output styles cannot alter current state or history',()=>{
  const invalid:[string,unknown][]=[
    ['out-of-range index',{'64':{color:'#123456'}}],['negative index',{'-1':{width:2}}],['fractional index',{'1.5':{width:2}}],['noncanonical index',{'01':{width:2}}],
    ['named index',{line:{width:2}}],['short color',{'0':{color:'#abc'}}],['named color',{'0':{color:'red'}}],['invalid hex',{'0':{color:'#zzzzzz'}}],
    ['zero width',{'0':{width:0}}],['excess width',{'0':{width:9}}],['non-finite width',{'0':{width:NaN}}],['string width',{'0':{width:'2'}}],
    ['null style',{'0':null}],['array style',{'0':[]}],['unknown style field',{'0':{opacity:.5}}],['array map',[]],['null map',null],
  ];
  it.each(invalid)('rejects %s atomically',(_name,bad)=>{
    const store=new SceneStore(),original=document();store.replaceDocument(original);
    const valid=structuredClone(original);valid.indicators[0].plotStyles=styles;store.commitDocument(valid);store.undo();
    const next=structuredClone(original);next.indicators[0].plotStyles=bad as Record<string,IndicatorPlotStyle>;
    expect(()=>store.commitDocument(next)).toThrow(/样式/);expect(store.document).toEqual(original);expect(store.canUndo).toBe(false);expect(store.canRedo).toBe(true);
    store.redo();expect(store.document).toEqual(valid);store.undo();expect(store.document).toEqual(original);expect(store.canUndo).toBe(false);
  });
  it('rejects malformed imported styles using the same rules as a local commit',()=>{
    const doc=document();doc.indicators[0].plotStyles={'64':{width:2}};
    expect(()=>parseSceneDocument(JSON.stringify(doc),new ToolRegistry())).toThrow(/样式/);
  });
  it('retains an active preview and its cancellation baseline after invalid replacement',()=>{
    const store=new SceneStore(),original=document();store.replaceDocument(original);store.beginPreview();
    const preview=structuredClone(original);preview.indicators[0].plotStyles=styles;store.commitDocument(preview);
    const bad=structuredClone(original);bad.indicators[0].plotStyles={'0':{width:12}};
    expect(()=>store.replaceDocument(bad)).toThrow(/样式/);expect(store.isPreviewing).toBe(true);expect(store.document).toEqual(preview);
    store.finishPreview(false);expect(store.document).toEqual(original);expect(store.canUndo).toBe(false);
  });
});

it('previews styles and per-output visibility together, cancels cleanly and confirms as one undo step',()=>{
  const host:DrawingHost={paneAt:()=>null,projection:()=>null,anchorAt:()=>null,zoomTo:()=>{}};
  const engine=new DrawingEngine(new ToolRegistry(),host,()=>{},document);engine.setMarket('mock:STUDY');engine.selectLayers(['study']);const original=structuredClone(engine.document);
  const edit=()=>engine.transact(doc=>({...doc,indicators:doc.indicators.map(i=>({...i,plotStyles:{'0':{color:'#654321',width:4}},hiddenPlots:[1]}))}));
  const cancelled=engine.beginPropertyEdit(['study']);edit();expect(engine.document.indicators[0].plotStyles).toEqual({'0':{color:'#654321',width:4}});
  expect(localStorage.getItem('tvchart.workspace.v2:mock:STUDY')).toBeNull();cancelled.cancel();expect(engine.document).toEqual(original);
  const confirmed=engine.beginPropertyEdit(['study']);edit();
  engine.transact(doc=>({...doc,indicators:doc.indicators.map(i=>({...i,plotStyles:{...i.plotStyles,'2':{color:'#26a69a',width:2}}}))}));
  const expected=structuredClone(engine.document);confirmed.commit();expect(JSON.parse(localStorage.getItem('tvchart.workspace.v2:mock:STUDY')!).indicators).toEqual(expected.indicators);
  engine.undo();expect(engine.document).toEqual(original);expect(engine.state.canUndo).toBe(false);engine.redo();expect(engine.document).toEqual(expected);
  const restored=new DrawingEngine(new ToolRegistry(),host,()=>{},document);restored.setMarket('mock:STUDY');expect(restored.document).toEqual(expected);restored.destroy();engine.destroy();
});
