export type DockZone='left'|'right'|'bottom';
export type WorkspacePreset='standard'|'analysis'|'focus'|'orderflow';
export interface NamedLayout {id:string;name:string;layout:WorkspaceLayout}
export interface DockLayout { size:number;open:boolean;active:string|null;panels:string[] }
export interface WorkspaceLayout {
  version:1;density:'compact'|'comfortable';drawingTools:boolean;quoteHeader:boolean;
  zones:Record<DockZone,DockLayout>;hidden:string[];
}
export interface WorkspaceLayoutStorage { getItem(key:string):string|null;setItem(key:string,value:string):void }
export const WORKSPACE_LAYOUT_STORAGE_KEY='tvchart.workspace-layout.v1';
export const DOCK_ZONES:readonly DockZone[]=['left','right','bottom'];
export const DOCK_SIZE_LIMITS:Record<DockZone,{min:number;max:number}>={left:{min:180,max:800},right:{min:180,max:800},bottom:{min:120,max:600}};
const DEFAULT_SIZES:Record<DockZone,number>={left:260,right:320,bottom:220};
const BUILTIN_PANELS=['watchlist','objects','data'];
const RETIRED_PANELS=new Set(['pine-editor','backtest-report']);
const panelId=(id:unknown):id is string=>typeof id==='string'&&id.length>0&&id.length<=128&&!/[\s\u0000-\u001f]/u.test(id);
const isZone=(zone:unknown):zone is DockZone=>DOCK_ZONES.includes(zone as DockZone);
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

export function defaultWorkspaceLayout():WorkspaceLayout {
  return {version:1,density:'compact',drawingTools:true,quoteHeader:true,
    zones:{left:{size:260,open:false,active:null,panels:[]},right:{size:320,open:true,active:'watchlist',panels:[...BUILTIN_PANELS]},bottom:{size:220,open:false,active:null,panels:[]}},hidden:[]};
}
function copy(layout:WorkspaceLayout):WorkspaceLayout {
  return {version:1,density:layout.density,drawingTools:layout.drawingTools,quoteHeader:layout.quoteHeader,
    zones:{left:{...layout.zones.left,panels:[...layout.zones.left.panels]},right:{...layout.zones.right,panels:[...layout.zones.right.panels]},bottom:{...layout.zones.bottom,panels:[...layout.zones.bottom.panels]}},hidden:[...layout.hidden]};
}
function reconcileActive(layout:WorkspaceLayout):void {
  for(const zone of DOCK_ZONES){
    const dock=layout.zones[zone],visible=dock.panels.filter(id=>!layout.hidden.includes(id));
    if(!dock.active||!visible.includes(dock.active))dock.active=visible[0]??null;
    if(!dock.active)dock.open=false;
  }
}
function parse(value:unknown):WorkspaceLayout|null {
  if(!record(value)||value.version!==1||!['compact','comfortable'].includes(String(value.density))||typeof value.drawingTools!=='boolean'||typeof value.quoteHeader!=='boolean'||!record(value.zones)||!Array.isArray(value.hidden))return null;
  if(Object.keys(value.zones).length!==DOCK_ZONES.length)return null;
  const ids=new Set<string>(),zones={} as Record<DockZone,DockLayout>;
  for(const zone of DOCK_ZONES){
    const raw=value.zones[zone],limits=DOCK_SIZE_LIMITS[zone];
    if(!record(raw)||typeof raw.size!=='number'||!Number.isFinite(raw.size)||raw.size<limits.min||raw.size>limits.max||typeof raw.open!=='boolean'||!Array.isArray(raw.panels))return null;
    if(raw.active!==null&&!panelId(raw.active))return null;
    const panels:string[]=[];
    for(const id of raw.panels){if(!panelId(id)||ids.has(id)||ids.size>=256)return null;ids.add(id);panels.push(id);}
    if(raw.active!==null&&!panels.includes(raw.active))return null;
    zones[zone]={size:raw.size,open:raw.open,active:raw.active,panels};
  }
  const hidden:string[]=[];
  for(const id of value.hidden){if(!panelId(id)||!ids.has(id)||hidden.includes(id))return null;hidden.push(id);}
  const result:WorkspaceLayout={version:1,density:value.density as WorkspaceLayout['density'],drawingTools:value.drawingTools,quoteHeader:value.quoteHeader,zones,hidden};
  for(const zone of DOCK_ZONES){result.zones[zone].panels=result.zones[zone].panels.filter(id=>!RETIRED_PANELS.has(id));}
  result.hidden=result.hidden.filter(id=>!RETIRED_PANELS.has(id));
  reconcileActive(result);return result;
}
function browserStorage():WorkspaceLayoutStorage|null {
  try{return typeof localStorage==='undefined'?null:localStorage;}catch{return null;}
}
/** Read only: invalid/unavailable storage never gets overwritten during load. */
export function loadWorkspaceLayout(storage:Pick<WorkspaceLayoutStorage,'getItem'>|null=browserStorage()):WorkspaceLayout {
  try{const raw=storage?.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);return raw?parse(JSON.parse(raw))??defaultWorkspaceLayout():defaultWorkspaceLayout();}
  catch{return defaultWorkspaceLayout();}
}
export function clampDockSize(zone:DockZone,size:number):number {
  const limits=DOCK_SIZE_LIMITS[zone];
  return Number.isFinite(size)?Math.max(limits.min,Math.min(limits.max,Math.round(size))):DEFAULT_SIZES[zone];
}
function location(layout:WorkspaceLayout,id:string):DockZone|undefined {return DOCK_ZONES.find(zone=>layout.zones[zone].panels.includes(id));}
function preset(current:WorkspaceLayout,name:WorkspacePreset,resetDensity=false):WorkspaceLayout {
  if(name==='focus'){
    const next=copy(current);for(const zone of DOCK_ZONES)next.zones[zone].open=false;next.drawingTools=false;next.quoteHeader=false;return next;
  }
  const next=defaultWorkspaceLayout();if(!resetDensity)next.density=current.density;
  if(name==='orderflow'){next.zones.right={size:380,open:true,active:'orderbook',panels:['watchlist','orderbook','objects','data']};}
  if(name==='analysis')next.zones.right={size:360,open:true,active:'patterns',panels:['watchlist','objects','data','patterns']};
  // A preset knows the built-ins only; keep plugin registrations and masks so
  // temporarily uninstalled plugins regain their last assigned dock later.
  for(const zone of DOCK_ZONES)for(const id of current.zones[zone].panels)if(!BUILTIN_PANELS.includes(id)&&!location(next,id))next.zones[zone].panels.push(id);
  next.hidden=current.hidden.filter(id=>!BUILTIN_PANELS.includes(id)&&!DOCK_ZONES.some(zone=>next.zones[zone].open&&next.zones[zone].active===id));
  reconcileActive(next);return next;
}

