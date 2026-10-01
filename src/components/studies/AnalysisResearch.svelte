<script lang="ts">
  import {t,canonicalT,locale} from '../../lib/i18n';
  import {onDestroy,untrack} from 'svelte';
  import type {WorkspacePanelProps} from '../layout/panel-context';
  import type {DatasetSnapshot} from '../../lib/history/types';
  import type {ParamValues} from '../../lib/core/types';
  import {createAnalysisValidationJob} from '../../lib/analysis/validation-client';
  import type {ValidationProgress,ValidationReport} from '../../lib/analysis/validation';
  let {context,active=true}:WorkspacePanelProps=$props();
  let page=$state<'replay'|'validate'|'reviews'|'anchors'>('replay'),revision=$state(0),message=$state('');
  let replay=$state<DatasetSnapshot>(),cursor=$state(0),playing=$state(false),speed=$state(1),bars=$state(5000);
  let selectedIds=$state<string[]>([]),report=$state<ValidationReport>(),progress=$state<ValidationProgress>(),running=$state(false);
  let fee=$state(5),slippage=$state(1),stopAtr=$state(1.5),takeAtr=$state(2),holdBars=$state(24),holdout=$state(256),capital=$state(10000),notional=$state(1000),includeFunding=$state(false);
  let cancelJob:undefined|(()=>void);
  let drawingId=$state(''),priceUnit=$state(1),timeUnitBars=$state(1),absoluteTimeMinutes=$state(0);
  const modules=$derived(context.controller.registry.list().filter(d=>d.category==='pattern'||d.category==='analysis'));
  const reviews=$derived.by(()=>{context.chartState;revision;return context.controller.listAnalysisReviews();});
  const drawings=$derived.by(()=>{context.chartState;revision;return context.controller.drawing.document.drawings.filter(d=>d.paneId==='main'&&d.points.length>0);});
  const replayState=$derived.by(()=>{context.chartState;return context.controller.getAnalysisReplayState();});
  const fmt=(n:number|null|undefined,digits=2)=>n===null||n===undefined||!Number.isFinite(n)?'—':n.toLocaleString($locale,{maximumFractionDigits:digits});
  const date=(time?:number|null)=>time?new Date(time).toLocaleString($locale,{hour12:false,timeZone:'UTC'}):'—';
  const conclusion:Record<string,string>={disabled:'未运行研究交易','no-signals':'没有可用的方向事件','insufficient-sample':'样本不足，不能认定优势','non-positive-sample':'本后段未取得正结果','positive-sample-only':'仅本样本为正，尚不能推广'};
  $effect(()=>context.controller.drawing.subscribe(()=>untrack(()=>revision++)));
  $effect(()=>{if(!active||!replayState.active)playing=false;});
  $effect(()=>{if(!playing||!active)return;const timer=setInterval(()=>{if(context.chartState.indicatorsPending)return;if(!replay||cursor>=replay.bars.length){playing=false;return;}cursor++;seek();},Math.max(100,1000/speed));return ()=>clearInterval(timer);});
  onDestroy(()=>{cancelJob?.();});
  function begin(){try{playing=false;replay=context.controller.beginAnalysisReplay(bars);cursor=context.controller.getAnalysisReplayState().cursor;message='已冻结当前闭柱数据；脚本若未按当前游标重算，其未来结果会隐藏。';}catch(error){message=String(error);}}
  function seek(){try{context.controller.seekAnalysisReplay(cursor);}catch(error){playing=false;message=String(error);}}
  function dragSeek(event:Event){playing=false;cursor=(event.currentTarget as HTMLInputElement).valueAsNumber;seek();}
  function step(delta:number){if(!replay)return;playing=false;cursor=Math.max(1,Math.min(replay.bars.length,cursor+delta));seek();}
  function latest(){playing=false;context.controller.followLatest();replay=undefined;cursor=0;message='正在恢复实时行情';}
  function choose(id:string){selectedIds=selectedIds.includes(id)?selectedIds.filter(v=>v!==id):selectedIds.length<8?[...selectedIds,id]:selectedIds;}
  function download(value:unknown,name:string){const url=URL.createObjectURL(new Blob([typeof value==='string'?value:JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function run(){
    if(!selectedIds.length){message='请至少选择一个模块';return;}running=true;message='';report=undefined;progress=undefined;
    const aborter=new AbortController();cancelJob=()=>aborter.abort();
    try{
      const dataset=context.controller.snapshotDataset(bars),studies=selectedIds.map(id=>{const instance=context.controller.drawing.document.indicators.find(i=>i.id===id);return {id,params:instance?structuredClone(instance.params):context.controller.registry.defaults(id),timeframe:instance?.timeframe??'chart'};});
      let funding;
      if(includeFunding&&dataset.source==='binance'){const {fetchValidationFunding}=await import('../../lib/analysis/funding');funding=await fetchValidationFunding(dataset,fetch,aborter.signal);}
      aborter.signal.throwIfAborted();
      const job=createAnalysisValidationJob({dataset,closedLength:dataset.bars.length,studies,prefixProbes:32,maxHoldoutBars:holdout,holdoutFraction:.3,research:{initialCapital:capital,notional,feeBps:fee,slippageBps:slippage,stopAtr,takeAtr,maxHoldBars:holdBars},funding},value=>progress=value);cancelJob=()=>{aborter.abort();job.cancel();};report=await job.promise;
      message='报告已生成；研究结果与形态准确率分开解释。';
    }catch(error){message=error instanceof Error?error.message:String(error);}finally{running=false;cancelJob=undefined;}
  }
  async function importReviews(event:Event){try{const file=(event.currentTarget as HTMLInputElement).files?.[0];if(file){message=context.controller.importAnalysisReviews(await file.text())||'复核记录已合并';revision++;}}catch(error){message=String(error);}}
  function restoreReview(kind:'pattern'|'analysis',instanceId:string,sourceId:string){try{const warning=context.controller.restoreObservation(kind,instanceId,sourceId);revision++;message=warning||'已恢复自动标注';}catch(error){message=String(error);}}
  function useDrawing(kind:'gann'|'pnf'){
    const drawing=drawings.find(d=>d.id===drawingId);if(!drawing?.points.length){message='请明确选择一个手绘对象作为锚点';return;}
    if(kind==='gann'&&(!Number.isFinite(priceUnit)||priceUnit<=0||!Number.isFinite(timeUnitBars)||timeUnitBars<=0||!Number.isFinite(absoluteTimeMinutes)||absoluteTimeMinutes<0)){message='请填写有效的价格和时间单位';return;}
    if(kind==='gann'&&context.chartState.interval==='1M'&&absoluteTimeMinutes===0){message='月线柱长不固定，请明确填写固定时间单位（分钟）';return;}
    if(kind==='pnf'&&new Set(drawing.points.map(p=>p.time)).size<2){message='区间计数需要至少两个不同时间的主图锚点';return;}
    const id=kind==='gann'?'analysis-gann':'analysis-point-figure',existing=context.controller.drawing.document.indicators.find(i=>i.id===id);
    if(existing&&context.controller.layerStatus(existing.instanceId).locked){message='请先解锁该分析图层';return;}
    const instanceId=existing?.instanceId??context.controller.addIndicator(id);if(!instanceId){message=context.controller.drawing.state.error||'未能添加模块';return;}
    const first=drawing.points[0],times=drawing.points.map(p=>p.time);const patch:ParamValues=kind==='gann'?{anchorTime:first.time,anchorPrice:first.value,priceUnit,timeUnitBars,timeUnitMs:absoluteTimeMinutes*60000}:{rangeFrom:Math.min(...times),rangeTo:Math.max(...times),countPrice:first.value,tickSize:context.chartState.contract?.tickSize??0};
    context.controller.drawing.transact(doc=>({...doc,indicators:doc.indicators.map(i=>i.instanceId===instanceId?{...i,params:{...i.params,...patch}}:i)}));message=context.controller.drawing.state.error||'已将选定手绘的明确坐标与当前标尺写入模块参数，可继续在配置中调整。';
  }
</script>
<section class="research-panel" aria-label={$t("分析研究与回放")}>
  <nav aria-label={$t("研究工具")}>{#each [{id:'replay',label:'回放'},{id:'validate',label:'自验收'},{id:'reviews',label:'复核记录'},{id:'anchors',label:'锚点'}] as tab}<button class:current={page===tab.id} aria-pressed={page===tab.id} onclick={()=>page=tab.id as typeof page}>{$canonicalT((tab.label)??'')}</button>{/each}</nav>
  {#if message}<p class="feedback" role="status">{$canonicalT(message)}</p>{/if}
  <div class="body">
  {#if page==='replay'}
    <h3>{$t("逐闭柱历史回放")}</h3><p>{$t("冻结当前已加载数据，只将游标之前的柱交给识别器。区分实际锚点与首次可知时间。")}</p>
    <label>{$t("冻结最大柱数")}<input type="number" bind:value={bars} min="100" max="20000" step="100"/></label>
    <div class="buttons"><button onclick={begin} disabled={context.chartState.loading||running}>{$t("开始 / 重新冻结")}</button><button onclick={latest} disabled={!replayState.active}>{$t("返回实时")}</button></div>
    {#if replay&&replayState.active}
      <div class="replay-date">{date(replay.bars[cursor-1]?.time)} UTC</div>
      <input class="seek" aria-label={$t("历史回放游标")} type="range" min="1" max={replay.bars.length} value={cursor} oninput={dragSeek}/>
      <div class="buttons"><button onclick={()=>step(-1)} disabled={cursor<=1}>{$t("前一柱")}</button><button onclick={()=>playing=!playing} disabled={cursor>=replay.bars.length}>{playing?$t("暂停"):$t("播放")}</button><button onclick={()=>step(1)} disabled={cursor>=replay.bars.length}>{$t("后一柱")}</button><select aria-label={$t("回放速度")} bind:value={speed}>{#each [1,2,4,8] as value}<option value={value}>{value} {$t("柱/秒")}</option>{/each}</select></div>
      <p>{cursor} / {replay.bars.length} {$t("根 ·")} {context.chartState.indicatorsPending?$t("等待识别更新"):$t("当前闭柱已提交")}</p>
    {/if}
    <details><summary>{$t("回放边界")}</summary><p>{$t("当前研究页回放原生分析模块，按游标之前的已收盘 K 线更新结构与证据。点顶部“最新”可恢复实时行情。成交档案与深度回放位于“成交 → 数据”。")}</p></details>
  {:else if page==='validate'}
    <h3>{$t("当前行情自验收")}</h3><p>{$t("因果检查、后段事件响应和单持仓研究分开报告。规则符合度不等于预测准确率。")}</p>
    <details open><summary>{$t("选择模块（最多8个）")}</summary><div class="module-list">{#each modules as module}<label><input type="checkbox" checked={selectedIds.includes(module.id)} onchange={()=>choose(module.id)} disabled={running}/><span>{$canonicalT((module.title??module.name)??'')}</span></label>{/each}</div></details>
    <div class="fields"><label>{$t("数据柱数")}<input type="number" bind:value={bars} min="100" max="20000" step="100"/></label><label>{$t("后段最多柱数")}<input type="number" bind:value={holdout} min="32" max="2048" step="32"/></label><label>{$t("实验资金 USDT")}<input type="number" bind:value={capital} min="1"/></label><label>{$t("固定名义 USDT")}<input type="number" bind:value={notional} min="1"/></label><label>{$t("手续费 bps/边")}<input type="number" bind:value={fee} min="0" step=".1"/></label><label>{$t("滑点 bps/边")}<input type="number" bind:value={slippage} min="0" step=".1"/></label><label>{$t("止损 ATR（0关闭）")}<input type="number" bind:value={stopAtr} min="0" step=".1"/></label><label>{$t("止盈 ATR（0关闭）")}<input type="number" bind:value={takeAtr} min="0" step=".1"/></label><label>{$t("最多持仓柱数")}<input type="number" bind:value={holdBars} min="1" max="512"/></label></div>
    <label class="check"><input type="checkbox" bind:checked={includeFunding}/>{$t("读取同区间 Binance 资金费与标记价")}</label>
    <div class="buttons"><button onclick={run} disabled={running||!selectedIds.length||context.chartState.loading}>{$t("运行验收")}</button>{#if running}<button onclick={()=>cancelJob?.()}>{$t("取消")}</button>{/if}{#if report}<button onclick={()=>download(report,`analysis-validation-${Date.now()}.json`)}>{$t("导出报告")}</button>{/if}</div>
    {#if progress}<progress value={progress.percent} max="100"></progress><p>{{prepare:$t("准备数据"),causality:$t("因果检查"),holdout:$t("后段研究"),complete:$t("完成")}[progress.phase]} · {progress.completed}/{progress.total}</p>{/if}
    {#if report}
      <h4>{$t("因果检查")}</h4><dl><div><dt>{$t("结果")}</dt><dd>{report.causality.status==='issues'?$t("发现问题"):$t("抽样门槛通过")}</dd></div><div><dt>{$t("已知事实改变")}</dt><dd>{report.causality.changedKnownFacts}</dd></div><div><dt>{$t("提前输出 / 读取未来")}</dt><dd>{report.causality.futureEmissions} / {report.causality.futureBackingDifferences}</dd></div><div><dt>{$t("最终窗口未保留的旧记录")}</dt><dd>{report.causality.unmatchedPastFacts}</dd></div></dl>
      <h4>{$t("固定后段研究")}</h4><dl><div><dt>{$t("后段 / 总闭柱")}</dt><dd>{report.split.holdoutBars} / {report.dataset.closedBars}</dd></div><div><dt>{$t("事件 / 完整响应")}</dt><dd>{report.responses.signals} / {report.responses.evaluated}</dd></div><div><dt>{$t("正响应比例（非识别准确率）")}</dt><dd>{report.responses.positiveRate===null?'—':fmt(report.responses.positiveRate*100)+'%'}</dd></div><div><dt>{$t("交易笔数")}</dt><dd>{report.research.trades.length}</dd></div><div><dt>{$t("研究净结果 USDT")}</dt><dd class:negative={report.research.net<0}>{fmt(report.research.net)}</dd></div><div><dt>{$t("手续费 / 滑点 / 资金费")}</dt><dd>{fmt(report.research.fees)} / {fmt(report.research.slippageCost)} / {fmt(report.research.funding)}</dd></div><div><dt>{$t("资金费覆盖")}</dt><dd>{{'not-provided':$t("未提供"),'partial':$t("部分覆盖"),'covered':$t("已覆盖")}[report.research.fundingBasis]}</dd></div><div><dt>{$t("结论")}</dt><dd>{$canonicalT(conclusion[report.research.conclusion])}</dd></div></dl>
      <details><summary>{$t("数据版本与限制")}</summary><code>{report.dataset.hash}</code>{#each report.warnings as warning}<p>{$canonicalT(warning)}</p>{/each}</details>
    {/if}
    <details><summary>{$t("开发自验收与独立样本报告")}</summary><p><a href="/docs/technical-analysis-plan-2026-09-23/acceptance-generated.md" target="_blank" rel="noreferrer">{$t("查看规则/真实窗口报告")}</a></p><p><a href="/docs/technical-analysis-plan-2026-09-23/anchor-review-round2-score.md" target="_blank" rel="noreferrer">{$t("查看独立真实锚点盲审与分歧")}</a></p><p><a href="/docs/technical-analysis-plan-2026-09-23/acceptance-generated.json" target="_blank" rel="noreferrer">{$t("下载完整数据与SHA")}</a></p></details>
  {:else if page==='reviews'}
    <h3>{$t("人工复核记录")}</h3><p>{$t("独立保存判断和手绘来源。不会用你修改过的图形反过来证明原算法正确。")}</p>
    <div class="buttons"><button onclick={()=>download(context.controller.exportAnalysisReviews(),'analysis-reviews.json')}>{$t("导出全部复核")}</button><label class="import">{$t("导入 JSON")}<input type="file" accept="application/json,.json" onchange={importReviews}/></label></div>
    {#each reviews as review}<article><strong>{review.name}</strong><small>{{accepted:$t("接受"),rejected:$t("驳回"),pending:$t("待定"),manual:$t("手绘覆盖")}[review.decision]} · {date(review.updatedAt)}</small><p>{review.note||$t("没有备注")}</p><button onclick={()=>restoreReview(review.kind,review.instanceId,review.sourceId)}>{$t("恢复自动标注")}</button></article>{:else}<p>{$t("在形态或分析记录的详情中展开“人工复核与校正”。")}</p>{/each}
  {:else}
    <h3>{$t("从明确手绘锚点开始")}</h3><p>{$t("先在主图绘制趋势线或区间，再选择该对象。坐标来自数据时间和价格，缩放不会改变计算尺度。")}</p>
    <label>{$t("主图手绘对象")}<select bind:value={drawingId}><option value="">{$t("请选择")}</option>{#each drawings as drawing}<option value={drawing.id}>{context.controller.drawing.document.layers.find(l=>l.id===drawing.id)?.name??$t("手绘")} · {{'analysis-path':$t("结构路径"),rectangle:$t("区间框"),'trend-line':$t("线段"),text:$t("文字")}[drawing.toolId]??drawing.toolId} · {date(drawing.points[0]?.time)}</option>{/each}</select></label>
    <div class="fields"><label>{$t("Gann 每单位价格")}<input type="number" bind:value={priceUnit} min=".00000001" step=".1"/></label><label>{$t("Gann 每单位柱数")}<input type="number" bind:value={timeUnitBars} min=".01" step=".1"/></label><label>{$t("固定时间单位（分钟，0按柱）")}<input type="number" bind:value={absoluteTimeMinutes} min="0" step="1"/></label></div>
    <div class="buttons"><button onclick={()=>useDrawing('gann')} disabled={!drawingId||priceUnit<=0}>{$t("用于 Gann 投射")}</button><button onclick={()=>useDrawing('pnf')} disabled={!drawingId}>{$t("用于点数图区间计数")}</button></div>
    <p>{$t("自动结构可先在详情中“转为手动校正”，随后拖动任意端点或边界。手绘与原识别分开保存，支持原有撤销/重做。")}</p>
  {/if}
  </div>
</section>
<style>.research-panel{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--text);background:var(--bg-panel);font-size:11px}.research-panel>nav{display:flex;gap:2px;padding:0 7px;border-bottom:1px solid var(--line-strong)}.research-panel>nav button{flex:1;padding:8px 3px;border:0;border-bottom:2px solid transparent}.research-panel>nav button.current{background:var(--bg-active);border-color:var(--accent)}.body{overflow:auto;padding:12px;min-height:0;flex:1}h3{font-size:13px;font-weight:550;margin:0 0 8px}h4{font-size:11px;margin:15px 0 9px;font-weight:500;color:var(--text)}p{font-size:10px;line-height:1.8;color:var(--text-dim);margin:7px 0}button,.import{border:1px solid var(--line-strong);padding:5px 7px;border-radius:1px;font-size:10px;color:var(--accent-strong);cursor:pointer}button:hover,.import:hover{background:var(--bg-active)}button:disabled{opacity:.4;cursor:default}label{display:flex;flex-direction:column;gap:5px;margin:7px 0;color:var(--text-dim);font-size:10px}input,select{min-width:0;border:1px solid var(--line-strong);background:var(--bg-panel);color:var(--text);padding:5px;border-radius:1px;font:11px var(--mono)}.fields{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}.buttons{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:10px 0}.replay-date{font:11px var(--mono);padding:12px 0;color:var(--accent-strong)}.seek{width:100%;accent-color:var(--accent)}.check{flex-direction:row;align-items:center;line-height:1.5}.module-list{max-height:230px;overflow:auto;display:grid;gap:0}.module-list label{flex-direction:row;align-items:center;gap:7px;margin:0;padding:5px 0}.module-list input,.check input{accent-color:#8eafd5}details{border-block:1px solid var(--line-strong);margin-top:12px;padding:9px 0}summary{cursor:pointer;color:var(--text);line-height:1.7}dl{margin:0;display:grid;gap:7px}dl>div{display:flex;justify-content:space-between;gap:12px;align-items:baseline}dt{font-size:10px;color:var(--text-dim)}dd{margin:0;font:11px var(--mono);text-align:right;color:var(--text);overflow-wrap:anywhere}.negative{color:var(--down)}.feedback{margin:0;padding:9px 12px;background:var(--bg-hover);border-bottom:1px solid var(--line-strong);color:var(--accent-strong)}progress{width:100%;height:5px;accent-color:#82accf}code{display:block;overflow-wrap:anywhere;font-size:10px;margin-top:8px}.import{position:relative;overflow:hidden;margin:0}.import input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%}article{padding:12px 0;border-bottom:1px solid var(--line-strong)}article strong{display:block;font-size:11px;font-weight:500}article small{display:block;font:10px var(--mono);color:var(--text-dim);margin-top:6px}a{color:var(--accent-strong)}button:focus-visible,input:focus-visible,select:focus-visible{outline:1px solid var(--accent);outline-offset:1px}</style>
