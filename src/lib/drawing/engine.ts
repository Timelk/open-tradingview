import type { Anchor, Drawing, DrawingHost, DrawingState, DrawingStyle, Pixel, ToolGesture, Primitive, Projection, MagnetStrength } from './types';
import { DEFAULT_STYLE } from './types';
import { ToolRegistry } from './registry';
import { DrawingStore, parseDrawingDocument } from './store';
import { AnchoredGesture, FreehandGesture } from './gestures';
import { emptyScene, layerOf, type SceneDocument, type SceneLayer, type EffectiveLayer } from '../scene/types';
import { orderedLayers, effectiveLayer, descendants } from '../scene/model';
import { updateLayers, groupLayers, moveToGroup, reorderLayers, ungroup, deleteLayers, placeRelative } from '../scene/commands';
import { parseSceneDocument } from '../scene/serialization';
import { primitiveHit, renderPrimitives } from './primitives';

interface Placement { model:Drawing; gesture:ToolGesture }
interface Edit { model:Drawing; original:Drawing; origin:Anchor; handle:number|null }
export class DrawingEngine {
  /** Handle/selection inks; the chart swaps these with the appearance tone. */
  ink={handleFill:'#151718',selected:'#b7d2ff'};
  private stores=new Map<string,DrawingStore>();
  private store=new DrawingStore();private market='';
  private selectedId:string|null=null;
  private selectedIds:string[]=[];
  private activeGroupId:string|null=null;
  private interval='1m';
  private revision=0;
  private planDocument:SceneDocument|null=null;
  private planInterval='';
  private paint:SceneLayer[]=[];
  private effectiveCache=new Map<string,EffectiveLayer>();
  private drawingMap=new Map<string,Drawing>();
  private geometryCache=new Map<string,{drawing:Drawing;projection:Projection;primitives:Primitive[]}>();
  private active='cursor';private magnet=false;private stay=false;private locked=false;private hidden=false;
  private strength:MagnetStrength='weak';private magnetModifier=false;private lastPixel:Pixel|null=null;
  private placement:Placement|null=null;private edit:Edit|null=null;private pressed=false;
  private hover:string|null=null;private error='';
  private listeners=new Set<(state:DrawingState)=>void>();
  private unsubscribeRegistry:()=>void;
  private styles=new Map<string,DrawingStyle>();
  constructor(readonly registry:ToolRegistry,private host:DrawingHost,private invalidate:(kind?:'scene'|'overlay')=>void,private defaults:()=>SceneDocument=emptyScene){
    this.unsubscribeRegistry=registry.subscribe(()=>{this.geometryCache.clear();if(!registry.get(this.active))this.active='cursor';this.invalidate();this.emit();});
  }
  get allLocked():boolean{return this.locked;}
  get allHidden():boolean{return this.hidden;}
  get drawingMode():boolean{return this.registry.get(this.active)?.mode!=='cursor';}
  get hasGesture():boolean{return !!this.placement||!!this.edit;}
  /** A property dialog's live preview owns the scene until OK/Cancel. */
  get previewing():boolean{return this.store.isPreviewing;}
  get crosshair():boolean{return this.active!=='eraser';}
  get effectiveMagnet():boolean{return this.magnet!==this.magnetModifier;}
  get magnetModifierHeld():boolean{return this.magnetModifier;}
  get effectiveMagnetStrength():MagnetStrength{return this.magnetModifier&&!this.magnet?'strong':this.strength;}
  get interactionPaneId():string|null{return this.edit?.model.paneId??this.placement?.model.paneId??null;}
  get canSnapPointer():boolean{return this.effectiveMagnet&&this.active!=='eraser'&&(!this.edit||this.edit.handle!==null);}
  /** Read-only picking for menus; never reuse selection as a substitute hit. */
  hitDrawing(pixel:Pixel,paneId=this.host.paneAt(pixel)):Drawing|null {
    if(!paneId)return null;const drawing=this.hit(pixel,paneId);return drawing?structuredClone(drawing):null;
  }
  get cursor():string{return this.active==='eraser'?'cell':this.drawingMode?'crosshair':this.hover?'move':this.registry.get(this.active)?.cursor??'crosshair';}
  get state():DrawingState {
    const selected=this.store.items.find(d=>d.id===this.selectedId);
    return {scene:{document:structuredClone(this.store.document),selectedIds:[...this.selectedIds],activeGroupId:this.activeGroupId,interval:this.interval,revision:this.revision},inheritedLocked:!!selected&&this.isLocked(selected)&&!selected.locked&&!this.locked,activeTool:this.active,selected:selected?{...structuredClone(selected),locked:this.isLocked(selected)}:null,drawings:structuredClone([...this.store.items]),magnet:this.magnet,magnetStrength:this.strength,magnetModifier:this.magnetModifier,effectiveMagnet:this.effectiveMagnet,effectiveMagnetStrength:this.effectiveMagnetStrength,stayDrawing:this.stay,locked:this.locked,hidden:this.hidden,canUndo:this.store.canUndo,canRedo:this.store.canRedo,placing:!!this.placement,error:this.error};
  }
  subscribe(fn:(state:DrawingState)=>void):()=>void{this.listeners.add(fn);fn(this.state);return ()=>this.listeners.delete(fn);}
  private emit(){const state=this.state;for(const fn of this.listeners)fn(state);}
  private changed(save=false){this.invalidate();if(save&&!this.store.isPreviewing){this.revision++;this.persist();}this.emit();}
  setMarket(market:string):void {
    this.cancel();this.market=market;this.selectedId=null;this.selectedIds=[];this.activeGroupId=null;this.hover=null;this.magnetModifier=false;this.lastPixel=null;
    let store=this.stores.get(market);
    if(!store){store=new DrawingStore();this.stores.set(market,store);
      try{const text=localStorage.getItem(this.storageKey())??localStorage.getItem(`tvchart.drawings.v1:${market}`);store.replaceDocument(text?parseSceneDocument(text,this.registry,this.defaults()):this.defaults());}catch{store.replaceDocument(this.defaults());this.error='保存的工作区无法读取，已载入默认图表；原记录未删除。';}
    }
    this.store=store;this.changed();
  }
  selectTool(id:string):void {
    if(!this.registry.get(id))return;
    this.cancel();this.active=id;this.selectedId=null;this.selectedIds=[];this.hover=null;this.changed();
  }
  setOption(key:'magnet'|'stayDrawing'|'locked'|'hidden',value:boolean):void {
    if(key==='magnet')this.magnet=value;if(key==='stayDrawing')this.stay=value;
    if(key==='locked'){this.locked=value;if(value)this.cancel();}
    if(key==='hidden'){this.hidden=value;if(value)this.cancel();}
    if(key==='magnet'&&this.lastPixel)this.pointerMove(this.lastPixel);
    this.changed();
  }
  setMagnetModifier(held:boolean):void {
    if(this.magnetModifier===held)return;this.magnetModifier=held;
    if(this.lastPixel)this.pointerMove(this.lastPixel);this.changed();
  }
  setMagnetStrength(strength:MagnetStrength):void {
    if(!['weak','strong'].includes(strength)||this.strength===strength)return;this.strength=strength;
    if(this.lastPixel)this.pointerMove(this.lastPixel);this.changed();
  }
  setMagnetMode(mode:'off'|MagnetStrength):void {
    if(!['off','weak','strong'].includes(mode))return;
    this.magnet=mode!=='off';if(mode!=='off')this.strength=mode;
    if(this.lastPixel)this.pointerMove(this.lastPixel);this.changed();
  }
  selectDrawing(id:string):void {this.selectLayers([id]);}
  updateSelected(patch:{points?:Anchor[];style?:Partial<DrawingStyle>;props?:Drawing['props'];locked?:boolean;hidden?:boolean}):void {
    const selected=this.store.items.find(d=>d.id===this.selectedId);if(!selected)return;
    if(this.isLocked(selected)&&patch.locked===undefined)return;
    let next={...selected,...patch,style:{...selected.style,...patch.style},props:{...selected.props,...patch.props}};
    try{next=parseDrawingDocument(JSON.stringify({version:1,drawings:[next]}),this.registry)[0];}catch{this.error='请输入有效的绘图属性';this.changed();return;}
    if(JSON.stringify(next)===JSON.stringify(selected))return;
    this.store.commit(this.store.items.map(d=>d.id===selected.id?next:d));if(!this.store.isPreviewing)this.styles.set(selected.toolId,next.style);this.changed(true);
  }
  setDrawingFlags(id:string,flags:{locked?:boolean;hidden?:boolean}):void {
    if(!this.store.items.some(d=>d.id===id))return;
    this.store.commit(this.store.items.map(d=>d.id===id?{...d,...flags}:d));this.changed(true);
  }
  deleteSelected():void {this.removeLayers(this.selectedIds);}
  clear():void {if(this.locked)return;this.cancel();const kept=this.store.items.filter(d=>this.isLocked(d));if(kept.length===this.store.items.length)return;this.store.commit(kept);this.selectedId=null;this.selectedIds=[];this.changed(true);}
  undo():void {this.cancel();this.store.undo();this.selectedId=null;this.selectedIds=[];this.changed(true);}
  redo():void {this.cancel();this.store.redo();this.selectedId=null;this.selectedIds=[];this.changed(true);}
  cancel():void {if(!this.placement&&!this.edit&&!this.pressed)return;try{this.placement?.gesture.cancel?.();}catch(e){this.fail(e);}this.placement=null;this.edit=null;this.pressed=false;this.changed();}
  exportJSON():string{return JSON.stringify({...this.store.document,market:this.market},null,2);}
  importJSON(text:string):void {
    const document=JSON.parse(text) as {market?:string};
    if(document.market&&document.market!==this.market)throw new Error('绘图文件属于其他市场，请先切换交易对及数据源');
    const scene=parseSceneDocument(text,this.registry,this.defaults());this.cancel();this.store.commitDocument(scene);this.selectedId=null;this.selectedIds=[];this.changed(true);
  }
  destroy(){this.unsubscribeRegistry();this.listeners.clear();try{this.placement?.gesture.cancel?.();}catch{/* A plugin cannot interrupt chart cleanup. */}}

