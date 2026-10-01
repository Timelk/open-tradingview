import type {ChartController} from '../../lib/chart/controller';
import type {SceneDocument,SceneLayer} from '../../lib/scene/types';

/** User names are opaque. Only an unchanged canonical built-in name is localized. */
export function defaultDisplayName(name:string|undefined,canonical:string|undefined,t:(message:unknown)=>string):string {
  if(!name)return t(canonical??'');
  if(!canonical)return name;
  if(name===canonical)return t(canonical);
  const suffix=name.slice(canonical.length);
  if(name.startsWith(canonical)&&/^( 副本)+$/.test(suffix))return t(canonical)+suffix.replace(/ 副本/g,()=>t(' 副本'));
  return name;
}
export function workspaceLayerName(controller:ChartController,doc:SceneDocument,layer:SceneLayer,t:(message:unknown)=>string):string {
  if(layer.kind==='overlay')return layer.name;
  let canonical:string|undefined;
  if(layer.kind==='drawing')canonical=controller.drawing.registry.get(doc.drawings.find(d=>d.id===layer.id)?.toolId??'')?.name;
  else if(layer.kind==='indicator'){
    const definition=controller.registry.list().find(d=>d.id===doc.indicators.find(i=>i.instanceId===layer.id)?.id);
    if(definition?.source==='builtin')canonical=definition.name;
  }
  else if(layer.kind==='series')canonical=layer.id==='series:candles'?'K 线':layer.id==='series:volume'?'成交量柱':undefined;
  else if(layer.kind==='group')canonical='新建分组';
  return defaultDisplayName(layer.name,canonical,t);
}
/** Output captions from external series or custom plugins are authored
 * content. Only outputs owned by a shipped indicator use the canonical catalog. */
export function workspacePlotName(controller:ChartController,doc:SceneDocument,instanceId:string,name:string,t:(message:unknown)=>string):string {
  const instance=doc.indicators.find(i=>i.instanceId===instanceId);
  const builtin=instance&&controller.registry.list().find(d=>d.id===instance.id)?.source==='builtin';
  return builtin?t(name):name;
}
