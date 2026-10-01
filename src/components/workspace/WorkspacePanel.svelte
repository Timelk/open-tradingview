<script lang="ts">
  import {workspaceLayerName,workspacePlotName} from './names';
  import {t, canonicalT, translateError, locale} from '../../lib/i18n';
  import { surface, setSurfaceInteractive } from '../../lib/ui/motion';
  import { formatMarketPrice,marketPriceDigits } from '../../lib/core/market-format';
  import { untrack, tick, onMount } from 'svelte';
  import { panelMetrics, observeCoarsePointer, reanchorVirtualScroll, type PanelDensity, type VirtualRowGeometry } from '../../lib/ui/panel-density';
  import type { ChartController,ChartState } from '../../lib/chart/controller';
  import type { DrawingState } from '../../lib/drawing/types';
  import type { SceneLayer } from '../../lib/scene/types';
  import {visibleSceneLayers} from '../../lib/chart/scene-visibility';
  import { TIMEFRAMES } from '../../lib/scene/types';
  import { descendants } from '../../lib/scene/model';
  import { drawingPlugins } from '../../plugins/drawing-tools';
  import ToolIcon from '../drawing/ToolIcon.svelte';
  let {controller,chartState,tab,onTab,onClose,onOpenProperties,onTreeSelection,onOpenLibrary,density='compact',embedded=false}:{controller:ChartController;chartState:ChartState;tab:'objects'|'data'|'indicators';onTab:(tab:'objects'|'data'|'indicators')=>void;onClose:()=>void;onOpenProperties:(ids:string[])=>void;onTreeSelection:()=>void;onOpenLibrary?:()=>void;density?:PanelDensity;embedded?:boolean}=$props();
  let coarse=$state(false);
  const metrics=$derived(panelMetrics(density,coarse));
  onMount(()=>observeCoarsePointer(value=>coarse=value));
  let workspace=$state<DrawingState>(untrack(()=>controller.drawing.state));
  let search=$state(''),view=$state('pane'),visibility=$state('all'),collapsed=$state<string[]>([]),expandedPlots=$state<string[]>([]),lastSelection=$state('');
  let dragging=$state<string[]>([]),dropTarget=$state(''),message=$state(''),source=$state('chart'),dataVisibleOnly=$state(false);
  let fileInput=$state<HTMLInputElement>();
  let treeElement=$state<HTMLDivElement>();
  let treeTop=$state(0),treeHeight=$state(400);
  let lastRevealed='';
  $effect(()=>{if(!treeElement)return;treeElement.scrollTop=untrack(()=>treeTop);const observer=new ResizeObserver(()=>treeHeight=treeElement?.clientHeight??400);observer.observe(treeElement);return ()=>observer.disconnect();});
  $effect(()=>controller.drawing.subscribe(value=>workspace=value));
  const chartInterval=$derived(chartState.interval);
  const plotCountSignature=$derived(chartState.readings.map(r=>`${r.id}:${r.values.length}`).join('|'));
  const plotCounts=$derived(new Map(plotCountSignature.split('|').filter(Boolean).map(entry=>{const divider=entry.lastIndexOf(':');return [entry.slice(0,divider),Number(entry.slice(divider+1))] as const;})));
  const doc=$derived({...workspace.scene.document,layers:visibleSceneLayers(workspace.scene.document.layers)}),selection=$derived(workspace.scene.selectedIds);
  const groupNames:Record<string,string>={drawing:'绘图对象',indicator:'指标实例',series:'行情序列',overlay:'外部数据',group:'分组'};
  function name(layer:SceneLayer){return workspaceLayerName(controller,doc,layer,$t)||$t(groupNames[layer.kind]);}
  function paneName(id:string){const layer=doc.layers.find(l=>l.paneId===id&&l.kind==='indicator');return id==='main'?$t('主图'):id==='volume'?$t('成交量'):layer?name(layer):$t('绘图窗格');}
  function readingName(id:string,fallback:string){const layer=doc.layers.find(l=>l.id===id);return layer?name(layer):fallback;}
  function plotName(id:string,value:string){return workspacePlotName(controller,doc,id,value,$canonicalT);}
  function parameterSummary(instanceId:string){
    const instance=doc.indicators.find(i=>i.instanceId===instanceId);if(!instance)return '';
    const def=controller.registry.list().find(d=>d.id===instance.id);
    if(def?.category==='analysis')return $t('闭柱证据');
    if(def?.category==='pattern')return $t('拐点 {strength}{close}',{strength:instance.params.pivotStrength??3,close:['pattern-huzi','pattern-confluence'].includes(instance.id)?$t(' · 收盘 {count}',{count:instance.params.breakoutCloses??1}):''});
    if(def?.analysisFamily==='flow')return instance.params.unit==='quote'?'USDT':$t('基础量');
    return Object.entries(instance.params).filter(([key,value])=>key!=='divergenceStrength'&&typeof value!=='boolean'&&String(value).trim()!=='').slice(0,4).map(([key,value])=>{const field=def?.inputs.find(i=>i.key===key);return field?.type==='select'?$t(field.optionLabels?.[String(value)]??String(value)):String(value);}).join(' / ');
  }
  function icon(layer:SceneLayer){return layer.kind==='group'?'folder':layer.kind==='series'?'candles':layer.kind==='indicator'?'indicator':layer.kind==='overlay'?'layers':drawingPlugins.core.get(doc.drawings.find(d=>d.id===layer.id)?.toolId??'')?.icon??'zone';}
  function timeframe(layer:SceneLayer){const i=doc.indicators.find(i=>i.instanceId===layer.id);return i?(i.timeframe==='chart'?chartInterval:i.timeframe):layer.createdInterval;}
  function matches(layer:SceneLayer):boolean {
    const status=controller.layerStatus(layer.id);
    const text=`${name(layer)} ${layer.kind} ${layer.paneId} ${timeframe(layer)}`.toLowerCase();
    return (!search||text.includes(search.toLowerCase()))&&(visibility==='all'||(visibility==='visible'?status.visible:!status.visible));
  }
  function included(layer:SceneLayer):boolean {return matches(layer)||(layer.kind==='group'&&descendants(doc,layer.id).some(id=>{const l=doc.layers.find(l=>l.id===id);return !!l&&matches(l);}));}
  interface Row {key:string;title?:string;layer?:SceneLayer;depth:number;count?:number}
  const rows=$derived.by(()=>{
    const out:Row[]=[];
    if(view==='pane'){
      const panes=[...new Set(['main',...doc.layers.map(l=>l.paneId)])];
      for(const pane of panes){
        const layers=doc.layers.filter(l=>l.paneId===pane),key=`pane:${pane}`;
        if(!layers.some(included))continue;
        out.push({key,title:paneName(pane),depth:0,count:layers.filter(l=>l.kind!=='group').length});
        if(collapsed.includes(key)&&!search)continue;
        const walk=(parent:string|null,depth:number)=>{for(const layer of layers.filter(l=>l.parentId===parent).reverse()){
          if(!included(layer))continue;out.push({key:`layer:${layer.id}`,layer,depth});
          if(layer.kind==='group'&&(!collapsed.includes(layer.id)||search))walk(layer.id,depth+1);
        }};walk(null,0);
      }
    }else{
      const leaves=doc.layers.filter(l=>l.kind!=='group'&&matches(l)).reverse();
      const groups=[...new Set(leaves.map(l=>view==='type'?l.kind:timeframe(l)))];
      for(const group of groups){const items=leaves.filter(l=>(view==='type'?l.kind:timeframe(l))===group),key=`${view}:${group}`;
        out.push({key,title:view==='type'?$t(groupNames[group]):$t('{0} · 来源周期',{0:group}),depth:0,count:items.length});
        if(!collapsed.includes(key)||search)items.forEach(layer=>out.push({key:`layer:${layer.id}`,layer,depth:0}));
      }
    }
    return out;
  });
  const positioned=$derived.by(()=>{
    let top=0;
    return rows.map(row=>{
      const count=row.layer?plotCounts.get(row.layer.id):0;
      const expanded=row.layer&&expandedPlots.includes(row.layer.id);
      const height=row.layer?metrics.treeRow+(expanded?Math.max(1,count??0)*metrics.plotRow:0):metrics.paneHeading;
      const result={row,top,height};top+=height;return result;
    });
  });
  const totalHeight=$derived(positioned.length?positioned.at(-1)!.top+positioned.at(-1)!.height:0);
  const visibleRows=$derived(positioned.filter(item=>item.top+item.height>=treeTop-180&&item.top<=treeTop+treeHeight+180));
  let previousGeometry:{key:string;rows:VirtualRowGeometry[]}|null=null;
  $effect(()=>{
    const key=`${metrics.treeRow}:${metrics.paneHeading}:${metrics.plotRow}`;
    const layout=positioned.map(({row,top,height})=>({key:row.key,top,height}));
    const previous=previousGeometry;previousGeometry={key,rows:layout};
    if(!previous||previous.key===key)return;
    const node=untrack(()=>treeElement),top=untrack(()=>treeTop);
    const next=reanchorVirtualScroll(previous.rows,layout,top);
    void tick().then(()=>{if(node&&node===treeElement){node.scrollTop=next;treeTop=node.scrollTop;}});
  });
  $effect(()=>{
    const id=selection.length===1?selection[0]:'';if(!id||id===lastRevealed)return;lastRevealed=id;
    const layer=doc.layers.find(l=>l.id===id);if(!layer)return;
    const parents=new Set<string>([`pane:${layer.paneId}`]);let parent=layer.parentId;
    while(parent){parents.add(parent);parent=doc.layers.find(l=>l.id===parent)?.parentId??null;}
    if(collapsed.some(id=>parents.has(id)))collapsed=collapsed.filter(id=>!parents.has(id));
    void tick().then(()=>{const item=positioned.find(item=>item.row.layer?.id===id);if(treeElement&&item&&(item.top<treeTop||item.top+item.height>treeTop+treeHeight))treeElement.scrollTop=Math.max(0,item.top-50);});
  });
  const targets=$derived(doc.layers.filter(l=>l.kind==='group'));
  function toggleCollapse(key:string){collapsed=collapsed.includes(key)?collapsed.filter(k=>k!==key):[...collapsed,key];}
  function choose(layer:SceneLayer,event:MouseEvent){
    onTreeSelection();
    let ids=[layer.id];
    if(event.shiftKey&&lastSelection){const order=rows.flatMap(r=>r.layer?[r.layer.id]:[]),a=order.indexOf(lastSelection),b=order.indexOf(layer.id);if(a>=0&&b>=0)ids=order.slice(Math.min(a,b),Math.max(a,b)+1);}
    else if(event.ctrlKey||event.metaKey)ids=selection.includes(layer.id)?selection.filter(id=>id!==layer.id):[...selection,layer.id];
    controller.drawing.selectLayers(ids);lastSelection=layer.id;
  }
  function dragStart(layer:SceneLayer,event:DragEvent){onTreeSelection();dragging=selection.includes(layer.id)?selection:[layer.id];controller.drawing.selectLayers(dragging);event.dataTransfer?.setData('text/plain',JSON.stringify(dragging));if(event.dataTransfer)event.dataTransfer.effectAllowed='move';}
  function drop(layer:SceneLayer,event:DragEvent){
    event.preventDefault();const rect=(event.currentTarget as HTMLElement).getBoundingClientRect(),ratio=(event.clientY-rect.top)/rect.height;
    if(dragging.length){if(layer.kind==='group'&&ratio>.25&&ratio<.75)controller.drawing.moveLayers(dragging,layer.id);else controller.drawing.placeLayers(dragging,layer.id,ratio<.5);}
    dragging=[];dropTarget='';
  }
  function exportDocument(){const url=URL.createObjectURL(new Blob([controller.drawing.exportJSON()],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='chart-workspace.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function importDocument(){const file=fileInput?.files?.[0];if(!file)return;try{if(file.size>10_000_000)throw Error('文件不能超过 10MB');controller.drawing.importJSON(await file.text());message='工作区已导入';}catch(e){message=e instanceof Error?e.message:'导入失败';}if(fileInput)fileInput.value='';}
  function add(id:string){onTreeSelection();controller.addIndicator(id,source);onTab('objects');onOpenProperties(controller.drawing.state.scene.selectedIds);}
  const format=(value:number)=>formatMarketPrice(value,Math.max(5,marketPriceDigits(value)));
  const formatReading=(item:{value:number;unit?:'price'|'count';plot?:string})=>item.unit==='count'||item.plot==='patterns'||item.plot==='analysis'?(Number.isFinite(item.value)?String(Math.round(item.value)):'—'):format(item.value);
</script>
{#snippet panelContent()}
  {#if !embedded}
  <div class="panel-tabs"><button class:active={tab==='objects'} onclick={()=>onTab('objects')}>{$t("对象树")}</button><button class:active={tab==='data'} onclick={()=>onTab('data')}>{$t("数据窗口")}</button><button class:active={tab==='indicators'} aria-label={$t("添加指标实例")} title={$t("指标库")} onclick={()=>onOpenLibrary?onOpenLibrary():onTab('indicators')}><ToolIcon name="indicator" size={18}/></button><button aria-label={$t("关闭右侧面板")} onclick={onClose}><ToolIcon name="close" size={16}/></button></div>
  {/if}
  <div class="market-heading"><ToolIcon name="candles" size={18}/><strong>{chartState.symbol}</strong><span>{chartState.source==='mock'?$t("模拟"):'Binance'} · {chartState.interval}</span></div>
  {#if tab==='objects'}
    <div class="object-actions">
      <button aria-label={$t("新建图层组")} title={$t("将所选对象分组，或新建空组")} onclick={()=>controller.drawing.createGroup()}><ToolIcon name="folder-add" size={20}/></button>
      <button aria-label={$t("复制所选图层")} title={$t("复制所选图层")} disabled={!selection.length} onclick={()=>controller.drawing.cloneLayers(selection)}><ToolIcon name="copy" size={18}/></button>
      <button aria-label={$t("图层上移")} title={$t("上移一层（更靠前）")} disabled={!selection.length} onclick={()=>controller.drawing.reorderLayers(selection,'forward')}><ToolIcon name="up" size={18}/></button>
      <button aria-label={$t("图层下移")} title={$t("下移一层（更靠后）")} disabled={!selection.length} onclick={()=>controller.drawing.reorderLayers(selection,'backward')}><ToolIcon name="down" size={18}/></button>
      <button aria-label={$t("编辑图层属性")} title={$t("图层属性（双击对象）")} disabled={!selection.length} onclick={()=>onOpenProperties(selection)}><ToolIcon name="settings" size={18}/></button>
      <select aria-label={$t("图层批量操作")} value="" onchange={(e)=>{const value=e.currentTarget.value;if(value==='front'||value==='back')controller.drawing.reorderLayers(selection,value);if(value==='hide'||value==='show')controller.drawing.updateLayers(selection,{visible:value==='show'});if(value==='lock'||value==='unlock')controller.drawing.updateLayers(selection,{locked:value==='lock'});if(value==='out')controller.drawing.moveLayers(selection,null);if(value==='ungroup')for(const id of selection)controller.drawing.ungroup(id);if(value==='delete')controller.drawing.removeLayers(selection);e.currentTarget.value='';}} disabled={!selection.length}><option value="">{$t("批量操作")}</option><option value="front">{$t("置于顶层")}</option><option value="back">{$t("置于底层")}</option><option value="hide">{$t("隐藏所选")}</option><option value="show">{$t("显示所选")}</option><option value="lock">{$t("锁定所选")}</option><option value="unlock">{$t("解锁所选")}</option><option value="out">{$t("移出分组")}</option><option value="ungroup">{$t("解散所选组")}</option><option value="delete">{$t("删除所选")}</option></select>
    </div>
    <div class="tree-filters"><input aria-label={$t("搜索图层")} placeholder={$t("搜索名称、类型、周期")} bind:value={search}/><div><select aria-label={$t("对象树分类维度")} bind:value={view}><option value="pane">{$t("按窗格与分组")}</option><option value="type">{$t("按元素类型")}</option><option value="timeframe">{$t("按来源周期")}</option></select><select aria-label={$t("图层可见性筛选")} bind:value={visibility}><option value="all">{$t("全部状态")}</option><option value="visible">{$t("当前可见")}</option><option value="hidden">{$t("当前隐藏")}</option></select></div></div>
    <div class="tree" bind:this={treeElement} onscroll={(e)=>treeTop=e.currentTarget.scrollTop} role="tree" tabindex="0" aria-label={$t("工作区图层")} onkeydown={(e)=>{if(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement)return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?controller.drawing.redo():controller.drawing.undo();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){e.preventDefault();controller.drawing.selectLayers(rows.flatMap(r=>r.layer?[r.layer.id]:[]));}if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();controller.drawing.removeLayers(selection);}if(e.altKey&&(e.key==='ArrowUp'||e.key==='ArrowDown')){e.preventDefault();controller.drawing.reorderLayers(selection,e.key==='ArrowUp'?'forward':'backward');}}}>
      <div aria-hidden="true" style:height={`${visibleRows[0]?.top??0}px`}></div>
      {#each visibleRows as item (item.row.key)}
        {@const row=item.row}
        {#if !row.layer}<button class="pane-heading" onclick={()=>toggleCollapse(row.key)}><span class:collapsed={collapsed.includes(row.key)}><ToolIcon name="down" size={12}/></span><strong>{row.title}</strong><span>{row.count}</span></button>
        {:else}
          {@const layer=row.layer}
          {@const status=controller.layerStatus(layer.id)}
          {@const instance=doc.indicators.find(i=>i.instanceId===layer.id)}
          {@const reading=chartState.readings.find(i=>i.id===layer.id)}
          <div class="tree-row" data-layer-id={layer.id} class:selected={selection.includes(layer.id)} class:muted={!status.visible} class:drop-target={dropTarget===layer.id} style:padding-left={`${8+row.depth*16}px`} role="treeitem" aria-selected={selection.includes(layer.id)} aria-level={row.depth+1} tabindex="0" draggable={!status.locked} ondragstart={(e)=>dragStart(layer,e)} ondragend={()=>{dragging=[];dropTarget='';}} ondragenter={(e)=>{if(dragging.length){e.preventDefault();dropTarget=layer.id;}}} ondragover={(e)=>{if(dragging.length){e.preventDefault();dropTarget=layer.id;}}} ondragleave={()=>dropTarget=''} ondrop={(e)=>drop(layer,e)} onclick={(e)=>choose(layer,e)} ondblclick={(e)=>{if(e.target instanceof Element&&e.target.closest('button,input,select'))return;onTreeSelection();onOpenProperties([layer.id]);}} onkeydown={(e)=>{if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();onTreeSelection();controller.drawing.selectLayers([layer.id]);if(e.key==='Enter')onOpenProperties([layer.id]);}}}>
            {#if layer.kind==='group'||instance}<button class="row-expand" aria-label={$t("展开 {0}", {0: name(layer)})} onclick={(e)=>{e.stopPropagation();if(instance)expandedPlots=expandedPlots.includes(layer.id)?expandedPlots.filter(i=>i!==layer.id):[...expandedPlots,layer.id];else toggleCollapse(layer.id);}}><span class:closed={instance?!expandedPlots.includes(layer.id):collapsed.includes(layer.id)}><ToolIcon name="down" size={11}/></span></button>{:else}<span class="row-spacer"></span>{/if}
            <span class="row-icon"><ToolIcon name={icon(layer)} size={19}/></span>
            <div class="row-name" title={`${name(layer)} · ${$canonicalT(status.reason||status.dataReason||"可见")}`}><span>{name(layer)}</span><small><span>{$canonicalT(status.dataReason)||(instance?parameterSummary(instance.instanceId):layer.kind==='group'?$t("{0} 个元素", {0: descendants(doc,layer.id).length}):$t(groupNames[layer.kind]))}</span><b>{instance?(instance.timeframe==='chart'?$t("图表 · {0}", {0: chartState.interval}):instance.timeframe):layer.intervals?layer.intervals.join(' · '):''}</b></small></div>
            {#if workspace.scene.activeGroupId===layer.id}<span class="target-mark" title={$t("新绘图的目标组")}>◎</span>{/if}
            {#if layer.intervals}<span class="interval-mark" title={$t("显示周期：{0}", {0: layer.intervals.join(', ')||$t("无")})}><ToolIcon name="clock" size={12}/></span>{/if}
            <div class="row-actions">
              <button class:lit={status.locked} aria-label={$t("{0}图层 {1}", {0: layer.locked?$t("解锁"):$t("锁定"), 1: layer.id})} title={status.locked&&!layer.locked?$t("由上级分组锁定"):layer.locked?$t("解锁"):$t("锁定")} onclick={(e)=>{e.stopPropagation();controller.drawing.updateLayers([layer.id],{locked:!layer.locked});}}><ToolIcon name={status.locked?'lock':'unlock'} size={15}/></button>
              <button class:hidden-eye={!status.visible} aria-label={$t("{0}图层 {1}", {0: layer.visible?$t("隐藏"):$t("显示"), 1: layer.id})} aria-pressed={layer.visible} title={$t("{0}此图层{1}", {0: layer.visible?$t("隐藏"):$t("显示"), 1: status.reason||status.dataReason?` · ${$canonicalT(status.reason||status.dataReason)}`:''})} onclick={(e)=>{e.stopPropagation();controller.drawing.updateLayers([layer.id],{visible:!layer.visible});}}><ToolIcon name={status.visible?'eye':'hidden'} size={17}/></button>
              <button aria-label={$t("删除图层 {0}", {0: layer.id})} title={$t("删除（可撤销）")} disabled={status.locked} onclick={(e)=>{e.stopPropagation();controller.drawing.removeLayers([layer.id]);}}><ToolIcon name="trash" size={15}/></button>
            </div>
          </div>
          {#if instance&&expandedPlots.includes(layer.id)}
            {#each reading?.values??[] as plot (plot.plotIndex??plot.name)}<div class="plot-row" style:padding-left={`${42+row.depth*16}px`}><span style:background={plot.color}></span><span>{plotName(layer.id,plot.name)}</span><span class="num">{formatReading(plot)}</span><button aria-label={$t("切换指标序列 {0} {1}", {0: layer.id, 1: plot.plotIndex})} title={plot.hidden?$t("显示序列"):$t("隐藏序列")} onclick={()=>controller.toggleIndicatorPlot(layer.id,plot.plotIndex??0)}><ToolIcon name={plot.hidden?'hidden':'eye'} size={14}/></button></div>{/each}
            {#if !reading?.values.length}<p class="plot-status">{$canonicalT(status.reason||"正在计算…")}</p>{/if}
          {/if}
        {/if}
      {/each}
      <div aria-hidden="true" style:height={`${Math.max(0,totalHeight-(visibleRows.at(-1)?visibleRows.at(-1)!.top+visibleRows.at(-1)!.height:0))}px`}></div>
      {#if !rows.length}<p class="empty">{$t("没有符合筛选条件的元素")}</p>{/if}
    </div>
    <div class="tree-footer"><span>{selection.length?$t("已选择 {0} 项", {0: selection.length}):$t("{0} 个元素", {0: doc.layers.filter(l=>l.kind!=='group').length})}</span><button title={$t("导出图层、分组、绘图与指标配置")} onclick={exportDocument}><ToolIcon name="download" size={13}/>{$t("导出")}</button><button onclick={()=>fileInput?.click()}><ToolIcon name="upload" size={13}/>{$t("导入")}</button><input bind:this={fileInput} class="file-input" type="file" accept=".json" aria-label={$t("导入工作区文件")} onchange={importDocument}/></div>
    <div class="creation-target"><span>{$t("新绘图加入")}</span><select aria-label={$t("新绘图目标组")} value={workspace.scene.activeGroupId??''} onchange={(e)=>controller.drawing.setActiveGroup(e.currentTarget.value||null)}><option value="">{$t("当前窗格根层")}</option>{#each targets as group}<option value={group.id}>{paneName(group.paneId)} / {name(group)}</option>{/each}</select></div>

  {:else if tab==='data'}
    <div class="data-scroll">
      <div class="data-time"><strong>{chartState.hover?$t("十字光标数据"):$t("最新数据")}</strong><span>{chartState.quote?new Date(chartState.quote.time).toLocaleString($locale,{hour12:false}):'—'}</span></div>
      <label class="data-filter"><input type="checkbox" bind:checked={dataVisibleOnly}/>{$t("只看当前可见图层")}</label>
      <section class="data-section"><div class="data-title"><ToolIcon name="candles" size={17}/><strong>{chartState.symbol}</strong><span>{chartState.interval}</span></div>{#each [['开盘','open'],['最高','high'],['最低','low'],['收盘','close'],['成交量','volume']] as [label,key] (key)}<div class="data-value"><span>{$t(label)}</span><b class="num">{format(chartState.quote?.[key as 'close']??NaN)}</b></div>{/each}</section>
      {#each chartState.readings.filter(r=>!dataVisibleOnly||r.visible) as reading (reading.id)}<section class="data-section" class:dimmed={!reading.visible}><div class="data-title"><ToolIcon name="indicator" size={16}/><button onclick={()=>{onTreeSelection();controller.drawing.selectLayers([reading.id]);onTab('objects');}}>{readingName(reading.id,reading.name)}</button><span>{reading.timeframe==='chart'?chartState.interval:reading.timeframe}</span></div><p class="data-status">{$canonicalT(reading.status)}</p>{#each reading.values as value (value.plotIndex??value.name)}<div class="data-value"><span style:color={value.color}>{plotName(reading.id,value.name)}{value.hidden?$t(" · 已隐藏"):''}</span><b class="num">{formatReading(value)}</b></div>{/each}{#if !reading.values.length}<p class="empty">{$t("暂无可用数据")}</p>{/if}</section>{/each}
    </div>
  {:else}
    <div class="library-scroll">{#if !doc.layers.some(l=>l.id==='series:candles')}<button onclick={()=>controller.restoreSeries('candles')}>{$t("恢复 K 线图层")}</button>{/if}{#if !doc.layers.some(l=>l.id==='series:volume')}<button onclick={()=>controller.restoreSeries('volume')}>{$t("恢复成交量柱")}</button>{/if}<div class="library-title">{$t("添加独立指标实例")}</div><p class="explanation">{$t("同一指标可添加多份，分别配置参数、周期与显示范围。")}</p><label class="library-source">{$t("计算周期")}<select aria-label={$t("新指标计算周期")} bind:value={source}><option value="chart">{$t("跟随图表（{0}）",{0:chartState.interval})}</option>{#each Object.keys(TIMEFRAMES) as interval}<option value={interval} disabled={TIMEFRAMES[interval]<TIMEFRAMES[chartState.interval]}>{interval} {$t("· 聚合")}</option>{/each}</select></label>
      {#each controller.registry.list() as definition}<div class="library-row"><ToolIcon name="indicator" size={21}/><div><strong>{(definition.source==='builtin'?$t(definition.name):definition.name)}</strong><span>{definition.target==='main'?$t("主图叠加"):definition.target==='volume'?$t("成交量窗格"):$t("独立指标窗格")} {$t("· 已添加")} {doc.indicators.filter(i=>i.id===definition.id).length} {$t("份")}</span></div><button aria-label={$t("添加 {0} 指标实例", {0: (definition.source==='builtin'?$t(definition.name):definition.name)})} disabled={source!=='chart'&&TIMEFRAMES[source]<TIMEFRAMES[chartState.interval]} onclick={()=>add(definition.id)}>{$t("＋ 添加")}</button></div>{/each}
      <p class="explanation">{$t("高周期由当前 OHLCV 聚合；普通指标末端实时预览，历史保留已确认值；策略按确认规则更新。低周期需独立数据源。")}</p>
    </div>
  {/if}
  {#if message||workspace.error}<div class="panel-message" role="status">{translateError(workspace.error||message,$locale)}</div>{/if}
{/snippet}
{#if embedded}
  <aside class="workspace-panel" class:compact={density==='compact'} class:coarse={coarse} style:--tree-row-height={`${metrics.treeRow}px`} style:--pane-heading-height={`${metrics.paneHeading}px`} style:--plot-row-height={`${metrics.plotRow}px`} aria-label={$t("对象树与数据窗口")} class:embedded>{@render panelContent()}</aside>
{:else}
  <aside class="workspace-panel" class:compact={density==='compact'} class:coarse={coarse} style:--tree-row-height={`${metrics.treeRow}px`} style:--pane-heading-height={`${metrics.paneHeading}px`} style:--plot-row-height={`${metrics.plotRow}px`} aria-label={$t("对象树与数据窗口")} transition:surface|global={{x:8,y:0,enter:160,exit:100}} onintrostart={(e)=>setSurfaceInteractive(e.currentTarget,true)} onoutrostart={(e)=>setSurfaceInteractive(e.currentTarget,false)}>{@render panelContent()}</aside>
{/if}
<style>
  .workspace-panel{width:330px;flex:0 0 330px;min-height:0;display:flex;flex-direction:column;background:var(--bg-panel);border-left:1px solid var(--line);color:var(--text);position:relative;contain:layout style;z-index:7}.panel-tabs{display:flex;align-items:center;gap:3px;padding:6px;border-bottom:1px solid var(--line);min-height:47px}.panel-tabs button{height:33px;display:flex;align-items:center;justify-content:center}.panel-tabs button:nth-child(-n+2){flex:1;font-size:12px}.panel-tabs button.active{background:var(--bg-active);color:var(--text-strong);border-bottom:2px solid var(--accent)}.panel-tabs button:nth-child(n+3){padding:6px}.market-heading{display:flex;align-items:center;gap:8px;padding:12px 14px;color:var(--text-dim);border-bottom:1px solid var(--line);font-size:11px}.market-heading strong{color:var(--text);font:11px var(--mono)}.market-heading>span{margin-left:auto}.object-actions{display:flex;align-items:center;gap:2px;padding:6px 9px;border-bottom:1px solid var(--line)}.object-actions>button{width:31px;height:31px;padding:4px;display:flex;align-items:center;justify-content:center}.object-actions select{margin-left:auto;max-width:108px}.tree-filters{padding:8px 10px;display:flex;flex-direction:column;gap:6px;border-bottom:1px solid var(--line)}.tree-filters>div{display:flex;gap:5px}.tree-filters select{flex:1;min-width:0}.tree-filters input{width:100%}input,select{border:1px solid var(--line-strong);background-color:var(--surface-sunken);color:var(--text);padding:0 7px;font-size:11px;height:27px;min-height:27px;line-height:normal}select{padding-right:24px}.tree{flex:1;overflow:auto;min-height:110px}.pane-heading{height:var(--pane-heading-height);min-height:var(--pane-heading-height);box-sizing:border-box;display:flex;align-items:center;justify-content:flex-start;gap:7px;width:100%;padding:3px 10px;background:var(--surface-raised);border-bottom:1px solid var(--line);font-size:11px;color:var(--text-dim)}.pane-heading strong{font-weight:500}.pane-heading>span:last-child{margin-left:auto;font-family:var(--mono);color:var(--text-dim)}.collapsed{transform:rotate(-90deg)}.tree-row{display:flex;align-items:center;height:var(--tree-row-height);min-height:var(--tree-row-height);padding-right:7px;border-bottom:1px solid var(--line);cursor:pointer;outline:none}.tree-row{transition:background-color 100ms ease-out}.row-actions{transition:opacity 100ms ease-out}.row-expand span,.pane-heading>span:first-child{transition:transform 120ms ease-out}.tree-row:hover{background:var(--bg-hover)}.tree-row.selected{background:var(--accent-soft);color:var(--text-strong)}.tree-row:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}.tree-row.muted .row-name,.tree-row.muted .row-icon{opacity:.4}.row-spacer{width:14px;flex-shrink:0}.row-expand{width:14px;padding:0;flex-shrink:0;height:28px;display:flex;align-items:center}.row-expand .closed{transform:rotate(-90deg)}.row-icon{display:flex;align-items:center;margin-right:8px}.row-name{min-width:0;flex:1}.row-name>span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.row-name small{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim);margin-top:4px;overflow:hidden;white-space:nowrap}.row-name small>span{min-width:0;overflow:hidden;text-overflow:ellipsis}.row-name b{flex-shrink:0;font-weight:400;color:var(--text-dim)}.row-actions{display:flex;align-items:center;gap:1px;opacity:.22}.tree-row:hover .row-actions,.tree-row.selected .row-actions,.tree-row:focus-within .row-actions{opacity:1}.row-actions button{width:23px;height:28px;display:flex;align-items:center;justify-content:center;padding:0}.row-actions .lit{color:var(--text-dim)}.row-actions .hidden-eye{color:var(--warn);opacity:1}.tree-row.muted .row-actions{opacity:.8}.target-mark{color:var(--accent-strong);font-size:14px}.interval-mark{display:flex;color:var(--text-dim);margin-right:3px}.drop-target{box-shadow:inset 0 2px var(--accent),inset 0 -2px var(--accent);background:var(--bg-active)!important}.plot-row{display:flex;align-items:center;gap:8px;padding:3px 8px;height:var(--plot-row-height);min-height:var(--plot-row-height);color:var(--text-dim);background:var(--surface-sunken);font-size:11px}.plot-row>span:first-child{width:12px;height:2px}.plot-row .num{margin-left:auto}.plot-row button{padding:1px 4px;display:flex}.plot-status{font-size:11px;color:var(--text-dim);margin:0;height:var(--plot-row-height);min-height:var(--plot-row-height);padding:0 35px;display:flex;align-items:center}.tree-footer{display:flex;align-items:center;gap:5px;border-top:1px solid var(--line-strong);padding:6px 10px;font-size:11px;color:var(--text-dim)}.tree-footer>span{margin-right:auto}.tree-footer button{display:flex;gap:4px;font-size:11px;padding:4px}.creation-target{display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid var(--line);font-size:11px;color:var(--text-dim)}.creation-target select{min-width:0;flex:1;font-size:11px}.file-input{display:none}.empty{font-size:11px;color:var(--text-dim);padding:14px;line-height:1.7}.panel-message{font-size:11px;line-height:1.5;color:var(--warn);padding:8px 12px;border-top:1px solid var(--line-strong);background:var(--bg-hover)}.data-scroll,.library-scroll{overflow:auto;min-height:0;flex:1;padding:0 12px 16px}.data-time{display:flex;flex-direction:column;gap:6px;font-size:11px;padding:14px 0}.data-time strong{font-weight:500;color:var(--text)}.data-time>span{font:11px var(--mono);color:var(--text-dim)}.data-filter{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--text-dim);padding-bottom:12px}.data-filter input{height:auto;min-height:0;accent-color:var(--accent)}.data-section{border-top:1px solid var(--line);padding:10px 0 14px}.data-title{display:flex;align-items:center;gap:8px;font-size:11px;margin-bottom:8px}.data-title button{padding:0;color:var(--text);font-size:11px}.data-title>span:last-child{margin-left:auto;font:11px var(--mono);color:var(--text-dim)}.data-value{display:flex;align-items:center;justify-content:space-between;padding:5px 0;font-size:11px;color:var(--text-dim)}.data-value b{font-weight:400;color:var(--text-strong)}.data-status{font-size:11px;color:var(--text-dim);margin:4px 0 8px}.dimmed{opacity:.6}.library-title{padding-top:17px;font-size:13px;color:var(--text-strong)}.explanation{font-size:11px;line-height:1.8;color:var(--text-dim);margin:10px 0 16px}.library-source{font-size:11px;color:var(--text-dim);display:flex;align-items:center;gap:10px;margin-bottom:14px}.library-source select{flex:1;min-width:0}.library-row{display:flex;gap:10px;align-items:center;padding:14px 0;border-top:1px solid var(--line)}.library-row>div{flex:1}.library-row strong{font:12px var(--mono);display:block;color:var(--text)}.library-row span{font-size:11px;color:var(--text-dim);display:block;margin-top:5px}.library-row button{font-size:11px;color:var(--accent-strong);border:1px solid var(--line-strong);padding:6px 8px}
  @media(max-width:1000px){.workspace-panel{position:absolute;right:39px;top:0;bottom:0;width:310px;box-shadow:-8px 0 24px rgb(0 0 0 / calc(0.33 * var(--shadow-strength)))}}
  @media(max-width:470px){.workspace-panel{width:calc(100vw - 82px)}}

  .workspace-panel{min-width:0;container:workspace-width / inline-size}.panel-tabs,.market-heading,.object-actions,.tree-filters,.tree-footer,.creation-target{flex-shrink:0}.tree-row,.pane-heading,.plot-row,.plot-status{box-sizing:border-box}.row-name>span,.row-name small{min-width:0}.plot-row{overflow:hidden}.plot-row .num{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.data-value{gap:10px}.data-value b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.data-title{min-width:0}.data-title button{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.panel-message{flex-shrink:0;max-height:70px;overflow:auto;overflow-wrap:anywhere}
  .compact .panel-tabs{padding:3px 5px;min-height:37px}.compact .panel-tabs button{height:30px}.compact .panel-tabs button:nth-child(-n+2){font-size:11px}.compact .market-heading{padding:7px 10px;min-height:29px;font-size:11px}.compact .object-actions{padding:3px 7px}.compact .object-actions>button{width:28px;height:27px}.compact .tree-filters{padding:5px 8px;gap:4px}.compact .tree-filters input,.compact .tree-filters select{height:24px;min-height:24px;padding:0 5px;font-size:11px}.compact .tree-filters select{padding-right:22px}.compact .row-name{display:flex;align-items:center;gap:6px}.compact .row-name>span{font-size:11px;flex:1}.compact .row-name small{font-size:11px;line-height:1;max-width:45%;margin:0;gap:4px;flex-shrink:1}.compact .row-icon{margin-right:5px}.compact .row-actions button{height:26px;width:22px}.compact .row-expand{height:26px}.compact .tree-footer,.compact .creation-target{padding:4px 8px}.compact .creation-target select{height:24px;min-height:24px;padding:0 22px 0 5px}.compact .data-time{padding:10px 0;gap:4px}.compact .data-section{padding-block:8px 10px}.compact .data-value{padding-block:3px}.compact .data-filter{padding-bottom:8px}.coarse .row-actions button,.coarse .row-expand{height:40px}.coarse .row-actions button{width:30px}.coarse .plot-row button{min-height:36px}
  .workspace-panel.embedded{position:relative;inset:auto;width:100%;height:100%;max-width:100%;min-width:0;min-height:0;flex:1 1 auto;border:0;box-shadow:none;z-index:auto}.workspace-panel.embedded .tree{min-height:0}.workspace-panel.embedded .object-actions{min-width:0}.workspace-panel.embedded .object-actions select{min-width:0}.workspace-panel.embedded .object-actions>button{flex-shrink:0}.workspace-panel.embedded .data-scroll,.workspace-panel.embedded .library-scroll{min-width:0;max-width:100%}
  @container workspace-width (min-width:600px){.data-scroll{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:0 22px;align-content:start}.data-time,.data-filter{grid-column:1 / -1}.data-time{flex-direction:row;align-items:center;gap:15px}.data-filter{padding-bottom:8px}.data-section{min-width:0}.tree-filters{flex-direction:row;align-items:center}.tree-filters>input,.tree-filters>div{flex:1;min-width:0}.tree-filters>input{width:auto}.row-name small{max-width:none}}
  @container workspace-width (max-width:280px){.panel-tabs button:nth-child(-n+2){font-size:11px}.panel-tabs{gap:0}.object-actions{gap:0;padding-inline:3px}.compact .object-actions>button{width:24px}.object-actions select{max-width:70px;font-size:11px}.compact .row-name small{display:none}.row-icon{margin-right:3px}.row-actions{gap:0}.row-actions button{width:20px}.tree-filters{padding-inline:5px}.market-heading{gap:5px}.market-heading strong{font-size:11px}.creation-target>span{font-size:11px}.data-scroll,.library-scroll{padding-inline:8px}}
  @media(prefers-reduced-motion:reduce){.tree-row,.row-actions,.row-expand span,.pane-heading>span:first-child{transition:none}}
</style>
