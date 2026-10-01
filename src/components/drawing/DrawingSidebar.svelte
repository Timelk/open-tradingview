<script lang="ts">
  import {t, locale} from '../../lib/i18n';
  import { onMount, onDestroy, tick } from 'svelte';
  import type { DrawingEngine } from '../../lib/drawing/engine';
  import type { DrawingState } from '../../lib/drawing/types';
  import { drawingPlugins } from '../../plugins/drawing-tools';
  import ToolIcon from './ToolIcon.svelte';
  import { surface, setSurfaceInteractive } from '../../lib/ui/motion';
  import { DRAWING_TOOL_MIME } from '../../lib/drawing/tool-transfer';
  import { isMacShortcutPlatform } from '../../lib/ui/shortcuts';
  let {engine,focusChart,onOpenObjects}:{engine?:DrawingEngine;focusChart:()=>void;onOpenObjects:()=>void}=$props();
  let drawingState=$state<DrawingState|null>(null);
  let revision=$state(0);
  let openGroup=$state<string|null>(null);
  let menuTop=$state(90);
  let railRight=$state(52);
  let search=$state('');
  let objectsOpen=$state(false);
  let message=$state('');
  let rail:HTMLElement;
  let hoverTimer:ReturnType<typeof setTimeout>|undefined,closeTimer:ReturnType<typeof setTimeout>|undefined;
  let touchActivation=false;
  function cancelClose(){clearTimeout(closeTimer);closeTimer=undefined;}
  function closeLater(){clearTimeout(hoverTimer);cancelClose();closeTimer=setTimeout(()=>{if(!rail?.querySelector('.tool-popup')?.contains(document.activeElement))openGroup=null;},180);}
  function hoverGroup(id:string,event:PointerEvent){if(event.pointerType==='touch'||event.buttons)return;cancelClose();clearTimeout(hoverTimer);const target=event.currentTarget as HTMLElement;hoverTimer=setTimeout(()=>open(id,target,false,false),80);}
  onDestroy(()=>{clearTimeout(hoverTimer);cancelClose();});
  let recent=$state<Record<string,string>>({});
  const modifierName=isMacShortcutPlatform()?'⌘ / Ctrl':'Ctrl';
  const magnetTitle=$derived(drawingState?.magnetModifier
    ?drawingState.effectiveMagnet?$t('临时强磁吸 OHLC · 松开 {0} 恢复关闭',{0:modifierName}):$t('临时关闭磁吸 · 松开 {0} 恢复{1}磁吸',{0:modifierName,1:$t(drawingState.magnetStrength==='strong'?'强':'弱')})
    :$t('{0} · 按住 {1} 临时{2}；右键图表可选择强弱磁吸',{0:$t(drawingState?.magnet?(drawingState.magnetStrength==='strong'?'强磁吸':'弱磁吸'):'磁吸关闭'),1:modifierName,2:$t(drawingState?.magnet?'关闭':'强吸 OHLC')}));
  $effect(()=>{if(engine)return engine.subscribe(value=>drawingState=value);});
  onMount(()=>drawingPlugins.core.subscribe(()=>revision++));
  const groups=$derived.by(()=>{revision;return drawingPlugins.core.listGroups();});
  const tools=$derived.by(()=>{revision;return drawingPlugins.core.list();});
  const menuTools=$derived(tools.filter(tool=>tool.group===openGroup&&`${tool.name} ${$t(tool.name)}`.toLowerCase().includes(search.toLowerCase())));
  function choose(id:string){clearTimeout(hoverTimer);cancelClose();engine?.selectTool(id);const tool=drawingPlugins.core.get(id);if(tool)recent={...recent,[tool.group]:id};openGroup=null;objectsOpen=false;focusChart();}
  function dragTool(event:DragEvent,id:string){
    clearTimeout(hoverTimer);cancelClose();openGroup=null;
    if(!event.dataTransfer)return;
    event.dataTransfer.setData(DRAWING_TOOL_MIME,id);event.dataTransfer.effectAllowed='copy';
    const tool=drawingPlugins.core.get(id);if(tool)recent={...recent,[tool.group]:id};
  }
  function finishToolDrag(){openGroup=null;objectsOpen=false;}
  function open(id:string,target:HTMLElement,focus=true,toggle=true){clearTimeout(hoverTimer);cancelClose();const b=target.getBoundingClientRect();menuTop=Math.max(8,Math.min(b.top,window.innerHeight-330));railRight=rail.getBoundingClientRect().right;openGroup=toggle&&openGroup===id?null:id;search='';objectsOpen=false;if(focus&&openGroup)void tick().then(()=>rail.querySelector<HTMLInputElement>('.tool-search')?.focus());}
  function dismiss(event:PointerEvent){if(!(event.target instanceof Node)||!rail?.contains(event.target)){clearTimeout(hoverTimer);cancelClose();openGroup=null;objectsOpen=false;}}
  function toggle(key:'magnet'|'stayDrawing'|'locked'|'hidden'){if(drawingState)engine?.setOption(key,!drawingState[key]);}
  function menuKeys(event:KeyboardEvent){
    if(event.target instanceof HTMLInputElement||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();
    const items=Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('.tool-options button'));
    const index=items.indexOf(document.activeElement as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[next]?.focus();
  }
</script>
<svelte:window onpointerdown={dismiss} onkeydown={(e)=>{if(e.key==='Escape'){clearTimeout(hoverTimer);cancelClose();if(openGroup||objectsOpen){openGroup=null;objectsOpen=false;focusChart();}}}} />
<aside class="drawing-rail" bind:this={rail} aria-label={$t("绘图工具栏")}>
  <div class="tool-groups">
    {#each groups as group}
      {@const groupTools=tools.filter(t=>t.group===group.id)}
      {@const current=groupTools.find(t=>t.id===recent[group.id])??groupTools[0]}
      {#if current}
        {@const Icon=drawingPlugins.get(current.id)?.Icon}
        <div class="tool-group" class:group-active={groupTools.some(t=>t.id===drawingState?.activeTool)} class:has-menu={groupTools.length>1}>
          <button class="tool-main" aria-haspopup="dialog" aria-expanded={openGroup===group.id} onpointerenter={e=>hoverGroup(group.id,e)} onpointerleave={closeLater} onpointerdown={e=>{touchActivation=e.pointerType==='touch';clearTimeout(hoverTimer);}} draggable={!current.mode||current.mode==='draw'} ondragstart={(e)=>dragTool(e,current.id)} ondragend={finishToolDrag} aria-label={$t(current.name)} title={`${$t(current.name)}${current.shortcut?' · '+current.shortcut:''}${!current.mode||current.mode==='draw'?$t(" · 可拖入图表"):''}`} aria-pressed={drawingState?.activeTool===current.id} onclick={e=>{if(touchActivation){touchActivation=false;open(group.id,e.currentTarget);}else choose(current.id);}} onkeydown={(e)=>{if(e.key==='ArrowRight'||e.key==='ArrowDown'){e.preventDefault();open(group.id,e.currentTarget);}}}>
            {#if Icon}<Icon />{:else}<ToolIcon name={current.icon}/>{/if}
          </button>
        </div>
      {/if}
    {/each}
  </div>
  <div class="rail-section">
    <button class:enabled={drawingState?.activeTool==='date-price-range'} draggable="true" ondragstart={(e)=>dragTool(e,'date-price-range')} ondragend={finishToolDrag} aria-label={$t("测量")} title={$t("测量日期和价格范围")} onclick={()=>choose('date-price-range')}><ToolIcon name="ruler"/></button>
    <button class:enabled={drawingState?.activeTool==='zoom-region'} draggable="true" ondragstart={(e)=>dragTool(e,'zoom-region')} ondragend={finishToolDrag} aria-label={$t("区域放大")} title={$t("框选区域放大")} onclick={()=>choose('zoom-region')}><ToolIcon name="zoom"/></button>
  </div>
  <div class="rail-section">
    <button class:enabled={drawingState?.effectiveMagnet} class:temporary={drawingState?.magnetModifier} aria-label={$t("磁吸 OHLC")} aria-pressed={drawingState?.effectiveMagnet??false} data-magnet-state={drawingState?.effectiveMagnet?drawingState.effectiveMagnetStrength:'off'} title={$t(magnetTitle)} onclick={()=>toggle('magnet')}><ToolIcon name="magnet"/></button>
    <button class:enabled={drawingState?.stayDrawing} aria-label={$t("连续绘制")} aria-pressed={drawingState?.stayDrawing??false} title={$t("保持绘图工具，连续创建对象")} onclick={()=>toggle('stayDrawing')}><ToolIcon name="stay"/></button>
    <button class:enabled={drawingState?.locked} aria-label={$t("锁定全部绘图")} aria-pressed={drawingState?.locked??false} title={$t("锁定全部绘图")} onclick={()=>toggle('locked')}><ToolIcon name={drawingState?.locked?'lock':'unlock'}/></button>
    <button class:enabled={drawingState?.hidden} aria-label={$t("隐藏全部绘图")} aria-pressed={drawingState?.hidden??false} title={$t("隐藏 / 显示全部绘图")} onclick={()=>toggle('hidden')}><ToolIcon name={drawingState?.hidden?'hidden':'eye'}/></button>
  </div>
  <div class="rail-section">
    <button aria-label={$t("撤销绘图")} title={$t("撤销 · Ctrl / ⌘ Z")} disabled={!drawingState?.canUndo} onclick={()=>{engine?.undo();focusChart();}}><ToolIcon name="undo"/></button>
    <button aria-label={$t("重做绘图")} title={$t("重做 · Ctrl / ⌘ Shift Z")} disabled={!drawingState?.canRedo} onclick={()=>{engine?.redo();focusChart();}}><ToolIcon name="redo"/></button>
    <button aria-label={$t("绘图对象列表")} title={$t("在右侧打开对象树")} onclick={onOpenObjects}><ToolIcon name="objects"/>{#if drawingState?.drawings.length}<span class="count">{drawingState.drawings.length}</span>{/if}</button>
    <button aria-label={$t("清除未锁定绘图")} title={$t("清除未锁定绘图（可撤销）")} disabled={!drawingState?.drawings.length||drawingState?.locked} onclick={()=>engine?.clear()}><ToolIcon name="trash"/></button>
  </div>
  {#if openGroup}
    <div class="tool-popup" onpointerenter={cancelClose} onpointerleave={closeLater} onfocusout={closeLater} style:left={`${railRight+5}px`} style:top={`${menuTop}px`} style:max-height={`calc(100dvh - ${menuTop+12}px)`} role="dialog" aria-label={$t(groups.find(g=>g.id===openGroup)?.name)} tabindex="-1" onkeydown={menuKeys} transition:surface={{x:-4,y:0}} onintrostart={(e)=>setSurfaceInteractive(e.currentTarget,true)} onoutrostart={(e)=>setSurfaceInteractive(e.currentTarget,false)}>
      <div class="popup-heading">{$t(groups.find(g=>g.id===openGroup)?.name)}<button aria-label={$t("关闭工具菜单")} onclick={()=>openGroup=null}><ToolIcon name="close" size={14}/></button></div>
      <input class="tool-search" aria-label={$t("搜索当前分类工具")} placeholder={$t("搜索工具")} bind:value={search} onkeydown={(e)=>{if(e.key==='ArrowDown'){e.preventDefault();rail.querySelector<HTMLButtonElement>('.tool-options button')?.focus();}}}/>
      <div class="tool-options">
        {#each menuTools as tool}
          {@const Icon=drawingPlugins.get(tool.id)?.Icon}
          <button class:chosen={drawingState?.activeTool===tool.id} draggable={!tool.mode||tool.mode==='draw'} ondragstart={(e)=>dragTool(e,tool.id)} ondragend={finishToolDrag} aria-label={$t(tool.name)} onclick={()=>choose(tool.id)}>{#if Icon}<Icon />{:else}<ToolIcon name={tool.icon} size={18}/>{/if}<span>{$t(tool.name)}</span><kbd>{tool.shortcut??''}</kbd></button>
        {/each}
        {#if !menuTools.length}<p class="empty">{$t("没有匹配的工具")}</p>{/if}
      </div>
    </div>
  {/if}
</aside>
<style>
  .drawing-rail{position:relative;z-index:8;width:52px;flex:0 0 52px;border-right:1px solid var(--line);background:var(--bg-panel);overflow:visible;display:flex;flex-direction:column;padding-top:6px;max-height:100%}
  .tool-groups,.rail-section{flex-shrink:0}
  .tool-group{position:relative;display:flex;align-items:center;justify-content:center;height:38px;margin:1px 0;color:var(--text-dim)}
  .tool-group.group-active{color:var(--accent-strong)}
  .tool-group.group-active::before{content:'';position:absolute;left:0;top:9px;bottom:9px;width:2px;border-radius:0 2px 2px 0;background:var(--accent)}
  .tool-group.group-active .tool-main{background:var(--accent-soft)}
  /* More tools in this group: a quiet corner tick, like a disclosure. */
  .tool-group.has-menu .tool-main::after{content:'';position:absolute;right:3px;bottom:3px;border:2.5px solid transparent;border-right-color:currentColor;border-bottom-color:currentColor;opacity:.45;pointer-events:none}
  button{position:relative;display:flex;align-items:center;justify-content:center;padding:0;color:inherit;flex-shrink:0;border-radius:var(--radius-md)}
  button:disabled{cursor:default;opacity:.28}
  button:hover{background:var(--bg-hover);color:var(--text-strong)}
  .tool-main{width:34px;height:34px}
  .rail-section{position:relative;margin:6px 0 0;padding-top:6px;display:flex;flex-direction:column;align-items:center;gap:1px}
  .rail-section::before{content:'';position:absolute;top:0;left:12px;right:12px;height:1px;background:var(--line)}
  .rail-section>button{width:34px;height:32px;color:var(--text-dim)}
  .rail-section>button.enabled{color:var(--accent-strong);background:var(--accent-soft)}
  .count{position:absolute;right:1px;bottom:1px;min-width:13px;height:13px;padding:0 3px;border-radius:var(--radius-md);font:600 9px/13px var(--mono);color:var(--on-accent);background:var(--accent);box-shadow:0 0 0 1.5px var(--bg-panel)}
  .rail-section>button.temporary{box-shadow:inset 0 -2px var(--accent)}
  .tool-popup{position:fixed;z-index:30;background:var(--surface-raised);border:1px solid var(--line-strong);box-shadow:var(--shadow-md);width:268px;overflow:auto;color:var(--text);padding-bottom:4px}
  .popup-heading{display:flex;align-items:center;gap:9px;padding:8px 8px 8px 12px;font:600 11px var(--font);letter-spacing:.02em;color:var(--text-dim);min-height:36px}
  .popup-heading>button{margin-left:auto;width:24px;height:24px;color:var(--text-dim)}
  .tool-search{margin:0 8px 6px;width:calc(100% - 16px);height:30px;padding:0 10px;background:var(--surface-sunken);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text);font-size:12px}
  .tool-search:focus{border-color:var(--accent-line)}
  .tool-options{padding:0 4px}
  .tool-options button{display:flex;gap:11px;text-align:left;width:100%;padding:0 10px;min-height:34px;color:var(--text);border-radius:var(--radius-sm)}
  .tool-options button :global(svg){color:var(--text-dim);flex-shrink:0}
  .tool-options button:hover :global(svg){color:var(--text-strong)}
  .tool-options button>span{font-size:12px}
  .tool-options kbd{margin-left:auto;font:10.5px var(--mono);color:var(--text-muted)}
  .tool-options .chosen{background:var(--accent-soft);color:var(--accent-strong)}
  .tool-options .chosen :global(svg){color:var(--accent-strong)}
  .empty{padding:12px;font-size:11px;color:var(--text-dim);line-height:1.7}
  @media(max-height:850px){.tool-group{height:32px}.tool-main{height:30px}.rail-section>button{height:28px}.rail-section{margin-top:3px;padding-top:3px}.tool-group.group-active::before{top:7px;bottom:7px}}
  @media(max-height:690px){.tool-group{height:27px}.tool-main{height:25px}.rail-section>button{height:24px}.drawing-rail{padding-top:2px}.rail-section{margin-top:2px;padding-top:2px}}
  @media(max-height:570px){.tool-groups{max-height:40%;overflow-y:auto}.rail-section>button{height:22px}}
  @media(max-width:540px){.drawing-rail{width:44px;flex-basis:44px}.tool-group{margin-inline:0}.tool-main{width:30px}.rail-section{margin-inline:0}.rail-section>button{width:30px}.tool-popup{max-width:calc(100vw - 62px)}}
</style>
