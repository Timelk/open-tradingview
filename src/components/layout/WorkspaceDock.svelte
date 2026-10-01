<script lang="ts">
  import {t,locale} from '../../lib/i18n';
  import { onMount,untrack,tick,type Snippet } from 'svelte';
  import {tabs as tabIndicator,tabKeys} from '../../lib/ui/tabs';
  import {motionReduced} from '../../lib/ui/motion-preferences';
  import {animateDockMove,cancelDockMotion} from '../../lib/ui/dock-motion';
  import type { WorkspaceLayout,DockZone } from '../../lib/workspace/layout';
  import { resolveDockSizes,DOCK_SIZE_LIMITS } from '../../lib/workspace/layout';
  import type { PanelRegistry } from '../../lib/workspace/registry';
  import type { WorkspacePanelComponent,WorkspacePanelContext } from './panel-context';
  import ToolIcon from '../drawing/ToolIcon.svelte';
  let {layout,registry,context,children,onOpenPanel,onCloseZone,onResize,onResizeEnd,onMovePanel,onSettings,focusedZone='right',mobileOpen=false,onMobileChange}:{
    layout:WorkspaceLayout;registry:PanelRegistry<WorkspacePanelComponent>;context?:WorkspacePanelContext;children:Snippet;
    onOpenPanel:(id:string)=>void;onCloseZone:(zone:DockZone)=>void;onResize:(zone:DockZone,size:number)=>void;onResizeEnd:()=>void;
    onMovePanel:(id:string,zone:DockZone)=>void;onSettings:()=>void;focusedZone?:DockZone;mobileOpen?:boolean;onMobileChange?:(mobile:boolean)=>void;
  }=$props();
  function localizedTabs(node:HTMLElement,_language:string){let indicator=tabIndicator(node);return {update(){indicator.destroy();indicator=tabIndicator(node);},destroy(){indicator.destroy();}};}
  const zones:DockZone[]=['left','right','bottom'];
  const zoneNames={left:'左侧',right:'右侧',bottom:'底部'};
  let grid:HTMLDivElement;
  let bounds=$state({width:typeof innerWidth==='number'?innerWidth-92:1200,height:typeof innerHeight==='number'?innerHeight-126:750});
  let visited=$state<string[]>([]),revision=$state(0),draggedPanel=$state(''),dropZone=$state<DockZone|null>(null),resizing=$state(false);
  let resizeDrag:{id:number;zone:DockZone;start:number;size:number;target:HTMLElement;other?:{zone:DockZone;size:number}}|null=null;
  let pendingSize:number|null=null,resizeFrame=0;
  let panelDrag:{id:number;panel:string;x:number;y:number;target:HTMLElement;moved:boolean}|null=null;
  let suppressTabClick='';
  const mobile=$derived.by(()=>{bounds;return typeof innerWidth==='number'?(innerWidth<768||innerWidth<=1000&&innerHeight<=480):bounds.width<720;});
  $effect(()=>{const narrow=mobile;untrack(()=>onMobileChange?.(narrow));});
  const available=$derived.by(()=>{revision;return registry.list();});
  // Tabs follow the registry's task order (market → chart → research), the
  // same order as the right rail, independent of the order panels were docked.
  function tabs(zone:DockZone){const order=new Map(available.map((panel,index)=>[panel.id,index]));return layout.zones[zone].panels.filter(id=>!layout.hidden.includes(id)).sort((a,b)=>(order.get(a)??Infinity)-(order.get(b)??Infinity));}
  function groupStart(zone:DockZone,index:number){if(!index)return false;const list=tabs(zone),group=(id:string)=>available.find(item=>item.id===id)?.group;return group(list[index])!==group(list[index-1]);}
  function active(zone:DockZone){const ids=tabs(zone);return ids.includes(layout.zones[zone].active??'')?layout.zones[zone].active:ids[0]??null;}
  const mobileZone=$derived(layout.zones[focusedZone].open&&tabs(focusedZone).length?focusedZone:zones.find(zone=>layout.zones[zone].open&&tabs(zone).length)??null);
  function zoneMinimum(zone:DockZone){revision;return Math.max(DOCK_SIZE_LIMITS[zone].min,...tabs(zone).map(id=>(zone==='bottom'?registry.get(id)?.minHeight:registry.get(id)?.minWidth)??0));}
  const sizingLayout=$derived({...layout,zones:{left:{...layout.zones.left,size:Math.max(layout.zones.left.size,zoneMinimum('left'))},right:{...layout.zones.right,size:Math.max(layout.zones.right.size,zoneMinimum('right'))},bottom:{...layout.zones.bottom,size:Math.max(layout.zones.bottom.size,zoneMinimum('bottom'))}}});
  const sizes=$derived(resolveDockSizes(sizingLayout,{width:Math.max(0,bounds.width-10),height:Math.max(0,bounds.height-5),minChartWidth:320,minChartHeight:180}));
  const left=$derived(mobile?0:sizes.left),right=$derived(mobile?0:sizes.right),bottom=$derived(mobile?0:sizes.bottom);
  function isOpen(zone:DockZone){return layout.zones[zone].open&&tabs(zone).length>0&&(mobile?mobileOpen&&zone===mobileZone:sizes[zone]>0);}
  function location(id:string):DockZone{return zones.find(zone=>layout.zones[zone].panels.includes(id))??'right';}
  function shown(id:string){const zone=location(id);return isOpen(zone)&&active(zone)===id&&!layout.hidden.includes(id);}
  function area(zone:DockZone){return zone==='left'?'1 / 1 / 2 / 2':zone==='right'?'1 / 5 / 2 / 6':'3 / 1 / 4 / 6';}
  function mobileGeometry(_zone:DockZone,header=false){return header?'inset:0 0 auto;height:44px;':'inset:0;width:100%;height:100%;';}
  let lastShown='',mobileWasOpen=false;let returnFocus:HTMLElement|null=null;
  $effect(()=>{const ids=zones.flatMap(zone=>isOpen(zone)&&active(zone)?[active(zone)!]:[]),key=ids.join('|');const isMobile=mobile&&mobileOpen;
    untrack(()=>{if(key!==lastShown){lastShown=key;void tick().then(()=>{for(const node of grid?.querySelectorAll<HTMLElement>('.dock-surface')??[]){node.getAnimations().forEach(a=>a.cancel());if(!node.hidden&&!mobile&&!motionReduced()&&registry.get(node.dataset.panel??'')?.motionPolicy!=='none')node.animate([{opacity:.55},{opacity:1}],{duration:120,easing:'ease-out'});}});}if(isMobile&&!mobileWasOpen){if(!returnFocus)returnFocus=document.activeElement as HTMLElement;void tick().then(()=>grid?.querySelector<HTMLButtonElement>('.mobile-header .dock-close')?.focus());}else if(!isMobile&&returnFocus){const prior=returnFocus;returnFocus=null;void tick().then(()=>{if(prior?.isConnected)prior.focus();});}mobileWasOpen=isMobile;});
  });
  $effect(()=>{
    const next=zones.flatMap(zone=>isOpen(zone)&&active(zone)?[active(zone)!]:[]);
    untrack(()=>{if(next.some(id=>!visited.includes(id)))visited=[...visited,...next.filter(id=>!visited.includes(id))];});
  });
  onMount(()=>{
    const off=registry.subscribe(()=>revision++);
    const observer=new ResizeObserver(()=>{const width=grid.clientWidth,height=grid.clientHeight;if(width!==bounds.width||height!==bounds.height)bounds={width,height};});
    observer.observe(grid);
    return()=>{off();observer.disconnect();cancelAnimationFrame(resizeFrame);cancelDockMotion();};
  });
  function applySize(zone:DockZone,value:number,other?:{zone:DockZone;size:number}){
    const limits=DOCK_SIZE_LIMITS[zone];
    const maximum=zone==='bottom'?bounds.height-185:bounds.width-320-(other?10:5)-(other?DOCK_SIZE_LIMITS[other.zone].min:0);
    const size=Math.max(zoneMinimum(zone),Math.min(limits.max,maximum,value));
    if(other)onResize(other.zone,Math.min(other.size,bounds.width-330-size));
    onResize(zone,size);
  }
  function flushResize(){cancelAnimationFrame(resizeFrame);resizeFrame=0;if(resizeDrag&&pendingSize!==null)applySize(resizeDrag.zone,pendingSize,resizeDrag.other);pendingSize=null;}
  function startResize(event:PointerEvent,zone:DockZone){
    if(event.button!==0)return;event.preventDefault();
    const size=zone==='left'?left:zone==='right'?right:bottom;
    const other=zone==='left'&&right?{zone:'right' as DockZone,size:right}:zone==='right'&&left?{zone:'left' as DockZone,size:left}:undefined;
    resizeDrag={id:event.pointerId,zone,start:zone==='bottom'?event.clientY:event.clientX,size,target:event.currentTarget as HTMLElement,other};
    resizeDrag.target.setPointerCapture(event.pointerId);resizing=true;
  }
  function moveResize(event:PointerEvent){
    if(!resizeDrag||resizeDrag.id!==event.pointerId)return;
    const {zone,start,size}=resizeDrag,delta=(zone==='bottom'?event.clientY:event.clientX)-start;
    pendingSize=size+delta*(zone==='left'?1:-1);
    if(!resizeFrame)resizeFrame=requestAnimationFrame(flushResize);
  }
  function finishResize(event?:PointerEvent){
    if(!resizeDrag||event&&event.pointerId!==resizeDrag.id)return;
    if(event&&event.type==='pointerup')moveResize(event);
    flushResize();const drag=resizeDrag;resizeDrag=null;resizing=false;
    if(drag.target.hasPointerCapture(drag.id))drag.target.releasePointerCapture(drag.id);
    onResizeEnd();
  }
  function resizeKeys(event:KeyboardEvent,zone:DockZone){
    const negative=zone==='bottom'?'ArrowDown':zone==='right'?'ArrowRight':'ArrowLeft';
    const positive=zone==='bottom'?'ArrowUp':zone==='right'?'ArrowLeft':'ArrowRight';
    if(![negative,positive,'Home','End'].includes(event.key))return;
    event.preventDefault();const current=zone==='left'?left:zone==='right'?right:bottom;
    applySize(zone,event.key==='Home'?DOCK_SIZE_LIMITS[zone].min:event.key==='End'?DOCK_SIZE_LIMITS[zone].max:current+(event.key===negative?-1:1)*(event.shiftKey?40:10),zone==='left'&&right?{zone:'right',size:right}:zone==='right'&&left?{zone:'left',size:left}:undefined);onResizeEnd();
  }
  function startPanelDrag(event:PointerEvent,panel:string){
    if(event.button!==0||!event.isPrimary)return;
    suppressTabClick='';
    const target=event.currentTarget as HTMLElement;
    panelDrag={id:event.pointerId,panel,x:event.clientX,y:event.clientY,target,moved:false};
    target.setPointerCapture(event.pointerId);
  }
  function hitDropZone(event:PointerEvent){
    const value=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-drop-zone]')?.dataset.dropZone;
    return zones.includes(value as DockZone)?value as DockZone:null;
  }
  function movePanelDrag(event:PointerEvent){
    if(!panelDrag||event.pointerId!==panelDrag.id)return;
    if(!panelDrag.moved&&Math.hypot(event.clientX-panelDrag.x,event.clientY-panelDrag.y)<6)return;
    panelDrag.moved=true;draggedPanel=panelDrag.panel;dropZone=hitDropZone(event);
  }
  function finishPanelDrag(event?:PointerEvent){
    if(!panelDrag||event&&event.pointerId!==panelDrag.id)return;
    const drag=panelDrag,zone=event?.type==='pointerup'?hitDropZone(event):null;
    panelDrag=null;draggedPanel='';dropZone=null;
    if(drag.target.hasPointerCapture(drag.id))drag.target.releasePointerCapture(drag.id);
    if(drag.moved){suppressTabClick=drag.panel;if(zone){const from=drag.target.getBoundingClientRect(),label=drag.target.textContent??drag.panel;onMovePanel(drag.panel,zone);void tick().then(()=>{const target=grid.querySelector<HTMLElement>(`[data-panel="${CSS.escape(drag.panel)}"]`);if(target)animateDockMove(from,label,target);});}}
  }
