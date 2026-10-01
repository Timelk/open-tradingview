import type { Anchor, Pixel } from './types';
import type { SceneDocument, SceneLayer } from '../scene/types';
import { TIMEFRAMES } from '../scene/types';
import { descendants, effectiveLayer } from '../scene/model';

export interface ChartMenuTarget {
  x:number;y:number;pixel:Pixel;paneId:string;ids:string[];anchor:Anchor|null;
  region:'plot'|'price'|'time'|'separator';market:string;
}
export type VisibilityRange='all'|'current'|'below'|'above';
export function visibilityIntervals(interval:string,range:VisibilityRange):string[]|null {
  if(range==='all')return null;
  if(range==='current')return [interval];
  const duration=TIMEFRAMES[interval];
  return Object.keys(TIMEFRAMES).filter(key=>range==='below'?TIMEFRAMES[key]<=duration:TIMEFRAMES[key]>=duration);
}

/** Menu commands include descendants in lock checks. Engine commands also serve
 * property editors, so context menus must not treat a parent's lock as editable. */
export function layerActionState(doc:SceneDocument,ids:string[],interval:string,allDrawingsLocked=false) {
  const selected=doc.layers.filter(layer=>ids.includes(layer.id));
  const allIds=new Set(selected.flatMap(layer=>[layer.id,...descendants(doc,layer.id)]));
  const affected=doc.layers.filter(layer=>allIds.has(layer.id));
  const globalLock=allDrawingsLocked&&affected.some(layer=>layer.kind==='drawing');
  const inherited=selected.some(layer=>{
    let parent=layer.parentId;
    while(parent){const ancestor=doc.layers.find(item=>item.id===parent);if(!ancestor)break;if(ancestor.locked)return true;parent=ancestor.parentId;}
    return false;
  });
  const locked=globalLock||affected.some(layer=>effectiveLayer(doc,layer.id,interval).locked);
  const samePane=selected.length>0&&selected.every(layer=>layer.paneId===selected[0].paneId);
  return {
    selected,affected,locked,inherited:inherited||globalLock,
    lockLabel:globalLock?'全部绘图已锁定':inherited?'由上级分组锁定':selected.every(layer=>layer.locked)?'解锁':'锁定',
    canClone:selected.length>0&&!affected.some(layer=>layer.kind==='series'||layer.kind==='overlay'),
    canGroup:samePane&&!locked,
    canRemove:selected.length>0&&!locked&&!affected.some(layer=>layer.kind==='series'||layer.kind==='overlay'),
    canUnlock:selected.length>0&&!inherited&&!globalLock,
    groups:doc.layers.filter(layer=>layer.kind==='group'&&samePane&&layer.paneId===selected[0].paneId&&!allIds.has(layer.id)&&!effectiveLayer(doc,layer.id,interval).locked),
  };
}
export function contextSelection(current:string[],hitId:string|null,doc:SceneDocument):string[] {
  if(!hitId||!doc.layers.some(layer=>layer.id===hitId))return [];
  return current.includes(hitId)?current.filter(id=>doc.layers.some(layer=>layer.id===id)):[hitId];
}
export function paneDrawingIds(doc:SceneDocument,paneId:string,interval:string,unlockedOnly=false):string[] {
  return doc.layers.filter(layer=>layer.kind==='drawing'&&layer.paneId===paneId&&(!unlockedOnly||!effectiveLayer(doc,layer.id,interval).locked)).map(layer=>layer.id);
}
export function contextLayerName(layer:SceneLayer|undefined,count:number):string {
  return count>1?`${count} 个选中对象`:layer?.name||'图表操作';
}
