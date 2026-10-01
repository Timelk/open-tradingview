<script lang="ts">
  import {onDestroy,tick,untrack} from 'svelte';
  import {t,canonicalT,locale} from '../../lib/i18n';
  import type {WorkspacePanelProps} from '../layout/panel-context';
  import type {ChartOrderFlowState,OrderFlowSettings} from '../../lib/flow/chart-order-flow';
  import type {DatasetInfo} from '../../lib/flow/persistence-client';
  import type {AggregatedBookLevel} from '../../lib/flow/orderbook-models';
  import {followBookCenter,type BookCenterFollower} from '../../lib/flow/terminal-scroll';
  import {terminalStatus,buildTerminalLadder,terminalDeltaRows,terminalPriceDigits,formatTerminalAmount} from '../../lib/flow/terminal-presentation';
  import {formatFlowNumber,formatFlowTime} from '../../lib/flow/canvas-presentation';
  import {getMarketConnector} from '../../lib/market/connectors';
  import {tabKeys} from '../../lib/ui/tabs';
  import ToolIcon from '../drawing/ToolIcon.svelte';
  import HeatmapSettings from './HeatmapSettings.svelte';
  import {surface as sheetMotion,setSurfaceInteractive} from '../../lib/ui/motion';

  let {context,active=true,density='compact',zone,onClose}:WorkspacePanelProps=$props();
  const flow=$derived(context.controller.orderFlow);
  let snapshot=$state.raw<ChartOrderFlowState>(untrack(()=>context.controller.orderFlow.snapshot()));
  let settingsOpen=$state(false),settingsButton=$state<HTMLButtonElement>(),settingsSheet=$state<HTMLDivElement>(),bookElement=$state<HTMLDivElement>(),ladderElement=$state<HTMLDivElement>();
  let bookCenter=$state.raw<BookCenterFollower>();
  let locked=$state(false),manualCenter=$state<number|null>(null),seekDraft=$state<number|null>(null);
  let archives=$state.raw<DatasetInfo[]>([]),archivesLoading=$state(false),archivesLoaded=$state(false),archiveError=$state('');
  let pricesBusy=$state(false),pricesMessage=$state('');
  let seekTimer:ReturnType<typeof setTimeout>|undefined,archiveGeneration=0,marketKey='';
  $effect(()=>{if(active)return flow.subscribe(next=>snapshot=next);});
  $effect(()=>{if(active)return flow.panel();});
  onDestroy(()=>{clearTimeout(seekTimer);archiveGeneration++;});
  $effect(()=>{
    const m=snapshot.market,key=m?`${m.source}:${m.marketType}:${m.symbol}`:'';
    if(key!==marketKey){marketKey=key;untrack(()=>{locked=false;manualCenter=null;archives=[];archivesLoaded=false;archivesLoading=false;archiveError='';pricesMessage='';seekDraft=null;clearTimeout(seekTimer);archiveGeneration++;});}
  });
  const status=$derived(terminalStatus(snapshot));
  const settings=$derived(snapshot.settings),archive=$derived(snapshot.archive);
  const book=$derived.by(()=>{snapshot;return flow.aggregate(settings.view==='dom'?200:30);});
  const ladder=$derived(book?buildTerminalLadder(book,snapshot.mode==='live'?snapshot.trades:undefined,locked&&manualCenter!==null?manualCenter:book.mid??0):undefined);
  const ladderCenterKey=$derived(book?.mid==null?'':Math.round(book.mid/book.priceStep));
  const bookIdentity=$derived(`${snapshot.market?.source}:${snapshot.market?.symbol}:${snapshot.mode}:${archive?.dataset.id??''}:${settings.view}`);
  const bidChanges=$derived(book?terminalDeltaRows(book,'bids'):[]),askChanges=$derived(book?terminalDeltaRows(book,'asks'):[]);
  const bookShape=$derived(`${settings.view==='delta'?askChanges.length:book?.asks.length??0}:${settings.view==='delta'?bidChanges.length:book?.bids.length??0}:${book?.priceStep??0}:${density}`);
  const maxSize=$derived(Math.max(1e-12,...[...(book?.bids??[]),...(book?.asks??[])].map(row=>row.quantity)));
  const maxCumulative=$derived(Math.max(1e-12,...[...(book?.bids??[]),...(book?.asks??[])].map(row=>row.cumulative)));
  const maxDelta=$derived(Math.max(1e-12,...[...bidChanges,...askChanges].flatMap(row=>[row.added,row.subtracted])));
  const deltaTotals=$derived([...bidChanges,...askChanges].reduce((sum,row)=>({added:sum.added+row.added,subtracted:sum.subtracted+row.subtracted}),{added:0,subtracted:0}));
  // Direction of the last mid move, for the ▲/▼ cue next to the mid price.
  let lastMid:number|null=null,midTrend=$state(0);
  $effect(()=>{const mid=book?.mid??null;if(mid!==null&&lastMid!==null&&mid!==lastMid)midTrend=mid>lastMid?1:-1;lastMid=mid;});
  // Live DOM leaves empty trade cells blank; history marks the missing tape.
  const tradeCell=(value:number|null|undefined)=>snapshot.mode==='history'||value?amount(value):'';
  const asset=$derived(context.chartState.contract?.baseAsset??snapshot.market?.symbol.replace(/USDT$/,'')??'');
  const quote=$derived(context.chartState.contract?.quoteCurrency??getMarketConnector(context.chartState.source)?.defaultQuoteCurrency??'');
  const unitLabel=$derived(settings.unit==='quote'?quote:asset);
  const digits=$derived(terminalPriceDigits(snapshot.market?.tickSize??0));
  const amount=(value:number|null|undefined)=>formatTerminalAmount(value,$locale);
  const price=(value:number|null|undefined)=>value===null?'—':formatFlowNumber(value,$locale,digits);
  const midPrice=(value:number|null|undefined)=>value===null?'—':formatFlowNumber(value,$locale,terminalPriceDigits((snapshot.market?.tickSize??0)/2));
  const exact=(value:number|null|undefined)=>value===null?'—':formatFlowNumber(value,$locale,8);
  const time=(value:number|undefined)=>value===undefined?'—':formatFlowTime(value,$locale);
  const day=(value:number|undefined)=>value===undefined?'—':new Date(value).toLocaleString($locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'});
  const bidPercent=$derived(book?.imbalance===null||book?.imbalance===undefined?null:(1+book.imbalance)*50);
  const historyCoverage=$derived(snapshot.mode==='live'?snapshot.book?.historyCoverage:undefined);
  const receiveAge=$derived(snapshot.mode==='live'&&snapshot.book?.lastReceivedAt?Math.max(0,snapshot.book.capturedAt-snapshot.book.lastReceivedAt):null);
  $effect(()=>{const element=bookElement;if(!element)return;const follower=followBookCenter(element);bookCenter=follower;follower.update(untrack(()=>bookIdentity),untrack(()=>bookShape));return()=>{follower.destroy();};});
  $effect(()=>{const identity=bookIdentity,shape=bookShape;bookCenter?.update(identity,shape);});

  $effect(()=>{ladderCenterKey;const element=ladderElement;if(element&&!locked)void tick().then(()=>{const middle=element.querySelector<HTMLElement>('.mid');if(middle&&element.isConnected&&!locked)element.scrollTop=Math.max(0,element.scrollTop+middle.getBoundingClientRect().top-element.getBoundingClientRect().top-element.clientHeight/2+middle.clientHeight/2);});});

  function change(patch:Partial<OrderFlowSettings>){flow.settings(patch);}
  function center(){locked=false;manualCenter=null;}
  function toggleLock(){if(!locked)manualCenter=book?.mid??null;locked=!locked;}
  function shift(rows:number){if(!book?.mid)return;manualCenter=Math.max(book.priceStep,(locked&&manualCenter!==null?manualCenter:book.mid)+rows*book.priceStep);locked=true;}
  function ladderKeys(event:KeyboardEvent){
    if(event.ctrlKey||event.metaKey||event.altKey||!['ArrowUp','ArrowDown','PageUp','PageDown','Home'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();if(event.key==='Home')center();else shift(event.key==='ArrowUp'?1:event.key==='ArrowDown'?-1:event.key==='PageUp'?10:-10);
  }
  function closeSettings(refocus=false){settingsOpen=false;if(refocus)settingsButton?.focus();}
  function settingsKeys(event:KeyboardEvent){if(event.key==='Escape'&&settingsOpen){const inside=event.target instanceof Node&&(settingsSheet?.contains(event.target)||settingsButton?.contains(event.target));closeSettings(Boolean(inside));if(inside){event.preventDefault();event.stopPropagation();}}}
  function dismissSettings(event:PointerEvent){if(settingsOpen&&event.target instanceof Node&&!settingsSheet?.contains(event.target)&&!settingsButton?.contains(event.target))closeSettings();}
  // Heatmap bounds are in the display unit; switching units re-derives them.
  function changeUnit(unit:'base'|'quote'){if(unit!==settings.unit)change({unit,threshold:0,ceiling:0,minBounds:0,maxBounds:0,...(settings.sensitivity==='custom'?{sensitivity:'med' as const}:{})});}
  async function refreshArchives(){
    if(snapshot.market?.source!=='binance'||snapshot.market.marketType!=='usdm-perpetual'){archives=[];archivesLoaded=true;return;}
    const generation=++archiveGeneration,key=marketKey;archivesLoading=true;archiveError='';
    try{const result=await flow.datasets();if(generation===archiveGeneration&&key===marketKey){archives=result;archivesLoaded=true;}}
    catch(error){if(generation===archiveGeneration)archiveError=error instanceof Error?error.message:$t('行情档案加载失败');}
    finally{if(generation===archiveGeneration)archivesLoading=false;}
  }
  function chooseArchive(id:string){const chosen=archives.find(item=>item.id===id);if(chosen){center();pricesMessage='';void flow.loadArchive(chosen);}}
  function scrub(value:number){
    if(!Number.isFinite(value))return;seekDraft=value;clearTimeout(seekTimer);
    seekTimer=setTimeout(()=>{seekTimer=undefined;void flow.seek(value).finally(()=>{if(seekDraft===value)seekDraft=null;});},120);
  }
  function returnLive(){clearTimeout(seekTimer);seekDraft=null;center();pricesMessage='';context.controller.returnToLiveOrderFlow();}
  async function loadPrices(){
    if(pricesBusy)return;pricesBusy=true;pricesMessage='';const key=marketKey,id=archive?.dataset.id;
    try{await context.controller.loadOrderFlowArchivePrices();if(key===marketKey&&id===archive?.dataset.id)pricesMessage=$t('档案价格图已载入');}
    catch(error){if(key===marketKey&&id===archive?.dataset.id)pricesMessage=error instanceof Error?error.message:$t('行情档案加载失败');}
    finally{pricesBusy=false;}
  }
</script>

<svelte:window onpointerdown={dismissSettings} onkeydowncapture={settingsKeys}/>
{#snippet levelRows(rows:AggregatedBookLevel[],side:'bid'|'ask',delta=false)}
  {#each rows as row (row.price)}
    {#if delta}
      <div class="depth-row delta-row" class:bid={side==='bid'} class:ask={side==='ask'} role="row">
        <span class="row-price" role="cell" title={price(row.price)}>{price(row.price)}</span>
        <span class="delta-added" role="cell" title={exact(row.added)}>{#if row.added>0}<i class="delta-bar" style:transform={`scaleX(${Math.min(1,row.added/maxDelta)})`}></i><b>+{amount(row.added)}</b>{/if}</span>
        <span class="delta-removed" role="cell" title={exact(row.subtracted)}>{#if row.subtracted>0}<i class="delta-bar" style:transform={`scaleX(${Math.min(1,row.subtracted/maxDelta)})`}></i><b>−{amount(row.subtracted)}</b>{/if}</span>
      </div>
    {:else}
      <div class="depth-row" class:bid={side==='bid'} class:ask={side==='ask'} role="row">
        <span class="row-price" role="cell" title={price(row.price)}>{price(row.price)}</span>
        <span class="row-amount" role="cell" title={exact(row.quantity)}><i class="depth-fill" style:transform={`scaleX(${Math.min(1,row.quantity/maxSize)})`}></i><b>{amount(row.quantity)}</b></span>
        <span class="row-total" role="cell" title={exact(row.cumulative)}><i class="cum-fill" style:transform={`scaleX(${Math.min(1,row.cumulative/maxCumulative)})`}></i><b>{amount(row.cumulative)}</b></span>
      </div>
    {/if}
  {/each}
{/snippet}

<section class="orderbook-terminal" class:comfortable={density==='comfortable'} data-zone={zone} aria-label={$t('盘口终端')}>
  <header class="terminal-header">
    <div class="identity"><span class="connection" data-phase={status.phase} title={$canonicalT(status.detail)}><i></i></span><strong>{snapshot.market?.symbol??context.chartState.symbol}</strong><span class="connection-label" data-phase={status.phase}>{$t(status.label)}</span></div>
    <div class="header-actions">
      {#if snapshot.mode==='history'}<button class="return-live" onclick={returnLive} title={$t('返回实时盘口')}>{$t('实时')}</button>
      {:else}<button class="icon-button" onclick={()=>flow.pause(snapshot.running)} disabled={status.phase==='unsupported'} aria-label={$t(snapshot.running?'暂停更新':'恢复更新')} title={$t(snapshot.running?'暂停更新':'恢复更新')}><span aria-hidden="true">{snapshot.running?'Ⅱ':'▶'}</span></button>
      <button class="icon-button" class:attention={status.phase==='error'||status.phase==='stale'} onclick={()=>flow.reconnect()} disabled={status.phase==='unsupported'} aria-label={$t('重新连接行情')} title={$t('重新连接行情')}><span aria-hidden="true">↻</span></button>{/if}
      <button class="icon-button settings-trigger" class:open={settingsOpen} bind:this={settingsButton} aria-haspopup="dialog" aria-expanded={settingsOpen} aria-controls="orderbook-settings" aria-label={$t('盘口设置')} title={$t('盘口设置')} onclick={()=>settingsOpen=!settingsOpen}><ToolIcon name="gear" size={16}/>{#if settings.heatmap||settings.profile}<i class="overlay-dot" aria-hidden="true"></i>{/if}</button>
      <button class="icon-button" onclick={onClose} aria-label={$t('关闭盘口终端')} title={$t('关闭盘口终端')}><ToolIcon name="close" size={15}/></button>
    </div>
  </header>
  <div class="terminal-body">
  <div class="terminal-tabs" role="tablist" data-view={settings.view} tabindex="-1" aria-label={$t('盘口视图')} onkeydown={tabKeys}>
    {#each [{id:'book',label:'Book'},{id:'delta',label:'Delta'},{id:'dom',label:'DOM'}] as tab}
      <button role="tab" id={`orderbook-tab-${tab.id}`} aria-selected={settings.view===tab.id} aria-controls="orderbook-content" tabindex={settings.view===tab.id?0:-1} onclick={()=>change({view:tab.id as OrderFlowSettings['view']})}>{tab.label}</button>
    {/each}
  </div>

  <div class="terminal-content" id="orderbook-content" role="tabpanel" aria-labelledby={`orderbook-tab-${settings.view}`}>
    {#if seekDraft!==null||!status.showBook||!book}
      <div class="terminal-empty" role="status"><strong>{$t(seekDraft!==null?'正在定位历史盘口':status.label)}</strong>{#if status.detail}<p>{$canonicalT(status.detail)}</p>{:else if seekDraft===null&&(status.phase==='initial'||status.phase==='loading')}<p>{$t('真实深度未到达')}</p>{/if}{#if status.phase==='error'||status.phase==='stale'}<button onclick={()=>flow.reconnect()}>{$t('重试')}</button>{/if}</div>
    {:else if settings.view==='dom'}
      <div class="ladder-controls"><button class:chosen={locked} aria-pressed={locked} onclick={toggleLock}>{$t(locked?'固定价梯':'自动居中')}</button><button onclick={center} title={$t('回到中间价')}>{$t('居中')}</button><button class="icon-button" aria-label={$t('上移价梯')} onclick={()=>shift(5)}>↑</button><button class="icon-button" aria-label={$t('下移价梯')} onclick={()=>shift(-5)}>↓</button></div>
      <div class="ladder-heading" aria-hidden="true"><span>{$t('买量')}</span><span>{$t('买成交')}</span><span>{$t('价格')}</span><span>{$t('卖成交')}</span><span>{$t('卖量')}</span></div>
      <div class="ladder-body" bind:this={ladderElement} role="grid" tabindex="0" onwheel={event=>{event.stopPropagation();if(!locked){manualCenter=book?.mid??null;locked=true;}}} aria-label={$t('价格阶梯，方向键移动，Home 居中')} onkeydown={ladderKeys}>
        {#each ladder?.rows??[] as row (row.price)}
          <div class="ladder-row" class:mid={row.atMid} role="row"><span class="bid size-cell" role="gridcell" title={exact(row.bid?.quantity)}>{#if row.bid}<i class="depth-fill" style:transform={`scaleX(${Math.min(1,row.bid.quantity/maxSize)})`}></i>{/if}<b>{row.bid?amount(row.bid.quantity):''}</b></span><span class="bid trade" role="gridcell" title={exact(row.buy)}>{tradeCell(row.buy)}</span><span class="ladder-price" role="gridcell">{price(row.price)}</span><span class="ask trade" role="gridcell" title={exact(row.sell)}>{tradeCell(row.sell)}</span><span class="ask size-cell" role="gridcell" title={exact(row.ask?.quantity)}>{#if row.ask}<i class="depth-fill" style:transform={`scaleX(${Math.min(1,row.ask.quantity/maxSize)})`}></i>{/if}<b>{row.ask?amount(row.ask.quantity):''}</b></span></div>
        {/each}
      </div>
      <p class="tape-caption">{$t('近30个1秒块')} · {snapshot.mode==='history'?$t('历史成交窗口未提供'):ladder?.tradeBasis==='coarse'?$t('成交粒度不足，暂不分配价梯'):ladder?.tradeBasis==='unavailable'?$t('等待真实成交'):ladder?.tradeBasis==='partial'?$t('部分覆盖'):$t('已接收成交')}{#if ladder?.tradeFrom!==undefined} · {time(ladder.tradeFrom)}–{time(ladder.tradeThrough)} UTC{/if}</p>
    {:else if settings.view==='delta'&&snapshot.mode==='history'}
      <div class="terminal-empty" role="status"><strong>{$t('历史 Delta 暂不可用')}</strong><p>{$t('该档案未提供连续盘口增减窗口；Book 和 DOM 仍可查看历史快照。')}</p></div>
    {:else}
      {#if settings.view==='delta'}<div class="delta-tools"><label>{$t('盘口增减窗口')}<select aria-label={$t('盘口增减窗口')} value={settings.windowMs} onchange={e=>change({windowMs:Number(e.currentTarget.value)})}>{#each [1000,5000,30000] as value}<option value={value}>{value/1000}s</option>{/each}</select></label>{#if !book.changeWindow.covered}<span class="partial" role="status">{$t(book.changeWindow.truncated?'窗口覆盖不足':'窗口积累中')}</span>{/if}</div>{/if}
      <div class="depth-heading" aria-hidden="true"><span>{$t('价格')}</span><span>{$t(settings.view==='delta'?'增加':'挂单量')}</span><span>{$t(settings.view==='delta'?'减少':'累计')}</span></div>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (A labeled scrolling region must be keyboard reachable without moving the chart.) -->
      <div class="book-scroll" bind:this={bookElement} role="region" tabindex="0" aria-label={$t('盘口价档，方向键滚动')}><div role="table" aria-label={$t(settings.view==='delta'?'盘口价档增减':'当前盘口')}>
        {@render levelRows([...(settings.view==='delta'?askChanges:book.asks)].reverse(),'ask',settings.view==='delta')}
        <div class="book-mid" role="row">
          <span class="mid-main" role="cell"><span class="mid-label">{$t('中间价')}</span><strong class="mid-price" class:up={midTrend>0} class:down={midTrend<0}>{midPrice(book.mid)}</strong><span class="mid-arrow" aria-hidden="true">{midTrend>0?'▲':midTrend<0?'▼':''}</span></span>
          {#if settings.view==='delta'}<span class="mid-meta delta-totals" role="cell"><b class="bid">+{amount(deltaTotals.added)}</b><b class="ask">−{amount(deltaTotals.subtracted)}</b></span>
          {:else}<span class="mid-meta" role="cell" title={$t('按当前展示深度计算，不代表成交比例')}>{bidPercent===null?'—':`${formatFlowNumber(bidPercent,$locale,1)}% / ${formatFlowNumber(100-bidPercent,$locale,1)}%`} {$t('买 / 卖')} · {$t('价差')} {price(book.spread)}</span>{/if}
          <button class="center-button" onclick={()=>bookCenter?.resume()} aria-label={$t('回到中间价')} title={$t('回到中间价')}>{$t('居中')}</button>
        </div>
        {@render levelRows(settings.view==='delta'?bidChanges:book.bids,'bid',settings.view==='delta')}
        {#if settings.view==='delta'&&!bidChanges.length&&!askChanges.length}<p class="no-changes">{$t(book.changeWindow.covered?'此窗口未收到价档增减':'正在积累连续深度更新')}</p>{/if}
      </div></div>
      <p class="range-caption">{#if settings.view==='delta'}{$t('已接收增减价位，最多每侧30档')} · {$t('盘口增减，不是成交 Delta')}{:else}{$t('最优价附近各 {0} 档',{0:book.range.limitPerSide})} · {price(book.range.bidLow)}–{price(book.range.askHigh)}{/if}</p>
    {/if}
  </div>

  <details class="archive-tools" ontoggle={e=>{if(e.currentTarget.open&&!archivesLoaded&&!archivesLoading)void refreshArchives();}}>
    <summary>{$t('深度档案')}{#if snapshot.mode==='history'}<span class="historical-tag">{$t('历史')}</span>{/if}</summary>
    <div class="archive-controls"><select aria-label={$t('选择深度档案')} value={archive?.dataset.id??''} onchange={e=>chooseArchive(e.currentTarget.value)} disabled={archivesLoading}><option value="">{$t(archivesLoading?'正在加载档案列表':archives.length?'选择深度档案':'暂无已录深度')}</option>{#each archives as item (item.id)}<option value={item.id}>{day(item.fromTime)}–{day(item.throughTime)} UTC</option>{/each}</select><button class="icon-button" onclick={()=>void refreshArchives()} disabled={archivesLoading} aria-label={$t('刷新深度档案')}>↻</button></div>
    {#if archiveError}<p role="status">{$canonicalT(archiveError)}</p>{/if}
    {#if snapshot.mode==='history'&&archive}
      <label class="seek-label"><span>{day(seekDraft??archive.cursor)} UTC</span><input type="range" aria-label={$t('深度回放时间')} min={archive.from} max={archive.to} step="1000" value={seekDraft??archive.cursor} oninput={e=>scrub(e.currentTarget.valueAsNumber)}/></label>
      <div class="archive-actions"><button onclick={loadPrices} disabled={pricesBusy||archive.pending}>{$t(pricesBusy?'正在载入价格图…':'载入档案价格图')}</button><button onclick={returnLive}>{$t('返回实时盘口')}</button></div>
      {#if pricesMessage}<p role="status">{$canonicalT(pricesMessage)}</p>{/if}
    {/if}
  </details>
  <footer><span>{snapshot.mode==='history'?$t('历史盘口'):receiveAge===null?'—':$t('接收 {0}s 前',{0:formatFlowNumber(receiveAge/1000,$locale,1)})}</span><details><summary>{$t('数据说明')}</summary><p>{$t('公开 L2 聚合档位。盘口减少不直接等于撤单，买卖成交来自独立成交流。')}</p><p>{$t('热图和深度分布可在关闭面板后继续显示。')}</p>{#if snapshot.book}<p>{$t('采集起点')} {day(snapshot.book.coverage.fromTime??undefined)} UTC · {$t('当前盘口重建上限')} {snapshot.book.coverage.depthPerSide}</p>{/if}<p>{$t('热图保留采样')} {historyCoverage?.samples??'—'} · {$t('采样间隔')} {historyCoverage?formatFlowNumber(historyCoverage.intervalMs/1000,$locale,2)+'s':'—'} · {$t('每侧原始价档')} {historyCoverage?.levelsPerSide??'—'}</p><p>{$t('热图保留区间')} {time(historyCoverage?.fromTime??undefined)}–{time(historyCoverage?.throughTime??undefined)} UTC</p><p>{$t('盘口重建深度不等于热图保留深度。超出已采集区间保持空白。')}</p>{#if status.detail}<p>{$canonicalT(status.detail)}</p>{/if}</details></footer>
  {#if settingsOpen}
    <div class="settings-sheet" id="orderbook-settings" role="dialog" aria-label={$t('盘口设置')} bind:this={settingsSheet} transition:sheetMotion={{y:-6,enter:160,exit:100}} onoutrostart={e=>setSurfaceInteractive(e.currentTarget,false)}>
      <div class="sheet-section">
        <h3 class="sheet-heading">{$t('盘口')}</h3>
        <label class="sheet-field">{$t('价格粒度')}<span class="input-suffix"><input type="number" min="1" max="100000" step="1" value={settings.priceStepTicks} onchange={e=>change({priceStepTicks:e.currentTarget.valueAsNumber})}/><span>ticks · {price((snapshot.market?.tickSize??0)*settings.priceStepTicks)}</span></span></label>
        <label class="sheet-field">{$t('数量口径')}<select value={settings.unit} onchange={e=>changeUnit(e.currentTarget.value as 'base'|'quote')}><option value="base">{asset||$t('基础量')}</option><option value="quote">{quote||$t('报价量')}</option></select></label>
      </div>
      <HeatmapSettings controller={context.controller} {settings} {unitLabel} revision={snapshot.revision} locale={$locale} {change}/>
      <button class="sheet-done" onclick={()=>closeSettings(true)}>{$t('完成')}</button>
    </div>
  {/if}
  </div>
</section>

<style>
  .orderbook-terminal{--bid:var(--up,#45c7ae);--ask:var(--down,#e78a94);display:flex;flex:1 1 auto;flex-direction:column;width:100%;max-width:100%;height:100%;min-height:0;min-width:0;box-sizing:border-box;background:var(--bg-panel,#191d24);color:var(--text,#cbd4df);font:11px var(--font);font-variant-numeric:tabular-nums;overflow:hidden}.terminal-header{display:flex;align-items:center;justify-content:space-between;gap:4px;padding:7px 8px;border-bottom:1px solid var(--line);min-height:40px;box-sizing:border-box}.identity{display:flex;align-items:center;gap:7px;min-width:0}.identity>strong{font:600 12px var(--mono);letter-spacing:.01em;overflow:hidden;text-overflow:ellipsis}.connection{display:inline-flex;align-items:center}.connection i{width:6px;height:6px;border-radius:50%;background:var(--accent);transition:background var(--motion-fast,110ms) ease}.connection-label{font-size:10px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.connection[data-phase=live] i{box-shadow:0 0 0 3px color-mix(in srgb,var(--bid) 18%,transparent)}.connection[data-phase=live] i{background:var(--bid)}.connection[data-phase=error] i,.connection[data-phase=stale] i{background:var(--ask)}.header-actions{display:flex;align-items:center;gap:2px;flex-shrink:0}button{color:var(--text-dim);background:transparent;border:0;border-radius:var(--radius-xs);font-size:11px;min-height:28px;padding:4px 7px;cursor:pointer}button:hover,summary:hover{color:var(--text);background:var(--bg-hover)}button:disabled{opacity:.4;cursor:default}button:focus-visible,select:focus-visible,summary:focus-visible,input:focus-visible,.ladder-body:focus-visible{outline:1px solid var(--accent);outline-offset:-2px}.icon-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;min-height:28px;padding:0}.icon-button.attention{color:var(--ask)}.settings-trigger{position:relative}.settings-trigger.open{color:var(--text);background:var(--bg-hover)}.overlay-dot{position:absolute;top:5px;right:5px;width:5px;height:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 2px var(--bg-panel)}.terminal-body{position:relative;display:flex;flex:1;flex-direction:column;min-height:0}.settings-sheet{position:absolute;inset:0;z-index:30;display:grid;align-content:start;gap:16px;padding:12px 12px 14px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;background:var(--bg-panel);box-shadow:inset 0 1px 0 var(--line)}.sheet-section{display:grid;gap:10px}.settings-sheet :global(.sheet-heading){margin:0;font:600 10px var(--font);letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim)}.sheet-field{display:grid;grid-template-columns:72px minmax(0,1fr);align-items:center;gap:10px;color:var(--text-dim);font-size:11px}.sheet-field input,.sheet-field select{width:100%}.sheet-done{justify-self:end;min-width:72px;border:1px solid var(--line);color:var(--text)}input,select{min-width:0;max-width:100%;box-sizing:border-box;color:var(--text);border:1px solid var(--line);border-radius:var(--radius-xs);background:var(--bg);font:11px var(--mono);height:29px;padding:3px 6px}.input-suffix{display:flex;align-items:center;gap:6px;min-width:0}.input-suffix input{flex:0 0 64px;width:64px}.input-suffix span{font:10px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.terminal-tabs{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;margin:6px 8px;padding:2px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--bg);flex-shrink:0}.terminal-tabs button{font:500 11.5px var(--font);min-height:26px;height:26px;border-radius:var(--radius-sm);transition:background var(--motion-fast,110ms) ease,color var(--motion-fast,110ms) ease}.terminal-tabs button[aria-selected=true]{background:var(--bg-hover);color:var(--text);box-shadow:0 1px 2px rgb(0 0 0 / calc(0.27 * var(--shadow-strength)))}.ladder-controls .chosen{color:var(--text);background:var(--bg-hover);border-color:var(--accent)}.terminal-content{display:flex;flex:1;flex-direction:column;min-height:120px;min-width:0;overflow:hidden}.terminal-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:9px;padding:24px 16px;min-height:130px;box-sizing:border-box}.terminal-empty strong{font-size:12px;font-weight:500}.terminal-empty p{color:var(--text-dim);font-size:11px;line-height:1.7;margin:0;overflow-wrap:anywhere;max-width:100%}.terminal-empty button{border:1px solid var(--line);padding:5px 15px}.depth-heading,.depth-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.9fr) minmax(0,1fr);align-items:center;gap:4px;padding:0 9px;text-align:right}.depth-heading{font-size:9px;color:var(--text-dim);height:24px;min-height:24px;border-bottom:1px solid var(--line)}.depth-heading>span:first-child,.row-price{text-align:left}.book-scroll{overflow-anchor:none;position:relative;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 12px,#000 calc(100% - 12px),transparent 100%);mask-image:linear-gradient(to bottom,transparent 0,#000 12px,#000 calc(100% - 12px),transparent 100%)}.depth-row{min-height:22px;font:10px var(--mono)}.depth-row{transition:background var(--motion-fast,110ms) ease}.depth-row:hover{background:var(--bg-hover)}.depth-row>span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;line-height:22px}.bid .row-price,.bid{color:var(--bid)}.ask .row-price,.ask{color:var(--ask)}.depth-row>span:not(.row-price){color:var(--text)}.row-amount,.row-total{position:relative;padding-inline:4px}.row-amount b,.row-total b,.delta-row b{position:relative;font-weight:400}.depth-fill,.cum-fill,.delta-bar{position:absolute;left:0;right:0;top:2px;bottom:2px;transform-origin:right center;background:var(--bid);transition:transform 140ms cubic-bezier(.22,1,.36,1)}.depth-fill{opacity:.24}.cum-fill{opacity:.09}.ask .depth-fill,.ask .cum-fill{background:var(--ask)}.delta-added,.delta-removed{position:relative;padding-inline:4px}.delta-added .delta-bar{background:var(--bid);opacity:.3}.delta-removed{border-left:1px solid var(--line)}.delta-removed .delta-bar{transform-origin:left center;background:var(--ask);opacity:.3}.delta-row .delta-added b{color:var(--bid)}.delta-row .delta-removed b{color:var(--ask)}.delta-row .delta-removed{text-align:left}.book-mid{position:sticky;display:grid;grid-template-columns:1fr auto;grid-template-rows:auto auto;align-items:center;column-gap:8px;row-gap:2px;min-height:48px;padding:6px 9px;border-block:1px solid var(--line);background:var(--bg-panel);color:var(--text-dim)}.mid-main{display:flex;align-items:baseline;gap:6px;min-width:0}.mid-label{font-size:9.5px;color:var(--text-dim)}.book-mid .mid-price{font:600 17px var(--mono);color:var(--text);transition:color 200ms ease}.book-mid .mid-price.up,.mid-price.up+.mid-arrow{color:var(--bid)}.book-mid .mid-price.down,.mid-price.down+.mid-arrow{color:var(--ask)}.mid-arrow{font-size:10px}.mid-meta{grid-column:1;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.delta-totals{display:flex;gap:10px;font:500 10.5px var(--mono)}.delta-totals .bid{color:var(--bid)}.delta-totals .ask{color:var(--ask)}.center-button{grid-column:2;grid-row:1/span 2;font-size:10px;min-height:24px;padding:2px 8px;border:1px solid var(--line)}.range-caption,.tape-caption{margin:0;padding:6px 9px;border-top:1px solid var(--line);font-size:9px;color:var(--text-dim);line-height:1.5;overflow-wrap:anywhere}.delta-tools{display:flex;align-items:center;justify-content:space-between;gap:5px;padding:5px 9px}.delta-tools label{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text-dim)}.delta-tools select{width:60px;height:25px}.partial{color:var(--accent);font-size:9px}.no-changes{margin:12px 8px;text-align:center;color:var(--text-dim);font-size:10px}.ladder-controls{display:flex;align-items:center;gap:3px;padding:4px 6px}.ladder-controls>button:first-child{margin-right:auto}.ladder-controls>button{font-size:10px}.ladder-heading,.ladder-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.85fr) minmax(72px,1.2fr) minmax(0,.85fr) minmax(0,1fr);gap:2px;align-items:center;padding:0 6px;text-align:right}.ladder-heading{height:25px;min-height:25px;color:var(--text-dim);font-size:9px;border-bottom:1px solid var(--line)}.ladder-heading span:nth-child(3){text-align:center}.ladder-body{overflow-anchor:none;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;outline:none;-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 10px,#000 calc(100% - 10px),transparent 100%);mask-image:linear-gradient(to bottom,transparent 0,#000 10px,#000 calc(100% - 10px),transparent 100%)}.ladder-row{min-height:25px;font:10px var(--mono);border-bottom:1px solid color-mix(in srgb,var(--line) 50%,transparent)}.ladder-row>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 2px}.ladder-row>.ladder-price{font-weight:500;text-align:center;padding:5px 2px;color:var(--text);background:var(--bg-hover);overflow:hidden;text-overflow:ellipsis}.ladder-row.mid{background:color-mix(in srgb,var(--accent) 14%,transparent)}.ladder-row.mid>.ladder-price{background:color-mix(in srgb,var(--accent) 25%,transparent)}.trade{opacity:.85}.size-cell{position:relative}.bid.size-cell .depth-fill{transform-origin:right center}.ask.size-cell .depth-fill{transform-origin:left center}.size-cell b{position:relative;font-weight:400}.archive-tools{border-top:1px solid var(--line);padding:0 8px;flex-shrink:0;max-height:220px;overflow:auto}.archive-tools>summary{font-size:10px;color:var(--text-dim);cursor:pointer;padding:9px 0}.historical-tag{margin-left:8px;color:var(--accent)}.archive-controls{display:flex;gap:4px}.archive-controls select{flex:1;min-width:0;font-size:10px}.archive-tools p{font-size:10px;color:var(--text-dim);line-height:1.6;overflow-wrap:anywhere}.seek-label{display:grid;gap:4px;margin-top:10px;font:10px var(--mono);color:var(--text-dim)}.seek-label input{width:100%;padding:0;border:0}.archive-actions{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0}.archive-actions button{border:1px solid var(--line);font-size:10px}footer{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--line);padding:5px 9px;font:9px var(--font);color:var(--text-dim);flex-shrink:0}footer details{min-width:0}footer summary{cursor:pointer;text-align:right}footer details[open]{max-width:100%}footer details p{line-height:1.6;overflow-wrap:anywhere}footer:has(details[open]){display:block;max-height:170px;overflow:auto}.comfortable .depth-row{min-height:27px}.comfortable .depth-row>span{line-height:27px}@media(pointer:coarse),(max-width:767px){button,.icon-button,.terminal-tabs button,.archive-actions button{min-height:40px}.icon-button{width:40px;height:40px}.sheet-field input,.sheet-field select,.archive-controls select,.delta-tools select{height:40px}.archive-tools>summary,footer summary{padding-block:12px}.depth-row{min-height:28px}.ladder-row{min-height:30px}}@media(max-width:420px){.terminal-header{padding-inline:6px}.header-actions{gap:0}.identity>strong{font-size:10px}.connection{font-size:9px}.ladder-heading,.ladder-row{padding-inline:4px;font-size:9px;grid-template-columns:minmax(0,1fr) minmax(0,.75fr) minmax(69px,1.1fr) minmax(0,.75fr) minmax(0,1fr)}}
@media(prefers-reduced-motion:reduce){.depth-fill,.cum-fill,.delta-bar,.book-mid .mid-price,.terminal-tabs button,.depth-row{transition:none}}
</style>