</script>
<svelte:window onpointermove={event=>{moveResize(event);movePanelDrag(event);}} onpointerup={event=>{finishResize(event);finishPanelDrag(event);}} onpointercancel={event=>{finishResize(event);finishPanelDrag(event);}} onblur={()=>{finishResize();finishPanelDrag();}} onkeydown={event=>{if(event.key==='Escape'&&!event.defaultPrevented){cancelDockMotion();finishPanelDrag();if(mobile&&mobileOpen&&mobileZone){event.preventDefault();onCloseZone(mobileZone);}}}}/>
<div bind:this={grid} class="dock-grid" class:resizing class:mobile style:grid-template-columns={`${left}px ${left?5:0}px minmax(0,1fr) ${right?5:0}px ${right}px`} style:grid-template-rows={`minmax(0,1fr) ${bottom?5:0}px ${bottom}px`} aria-label={$t("工作区布局")}>
  <div class="chart-slot" inert={mobile&&mobileOpen}>{@render children()}</div>
  {#each zones as zone}
    {#if isOpen(zone)}
      <header class="dock-header" class:mobile-header={mobile} style={`grid-area:${area(zone)};${mobile?mobileGeometry(zone,true):''}`} data-dock-header={zone}>
        <div class="dock-tabs" role="tablist" tabindex="-1" aria-label={$t("{0}面板",{0:$t(zoneNames[zone])})} use:localizedTabs={$locale} onkeydown={tabKeys}>
          {#each tabs(zone) as id, index}
            {@const definition=available.find(item=>item.id===id)}
            {@const shortTitle=tabs(zone).length>=4?(id==='objects'?'对象':definition?.title??id):(definition?.title??id)}
            <button class:active={active(zone)===id} class:group-start={groupStart(zone,index)} role="tab" tabindex={active(zone)===id?0:-1} aria-selected={active(zone)===id} aria-controls={`workspace-panel-${id}`} id={`workspace-tab-${id}`} onpointerdown={event=>startPanelDrag(event,id)} onclick={()=>{if(suppressTabClick===id){suppressTabClick='';return;}onOpenPanel(id);}} title={$t("{0} · 可拖到左、右或底部",{0:$t(definition?.title??id)})}><ToolIcon name={definition?.icon??'layers'} size={14}/><span>{$t(shortTitle)}</span></button>
          {/each}
        </div>
        <button class="dock-close" aria-label={$t("收起{0}面板",{0:$t(zoneNames[zone])})} title={$t("收起此区域")} onclick={()=>onCloseZone(zone)}><ToolIcon name="close" size={15}/></button>
      </header>
    {/if}
    {#if !mobile&&(zone==='left'?left:zone==='right'?right:bottom)>0}
      <!-- Focusable separator is the ARIA window-splitter pattern. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div class="dock-divider" class:horizontal={zone==='bottom'} style:grid-area={zone==='left'?'1 / 2 / 2 / 3':zone==='right'?'1 / 4 / 2 / 5':'2 / 1 / 3 / 6'} role="separator" tabindex="0" aria-orientation={zone==='bottom'?'horizontal':'vertical'} aria-label={$t("调整{0}面板{1}",{0:$t(zoneNames[zone]),1:zone==='bottom'?$t('高度'):$t('宽度')})} aria-valuenow={Math.round(zone==='left'?left:zone==='right'?right:bottom)} aria-valuemin={DOCK_SIZE_LIMITS[zone].min} aria-valuemax={DOCK_SIZE_LIMITS[zone].max} onpointerdown={event=>startResize(event,zone)} onkeydown={event=>resizeKeys(event,zone)}></div>
    {/if}
  {/each}
  {#each visited as id (id)}
    {@const zone=location(id)}
    {@const definition=available.find(item=>item.id===id)}
    <div class="dock-surface" class:mobile-surface={mobile} data-panel={id} data-zone={zone} data-density={layout.density} id={`workspace-panel-${id}`} role="tabpanel" aria-labelledby={`workspace-tab-${id}`} hidden={!shown(id)} inert={!shown(id)} style={`grid-area:${area(zone)};${mobile?mobileGeometry(zone):''}`}>
      {#if definition&&context}
        {@const Panel=definition.component}
        <Panel {context} active={shown(id)} density={layout.density} {zone} onClose={()=>onCloseZone(zone)}/>
      {:else if !definition}<div class="panel-placeholder">{$t("组件尚未加载：")}{id}<button onclick={onSettings}>{$t("调整布局")}</button></div>{/if}
    </div>
  {/each}
  {#if draggedPanel}
    <div class="dock-drop-zones" aria-label={$t("面板停靠区域")}>
      {#each registry.get(draggedPanel)?.allowedZones??zones as zone}<div class="dock-drop" class:targeted={dropZone===zone} class:bottom={zone==='bottom'} data-drop-zone={zone} role="region" aria-label={$t("停靠到{0}",{0:$t(zoneNames[zone])})}>{$t("停靠到")} {$t(zoneNames[zone])}</div>{/each}
    </div>
  {/if}
</div>
<style>
  .dock-grid{position:relative;display:grid;flex:1;min-width:0;min-height:0;overflow:hidden;background:var(--bg)}.chart-slot{grid-area:1 / 3 / 2 / 4;display:flex;min-width:0;min-height:0;overflow:hidden}.dock-header{position:relative;align-self:start;min-width:0;display:flex;align-items:center;height:31px;background:var(--bg-panel);border-bottom:1px solid var(--line);z-index:4;overflow:hidden}.dock-tabs{display:flex;flex:1;min-width:0;overflow:auto;scrollbar-width:none;height:31px}.dock-tabs button{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:0 6px;min-height:31px;min-width:0;font-size:11px;color:var(--text-dim);white-space:nowrap;border-bottom:2px solid transparent;cursor:grab;touch-action:none;user-select:none;flex:1}.dock-tabs button{transition:color var(--motion-fast,110ms) ease,background-color var(--motion-fast,110ms) ease,border-color var(--motion-fast,110ms) ease}.dock-tabs button:hover{color:var(--text)}.dock-tabs button{border:0;border-radius:0;border-bottom:2px solid transparent}.dock-tabs button.active{color:var(--text-strong);border-color:transparent;border-bottom-color:var(--accent);background:transparent}.dock-tabs button.group-start{box-shadow:inset 1px 0 0 var(--line)}.dock-tabs button:active{cursor:grabbing}.dock-close{height:28px;width:25px;display:flex;align-items:center;justify-content:center;padding:0;color:var(--text-dim);flex-shrink:0}.dock-surface{min-width:0;min-height:0;overflow:hidden;display:flex;padding-top:31px;background:var(--bg-panel);z-index:2;container-type:inline-size}.dock-surface[hidden]{display:none!important}.dock-divider{cursor:ew-resize;outline:none;touch-action:none;background:var(--bg);z-index:5;position:relative}.dock-divider:after{content:'';position:absolute;inset:0 1px;background:var(--line);opacity:.9}.dock-divider:hover:after,.dock-divider:focus-visible:after,.resizing .dock-divider:after{background:var(--accent);opacity:1}.dock-divider.horizontal{cursor:ns-resize}.dock-divider.horizontal:after{inset:1px 0}.resizing{user-select:none}.mobile-surface{position:absolute;grid-area:auto!important;z-index:10;box-shadow:var(--shadow-md)}.mobile-header{position:absolute;grid-area:auto!important;z-index:11;height:31px!important;}.panel-placeholder{padding:20px;color:var(--text-dim);font-size:12px;display:flex;flex-direction:column;gap:15px}.panel-placeholder button{border:1px solid var(--line-strong)}.dock-drop-zones{position:absolute;inset:8px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr .55fr;gap:10px;z-index:30;pointer-events:none}.dock-drop{display:flex;align-items:center;justify-content:center;border:1px dashed var(--line-strong);background:color-mix(in srgb, var(--bg-hover) 90%, transparent);color:var(--text);font-size:13px;pointer-events:auto}.dock-drop.bottom{grid-column:1 / -1}.dock-drop.targeted{border-style:solid;border-color:var(--accent);background:var(--accent-soft)}
</style>
