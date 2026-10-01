<script lang="ts">
  import {onDestroy} from 'svelte';
  import {t,canonicalT,locale} from '../../lib/i18n';
  import type {WorkspacePanelProps} from '../layout/panel-context';
  import {createTradeFlowSession,type TradeFlowSession} from '../../lib/flow/session';
  import type {TradeFlowSessionSnapshot,FlowPriceLevel} from '../../lib/flow/types';
  import {volumeValueArea} from '../../lib/flow/value-area';
  import {PanelOrderBookSubscription} from '../../lib/flow/panel-orderbook';
  import type {SharedBookSnapshot} from '../../lib/flow/orderbook-hub';
  import {aggregateOrderBook} from '../../lib/flow/orderbook-models';
  import type {DatasetInfo} from '../../lib/flow/persistence-client';
  import MarketDataManager from './MarketDataManager.svelte';
  import HistoricalFlowViewer from './HistoricalFlowViewer.svelte';
  import FlowCanvas from './FlowCanvas.svelte';
  let {context,active=true,zone}:WorkspacePanelProps=$props();
  let sourceView=$state<'live'|'data'|'history'>('live'),historical=$state<DatasetInfo>(),canvasView=$state(true);
  let mode=$state<'profile'|'footprint'|'tpo'|'book'>('profile'),unit=$state<'base'|'quote'>('base'),step=$state(10),minutes=$state(1),running=$state(true),selectedTime=$state(0);
  let snapshot=$state<TradeFlowSessionSnapshot>(),book=$state.raw<SharedBookSnapshot>(),session=$state<TradeFlowSession>(),error=$state('');
  const symbol=$derived(context.chartState.symbol),source=$derived(context.chartState.source),marketType=$derived(context.chartState.marketType),contract=$derived(context.chartState.contract),tickSize=$derived(contract?.tickSize??0),asset=$derived(contract?.baseAsset??symbol.replace(/USDT$/,'')),quote=$derived(contract?.quoteCurrency??'USDT');
  const supported=$derived(source==='binance'&&marketType==='usdm-perpetual');
  const bookSubscription=new PanelOrderBookSubscription(next=>book=next);
  onDestroy(()=>bookSubscription.destroy());
  $effect(()=>{
    if(!supported||tickSize<=0){session=undefined;snapshot=undefined;return;}
    error='';snapshot=undefined;
    const value=createTradeFlowSession({symbol,tickSize,timeframeMs:60_000,priceStepTicks:10,maxTrades:100_000,maxAgeMs:3600_000,maxPriceLevels:250,maxFootprintBars:120,onUpdate:next=>snapshot=next});
    session=value;snapshot=value.snapshot();return ()=>value.disconnect();
  });
  $effect(()=>{const value=session;if(!value)return;if(active&&running&&mode!=='book'&&sourceView==='live'&&!context.chartState.historicalSnapshot&&!context.chartState.paused)value.connect();else value.disconnect();return ()=>value.disconnect();});
  $effect(()=>{if(session&&mode!=='book')session.setAggregation({timeframeMs:minutes*60_000,priceStepTicks:step});});
  $effect(()=>{
    bookSubscription.update({source,marketType,symbol,tickSize,active,running,view:mode,sourceView,historical:!!context.chartState.historicalSnapshot,chartPaused:context.chartState.paused});
  });
  $effect(()=>{if(historical&&historical.symbol!==symbol){historical=undefined;sourceView='live';}});
  const amount=(row:FlowPriceLevel,key:'buy'|'sell'|'delta'|'volume')=>row[`${key}${unit==='base'?'Base':'Quote'}` as 'buyBase'];
  const rows=$derived([...(snapshot?.profile??[])].sort((a,b)=>b.price-a.price));
  const maxVolume=$derived(Math.max(1,...rows.map(row=>amount(row,'volume'))));
  const valueArea=$derived(volumeValueArea(rows,unit));
  const bar=$derived(snapshot?.footprint.find(bar=>bar.time===selectedTime)??snapshot?.footprint.at(-1));
  const footprint=$derived([...(bar?.levels??[])].sort((a,b)=>b.price-a.price));
  const tpo=$derived(rows.map(row=>({row,blocks:(snapshot?.footprint??[]).flatMap((bar,i)=>bar.levels.some(level=>level.tick===row.tick)?[{time:bar.time,text:String.fromCharCode(65+i%26),partial:bar.partial}]:[])})));
  const fmt=(n:number|undefined,max=4)=>Number.isFinite(n)?n!.toLocaleString($locale,{maximumFractionDigits:max}):'—';
  const date=(t?:number)=>t?new Date(t).toLocaleTimeString($locale,{hour12:false,timeZone:'UTC'}):'—';
  const price=(n:number)=>fmt(n,10);
  const connectionStatus=$derived(!supported?'unsupported':!running||context.chartState.paused||context.chartState.historicalSnapshot?'paused':mode==='book'?book?.status:snapshot?.status);
  const statusLabels:Record<string,string>={idle:'未连接',connecting:'连接中',loading:'补取最近成交',live:'实时',partial:'覆盖不完整',reconnecting:'重连中',resyncing:'重建订单簿',stopped:'已暂停',paused:'盘口已暂停',stale:'行情已过期，正在恢复',unsupported:'此市场暂不支持盘口',error:'连接错误'};
  const bookModel=$derived(book&&tickSize>0?aggregateOrderBook(book,{priceStep:tickSize*step,limit:30,unit}):undefined);
  const bookRows=$derived(Array.from({length:Math.max(bookModel?.bids.length??0,bookModel?.asks.length??0)},(_,index)=>({bid:bookModel?.bids[index],ask:bookModel?.asks[index]})));
  function add(id:string){try{context.controller.addIndicator(id);}catch(reason){error=String(reason);}}
  function exportSnapshot(){if(!snapshot)return;const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`${symbol}-flow-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
</script>
<section class="flow-panel" aria-label={$t("实时成交分析")}>
  <div class="data-source"><button class:chosen={sourceView==='live'} onclick={()=>sourceView='live'}>{$t("实时")}</button><button class:chosen={sourceView!=='live'} onclick={()=>sourceView='data'}>{$t("历史与录制")}</button>{#if context.onExpandAnalysis}<button class="expand" onclick={context.onExpandAnalysis} title={$t("调整分析工作区停靠位置，图表保持原实例")}>{zone==='bottom'?$t("靠右"):$t("宽屏")}</button>{/if}</div>
  {#if sourceView==='data'}<div class="embedded"><MarketDataManager {symbol} {active} onSelect={dataset=>{historical=dataset;sourceView='history';}}/></div>
  {:else if sourceView==='history'&&historical}<div class="embedded"><HistoricalFlowViewer dataset={historical} {tickSize} {active} getChartRange={()=>context.controller.getVisibleAnalysisTimeRange()} onBack={()=>sourceView='data'}/></div>
  {:else}
  <header><strong>{symbol}</strong><span title={$t("只订阅公开行情，不访问账户")}>{$canonicalT(statusLabels[connectionStatus??'idle']??'')}</span><button onclick={()=>running=!running} title={running?$t("暂停成交流与盘口订阅"):$t("继续公开行情订阅")}>{running?$t("暂停"):$t("继续")}</button>{#if mode==='book'&&running&&supported&&(book?.status==='stale'||book?.status==='error')}<button onclick={()=>void bookSubscription.reconnect()} title={$t("重新连接行情")}>{$t("重连")}</button>{/if}</header>
  <div class="tabs" role="group" aria-label={$t("成交分析视图")}>{#each [{id:'profile',label:'分布'},{id:'footprint',label:'Footprint'},{id:'tpo',label:'TPO'},{id:'book',label:'盘口'}] as tab}<button aria-pressed={mode===tab.id} class:current={mode===tab.id} onclick={()=>mode=tab.id as typeof mode}>{$canonicalT((tab.label)??'')}</button>{/each}</div>
  {#if context.chartState.historicalSnapshot}<p class="empty">{$t("主图处于历史回放，实时成交流已暂停。请选择“历史与录制”中的相应数据，或返回最新行情。")}</p>
  {:else if !supported}<p class="empty">{$t("当前支持 Binance USDT 永续公开深度")}</p>
  {:else if !tickSize}<p class="empty">{$t("正在等待合约最小价格跳动，获取后再建立精确价位桶。")}</p>
  {:else}
    {#if error}<p class="warning" role="status">{$canonicalT(error)}</p>{/if}
    {#if mode!=='book'}
      <div class="settings"><label>{$t("单位")}<select bind:value={unit}><option value="base">{asset}</option><option value="quote">USDT</option></select></label><label>{$t("每档 ticks")}<select bind:value={step}>{#each [1,5,10,25,50,100,500,1000] as value}<option value={value}>{value}</option>{/each}</select></label><label>{$t("时间块")}<select bind:value={minutes}>{#each [1,5,15,30,60] as value}<option value={value}>{value}m</option>{/each}</select></label></div>
      <div class="coverage"><span>{date(snapshot?.coverage.fromTime)} — {date(snapshot?.coverage.throughTime)} UTC</span><span>{snapshot?.coverage.retainedTrades??0} {$t("条聚合成交")}</span><p>{$canonicalT((snapshot?.message??$t("正在连接公开成交流…"))??'')}</p>{#if snapshot?.coverage.gapCount}<p class="warning">{$t("发现")} {snapshot.coverage.gapCount} {$t("处 ID 缺口，统计与累计覆盖不完整。")}</p>{/if}<small>{$t("仅本次保留的公开成交；不是整段图表历史。每档实际")} {price(snapshot?.effectivePriceStep??tickSize*step)}{$locale==='zh-CN'?"。":"."}</small></div>
      <div class="view-switch"><button aria-pressed={canvasView} onclick={()=>canvasView=true}>{$t("画布")}</button><button aria-pressed={!canvasView} onclick={()=>canvasView=false}>{$t("表格")}</button></div>
      {#if canvasView}<FlowCanvas data={snapshot} {unit} mode={mode}/>
      {:else if mode==='profile'}
        <div class="metrics"><span>{$t("主动买")} <b>{fmt(snapshot?.coverage.retainedTrades?(unit==='base'?snapshot.totals.buyBase:snapshot.totals.buyQuote):undefined)}</b></span><span>{$t("主动卖")} <b>{fmt(snapshot?.coverage.retainedTrades?(unit==='base'?snapshot.totals.sellBase:snapshot.totals.sellQuote):undefined)}</b></span><span>{$t("净量")} <b>{fmt(snapshot?.coverage.retainedTrades?(unit==='base'?snapshot.totals.deltaBase:snapshot.totals.deltaQuote):undefined)}</b></span></div>
        {#if valueArea}<p class="caption" title={$t("仅当前保留成交的连续70%价值区；按相邻价格桶扩展")}>POC {price(valueArea.poc)} · VA {price(valueArea.low)} — {price(valueArea.high)}</p>{/if}
        <div class="table-scroll"><table><thead><tr><th>{$t("价格桶")}</th><th>{$t("成交分布")}</th><th>{$t("数量 /")} {unit==='base'?asset:'USDT'}</th></tr></thead><tbody>{#each rows as row (row.tick)}<tr class:poc={valueArea?.poc===row.price}><th title={`${price(row.price)} — ${price(row.priceEnd)}${valueArea?.poc===row.price?$t(" · 本覆盖窗口 POC"):''}`}>{price(row.price)}</th><td><span class="profile-bar" style:width={`${Math.max(.5,amount(row,'volume')/maxVolume*100)}%`}><i style:width={`${amount(row,'buy')/Math.max(Number.EPSILON,amount(row,'volume'))*100}%`}></i></span></td><td>{fmt(amount(row,'volume'))}</td></tr>{:else}<tr><td colspan="3">{$t("等待公开成交…")}</td></tr>{/each}</tbody></table></div>
      {:else if mode==='footprint'}
        <label class="bar-picker">{$t("查看时间块")}<select bind:value={selectedTime}><option value={0}>{$t("最新时间块")}</option>{#each snapshot?.footprint??[] as item}<option value={item.time}>{date(item.time)}{item.partial?$t(" · 部分"):''}</option>{/each}</select></label>
        <p class="caption">{date(bar?.time)} UTC · {bar?.partial?$t("部分覆盖"):$t("当前保留范围")} · {unit==='base'?asset:'USDT'}</p>
        <div class="table-scroll"><table><thead><tr><th>{$t("主动卖")}</th><th>{$t("价格桶")}</th><th>{$t("主动买")}</th><th>{$t("净量")}</th></tr></thead><tbody>{#each footprint as row (row.tick)}<tr><td class="sell">{fmt(amount(row,'sell'))}</td><th title={`${price(row.price)} — ${price(row.priceEnd)}`}>{price(row.price)}</th><td class="buy">{fmt(amount(row,'buy'))}</td><td class:buy={amount(row,'delta')>=0} class:sell={amount(row,'delta')<0}>{fmt(amount(row,'delta'))}</td></tr>{:else}<tr><td colspan="4">{$t("等待该时间块的逐价成交。")}</td></tr>{/each}</tbody></table></div>
      {:else}
        <p class="caption">{$t("按")} {minutes} {$t("分钟块统计已观察到的价格访问。字母表示时间块，不表示成交量；部分覆盖以虚线标记。")}</p>
        <div class="table-scroll"><table><thead><tr><th>{$t("价格桶")}</th><th>{$t("已观察到的时间块")}</th><th>{$t("次数")}</th></tr></thead><tbody>{#each tpo as item (item.row.tick)}<tr><th>{price(item.row.price)}</th><td class="letters">{#each item.blocks as block}<span class:partial={block.partial} title={`${date(block.time)} UTC${block.partial?$t(" · 部分覆盖"):''}`}>{block.text}</span>{/each}</td><td>{item.blocks.length}</td></tr>{/each}</tbody></table></div>
      {/if}
      <div class="actions"><button onclick={()=>add('flow-delta')} title={$t("在主图工作区增加独立 Delta 子窗格")}>{$t("添加 Delta")}</button><button onclick={()=>add('flow-cvd')} title={$t("在主图工作区增加独立 CVD 子窗格")}>{$t("添加 CVD")}</button><button disabled={!snapshot?.coverage.retainedTrades} onclick={exportSnapshot} title={$t("导出当前聚合结果与覆盖元数据")}>{$t("导出")}</button></div>
    {:else}
      <div class="settings"><label>{$t("数量口径")}<select bind:value={unit}><option value="base">{asset}</option><option value="quote">{quote}</option></select></label><label>{$t("每档 ticks")}<select bind:value={step}>{#each [1,5,10,25,50,100,500,1000] as value}<option value={value}>{value}</option>{/each}</select></label></div>
      <p class="coverage">{$canonicalT((book?.warning??$t("L2 聚合档位；不是单订单、隐藏流动性或历史热图。"))??'')}<small>{$t("序号")} {book?.lastUpdateId??'—'} · {date(book?.updatedAt)} UTC</small></p>
      <div class="table-scroll"><table><thead><tr><th>{$t("买量 /")} {unit==='quote'?quote:asset}</th><th>{$t("买价")}</th><th>{$t("卖价")}</th><th>{$t("卖量 /")} {unit==='quote'?quote:asset}</th></tr></thead><tbody>{#each bookRows as row}<tr><td class="buy">{fmt(row.bid?.quantity,8)}</td><th class="buy">{row.bid?price(row.bid.price):'—'}</th><th class="sell">{row.ask?price(row.ask.price):'—'}</th><td class="sell">{fmt(row.ask?.quantity,8)}</td></tr>{:else}<tr><td colspan="4">{$canonicalT(statusLabels[connectionStatus??'idle']??'等待盘口快照')}</td></tr>{/each}</tbody></table></div>
    {/if}
  {/if}
  <footer>{$t("Binance USDⓈ-M · 仅行情 ·")} {mode==='book'?$t("盘口聚合 L2"):$t("成交先统计，再合并界面刷新")}</footer>
  {/if}
</section>
<style>
  .data-source{display:flex;gap:5px;padding:6px 8px;border-bottom:1px solid var(--line-strong);flex-shrink:0}.data-source button{border:0;border-bottom:2px solid transparent}.data-source .chosen{border-bottom-color:var(--accent);background:var(--bg-active)}.data-source .expand{margin-left:auto}.embedded{flex:1;min-height:0;overflow:hidden}.view-switch{display:flex;gap:4px;padding:3px 9px}.view-switch button{padding:3px 7px;border:0}.view-switch button[aria-pressed=true]{background:var(--bg-active);color:var(--text-strong)}
  .flow-panel{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--bg-panel);color:var(--text);font-size:11px}header{display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid var(--line)}header strong{font:11px var(--mono);flex:1}header span{font-size:10px;color:var(--text-dim)}button{border:1px solid var(--line-strong);padding:4px 7px;font-size:10px;color:var(--text);border-radius:1px}button:hover{background:var(--bg-active)}button:disabled{opacity:.4;cursor:default}.tabs{display:flex;border-bottom:1px solid var(--line);padding:0 8px;gap:3px}.tabs button{flex:1;padding:9px 3px;border:0;border-bottom:2px solid transparent}.tabs button.current{border-bottom-color:var(--accent);background:var(--bg-hover)}.settings{padding:9px;display:flex;gap:7px}.settings label{display:flex;flex:1;min-width:0;flex-direction:column;gap:5px;font-size:10px;color:var(--text-dim)}select{height:25px;background:var(--bg-panel);border:1px solid var(--line-strong);border-radius:1px;color:var(--text);font:10px var(--font);min-width:0;padding:2px 4px}.coverage{margin:0;padding:9px 10px;border-bottom:1px solid var(--line);line-height:1.7;color:var(--text-dim);font-size:10px}.coverage>span+span{float:right}.coverage p{margin:5px 0}.coverage small{display:block;font-size:10px;color:var(--text-dim)}.metrics{padding:8px 10px;display:flex;gap:12px;flex-wrap:wrap;font-size:10px}.metrics b{font:10px var(--mono);color:var(--text);margin-left:4px}.table-scroll{flex:1;min-height:80px;overflow:auto}table{border-collapse:collapse;width:100%;table-layout:auto;font:10px var(--mono);font-variant-numeric:tabular-nums}thead{position:sticky;top:0;background:var(--bg-hover);z-index:1}th,td{padding:6px 7px;border-bottom:1px solid var(--line);white-space:nowrap;text-align:right;font-weight:400}thead th{font:10px var(--font);color:var(--text-dim)}td:nth-child(2){min-width:62px}.profile-bar{height:10px;display:flex;background:var(--bg-active);max-width:100%;min-width:1px}.profile-bar i{height:100%;display:block;background:var(--up)}.poc{background:var(--bg-hover)}.buy{color:var(--up)}.sell{color:var(--down)}.caption{margin:0;padding:7px 10px;color:var(--text-dim);line-height:1.7;font-size:10px}.bar-picker{display:flex;gap:10px;padding:6px 10px;align-items:center}.bar-picker select{flex:1}.letters{white-space:normal;text-align:left}.letters span{display:inline-block;color:var(--accent-strong);padding:1px 3px;margin:1px;background:var(--bg-active)}.letters span.partial{border-bottom:1px dashed var(--warn)}.actions{display:flex;gap:6px;padding:8px 10px;border-top:1px solid var(--line)}.actions button:last-child{margin-left:auto}footer{padding:7px 10px;border-top:1px solid var(--line);color:var(--text-dim);font-size:10px}.empty{padding:25px 15px;line-height:1.9;color:var(--text-dim)}.warning{color:var(--warn);padding:6px 10px;font-size:10px;line-height:1.7}button:focus-visible,select:focus-visible{outline:1px solid var(--accent);outline-offset:1px}
</style>
