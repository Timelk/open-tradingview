<script lang="ts">
  import {workspaceLayerName} from './names';
  import {t, canonicalT, locale} from '../../lib/i18n';
  import type { ChartController } from '../../lib/chart/controller';
  import type { DrawingState } from '../../lib/drawing/types';
  import { TIMEFRAMES } from '../../lib/scene/types';
  import { descendants } from '../../lib/scene/model';
  let {controller,workspace,onCollapse=()=>{},selectionIds,section='all',embedded=false}:{controller:ChartController;workspace:DrawingState;onCollapse?:()=>void;selectionIds?:string[];section?:'all'|'layer'|'visibility'|'inputs';embedded?:boolean}=$props();
  const doc=$derived(workspace.scene.document),ids=$derived(selectionIds??workspace.scene.selectedIds);
  const selected=$derived(doc.layers.filter(l=>ids.includes(l.id))),one=$derived(selected.length===1?selected[0]:null);
  const instance=$derived(one?doc.indicators.find(i=>i.instanceId===one.id):undefined);
  const definition=$derived(instance?controller.registry.list().find(d=>d.id===instance.id):undefined);
  const locked=$derived(selected.some(l=>controller.layerStatus(l.id).locked));
  const groups=$derived(doc.layers.filter(l=>l.kind==='group'&&selected.every(s=>s.paneId===l.paneId)&&!ids.includes(l.id)&&!ids.some(id=>descendants(doc,id).includes(l.id))));
  function intervalsPreset(mode:string){const current=TIMEFRAMES[workspace.scene.interval];controller.drawing.updateLayers(ids,{intervals:mode==='all'?null:mode==='current'?[workspace.scene.interval]:Object.keys(TIMEFRAMES).filter(k=>mode==='lower'?TIMEFRAMES[k]<=current:TIMEFRAMES[k]>=current)});}
  function toggleInterval(key:string){const previous=one?.intervals??Object.keys(TIMEFRAMES);controller.drawing.updateLayers(ids,{intervals:previous.includes(key)?previous.filter(i=>i!==key):[...previous,key]});}
