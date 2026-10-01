<script lang="ts">
  import {t,canonicalT,locale} from '../../lib/i18n';
  import {onDestroy,untrack} from 'svelte';
  import {createMarketDataClient,type DatasetInfo,type HistoricalFlowAggregate,type DepthHeatmap,type ReplaySnapshot} from '../../lib/flow/persistence-client';
  import {HistoryQueryGate,applyHistoryQuery,aggregateAtCursor,advanceHistoryCursor,historyCursor,visibleHistory,type AppliedHistoryQuery,type HistoryChannel,type HistoryViewMode} from '../../lib/flow/history-view';
  import {sessionDate,sessionRange,datasetRange,initialBalance,tpoStatistics} from '../../lib/flow/studies';
  import FlowCanvas from './FlowCanvas.svelte';
  let {dataset,tickSize,active=true,onBack,getChartRange}:{dataset:DatasetInfo;tickSize:number;active?:boolean;onBack:()=>void;getChartRange?:()=>{from:number;to:number}|undefined}=$props();
  const client=createMarketDataClient();
  let mode=$state<HistoryViewMode>('footprint'),unit=$state<'base'|'quote'>('base');
  let zone=$state('UTC'),sessionDay=$state(''),sessionStart=$state('00:00'),ibMinutes=$state(60),appliedIbMinutes=$state(60),valueArea=$state(70),sessionLabel=$state('自定义 UTC 区间');
  let from=$state(''),to=$state(''),priceTick=$state(.01),step=$state(10),minutes=$state(1),tpoMinutes=$state(30);
  let balance=$state<HistoricalFlowAggregate>(),data=$state<HistoricalFlowAggregate>(),heatmap=$state<DepthHeatmap>(),frame=$state<ReplaySnapshot>(),message=$state('');
  let applied=$state<AppliedHistoryQuery>(),pending=$state({data:false,heatmap:false,frame:false,balance:false});
  let cursor=$state(0),playing=$state(false),speed=$state(1),identity='',seekTimer:ReturnType<typeof setTimeout>|undefined;
  const gate=new HistoryQueryGate();let dataKey='',heatmapKey='',frameKey='',balanceKey='';
  let appliedSessionKey=$state('');
  const sessionDraftChanged=$derived(!!applied&&appliedSessionKey!==JSON.stringify([zone,sessionDay,sessionStart]));
  const inputTime=(time:number)=>new Date(time).toISOString().slice(0,23);
  const parse=(value:string)=>Date.parse(value+'Z');
  const loading=$derived(pending.data||pending.heatmap||pending.frame||pending.balance);
  const waiting=$derived(mode==='book'?pending.frame:mode==='heatmap'?pending.heatmap:pending.data||(mode==='tpo'&&pending.balance));
  const visible=$derived(visibleHistory(applied,cursor,{data,balance,frame,heatmap}));
  const draftChanged=$derived(!!applied&&(parse(from)!==applied.from||parse(to)!==applied.to||priceTick!==applied.tickSize||step!==applied.priceStepTicks||minutes*60_000!==applied.timeframeMs||tpoMinutes*60_000!==applied.tpoBlockMs||ibMinutes!==appliedIbMinutes));
  const tpoStudy=$derived(visible.data?tpoStatistics(visible.data.tpo.rows,valueArea):undefined);
  const balanceStudy=$derived(applied?initialBalance(visible.balance,applied.from,appliedIbMinutes*60_000,cursor):undefined);
  const incompleteRange=$derived.by(()=>{const range=datasetRange(dataset);return !!applied&&(range.from===undefined||range.to===undefined||range.from>applied.from||range.to<cursor);});
  const timeText=(time?:number)=>time?new Date(time).toLocaleString($locale,{hour12:false,timeZone:'UTC'}):'—';
  const fmt=(value:number|undefined,d=5)=>Number.isFinite(value)?value!.toLocaleString($locale,{maximumFractionDigits:d}):'—';
  $effect(()=>{if(dataset.id!==identity){identity=dataset.id;untrack(()=>{const start=dataset.fromTime??dataset.createdAt,end=dataset.throughTime??start+60_000;from=inputTime(Math.floor(start/1000)*1000);to=inputTime(Math.ceil(Math.min(end,start+3600_000)/1000)*1000+1000);priceTick=tickSize>0?tickSize:.01;sessionDay=sessionDate(start,zone);sessionLabel='自定义 UTC 区间';mode=dataset.depthCount&&!dataset.tradeCount?'heatmap':'footprint';load();});}});
  $effect(()=>{const enabled=active;untrack(()=>{if(!enabled){playing=false;cancelQueries();}else ensureMode();});});
  $effect(()=>{
    if(!playing||!active||!applied)return;let previous=performance.now();
    const timer=setInterval(()=>{
      if(waiting)return;const now=performance.now(),elapsed=now-previous;previous=now;
      if(!applied||cursor>=applied.to){playing=false;return;}
      moveCursor(advanceHistoryCursor(cursor,elapsed,speed,applied.to));ensureMode();
      if(cursor>=applied.to)playing=false;
    },250);return ()=>clearInterval(timer);
  });
  onDestroy(()=>cancelQueries());
  function cancelQueries(){gate.cancel();pending={data:false,heatmap:false,frame:false,balance:false};clearTimeout(seekTimer);seekTimer=undefined;}
  function load(label?:string){
    let query:AppliedHistoryQuery;
    try{if(!Number.isInteger(ibMinutes)||ibMinutes<1||ibMinutes>1440)throw Error('初始平衡分钟数应为 1–1440');query=applyHistoryQuery({datasetId:dataset.id,from:parse(from),to:parse(to),tickSize:priceTick,priceStepTicks:step,timeframeMs:minutes*60_000,maxBars:240,tpoBlockMs:tpoMinutes*60_000,sessionOffsetMs:parse(from)});}
    catch(error){message=String(error);return;}
    cancelQueries();playing=false;message='';balance=undefined;data=undefined;heatmap=undefined;frame=undefined;dataKey=heatmapKey=frameKey=balanceKey='';
    applied=query;appliedSessionKey=JSON.stringify([zone,sessionDay,sessionStart]);sessionLabel=label??sessionLabel;appliedIbMinutes=ibMinutes;cursor=query.to;ensureMode(true);
  }
  async function query<T>(channel:HistoryChannel,key:string,read:(signal:AbortSignal)=>Promise<T>,commit:(value:T)=>void){
    const ticket=gate.begin(channel,key);if(!ticket)return;pending={...pending,[channel]:true};
    try{const result=await read(ticket.signal);if(gate.current(ticket))commit(result);}
    catch(error){if(gate.current(ticket))message=String(error);}
    finally{if(gate.current(ticket))pending={...pending,[channel]:false};gate.finish(ticket);}
  }
  function ensureMode(prefetch=false){
    const scope=applied;if(!scope||!active)return;const at=historyCursor(scope,cursor);
    if(prefetch||!['book','heatmap'].includes(mode)){
      const options=aggregateAtCursor(scope,at),key=JSON.stringify([scope.datasetId,options]);
      if(!data||dataKey!==key)void query('data',key,signal=>client.aggregate(scope.datasetId,options,signal),value=>{data=value;dataKey=key;});
    }
    if(mode==='tpo'){
      const options={...aggregateAtCursor(scope,Math.min(at,scope.from+appliedIbMinutes*60_000-1)),timeframeMs:appliedIbMinutes*60_000,maxBars:1},key=JSON.stringify([scope.datasetId,options]);
      if(!balance||balanceKey!==key)void query('balance',key,signal=>client.aggregate(scope.datasetId,options,signal),value=>{balance=value;balanceKey=key;});
    }
    if(dataset.depthCount&&(prefetch||mode==='book')){
      const key=`${scope.datasetId}:${at}`;
      if(!frame||frameKey!==key)void query('frame',key,signal=>client.replay(scope.datasetId,at,200,signal),value=>{frame=value;frameKey=key;});
    }
    if(dataset.depthCount&&(prefetch||mode==='heatmap')){
      const key=`${scope.datasetId}:${scope.from}:${scope.to}`;
      if(!heatmap||heatmapKey!==key)void query('heatmap',key,signal=>client.heatmap(scope.datasetId,{from:scope.from,to:scope.to,samples:80,levels:40},signal),value=>{heatmap=value;heatmapKey=key;});
    }
  }
  function moveCursor(value:number){
    if(!applied)return;cursor=historyCursor(applied,value);gate.cancel('data','frame','balance');pending={...pending,data:false,frame:false,balance:false};clearTimeout(seekTimer);seekTimer=undefined;
    if(balance&&balance.toTime>cursor){balance=undefined;balanceKey='';}if(data&&data.toTime>cursor){data=undefined;dataKey='';}if(frame&&frame.at>cursor){frame=undefined;frameKey='';}
  }
  function scrub(value:number){playing=false;message='';moveCursor(value);seekTimer=setTimeout(()=>{seekTimer=undefined;ensureMode();},120);}
  function changeMode(value:HistoryViewMode){mode=value;message='';clearTimeout(seekTimer);seekTimer=undefined;ensureMode();}
  function togglePlayback(){if(!applied)return;if(playing){playing=false;return;}if(cursor>=applied.to){moveCursor(applied.from);ensureMode();}playing=true;}
  function applySession(){try{const [hours,mins]=sessionStart.split(':').map(Number),range=sessionRange(sessionDay,zone,hours*60+mins);from=inputTime(range.from);to=inputTime(range.to);load(`${sessionDay} · ${zone} ${sessionStart} 开盘`);}catch(error){message=String(error);}}
  function useChartRange(){const range=getChartRange?.();if(!range||!Number.isFinite(range.from)||!Number.isFinite(range.to)||range.to<=range.from){message='图表可见区间尚不可用';return;}from=inputTime(range.from);to=inputTime(range.to);load('图表可见区间');}
  function download(){
    if(!applied||!visible.data&&!visible.frame&&!visible.heatmap)return;
    const output={datasetId:dataset.id,cursor,applied,mode,unit,sessionLabel,tpoStudy,balanceStudy,...visible};
    const url=URL.createObjectURL(new Blob([JSON.stringify(output,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`${dataset.symbol}-history-${cursor}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
</script>
<section class="history-flow" aria-label={$t("历史成交与深度回放")}>
  <header><button onclick={onBack}>{$t("‹ 数据集")}</button><strong>{dataset.symbol} {$t("· 历史")}</strong></header>
  <div class="history-body"><aside class="history-settings">
  <details><summary>{$t("区间与聚合设置")}</summary><div class="fields"><label>{$t("会话日期")}<input type="date" bind:value={sessionDay}/></label><label>{$t("会话时区")}<select bind:value={zone}>{#each ['UTC','Asia/Shanghai','Asia/Kolkata','America/New_York','Europe/London'] as name}<option value={name}>{name}</option>{/each}</select></label><label>{$t("当地开盘")}<input type="time" bind:value={sessionStart}/></label><label>{$t("初始平衡分钟")}<input type="number" bind:value={ibMinutes} min="1" max="1440"/></label></div>{#if sessionDraftChanged}<p class="warning">{$t("会话选择已修改，点击「应用日会话」后生效。")}</p>{/if}<div class="range-actions"><button onclick={applySession} title={$t("按所选时区的当地开盘生成完整日会话，夏令时按当地日历计算")}>{$t("应用日会话")}</button>{#if getChartRange}<button onclick={useChartRange} title={$t("使用当前图表可见时间范围查询所选数据集")}>{$t("图表可见区间")}</button>{/if}</div><div class="fields"><label>{$t("开始 UTC")}<input type="datetime-local" step=".001" bind:value={from}/></label><label>{$t("结束 UTC")}<input type="datetime-local" step=".001" bind:value={to}/></label><label>{$t("每tick价格")}<input type="number" bind:value={priceTick} min=".00000001" step=".01"/></label><label>{$t("每价格档 ticks")}<input type="number" bind:value={step} min="1" max="100000"/></label><label>{$t("Footprint 时间块")}<select bind:value={minutes}>{#each [1,5,15,30,60,240] as value}<option value={value}>{value}m</option>{/each}</select></label><label>{$t("TPO 时间块")}<select bind:value={tpoMinutes}>{#each [5,15,30,60] as value}<option value={value}>{value}m</option>{/each}</select></label></div><button onclick={()=>load('自定义 UTC 区间')}>{$t("应用区间")}</button>{#if loading}<button onclick={()=>{cancelQueries();playing=false;}}>{$t("取消查询")}</button>{/if}{#if draftChanged}<p class="warning">{$t("输入已修改，点击「应用区间」后生效。")}</p>{/if}<p>{$t("历史tick由此处明确指定，不宣称当前合约规则就是过去的价格精度。整窗成交量在本地服务聚合，前端只取有界绘制数据。")}</p></details>

  <div class="coverage"><p>{$canonicalT((sessionLabel)??'')} {$t("· TPO 从已应用起点对齐")}</p><span>{timeText(applied?.from)} — {timeText(visible.data?.toTime??cursor)} UTC</span>{#if loading}<b role="status">{$t("计算中…")}</b>{/if}{#if visible.data}<p>{$t("截至游标")} {visible.data.snapshot.coverage.retainedTrades.toLocaleString($locale)} {$t("条成交 ·")} {visible.data.snapshot.coverage.gapCount} {$t("处已记录缺口")}</p>{#if visible.data.footprintTruncated}<p>{$t("Footprint 显示最近")} {visible.data.returnedBars}/{visible.data.totalBars} {$t("个时间块；成交分布覆盖已应用起点至当前游标。")}</p>{/if}{/if}{#if dataset.kind==='recording'&&visible.data&&(!visible.data.tradeCoverage?.complete||(visible.data.tradeCoverage.availableAt??Infinity)>cursor)}<p class="warning">{$t("成交覆盖尚无完整区间证明，仅统计已保存的成交；盘口覆盖不替代成交覆盖。")}</p>{/if}{#if incompleteRange}<p class="warning">{$t("所选区间未被该数据集完整覆盖，仅统计已有成交；不足部分不补零。")}</p>{/if}{#if message}<p class="warning" role="status">{$canonicalT(message)}</p>{/if}</div>
  </aside><div class="history-display">
  <nav aria-label={$t("历史数据视图")}>{#each [{id:'footprint',label:'足迹'},{id:'profile',label:'分布'},{id:'tpo',label:'TPO'},{id:'heatmap',label:'热图'},{id:'book',label:'盘口'}] as view}<button class:current={mode===view.id} aria-pressed={mode===view.id} onclick={()=>changeMode(view.id as HistoryViewMode)}>{$canonicalT((view.label)??'')}</button>{/each}<select aria-label={$t("历史统计单位")} bind:value={unit}><option value="base">{$t("基础量")}</option><option value="quote">USDT</option></select></nav>
  {#if mode==='tpo'}<div class="study-config"><label>{$t("价值区 %")}<input type="number" min="1" max="100" bind:value={valueArea}/></label><span>{$t("IB 前")} {appliedIbMinutes}{$t("m · 单印为内部仅一块访问；不包含两端尾部。")}</span></div>{/if}
  <div class="visual">
  {#if (mode==='book'||mode==='heatmap')&&!dataset.depthCount}<p class="empty">{$t("该数据集只有成交，没有历史深度。后台录制的真实快照与连续增量到位后才能查看盘口或热图。")}</p>
  {:else if mode==='book'}
    <p class="caption">{timeText(visible.frame?.at)} UTC · {visible.frame?{available:$t("已连续重建"),gap:$t("断档"),unavailable:$t("尚无记录"),truncated:$t("达到重放上限")}[visible.frame.book.status]:$t("等待寻址")} {$canonicalT((visible.frame?.book.warning??'')??'')}</p>
    <div class="table-scroll"><table><thead><tr><th>{$t("买量")}</th><th>{$t("买价")}</th><th>{$t("卖价")}</th><th>{$t("卖量")}</th></tr></thead><tbody>{#each visible.frame?.book.bids.slice(0,40)??[] as bid,i}<tr><td>{fmt(bid.quantity)}</td><td>{fmt(bid.price,10)}</td><td>{fmt(visible.frame?.book.asks[i]?.price,10)}</td><td>{fmt(visible.frame?.book.asks[i]?.quantity)}</td></tr>{:else}<tr><td colspan="4">{$t("该时点尚无可连续重建的订单簿")}</td></tr>{/each}</tbody></table></div>
  {:else}<FlowCanvas data={visible.data?.snapshot} {unit} {mode} heatmap={visible.heatmap} tpo={visible.data?.tpo} tpoStudy={tpoStudy} balance={balanceStudy}/>{/if}
  </div>
  <div class="replay"><span>{timeText(cursor)} UTC</span><input type="range" aria-label={$t("成交与深度回放时间")} min={applied?.from??0} max={applied?.to??1} step="1000" value={cursor} disabled={!applied} oninput={event=>scrub(event.currentTarget.valueAsNumber)}/><div class="buttons"><button disabled={!applied||waiting&&!playing} onclick={togglePlayback}>{playing?$t("暂停"):$t("播放")}</button><select aria-label={$t("历史播放速度")} bind:value={speed}>{#each [1,5,30,60,300] as value}<option value={value}>{value}×</option>{/each}</select><button disabled={!applied} onclick={()=>{if(applied){playing=false;moveCursor(applied.to);ensureMode();}}}>{$t("区间末端")}</button><button disabled={!visible.data&&!visible.frame&&!visible.heatmap} onclick={download} title={$t("导出截至当前游标的数据，不包含未来缓存")}>{$t("导出结果")}</button></div></div>
  </div></div>
</section>
<style>.history-body{display:flex;flex-direction:column;flex:1;min-height:0;overflow-y:auto}.history-settings{flex-shrink:0;min-width:0}.history-display{display:flex;flex-direction:column;flex:1;min-height:370px;min-width:0}.visual{display:flex;flex-direction:column;flex:1;min-height:260px;min-width:0}.history-flow{width:100%;overflow-y:auto;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--bg-panel);color:var(--text);font-size:11px}header,nav,.coverage,.study-config{flex-shrink:0}header{display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--line-strong)}.range-actions{display:flex;gap:5px}.study-config{display:flex;align-items:center;gap:10px;padding:5px 10px;border-bottom:1px solid var(--line-strong);font-size:10px;color:var(--text-dim)}.study-config label{flex-direction:row;align-items:center}.study-config input{width:46px}header strong{font-size:11px;font-weight:500;flex:1}button,select,input{border:1px solid var(--line-strong);border-radius:1px;background:var(--bg-hover);color:var(--accent-strong);padding:4px 6px;font-size:10px;min-width:0}button:hover{background:var(--bg-active)}button:disabled{opacity:.4}details{padding:8px 10px;border-bottom:1px solid var(--line-strong);flex-shrink:0}summary{cursor:pointer;font-size:10px;line-height:1.6}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:8px 0}.fields label{min-width:0}.fields label:has(input[type=datetime-local]){grid-column:1/-1}label{display:flex;flex-direction:column;gap:4px;color:var(--text-dim);font-size:10px}p{font-size:10px;color:var(--text-dim);line-height:1.7;margin:6px 0}nav{display:flex;gap:3px;padding:5px 7px;border-bottom:1px solid var(--line-strong)}nav button{border:0;border-bottom:2px solid transparent;flex:1}.current{border-bottom-color:var(--accent)!important;background:var(--bg-active)}nav select{width:60px}.coverage{padding:7px 10px;border-bottom:1px solid var(--line-strong);font-size:10px;line-height:1.5}.coverage b{margin-left:5px;color:var(--warn);font-weight:400}.warning{color:var(--warn)}.replay{border-top:1px solid var(--line-strong);padding:8px 10px;flex-shrink:0}.replay>span{display:block;font:10px var(--mono);margin-bottom:6px}.replay>input{width:100%;accent-color:var(--accent)}.buttons{display:flex;align-items:center;gap:5px;padding-top:6px}.buttons button:last-child{margin-left:auto}.empty{padding:30px 20px;line-height:1.9;flex:1}.caption{padding:6px 10px}.table-scroll{overflow:auto;min-height:100px;flex:1}table{border-collapse:collapse;width:100%;font:10px var(--mono)}th,td{padding:7px 5px;text-align:right;border-bottom:1px solid var(--line)}thead{position:sticky;top:0;background:var(--bg-hover)}button:focus-visible,input:focus-visible,select:focus-visible{outline:1px solid var(--accent);outline-offset:1px}@container(min-width:700px){.history-body{display:grid;grid-template-columns:250px minmax(0,1fr);overflow:hidden}.history-settings{overflow:auto;border-right:1px solid var(--line-strong)}.history-display{min-height:0;overflow:hidden}.visual{min-height:80px;overflow:hidden}.visual :global(.flow-canvas){height:100%;min-height:0}.visual :global(.surface){min-height:70px}.visual :global(output){min-height:16px;padding:4px 9px}.visual :global(.flow-canvas p){padding-bottom:3px;line-height:1.4}.replay{padding-block:4px}.replay>span{margin-bottom:1px}.buttons{padding-top:1px}}
</style>