export class WorkspaceLayoutStore {
  private current:WorkspaceLayout;
  private listeners=new Set<(layout:WorkspaceLayout)=>void>();
  private storage:WorkspaceLayoutStorage|null;
  private destroyed=false;
  private pendingSave=false;
  private problem='';
  private past:WorkspaceLayout[]=[];private future:WorkspaceLayout[]=[];private checkpoint:WorkspaceLayout|null=null;
  private named:NamedLayout[]=[];
  constructor(storage:WorkspaceLayoutStorage|null=browserStorage()) {this.storage=storage;this.current=loadWorkspaceLayout(storage);try{const raw=JSON.parse(storage?.getItem('tvchart.named-layouts.v1')??'[]');if(Array.isArray(raw))this.named=raw.slice(0,20).flatMap(item=>{const layout=parse(item?.layout);return layout&&typeof item.id==='string'&&typeof item.name==='string'&&item.name.length<=80?[{id:item.id,name:item.name,layout}]:[];});}catch{}}
  get snapshot():WorkspaceLayout{return copy(this.current);}
  get error():string{return this.problem;}
  get canUndo():boolean{return this.past.length>0||!!this.checkpoint;}
  get canRedo():boolean{return this.future.length>0;}
  get namedLayouts():NamedLayout[]{return this.named.map(item=>({...item,layout:copy(item.layout)}));}
  undo():boolean{if(this.destroyed)return false;if(this.checkpoint)this.persist();const previous=this.past.pop();if(!previous)return false;this.future.push(copy(this.current));this.current=previous;this.checkpoint=null;this.pendingSave=true;this.persist();this.emit();return true;}
  redo():boolean{if(this.destroyed)return false;const next=this.future.pop();if(!next)return false;this.past.push(copy(this.current));this.current=next;this.checkpoint=null;this.pendingSave=true;this.persist();this.emit();return true;}
  saveNamed(name:string):boolean{if(this.destroyed)return false;const clean=name.trim();if(!clean||clean.length>80||this.named.length>=20){this.problem='请输入 1–80 字的名称，最多保存 20 份布局';this.emit();return false;}if(this.named.some(item=>item.name===clean)){this.problem='已有同名布局，请使用新名称';this.emit();return false;}const next=[...this.named,{id:crypto.randomUUID(),name:clean,layout:copy(this.current)}];try{if(!this.storage)throw Error();this.storage.setItem('tvchart.named-layouts.v1',JSON.stringify(next));this.named=next;this.problem='';this.emit();return true;}catch{this.problem='命名布局保存失败，请导出备份';this.emit();return false;}}
  removeNamed(id:string):boolean{if(this.destroyed||!this.named.some(item=>item.id===id))return false;const next=this.named.filter(item=>item.id!==id);try{if(!this.storage)throw Error();this.storage.setItem('tvchart.named-layouts.v1',JSON.stringify(next));this.named=next;this.problem='';this.emit();return true;}catch{this.problem='布局列表保存失败，原记录已保留';this.emit();return false;}}
  loadNamed(id:string):boolean{const item=this.named.find(item=>item.id===id);return item?this.replace(copy(item.layout)):false;}
  exportLayout():string{return JSON.stringify({format:'tvchart-layout',version:1,layout:this.current},null,2);}
  importLayout(source:string):boolean{if(this.destroyed)return false;try{const raw=JSON.parse(source),layout=parse(raw?.format==='tvchart-layout'&&raw.version===1?raw.layout:raw);if(!layout)throw Error();this.replace(layout);return true;}catch{this.problem='布局文件格式无效，当前布局未改变';this.emit();return false;}}
  subscribe(listener:(layout:WorkspaceLayout)=>void):()=>void {
    if(this.destroyed)return ()=>{};this.listeners.add(listener);listener(this.snapshot);return ()=>{this.listeners.delete(listener);};
  }
  openPanel(id:string,defaultZone:DockZone='right'):boolean {
    if(!panelId(id)||RETIRED_PANELS.has(id)||!isZone(defaultZone))return false;
    return this.change(next=>{const zone=location(next,id)??defaultZone,dock=next.zones[zone];if(!dock.panels.includes(id))dock.panels.push(id);next.hidden=next.hidden.filter(value=>value!==id);dock.active=id;dock.open=true;});
  }
  togglePanel(id:string,defaultZone:DockZone='right'):boolean {
    if(!panelId(id)||RETIRED_PANELS.has(id)||!isZone(defaultZone))return false;
    const zone=location(this.current,id);
    if(zone&&this.current.zones[zone].open&&this.current.zones[zone].active===id&&!this.current.hidden.includes(id))return this.setZoneOpen(zone,false);
    return this.openPanel(id,defaultZone);
  }
  setPlacement(id:string,placement:DockZone|'hidden'):boolean {
    if(!panelId(id)||RETIRED_PANELS.has(id)||(placement!=='hidden'&&!isZone(placement)))return false;
    return this.change(next=>{
      if(placement==='hidden'){
        if(!location(next,id))next.zones.right.panels.push(id);
        if(!next.hidden.includes(id))next.hidden.push(id);return;
      }
      if(location(next,id)!==placement){
        for(const zone of DOCK_ZONES)next.zones[zone].panels=next.zones[zone].panels.filter(value=>value!==id);
        next.zones[placement].panels.push(id);
      }
      next.zones[placement].active=id;next.zones[placement].open=true;next.hidden=next.hidden.filter(value=>value!==id);
    });
  }
  setZoneOpen(zone:DockZone,open:boolean):boolean {
    if(!isZone(zone)||typeof open!=='boolean')return false;
    return this.change(next=>{next.zones[zone].open=open;});
  }
  setSize(zone:DockZone,size:number,persist=true):boolean {
    if(!isZone(zone)||typeof size!=='number'||!Number.isFinite(size)||size<=0)return false;
    return this.change(next=>{next.zones[zone].size=clampDockSize(zone,size);},persist);
  }
  setDensity(density:WorkspaceLayout['density']):boolean {
    if(density!=='compact'&&density!=='comfortable')return false;
    return this.change(next=>{next.density=density;});
  }
  setChrome(patch:{drawingTools?:boolean;quoteHeader?:boolean}):boolean {
    if((patch.drawingTools!==undefined&&typeof patch.drawingTools!=='boolean')||(patch.quoteHeader!==undefined&&typeof patch.quoteHeader!=='boolean'))return false;
    return this.change(next=>{if(patch.drawingTools!==undefined)next.drawingTools=patch.drawingTools;if(patch.quoteHeader!==undefined)next.quoteHeader=patch.quoteHeader;});
  }
  applyPreset(name:WorkspacePreset):boolean {
    if(!['standard','focus','analysis','orderflow'].includes(name))return false;
    return this.replace(preset(this.current,name));
  }
  reset():boolean{return this.replace(preset(this.current,'standard',true));}
  save():boolean {if(this.destroyed)return false;const saved=this.persist();this.emit();return saved;}
  destroy():void {this.destroyed=true;this.listeners.clear();}
  private change(update:(layout:WorkspaceLayout)=>void,persist=true):boolean {
    if(this.destroyed)return false;const next=copy(this.current);update(next);reconcileActive(next);return this.replace(next,persist);
  }
  private replace(next:WorkspaceLayout,persist=true):boolean {
    if(this.destroyed)return false;
    const valid=parse(next);if(!valid)return false;
    if(JSON.stringify(valid)===JSON.stringify(this.current)){
      if(persist&&this.pendingSave){this.persist();this.emit();}return false;
    }
    this.checkpoint??=copy(this.current);this.current=valid;this.pendingSave=true;if(persist)this.persist();this.emit();return true;
  }
  private persist():boolean {
    if(this.checkpoint){this.past.push(this.checkpoint);if(this.past.length>30)this.past.shift();this.future=[];this.checkpoint=null;}
    try{
      if(!this.storage){this.problem='布局暂时只保留在当前页面。';return false;}
      this.storage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY,JSON.stringify(this.current));this.pendingSave=false;this.problem='';return true;
    }catch{this.problem='布局保存失败，更改暂时保留在当前页面。';return false;}
  }
  private emit():void {for(const listener of this.listeners)listener(this.snapshot);}
}

