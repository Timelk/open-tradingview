<script lang="ts">
  import {workspaceLayerName} from '../workspace/names';
  import {t, locale} from '../../lib/i18n';
  import { untrack } from 'svelte';
  import ContextMenu from '../ui/ContextMenu.svelte';
  import type { ContextMenuItem } from '../../lib/ui/context-menu';
  import type { ChartController,ChartState } from '../../lib/chart/controller';
  import { DEFAULT_STYLE,type Drawing,type DrawingState } from '../../lib/drawing/types';
  import { layerOf } from '../../lib/scene/types';
  import { formatMarketPrice } from '../../lib/core/market-format';
  import { shortcutKeyLabel } from '../../lib/ui/shortcuts';
  import { layerActionState,paneDrawingIds,contextLayerName,visibilityIntervals,type ChartMenuTarget,type VisibilityRange } from '../../lib/drawing/context-actions';
  let {controller,chartState,target,onClose,onOpenProperties,onReveal,onOpenLibrary,onOpenLayout,onOpenAppearance=()=>{}}:{
    controller:ChartController;chartState:ChartState;target:ChartMenuTarget;onClose:(restoreFocus?:boolean)=>void;
    onOpenProperties:(ids:string[])=>void;onReveal:(ids:string[])=>void;onOpenLibrary:()=>void;onOpenLayout:()=>void;
    onOpenAppearance?:()=>void;
  }=$props();
  let workspace=$state<DrawingState>(untrack(()=>controller.drawing.state));
  $effect(()=>controller.drawing.subscribe(value=>workspace=value));
  const doc=$derived(workspace.scene.document);
  const actions=$derived(layerActionState(doc,target.ids,chartState.interval,workspace.locked));
  const paneName=$derived.by(()=>{const layer=doc.layers.find(layer=>layer.paneId===target.paneId&&layer.kind==='indicator');return target.paneId==='main'?$t('主图'):target.paneId==='volume'?$t('成交量'):layer?workspaceLayerName(controller,doc,layer,$t):$t('当前窗格');});
  const price=$derived(target.anchor?formatMarketPrice(target.anchor.value):'');
  const label=$derived(target.ids.length>1?$t('{0} 个选中对象',{0:target.ids.length}):actions.selected[0]?workspaceLayerName(controller,doc,actions.selected[0],$t):$t(target.region==='price'?'{0}价格轴':target.region==='time'?'{0}时间轴':'{0}操作',{0:paneName}));
  $effect(()=>{
    if(target.market!==`${chartState.source}:${chartState.symbol}:${chartState.interval}`||target.ids.some(id=>!doc.layers.some(layer=>layer.id===id)))onClose(false);
  });
  function change(run:()=>void){
    if(target.market!==`${chartState.source}:${chartState.symbol}:${chartState.interval}`)return;
    run();
  }
  function setVisibility(range:VisibilityRange){change(()=>controller.drawing.updateLayers(target.ids,{intervals:visibilityIntervals(chartState.interval,range)}));}
  function addAt(toolId:string){
    const tool=controller.drawing.registry.get(toolId),anchor=target.anchor;
    if(!anchor||!tool||workspace.locked||workspace.hidden)return;
    const id=crypto.randomUUID();
    const drawing:Drawing={id,toolId,paneId:target.paneId,points:[{...anchor}],style:{...DEFAULT_STYLE,...tool.defaultStyle},props:Object.fromEntries((tool.fields??[]).map(field=>[field.key,field.default])),locked:false,hidden:false};
    change(()=>{controller.drawing.transact(current=>({...current,drawings:[...current.drawings,drawing],layers:[...current.layers,layerOf(id,'drawing',tool.name,target.paneId,{createdInterval:chartState.interval})]}));controller.drawing.selectDrawing(id);});
  }
  async function copyPrice(){
    if(!target.anchor)return;
    try{await navigator.clipboard.writeText(String(target.anchor.value));}
    catch{throw Error('价格未能复制，请允许此页面使用剪贴板后重试。');}
  }
  const items=$derived.by(()=>{
    const engine=controller.drawing,ids=target.ids,selected=actions.selected,mod=shortcutKeyLabel('Mod');
    const out:ContextMenuItem[]=[];
    if(ids.length){
      out.push({id:'properties',label:'属性设置…',icon:'gear',run:()=>onOpenProperties(ids)});
      if(actions.canClone)out.push({id:'clone',label:'创建副本',icon:'copy',run:()=>change(()=>engine.cloneLayers(ids))});
      out.push({id:'lock',label:actions.lockLabel,icon:selected.every(layer=>layer.locked)?'unlock':'lock',disabled:!actions.canUnlock,run:()=>change(()=>engine.updateLayers(ids,{locked:!selected.every(layer=>layer.locked)}))});
      out.push({id:'visibility',label:selected.every(layer=>!layer.visible)?'显示':'隐藏',icon:selected.every(layer=>!layer.visible)?'eye':'hidden',disabled:actions.locked,run:()=>change(()=>engine.updateLayers(ids,{visible:selected.every(layer=>!layer.visible)}))});
      out.push({id:'order',label:'显示顺序',icon:'layers',disabled:actions.locked,separatorBefore:true,children:[
        {id:'front',label:'置于顶层',run:()=>change(()=>engine.reorderLayers(ids,'front'))},
        {id:'forward',label:'上移一层',run:()=>change(()=>engine.reorderLayers(ids,'forward'))},
        {id:'backward',label:'下移一层',run:()=>change(()=>engine.reorderLayers(ids,'backward'))},
        {id:'back',label:'置于底层',run:()=>change(()=>engine.reorderLayers(ids,'back'))},
      ]});
      out.push({id:'intervals',label:'周期可见性',icon:'clock',disabled:actions.locked,children:[
        {id:'all-intervals',label:'所有周期',checked:selected.every(layer=>layer.intervals===null),run:()=>setVisibility('all')},
        {id:'current-interval',label:`仅当前周期 · ${chartState.interval}`,checked:selected.every(layer=>layer.intervals?.length===1&&layer.intervals[0]===chartState.interval),run:()=>setVisibility('current')},
        {id:'below-interval',label:'当前周期及以下',run:()=>setVisibility('below')},
        {id:'above-interval',label:'当前周期及以上',run:()=>setVisibility('above')},
        {id:'custom-intervals',label:'自定义…',run:()=>onOpenProperties(ids)},
      ]});
      const groupItems:ContextMenuItem[]=[{id:'new-group',label:'新建分组并移入',disabled:!actions.canGroup,run:()=>change(()=>{engine.selectLayers(ids);engine.createGroup('新建分组',target.paneId);})}];
      if(selected.some(layer=>layer.parentId))groupItems.push({id:'ungroup-objects',label:'移出所在分组',disabled:actions.locked,run:()=>change(()=>engine.moveLayers(ids,null))});
      if(selected.length===1&&selected[0].kind==='group')groupItems.push({id:'dissolve-group',label:'解散分组，保留对象',disabled:actions.locked,run:()=>change(()=>engine.ungroup(ids[0]))});
      groupItems.push(...actions.groups.map(group=>({id:`group-${group.id}`,label:`移入 ${workspaceLayerName(controller,doc,group,$t)}`,disabled:!actions.canGroup,run:()=>change(()=>engine.moveLayers(ids,group.id))})));
      out.push({id:'groups',label:'分组',icon:'folder',children:groupItems});
      out.push({id:'reveal',label:'在对象树中查看',icon:'objects',separatorBefore:true,run:()=>onReveal(ids)});
      if(actions.canRemove||selected.some(layer=>['drawing','indicator','group'].includes(layer.kind)))out.push({id:'remove',label:ids.length>1?`删除 ${ids.length} 个对象`:'删除',icon:'trash',shortcut:'Delete',danger:true,disabled:!actions.canRemove,run:()=>change(()=>engine.removeLayers(ids))});
    }else{
      out.push({id:'latest',label:'返回最新行情',icon:'ray',shortcut:'End',run:()=>controller.followLatest()});
      out.push({id:'reset-scale',label:`恢复${paneName}自动比例`,icon:'fit',run:()=>controller.resetPaneScale(target.paneId)});
      out.push({id:'pane',label:controller.maximizedPaneId===target.paneId?'恢复窗格显示':`最大化${paneName}`,icon:'maximize',run:()=>controller.toggleMaximize(target.paneId)});
      out.push({id:'chart-view',label:'图表视图',icon:'candles',children:[
        {id:'all-history',label:'查看全部已加载历史',shortcut:'Home',run:()=>controller.showAll()},
        {id:'pane-heights',label:'恢复窗格高度',run:()=>controller.resetPaneLayout()},
        {id:'smooth',label:'平滑图表动效',checked:chartState.smoothMotion,run:()=>controller.setSmoothMotion(!chartState.smoothMotion)},
      ]});
      if(target.anchor){
        out.push({id:'copy-price',label:`复制价格 ${price}`,icon:'copy',separatorBefore:true,run:copyPrice});
        out.push({id:'add-at',label:'在此处添加',icon:'plus',disabled:workspace.locked||workspace.hidden,children:[
          {id:'add-horizontal',label:'水平线',icon:'horizontal',run:()=>addAt('horizontal-line')},
          {id:'add-vertical',label:'垂直线',icon:'vertical',run:()=>addAt('vertical-line')},
          {id:'add-text',label:'文字注释',icon:'text',run:()=>addAt('text')},
        ]});
      }
      out.push({id:'studies',label:'添加指标或策略…',icon:'indicator',shortcut:'/',separatorBefore:true,run:onOpenLibrary});
      out.push({id:'objects',label:'打开对象树',icon:'objects',run:()=>onReveal([])});
      out.push({id:'all-drawings',label:workspace.hidden?'显示全部绘图':'隐藏全部绘图',icon:workspace.hidden?'eye':'hidden',disabled:doc.drawings.length===0,run:()=>engine.setOption('hidden',!workspace.hidden)});
      out.push({id:'magnet',label:'磁吸模式',icon:'magnet',children:[
        {id:'magnet-off',label:'关闭磁吸',checked:!workspace.magnet,run:()=>engine.setMagnetMode('off')},
        {id:'magnet-weak',label:'弱磁吸 · 靠近价格点',checked:workspace.magnet&&workspace.magnetStrength==='weak',run:()=>engine.setMagnetMode('weak')},
        {id:'magnet-strong',label:'强磁吸 · 跟随 K 线四价',checked:workspace.magnet&&workspace.magnetStrength==='strong',run:()=>engine.setMagnetMode('strong')},
      ]});
      out.push({id:'pane-drawings',label:`${paneName}绘图`,icon:'layers',disabled:!paneDrawingIds(doc,target.paneId,chartState.interval).length,children:[
        {id:'select-drawings',label:'选中此窗格绘图',run:()=>engine.selectLayers(paneDrawingIds(doc,target.paneId,chartState.interval))},
        {id:'clear-drawings',label:'删除此窗格未锁定绘图',danger:true,disabled:workspace.locked||!paneDrawingIds(doc,target.paneId,chartState.interval,true).length,run:()=>engine.removeLayers(paneDrawingIds(doc,target.paneId,chartState.interval,true))},
      ]});
      out.push({id:'layout',label:'工作区布局…',icon:'layout',run:onOpenLayout});
    }
    out.push({id:'chart-appearance',label:'图表外观…',icon:'gear',separatorBefore:true,run:onOpenAppearance});
    out.push({id:'undo',label:'撤销',icon:'undo',shortcut:`${mod} Z`,disabled:!workspace.canUndo,separatorBefore:true,run:()=>engine.undo()});
    out.push({id:'redo',label:'重做',icon:'redo',shortcut:`${mod} ⇧ Z`,disabled:!workspace.canRedo,run:()=>engine.redo()});
    const localize=(items:ContextMenuItem[]):ContextMenuItem[]=>items.map(item=>({...item,label:$t(item.label),...(item.children?{children:localize(item.children)}:{})}));return localize(out);
  });
</script>
<ContextMenu x={target.x} y={target.y} {label} {items} {onClose}/>