  /** Modal preview updates the live scene but commits one undo step only on OK. */
  beginPropertyEdit(ids:string[]) {
    const store=this.store,selected=[...ids],previousError=this.error;store.beginPreview();this.error='';let finished=false;
    const finish=(apply:boolean)=>{
      if(finished)return;finished=true;const changed=store.finishPreview(apply);
      if(this.store===store){
        if(!apply)this.error=previousError;
        if(apply)for(const drawing of store.items.filter(d=>selected.includes(d.id)))this.styles.set(drawing.toolId,drawing.style);
        this.changed(apply&&changed);
      }
    };
    return {
      valid:()=>this.store===store&&selected.length===this.selectedIds.length&&selected.every(id=>this.selectedIds.includes(id)&&store.document.layers.some(l=>l.id===id)),
      commit:()=>finish(true),cancel:()=>finish(false),
    };
  }

  get document():SceneDocument{return this.store.document;}
  get paintLayers():SceneLayer[]{this.ensurePlan();return this.paint;}
  effective(id:string):EffectiveLayer{this.ensurePlan();return this.effectiveCache.get(id)??{visible:false,locked:false,opacity:1,reason:'图层不存在'};}
  private ensurePlan():void {
    const doc=this.store.document;if(this.planDocument===doc&&this.planInterval===this.interval)return;
    this.planDocument=doc;this.planInterval=this.interval;this.paint=orderedLayers(doc);this.geometryCache.clear();this.drawingMap=new Map(doc.drawings.map(d=>[d.id,d]));
    this.effectiveCache=new Map(doc.layers.map(l=>[l.id,effectiveLayer(doc,l.id,this.interval)]));
  }
  private isVisible(drawing:Drawing):boolean{return !this.hidden&&this.effective(drawing.id).visible;}
  private isLocked(drawing:Drawing):boolean{return this.locked||this.effective(drawing.id).locked;}
  setInterval(interval:string):void {this.interval=interval;this.cancel();this.changed();}
  selectLayers(ids:string[]):void {
    this.cancel();this.active='cursor';this.selectedIds=ids.filter(id=>this.store.document.layers.some(l=>l.id===id));
    this.selectedId=this.selectedIds.length===1&&this.store.items.some(d=>d.id===this.selectedIds[0])?this.selectedIds[0]:null;this.changed();
  }
  setActiveGroup(id:string|null):void {
    if(id&&!this.store.document.layers.some(l=>l.id===id&&l.kind==='group'))return;
    this.activeGroupId=id;this.error='';this.changed();
  }
  transact(change:(doc:SceneDocument)=>SceneDocument):void {
    try{const next=change(structuredClone(this.store.document));if(JSON.stringify(next)===JSON.stringify(this.store.document))return;
      this.cancel();this.store.commitDocument(next);this.error='';this.selectedIds=this.selectedIds.filter(id=>next.layers.some(l=>l.id===id));
      if(!this.selectedIds.includes(this.selectedId??''))this.selectedId=null;
      if(this.activeGroupId&&!next.layers.some(l=>l.id===this.activeGroupId))this.activeGroupId=null;
      this.changed(true);
    }catch(e){this.fail(e);}
  }
  updateLayers(ids:string[],patch:Parameters<typeof updateLayers>[2]):void {this.transact(doc=>updateLayers(doc,ids,patch));}
  createGroup(name='新建分组',paneId='main'):void {
    let id='';this.transact(doc=>{const result=groupLayers(doc,this.selectedIds,name,paneId);id=result.id;return result.document;});
    if(id&&this.store.document.layers.some(l=>l.id===id)){this.activeGroupId=id;this.selectLayers([id]);}
  }
  moveLayers(ids:string[],parentId:string|null):void {this.transact(doc=>moveToGroup(doc,ids,parentId));}
  reorderLayers(ids:string[],direction:Parameters<typeof reorderLayers>[2]):void {this.transact(doc=>reorderLayers(doc,ids,direction));}
  placeLayers(ids:string[],targetId:string,inFront:boolean):void {this.transact(doc=>placeRelative(doc,ids,targetId,inFront));}
  ungroup(id:string):void {this.transact(doc=>ungroup(doc,id));}
  removeLayers(ids:string[]):void {
    const safe=this.locked?ids.filter(id=>![id,...descendants(this.store.document,id)].some(child=>this.store.document.layers.find(l=>l.id===child)?.kind==='drawing')):ids;
    this.transact(doc=>deleteLayers(doc,safe,this.interval));
  }
  cloneLayers(ids:string[]):void {
    const all=new Set(ids.flatMap(id=>[id,...descendants(this.store.document,id)]));
    const selected=this.store.document.layers.filter(l=>all.has(l.id));
    if(selected.some(l=>l.kind==='series'||l.kind==='overlay')){this.error='行情与外部数据层请通过数据源添加';this.changed();return;}
    const map=new Map(selected.map(l=>[l.id,crypto.randomUUID()]));
    this.transact(doc=>({...doc,
      layers:[...doc.layers,...selected.map(l=>({...l,id:map.get(l.id)!,name:l.name+' 副本',parentId:map.get(l.parentId??'')??l.parentId}))],
      drawings:[...doc.drawings,...doc.drawings.filter(d=>all.has(d.id)).map(d=>({...d,id:map.get(d.id)!}))],
      indicators:[...doc.indicators,...doc.indicators.filter(i=>all.has(i.instanceId)).map(i=>({...i,instanceId:map.get(i.instanceId)!}))],
    }));this.selectLayers(ids.map(id=>map.get(id)!).filter(Boolean));
  }

