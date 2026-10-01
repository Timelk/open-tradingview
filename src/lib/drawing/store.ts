import type { Drawing } from './types';
import type { ToolRegistry } from './registry';
import { validDrawingFontSize } from './labels';
export { SceneStore as DrawingStore } from '../scene/store';

/** Atomic validation before import/storage restoration. Unknown plugins are kept
 * in the document and can render after their definition is registered later. */
export function parseDrawingDocument(text:string,registry:ToolRegistry):Drawing[] {
  const value:unknown=JSON.parse(text);
  if(!value||typeof value!=='object'||!('version'in value)||value.version!==1||!('drawings'in value)||!Array.isArray(value.drawings)||value.drawings.length>2000)throw new Error('不支持的绘图文件');
  const seen=new Set<string>();
  return value.drawings.map((raw:unknown)=>{
    if(!raw||typeof raw!=='object')throw new Error('无效绘图对象');
    const d=raw as Drawing;
    if(typeof d.id!=='string'||seen.has(d.id)||typeof d.toolId!=='string'||typeof d.paneId!=='string'||!Array.isArray(d.points)||!d.points.length||d.points.length>2048)throw new Error('无效绘图标识或坐标');
    seen.add(d.id);
    for(const p of d.points)if(!p||!Number.isFinite(p.time)||!Number.isFinite(p.value))throw new Error('无效坐标');
    if(!d.style||!/^#[\da-f]{6}$/i.test(d.style.color)||!Number.isFinite(d.style.width)||d.style.width<1||d.style.width>8||!['solid','dashed','dotted'].includes(d.style.dash)||!Number.isFinite(d.style.fillOpacity)||d.style.fillOpacity<0||d.style.fillOpacity>1)throw new Error('无效绘图样式');
    if(d.style.fontSize!==undefined&&!validDrawingFontSize(d.style.fontSize))throw new Error('绘图字号必须在 12–32 px 之间');
    if(!d.props||typeof d.props!=='object'||Array.isArray(d.props))throw new Error('无效绘图属性');
    for(const v of Object.values(d.props))if(!['string','number','boolean'].includes(typeof v)||(typeof v==='number'&&!Number.isFinite(v))||(typeof v==='string'&&v.length>2000))throw new Error('无效属性值');
    const tool=registry.get(d.toolId);
    if(tool?.mode&&tool.mode!=='draw')throw new Error('游标不能保存为绘图');
    return {id:d.id,toolId:d.toolId,paneId:d.paneId,points:d.points.map(p=>({time:p.time,value:p.value})),style:{...d.style},props:{...d.props},locked:!!d.locked,hidden:!!d.hidden};
  });
}
