import type { DockZone } from './layout';

export interface PanelDefinition<T> { id:string;title:string;icon:string;component:T;defaultZone?:DockZone;preferredSize?:number;minWidth?:number;minHeight?:number;allowedZones?:readonly DockZone[];motionPolicy?:'surface'|'none';
  /** Task group used to order and separate panel entry points (rail, tabs). */
  group?:string }
/** Renderer-agnostic component registry. Layout storage keeps IDs independently
 * of installation state; get() therefore intentionally returns undefined. */
export class PanelRegistry<T> {
  private panels=new Map<string,PanelDefinition<T>>();
  private listeners=new Set<(panels:PanelDefinition<T>[])=>void>();
  register(definition:PanelDefinition<T>):()=>void {
    const {id,title,icon,component,defaultZone,preferredSize,minWidth,minHeight,allowedZones,motionPolicy,group}=definition;
    if(typeof id!=='string'||!id||id.length>128||/[\s\u0000-\u001f]/u.test(id))throw Error('无效面板 ID');
    if(this.panels.has(id))throw Error(`面板已注册：${id}`);
    if(typeof title!=='string'||!title.trim()||title.trim().length>120||typeof icon!=='string'||!icon.trim()||component===undefined||component===null)throw Error('无效面板定义');
    if(defaultZone!==undefined&&!['left','right','bottom'].includes(defaultZone))throw Error('无效默认面板区域');
    if([preferredSize,minWidth,minHeight].some(value=>value!==undefined&&(!Number.isFinite(value)||value<120||value>800)))throw Error('无效面板尺寸约束');
    if(allowedZones&&(!allowedZones.length||allowedZones.some(zone=>!['left','right','bottom'].includes(zone))||new Set(allowedZones).size!==allowedZones.length||defaultZone&&!allowedZones.includes(defaultZone)))throw Error('无效允许停靠区域');
    if(motionPolicy!==undefined&&!['surface','none'].includes(motionPolicy))throw Error('无效面板动效策略');
    if(group!==undefined&&(typeof group!=='string'||!group.trim()||group.length>32))throw Error('无效面板分组');
    const panel={id,title:title.trim(),icon:icon.trim(),component,...(allowedZones?{allowedZones:[...allowedZones]}:{}),...(motionPolicy?{motionPolicy}:{}),...(group?{group:group.trim()}:{}),...(defaultZone?{defaultZone}:{}),...(preferredSize?{preferredSize}:{}),...(minWidth?{minWidth}:{}),...(minHeight?{minHeight}:{})};
    this.panels.set(id,panel);this.emit();let removed=false;
    return ()=>{if(removed)return;removed=true;if(this.panels.get(id)===panel){this.panels.delete(id);this.emit();}};
  }
  get(id:string):PanelDefinition<T>|undefined {const panel=this.panels.get(id);return panel?{...panel,...(panel.allowedZones?{allowedZones:[...panel.allowedZones]}:{})}:undefined;}
  list():PanelDefinition<T>[] {return [...this.panels.values()].map(panel=>({...panel,...(panel.allowedZones?{allowedZones:[...panel.allowedZones]}:{})}));}
  subscribe(listener:(panels:PanelDefinition<T>[])=>void):()=>void {this.listeners.add(listener);listener(this.list());return ()=>{this.listeners.delete(listener);};}
  private emit():void {for(const listener of this.listeners)listener(this.list());}
}
