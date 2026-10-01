<script lang="ts">
  import {onMount,tick} from 'svelte';
  import {t,locale,setLocale} from '../lib/i18n';
  import ToolIcon from './drawing/ToolIcon.svelte';
  import {surface,setSurfaceInteractive} from '../lib/ui/motion';
  import type { ChartState } from '../lib/chart/controller';
  import { intervals } from '../lib/chart/controller';
  import { INTERVAL_CATALOG, loadFavoriteIntervals, toggleFavoriteInterval, toolbarIntervals, type IntervalGroupId } from '../lib/chart/market-selection';
  import { coerceConnectorSymbol, getMarketConnector, marketConnectors, type MarketSourceId } from '../lib/market/connectors';
  export let state: ChartState;
  export let panelOpen = true;
  export let symbolLabel='';
  export let onSymbolSearch:()=>void=()=>{};
  export let onMarket: (source:MarketSourceId,symbol:string,interval:string)=>void;
  export let onPanel: ()=>void;
  export let onCommands:()=>void=()=>{};
  export let onConnectorSettings:()=>void=()=>{};
  export let onPause: ()=>void;
  export let onReconnect: ()=>void;

  let connectors=marketConnectors.list();
  let settingsMenu:HTMLDetailsElement;
  function closeSettings(){if(settingsMenu)settingsMenu.open=false;}
  function configure(){closeSettings();onConnectorSettings();}
  async function settingsKeys(event:KeyboardEvent){
    if(event.key==='Escape'&&settingsMenu?.open){event.preventDefault();event.stopPropagation();closeSettings();settingsMenu.querySelector('summary')?.focus();return;}
    if(event.target instanceof HTMLSelectElement||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();settingsMenu.open=true;await tick();
    const items=Array.from(settingsMenu.querySelectorAll<HTMLElement>('.settings-popover select,.settings-popover button:not(:disabled)'));
    const index=items.indexOf(document.activeElement as HTMLElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:index<0?(event.key==='ArrowUp'?items.length-1:0):(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[next]?.focus();
  }
  onMount(()=>marketConnectors.subscribe(list=>{connectors=list;}));
  $: activeConnector=getMarketConnector(state.source);
  function switchSource(nextSource:MarketSourceId){
    const targetSymbol=coerceConnectorSymbol(nextSource,state.symbol)??state.symbol;
    closeSettings();onMarket(nextSource,targetSymbol,state.interval);
  }

  const intervalGroups:{id:IntervalGroupId;title:string}[]=[
    {id:'minutes',title:'分钟'},
    {id:'hours',title:'小时'},
    {id:'days',title:'天 / 周 / 月'},
  ];
  const labelByInterval=new Map(INTERVAL_CATALOG.map(item=>[item.id,item.label]));
  let favorites=loadFavoriteIntervals();
  let intervalMenuOpen=false;
  let intervalPickerEl:HTMLDivElement|null=null;
  $: visibleIntervals=toolbarIntervals(favorites,state.interval);
  function chooseInterval(interval:string){
    intervalMenuOpen=false;
    onMarket(state.source,state.symbol,interval);
  }
  function onToggleFavorite(interval:string,event:MouseEvent){
    event.stopPropagation();
    favorites=toggleFavoriteInterval(favorites,interval);
  }
  function handleWindowPointerDown(event:PointerEvent){
    if(settingsMenu?.open&&event.target instanceof Node&&!settingsMenu.contains(event.target))closeSettings();
    if(intervalMenuOpen&&intervalPickerEl&&event.target instanceof Node&&!intervalPickerEl.contains(event.target)){
      intervalMenuOpen=false;
    }
  }
  function handleWindowKeyDown(event:KeyboardEvent){
    if(event.target instanceof Node&&settingsMenu?.contains(event.target)){void settingsKeys(event);if(event.defaultPrevented)return;}
    if(event.key==='Escape'&&settingsMenu?.open)closeSettings();
    if(intervalMenuOpen&&event.key==='Escape'){
      intervalMenuOpen=false;
    }
  }
</script>
<svelte:window on:pointerdown={handleWindowPointerDown} on:keydown|capture={handleWindowKeyDown}/>
<header class="toolbar">
  <div class="brand"><span class="brand-mark" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 15 15" fill="none"><rect x="1" y="1" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.4"/><line x1="5.3" y1="1.5" x2="5.3" y2="13.5" stroke="currentColor" stroke-width="1.25"/><line x1="9.7" y1="1.5" x2="9.7" y2="13.5" stroke="currentColor" stroke-width="1.25"/></svg></span><span class="brand-word">open-<span class="muted">tradingview</span></span></div>
  <div class="separator"></div>
  <button class="symbol-search-button" aria-label={$t("搜索和切换品种")} title={$t("搜索品种 · 也可直接输入字母")} aria-haspopup="dialog" on:click={onSymbolSearch}><strong>{symbolLabel||state.symbol}</strong><ToolIcon name="search" size={14}/></button>
  <nav class="intervals" aria-label={$t("K线周期")}>
    {#each visibleIntervals as interval}<button class:active={state.interval===interval} aria-pressed={state.interval===interval} title={$t(labelByInterval.get(interval)??interval)} disabled={state.loading} on:click={()=>chooseInterval(interval)}>{interval}</button>{/each}
    <div class="interval-picker" bind:this={intervalPickerEl}>
      <button class="interval-menu-trigger" class:active={intervalMenuOpen} aria-label={$t("全部周期与收藏设置")} title={$t("全部周期与收藏设置")} aria-haspopup="menu" aria-expanded={intervalMenuOpen} disabled={state.loading} on:click={()=>intervalMenuOpen=!intervalMenuOpen}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      {#if intervalMenuOpen}
        <div class="interval-popover" role="menu" aria-label={$t("全部周期与收藏设置")} transition:surface={{y:-4,enter:150,exit:100}} on:outrostart={e=>setSurfaceInteractive(e.currentTarget,false)}>
          {#each intervalGroups as group}
            <div class="interval-group">
              <div class="interval-group-title">{$t(group.title)}</div>
              {#each INTERVAL_CATALOG.filter(item=>item.group===group.id) as item}
                {@const starred=favorites.includes(item.id)}
                <div class="interval-row" class:active={state.interval===item.id}>
                  <button class="interval-item-select" class:active={state.interval===item.id} role="menuitemradio" aria-checked={state.interval===item.id} disabled={state.loading} on:click={()=>chooseInterval(item.id)}>
                    <span class="interval-code">{item.id}</span>
                    <span class="interval-name">{$t(item.label)}</span>
                  </button>
                  <button class="interval-star" class:starred aria-label={starred?$t("取消收藏周期 {0}",{0:item.id}):$t("收藏周期 {0}",{0:item.id})} aria-pressed={starred} title={starred?$t("从顶部工具栏移除"):$t("添加到顶部工具栏收藏")} on:click={event=>onToggleFavorite(item.id,event)}>{starred?'★':'☆'}</button>
                </div>
              {/each}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </nav>
  <button class="study-library-trigger" class:active={panelOpen} aria-label={$t("指标、衡量标准和策略")} aria-haspopup="dialog" aria-expanded={panelOpen} disabled={state.loading} on:click={onPanel} title={$t("指标、衡量标准和策略 · /")}><ToolIcon name="indicator" size={17}/><span>{$t("指标与策略")}</span><kbd>/</kbd></button>
  <select class="compact-period" aria-label={$t("选择图表周期")} value={state.interval} disabled={state.loading} on:change={e=>onMarket(state.source,state.symbol,e.currentTarget.value)}>{#each Object.keys(intervals) as interval}<option value={interval}>{interval}</option>{/each}</select>
  <button class="commands-button" aria-label={$t("搜索功能和快捷操作")} title={$t("搜索功能 · Ctrl / ⌘ Shift P")} on:click={onCommands}><ToolIcon name="search" size={16}/><span>{$t("功能")}</span></button>
  <div class="spacer"></div>
  {#if !state.historicalSnapshot&&(state.status==='error'||state.status==='reconnecting'&&!state.loading)}<button class="reconnect-alert" class:failed={state.status==='error'} title={$t("重新连接行情")} on:click={onReconnect}>{$t(state.status==='error'?'重连':'连接中')}</button>{/if}
  <details class="workspace-settings" bind:this={settingsMenu}>
    <summary aria-label={$t("工作区设置")} title={$t("行情来源、语言与连接设置")}><ToolIcon name="gear" size={17}/></summary>
    <div class="settings-popover" role="region" aria-label={$t("工作区设置")}>
      <label>{$t("行情来源")}<select aria-label={$t("行情来源")} value={state.source} on:change={e=>switchSource(e.currentTarget.value)}>{#each connectors as connector}<option value={connector.id}>{$t(connector.label)}</option>{/each}</select></label>
      <label>{$t("界面语言")}<select aria-label={$t("界面语言")} value={$locale} on:change={event=>setLocale(event.currentTarget.value)}><option value="zh-CN">中文</option><option value="en-US">English</option></select></label>
      <button type="button" on:click={configure}><ToolIcon name="gear" size={15}/>{$t("数据源设置")}</button>
      <button on:click={()=>{closeSettings();onReconnect();}}>{$t("重新连接行情")}</button>
      {#if activeConnector?.capabilities.supportsPause}<button disabled={state.loading} on:click={()=>{closeSettings();onPause();}}>{$t(state.paused?'继续行情':'暂停行情')}</button>{/if}
      <button on:click={()=>{closeSettings();onCommands();}}>{$t("搜索全部功能")}</button>
    </div>
  </details>
</header>
<style>
  .toolbar{display:flex;align-items:center;gap:6px;min-height:42px;padding:0 12px;border-bottom:1px solid var(--line);background:var(--bg-panel);flex-wrap:wrap}
  .brand{display:inline-flex;align-items:center;gap:7px;height:28px;line-height:1;margin-right:4px;user-select:none}.brand-mark{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--accent);flex-shrink:0}.brand-mark svg{display:block}.brand-word{display:inline-flex;align-items:center;gap:0;font:600 12px/1 var(--mono);letter-spacing:0;color:var(--text)}.muted{color:var(--text-dim)}
  .symbol-search-button{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid var(--line);background:var(--surface-sunken);padding:0 10px;max-width:175px;border-radius:var(--radius-md)}.symbol-search-button:hover{border-color:var(--line-strong);background:var(--bg-hover)}.symbol-search-button strong{font:600 11.5px/1 var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}.symbol-search-button :global(svg){flex-shrink:0}
  .separator{height:18px;border-left:1px solid var(--line);margin:0 4px}.intervals{display:inline-flex;align-items:center;gap:1px;margin-left:4px;padding:2px;border-radius:var(--radius-md);background:var(--surface-sunken);border:1px solid var(--line)}.intervals>button{padding:0 8px;border:0;border-radius:var(--radius-sm);font:500 11.5px/1 var(--mono);color:var(--text-dim)}.intervals>button:hover{color:var(--text-strong);background:var(--bg-hover)}.intervals>button.active{color:var(--text-strong);background:var(--surface-raised);border:0;box-shadow:var(--shadow-sm),inset 0 0 0 1px var(--line-strong)}.spacer{flex:1}
  .interval-picker{position:relative;display:inline-flex;align-items:center}
  .intervals .interval-menu-trigger{min-width:24px;width:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;color:var(--text-dim)}
  .intervals .interval-menu-trigger:hover,.intervals .interval-menu-trigger.active{color:var(--text)}
  .interval-popover{position:absolute;top:calc(100% + 6px);left:0;min-width:216px;max-height:min(540px,calc(100vh - 56px));overflow-y:auto;padding:6px;background:var(--surface-raised,#1b1f27);border:1px solid var(--line);border-radius:var(--radius-md);z-index:80;box-shadow:var(--shadow-md)}
  .interval-group+.interval-group{margin-top:3px;padding-top:3px;border-top:1px solid color-mix(in srgb, var(--ink) 6%, transparent)}
  .interval-group-title{font:600 10.5px/1.2 var(--font);color:var(--text-dim);padding:3px 8px;letter-spacing:.04em}
  .interval-row{display:flex;align-items:center;gap:2px;border-radius:var(--radius-sm)}
  .interval-row:hover{background:var(--bg-hover)}
  .interval-row.active{background:var(--accent-soft)}
  .intervals .interval-item-select{flex:1;min-width:0;min-height:25px;padding:0 8px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:transparent;border:0;border-radius:var(--radius-sm);color:var(--text);text-align:left}
  .intervals .interval-item-select:hover{background:transparent}
  .intervals .interval-item-select.active{background:transparent;color:var(--accent-strong)}
  .interval-code{font:600 11.5px/1 var(--mono);min-width:30px}
  .interval-name{font:400 11.5px/1 var(--font);color:var(--text-dim);margin-left:auto}
  .intervals .interval-item-select.active .interval-name{color:var(--accent-strong)}
  .intervals .interval-star{min-width:25px;width:25px;min-height:25px;padding:0;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:0;border-radius:var(--radius-sm);color:var(--text-muted);font-size:13px;line-height:1}
  .intervals .interval-star:hover{background:color-mix(in srgb, var(--ink) 6%, transparent);color:var(--warn)}
  .intervals .interval-star.starred{color:var(--warn)}
  .study-library-trigger{display:inline-flex;align-items:center;gap:6px;padding:0 10px;white-space:nowrap;margin-left:6px;border-radius:var(--radius-md)}.study-library-trigger kbd{display:inline-flex;align-items:center;justify-content:center;height:18px;min-width:18px;font:500 11px/1 var(--mono);color:var(--text-dim);border:1px solid var(--line-strong);border-radius:var(--radius-xs);padding:0 4px;margin-left:2px}.study-library-trigger.active{color:var(--accent-strong);background:var(--bg-hover)}@media(max-width:1100px){.study-library-trigger kbd{display:none}}@media(max-width:540px){.study-library-trigger{margin-left:4px;padding:0 6px;gap:4px}.study-library-trigger span{font-size:11px}}
  button{min-height:28px}.intervals>button{min-width:32px;padding:0 6.5px;font:500 12px/1 var(--mono);border-radius:var(--radius-sm)}select{font-weight:500;border-radius:var(--radius-sm)}
  .commands-button{display:inline-flex;align-items:center;gap:6px;min-width:36px;padding:0 10px;border-radius:var(--radius-sm)}.commands-button span{font-size:12px}.compact-period{display:none}
  .workspace-settings{position:relative;flex-shrink:0}.workspace-settings summary{display:flex;align-items:center;justify-content:center;list-style:none;width:32px;height:32px;cursor:pointer;color:var(--text-dim);border-radius:var(--radius-sm)}.workspace-settings summary::-webkit-details-marker{display:none}.workspace-settings summary:hover,.workspace-settings[open] summary{color:var(--text);background:var(--bg-hover)}.workspace-settings summary:focus-visible{outline:1px solid var(--accent);outline-offset:-2px}.settings-popover{position:absolute;right:0;top:calc(100% + 6px);width:265px;max-width:calc(100vw - 24px);padding:12px;background:var(--surface-raised,var(--bg-panel));border:1px solid var(--line);border-radius:var(--radius-md);z-index:85;box-shadow:var(--shadow-md)}.settings-popover label{display:grid;gap:6px;margin-bottom:12px;font-size:11px;color:var(--text-dim)}.settings-popover select{width:100%;height:32px}.settings-popover button{display:flex;align-items:center;gap:8px;text-align:left;width:100%;min-height:32px;padding:5px 8px}.reconnect-alert{color:var(--accent);font-size:11px;padding:0 8px}.reconnect-alert.failed{color:var(--down);border:1px solid currentColor}
  @media(max-width:950px){.toolbar{padding:4px 8px}.separator{display:none}.intervals{order:5;width:100%;margin-left:0;border-top:1px solid var(--line);padding-top:3px}.intervals>button{flex:1}.brand{font-size:11px}}
  @media(max-width:540px){.brand{display:none}.toolbar{gap:0}.symbol-search-button{max-width:140px;padding:0 8px}.symbol-search-button strong{font-size:11px}select{font-size:11px;padding:0 22px 0 6px}.spacer{min-width:0}}
  @media(max-width:1100px){.brand{display:none}.toolbar{flex-wrap:nowrap;height:46px;min-height:46px;gap:5px;padding:3px 8px}.intervals,.separator,.spacer{display:none}.compact-period{display:block;width:68px;height:36px;padding:0 20px 0 6px;font-size:12px}.symbol-search-button{max-width:none;min-width:0;flex:1;height:36px}.study-library-trigger{margin:0;width:36px;height:36px;padding:0;justify-content:center;flex-shrink:0}.study-library-trigger span,.study-library-trigger kbd,.commands-button span{display:none}.commands-button{width:36px;padding:0;justify-content:center}.workspace-settings summary{width:36px;height:36px}.toolbar .symbol-search-button strong{font-size:12px}.reconnect-alert{font-size:10px;padding:0 4px}}
  @media(max-width:400px){.commands-button{display:none}}
</style>
