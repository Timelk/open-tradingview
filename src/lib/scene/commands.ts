import { descendants, effectiveLayer, validateStructure } from './model';
import { layerOf, type SceneDocument, type SceneLayer } from './types';

export function topSelection(doc: SceneDocument, ids: string[]): SceneLayer[] {
  const set = new Set(ids);
  return doc.layers.filter(layer => set.has(layer.id) && !ids.some(id => id !== layer.id && descendants(doc, id).includes(layer.id)));
}
export function updateLayers(doc: SceneDocument, ids: string[], patch: Partial<Pick<SceneLayer,'name'|'visible'|'locked'|'opacity'|'intervals'>>): SceneDocument {
  const set = new Set(ids);
  const next = { ...doc, layers: doc.layers.map(l => set.has(l.id) ? { ...l, ...patch } : l) };
  validateStructure(next); return next;
}
export function groupLayers(doc: SceneDocument, ids: string[], name: string, paneId = 'main'): { document: SceneDocument; id: string } {
  const selected = topSelection(doc, ids);
  if (selected.length && selected.some(l => l.paneId !== selected[0].paneId)) throw Error('请选择同一窗格内的对象分组');
  const pane = selected[0]?.paneId ?? paneId;
  const id = crypto.randomUUID();
  const parent = selected.length && selected.every(l => l.parentId === selected[0].parentId) ? selected[0].parentId : null;
  const group = layerOf(id, 'group', name || '新建分组', pane, { parentId: parent });
  const set = new Set(selected.map(l => l.id));
  const layers = doc.layers.map(l => set.has(l.id) ? { ...l, parentId: id } : l);
  layers.push(group);
  const next = { ...doc, layers }; validateStructure(next);
  return { document: next, id };
}
export function moveToGroup(doc: SceneDocument, ids: string[], parentId: string | null): SceneDocument {
  const selected = topSelection(doc, ids), group = doc.layers.find(l => l.id === parentId);
  if (parentId && (!group || group.kind !== 'group')) throw Error('目标分组不存在');
  if (selected.some(l => l.id === parentId || descendants(doc, l.id).includes(parentId ?? ''))) throw Error('不能将分组移入自身或子分组');
  if (group && selected.some(l => l.paneId !== group.paneId)) throw Error('只能移入同一窗格的分组');
  const set = new Set(selected.map(l => l.id));
  const next = { ...doc, layers: [...doc.layers.filter(l => !set.has(l.id)), ...selected.map(l => ({ ...l, parentId }))] };
  validateStructure(next); return next;
}
export function reorderLayers(doc: SceneDocument, ids: string[], direction: 'front'|'back'|'forward'|'backward'): SceneDocument {
  const selected = topSelection(doc, ids), set = new Set(selected.map(l => l.id));
  const layers = [...doc.layers];
  const scopes = new Set(selected.map(l => `${l.paneId}|${l.parentId ?? ''}`));
  for (const scope of scopes) {
    const slots = layers.map((l,i)=>({l,i})).filter(({l})=>`${l.paneId}|${l.parentId ?? ''}`===scope);
    let siblings = slots.map(s=>s.l);
    if (direction === 'front') siblings = [...siblings.filter(l=>!set.has(l.id)),...siblings.filter(l=>set.has(l.id))];
    else if (direction === 'back') siblings = [...siblings.filter(l=>set.has(l.id)),...siblings.filter(l=>!set.has(l.id))];
    else if (direction === 'forward') { for(let i=siblings.length-2;i>=0;i--) if(set.has(siblings[i].id)&&!set.has(siblings[i+1].id)) [siblings[i],siblings[i+1]]=[siblings[i+1],siblings[i]]; }
    else { for(let i=1;i<siblings.length;i++) if(set.has(siblings[i].id)&&!set.has(siblings[i-1].id)) [siblings[i],siblings[i-1]]=[siblings[i-1],siblings[i]]; }
    slots.forEach((slot,i)=>layers[slot.i]=siblings[i]);
  }
  return { ...doc, layers };
}
export function ungroup(doc: SceneDocument, id: string): SceneDocument {
  const group = doc.layers.find(l=>l.id===id); if(group?.kind!=='group')return doc;
  // Preserve the group's current inherited state on immediate children.
  return { ...doc, layers: doc.layers.filter(l=>l.id!==id).map(l=>l.parentId===id?{...l,parentId:group.parentId,visible:l.visible&&group.visible,locked:l.locked||group.locked,opacity:l.opacity*group.opacity,
    intervals:group.intervals===null?l.intervals:l.intervals===null?group.intervals:l.intervals.filter(i=>group.intervals!.includes(i))}:l) };
}
export function deleteLayers(doc: SceneDocument, ids: string[], interval: string): SceneDocument {
  const remove = new Set<string>();
  for(const layer of topSelection(doc,ids)) {
    const all = [layer.id,...descendants(doc,layer.id)];
    if(all.some(id=>effectiveLayer(doc,id,interval).locked))continue;
    all.forEach(id=>remove.add(id));
  }
  return { ...doc, layers: doc.layers.filter(l=>!remove.has(l.id)), drawings: doc.drawings.filter(d=>!remove.has(d.id)), indicators: doc.indicators.filter(i=>!remove.has(i.instanceId)) };
}

export function placeRelative(doc:SceneDocument,ids:string[],targetId:string,inFront:boolean):SceneDocument {
  const selected=topSelection(doc,ids),target=doc.layers.find(l=>l.id===targetId);if(!target)return doc;
  if(selected.some(l=>l.id===targetId||descendants(doc,l.id).includes(targetId)))throw Error('不能拖入自身');
  if(selected.some(l=>l.paneId!==target.paneId))throw Error('跨窗格对象请分别调整层级');
  const selectedIds=new Set(selected.map(l=>l.id));
  const layers=doc.layers.filter(l=>!selectedIds.has(l.id));
  const index=layers.findIndex(l=>l.id===targetId)+(inFront?1:0);
  layers.splice(index,0,...selected.map(l=>({...l,parentId:target.parentId})));
  const next={...doc,layers};validateStructure(next);return next;
}
