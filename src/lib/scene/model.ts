import type { Drawing } from '../drawing/types';
import {migratePatternDisplayParams} from '../patterns/selection';
import { emptyScene, layerOf, TIMEFRAMES, type EffectiveLayer, type SceneDocument, type SceneLayer, type IndicatorPlotStyle } from './types';

/** Paint order is back-to-front. Groups are contiguous blocks, not cosmetic folders. */
export function orderedLayers(doc: SceneDocument, parentId: string | null = null): SceneLayer[] {
  const result: SceneLayer[] = [];
  const children=new Map<string|null,SceneLayer[]>();
  for(const layer of doc.layers){const list=children.get(layer.parentId)??[];list.push(layer);children.set(layer.parentId,list);}
  const visit=(parent:string|null)=>{for(const layer of children.get(parent)??[]){if(layer.kind==='group')visit(layer.id);else result.push(layer);}};
  visit(parentId);
  return result;
}
export function descendants(doc: SceneDocument, id: string): string[] {
  const out: string[] = [];
  const walk = (parent: string) => {
    for (const child of doc.layers.filter(l => l.parentId === parent)) { out.push(child.id); walk(child.id); }
  };
  walk(id); return out;
}
export function effectiveLayer(doc: SceneDocument, id: string, interval: string): EffectiveLayer {
  let layer = doc.layers.find(l => l.id === id);
  const result: EffectiveLayer = { visible: true, locked: false, opacity: 1, reason: '' };
  const visited = new Set<string>();
  if (!layer) return { ...result, visible: false, reason: '图层不存在' };
  while (layer && !visited.has(layer.id)) {
    visited.add(layer.id);
    if (!layer.visible) { result.visible = false; result.reason ||= layer.id === id ? '已隐藏' : '分组已隐藏'; }
    if (layer.intervals && !layer.intervals.includes(interval)) { result.visible = false; result.reason ||= '当前周期不显示'; }
    result.locked ||= layer.locked;
    result.opacity *= layer.opacity;
    layer = layer.parentId ? doc.layers.find(l => l.id === layer!.parentId) : undefined;
  }
  if(result.opacity===0){result.visible=false;result.reason||='透明度为零';}
  return result;
}
export function reconcileDrawings(doc: SceneDocument, drawings: Drawing[]): SceneDocument {
  const previous = new Map(doc.drawings.map(d => [d.id, d]));
  const ids = new Set(drawings.map(d => d.id));
  const layers = doc.layers.filter(l => l.kind !== 'drawing' || ids.has(l.id)).map(l => ({ ...l }));
  for (const drawing of drawings) {
    let layer = layers.find(l => l.id === drawing.id);
    if (!layer) {
      layer = layerOf(drawing.id, 'drawing', '', drawing.paneId, { visible: !drawing.hidden, locked: !!drawing.locked });
      layers.push(layer);
    } else {
      const old = previous.get(drawing.id);
      if (old?.hidden !== drawing.hidden) layer.visible = !drawing.hidden;
      if (old?.locked !== drawing.locked) layer.locked = drawing.locked;
    }
  }
  return { ...doc, layers, drawings };
}
export function normalizeDocument(doc: SceneDocument): SceneDocument {
  const layers = new Map(doc.layers.map(l => [l.id, l]));
  return { ...doc, version: 2,indicators:doc.indicators.map(instance=>['pattern-huzi','pattern-harmonic','pattern-confluence'].includes(instance.id)?{...instance,params:migratePatternDisplayParams(instance.params,instance.id)}:instance), drawings: doc.drawings.map(d => {
    const layer = layers.get(d.id);
    return layer ? { ...d, paneId: layer.paneId, hidden: !layer.visible, locked: layer.locked } : d;
  }) };
}
export function validatePlotStyles(styles:unknown):asserts styles is Record<string,IndicatorPlotStyle> {
  if(!styles||typeof styles!=='object'||Array.isArray(styles))throw Error('无效指标样式');
  for(const [key,value] of Object.entries(styles)){
    if(!/^(0|[1-9]\d?)$/.test(key)||Number(key)>63||!value||typeof value!=='object'||Array.isArray(value))throw Error('无效指标样式序列');
    if(Object.keys(value).some(key=>key!=='color'&&key!=='width'))throw Error('无效指标样式属性');
    const style=value as IndicatorPlotStyle;
    if(style.color!==undefined&&(typeof style.color!=='string'||!/^#[\da-f]{6}$/i.test(style.color)))throw Error('无效指标样式颜色');
    if(style.width!==undefined&&(typeof style.width!=='number'||!Number.isFinite(style.width)||style.width<1||style.width>8))throw Error('无效指标样式线宽');
  }
}

export function validateStructure(doc: SceneDocument): void {
  if (!Array.isArray(doc.layers) || doc.layers.length > 5000 || !Array.isArray(doc.indicators) || doc.indicators.length > 64) throw Error('图层数量超出限制');
  const map = new Map<string, SceneLayer>();
  for (const layer of doc.layers) {
    if (typeof layer.id !== 'string' || !layer.id || map.has(layer.id) || !['series','indicator','drawing','group','overlay'].includes(layer.kind)) throw Error('无效或重复的图层 ID');
    if (typeof layer.name !== 'string' || layer.name.length > 120 || typeof layer.paneId !== 'string' || typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean') throw Error('无效图层属性');
    if (!Object.hasOwn(TIMEFRAMES,layer.createdInterval)) throw Error('无效创建周期');
    if (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) throw Error('透明度必须在 0–1 之间');
    if (layer.intervals !== null && (!Array.isArray(layer.intervals) || layer.intervals.some(i => !Object.hasOwn(TIMEFRAMES,i)))) throw Error('无效周期范围');
    map.set(layer.id, layer);
  }
  for (const layer of doc.layers) {
    let parent = layer.parentId;
    const seen = new Set([layer.id]);
    while (parent !== null) {
      const group = map.get(parent);
      if (!group || group.kind !== 'group' || group.paneId !== layer.paneId || seen.has(parent)) throw Error('分组存在循环、跨窗格引用或无效父级');
      seen.add(parent); parent = group.parentId;
    }
  }
  const drawings = new Set(doc.drawings.map(d => d.id));
  const indicators = new Set<string>();
  for (const instance of doc.indicators) {
    if (typeof instance.instanceId !== 'string' || indicators.has(instance.instanceId) || typeof instance.id !== 'string' || !instance.params || !['chart',...Object.keys(TIMEFRAMES)].includes(instance.timeframe)) throw Error('无效指标实例');
    for (const value of Object.values(instance.params)) if (!['number','string','boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw Error('无效指标参数');
    if (!Array.isArray(instance.hiddenPlots) || instance.hiddenPlots.some(i => !Number.isInteger(i) || i < 0 || i > 64)) throw Error('无效指标序列');
    if(instance.plotStyles!==undefined)validatePlotStyles(instance.plotStyles);
    if (map.get(instance.instanceId)?.kind !== 'indicator') throw Error('指标缺少图层');
    indicators.add(instance.instanceId);
  }
  for (const id of drawings) if (map.get(id)?.kind !== 'drawing') throw Error('绘图缺少图层');
  for (const layer of doc.layers) {
    if (layer.kind === 'drawing' && !drawings.has(layer.id)) throw Error('图层缺少绘图对象');
    if (layer.kind === 'indicator' && !indicators.has(layer.id)) throw Error('图层缺少指标实例');
  }
}
export function fromDrawings(drawings: Drawing[]): SceneDocument { return reconcileDrawings(emptyScene(), drawings); }
