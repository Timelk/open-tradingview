<script lang="ts">
  import {t,locale,translateError,canonicalT,formatDate} from './lib/i18n';
  import StorageInfo from './components/layout/StorageInfo.svelte';
  import CommandPalette from './components/ui/CommandPalette.svelte';
  import { onMount,tick } from 'svelte';
  import WorkspaceDock from './components/layout/WorkspaceDock.svelte';
  import LayoutSettings from './components/layout/LayoutSettings.svelte';
  import ChartAppearanceDialog from './components/chart/ChartAppearanceDialog.svelte';
  import type { WorkspacePanelContext } from './components/layout/panel-context';
  import { workspacePanels, PANEL_GROUPS } from './plugins/workspace-panels';
  import { loadWorkspaceLayout,WorkspaceLayoutStore,DOCK_ZONES,type DockZone,type WorkspacePreset } from './lib/workspace/layout';
  import SymbolSearchDialog from './components/watchlist/SymbolSearchDialog.svelte';
  import ConnectorSettingsDialog from './components/market/ConnectorSettingsDialog.svelte';
  import KeyboardShortcuts from './components/KeyboardShortcuts.svelte';
  import { WatchlistStore } from './lib/watchlist/store';
  import { WatchlistQuotes } from './lib/watchlist/quotes';
  import { DEFAULT_SYMBOLS, normalizePerpetualSymbol as normalizeSymbol } from './lib/watchlist/symbols';
  import { coerceConnectorSymbol, getMarketConnector, marketConnectors, synthesizeSymbolForConnector } from './lib/market/connectors';
  import { connectorConfigStore } from './lib/market/connector-config';
  import {
    defaultMultiSourceCatalog,
    mergeSymbolCatalogs,
    persistSymbolsToSqlite,
    syncMultiSourceCatalog,
    type SqliteSymbolSourceStat,
  } from './lib/market/symbol-catalog';
  import type { MarketSymbol, WatchlistDocument, WatchlistQuoteSnapshot } from './lib/watchlist/types';
  import { getWorkspaceShortcut } from './lib/ui/shortcuts';
  import { formatMarketPrice } from './lib/core/market-format';
  import StudyLibrary from './components/studies/StudyLibrary.svelte';
  import type {StudySection} from './lib/studies/catalog';
  import ChartStudies from './components/studies/ChartStudies.svelte';
  import DrawingSidebar from './components/drawing/DrawingSidebar.svelte';
  import DrawingProperties from './components/drawing/DrawingProperties.svelte';
  import ChartContextMenu from './components/drawing/ChartContextMenu.svelte';
  import { contextSelection,type ChartMenuTarget } from './lib/drawing/context-actions';
  import Toolbar from './components/Toolbar.svelte';
  import ChartView from './components/ChartView.svelte';
  import ObjectPropertiesDialog from './components/workspace/ObjectPropertiesDialog.svelte';
  import ToolIcon from './components/drawing/ToolIcon.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import {agentBridge,newChartId} from './lib/agent/client';
  import {ChartAgentAdapter} from './lib/agent/chart-adapter';
  import { initialState, type ChartController, type DrawingSelection, type StudyPaneLayout } from './lib/chart/controller';
  let state={...initialState};
  let layout=loadWorkspaceLayout();
  let layoutStore:WorkspaceLayoutStore;
  let storageInfoOpen=false;
  let layoutOpen=false,layoutSequence=0,commandSequence=0;
  let focusedDock:DockZone='right';
  let compactWorkspace=false,mobilePanelOpen=false,mobileToolsOpen=false;
  function closeDock(zone:DockZone){if(compactWorkspace)mobilePanelOpen=false;else layoutStore?.setZoneOpen(zone,false);}
  const setMobileMode=(mobile:boolean)=>{if(compactWorkspace!==mobile){compactWorkspace=mobile;mobilePanelOpen=false;mobileToolsOpen=false;}};
  let panelDefinitions=workspacePanels.list();
  // Rail entry points grouped by task; plugin panels without a known group
  // collect in a trailing group so they are never hidden.
  $: railGroups=[...PANEL_GROUPS.map(group=>({id:group.id as string,title:group.title as string,panels:panelDefinitions.filter(panel=>panel.group===group.id)})),
    {id:'other',title:'其他',panels:panelDefinitions.filter(panel=>!PANEL_GROUPS.some(group=>group.id===panel.group))}].filter(group=>group.panels.length);
  let panelContext:WorkspacePanelContext|undefined;
  let offAgent:()=>void=()=>{};
  function readyChart(chart:ChartController){
    controller=chart;
    offAgent();offAgent=agentBridge.register(new ChartAgentAdapter(chart,{chartId:newChartId(),host:()=>chartArea,
      ui:{revealObjects:ids=>revealContext(ids),openProperties:ids=>openProperties(ids)}}));
  }
  function panelZone(id:string){return DOCK_ZONES.find(zone=>layout.zones[zone].panels.includes(id))??workspacePanels.get(id)?.defaultZone??'right';}
  function showPanel(id:string){
    mobileToolsOpen=false;
    if(id==='indicators'){openLibrary();return;}
    const definition=workspacePanels.get(id);
    if(definition?.preferredSize&&!DOCK_ZONES.some(zone=>layout.zones[zone].panels.includes(id)))layoutStore?.setSize(definition.defaultZone??'right',definition.preferredSize,false);
    mobilePanelOpen=true;focusedDock=panelZone(id);layoutStore?.openPanel(id,workspacePanels.get(id)?.defaultZone??'right');
  }
  function togglePanel(id:string){mobileToolsOpen=false;if(!DOCK_ZONES.some(zone=>layout.zones[zone].panels.includes(id))){showPanel(id);return;}const zone=panelZone(id),visible=panelActive(id);focusedDock=zone;mobilePanelOpen=!visible;if(compactWorkspace&&!visible)layoutStore?.openPanel(id,workspacePanels.get(id)?.defaultZone??'right');else layoutStore?.togglePanel(id,workspacePanels.get(id)?.defaultZone??'right');}
  function panelActive(id:string){const zone=panelZone(id);return layout.zones[zone].open&&layout.zones[zone].active===id&&!layout.hidden.includes(id)&&(!compactWorkspace||mobilePanelOpen&&focusedDock===zone);}
  function movePanel(id:string,zone:DockZone|'hidden'){if(zone!=='hidden'&&workspacePanels.get(id)?.allowedZones&&!workspacePanels.get(id)!.allowedZones!.includes(zone))return;if(zone!=='hidden'){focusedDock=zone;mobilePanelOpen=true;}layoutStore?.setPlacement(id,zone);}
  function layoutPreset(value:WorkspacePreset){focusedDock='right';mobilePanelOpen=value!=='focus';layoutStore?.applyPreset(value);}
  function openCommands(event:KeyboardEvent){if(event.defaultPrevented||event.isComposing||document.querySelector('dialog[open]'))return;if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.code==='KeyP'&&!(event.target instanceof Element&&event.target.closest('input,textarea,[contenteditable=true],.code-editor'))){event.preventDefault();showCommands();}}
  $: commands=[
    {id:'studies',label:'指标与策略',shortcut:'/',run:()=>openLibrary()},
    {id:'connector-settings',label:'数据源设置',keywords:'source connector sqlite binance okx coinbase A股 数据源 配置',run:openConnectorSettings},
    {id:'patterns',label:'打开分析',keywords:'形态 经典 谐波 量价共振 结构 volume structure patterns',run:()=>showPanel('patterns')},
    {id:'objects',label:'打开对象树',run:()=>showPanel('objects')},
    {id:'watchlist',label:'打开自选列表',run:()=>showPanel('watchlist')},
    {id:'layout',label:'布局设置与命名保存',run:openLayout},
    {id:'storage-info',label:'存储与版本',keywords:'storage cache 缓存 版本',run:openStorageInfo},
    {id:'orderbook',label:'盘口终端',keywords:'order book heatmap dom 盘口 热图 订单流',run:()=>showPanel('orderbook')},
    {id:'layout-orderflow',label:'订单流',run:()=>layoutPreset('orderflow')},
    {id:'layout-watch',label:'看盘布局',run:()=>layoutPreset('standard')},
    {id:'layout-research',label:'研究布局',run:()=>layoutPreset('analysis')},
    {id:'layout-focus',label:'专注主图',run:()=>layoutPreset('focus')},
    {id:'layout-undo',label:'还原上一次布局',run:()=>{layoutStore?.undo();}},
    {id:'latest',label:'返回最新行情',shortcut:'End',run:()=>controller?.followLatest()},
    {id:'help',label:'查看全部快捷键',shortcut:'?',run:()=>{helpOpen=true;}},
  ];
  function showCommands(){commandSequence++;commandOpen=true;}
  function openStorageInfo(){layoutOpen=false;storageInfoOpen=true;}
  function openLayout(){mobileToolsOpen=false;controller?.drawing.cancel();layoutSequence++;layoutOpen=true;}
  let connectorSettingsOpen=false,connectorSettingsSequence=0;
  function openConnectorSettings(){mobileToolsOpen=false;controller?.drawing.cancel();connectorSettingsSequence++;connectorSettingsOpen=true;}
  const setWatchOrder=(order:string[])=>{if(order.join('|')!==watchOrder.join('|'))watchOrder=order;};
  const openPanelProperties=(ids:string[])=>{quickSelection=null;openProperties(ids);};
  const clearQuickSelection=()=>quickSelection=null;
  const addWatchSymbol=()=>openSymbolSearch('add');
  const retryQuotes=()=>quoteService?.retry();
  $: panelContext=controller&&watchlistStore?{controller,chartState:state,watchlistStore,quoteState,catalog,onSelectSymbol:chooseSymbol,onAddSymbol:addWatchSymbol,onRetryQuotes:retryQuotes,onWatchOrder:setWatchOrder,onOpenLibrary:openLibrary,onOpenProperties:openPanelProperties,onTreeSelection:clearQuickSelection,onOpenPanel:showPanel,onExpandAnalysis:()=>{const atBottom=layout.zones.bottom.panels.includes('patterns');movePanel('patterns',atBottom?'right':'bottom');if(!atBottom)layoutStore?.setSize('bottom',Math.min(560,innerHeight*.62));}}:undefined;
  let watchlistStore:WatchlistStore;
  let quoteService:WatchlistQuotes;
  let watchlistDoc:WatchlistDocument={version:1,activeId:'default',lists:[{id:'default',name:'自选列表',symbols:DEFAULT_SYMBOLS.map(s=>s.symbol)}]};
  let quoteState:WatchlistQuoteSnapshot={quotes:{},status:'loading',error:''};
  let catalog:MarketSymbol[]=defaultMultiSourceCatalog(),catalogLoading=false,catalogError='';
  let sqliteSymbolSources:SqliteSymbolSourceStat[]=[];
  let catalogAbort:AbortController|undefined;
  let symbolSearchOpen=false,symbolSearchMode:'switch'|'add'='switch',symbolQuery='',symbolSequence=0;
  let helpOpen=false,commandOpen=false;
  let watchOrder:string[]=[];
  $: activeWatchlist=watchlistDoc.lists.find(list=>list.id===watchlistDoc.activeId)??watchlistDoc.lists[0];
  $: activeConnector=getMarketConnector(state.source);
  $: quoteService?.setSymbols([state.symbol,...activeWatchlist.symbols]);
  $: symbolInfo=catalog.find(item=>item.symbol===state.symbol&&(item.source??'binance')===state.source)??catalog.find(item=>item.symbol===state.symbol);
  $: symbolLabel=symbolInfo?(symbolInfo.quoteAsset==='CNY'&&symbolInfo.name?`${symbolInfo.name} · ${symbolInfo.symbol}`:`${symbolInfo.baseAsset} / ${symbolInfo.quoteAsset}`):state.symbol;
  onMount(()=>{
    const layoutModel=new WorkspaceLayoutStore();layoutStore=layoutModel;
    const offLayout=layoutModel.subscribe(value=>{if(layout.drawingTools&&!value.drawingTools)controller?.drawing.selectTool('cursor');layout=value;});
    const offPanels=workspacePanels.subscribe(value=>panelDefinitions=value);
    const lists=new WatchlistStore(),quotes=new WatchlistQuotes();watchlistStore=lists;quoteService=quotes;
    const offList=watchlistStore.subscribe(doc=>{
      const previous=watchlistDoc.lists.find(list=>list.id===watchlistDoc.activeId);
      const next=doc.lists.find(list=>list.id===doc.activeId)!;
      if(doc.activeId!==watchlistDoc.activeId||previous?.symbols.join('|')!==next.symbols.join('|'))watchOrder=[...next.symbols];
      watchlistDoc=doc;
    });
    const offQuotes=quoteService.subscribe(value=>quoteState=value);
    void connectorConfigStore.syncFromServer();
    void loadCatalog();
    agentBridge.start();
    return()=>{offAgent();agentBridge.stop();catalogAbort?.abort();offList();offQuotes();offLayout();offPanels();layoutModel.destroy();quotes.destroy();lists.destroy();};
  });
  async function loadCatalog(){
    catalogAbort?.abort();const request=new AbortController();catalogAbort=request;catalogLoading=true;catalogError='';
    try{
      const synced=await syncMultiSourceCatalog({
        signal:request.signal,
        onPartial:(partialCatalog,partialSources)=>{
          if(!request.signal.aborted){catalog=partialCatalog;sqliteSymbolSources=partialSources;}
        },
      });
      if(!request.signal.aborted){catalog=synced.catalog;sqliteSymbolSources=synced.sources;}
    }
    catch(reason){if(!request.signal.aborted)catalogError=`${reason instanceof Error?reason.message:'暂时无法加载品种目录'}。当前显示已入库品种，可重试。`;}
    finally{if(!request.signal.aborted)catalogLoading=false;}
  }
  function openSymbolSearch(mode:'switch'|'add'='switch',query=''){
    symbolSearchMode=mode;symbolQuery=query;symbolSequence++;symbolSearchOpen=true;
    if(catalogError&&!catalogLoading)void loadCatalog();
  }
  function resolveTargetSource(symbol:string,explicitSource?:string):string {
    if(explicitSource&&getMarketConnector(explicitSource)?.normalizeSymbol(symbol))return explicitSource;
    const current=getMarketConnector(state.source);
    if(current&&state.source!=='mock'&&current.normalizeSymbol(symbol))return state.source;
    const known=catalog.find(item=>item.symbol===symbol&&item.source&&item.source!=='mock');
    if(known?.source&&getMarketConnector(known.source)?.normalizeSymbol(symbol))return known.source;
    for(const candidate of marketConnectors.list()){
      if(candidate.id!=='mock'&&candidate.normalizeSymbol(symbol))return candidate.id;
    }
    return state.source;
  }
  function recordSelectedSymbol(symbol:string,source:string,item?:MarketSymbol){
    const connector=getMarketConnector(source);
    const entry=item??(connector?synthesizeSymbolForConnector(connector,symbol):null);
    if(!entry)return;
    catalog=mergeSymbolCatalogs(catalog,[entry]);
    void persistSymbolsToSqlite([entry]).then(sources=>{if(sources)sqliteSymbolSources=sources;});
  }
  function chooseSymbol(symbol:string,explicitSource?:string,item?:MarketSymbol){
    const targetSource=resolveTargetSource(symbol,explicitSource??item?.source);
    const normalized=getMarketConnector(targetSource)?.normalizeSymbol(symbol)??normalizeSymbol(symbol);
    if(!normalized||!controller)return;
    recordSelectedSymbol(normalized,targetSource,item);
    quickSelection=null;propertyIds=[];
    void controller.setMarket(targetSource,normalized,state.interval);
  }
  function addSymbol(symbol:string,explicitSource?:string,item?:MarketSymbol){
    if(!watchlistStore.add(symbol))throw Error(watchlistStore.error||'无法加入当前自选列表');
    const targetSource=resolveTargetSource(symbol,explicitSource??item?.source);
    recordSelectedSymbol(symbol,targetSource,item);
  }
  function nextSymbol(direction:number){
    const order=watchOrder.length?watchOrder:activeWatchlist.symbols;if(!order.length)return false;
    const index=order.indexOf(state.symbol),next=index<0?(direction>0?0:order.length-1):(index+direction+order.length)%order.length;
    chooseSymbol(order[next]);return true;
  }
  function workspaceKeys(event:KeyboardEvent){
    if(!controller||!watchlistStore)return;
    const editable=event.target instanceof Element&&!!event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
    const action=getWorkspaceShortcut(event,{editable,modalOpen:!!chartMenu||!!document.querySelector('dialog[open]'),drawingBusy:controller.drawing.hasGesture||controller.drawing.drawingMode});
    if(!action)return;
    if(action.type==='studies'){event.preventDefault();openLibrary();}
    else if(action.type==='symbolSearch'){event.preventDefault();openSymbolSearch('switch',action.query);}
    else if(action.type==='watchlistAdd'){event.preventDefault();watchlistStore.add(state.symbol);showPanel('watchlist');}
    else if(action.type==='help'){event.preventDefault();helpOpen=true;}
    else if(nextSymbol(action.type==='nextSymbol'?1:-1))event.preventDefault();
  }
  let controller:ChartController;
  let appearanceOpen=false;
  function openAppearance(){if(!controller)return;mobileToolsOpen=false;controller.cancelInteractionForMenu();closeChartMenu();appearanceOpen=true;}
  let chartArea:HTMLDivElement;
  let chartMenu:ChartMenuTarget|null=null,chartMenuSequence=0;
  let contextFocus:HTMLElement|null=null;
  function closeChartMenu(restoreFocus=false){
    chartMenu=null;
    if(restoreFocus)queueMicrotask(()=>{if(document.querySelector('dialog[open]'))return;if(contextFocus?.isConnected)contextFocus.focus();else controller?.focus();});
  }
  function revealContext(ids:string[]){controller.drawing.selectLayers(ids);quickSelection=null;showPanel('objects');}
  function contextAtElement(element:Element,x:number,y:number,keyboard=false):boolean {
    if(!controller||state.loading||propertyIds.length||document.querySelector('dialog[open]'))return false;
    if(element.closest('input,textarea,select,[contenteditable="true"],[role="menu"]'))return false;
    const row=element.closest<HTMLElement>('.tree-row[data-layer-id],.study-row[data-study-id]');
    const host=element.closest<HTMLElement>('.chart-host');
    if(!row&&!host)return false;
    const bounds=chartArea.getBoundingClientRect(),pixel={x:x-bounds.left,y:y-bounds.top};
    controller.cancelInteractionForMenu();
    const picked=host?controller.contextTargetAt(pixel):null;
    const doc=controller.drawing.document,current=controller.drawing.state.scene.selectedIds;
    const hitId=row?.dataset.layerId??row?.dataset.studyId??(keyboard&&current.length?current[0]:picked?.drawingId)??null;
    const layer=doc.layers.find(item=>item.id===hitId);
    if(!picked&&!layer)return false;
    const ids=contextSelection(current,hitId,doc);
    controller.drawing.selectLayers(ids);
    contextFocus=row??host;
    chartMenu={x,y,pixel,paneId:layer?.paneId??picked!.paneId,ids,anchor:picked?.anchor??null,region:picked?.region??'plot',market:`${state.source}:${state.symbol}:${state.interval}`};
    chartMenuSequence++;return true;
  }
  function chartContext(event:MouseEvent){
    if(event.defaultPrevented||!(event.target instanceof Element))return;
    if(contextAtElement(event.target,event.clientX,event.clientY)){event.preventDefault();event.stopPropagation();}
  }
  function chartContextKeys(event:KeyboardEvent){
    if(event.defaultPrevented||!(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey)||!(event.target instanceof Element))return;
    const bounds=event.target.getBoundingClientRect();
    if(contextAtElement(event.target,bounds.left+Math.min(bounds.width/2,160),bounds.top+Math.min(bounds.height/2,160),true)){event.preventDefault();event.stopPropagation();}
  }
  let quickSelection:DrawingSelection|null=null;
  let propertyIds:string[]=[];
  let propertyDialogSequence=0;
  let libraryOpen=false;
  let librarySequence=0;
  let librarySection:StudySection='all';
  let studyPanes:StudyPaneLayout[]=[];
  const openLibrary=(section:StudySection='all')=>{if(controller){librarySection=section;librarySequence++;libraryOpen=true;}};
  const revealStudy=(id:string)=>{controller.drawing.selectLayers([id]);showPanel('objects');};
  const openProperties=(ids:string[])=>{
    if(!controller)return;const targets=ids.filter(id=>controller.drawing.document.layers.some(l=>l.id===id));
    if(!targets.length)return;
    if(quickSelection&&!targets.includes(quickSelection.id))quickSelection=null;
    controller.drawing.selectLayers(targets);propertyDialogSequence++;propertyIds=targets;
  };
  $: quote=state.latestQuote??(!state.hover?state.quote:null);
  $: up=quote?quote.close>=quote.open:true;
  $: change=quote?(quote.close/quote.open-1)*100:0;