  pointerDown(pixel:Pixel,paneId:string,tolerance=7):boolean {
    this.lastPixel={...pixel};
    const tool=this.registry.get(this.active);if(!tool)return false;
    if(this.edit)return true;
    if(tool.mode==='eraser'){
      const hit=this.hit(pixel,paneId,tolerance);if(hit&&!this.isLocked(hit)){this.store.commit(this.store.items.filter(d=>d.id!==hit.id));this.selectedId=null;this.selectedIds=[];this.changed(true);}return true;
    }
    if(!tool.mode||tool.mode==='draw'){
      if(this.locked||this.hidden)return false;
      if(this.activeGroupId){const group=this.store.document.layers.find(l=>l.id===this.activeGroupId),state=this.effective(this.activeGroupId);
        if(!group||group.paneId!==paneId||!state.visible||state.locked){this.error='目标组不可绘制：请检查窗格、可见周期及锁定状态';this.changed();return true;}}

      if(this.placement&&this.placement.model.paneId!==paneId)return true;
      const anchor=this.host.anchorAt(pixel,paneId,this.effectiveMagnet,this.effectiveMagnetStrength);if(!anchor)return false;
      if(!this.placement){
        const props=Object.fromEntries((tool.fields??[]).map(field=>[field.key,field.default]));
        try{this.placement={model:{id:crypto.randomUUID(),toolId:tool.id,paneId,points:[anchor],style:{...DEFAULT_STYLE,...tool.defaultStyle,...this.styles.get(tool.id)},props,locked:false,hidden:false},gesture:tool.createGesture?.()??(tool.freehand?new FreehandGesture():new AnchoredGesture(tool.points??2))};}catch(e){this.fail(e);return true;}
      }
      this.pressed=true;this.updatePlacement('down',pixel);this.changed();return true;
    }
    const hit=this.hit(pixel,paneId,tolerance);
    if(!hit){if(this.selectedIds.length){this.selectedId=null;this.selectedIds=[];this.changed();}return false;}
    this.selectedId=hit.id;this.selectedIds=[hit.id];
    if(!this.isLocked(hit)){
      const projection=this.host.projection(paneId)!,handles=this.handleIndices(hit);
      const handle=handles.find(i=>{const at=projection.project(hit.points[i]);return Math.hypot(at.x-pixel.x,at.y-pixel.y)<Math.max(9,tolerance);});
      const origin=this.host.anchorAt(pixel,paneId,false);
      if(origin)this.edit={model:structuredClone(hit),original:structuredClone(hit),origin,handle:handle??null};
    }
    this.pressed=true;this.changed();return true;
  }
  pointerMove(pixel:Pixel):void {
    this.lastPixel={...pixel};
    if(this.edit){
      const edit=this.edit,current=this.host.anchorAt(pixel,edit.model.paneId,this.effectiveMagnet&&edit.handle!==null,this.effectiveMagnetStrength);if(!current)return;
      if(edit.handle!==null)edit.model.points[edit.handle]=current;
      else edit.model.points=edit.original.points.map(p=>({time:p.time+current.time-edit.origin.time,value:p.value+current.value-edit.origin.value}));
      this.invalidate();return;
    }
    if(this.placement){
      const tool=this.registry.get(this.placement.model.toolId);
      if(!tool?.freehand||this.pressed)this.updatePlacement('move',pixel);
      return;
    }
    const pane=this.host.paneAt(pixel),hit=pane?this.hit(pixel,pane):null;
    if(this.hover!==hit?.id){this.hover=hit?.id??null;this.invalidate('overlay');}
  }
  pointerUp(pixel:Pixel):void {
    if(this.edit){
      // Release can carry a newer position than the last pointermove.
      this.pointerMove(pixel);
      const {model,original}=this.edit;this.edit=null;
      if(JSON.stringify(model.points)!==JSON.stringify(original.points))this.store.commit(this.store.items.map(d=>d.id===model.id?model:d));
      this.changed(true);
    }else if(this.placement)this.updatePlacement('up',pixel);
    this.pressed=false;
  }
  pointerLeave():void {this.hover=null;if(!this.hasGesture)this.lastPixel=null;this.invalidate('overlay');}
  keyDown(event:KeyboardEvent):boolean {
    const command=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
    if(command&&key==='z'){event.shiftKey?this.redo():this.undo();return true;}
    if(command&&key==='y'){this.redo();return true;}
    if(event.key==='Escape'&&(this.hasGesture||this.drawingMode||this.selectedId)){
      this.cancel();this.active='cursor';this.selectedId=null;this.selectedIds=[];this.changed();return true;
    }
    if((event.key==='Delete'||event.key==='Backspace')&&this.selectedIds.length){this.deleteSelected();return true;}
    if(event.altKey&&!command){const tool=this.registry.list().find(t=>t.shortcut?.toLowerCase()===`alt+${event.code?.startsWith('Key')?event.code.slice(3).toLowerCase():key}`);if(tool){this.selectTool(tool.id);return true;}}
    return false;
  }
  renderObject(ctx:CanvasRenderingContext2D,id:string):void {
    if(this.hidden)return;
    this.ensurePlan();const stored=this.drawingMap.get(id),drawing=this.edit?.model.id===id?this.edit.model:stored;
    if(!drawing||!this.isVisible(drawing))return;
    const projection=this.host.projection(drawing.paneId),tool=this.registry.get(drawing.toolId);if(!projection||!tool)return;
    ctx.save();ctx.beginPath();ctx.rect(0,projection.pane.top,projection.pane.width,projection.pane.height);ctx.clip();
    ctx.globalAlpha*=this.effective(id).opacity;
    try{renderPrimitives(ctx,this.geometry(drawing,projection),drawing);}catch(e){this.fail(e);}ctx.restore();
  }
  /** Selection handles and unfinished gestures stay above the committed scene. */
  render(ctx:CanvasRenderingContext2D):void {
    if(this.hidden)return;
    const ids=new Set([...this.selectedIds,...(this.hover?[this.hover]:[])]);
    for(const id of [...ids])for(const child of descendants(this.store.document,id))ids.add(child);
    const objects=this.store.items.filter(d=>ids.has(d.id)&&this.isVisible(d)).map(d=>this.edit?.model.id===d.id?this.edit.model:d);
    if(this.placement)objects.push(this.placement.model);
    for(const drawing of objects){
      const projection=this.host.projection(drawing.paneId),tool=this.registry.get(drawing.toolId);if(!projection||!tool)continue;
      ctx.save();ctx.beginPath();ctx.rect(0,projection.pane.top,projection.pane.width,projection.pane.height);ctx.clip();
      try{
        if(drawing.id===this.placement?.model.id)renderPrimitives(ctx,this.geometry(drawing,projection),drawing);
        ctx.fillStyle=this.ink.handleFill;ctx.strokeStyle=ids.has(drawing.id)?this.ink.selected:drawing.style.color;ctx.lineWidth=1.5;ctx.setLineDash([]);
        for(const index of this.handleIndices(drawing)){const p=projection.project(drawing.points[index]);ctx.beginPath();ctx.arc(p.x,p.y,4,0,Math.PI*2);ctx.fill();ctx.stroke();}
      }catch(e){this.fail(e);}ctx.restore();
    }
  }
  private geometry(drawing:Drawing,projection:Projection):Primitive[] {
    const cached=this.geometryCache.get(drawing.id);
    if(cached?.drawing===drawing&&cached.projection===projection&&this.edit?.model!==drawing&&this.placement?.model!==drawing)return cached.primitives;
    const primitives=this.registry.get(drawing.toolId)?.build(drawing,projection)??[];
    if(this.edit?.model!==drawing&&this.placement?.model!==drawing)this.geometryCache.set(drawing.id,{drawing,projection,primitives});return primitives;
  }
  private handleIndices(drawing:Drawing):number[]{
    try{return [...new Set(this.registry.get(drawing.toolId)?.handles?.(drawing)??drawing.points.map((_,i)=>i))].filter(i=>Number.isInteger(i)&&i>=0&&i<drawing.points.length);}
    catch(e){this.fail(e);return [];}
  }
  private hit(pixel:Pixel,paneId:string,tolerance=7):Drawing|null {
    if(this.hidden)return null;const projection=this.host.projection(paneId);if(!projection)return null;
    const visible=this.paintLayers.filter(l=>l.kind==='drawing'&&l.paneId===paneId).map(l=>this.drawingMap.get(l.id)!).filter(d=>d&&this.isVisible(d));
    const selected=visible.find(d=>d.id===this.selectedId);
    if(selected&&this.handleIndices(selected).some(i=>{const p=projection.project(selected.points[i]);return Math.hypot(p.x-pixel.x,p.y-pixel.y)<9;}))return selected;
    for(const drawing of visible.slice().reverse()){
      const tool=this.registry.get(drawing.toolId);if(!tool)continue;
      try{if(tool.hitTest?tool.hitTest(pixel,drawing,projection):this.geometry(drawing,projection).some(p=>primitiveHit(pixel,p,tolerance,drawing.style.fillOpacity)))return drawing;}catch(e){this.fail(e);}
    }
    return null;
  }
  private updatePlacement(phase:'down'|'move'|'up',pixel:Pixel):void {
    const placement=this.placement;if(!placement)return;
    const anchor=this.host.anchorAt(pixel,placement.model.paneId,this.effectiveMagnet,this.effectiveMagnetStrength);if(!anchor)return;
    try{
      const result=placement.gesture.pointer(phase,{anchor,pixel});
      if(!result.points.length||result.points.length>2048||result.points.some(p=>!Number.isFinite(p.time)||!Number.isFinite(p.value)))throw new Error('自定义工具返回了无效坐标');
      placement.model.points=result.points;
      if(result.complete){
        const tool=this.registry.get(placement.model.toolId)!;
        const store=tool.onComplete?.(placement.model,this.host)!=='discard';
        if(store){const model=placement.model,layer=layerOf(model.id,'drawing',this.registry.get(model.toolId)?.name??model.toolId,model.paneId,{parentId:this.activeGroupId,createdInterval:this.interval});this.store.commitDocument({...this.store.document,drawings:[...this.store.items,model],layers:[...this.store.document.layers,layer]});this.selectedId=model.id;this.selectedIds=[model.id];}
        this.placement=null;if(!this.stay||!store)this.active='cursor';this.changed(store);
      }else this.invalidate('overlay');
    }catch(e){this.placement=null;this.fail(e);}
  }
  private storageKey(){return `tvchart.workspace.v2:${this.market}`;}
  private persist(){if(!this.market)return;try{localStorage.setItem(this.storageKey(),this.exportJSON());this.error='';}catch{this.error='无法保存到浏览器，请导出绘图备份。';}}
  private fail(error:unknown){const text=`绘图工具出错：${error instanceof Error?error.message:String(error)}`;if(this.error!==text){this.error=text;this.emit();}}
}
