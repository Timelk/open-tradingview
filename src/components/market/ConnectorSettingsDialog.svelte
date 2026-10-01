<script lang="ts">
  import {onDestroy,onMount,tick} from 'svelte';
  import {t,locale,translate,canonicalT} from '../../lib/i18n';
  import {marketConnectors,synthesizeSymbolForConnector,tagConnectorSymbol} from '../../lib/market/connectors';
  import {connectorConfigStore,DEFAULT_CONNECTOR_CONFIGS,type ConnectorRunMode,type ConnectorUserConfig} from '../../lib/market/connector-config';
  import {persistSymbolsToSqlite,searchRemoteCnAShareSymbols,type SqliteSymbolSourceStat} from '../../lib/market/symbol-catalog';
  import {surface,setSurfaceInteractive} from '../../lib/ui/motion';
  import type {MarketSymbol} from '../../lib/watchlist/types';
  import {probeConnectorDraft} from '../../lib/market/connector-probe';
  import ToolIcon from '../drawing/ToolIcon.svelte';

  export let activeSource='binance';
  export let sqliteSources:SqliteSymbolSourceStat[]=[];
  export let onClose:()=>void=()=>{};
  export let onSelectSource:(detail:{source:string;symbol?:string})=>void=()=>{};
  export let onSyncCatalog:(detail:{source?:string})=>void=()=>{};
  export let onCustomSymbolAdded:(detail:{symbol:MarketSymbol;sources:SqliteSymbolSourceStat[]})=>void=()=>{};
  export let onConfigUpdated:(detail:{configs:ConnectorUserConfig[]})=>void=()=>{};

  let dialog:HTMLDialogElement;
  let closed=false;
  let returnFocus:HTMLElement|null=null;

  let selectedId=activeSource||'binance';
  let configs:ConnectorUserConfig[]=connectorConfigStore.list();
  let editEnabled=true;
  let editMode:ConnectorRunMode='live';
  let editRestBase='';
  let editWsUrl='';
  let editDefaultSymbol='';

  let statusMessage='';
  let statusKind:'info'|'ok'|'error'='info';
  let busy=false;
  let probeAborter:AbortController|undefined;

  let customSymbolInput='';
  let customNameInput='';
  let customBadgeInput='';

  const unsubscribe=connectorConfigStore.subscribe(list=>{
    configs=list;
  });

  onDestroy(()=>{unsubscribe();probeAborter?.abort();});

  $: connectors=marketConnectors.list();
  $: activeConnector=connectors.find(c=>c.id===selectedId)??connectors[0];
  $: sourceCountMap=new Map(sqliteSources.map(s=>[s.source.toLowerCase(),s]));
  $: totalSqliteCount=sqliteSources.reduce((acc,s)=>acc+s.count,0);
  $: isMock=selectedId==='mock';
  $: isCnA=selectedId==='cn-a';

  function loadSelectedIntoForm(id:string){
    selectedId=id;
    const cfg=connectorConfigStore.get(id);
    editEnabled=cfg.enabled;
    editMode=cfg.mode;
    editRestBase=cfg.restBase;
    editWsUrl=cfg.wsUrl;
    editDefaultSymbol=cfg.defaultSymbol;
    statusMessage='';
    statusKind='info';
  }

  onMount(()=>{
    loadSelectedIntoForm(activeSource||'binance');
    returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
  });

  function releaseModal(){
    if(!dialog)return;
    dialog.classList.add('closing');
    setSurfaceInteractive(dialog,false);
    if(dialog.open)dialog.close();
  }

  function resumeModal(){
    if(!dialog?.classList.contains('closing'))return;
    closed=false;
    dialog.classList.remove('closing');
    setSurfaceInteractive(dialog,true);
    returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
    dialog.showModal();
  }

  function close(){
    if(closed)return;
    closed=true;probeAborter?.abort();
    releaseModal();
    onClose();
    void tick().then(()=>{
      if(returnFocus?.isConnected&&returnFocus!==document.body)returnFocus.focus();
    });
  }

  function draft():ConnectorUserConfig {
    const normalized=activeConnector.normalizeSymbol(editDefaultSymbol);
    if(!normalized)throw Error(translate('品种代码无效'));
    return {...connectorConfigStore.get(selectedId),source:selectedId,enabled:editEnabled,mode:editMode,restBase:editRestBase.trim(),wsUrl:editWsUrl.trim(),defaultSymbol:normalized};
  }
  async function saveCurrentConfig(notify=true,onApplied?:()=>void):Promise<boolean>{
    if(!activeConnector||busy)return false;
    busy=true;statusKind='info';statusMessage=translate('正在应用设置…');
    try{
      const value=draft(),pending=connectorConfigStore.save(selectedId,value);
      editDefaultSymbol=value.defaultSymbol;configs=connectorConfigStore.list();
      if(notify&&selectedId===activeSource)onConfigUpdated({configs});
      onApplied?.();
      const result=await pending;
      if(result.serverSaved)sqliteSources=result.sources;
      statusKind=result.browserSaved&&result.serverSaved?'ok':'info';
      statusMessage=translate(result.browserSaved&&result.serverSaved?'已应用并保存设置':result.browserSaved?'已应用到此浏览器；本地服务同步未完成':result.serverSaved?'已应用并同步本地服务；浏览器保存未完成':'已在本次会话应用；保存未完成');
      return true;
    }catch(error){statusKind='error';statusMessage=error instanceof Error?error.message:translate('设置未能应用');return false;}
    finally{busy=false;}
  }
  function resetCurrentConfig(){
    const cfg=DEFAULT_CONNECTOR_CONFIGS[selectedId];if(!cfg||busy)return;
    editEnabled=cfg.enabled;editMode=cfg.mode;editRestBase=cfg.restBase;editWsUrl=cfg.wsUrl;editDefaultSymbol=cfg.defaultSymbol;
    statusKind='info';statusMessage=translate('已恢复默认草稿，应用后生效');
  }
  async function testConnection(){
    if(!activeConnector||busy)return;
    busy=true;statusKind='info';statusMessage=translate('正在读取测试行情…');probeAborter=new AbortController();
    try{
      const result=await probeConnectorDraft(draft(),{signal:probeAborter.signal});
      if(closed)return;
      statusKind=result.kind==='simulation'?'info':'ok';
      statusMessage=result.kind==='simulation'?translate('当前为模拟模式，不进行网络连接测试'):translate('行情读取成功 · {0} ms · {1} 根 K 线；实时推送未测试',{0:result.elapsedMs,1:result.bars});
    }catch(error){if(!closed){statusKind='error';statusMessage=translate('连接测试失败：{0}',{0:error instanceof Error?error.message:translate('网络不可达')});}}
    finally{busy=false;probeAborter=undefined;}
  }

  async function syncChannelCatalog(){
    if(!activeConnector||busy||isMock)return;
    busy=true;
    statusKind='info';
    statusMessage=translate('正在刷新品种列表…');
    try{
      if(selectedId==='cn-a'&&customSymbolInput.trim()){
        const remote=await searchRemoteCnAShareSymbols(customSymbolInput.trim(),{limit:40});
        if(remote?.sources)sqliteSources=remote.sources;
      }
      onSyncCatalog({source:selectedId});
      statusKind='info';
      statusMessage=translate('已请求刷新品种列表');
    }catch(error){statusKind='error';statusMessage=error instanceof Error?error.message:translate('操作未完成，请重试。');}finally{
      busy=false;
    }
  }

  async function handleAddCustomSymbol(){
    if(!activeConnector||!customSymbolInput.trim()||busy||isMock)return;
    busy=true;
    try{
      const raw=customSymbolInput.trim();
      if(selectedId==='cn-a'){
        const remote=await searchRemoteCnAShareSymbols(raw,{limit:10});
        if(remote?.symbols?.length){
          const matched=remote.symbols[0];
          const item:MarketSymbol={
            ...matched,
            name:customNameInput.trim()||matched.name,
            marketBadge:customBadgeInput.trim()||matched.marketBadge,
          };
          const updated=await persistSymbolsToSqlite([item]);
          if(updated)sqliteSources=updated;
          onCustomSymbolAdded({symbol:item,sources:sqliteSources});
          statusKind='ok';
          statusMessage=translate(updated?'已保存品种 {0}':'已加入当前列表，持久化未完成：{0}',{0:item.symbol});
          statusKind=updated?'ok':'info';
          customSymbolInput='';
          customNameInput='';
          customBadgeInput='';
          return;
        }
      }
      const baseItem=synthesizeSymbolForConnector(activeConnector,raw);
      if(!baseItem){
        statusKind='error';
        statusMessage=translate('品种代码无效，示例：{0}',{0:activeConnector.defaultSymbol});
        return;
      }
      const item:MarketSymbol=tagConnectorSymbol(activeConnector,{
        ...baseItem,
        name:customNameInput.trim()||baseItem.name,
        ...(customBadgeInput.trim()?{marketBadge:customBadgeInput.trim()}:{}),
      });
      const updated=await persistSymbolsToSqlite([item]);
      if(updated)sqliteSources=updated;
      onCustomSymbolAdded({symbol:item,sources:sqliteSources});
      statusKind='ok';
      statusMessage=translate(updated?'已保存品种 {0}':'已加入当前列表，持久化未完成：{0}',{0:item.symbol});
      statusKind=updated?'ok':'info';
      customSymbolInput='';
      customNameInput='';
      customBadgeInput='';
    }catch(error){statusKind='error';statusMessage=error instanceof Error?error.message:translate('操作未完成，请重试。');}finally{
      busy=false;
    }
  }

  async function applyAndSwitchSource(){
    if(!await saveCurrentConfig(false,()=>onSelectSource({source:selectedId,symbol:editDefaultSymbol})))return;
    close();
  }

  function handleTabKeydown(event:KeyboardEvent){
    if(busy)return;
    const idx=connectors.findIndex(c=>c.id===selectedId);
    let next=-1;
    if(event.key==='ArrowDown'||event.key==='ArrowRight')next=(idx+1)%connectors.length;
    else if(event.key==='ArrowUp'||event.key==='ArrowLeft')next=(idx+connectors.length-1)%connectors.length;
    else if(event.key==='Home')next=0;
    else if(event.key==='End')next=connectors.length-1;
    if(next<0)return;
    event.preventDefault();
    loadSelectedIntoForm(connectors[next].id);
    dialog?.querySelector<HTMLButtonElement>(`#connector-tab-${connectors[next].id}`)?.focus();
  }
