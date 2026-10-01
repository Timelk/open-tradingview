<script lang="ts">
  import {t, translateError, locale} from '../../lib/i18n';
  import { tick, untrack } from 'svelte';
  import type { DrawingEngine } from '../../lib/drawing/engine';
  import type { DrawingState, DrawingStyle } from '../../lib/drawing/types';
  import type { DrawingSelection } from '../../lib/chart/controller';
  import { drawingPlugins } from '../../plugins/drawing-tools';
  import ToolIcon from './ToolIcon.svelte';
  import { surface, setSurfaceInteractive } from '../../lib/ui/motion';
  import { positionDrawingToolbar } from '../../lib/drawing/toolbar-position';
  import { drawingFontSize } from '../../lib/drawing/labels';
  let {engine,anchor,onOpenSettings}:{engine?:DrawingEngine;anchor:DrawingSelection|null;onOpenSettings:(ids:string[])=>void}=$props();
  let drawingState=$state<DrawingState|null>(null);
  let toolbar=$state<HTMLDivElement>();
  let moreButton=$state<HTMLButtonElement>();
  let x=$state(12),y=$state(29),more=$state(false),menuAbove=$state(false);
  let positioned='';
  let drag:{id:number;x:number;y:number;left:number;top:number}|null=null;
  $effect(()=>{if(engine)return engine.subscribe(value=>drawingState=value);});
  const selected=$derived(drawingState?.selected);
  const tool=$derived(selected?drawingPlugins.core.get(selected.toolId):undefined);
  const disabled=$derived(!!drawingState?.locked||!!selected?.locked);
  const active=$derived(drawingState?drawingPlugins.core.get(drawingState.activeTool):undefined);
  const showToolbar=$derived(!!selected&&!!tool&&anchor?.id===selected.id&&!drawingState?.hidden&&!!engine?.effective(selected.id).visible);
  $effect(()=>{
    if(!toolbar||!anchor||!showToolbar){more=false;return;}
    const key=`${anchor.id}:${anchor.x}:${anchor.y}:${anchor.bounds?Object.values(anchor.bounds).join(':'):''}`;
    const point=anchor;
    untrack(()=>{
      const parent=toolbar!.parentElement;
      if(key!==positioned&&parent){
        positioned=key;
        const position=positionDrawingToolbar(point,{width:toolbar!.offsetWidth,height:toolbar!.offsetHeight},{width:parent.clientWidth,height:parent.clientHeight});
        x=position.x;y=position.y;
      }
    });
  });
  $effect(()=>{
    if(!toolbar)return;
    const observer=new ResizeObserver(()=>clamp());observer.observe(toolbar);if(toolbar.parentElement)observer.observe(toolbar.parentElement);
    return ()=>observer.disconnect();
  });
  function clamp(){if(!toolbar)return;const parent=toolbar.parentElement;if(!parent)return;x=Math.max(8,Math.min(x,parent.clientWidth-toolbar.offsetWidth-88));y=Math.max(26,Math.min(y,parent.clientHeight-toolbar.offsetHeight-32));}
  function startDrag(event:PointerEvent){if(event.button!==0)return;event.preventDefault();drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:x,top:y};(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);}
  function moveDrag(event:PointerEvent){if(drag?.id!==event.pointerId)return;x=drag.left+event.clientX-drag.x;y=drag.top+event.clientY-drag.y;clamp();}
  function endDrag(event:PointerEvent){if(drag?.id!==event.pointerId)return;drag=null;const target=event.currentTarget as HTMLElement;if(target.hasPointerCapture(event.pointerId))target.releasePointerCapture(event.pointerId);}
  function outside(event:PointerEvent){if(event.target instanceof Node&&!toolbar?.contains(event.target))more=false;}
  async function openMore(){more=!more;menuAbove=y+210>(toolbar?.parentElement?.clientHeight??1000);await tick();if(more)toolbar?.querySelector<HTMLButtonElement>('.quick-menu button')?.focus();}
  function closeMore(restoreFocus=false){if(restoreFocus)moreButton?.focus();more=false;}
  function menuKeys(event:KeyboardEvent){
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMore(true);return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();
    const items=Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index=items.indexOf(document.activeElement as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[next]?.focus();
  }
</script>
<svelte:window onpointerdown={outside} onkeydown={(e)=>{if(e.key==='Escape'&&more){closeMore(true);e.preventDefault();}}}/>
{#if showToolbar&&selected&&tool}
  <div bind:this={toolbar} class="drawing-properties" role="toolbar" aria-label={$t("绘图快捷工具条")} style:left={`${x}px`} style:top={`${y}px`} transition:surface|global onintrostart={(e)=>setSurfaceInteractive(e.currentTarget,true)} onoutrostart={(e)=>setSurfaceInteractive(e.currentTarget,false)}>
    <button class="grip" aria-label={$t("移动绘图工具条")} title={$t("拖动工具条")} onpointerdown={startDrag} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={endDrag} onlostpointercapture={()=>drag=null}><ToolIcon name="grip" size={17}/></button>
    <span class="object-icon" title={$t(tool.name)}><ToolIcon name={tool.icon} size={19}/></span>
    <label class="color-control" title={$t("线条颜色")}><span class="sr-only">{$t("绘图颜色")}</span><input type="color" aria-label={$t("快捷绘图颜色")} value={selected.style.color} {disabled} onchange={(e)=>engine?.updateSelected({style:{color:e.currentTarget.value}})}/></label>
    <select aria-label={$t("快捷绘图线宽")} value={selected.style.width} {disabled} onchange={(e)=>engine?.updateSelected({style:{width:Number(e.currentTarget.value)}})}>{#each [1,2,3,4,6,8] as width}<option value={width}>{width}px</option>{/each}</select>
    <select aria-label={$t("快捷绘图线型")} value={selected.style.dash} {disabled} onchange={(e)=>engine?.updateSelected({style:{dash:e.currentTarget.value as DrawingStyle['dash']}})}><option value="solid">{$t("实线")}</option><option value="dashed">{$t("虚线")}</option><option value="dotted">{$t("点线")}</option></select>
    {#if tool.supportsLabels||tool.fields?.some(field=>['text','label','fontSize'].includes(field.key))}<select aria-label={$t("快捷标签字号")} title={$t("标签字号")} value={drawingFontSize(selected)} {disabled} onchange={(e)=>engine?.updateSelected({style:{fontSize:Number(e.currentTarget.value)}})}>{#each [...new Set([12,13,14,16,18,20,24,28,32,drawingFontSize(selected)])].sort((a,b)=>a-b) as size}<option value={size}>{size}px</option>{/each}</select>{/if}
    <span class="separator"></span>
    <button aria-label={$t("设置选中绘图")} title={$t("设置")} onclick={()=>onOpenSettings([selected.id])}><ToolIcon name="gear" size={20}/></button>
    <button disabled={drawingState?.inheritedLocked||drawingState?.locked} aria-label={selected.locked?$t("解锁选中绘图"):$t("锁定选中绘图")} title={drawingState?.locked?$t("全部绘图已锁定"):drawingState?.inheritedLocked?$t("由上级分组锁定"):selected.locked?$t("解锁"):$t("锁定")} onclick={()=>engine?.setDrawingFlags(selected.id,{locked:!selected.locked})}><ToolIcon name={selected.locked?'lock':'unlock'} size={19}/></button>
    <button aria-label={$t("删除选中绘图")} title={$t("删除 · Delete")} {disabled} onclick={()=>engine?.deleteSelected()}><ToolIcon name="trash" size={19}/></button>
    <button bind:this={moreButton} aria-label={$t("更多绘图操作")} title={$t("更多")} aria-haspopup="menu" aria-expanded={more} onclick={openMore}><ToolIcon name="more" size={21}/></button>
    {#if more}<div class="quick-menu" class:above={menuAbove} role="menu" aria-label={$t("更多绘图操作")} tabindex="-1" onkeydown={menuKeys} transition:surface={{y:menuAbove?3:-3}} onintrostart={(e)=>setSurfaceInteractive(e.currentTarget,true)} onoutrostart={(e)=>setSurfaceInteractive(e.currentTarget,false)}>
      <button role="menuitem" onclick={()=>{more=false;onOpenSettings([selected.id]);}}>{$t("属性设置")}</button>
      <button role="menuitem" onclick={()=>{more=false;engine?.cloneLayers([selected.id]);}}>{$t("复制绘图")}</button>
      <button role="menuitem" {disabled} onclick={()=>{more=false;engine?.reorderLayers([selected.id],'front');}}>{$t("置于顶层")}</button>
      <button role="menuitem" {disabled} onclick={()=>{more=false;engine?.reorderLayers([selected.id],'back');}}>{$t("置于底层")}</button>
      <button role="menuitem" {disabled} onclick={()=>{more=false;engine?.updateLayers([selected.id],{visible:false});}}>{$t("隐藏绘图")}</button>
      <button role="menuitem" onclick={()=>{more=false;engine?.selectTool('cursor');}}>{$t("取消选择")}</button>
    </div>{/if}
  </div>
{/if}
{#if active&&active.mode!=='cursor'}
  <div class="drawing-hint" role="status" transition:surface={{y:3}}><ToolIcon name={active.icon} size={14}/><strong>{$t(active.name)}</strong><span>{active.mode==='eraser'?$t("点击删除未锁定对象"):active.freehand?$t("按住并拖动画线"):active.points===1?$t("点击放置，或拖动后松开放置"):active.points===3?$t("依次选择三个控制点"):active.points===4?$t("依次选择 A、B、C、D 四点"):drawingState?.placing?$t("移动预览，点击确定终点"):$t("点击两点，或按住拖动绘制")}</span><kbd>{$t("Esc 退出")}</kbd></div>
{/if}
{#if drawingState?.error}<div class="drawing-error" role="status">{translateError(drawingState.error,$locale)}</div>{/if}
<style>
  .drawing-properties{position:absolute;z-index:6;max-width:calc(100% - 104px);display:flex;align-items:center;flex-wrap:wrap;gap:3px;padding:4px 6px;background:var(--chart-glass-menu-bg,#20242b);border:1px solid var(--chart-glass-border-strong,#414a58);border-radius:var(--radius-md);backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));-webkit-backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));box-shadow:var(--chart-glass-shadow,0 5px 20px #0005);color:var(--chart-glass-text,#bec8d6);pointer-events:auto}.drawing-properties button{width:29px;height:31px;display:flex;align-items:center;justify-content:center;padding:0;color:var(--chart-glass-text,#bec8d6);background:transparent;border:0;border-radius:var(--radius-sm)}.drawing-properties button:hover{background:var(--chart-glass-badge-bg,#2a313d)}.drawing-properties .grip{width:17px;cursor:grab;touch-action:none;color:var(--chart-glass-text-muted,var(--text-dim))}.drawing-properties .grip:active{cursor:grabbing}.object-icon{display:flex;padding:0 5px;color:var(--chart-glass-text,#bec8d6)}.separator{height:23px;border-left:1px solid var(--chart-glass-border,#3a4350);margin:0 3px}.drawing-properties input,.drawing-properties select{font:11px var(--mono);background:transparent;border:1px solid transparent;border-radius:var(--radius-sm);color:var(--chart-glass-text,#d5deec);height:29px;padding:3px 5px}.drawing-properties select:hover{background:var(--chart-glass-badge-bg,#2a313d)}.color-control input{width:27px;padding:1px;cursor:pointer}.drawing-properties :disabled{opacity:.4;cursor:default}.quick-menu{position:absolute;top:calc(100% + 5px);right:0;width:146px;z-index:2;padding:5px;background:var(--chart-glass-menu-bg,#202630);border:1px solid var(--chart-glass-border-strong,#455066);border-radius:var(--radius-md);backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));-webkit-backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));box-shadow:var(--chart-glass-shadow,0 8px 24px #0006)}.quick-menu.above{top:auto;bottom:calc(100% + 5px)}.quick-menu button{width:100%;justify-content:flex-start;font-size:11px;padding:5px 10px;height:30px}
  .drawing-hint{position:absolute;z-index:5;bottom:33px;left:12px;max-width:calc(100% - 108px);display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--chart-glass-bg,#20242b);border:1px solid var(--chart-glass-border-strong,#364150);border-radius:var(--radius-md);backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));-webkit-backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));box-shadow:var(--chart-glass-shadow,none);color:var(--chart-glass-text,#a9bad0);font-size:11px;pointer-events:none}.drawing-hint strong{font-weight:600;color:var(--accent,#9dc0ff);white-space:nowrap}.drawing-hint kbd{font:11px var(--mono);color:var(--chart-glass-text-muted,var(--text-dim));white-space:nowrap}.drawing-error{position:absolute;bottom:67px;left:12px;z-index:6;background:var(--chart-glass-menu-bg,#20242b);border:1px solid var(--chart-glass-border-strong,#364150);border-radius:var(--radius-md);backdrop-filter:var(--chart-glass-blur,blur(10px));padding:8px;color:var(--accent);font-size:11px}
  @media(max-width:600px){.drawing-properties{gap:2px;padding:3px}.object-icon{display:none}.drawing-hint{left:5px;max-width:calc(100% - 90px);flex-wrap:wrap}.drawing-hint span{font-size:11px}.drawing-hint kbd{display:none}}
</style>
