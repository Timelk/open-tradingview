<script lang="ts">
  import {t,locale,translate,translateError,canonicalT} from '../../lib/i18n';
  import {workspaceLayerName} from '../workspace/names';
  import { untrack } from 'svelte';
  import type { ChartController, ChartState, StudyPaneLayout } from '../../lib/chart/controller';
  import { deriveOverlaySurface, readableSurfaceColor } from '../../lib/chart/appearance';
  import type { DrawingState } from '../../lib/drawing/types';
  import { formatSeriesValue } from '../../lib/core/market-format';
  import ToolIcon from '../drawing/ToolIcon.svelte';
  import { surface, setSurfaceInteractive } from '../../lib/ui/motion';
  let {controller,chartState,panes,onOpenProperties,onReveal}:{controller:ChartController;chartState:ChartState;panes:StudyPaneLayout[];onOpenProperties:(ids:string[])=>void;onReveal:(id:string)=>void}=$props();
  let workspace=$state<DrawingState>(untrack(()=>controller.drawing.state));
  let collapsed=$state<string[]>([]),menu=$state(''),menuX=$state(0),menuY=$state(0);
  let menuElement=$state<HTMLDivElement>();
  let menuButton:HTMLButtonElement|null=null;
  $effect(()=>controller.drawing.subscribe(value=>workspace=value));
  const doc=$derived(workspace.scene.document);
  const overlaySurface=$derived.by(()=>{chartState;workspace;return deriveOverlaySurface(controller.getAppearance());});
  const patternCounts=$derived.by(()=>{chartState;workspace;return new Map(controller.getPatternStudies().map(study=>[study.instanceId,study]));});
  const analysisCounts=$derived.by(()=>{chartState;workspace;return new Map(controller.getAnalysisStudies().map(study=>[study.instanceId,study]));});
  const rows=$derived(doc.indicators.flatMap(instance=>{
    const layer=doc.layers.find(l=>l.id===instance.instanceId),def=controller.registry.list().find(d=>d.id===instance.id);
    if(!layer)return [];
    const reading=chartState.readings.find(r=>r.id===instance.instanceId),status=controller.layerStatus(instance.instanceId);
    const params=def?.category==='analysis'?$t('闭柱证据'):def?.category==='pattern'?$t('拐点 {strength}{close}',{strength:instance.params.pivotStrength??3,close:['pattern-huzi','pattern-confluence'].includes(instance.id)?$t(' · 收盘 {count}',{count:instance.params.breakoutCloses??1}):''}):def?.analysisFamily==='flow'?(instance.params.unit==='quote'?'USDT':$t('基础量')):Object.entries(instance.params).filter(([key,value])=>key!=='divergenceStrength'&&typeof value==='number').map(([,value])=>value).join(', ');
    return [{instance,layer,def,reading,status,params,name:workspaceLayerName(controller,doc,layer,$t)}];
  }));
  const activeMenu=$derived(rows.find(row=>row.instance.instanceId===menu));
  $effect(()=>{if(menu&&!activeMenu)menu='';});
  function settings(id:string){menu='';onOpenProperties([id]);}
  function toggle(id:string,visible:boolean){controller.drawing.updateLayers([id],{visible:!visible});}
  function openMenu(event:MouseEvent,id:string){
    const button=event.currentTarget as HTMLButtonElement,b=button.getBoundingClientRect();menuButton=button;
    menuX=Math.max(8,Math.min(b.left,innerWidth-190));menuY=Math.max(8,Math.min(b.bottom+4,innerHeight-185));menu=menu===id?'':id;
  }
  function dismiss(event:PointerEvent){if(event.target instanceof Node&&!menuElement?.contains(event.target)&&event.target!==menuButton&&!menuButton?.contains(event.target))menu='';}
  function menuKeys(event:KeyboardEvent){
    if(event.key==='Escape'){event.preventDefault();menu='';menuButton?.focus();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();const items=Array.from(menuElement?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);
    const index=items.indexOf(document.activeElement as HTMLButtonElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();
  }
</script>
<svelte:window onpointerdown={dismiss} onkeydown={(event)=>{if(event.key==='Escape'&&menu){menu='';menuButton?.focus();}}}/>
<div class="study-legends" aria-label={$t("图表指标与策略")}>
  {#each panes as pane (pane.id)}
    {@const items=rows.filter(row=>row.layer.paneId===pane.id)}
    {#if items.length}
      <section class="legend-pane" style:top={`${pane.top+4}px`} style:max-width={`${Math.max(100,pane.width-75)}px`} aria-label={$t('{name}的指标列表',{name:pane.id==='main'?$t('主图'):items[0].name})}>
        <div class="legend-scroll" style:max-height={`${Math.max(26,pane.height-10)}px`}>
          {#if !collapsed.includes(pane.id)}
            {#each items as row (row.instance.instanceId)}
              <div class="study-row" class:selected={workspace.scene.selectedIds.includes(row.instance.instanceId)} class:is-hidden={!row.status.visible} data-study-id={row.instance.instanceId}>
                <button class="study-name" title={$t('{name} · 双击设置{status}',{name:row.name,status:row.status.reason?' · '+$t(row.status.reason):''})} onclick={()=>controller.drawing.selectLayers([row.instance.instanceId])} ondblclick={()=>settings(row.instance.instanceId)}>
                  {#if row.def?.kind==='strategy'}<span class="strategy-mark"><ToolIcon name="trend" size={13}/></span>{/if}
                  <strong>{row.name||row.instance.id}</strong><span class="params">{row.params}</span>
                  {#if row.instance.timeframe!=='chart'}<span class="timeframe">{row.instance.timeframe}</span>{/if}
                </button>
                <div class="study-values num" aria-hidden="true">
                  {#if !row.status.visible}<span class="muted">{$t(row.status.reason||'已隐藏')}</span>
                  {:else if row.def?.category==='pattern'}{@const candCount=row.reading?.values.find(v=>v.name==='观察中结构')?.value??0}<span class="muted">{patternCounts.get(row.instance.instanceId)?.pending?$t("识别中…"):`${$t("形态 {0}", {0: patternCounts.get(row.instance.instanceId)?.count??0})}${candCount>0?' · '+$t("观察 {0}", {0: candCount}):''}`}</span>
                  {:else if row.def?.category==='analysis'}<span class="muted">{analysisCounts.get(row.instance.instanceId)?.pending?$t("识别中…"):$t("观察 {0}", {0: analysisCounts.get(row.instance.instanceId)?.count??0})}</span>
                  {:else if row.def?.kind==='strategy'}<span class="muted">{$t("已收盘信号")}</span>
                  {:else if row.reading?.values.length}{#each row.reading.values.filter(v=>!v.hidden) as value}<span style:color={readableSurfaceColor(value.color,overlaySurface.surfaceSolid,4.8)}>{formatSeriesValue(value.value,row.layer.paneId==='main')}</span>{/each}
                  {:else}<span class="muted">{$t("计算中…")}</span>{/if}
                </div>
                <div class="study-actions">
                  <button aria-label={$t(row.layer.visible?'隐藏 {name}':'显示 {name}',{name:row.name})} title={$t(row.layer.visible?'隐藏':'显示')} disabled={row.status.locked} onclick={()=>toggle(row.instance.instanceId,row.layer.visible)}><ToolIcon name={row.status.visible?'eye':'hidden'} size={16}/></button>
                  <button aria-label={$t('更多 {name}',{name:row.name})} title={$t("更多")} aria-haspopup="menu" aria-expanded={menu===row.instance.instanceId} onclick={(event)=>openMenu(event,row.instance.instanceId)}><ToolIcon name="more" size={17}/></button>
                </div>
              </div>
            {/each}
          {/if}
        </div>
        <button class="collapse-studies" aria-label={$t(collapsed.includes(pane.id)?'展开 {name}指标列表':'收起 {name}指标列表',{name:pane.id==='main'?$t('主图'):items[0].name})} aria-expanded={!collapsed.includes(pane.id)} onclick={()=>collapsed=collapsed.includes(pane.id)?collapsed.filter(id=>id!==pane.id):[...collapsed,pane.id]}><ToolIcon name={collapsed.includes(pane.id)?'down':'up'} size={11}/>{#if collapsed.includes(pane.id)}<span>{items.length}</span>{/if}</button>
      </section>
    {/if}
  {/each}
</div>
{#if activeMenu}
  <div bind:this={menuElement} class="study-menu" style:left={`${menuX}px`} style:top={`${menuY}px`} role="menu" tabindex="-1" aria-label={$t('{name}操作',{name:activeMenu.name})} onkeydown={menuKeys} transition:surface={{y:-3}} onintrostart={(e)=>{setSurfaceInteractive(e.currentTarget,true);e.currentTarget.querySelector<HTMLButtonElement>('button')?.focus();}} onoutrostart={(e)=>setSurfaceInteractive(e.currentTarget,false)}>
    <button role="menuitem" onclick={()=>settings(menu)}>{$t("设置")}</button>
    <button role="menuitem" onclick={()=>{controller.drawing.cloneLayers([menu]);menu='';}}>{$t("复制实例")}</button>
    <button role="menuitem" onclick={()=>{onReveal(menu);menu='';}}>{$t("在对象树中查看")}</button>
    <button role="menuitem" disabled={activeMenu.status.locked} onclick={()=>{controller.drawing.removeLayers([menu]);menu='';}}>{$t("删除此实例")}</button>
  </div>
{/if}
<style>
  .study-legends{position:absolute;inset:0;pointer-events:none;z-index:4}.legend-pane{position:absolute;left:7px;pointer-events:none;display:flex;align-items:flex-start;gap:4px}.legend-scroll{overflow:auto;pointer-events:none;scrollbar-width:thin;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:2px}.study-row{pointer-events:auto;display:flex;align-items:center;min-height:24px;height:24px;width:max-content;max-width:100%;padding:0 8px;border:1px solid var(--chart-glass-border,rgba(226,238,255,.13));border-radius:var(--radius-sm);color:var(--chart-glass-text,#ecf3fb);gap:6px;background:var(--chart-glass-bg,#151718c9);backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));-webkit-backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));box-shadow:var(--chart-glass-shadow,0 4px 14px #0003)}.study-row:hover,.study-row:focus-within{background:var(--chart-glass-bg-hover,#22272ee6);border-color:var(--chart-glass-border-strong,#3b4655)}.study-row.selected{border-color:var(--accent,#457bc3)}.study-name{display:inline-flex;align-items:center;min-height:20px;height:20px;padding:0 2px;gap:6px;min-width:0;font:11px/1 var(--mono);white-space:nowrap;color:var(--chart-glass-text,#ecf3fb);background:transparent;border:0}.study-name:hover{background:transparent;color:var(--chart-glass-text,#ecf3fb)}.study-name strong{font-weight:600;line-height:1;color:var(--chart-glass-text,#ecf3fb)}.params{color:var(--chart-glass-text-muted,var(--text-dim));max-width:120px;overflow:hidden;text-overflow:ellipsis;line-height:1}.timeframe{display:inline-flex;align-items:center;justify-content:center;height:16px;color:var(--accent,#89acd4);background:var(--chart-glass-badge-bg,#2a3544);border-radius:var(--radius-xs);padding:0 5px;font:500 10px/1 var(--mono)}.strategy-mark{display:inline-flex;align-items:center;color:var(--accent,#8aafe5)}.study-values{display:inline-flex;align-items:center;flex-shrink:0;gap:7px;font-size:11px;font-weight:500;line-height:1;white-space:nowrap;overflow:hidden}.muted{color:var(--chart-glass-text-muted,var(--text-dim));font-size:11px;line-height:1}.study-actions{display:inline-flex;align-items:center;gap:1px;width:46px;overflow:hidden;opacity:0;pointer-events:none;flex-shrink:0;transition:opacity 100ms ease}.study-row:hover .study-actions,.study-row:focus-within .study-actions,.is-hidden .study-actions{opacity:1;pointer-events:auto}.study-actions button{padding:0;width:22px;height:20px;min-height:20px;display:inline-flex;justify-content:center;align-items:center;color:var(--chart-glass-text-muted,#bac7d7);background:transparent;border:0;border-radius:var(--radius-xs)}.study-actions button:hover{color:var(--chart-glass-text,#e3ecf9);background:var(--chart-glass-badge-bg,#354153)}.study-actions button:disabled{opacity:.35;cursor:default}.is-hidden .study-name,.is-hidden .study-name strong{color:var(--chart-glass-text-muted,var(--text-dim))}.collapse-studies{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;gap:3px;min-width:24px;height:24px;min-height:24px;padding:0 6px;color:var(--chart-glass-text-muted,var(--text-dim));background:var(--chart-glass-bg,#151718bd);border:1px solid var(--chart-glass-border,rgba(226,238,255,.13));border-radius:var(--radius-sm);backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));-webkit-backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));box-shadow:var(--chart-glass-shadow,0 4px 14px #0003);font:500 11px/1 var(--mono)}.collapse-studies:hover{color:var(--chart-glass-text,#c5d1e0);background:var(--chart-glass-bg-hover);border-color:var(--chart-glass-border-strong)}.study-menu{position:fixed;z-index:25;width:180px;padding:5px;background:var(--chart-glass-menu-bg,#202630);border:1px solid var(--chart-glass-border-strong,#455066);border-radius:var(--radius-md);color:var(--chart-glass-text,#ecf3fb);backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));-webkit-backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));box-shadow:var(--chart-glass-shadow,0 8px 24px #0006)}.study-menu button{display:flex;align-items:center;justify-content:flex-start;width:100%;text-align:left;padding:8px 11px;min-height:30px;font-size:11px;color:var(--chart-glass-text,#ecf3fb);background:transparent;border:0;border-radius:var(--radius-sm)}.study-menu button:disabled{opacity:.4}.study-menu button:hover{background:var(--chart-glass-badge-bg,#303c4d);color:var(--chart-glass-text,#ecf3fb)}@media(pointer:coarse){.study-row{min-height:34px;height:34px}.study-actions{width:58px;opacity:1;pointer-events:auto}.study-actions button{height:28px;min-height:28px;width:28px}.study-name{min-height:28px;height:28px}.collapse-studies{height:34px;min-height:34px;min-width:32px}}@media(max-width:650px){.params{max-width:70px}.study-actions button{width:23px}.legend-pane{left:3px;max-width:calc(100% - 95px)!important}.study-name{font-size:11px;gap:3px}}
</style>