export interface DockAvailableSpace { width:number;height:number;minChartWidth?:number;minChartHeight?:number }
export interface ResolvedDockSizes { left:number;right:number;bottom:number;chartWidth:number;chartHeight:number;suppressed:DockZone[] }
/** Resolve display dimensions only. Persisted sizes/open flags survive small
 * windows unchanged. Width/height exclude the surrounding app chrome/rails. */
export function resolveDockSizes(layout:WorkspaceLayout,space:DockAvailableSpace):ResolvedDockSizes {
  const width=Number.isFinite(space.width)?Math.max(0,space.width):0,height=Number.isFinite(space.height)?Math.max(0,space.height):0;
  const minWidth=Math.max(320,Number.isFinite(space.minChartWidth)?space.minChartWidth!:320),minHeight=Math.max(180,Number.isFinite(space.minChartHeight)?space.minChartHeight!:180);
  const requested=(zone:DockZone)=>layout.zones[zone].open&&layout.zones[zone].panels.some(id=>!layout.hidden.includes(id))?clampDockSize(zone,layout.zones[zone].size):0;
  const wanted={left:requested('left'),right:requested('right'),bottom:requested('bottom')};
  let left=wanted.left,right=wanted.right,bottom=wanted.bottom;const horizontal=Math.max(0,width-minWidth),vertical=Math.max(0,height-minHeight);
  if(left+right>horizontal){
    if(left&&right&&horizontal>=DOCK_SIZE_LIMITS.left.min+DOCK_SIZE_LIMITS.right.min){
      left=Math.max(DOCK_SIZE_LIMITS.left.min,Math.min(horizontal-DOCK_SIZE_LIMITS.right.min,Math.round(horizontal*left/(left+right))));right=horizontal-left;
    }else if(right&&horizontal>=DOCK_SIZE_LIMITS.right.min){left=0;right=Math.min(right,horizontal);}
    else if(left&&horizontal>=DOCK_SIZE_LIMITS.left.min){right=0;left=Math.min(left,horizontal);}
    else{left=0;right=0;}
  }
  if(bottom>vertical)bottom=vertical>=DOCK_SIZE_LIMITS.bottom.min?vertical:0;
  const actual={left,right,bottom};
  return {...actual,chartWidth:Math.max(0,width-left-right),chartHeight:Math.max(0,height-bottom),suppressed:DOCK_ZONES.filter(zone=>wanted[zone]>0&&actual[zone]===0)};
}