</script>
{#if commandOpen}{#key commandSequence}<CommandPalette {commands} onClose={()=>commandOpen=false}/>{/key}{/if}
<svelte:head><title>{$t("open-tradingview — 加密货币研究工作台")}</title><meta name="description" content={$t("流畅的加密货币图表工作台：三类形态、原生指标、结构量价与 AI Agent 协作。")} /></svelte:head>
<a class="skip-chart" href="#main-chart" on:click|preventDefault={()=>controller?.focus()}>{$t("跳到图表")}</a>
<Toolbar {state} {symbolLabel} onSymbolSearch={()=>openSymbolSearch()} panelOpen={libraryOpen} onMarket={(source,symbol,interval)=>controller?.setMarket(source,symbol,interval)} onPanel={openLibrary} onPause={()=>controller?.togglePause()} onReconnect={()=>controller?.reconnect()} onCommands={showCommands} onConnectorSettings={openConnectorSettings} />
{#if layout.quoteHeader}<div class="quote-strip">
  <strong class="pair">{symbolLabel} <span>{state.interval}</span></strong>
  <span class="source-tag">{state.analysisReplay?$t("分析历史回放"):state.historicalSnapshot?$t("历史行情快照"):$t(activeConnector?.badge??"BINANCE · USDT 永续")}</span>
  {#if quote}<span class="quote-kind">{state.historicalSnapshot?$t("快照末柱"):$t("最新价")}</span><strong class="last num" class:positive={up} class:negative={!up}>{formatMarketPrice(quote.close)} <small title={$t("当前K线的涨跌幅；自选列表显示24小时涨跌")}><span class="change-period">{$t("本柱")}</span>{change>=0?'+':''}{change.toFixed(2)}%</small></strong>
    <div class="ohlc num"><span class="reading-kind">{state.hover?$t("光标所指"):$t("当前 K 线")}</span>{#if state.quote}<span>O <b>{formatMarketPrice(state.quote.open)}</b></span><span>H <b>{formatMarketPrice(state.quote.high)}</b></span><span>L <b>{formatMarketPrice(state.quote.low)}</b></span><span>C <b>{formatMarketPrice(state.quote.close)}</b></span><time>{formatDate(state.quote.time,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false},$locale)}</time>{/if}</div>
  {/if}
  <div class="chart-toolbar" role="toolbar" aria-label={$t("图表视图控制")}>
    <button class:active={panelActive('orderbook')} on:click={()=>togglePanel('orderbook')} title={$t("盘口终端")} aria-label={$t("盘口终端")}><ToolIcon name="orderbook" size={14}/>{$t("盘口")}</button>
    <button on:click={()=>controller?.zoom(.8)} aria-label={$t("缩小图表")} title={$t("缩小图表 · −")}>−</button><button on:click={()=>controller?.zoom(1.25)} aria-label={$t("放大图表")} title={$t("放大图表 · +")}>+</button>
    {#if !state.following||state.historicalSnapshot}<button class="active" on:click={()=>controller?.followLatest()} title={$t("返回最新 · End")}>{$t("最新 ↦")}</button>{/if}
  </div>
</div>{/if}
<main class="workspace" class:mobile-tools-open={mobileToolsOpen}>
  {#if layout.drawingTools}<DrawingSidebar engine={controller?.drawing} focusChart={()=>{mobileToolsOpen=false;controller?.focus();}} onOpenObjects={()=>showPanel('objects')}/>{/if}
  <WorkspaceDock {layout} mobileOpen={mobilePanelOpen} onMobileChange={setMobileMode} registry={workspacePanels} context={panelContext} focusedZone={focusedDock} onOpenPanel={showPanel} onCloseZone={closeDock} onResize={(zone,size)=>layoutStore?.setSize(zone,size,false)} onResizeEnd={()=>layoutStore?.save()} onMovePanel={movePanel} onSettings={openLayout}>
  <div class="chart-column">
    <div class="chart-area" id="main-chart" bind:this={chartArea}>
      <DrawingProperties engine={controller?.drawing} anchor={propertyIds.length?null:quickSelection} onOpenSettings={openProperties}/>
      <ChartView onOpenAppearance={openAppearance} onPaneLayout={(panes)=>studyPanes=panes} onDrawingSelection={(selection)=>quickSelection=selection} onPatternSelection={()=>{quickSelection=null;showPanel('patterns');}} onOpenProperties={openProperties} onState={(s)=>state=s} onReady={readyChart} />
      {#if controller}<ChartStudies {controller} chartState={state} panes={studyPanes} onOpenProperties={openProperties} onReveal={revealStudy}/>{/if}
      {#if state.loading}<div class="empty-state" role="status"><div class="load-symbol">▥</div><strong>{$t("正在准备")} {state.source==='mock'?$t(" 1,000,000 根 K 线"):$t("实时行情")}</strong><span>{state.source==='mock'?$t("建立历史数据与指标索引"):$t("连接行情…")}</span></div>{/if}
      {#if state.error}<div class="empty-state error-state" role="alert"><strong>{$t("行情暂时不可用")}</strong><p>{translateError(state.error,$locale)}</p><div><button on:click={()=>controller.reconnect()}>{$t("重新连接")}</button>{#if state.source!=='mock'}<button class="active" on:click={()=>controller.setMarket('mock',coerceConnectorSymbol('mock',state.symbol)??'BTCUSDT',state.interval)}>{$t("切回模拟行情")}</button>{/if}</div></div>{/if}
      {#if state.warning}<div class="warning" role="status">{$canonicalT(state.warning)}</div>{/if}
    </div>
  </div>
  </WorkspaceDock>
  <nav class="right-rail" aria-label={$t("工作区面板")}>
    <button class="mobile-drawing-entry" aria-label={$t("打开绘图工具")} title={$t("绘图工具")} aria-pressed={mobileToolsOpen} on:click={()=>{mobileToolsOpen=!mobileToolsOpen;mobilePanelOpen=false;}}><ToolIcon name="brush" size={20}/></button>
    {#each railGroups as group, index (group.id)}
      {#if index>0}<span class="rail-separator" aria-hidden="true"></span>{/if}
      <div class="rail-group" role="group" aria-label={$t(group.title)}>
        {#each group.panels as panel (panel.id)}
          <button class:active={panelActive(panel.id)} aria-label={$t('打开{0}',{0:$t(panel.id==='watchlist'?'自选列表':panel.id==='data'?'数据窗口':panel.title)})} title={`${$t(panel.title)} · ${$t(group.title)} · ${$t(panelZone(panel.id)==='left'?'左侧':panelZone(panel.id)==='bottom'?'底部':'右侧')}`} on:click={()=>togglePanel(panel.id)}><ToolIcon name={panel.icon} size={21}/></button>
        {/each}
      </div>
    {/each}
    <button class:active={layoutOpen} aria-label={$t("打开布局设置")} title={$t("工作区布局与显示")} on:click={openLayout}><ToolIcon name="layout" size={22}/></button>
    <button class="keyboard-help-button" aria-label={$t("打开快捷键帮助")} title={$t("快捷键与操作帮助 · ?")} on:click={()=>helpOpen=true}><ToolIcon name="keyboard" size={22}/></button>
  </nav>
</main>
{#if controller&&propertyIds.length}{#key propertyDialogSequence}<ObjectPropertiesDialog chartState={state} {controller} ids={propertyIds} chartBounds={()=>chartArea.getBoundingClientRect()} onClose={()=>propertyIds=[]}/>{/key}{/if}
{#if controller&&libraryOpen}{#key librarySequence}<StudyLibrary {controller} initialSection={librarySection} onClose={()=>libraryOpen=false}/>{/key}{/if}
{#if symbolSearchOpen}{#key symbolSequence}<SymbolSearchDialog {catalog} loading={catalogLoading} error={catalogError} mode={symbolSearchMode} selectedSymbols={activeWatchlist.symbols} activeSource={state.source} sqliteSources={sqliteSymbolSources} initialQuery={symbolQuery} onRetry={()=>void loadCatalog()} onOpenConnectorSettings={openConnectorSettings} onRemoteSymbolsFound={(symbols,sources)=>{catalog=mergeSymbolCatalogs(catalog,symbols);if(sources.length)sqliteSymbolSources=sources;}} onSelect={(symbol,source,item)=>symbolSearchMode==='add'?addSymbol(symbol,source,item):chooseSymbol(symbol,source,item)} onClose={()=>symbolSearchOpen=false}/>{/key}{/if}
{#if connectorSettingsOpen}{#key connectorSettingsSequence}<ConnectorSettingsDialog activeSource={state.source} bind:sqliteSources={sqliteSymbolSources} onClose={()=>connectorSettingsOpen=false} onSelectSource={({source,symbol})=>{const target=symbol??coerceConnectorSymbol(source,state.symbol)??state.symbol;void controller?.setMarket(source,target,state.interval);}} onSyncCatalog={()=>void loadCatalog()} onCustomSymbolAdded={({symbol,sources})=>{catalog=mergeSymbolCatalogs(catalog,[symbol]);if(sources.length)sqliteSymbolSources=sources;}} onConfigUpdated={()=>controller?.reconnect()} />{/key}{/if}
{#if layoutOpen&&layoutStore}{#key layoutSequence}<LayoutSettings {layout} store={layoutStore} registry={workspacePanels} onClose={()=>layoutOpen=false} onMove={movePanel} onPreset={layoutPreset} onStorage={openStorageInfo}/>{/key}{/if}
{#if storageInfoOpen}<StorageInfo onClose={()=>storageInfoOpen=false}/>{/if}
{#if helpOpen}<KeyboardShortcuts onClose={()=>helpOpen=false}/>{/if}
{#if controller&&appearanceOpen}<ChartAppearanceDialog {controller} onClose={()=>appearanceOpen=false}/>{/if}
{#if controller&&chartMenu}{#key chartMenuSequence}<ChartContextMenu {controller} chartState={state} target={chartMenu} onClose={closeChartMenu} onOpenProperties={openProperties} onReveal={revealContext} onOpenLibrary={openLibrary} onOpenLayout={openLayout} onOpenAppearance={openAppearance}/>{/key}{/if}
<svelte:window on:contextmenu={chartContext} on:keydown={event=>{openCommands(event);chartContextKeys(event);workspaceKeys(event);}}/>

<StatusBar {state} onRebuild={()=>controller?.rebuildRenderer()} />
<style>
  .right-rail .mobile-drawing-entry{display:none}
  .right-rail{width:40px;flex:0 0 40px;display:flex;align-items:center;flex-direction:column;border-left:1px solid var(--line);background:var(--bg-panel);z-index:8;gap:2px;padding-top:8px}.right-rail button{position:relative;display:flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;color:var(--text-dim);border-radius:var(--radius-md)}.right-rail button:hover{color:var(--text);background:var(--bg-hover)}.rail-group{display:flex;flex-direction:column;align-items:center;gap:2px}.rail-separator{width:18px;height:1px;margin:5px 0;background:var(--line);flex-shrink:0}.right-rail button.active::before{content:'';position:absolute;left:-3px;top:8px;bottom:8px;width:2px;border-radius:var(--radius-xs);background:var(--accent)}.right-rail .keyboard-help-button{margin-top:auto;margin-bottom:8px}.change-period{font-size:11px;color:var(--text-dim);margin-right:5px}.right-rail button.active{color:var(--text-strong);background:var(--bg-hover);border-color:transparent}
  .quote-strip{min-height:36px;display:flex;align-items:center;gap:12px;padding:4px 12px;border-bottom:1px solid var(--line);background:var(--bg-panel);white-space:nowrap;overflow:hidden}.pair{display:inline-flex;align-items:center;gap:6px;font:600 12.5px/1 var(--mono)}.pair span{color:var(--text-dim);font-weight:400}.source-tag{display:inline-flex;align-items:center;justify-content:center;height:20px;font:500 11px/1 var(--font);color:var(--text-dim);border:1px solid var(--line);border-radius:var(--radius-xs);padding:0 7px}.last{display:inline-flex;align-items:baseline;gap:6px;font-size:16px;font-weight:600;line-height:1}.last small{display:inline-flex;align-items:center;font-size:11px;line-height:1}.ohlc{display:flex;align-items:center;gap:12px;color:var(--text-dim);font-size:11px;line-height:1}.ohlc b{font-weight:400;color:var(--text)}
  .positive{color:var(--up)!important}.negative{color:var(--down)!important}.workspace{flex:1;display:flex;position:relative;min-height:0}.chart-column{display:flex;flex-direction:column;flex:1;min-width:0}.chart-toolbar{display:inline-flex;align-items:center;margin-left:auto;padding-left:10px;border-left:1px solid var(--line);gap:4px;white-space:nowrap;flex-shrink:0}.chart-toolbar button{min-height:24px;height:24px;padding:0 7px;border-radius:var(--radius-xs);font-size:11.5px;line-height:1;color:var(--text-dim)}.chart-toolbar button:hover{color:var(--text);background:var(--bg-hover)}.chart-toolbar button.active{color:var(--text);background:var(--bg-active);border-color:var(--line-strong)}.chart-area{position:relative;flex:1;min-height:0;overflow:hidden}.empty-state{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:13px;flex-direction:column;background:var(--bg);z-index:2}.empty-state strong{font-size:15px;font-weight:500}.empty-state span{color:var(--text-dim);font-size:11px}.load-symbol{font-size:32px;color:var(--accent)}.error-state p{max-width:460px;text-align:center;line-height:1.8;margin:0 20px;color:var(--text-dim)}.error-state button{border:1px solid var(--line);margin:10px 5px;min-height:36px}.warning{position:absolute;bottom:30px;left:12px;padding:7px 12px;background:var(--chart-glass-bg,var(--bg-panel));color:var(--chart-glass-text,var(--accent));border:1px solid var(--chart-glass-border-strong,var(--line));border-radius:var(--radius-md);backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));-webkit-backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));box-shadow:var(--chart-glass-shadow,none);z-index:3}
  .quote-kind{display:inline-flex;align-items:center;font-size:11px;line-height:1;color:var(--text-dim)}.quote-strip .ohlc{flex:1;min-width:0;align-items:center;gap:12px;font-size:11px;height:20px;overflow:hidden}.reading-kind{color:var(--accent);font-family:var(--font);min-width:60px}.ohlc time{margin-left:auto}
  @media(max-width:1180px){.quote-strip{min-height:52px;gap:8px;padding:4px 12px;flex-wrap:wrap;align-content:center}.quote-strip .ohlc{flex:1 1 auto}}
  @media(max-width:640px){.quote-strip{min-height:48px;padding:8px;gap:8px;flex-wrap:wrap}.pair{font-size:11px}.last{font-size:13px}.last small{font-size:11px}.source-tag{font-size:11px}.chart-toolbar{padding-left:6px}.chart-toolbar button{padding:0 6px}}
  @media(max-width:767px),(max-width:1000px) and (max-height:480px){.quote-strip{height:66px;min-height:66px;padding:4px 10px;gap:7px}.quote-strip .pair{display:none}.quote-strip .source-tag{font-size:11px;max-width:140px;overflow:hidden}.quote-strip .last{font-size:18px}.quote-strip .last small{font-size:11px}.quote-strip .ohlc{font-size:11px;gap:7px;height:23px}.quote-strip .ohlc>span:not(.reading-kind){display:none}.quote-strip .ohlc time{margin:0}.workspace>.right-rail{display:flex;overflow-y:auto;overflow-x:hidden}.workspace>.right-rail .mobile-drawing-entry{display:flex}.workspace :global(.drawing-rail){display:none}.workspace.mobile-tools-open :global(.drawing-rail){display:flex;position:absolute;inset:0 auto 0 0;z-index:35;max-height:100%;overflow-y:auto;overflow-x:visible;box-shadow:5px 0 20px rgb(0 0 0 / calc(0.40 * var(--shadow-strength)))}.chart-toolbar{padding-left:6px;justify-content:flex-end}.chart-toolbar button{min-width:34px;min-height:28px}.chart-column{min-width:0}.warning{max-width:100%}.mobile-tools-open:before{content:'';position:absolute;inset:0;z-index:25;pointer-events:none;background:rgb(0 0 0 / calc(0.27 * var(--shadow-strength)))}}
  @media(max-height:480px) and (max-width:1000px){.quote-strip{min-height:38px;height:38px}.quote-strip .ohlc{display:none}}
</style>
