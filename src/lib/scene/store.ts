import type { Drawing } from '../drawing/types';
import { emptyScene, type SceneDocument, type IndicatorPlotStyle } from './types';
import { normalizeDocument, reconcileDrawings, validateStructure, validatePlotStyles } from './model';
import { validDrawingFontSize } from '../drawing/labels';

function scalar<T extends string|number|boolean>(value:T):T {
  if(!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw Error('工作区包含无效属性值');
  return value;
}
function copyValues(values:Drawing['props']):Drawing['props'] {
  if(!values||typeof values!=='object'||Array.isArray(values))throw Error('工作区包含无效属性');
  return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,scalar(value)]));
}
function copyPlotStyles(styles:Record<string,IndicatorPlotStyle>):Record<string,IndicatorPlotStyle> {
  validatePlotStyles(styles);
  return Object.fromEntries(Object.entries(styles).map(([index,style])=>[index,{
    ...(style.color!==undefined?{color:style.color}:{}),...(style.width!==undefined?{width:style.width}:{}),
  }]));
}
/** Read reactive UI proxies through the known scene fields. Every persisted
 * array/object is owned plain data before validation or history mutation. */
function copyDocument(doc:SceneDocument):SceneDocument {
  return {
    version:scalar(doc.version),
    layers:doc.layers.map(l=>({id:scalar(l.id),kind:scalar(l.kind),name:scalar(l.name),paneId:scalar(l.paneId),
      parentId:l.parentId===null?null:scalar(l.parentId),visible:scalar(l.visible),locked:scalar(l.locked),opacity:scalar(l.opacity),
      intervals:l.intervals===null?null:l.intervals.map(scalar),createdInterval:scalar(l.createdInterval)})),
    indicators:doc.indicators.map(i=>({instanceId:scalar(i.instanceId),id:scalar(i.id),params:copyValues(i.params),
      timeframe:scalar(i.timeframe),hiddenPlots:i.hiddenPlots.map(scalar),...(i.plotStyles!==undefined?{plotStyles:copyPlotStyles(i.plotStyles)}:{})})),
    drawings:doc.drawings.map(d=>{
      if(d.style.fontSize!==undefined&&!validDrawingFontSize(d.style.fontSize))throw Error('绘图字号必须在 12–32 px 之间');
      const points=d.points.map(p=>{
        if(!Number.isFinite(p.time)||!Number.isFinite(p.value))throw Error('工作区包含无效绘图坐标');
        return {time:p.time,value:p.value};
      });
      return {id:scalar(d.id),toolId:scalar(d.toolId),paneId:scalar(d.paneId),points,
        style:{color:scalar(d.style.color),width:scalar(d.style.width),dash:scalar(d.style.dash),fillOpacity:scalar(d.style.fillOpacity),...(d.style.fontSize!==undefined?{fontSize:d.style.fontSize}:{})},
        props:copyValues(d.props),locked:scalar(d.locked),hidden:scalar(d.hidden)};
    }),
  };
}

/** One history owns drawing payloads, indicators, groups and visual order. */
export class SceneStore {
  private current: SceneDocument = emptyScene();
  private past: SceneDocument[] = [];
  private future: SceneDocument[] = [];
  private previewBase: SceneDocument | null = null;
  get isPreviewing(): boolean { return this.previewBase !== null; }
  get items(): readonly Drawing[] { return this.current.drawings; }
  get document(): SceneDocument { return this.current; }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  commit(drawings: Drawing[]): void { this.commitDocument(reconcileDrawings(this.current, drawings)); }
  commitDocument(document: SceneDocument): void {
    const next = normalizeDocument(copyDocument(document)); validateStructure(next);
    if(this.previewBase){this.current=next;return;}
    const previous=structuredClone(this.current);
    this.past.push(previous); if(this.past.length>80)this.past.shift();
    this.current=next; this.future=[];
  }
  replace(drawings: Drawing[]): void { this.replaceDocument(reconcileDrawings(emptyScene(), drawings)); }
  replaceDocument(document: SceneDocument): void {
    const next=normalizeDocument(copyDocument(document));validateStructure(next);
    this.previewBase=null; this.current=next; this.past=[]; this.future=[];
  }
  beginPreview(): void {
    if(this.previewBase)throw Error('已有属性编辑正在进行');
    this.previewBase=structuredClone(this.current);
  }
  finishPreview(apply:boolean): boolean {
    const base=this.previewBase;if(!base)return false;this.previewBase=null;
    const changed=JSON.stringify(base)!==JSON.stringify(this.current);
    if(!apply){this.current=base;return false;}
    if(changed){this.past.push(base);if(this.past.length>80)this.past.shift();this.future=[];}
    return changed;
  }
  undo(): void { if(this.previewBase)return; const doc=this.past.pop(); if(doc){this.future.push(this.current);this.current=doc;} }
  redo(): void { if(this.previewBase)return; const doc=this.future.pop(); if(doc){this.past.push(this.current);this.current=doc;} }
}