</script>

<dialog
  bind:this={dialog}
  class="connector-dialog"
  class:closing={closed}
  aria-labelledby="connector-dialog-title"
  aria-hidden={closed}
  transition:surface|global={{enter:160,exit:110,y:6}}
  on:introstart={resumeModal}
  on:outrostart={releaseModal}
  on:cancel={event=>{event.preventDefault();close();}}
  on:click={event=>{
    if(event.target===dialog){
      const b=dialog.getBoundingClientRect();
      if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)close();
    }
  }}
>
  <header class="dialog-header">
    <div><h2 id="connector-dialog-title">{$t("数据源设置")}</h2><p>{$t("选择来源、测试连接或应用配置。")}</p></div>
    <button type="button" class="close-dialog" aria-label={$t("关闭数据源配置")} title={$t("关闭 · Esc")} on:click={close}><ToolIcon name="close" size={20}/></button>
  </header>
  <div class="dialog-body">
    <div class="channel-sidebar" role="tablist" aria-label={$t("行情来源")}>
      {#each connectors as conn (conn.id)}
        <button type="button" role="tab" id={`connector-tab-${conn.id}`} aria-selected={selectedId===conn.id} tabindex={selectedId===conn.id?0:-1} class:active={selectedId===conn.id} disabled={busy} on:click={()=>loadSelectedIntoForm(conn.id)} on:keydown={handleTabKeydown}><strong>{$t(conn.shortLabel)}</strong><small>{$t(conn.badge)}</small></button>
      {/each}
    </div>
    {#if activeConnector}
      <div class="channel-detail" role="tabpanel" aria-labelledby={`connector-tab-${activeConnector.id}`}>
        <h3>{$t(activeConnector.label)}</h3>
        <p class="market-details">{activeConnector.session.timezone} · {activeConnector.defaultQuoteCurrency} · {activeConnector.session.settlementRule??'T+0'}</p>
        <div class="form-grid">
          <label>{$t("默认品种")}<input bind:value={editDefaultSymbol} placeholder={activeConnector.defaultSymbol} spellcheck="false" disabled={busy}/></label>
          <label>{$t("运行模式")}<select bind:value={editMode} disabled={isMock||busy}><option value="live">{$t("真实行情")}</option><option value="auto">{$t("自动（连接失败时可能使用模拟行情）")}</option><option value="simulation">{$t("模拟行情")}</option></select></label>
        </div>
        <div class="action-bar"><button class="primary" on:click={()=>void saveCurrentConfig()} disabled={busy}>{$t("应用设置")}</button><button on:click={testConnection} disabled={busy}>{$t("测试连接")}</button></div>
        <details class="advanced"><summary>{$t("高级设置")}</summary>
          <p>{$canonicalT(DEFAULT_CONNECTOR_CONFIGS[selectedId]?.notes??'')}</p>
          <label>{$t("历史行情地址")} <span class="technical">REST</span><input bind:value={editRestBase} placeholder={DEFAULT_CONNECTOR_CONFIGS[selectedId]?.restBase??''} disabled={isMock||busy} spellcheck="false"/></label>
          <label>{$t("实时推送地址")} <span class="technical">WebSocket</span><input bind:value={editWsUrl} placeholder={DEFAULT_CONNECTOR_CONFIGS[selectedId]?.wsUrl??''} disabled={isMock||isCnA||busy} spellcheck="false"/></label>
          {#if isCnA}<p>{$t("A 股通过定时查询更新行情。")}</p>{/if}
          <button on:click={resetCurrentConfig} disabled={busy}>{$t("恢复默认")}</button>
          <div class="storage-info"><strong>{$t("本地存储")}</strong><code>.data/market/market.sqlite</code><span>{$t("本地品种记录：{0}",{0:totalSqliteCount.toLocaleString($locale)})}</span><span>{$t(activeConnector.shortLabel)}: {sourceCountMap.get(selectedId)?.count??0}</span><button on:click={syncChannelCatalog} disabled={busy||isMock}>{$t("刷新品种列表")}</button></div>
        </details>
        {#if !isMock}<details class="custom-symbol"><summary>{$t("添加品种")}</summary><div class="form-grid">
          <label>{$t("品种代码")}<input bind:value={customSymbolInput} disabled={busy} placeholder={activeConnector.defaultSymbol} spellcheck="false"/></label>
          <label>{$t("显示名称（选填）")}<input bind:value={customNameInput} disabled={busy}/></label>
          <label>{$t("市场标签（选填）")}<input bind:value={customBadgeInput} disabled={busy}/></label>
        </div><button on:click={handleAddCustomSymbol} disabled={busy||!customSymbolInput.trim()}>{$t("添加品种")}</button></details>{/if}
      </div>
    {/if}
  </div>
  <footer class="dialog-footer"><p role="status" aria-live="polite" data-kind={statusKind}>{statusMessage?$canonicalT(statusMessage):$t("连接测试只读取行情；应用后才更新设置。")}</p><div><button on:click={applyAndSwitchSource} disabled={busy}>{$t("应用并切换")}</button><button on:click={close}>{$t("完成")}</button></div></footer>
</dialog>
<style>
  .connector-dialog{position:fixed;inset:0;margin:auto;width:min(760px,calc(100vw - 32px));height:min(610px,calc(100dvh - 40px));max-width:none;max-height:none;padding:0;border:1px solid var(--line,#424c5b);border-radius:var(--radius-lg);background:var(--surface-raised,#1b1f26);color:var(--text,#d3dce9);box-shadow:var(--shadow-lg);overflow:hidden;flex-direction:column;z-index:48}.connector-dialog[open],.connector-dialog.closing{display:flex}.connector-dialog.closing{pointer-events:none}.connector-dialog::backdrop{background:color-mix(in srgb, var(--bg-panel) 40%, transparent)}.dialog-header{display:flex;justify-content:space-between;gap:16px;padding:18px 22px;border-bottom:1px solid var(--line)}h2{font-size:18px;font-weight:550;margin:0}.dialog-header p{margin:7px 0 0;font-size:11px;color:var(--text-dim)}.close-dialog{width:32px;height:32px;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0}.dialog-body{display:flex;flex:1;min-height:0}.channel-sidebar{width:150px;flex-shrink:0;padding:10px 6px;border-right:1px solid var(--line);overflow:auto}.channel-sidebar button{display:flex;flex-direction:column;align-items:flex-start;gap:6px;width:100%;min-height:51px;padding:9px 10px;text-align:left;border-radius:var(--radius-sm)}.channel-sidebar strong{font-size:12px;font-weight:550}.channel-sidebar small{font-size:10px;color:var(--text-dim)}.channel-sidebar button.active{background:var(--bg-hover);box-shadow:inset 2px 0 var(--accent)}.channel-detail{flex:1;min-width:0;padding:18px 22px;overflow:auto}h3{font-size:15px;font-weight:550;margin:0}.market-details{font:10px var(--mono);color:var(--text-dim);margin:8px 0 18px}.form-grid{display:grid;grid-template-columns:1fr;gap:14px}label{display:block;color:var(--text-dim);font-size:11px;line-height:1.5}input,select{display:block;width:100%;height:32px;margin-top:6px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--bg,#151c24);color:var(--text);padding:5px 9px;font-size:12px;box-sizing:border-box}.action-bar{display:flex;gap:8px;margin:16px 0}.action-bar button,.advanced button,.custom-symbol button,.dialog-footer button{min-height:30px;padding:5px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);font-size:11px}.primary{background:var(--bg-hover);border-color:var(--accent)!important}.advanced,.custom-symbol{border-top:1px solid var(--line);padding:12px 0}.advanced summary,.custom-symbol summary{font-size:11px;cursor:pointer;color:var(--text-dim)}.advanced[open] summary,.custom-symbol[open] summary{margin-bottom:14px;color:var(--text)}.advanced p{font-size:10px;line-height:1.6;color:var(--text-dim)}.advanced label{margin:12px 0}.technical{font:10px var(--mono);margin-left:5px}.storage-info{display:grid;gap:7px;margin-top:16px;padding-top:12px;border-top:1px solid var(--line);font-size:10px;color:var(--text-dim)}.storage-info code{overflow-wrap:anywhere}.storage-info button{justify-self:start}.custom-symbol>button{margin-top:12px}.dialog-footer{display:flex;align-items:center;gap:16px;padding:12px 20px;border-top:1px solid var(--line)}.dialog-footer p{flex:1;min-width:0;font-size:11px;line-height:1.5;color:var(--text-dim);margin:0;overflow-wrap:anywhere}.dialog-footer p[data-kind=error]{color:var(--down)}.dialog-footer p[data-kind=ok]{color:var(--up)}.dialog-footer>div{display:flex;gap:7px;flex-shrink:0}button:disabled{opacity:.45;cursor:default}summary:focus-visible{outline:1px solid var(--accent)}@media(max-width:580px){.connector-dialog{width:calc(100vw - 18px);height:calc(100dvh - 24px)}.channel-sidebar{width:102px;padding:6px}.channel-sidebar button{padding:9px 6px}.channel-sidebar small{font-size:9px}.channel-detail{padding:15px 12px}.dialog-header{padding:16px}.dialog-footer{padding:12px;align-items:stretch;flex-direction:column;gap:10px}.dialog-footer>div{justify-content:flex-end}}
</style>