</script>
{#if selected.length}
<section class="layer-inspector" class:embedded aria-label={$t("图层属性")}>
  {#if !embedded}
  <div class="inspector-heading"><strong>{selected.length===1?$t("对象属性"):$t("已选择 {0} 个对象", {0: selected.length})}</strong><button aria-label={$t("收起图层属性")} onclick={onCollapse}>−</button></div>
  {/if}
  {#if section==='all'||section==='layer'}
  {#if one}<label class="field"><span>{$t("名称")}</span><input aria-label={$t("图层名称")} value={one.name} maxlength="120" onchange={(e)=>controller.drawing.updateLayers(ids,{name:e.currentTarget.value})}/></label><div class="meta-line"><span>{one.kind==='group'?$t("图层组"):one.kind==='drawing'?$t("绘图"):one.kind==='indicator'?$t("指标实例"):one.kind==='series'?$t("行情序列"):$t("外部叠加")}</span><span>{$t("创建于")} {one.createdInterval}</span><span>{$canonicalT(controller.layerStatus(one.id).reason||controller.layerStatus(one.id).dataReason||"当前可见")}</span></div>{/if}
  <label class="field"><span>{$t("所属分组")}</span><select aria-label={$t("所属图层组")} disabled={locked} value={one?.parentId??''} onchange={(e)=>controller.drawing.moveLayers(ids,e.currentTarget.value||null)}><option value="">{$t("窗格根层")}</option>{#each groups as group}<option value={group.id}>{workspaceLayerName(controller,doc,group,$t)}</option>{/each}</select></label>
  <label class="field"><span>{$t("透明度")}</span><input aria-label={$t("图层透明度")} type="range" min="0" max="1" step="0.05" disabled={locked} value={one?.opacity??1} onchange={(e)=>controller.drawing.updateLayers(ids,{opacity:Number(e.currentTarget.value)})}/><span class="num">{Math.round((one?.opacity??1)*100)}%</span></label>
  {/if}
  {#if section==='all'||section==='visibility'}
  <div class="section-label">{$t("显示周期")} <span>{$t("仅控制显示")}</span></div>
  <div class="presets"><button onclick={()=>intervalsPreset('all')}>{$t("全部")}</button><button onclick={()=>intervalsPreset('current')}>{$t("仅当前")}</button><button onclick={()=>intervalsPreset('lower')}>{$t("当前及更低")}</button><button onclick={()=>intervalsPreset('higher')}>{$t("当前及更高")}</button></div>
  <div class="interval-chips">{#each Object.keys(TIMEFRAMES) as interval}<button class:chosen={!one?.intervals||one.intervals.includes(interval)} aria-label={$t("显示周期 {0}", {0: interval})} aria-pressed={!one?.intervals||one.intervals.includes(interval)} onclick={()=>toggleInterval(interval)}>{interval}</button>{/each}</div>
  {/if}
  {#if instance&&definition&&(section==='all'||section==='inputs')}
    <div class="section-label">{$t("计算周期")} <span>{$t("独立计算此指标")}</span></div>
    <select class="source-select" aria-label={$t("指标计算周期")} disabled={locked} value={instance.timeframe} onchange={(e)=>controller.setIndicatorTimeframe(instance.instanceId,e.currentTarget.value)}><option value="chart">{$t("跟随图表（{0}）",{0:workspace.scene.interval})}</option>{#each Object.keys(TIMEFRAMES) as interval}<option value={interval} disabled={TIMEFRAMES[interval]<TIMEFRAMES[workspace.scene.interval]}>{interval} · {definition.kind==='strategy'?$t("收盘确认"):$t("实时")}</option>{/each}</select>
    {#if instance.timeframe!=='chart'}<p class="explanation">{definition.kind==='strategy'?$t("形态与策略按确认规则推进。"):$t("末端随当前高周期更新；历史保留已确认值。")} {$t("低于主图周期需独立行情源。")}</p>{/if}
    {#each definition.inputs as param}
      <label class="field"><span>{$t(param.label)}</span>
        {#if param.type==='int'||param.type==='float'}<input aria-label={`${definition.source==='builtin'?$t(definition.name):definition.name} ${$t(param.label)}`} type="number" disabled={locked} min={param.min} max={param.max} step={param.step??1} value={(instance.params[param.key]??param.def) as number} onchange={(e)=>controller.setParam(instance.instanceId,param.key,e.currentTarget.valueAsNumber)}/>
        {:else if param.type==='bool'}<input type="checkbox" disabled={locked} checked={!!(instance.params[param.key]??param.def)} onchange={(e)=>controller.setParam(instance.instanceId,param.key,e.currentTarget.checked)}/>
        {:else if param.type==='select'}<select disabled={locked} value={String(instance.params[param.key]??param.def)} onchange={(e)=>controller.setParam(instance.instanceId,param.key,e.currentTarget.value)}>{#each param.options??[] as option}<option value={option}>{$t(param.optionLabels?.[option]??option)}</option>{/each}</select>
        {:else}<input type="color" disabled={locked} value={String(instance.params[param.key]??param.def)} onchange={(e)=>controller.setParam(instance.instanceId,param.key,e.currentTarget.value)}/>{/if}
      </label>
    {/each}
  {/if}
  {#if !embedded&&one?.kind==='group'&&(section==='all'||section==='layer')}<div class="group-actions"><button onclick={()=>controller.drawing.setActiveGroup(one.id)} class:chosen={workspace.scene.activeGroupId===one.id}>{$t("设为绘图目标")}</button><button onclick={()=>controller.drawing.ungroup(one.id)}>{$t("解散分组")}</button></div>{/if}
</section>
{/if}
<style>
  .layer-inspector{flex-shrink:0;border-top:1px solid var(--line);padding:0 12px 12px;max-height:46%;overflow:auto;background:var(--bg-panel)}.inspector-heading{display:flex;align-items:center;justify-content:space-between;height:36px;font-size:11px}.inspector-heading strong{font-weight:500}.inspector-heading button{font-size:19px;width:28px}.field{display:flex;align-items:center;gap:8px;margin:7px 0;font-size:11px;color:var(--text-dim)}.field>span:first-child{width:58px;flex-shrink:0}.field input:not([type=range]),.field select{min-width:0;flex:1}.field input[type=number]{max-width:95px;margin-left:auto}.field input[type=range]{width:120px;accent-color:var(--accent)}.field .num{margin-left:auto}input,select{background:var(--surface-sunken);color:var(--text-strong);border:1px solid var(--line-strong);min-height:27px;font:11px var(--mono);padding:4px 6px}.meta-line{display:flex;gap:9px;flex-wrap:wrap;color:var(--text-dim);font-size:11px;margin:5px 0 12px}.section-label{font-size:11px;margin:14px 0 7px;color:var(--text);display:flex;justify-content:space-between}.section-label span{font-size:11px;color:var(--text-dim)}.presets,.interval-chips,.group-actions{display:flex;gap:3px;flex-wrap:wrap}.presets button{font-size:11px;padding:5px 6px;border:1px solid var(--line)}.interval-chips{margin-top:6px}.interval-chips button{flex:1 0 38px;font:11px var(--mono);padding:5px 4px;border:1px solid var(--line)}.chosen{background:var(--accent-soft)!important;color:var(--accent-strong)!important;border-color:var(--line-strong)!important}.source-select{width:100%}.explanation{font-size:11px;line-height:1.6;color:var(--text-dim)}.group-actions{margin-top:10px}.group-actions button{font-size:11px;border:1px solid var(--line-strong)}
  .embedded{padding:0;max-height:none;overflow:visible;background:transparent;border:0;}
  .embedded .field{font-size:12px;margin:15px 0;gap:12px}.embedded .field>span:first-child{width:100px}.embedded input,.embedded select{font-size:12px;min-height:34px;padding:6px 9px}.embedded .meta-line{font-size:11px;line-height:1.7;margin:12px 0}.embedded .section-label{font-size:12px;margin:7px 0 15px}.embedded .section-label span{font-size:11px}.embedded .presets{gap:6px;flex-wrap:wrap}.embedded .presets button,.embedded .interval-chips button{font-size:11px;padding:8px 10px}.embedded .interval-chips{gap:6px;margin-top:15px}.embedded .explanation{font-size:11px;line-height:1.8;margin:12px 0}.embedded .group-actions{margin-top:20px}.embedded .group-actions button{font-size:11px;padding:8px 12px}
</style>
