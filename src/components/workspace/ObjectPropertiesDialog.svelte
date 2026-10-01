<script lang="ts">
  import {workspaceLayerName} from './names';
  import {t, translateError, locale} from '../../lib/i18n';
  import { onMount,untrack,tick } from 'svelte';
  import type { ChartController, ChartState } from '../../lib/chart/controller';
  import type { DrawingState,DrawingStyle } from '../../lib/drawing/types';
  import { drawingFontSize } from '../../lib/drawing/labels';
  import { drawingPlugins } from '../../plugins/drawing-tools';
  import LayerInspector from './LayerInspector.svelte';
  import StudyStyleEditor from './StudyStyleEditor.svelte';
  import ToolIcon from '../drawing/ToolIcon.svelte';
  import { surface, setSurfaceInteractive } from '../../lib/ui/motion';
  let {controller,ids,chartBounds,onClose,chartState}:{controller:ChartController;ids:string[];chartBounds:()=>DOMRect;onClose:()=>void;chartState?:ChartState}=$props();
  let workspace=$state<DrawingState>(untrack(()=>controller.drawing.state));
  let dialog:HTMLDialogElement;
  let tab=$state('');
  let x=$state(12),y=$state(90),positioned=false;
  let drag:{id:number;x:number;y:number;left:number;top:number}|null=null;
  let session:ReturnType<ChartController['drawing']['beginPropertyEdit']>|null=null;
  let closed=$state(false);
  let returnFocus:HTMLElement|null=null;
  const layers=$derived(workspace.scene.document.layers.filter(l=>ids.includes(l.id)));
  const layer=$derived(layers.length===1?layers[0]:null);
  const drawing=$derived(layer?workspace.scene.document.drawings.find(d=>d.id===layer.id):undefined);
  const tool=$derived(drawing?drawingPlugins.core.get(drawing.toolId):undefined);
  const Editor=$derived(drawing?drawingPlugins.get(drawing.toolId)?.Editor:undefined);
  const instance=$derived(layer?workspace.scene.document.indicators.find(i=>i.instanceId===layer.id):undefined);
  const locked=$derived(layers.some(l=>controller.layerStatus(l.id).locked));
  const title=$derived(layer?workspaceLayerName(controller,workspace.scene.document,layer,$t):tool?$t(tool.name):layers.length>1?$t('{0} 个对象',{0:layers.length}):$t('对象属性'));
  const tabs=$derived([...(drawing?[{id:'style',label:'样式'},{id:'coordinates',label:'坐标'}]:instance?[{id:'inputs',label:'输入'},{id:'style',label:'样式'}]:[]),{id:'visibility',label:'可见性'},{id:'layer',label:'图层'}]);
  const activeTab=$derived(tabs.some(t=>t.id===tab)?tab:tabs[0].id);
  $effect(()=>{
    workspace.scene.selectedIds;
    if(session&&!session.valid()&&!closed)close(false);
  });
  onMount(()=>{
    returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
    session=controller.drawing.beginPropertyEdit([...ids]);
    const unsubscribe=controller.drawing.subscribe(value=>workspace=value);
    dialog.showModal();place();
    dialog.querySelector<HTMLButtonElement>('[role=tab][aria-selected=true]')?.focus();
    const resize=()=>place();window.addEventListener('resize',resize);
    const observer=new ResizeObserver(resize);observer.observe(dialog);
    return ()=>{unsubscribe();observer.disconnect();window.removeEventListener('resize',resize);session?.cancel();};
  });
  function place(){
    if(!dialog?.open)return;
    const chart=chartBounds(),width=dialog.offsetWidth,height=dialog.offsetHeight;
    x=Math.max(12,Math.min(window.innerWidth-width-12,positioned?x:chart.left+(chart.width-width)/2));
    y=Math.max(12,Math.min(window.innerHeight-height-12,positioned?y:chart.top+36));
    positioned=true;
  }
  async function selectTab(value:string){tab=value;await tick();place();}
  function releaseModal(){
    if(!dialog)return;
    dialog.classList.add('closing');
    setSurfaceInteractive(dialog,false);
    if(dialog.open)dialog.close();
  }
  function close(apply:boolean){
    if(closed)return;
    if(apply&&session&&!session.valid())apply=false;
    if(apply){
      const invalid=Array.from(dialog.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input,select,textarea')).find(input=>!input.checkValidity());
      if(invalid){invalid.reportValidity();invalid.focus();return;}
    }
    closed=true;apply?session?.commit():session?.cancel();releaseModal();onClose();
    void tick().then(()=>{if(returnFocus?.isConnected&&returnFocus!==document.body&&returnFocus!==document.documentElement)returnFocus.focus();else controller.focus();});
  }
  function startDrag(event:PointerEvent){
    if(event.button!==0)return;event.preventDefault();
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:x,top:y};(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function moveDrag(event:PointerEvent){if(!drag||drag.id!==event.pointerId)return;x=drag.left+event.clientX-drag.x;y=drag.top+event.clientY-drag.y;place();}
  function endDrag(event:PointerEvent){if(drag?.id!==event.pointerId)return;drag=null;const target=event.currentTarget as HTMLElement;if(target.hasPointerCapture(event.pointerId))target.releasePointerCapture(event.pointerId);}
  const localDate=(time:number)=>new Date(time-new Date(time).getTimezoneOffset()*60000).toISOString().slice(0,19);
  function coordinate(index:number,key:'time'|'value',value:number){
    if(!drawing||!Number.isFinite(value))return;
    controller.drawing.updateSelected({points:drawing.points.map((p,i)=>i===index?{...p,[key]:value}:p)});
  }
</script>
<dialog bind:this={dialog} class="object-dialog" class:closing={closed} aria-labelledby="object-dialog-title" aria-hidden={closed} style:left={`${x}px`} style:top={`${y}px`} transition:surface|global={{enter:160,exit:110,y:6}} onoutrostart={releaseModal} oncancel={(e)=>{e.preventDefault();close(false);}} onclick={(e)=>{if(e.target===dialog){const b=dialog.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)close(false);}}}>
  <header>
    <button class="dialog-grip" aria-label={$t("拖动属性窗口")} title={$t("拖动属性窗口")} onpointerdown={startDrag} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={endDrag} onlostpointercapture={()=>drag=null}><ToolIcon name="grip" size={18}/></button>
    <h2 id="object-dialog-title">{title}</h2><span>{$t("属性")}</span>
    <button class="dialog-close" aria-label={$t("关闭属性弹窗")} title={$t("关闭并取消本次修改")} onclick={()=>close(false)}><ToolIcon name="close" size={19}/></button>
  </header>
  <div class="property-tabs" role="tablist" tabindex="-1" aria-label={$t("对象属性分类")} onkeydown={(e)=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const index=tabs.findIndex(t=>t.id===activeTab);const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;void selectTab(tabs[next].id).then(()=>dialog.querySelector<HTMLButtonElement>('[role=tab][aria-selected=true]')?.focus());}}}>
    {#each tabs as item}<button role="tab" tabindex={activeTab===item.id?0:-1} aria-selected={activeTab===item.id} class:active={activeTab===item.id} onclick={()=>selectTab(item.id)}>{$t(item.label)}</button>{/each}
  </div>
  <div class="dialog-body" role="tabpanel" aria-label={$t(tabs.find(t=>t.id===activeTab)?.label)}>
    {#if locked}<p class="locked-note"><ToolIcon name="lock" size={14}/>{$t("此对象已锁定，样式、坐标与参数不可修改。")}</p>{/if}
    {#if activeTab==='style'&&drawing&&tool}
      <label class="property-field"><span>{$t("线条颜色")}</span><input type="color" aria-label={$t("绘图颜色")} value={drawing.style.color} disabled={locked} onchange={(e)=>controller.drawing.updateSelected({style:{color:e.currentTarget.value}})}/><code>{drawing.style.color}</code></label>
      <label class="property-field"><span>{$t("线宽")}</span><select aria-label={$t("绘图线宽")} value={drawing.style.width} disabled={locked} onchange={(e)=>controller.drawing.updateSelected({style:{width:Number(e.currentTarget.value)}})}>{#each [1,2,3,4,6,8] as width}<option value={width}>{width} px</option>{/each}</select></label>
      {#if tool.supportsLabels||tool.fields?.some(field=>['text','label','fontSize'].includes(field.key))}
        <label class="property-field"><span>{$t("标签字号")}</span><select aria-label={$t("绘图标签字号")} value={drawingFontSize(drawing)} disabled={locked} onchange={(e)=>controller.drawing.updateSelected({style:{fontSize:Number(e.currentTarget.value)}})}>{#each [...new Set([12,13,14,16,18,20,24,28,32,drawingFontSize(drawing)])].sort((a,b)=>a-b) as size}<option value={size}>{size} px</option>{/each}</select></label>
        <p class="label-note">{$t("字号独立于图表缩放。")}{tool.id==='fib-retracement'?$t("密集标签自动避让；空间不足时保留关键标签，所有水平线仍显示。"):$t("标签底色会随字号适配。")}</p>
      {/if}
      <label class="property-field"><span>{$t("线型")}</span><select aria-label={$t("绘图线型")} value={drawing.style.dash} disabled={locked} onchange={(e)=>controller.drawing.updateSelected({style:{dash:e.currentTarget.value as DrawingStyle['dash']}})}><option value="solid">{$t("实线")}</option><option value="dashed">{$t("虚线")}</option><option value="dotted">{$t("点线")}</option></select></label>
      {#if tool.supportsFill}<label class="property-field"><span>{$t("填充透明度")}</span><input aria-label={$t("绘图填充透明度")} type="range" min="0" max="1" step="0.01" value={drawing.style.fillOpacity} disabled={locked} oninput={(e)=>controller.drawing.updateSelected({style:{fillOpacity:Number(e.currentTarget.value)}})}/><code>{Math.round(drawing.style.fillOpacity*100)}%</code></label>{/if}
      {#if Editor}<div class="plugin-editor"><Editor {drawing} disabled={locked} update={(props)=>controller.drawing.updateSelected({props})}/></div>
      {:else if tool.fields?.length}<div class="plugin-editor">{#each tool.fields.filter(field=>field.key!=='fontSize') as field}<label class="property-field"><span>{$t(field.label)}</span>
        {#if field.type==='select'}<select aria-label={$t(field.label)} value={String(drawing.props[field.key])} disabled={locked} onchange={(e)=>controller.drawing.updateSelected({props:{[field.key]:e.currentTarget.value}})}>{#each field.options??[] as option}<option value={option}>{$t(option)}</option>{/each}</select>
        {:else if field.type==='number'}<input aria-label={$t(field.label)} type="number" min={field.min} max={field.max} required value={Number(drawing.props[field.key])} disabled={locked} onchange={(e)=>{if(Number.isFinite(e.currentTarget.valueAsNumber))controller.drawing.updateSelected({props:{[field.key]:Math.max(field.min??-Infinity,Math.min(field.max??Infinity,e.currentTarget.valueAsNumber))}});}}/>
        {:else}<input aria-label={$t(field.label)} value={String(drawing.props[field.key])} maxlength="2000" disabled={locked} onchange={(e)=>controller.drawing.updateSelected({props:{[field.key]:e.currentTarget.value}})}/>{/if}
      </label>{/each}</div>{/if}
    {:else if activeTab==='style'&&instance}
      <StudyStyleEditor {controller} {instance} {locked} reading={chartState?.readings.find(r=>r.id===instance.instanceId)}/>
    {:else if activeTab==='coordinates'&&drawing}
      <p class="section-note">{$t("锚点按本地时间与所在窗格的数值保存。")}</p>
      {#each drawing.points.map((point,index)=>({point,index})).filter(({index})=>drawing.points.length<=8||index===0||index===drawing.points.length-1) as {point,index}}
        <fieldset disabled={locked}><legend>{$t("控制点")} {index+1}</legend><label class="property-field"><span>{$t("时间")}</span><input aria-label={$t("控制点 {0} 时间", {0: index+1})} type="datetime-local" step="1" required value={localDate(point.time)} onchange={(e)=>coordinate(index,'time',new Date(e.currentTarget.value).getTime())}/></label><label class="property-field"><span>{$t("数值")}</span><input aria-label={$t("控制点 {0} 数值", {0: index+1})} type="number" step="any" required value={point.value} onchange={(e)=>coordinate(index,'value',e.currentTarget.valueAsNumber)}/></label></fieldset>
      {/each}
      {#if drawing.points.length>8}<p class="section-note">{$t("共 {0} 个路径点；此处调整起止点，其余路径可在图表中拖动。",{0:drawing.points.length})}</p>{/if}
    {:else}
      <LayerInspector {controller} {workspace} selectionIds={ids} section={activeTab==='inputs'?'inputs':activeTab==='visibility'?'visibility':'layer'} embedded/>
    {/if}
    {#if workspace.error}<p class="property-error" role="status">{translateError(workspace.error,$locale)}</p>{/if}
  </div>
  <footer><span>{$t("即时预览 · 确定后保存")}</span><button class="cancel" onclick={()=>close(false)}>{$t("取消")}</button><button class="confirm" onclick={()=>close(true)}>{$t("确定")}</button></footer>
</dialog>
<style>
  .object-dialog{position:fixed;inset:auto;margin:0;width:min(540px,calc(100vw - 24px));max-height:calc(100dvh - 24px);padding:0;border:1px solid var(--line-strong);background:var(--surface-raised);color:var(--text-strong);box-shadow:var(--shadow-lg);overflow:hidden;flex-direction:column;z-index:40}.object-dialog[open],.object-dialog.closing{display:flex}.object-dialog::backdrop{background:color-mix(in srgb, var(--bg-panel) 42%, transparent);animation:backdrop-in 160ms ease-out}.object-dialog.closing{pointer-events:none}
  header{display:flex;align-items:center;gap:10px;padding:12px 15px;border-bottom:1px solid var(--line-strong);min-height:58px;flex-shrink:0}header h2{margin:0;font-size:16px;font-weight:500;max-width:350px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}header>span{font-size:11px;color:var(--text-dim)}.dialog-grip{display:flex;align-items:center;justify-content:center;padding:0;width:20px;height:28px;cursor:grab;touch-action:none}.dialog-grip:active{cursor:grabbing}.dialog-close{margin-left:auto;width:30px;height:30px;padding:4px;display:flex;align-items:center;justify-content:center}
  .property-tabs{display:flex;gap:16px;padding:0 22px;border-bottom:1px solid var(--line-strong);flex-shrink:0}.property-tabs button{height:43px;padding:8px 4px;font-size:12px;border-bottom:2px solid transparent}.property-tabs .active{color:var(--text);border-bottom-color:var(--accent);background:transparent}.dialog-body{padding:18px 24px 24px;overflow:auto;min-height:220px;max-height:calc(100dvh - 225px)}
  .property-field{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--text-dim);margin:14px 0;min-height:34px}.property-field>span:first-child{width:105px;flex-shrink:0}.property-field input:not([type=color]):not([type=range]),.property-field select{flex:1;min-width:0}.property-field input,.property-field select{height:34px;font:12px var(--mono);color:var(--text-strong);background:var(--surface-sunken);border:1px solid var(--line-strong);padding:6px 9px}.property-field input[type=color]{width:44px;padding:3px;cursor:pointer}.property-field input[type=range]{width:175px;accent-color:var(--accent);padding:0;border:0}.property-field code{font:11px var(--mono);color:var(--text-dim)}.plugin-editor{margin-top:20px;padding-top:12px;border-top:1px solid var(--line-strong)}.section-note{font-size:11px;color:var(--text-dim);line-height:1.8;margin:0 0 18px}fieldset{border:1px solid var(--line-strong);padding:6px 14px;margin:14px 0}legend{font-size:11px;color:var(--text-dim);padding:0 7px}.locked-note{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--warn);padding:9px 10px;background:var(--warn-soft);margin:0 0 16px}.property-error{font-size:11px;color:var(--warn);margin:15px 0 0}
  footer{display:flex;align-items:center;gap:9px;padding:14px 20px;border-top:1px solid var(--line-strong);flex-shrink:0}footer>span{font-size:11px;color:var(--text-dim);margin-right:auto}footer button{height:34px;min-width:69px;padding:6px 16px;font-size:12px;border:1px solid var(--line-strong)}.confirm{background:var(--accent);color:white;border-color:var(--accent)}button:disabled,input:disabled,select:disabled{opacity:.45;cursor:default}
  .label-note{margin:-6px 0 18px;font-size:11px;line-height:1.6;color:var(--text-dim);text-wrap:pretty}
  @keyframes backdrop-in{from{background:transparent}to{background:color-mix(in srgb, var(--bg-panel) 42%, transparent)}}
  @media(prefers-reduced-motion:reduce){.object-dialog::backdrop{animation:none}}
  @media(max-width:600px){.dialog-body{padding:12px 16px 18px}.property-tabs{padding:0 14px;gap:16px}.property-field>span:first-child{width:84px}.property-field input[type=range]{width:110px}header{padding:10px}footer>span{max-width:112px;line-height:1.5}.dialog-body{min-height:150px}}
</style>
