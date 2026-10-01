<script lang="ts">
  import {t,canonicalT,locale} from '../../lib/i18n';
  import {onDestroy,tick,untrack} from 'svelte';
  import type {WorkspacePanelProps} from '../layout/panel-context';
  import type {AnalysisFamily,AnalysisObservation,AnalysisRow} from '../../lib/analysis/types';
  import {analysisBrief,analysisChartName,analysisEventMarker,analysisKind,analysisStatus,meaningfulCounterEvidence,meaningfulWaitingFor} from '../../lib/analysis/presentation';
  import {formatMarketPrice} from '../../lib/core/market-format';
  import ToolIcon from '../drawing/ToolIcon.svelte';
  import ReviewControls from './ReviewControls.svelte';
  import AnalysisGuide from './AnalysisGuide.svelte';

  let {context,density,zone}:Pick<WorkspacePanelProps,'context'|'density'|'zone'>=$props();
  let revision=$state(0),selectionRevision=$state(0),detail=$state(false),error=$state(''),addOpen=$state(false);
  let family=$state('all'),stateFilter=$state('active'),direction=$state('all'),instanceFilter=$state('all');
  let listElement=$state<HTMLDivElement>(),detailElement=$state<HTMLDivElement>(),panelElement=$state<HTMLElement>();
  let addButton=$state<HTMLButtonElement>();
  let lastSelection:string|null=null;
  let clickTimer:ReturnType<typeof setTimeout>|undefined,pendingDetailKey:string|null=null;
  const cancelClick=()=>{if(clickTimer!==undefined)clearTimeout(clickTimer);clickTimer=undefined;pendingDetailKey=null;};
  onDestroy(cancelClick);
  const moduleGroups=[
    {id:'structure',name:'读结构',description:'看拐点、破位和转向',icon:'trend'},
    {id:'zones',name:'找区域',description:'看价格区域的建立、回访和失效',icon:'zone'},
    {id:'volume',name:'看量价',description:'结合成交量理解价格行为',icon:'indicator'},
    {id:'measure',name:'做测量',description:'查看计数、几何和价时参考',icon:'ruler'}
  ];
  const moduleInfo:Record<string,{group:string;description:string;icon:string}>={
    'analysis-candles':{group:'structure',description:'辨认单根或多根 K 线的价格形状。',icon:'candles'},
    'analysis-structure':{group:'structure',description:'查看高低点、收盘破位和结构转向。',icon:'trend'},
    'analysis-ict':{group:'structure',description:'串联参考位扫过、结构转向与价格区域。',icon:'layers'},
    'analysis-order-blocks':{group:'zones',description:'定位推进前基底，跟踪区域回访与失效。',icon:'zone'},
    'analysis-zones':{group:'zones',description:'区分供需基底与三根 K 线形成的 FVG 价差。',icon:'rectangle'},
    'analysis-vsa':{group:'volume',description:'对比量能、振幅和收盘位置。',icon:'indicator'},
    'analysis-wyckoff':{group:'volume',description:'观察区间测试、突破与后续验证。',icon:'channel'},
    'analysis-point-figure':{group:'measure',description:'用 X/O 价格列记录走势并测量区间。',icon:'ruler'},
    'analysis-wolfe':{group:'measure',description:'查看五点结构与几何投射线。',icon:'pattern'},
    'analysis-elliott':{group:'measure',description:'对照主计数、备选计数和未完成部分。',icon:'pattern'},
    'analysis-hurst':{group:'measure',description:'估计历史周期、相位与稳定性。',icon:'clock'},
    'analysis-gann':{group:'measure',description:'从明确锚点按价格和时间单位投射。',icon:'ruler'}
  };
  const modules=$derived(context.controller.registry.list().filter(d=>d.category==='analysis').map(d=>({id:d.id,name:d.title??d.name,...(moduleInfo[d.id]??{group:'measure',description:d.description??'',icon:'indicator'})})));
  const familyNames:Record<AnalysisFamily,string>={candlestick:'K线形态',structure:'市场结构',wyckoff:'威科夫',
    'supply-demand':'供需区域',vsa:'量价观察',smc:'SMC',wave:'波浪',cycle:'周期'};
  $effect(()=>context.controller.drawing.subscribe(()=>untrack(()=>revision++)));
  const rows=$derived.by(()=>{context.chartState;revision;return context.controller.getAnalysisRows();});
  const studies=$derived.by(()=>{context.chartState;revision;return context.controller.getAnalysisStudies();});
  const selectedKey=$derived.by(()=>{context.chartState;revision;selectionRevision;return context.controller.selectedAnalysisKey;});
  const key=(row:AnalysisRow)=>`${row.instanceId}:${row.observation.id}`;
  const selected=$derived(rows.find(row=>key(row)===selectedKey));
  const selectedStudy=$derived(studies.find(study=>study.instanceId===selected?.instanceId));
  const waiting=$derived(studies.some(study=>study.pending));
  const families=$derived([...new Set(rows.map(row=>row.observation.family))]);
  const filtered=$derived(rows.filter(row=>(family==='all'||row.observation.family===family)
    &&(instanceFilter==='all'||row.instanceId===instanceFilter)
    &&(direction==='all'||row.observation.direction===direction)
    &&(stateFilter==='all'||stateFilter==='active'&&row.observation.state!=='invalidated'||row.observation.state===stateFilter))
    .sort((a,b)=>b.observation.availableAt-a.observation.availableAt||key(a).localeCompare(key(b))));
  $effect(()=>{
    const current=selectedKey;
    if(current&&current!==lastSelection&&current!==pendingDetailKey)detail=true;
    lastSelection=current;
    if(!current)detail=false;
  });
  $effect(()=>{selectedKey;if(detailElement)detailElement.scrollTop=0;});
  $effect(()=>{if(instanceFilter!=='all'&&!studies.some(study=>study.instanceId===instanceFilter))instanceFilter='all';});
  const shortFormat=$derived(new Intl.DateTimeFormat($locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'}));
  const fullFormat=$derived(new Intl.DateTimeFormat($locale,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'}));
  const date=(time:number,full=false)=>Number.isFinite(time)?(full?fullFormat:shortFormat).format(new Date(time)):'—';
  const stateName=(item:AnalysisObservation)=>analysisStatus(item).label;
  const directionName=(item:AnalysisObservation)=>item.direction==='neutral'?'中性':item.direction==='bullish'?'向上':'向下';
  const obStages=[{key:'activation',label:'区域建立',marker:'diamond'},{key:'revisit',label:'首次回访',marker:'circle'},{key:'mitigation',label:'达到深度',marker:'square'}];
  const trackingReason=(item:AnalysisObservation)=>item.trackingEndReason==='departure'?'已持续离开原区间':item.trackingEndReason==='expired'?'达到本级别观察期限':item.dataWarning?'后续数据或核验范围中断':'本段观察已结束';
  const icon=(id:string)=>modules.find(item=>item.id===id)?.icon??'indicator';
  const locked=(id:string)=>context.controller.layerStatus(id).locked;
  function settings(id:string){if(!locked(id))context.onOpenProperties([id]);}
  function toggle(id:string){
    if(locked(id))return;
    const layer=context.controller.drawing.document.layers.find(layer=>layer.id===id);
    if(layer)context.controller.drawing.updateLayers([id],{visible:!layer.visible});
  }
  function remove(id:string){if(!locked(id))context.controller.drawing.removeLayers([id]);}
  function add(id:string){
    error='';
    try{
      const instanceId=context.controller.addIndicator(id);
      if(!instanceId){error=context.controller.drawing.state.error||'未能添加分析模块，请重试。';return;}
      instanceFilter=instanceId;family='all';stateFilter='active';direction='all';detail=false;addOpen=false;
      void tick().then(()=>addButton?.focus({preventScroll:true}));
    }catch(reason){error=reason instanceof Error?reason.message:'未能添加分析模块。';}
  }
  async function openDetail(){detail=true;await tick();if(detail)panelElement?.querySelector<HTMLButtonElement>('.back')?.focus({preventScroll:true});}
  function select(row:AnalysisRow){cancelClick();context.controller.selectAnalysis(row.instanceId,row.observation.id,true);selectionRevision++;void openDetail();}
  function selectRow(row:AnalysisRow,event:MouseEvent){
    // Keep the row mounted for the browser's double-click gesture. Selection
    // and chart focus are immediate; only the drill-down waits briefly.
    cancelClick();
    if(event.detail===0){select(row);return;}
    pendingDetailKey=key(row);
    context.controller.selectAnalysis(row.instanceId,row.observation.id,true);selectionRevision++;
    if(event.detail>1){pendingDetailKey=null;detail=true;settings(row.instanceId);return;}
    clickTimer=setTimeout(()=>{clickTimer=undefined;pendingDetailKey=null;void openDetail();},250);
  }
  function doubleClick(row:AnalysisRow){cancelClick();detail=true;settings(row.instanceId);}
  async function back(){
    cancelClick();detail=false;await tick();
    const buttons=Array.from(listElement?.querySelectorAll<HTMLButtonElement>('.observation-row')??[]);
    (buttons.find(button=>button.dataset.key===selectedKey)??buttons[0])?.focus({preventScroll:true});
  }
  function listKeys(event:KeyboardEvent){
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    const items=Array.from(listElement?.querySelectorAll<HTMLButtonElement>('.observation-row')??[]);
    if(!items.length)return;event.preventDefault();
    const current=items.indexOf(document.activeElement as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:(current+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[next]?.focus();
  }
  function clearFilters(){family='all';stateFilter='active';direction='all';instanceFilter='all';}
</script>

<svelte:window onkeydown={event=>{if(event.key==='Escape'&&!event.defaultPrevented&&panelElement?.contains(document.activeElement)){if(addOpen){event.preventDefault();addOpen=false;addButton?.focus();}else if(detail){event.preventDefault();void back();}}}}/>

{#snippet moduleCatalog()}
  <div class="module-groups">
    {#each moduleGroups as group}
      {@const items=modules.filter(module=>module.group===group.id)}
      {#if items.length}
        <section class="module-group" data-group={group.id}>
          <header><ToolIcon name={group.icon} size={15}/><div><h4>{$canonicalT(group.name)}</h4><p>{$canonicalT(group.description)}</p></div></header>
          {#each items as module}
            <button class="module-option" onclick={()=>add(module.id)} aria-label={$t("添加 {0}",{0:$canonicalT(module.name)})}>
              <ToolIcon name={module.icon} size={15}/><span><strong>{$canonicalT(module.name)}</strong><small>{$canonicalT(module.description)}</small></span><ToolIcon name="plus" size={13}/>
            </button>
          {/each}
        </section>
      {/if}
    {/each}
  </div>
{/snippet}

<section class="analysis-panel" bind:this={panelElement} class:comfortable={density==='comfortable'} class:bottom={zone==='bottom'} aria-label={$t("技术分析观察工作区")}>
  <header class="panel-toolbar">
    {#if detail}<button class="back" title={$t("返回观察列表，保留图表选择")} aria-label={$t("返回分析观察列表")} onclick={back}><span class="back-icon"><ToolIcon name="chevron" size={13}/></span>{$t("观察列表")}</button>
    {:else}<div class="market"><strong>{context.chartState.symbol}</strong><span>{context.chartState.interval}</span></div>{/if}
    <button class="add-picker" bind:this={addButton} aria-expanded={addOpen} aria-label={$t("添加技术分析模块")} title={$t("添加独立分析模块，分别设置规则、周期与样式")} onclick={()=>addOpen=!addOpen}><ToolIcon name={addOpen?'close':'plus'} size={13}/><span>{$t(addOpen?'收起':'添加')}</span></button>
  </header>
  {#if error}<div class="error" role="alert"><span>{$canonicalT(error)}</span><button title={$t("关闭错误提示")} aria-label={$t("关闭分析错误提示")} onclick={()=>error=''}><ToolIcon name="close" size={13}/></button></div>{/if}
  {#if addOpen}<div class="module-browser" aria-label={$t("按用途选择分析模块")}>{@render moduleCatalog()}</div>{/if}
  {#if !detail}<AnalysisGuide/>{/if}

  {#if detail&&selected}
    {@const observation=selected.observation}
    {@const isLocked=locked(selected.instanceId)}
    {@const status=analysisStatus(observation)}
    {@const brief=analysisBrief(observation)}
    {@const kind=analysisKind(observation)}
    {@const caveats=meaningfulCounterEvidence(observation)}
    {@const waitingItems=meaningfulWaitingFor(observation)}
    <div class="evidence-page" bind:this={detailElement}>
      <header class="evidence-heading">
        <div><span class="eyebrow">{$canonicalT(familyNames[observation.family])} · {selected.timeframe}</span><h3>{$canonicalT(observation.name)}</h3></div>
        <button class="icon-button" title={$t("重新定位这条观察")} aria-label={$t("定位所选分析观察")} onclick={()=>select(selected)}><ToolIcon name="fit" size={15}/></button>
        <button class="icon-button" title={isLocked?$t("图层已锁定，请先在对象树解锁"):$t("设置所属模块的规则、周期与样式")} aria-label={$t("设置所选分析模块")} disabled={isLocked} onclick={()=>settings(selected.instanceId)}><ToolIcon name="gear" size={15}/></button>
      </header>
      <div class="observation-status"><span class="status-badge" class:invalid={status.key==='invalidated'} class:observing={status.key==='observing'} class:ended={status.key==='ended'} class:limited={status.key==='limited'} title={$canonicalT(status.description)}>{$canonicalT(status.label)}</span><span class:bullish={observation.direction==='bullish'} class:bearish={observation.direction==='bearish'}><ToolIcon name={observation.direction==='bullish'?'mark-up':observation.direction==='bearish'?'mark-down':'horizontal'} size={12}/>{$canonicalT(directionName(observation))}</span><span>{date(observation.availableAt,true)} UTC</span></div>
      <section class="reading-guide" data-kind={kind} aria-label={$t("形态释义与常见推测")}>
        <div class="brief-section">
          <div class="reading-guide-title"><span class="type-swatch" data-kind={kind} aria-hidden="true"></span><h4>{$t("形态释义")}</h4></div>
          <p>{$canonicalT(brief.summary)}</p>
        </div>
        <div class="brief-section">
          <strong>{$t("形态动作")}</strong>
          <p>{$canonicalT(brief.action)}</p>
        </div>
        <div class="brief-section">
          <strong>{$t("常见推测")}</strong>
          <p>{$canonicalT(brief.projection)}</p>
        </div>
      </section>
      {#if observation.zone}<dl class="zone"><dt>{$t("关键区间")}</dt><dd>{formatMarketPrice(observation.zone.low)}<span>—</span>{formatMarketPrice(observation.zone.high)}</dd></dl>{/if}
      {#if kind==='order-block'}
        <section class="ob-lifecycle" aria-label={$t("订单块生命周期")}>
          <h4>{$t("区域进展")}</h4>
          <ol>
            {#each obStages as stage}
              {@const event=observation.events.find(event=>event.kind===stage.key)}
              <li class:reached={!!event} class:pending={!event}><span class="event-marker" class:diamond={stage.marker==='diamond'} class:circle={stage.marker==='circle'} class:square={stage.marker==='square'} aria-hidden="true"></span><span>{$canonicalT(stage.label)}</span><small title={event?`${date(event.availableAt,true)} UTC`:undefined}>{event?date(event.availableAt):observation.state==='invalidated'||observation.trackingEndedAt||observation.dataWarning?$t("未记录"):$t("待观察")}</small></li>
            {/each}
            {#each observation.events.filter(event=>event.kind==='invalidation') as event}
              <li class="invalid-stage"><span class="event-marker cross" aria-hidden="true"></span><span>{$t("区域失效")}</span><small>{date(event.availableAt)}</small></li>
            {/each}
          </ol>
          <dl class="ob-times"><div><dt>{$t("基底所在 K 线")}</dt><dd>{date(observation.time,true)} UTC</dd></div><div><dt>{$t("区域建立可知")}</dt><dd>{date(observation.events.find(event=>event.kind==='activation')?.availableAt??observation.availableAt,true)} UTC</dd></div></dl>
        </section>
      {/if}
      {#if !selected.visible}<p class="notice"><ToolIcon name="hidden" size={13}/>{$t("当前标注已隐藏，记录仍可查看；可检查图层、显示范围或人工复核设置。")}</p>{/if}
      {#if selectedStudy?.pending}<p class="notice" role="status">{$t("正在更新当前行情的分析记录…")}</p>{/if}
      {#if observation.dataWarning||selectedStudy?.warning}<p class="notice warning">{$canonicalT(observation.dataWarning??selectedStudy?.warning)}</p>{/if}
      {#if observation.trackingEndedAt}<p class="notice">{$t("历史区间 ·")} {date(observation.trackingEndedAt,true)} UTC {$canonicalT(trackingReason(observation))}</p>{/if}
      {#if observation.phase}<section class="phase"><h4>{$t("当前阶段")}</h4><p>{$canonicalT(observation.phase)}</p></section>{/if}
      <section class="evidence-group support"><h4><span aria-hidden="true">＋</span>{$t("本次触发依据")} <small>{observation.evidence.length}</small></h4><ul>{#each observation.evidence as evidence}<li>{$canonicalT(evidence)}</li>{:else}<li class="muted">{$t("尚无足够支持依据。")}</li>{/each}</ul></section>
      {#if waitingItems.length}<section class="evidence-group waiting"><h4><ToolIcon name="clock" size={13}/>{$t("后续观察重点")}</h4><ul>{#each waitingItems as condition}<li>{$canonicalT(condition)}</li>{/each}</ul></section>{/if}
      {#if caveats.length}<section class="evidence-group conflict"><h4><span aria-hidden="true">−</span>{$t("技术面留意项")} <small>{caveats.length}</small></h4><ul>{#each caveats as evidence}<li>{$canonicalT(evidence)}</li>{/each}</ul></section>{/if}
      {#if observation.alternatives?.length}<details class="detail-block"><summary>{$t("备选解释")} <span>{observation.alternatives.length}</span></summary><ul>{#each observation.alternatives as alternative}<li>{$canonicalT(alternative)}</li>{/each}</ul></details>{/if}
      {#if observation.events.length>1||(observation.events.length===1&&observation.events[0].label!==observation.name)}<details class="detail-block" open={observation.events.length<=4}><summary>{$t("事件时间线")} <span>{observation.events.length}</span></summary><ol class="event-list">
        {#each observation.events as event (event.id)}
          {@const marker=analysisEventMarker(event)}
          <li class:invalid-event={event.kind==='invalidation'}>
          <span class="event-marker" class:diamond={marker==='diamond'} class:circle={marker==='circle'} class:square={marker==='square'} class:cross={marker==='cross'} aria-hidden="true"></span>
          <div class="event-title"><strong>{$canonicalT(event.label)}</strong><span>{formatMarketPrice(event.price)}</span></div>
          <dl><div><dt>{$t("发生")}</dt><dd>{date(event.time,true)} UTC</dd></div>{#if event.availableAt!==event.time}<div><dt>{$t("可知")}</dt><dd>{date(event.availableAt,true)} UTC</dd></div>{/if}</dl>
          <p>{$canonicalT(event.explanation)}</p>
        </li>{/each}
      </ol></details>{/if}
      {#if observation.points.length}<details class="detail-block anchors"><summary>{$t("实际锚点")} <span>{observation.points.length}</span></summary><table><thead><tr><th scope="col">{$t("锚点")}</th><th scope="col">{$t("价格")}</th><th scope="col">{$t("时间 · UTC")}</th></tr></thead><tbody>{#each observation.points as point}<tr><th scope="row">{$canonicalT(point.label)}</th><td>{formatMarketPrice(point.value)}</td><td title={date(point.time,true)}>{date(point.time)}</td></tr>{/each}</tbody></table></details>{/if}
      <dl class="metadata">
        <div><dt>{$t("结构发生")}</dt><dd>{date(observation.time,true)} UTC</dd></div>
        {#if observation.availableAt!==observation.time}<div><dt>{$t("首次可知")}</dt><dd>{date(observation.availableAt,true)} UTC</dd></div>{/if}
        {#if observation.invalidatedAt!==undefined}<div><dt>{$t("失效可知")}</dt><dd>{date(observation.invalidatedAt,true)} UTC</dd></div>{/if}
      </dl>
      <ReviewControls {context} kind="analysis" instanceId={selected.instanceId} sourceId={observation.id}/>
    </div>
  {:else if detail&&waiting}
    <div class="empty" role="status"><ToolIcon name="clock" size={22}/><strong>{$t("正在更新所选观察")}</strong><p>{$t("完成后会显示当前证据。")}</p><button onclick={back}>{$t("返回列表")}</button></div>
  {:else if !studies.length}
    <div class="empty start"><ToolIcon name="layers" size={25}/><h3>{$t("价格、结构与量价证据")}</h3><p>{$t("先选想观察的问题，再添加对应模块。每个模块都可独立设置和隐藏。")}</p>
      {#if !addOpen}{@render moduleCatalog()}{/if}
    </div>
  {:else}
    <div class="study-manager" aria-label={$t("已挂载的分析模块")}>
      {#each studies as study (study.instanceId)}
        {@const isLocked=locked(study.instanceId)}
        <div class="study" class:muted={!study.visible} class:current={instanceFilter===study.instanceId}>
          <button class="study-name" title={$t("{0} · {1}\n单击筛选{2}", {"0": String(study.name), "1": String(study.timeframe), "2": String(isLocked?$t(" · 图层已锁定"):$t(" / 双击设置"))})} aria-pressed={instanceFilter===study.instanceId} onclick={()=>instanceFilter=instanceFilter===study.instanceId?'all':study.instanceId} ondblclick={()=>settings(study.instanceId)}><ToolIcon name={icon(study.definitionId)} size={13}/><span>{study.name}</span><small>{study.timeframe}</small></button>
          <span class="count" title={study.pending?$t("正在更新"):study.definitionId.startsWith('flow-')?$t("连续数值输出，在副图查看"):$t("保留的观察记录")}>{study.pending?'…':study.definitionId.startsWith('flow-')?'—':study.count}</span>
          <button class="icon-button" disabled={isLocked} title={isLocked?$t("图层已锁定"):study.visible?$t("隐藏图表标注"):$t("显示图表标注")} aria-label={`${study.visible?$t("隐藏"):$t("显示")} ${study.name}`} onclick={()=>toggle(study.instanceId)}><ToolIcon name={study.visible?'eye':'hidden'} size={13}/></button>
          <button class="icon-button" disabled={isLocked} title={isLocked?$t("图层已锁定，请先解锁"):$t("设置规则、周期与样式")} aria-label={$t("设置 {0}", {"0": String(study.name)})} onclick={()=>settings(study.instanceId)}><ToolIcon name="gear" size={13}/></button>
          <button class="icon-button" disabled={isLocked} title={isLocked?$t("图层已锁定"):$t("删除此分析模块")} aria-label={$t("删除 {0}", {"0": String(study.name)})} onclick={()=>remove(study.instanceId)}><ToolIcon name="trash" size={13}/></button>
        </div>
      {/each}
    </div>
    <div class="filters">
      <select aria-label={$t("筛选分析分类")} title={$t("筛选分析分类")} bind:value={family}><option value="all">{$t("全部分类")}</option>{#each families as item}<option value={item}>{$canonicalT(familyNames[item])}</option>{/each}</select>
      <select aria-label={$t("筛选观察状态")} title={$t("默认隐藏失效记录")} bind:value={stateFilter}><option value="active">{$t("未失效")}</option><option value="observing">{$t("观察中")}</option><option value="confirmed">{$t("已记录事件")}</option><option value="invalidated">{$t("已失效")}</option><option value="all">{$t("全部状态")}</option></select>
      <select aria-label={$t("筛选观察方向")} title={$t("方向是结构描述，不是交易指令")} bind:value={direction}><option value="all">{$t("方向")}</option><option value="bullish">{$t("向上")}</option><option value="bearish">{$t("向下")}</option><option value="neutral">{$t("中性")}</option></select>
    </div>
    <div class="list-summary"><span>{instanceFilter==='all'?$t("观察记录"):studies.find(study=>study.instanceId===instanceFilter)?.name}<b>{filtered.length}</b></span>{#if waiting}<span role="status">{$t("更新中…")}</span>{:else}<span>{$t("首次可知 · UTC")}</span>{/if}</div>
    {#if studies.some(study=>study.warning)}<details class="coverage-warning"><summary>{$t("数据覆盖提示")}</summary>{#each studies.filter(study=>study.warning) as study}<p>{study.name}{$locale==='zh-CN'?"：":":"}{$canonicalT((study.warning)??'')}</p>{/each}</details>{/if}
    <div class="observation-list" bind:this={listElement} role="group" aria-label={$t("分析观察记录，按可知时间倒序")}>
      {#each filtered as row (key(row))}
        <button class="observation-row" data-key={key(row)} class:chosen={selectedKey===key(row)} class:invalid={row.observation.state==='invalidated'} aria-pressed={selectedKey===key(row)}
          title={$t("{0} · {1}\n{2} UTC 首次可知\n单击定位并查看证据，双击设置所属模块", {"0": String($canonicalT((row.observation.name)??'')), "1": String($canonicalT((stateName(row.observation))??'')), "2": String(date(row.observation.availableAt,true))})}
          onkeydown={listKeys} onclick={event=>selectRow(row,event)} ondblclick={()=>doubleClick(row)}>
          <span class="direction" class:bullish={row.observation.direction==='bullish'} class:bearish={row.observation.direction==='bearish'}><ToolIcon name={row.observation.direction==='bullish'?'mark-up':row.observation.direction==='bearish'?'mark-down':'horizontal'} size={13}/></span>
          <span class="row-copy"><strong>{$canonicalT(analysisChartName(row.observation))}</strong><small><span class="row-state" data-state={analysisStatus(row.observation).key} title={$canonicalT(analysisStatus(row.observation).description)}>{$canonicalT(stateName(row.observation))}</span><span>{row.timeframe}{#if !row.visible} {$t("· 已隐藏")}{/if}</span></small></span>
          <span class="row-time" title={date(row.observation.availableAt,true)}>{date(row.observation.availableAt)}</span>
        </button>
      {:else}
        <div class="empty" role="status"><ToolIcon name="search" size={23}/><strong>{waiting?$t("正在分析已收盘行情"):$t("暂无符合筛选的观察")}</strong><p>{studies.every(study=>study.definitionId.startsWith('flow-'))?$t("Delta / CVD 在独立副图连续更新，不生成形态观察条目。可通过上方添加价格与量价分析。"):stateFilter==='invalidated'?$t("失效记录默认隐藏；需要复盘时，可在所属模块设置中启用。"):$t("结果取决于已加载行情和明确规则。新 K 线收盘后会继续更新。")}</p>{#if family!=='all'||stateFilter!=='active'||direction!=='all'||instanceFilter!=='all'}<button onclick={clearFilters}>{$t("清除筛选")}</button>{/if}</div>
      {/each}
    </div>
    <footer><span>{$t("单击查看证据 · 双击设置")}</span><span title={$t("上下键移动焦点，Enter 查看证据")}>↑ ↓ / Enter</span></footer>
  {/if}
</section>

<style>
  .analysis-panel{width:100%;height:100%;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--bg-panel);color:var(--text);font-size:12px;font-variant-numeric:tabular-nums}
  button,select{font:inherit;border-radius:0}button{color:inherit}button:disabled{opacity:.36;cursor:default}.analysis-panel :is(button,select,summary):focus-visible{outline:1px solid var(--accent);outline-offset:-1px}
  .panel-toolbar{display:flex;align-items:center;gap:8px;min-height:35px;padding:0 9px;border-bottom:1px solid var(--line);flex-shrink:0}.market{display:flex;align-items:center;gap:8px;min-width:0;flex:1}.market strong{font:600 11px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.market span{font:11px var(--mono);color:var(--text-dim)}
  .add-picker{position:relative;display:flex;align-items:center;gap:4px;min-height:25px;padding:0 6px;border:1px solid var(--line-strong);cursor:pointer;font-size:11px;flex-shrink:0}.add-picker:hover,.add-picker:focus-within{background:var(--bg-active);border-color:var(--text-dim)}.back{display:flex;gap:4px;align-items:center;min-height:28px;flex:1;text-align:left;font-size:11px;color:var(--text)}.back-icon{display:flex;transform:rotate(180deg)}
  .error{display:flex;gap:7px;padding:8px 10px;border-bottom:1px solid var(--line-strong);color:var(--warn);font-size:11px;line-height:1.6}.error span{flex:1}.error button{padding:1px;display:flex}.study-manager{max-height:min(126px,25%);overflow:auto;flex-shrink:1;min-height:30px;border-bottom:1px solid var(--line);padding:3px 0}.study{display:flex;align-items:center;gap:2px;min-height:30px;padding:0 5px 0 7px;border-left:2px solid transparent}.study:hover{background:var(--bg-hover)}.study.current{background:var(--bg-hover);border-left-color:var(--accent)}.study-name{min-width:0;flex:1;display:flex;align-items:center;gap:5px;text-align:left;padding:5px 0;font-size:11px}.study-name>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.study-name small{font:10px var(--mono);color:var(--text-dim);margin-left:auto}.count{min-width:18px;text-align:center;color:var(--text-dim);font:10px var(--mono)}.icon-button{width:25px;height:27px;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0;color:var(--text-dim)}.icon-button:not(:disabled):hover{background:var(--bg-active);color:var(--text-strong)}.muted{color:var(--text-dim)}
  .filters{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 68px;gap:5px;padding:8px 9px 5px;flex-shrink:0}.filters select{min-width:0;width:100%;height:26px;min-height:26px;background-color:var(--bg-panel);border:1px solid var(--line-strong);color:var(--text);font-size:11px;padding:0 22px 0 6px}.list-summary{display:flex;justify-content:space-between;align-items:center;gap:5px;min-height:27px;padding:0 10px;color:var(--text-dim);font-size:10px;flex-shrink:0}.list-summary>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.list-summary b{font:10px var(--mono);color:var(--text);margin-left:7px}.coverage-warning{margin:0 9px 6px;color:var(--warn);font-size:10px;line-height:1.6}.coverage-warning summary{cursor:pointer}.coverage-warning p{margin:6px 0}
  .observation-list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}.observation-row{width:100%;min-height:40px;padding:6px 9px;display:flex;align-items:center;gap:6px;text-align:left;border-top:1px solid var(--line);border-left:2px solid transparent;transition:background-color 100ms,border-color 100ms}.observation-row:hover{background:var(--bg-hover)}.observation-row.chosen{background:var(--bg-active);border-left-color:var(--accent)}.direction{display:flex;flex-shrink:0;color:var(--text-dim)}.bullish{color:var(--up)}.bearish{color:var(--down)}.row-copy{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}.row-copy strong{font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row-copy small{font-size:10px;color:var(--text-dim)}.row-time{font:9px var(--mono);color:var(--text);white-space:nowrap;align-self:flex-start;padding-top:2px}.invalid .row-copy strong,.invalid .direction{color:var(--text-dim)}footer{display:flex;justify-content:space-between;align-items:center;gap:6px;min-height:25px;flex-shrink:0;padding:0 10px;border-top:1px solid var(--line);color:var(--text-dim);font-size:10px}
  .empty{display:flex;flex:1;min-height:130px;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px 17px;color:var(--text-dim);text-align:center;overflow:auto}.empty strong{font-size:12px;font-weight:500;color:var(--text)}.empty p{margin:0;font-size:11px;line-height:1.8;text-wrap:pretty}.empty>button{font-size:11px;padding:6px 9px;border:1px solid var(--line-strong)}.empty>button:hover{background:var(--bg-active)}.empty.start{align-items:stretch;justify-content:flex-start;text-align:left;gap:8px}.start h3{font-size:14px;font-weight:550;color:var(--text-strong);margin:5px 0}.start p{margin:0 0 9px}
  .evidence-page{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:12px 11px 16px}.evidence-heading{display:flex;align-items:flex-start;gap:3px}.evidence-heading>div{flex:1;min-width:0}.eyebrow{font-size:10px;color:var(--text-dim)}.evidence-heading h3{font-size:14px;font-weight:550;line-height:1.55;margin:5px 0 7px;color:var(--text-strong);text-wrap:pretty}.observation-status{display:flex;gap:9px;align-items:center;flex-wrap:wrap;color:var(--text);font-size:10px;margin:0 0 10px}.observation-status>span:first-child{border:1px solid var(--line-strong);padding:2px 5px}.observation-status>span:last-child{color:var(--text-dim)}.observation-status .invalid{color:var(--text-dim);border-color:var(--line-strong)}.notice{display:flex;gap:5px;align-items:center;margin:7px 0;padding:7px;background:var(--bg-hover);border-left:2px solid var(--line-strong);color:var(--text);font-size:10px;line-height:1.7}.notice.warning{display:block;background:var(--bg-hover);border-color:var(--text-dim);color:var(--warn)}
  h4{font-size:11px;font-weight:550;margin:0 0 7px;color:var(--text)}.phase{padding:10px 0;border-block:1px solid var(--line-strong)}.phase p{margin:0;color:var(--text);font-size:12px;line-height:1.7}.zone{display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap;margin:12px 0;font-size:11px}.zone dt{color:var(--text-dim)}.zone dd{margin:0;font:11px var(--mono);color:var(--text-strong);display:flex;gap:7px}.zone dd span{color:var(--text-muted)}.evidence-group{padding:11px 0;border-bottom:1px solid var(--line)}.evidence-group h4{display:flex;gap:6px;align-items:center}.evidence-group h4 small{font:10px var(--mono);margin-left:auto;color:var(--text-dim)}.support h4>span{color:var(--up)}.conflict h4>span{color:var(--warn)}.evidence-group ul,.detail-block ul{margin:0;padding-left:15px;font-size:11px;line-height:1.8;color:var(--text);overflow-wrap:anywhere}.evidence-group li+li,.detail-block li+li{margin-top:6px}.waiting li{color:var(--text)}.metadata{margin:13px 0;display:flex;flex-direction:column;gap:7px;font-size:10px}.metadata>div,.event-list dl>div{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}.metadata dt,.event-list dt{color:var(--text-dim)}.metadata dd,.event-list dd{margin:0;font:10px var(--mono);color:var(--text);overflow-wrap:anywhere}
  .detail-block{padding:10px 0;border-top:1px solid var(--line-strong);font-size:11px;color:var(--text)}.detail-block summary{cursor:pointer;line-height:1.6}.detail-block summary span{font:10px var(--mono);margin-left:5px;color:var(--text-dim)}.detail-block>ul{margin-top:9px}.event-list{list-style:none;padding:0;margin:10px 0 0}.event-list>li{position:relative;padding:0 0 12px 10px;border-left:1px solid var(--line-strong)}.event-title{display:flex;justify-content:space-between;gap:7px}.event-title strong{font-size:11px;font-weight:500;color:var(--text)}.event-title>span{font:10px var(--mono);color:var(--text)}.event-list dl{display:flex;flex-direction:column;gap:4px;margin:7px 0}.event-list p{font-size:10px;line-height:1.8;margin:5px 0;color:var(--text-dim)}.anchors table{width:100%;border-collapse:collapse;margin-top:8px;table-layout:auto}.anchors th,.anchors td{padding:6px 0;border-bottom:1px solid var(--line);font:10px var(--mono);text-align:right;overflow-wrap:anywhere}.anchors th:first-child{text-align:left;font:10px var(--font);max-width:100px}.anchors thead th{color:var(--text-dim)}
  .comfortable .observation-row{min-height:46px}.comfortable .study{min-height:34px}.bottom .evidence-page{padding-inline:16px;max-width:860px;width:100%;box-sizing:border-box}.bottom .filters{max-width:600px}.bottom .observation-row{min-height:37px}.bottom .row-copy{flex-direction:row;gap:12px;align-items:baseline}.bottom .row-copy small{white-space:nowrap}.bottom .row-time{align-self:center;padding:0}.bottom .study-manager{max-height:94px}
  .analysis-panel{--analysis-structure:var(--text-dim);--analysis-zone:var(--up);--analysis-volume:var(--warn);--analysis-measure:var(--accent);--analysis-pending:var(--warn);--analysis-history:var(--text-dim)}
  .module-browser{min-height:0;max-height:48%;overflow:auto;overscroll-behavior:contain;padding:11px 10px;border-bottom:1px solid var(--line);background:var(--bg-panel)}
  .module-groups{display:grid;gap:15px;min-width:0;width:100%}.module-group{--module-color:var(--analysis-structure);min-width:0}
  .module-group[data-group=zones]{--module-color:var(--analysis-zone)}.module-group[data-group=volume]{--module-color:var(--analysis-volume)}.module-group[data-group=measure]{--module-color:var(--analysis-measure)}
  .module-group>header{display:flex;align-items:flex-start;gap:8px;padding:0 0 7px;color:var(--module-color)}.module-group>header>div{min-width:0}
  .module-group h4{margin:0;font-size:12px;color:var(--text)}.module-group header p{margin:3px 0 0!important;font-size:11px!important;line-height:1.6;color:var(--text-dim)}
  .module-option{display:flex;align-items:center;gap:9px;min-height:57px;width:100%;padding:8px 7px;text-align:left;border:1px solid var(--line);border-left:2px solid var(--module-color);background:var(--bg)}
  .module-option+.module-option{border-top:0}.module-option:hover{background:var(--bg-hover);border-left-color:var(--module-color)}
  .module-option>span{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}.module-option> :global(svg){flex-shrink:0;color:var(--module-color)}
  .module-option strong{font-size:12px;font-weight:500;line-height:1.4;color:var(--text)}.module-option small{font-size:11px;line-height:1.6;color:var(--text-dim);text-wrap:pretty}
  .start{padding-inline:12px}.start>.module-groups{margin-top:5px}.add-picker[aria-expanded=true]{background:var(--selected,var(--bg-hover));border-color:var(--accent);color:var(--text)}
  .observation-status>span{display:inline-flex;align-items:center;gap:4px}.observation-status .status-badge{font-size:11px;line-height:1.5;padding:3px 6px;background:var(--bg-active);color:var(--text)}
  .observation-status .status-badge.observing{color:var(--analysis-pending);background:var(--bg-hover);border-color:var(--line-strong);border-style:dashed}
  .observation-status .status-badge.limited{color:var(--analysis-pending);background:var(--bg-hover);border-color:var(--line-strong)}
  .observation-status .status-badge.ended,.observation-status .status-badge.invalid{color:var(--analysis-history);background:var(--bg-hover);border-color:var(--line-strong)}
  .row-copy small{display:flex;align-items:center;gap:7px;flex-wrap:wrap;line-height:1.5}.row-state{color:var(--text)}.row-state[data-state=observing],.row-state[data-state=limited]{color:var(--analysis-pending)}.invalid .row-state,.row-state[data-state=ended]{color:var(--analysis-history)}
  .reading-guide{--guide-color:var(--analysis-structure);padding:10px 11px;border:1px solid var(--line);border-left:3px solid var(--guide-color);background:var(--bg-panel);margin:4px 0 12px}
  .reading-guide[data-kind=order-block],.reading-guide[data-kind=zone],.reading-guide[data-kind=ict]{--guide-color:var(--analysis-zone)}
  .reading-guide[data-kind=fvg],.reading-guide[data-kind=wave],.reading-guide[data-kind=cycle]{--guide-color:var(--analysis-measure)}
  .reading-guide[data-kind=vsa],.reading-guide[data-kind=wyckoff]{--guide-color:var(--analysis-volume)}
  .reading-guide-title{display:flex;align-items:center;gap:7px}.reading-guide-title h4{margin:0;color:var(--guide-color);font-size:11px;font-weight:600;line-height:1.5}
  .type-swatch{display:inline-block;width:16px;height:9px;flex-shrink:0;background:var(--guide-color);opacity:.85}
  .type-swatch[data-kind=order-block],.type-swatch[data-kind=zone],.type-swatch[data-kind=ict]{height:12px;border:1px solid var(--guide-color);background:transparent;border-left-width:3px}
  .type-swatch[data-kind=fvg]{height:12px;border:1px solid var(--guide-color);background:repeating-linear-gradient(135deg,var(--guide-color) 0px,var(--guide-color) 1px,transparent 1px,transparent 4px)}
  .type-swatch[data-kind=structure],.type-swatch[data-kind=wave],.type-swatch[data-kind=cycle]{height:0;background:transparent;border-top:1.5px solid var(--guide-color)}
  .type-swatch[data-kind=cycle]{border-top-style:dashed}.reading-guide p{margin:5px 0 0;line-height:1.75;color:var(--text);font-size:11px}
  .brief-section+.brief-section{margin-top:9px;padding-top:9px;border-top:1px solid var(--line)}.brief-section>strong{display:block;font-size:11px;font-weight:600;color:var(--guide-color);line-height:1.5}
  .ob-lifecycle{padding:1px 0 11px;margin-bottom:5px;border-bottom:1px solid var(--line)}.ob-lifecycle>h4{font-size:12px;color:var(--text)}
  .ob-lifecycle>ol{display:grid;grid-template-columns:repeat(auto-fit,minmax(83px,1fr));gap:6px;list-style:none;padding:0;margin:10px 0}
  .ob-lifecycle li{display:grid;grid-template-columns:12px minmax(0,1fr);align-items:center;gap:7px 6px;padding:9px 7px;border:1px solid var(--line-strong);background:var(--bg-hover);color:var(--text-strong);font-size:11px}
  .ob-lifecycle li.pending{border-style:dashed;border-color:var(--line-strong);background:transparent;color:var(--text-dim)}.ob-lifecycle li.invalid-stage{color:var(--analysis-history);background:var(--bg-hover)}
  .ob-lifecycle li>small{grid-column:1/-1;font:10px/1.5 var(--mono);color:var(--text-dim);overflow-wrap:anywhere}
  .ob-times{display:grid;gap:7px;margin:13px 0 8px;font-size:11px}.ob-times>div{display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap}.ob-times dt{color:var(--text-dim)}.ob-times dd{margin:0;font:10px/1.6 var(--mono);color:var(--text)}
  .event-marker{position:relative;display:inline-block;width:8px;height:8px;flex-shrink:0;border:1.5px solid currentColor;background:var(--bg-panel);color:var(--analysis-structure)}
  .event-marker.diamond{transform:rotate(45deg)}.event-marker.circle{border-radius:50%}.event-marker.square{background:currentColor}
  .event-marker.cross{border:0;color:var(--analysis-history)}.event-marker.cross::before,.event-marker.cross::after{content:'';position:absolute;left:3px;top:-1px;width:1.5px;height:10px;background:currentColor;transform:rotate(45deg)}.event-marker.cross::after{transform:rotate(-45deg)}
  .pending .event-marker{color:var(--text-muted)}.event-list>li{padding-left:16px;margin-left:4px}.event-list>li>.event-marker{position:absolute;left:-4.5px;top:4px}
  .event-list>li.invalid-event{border-left-color:var(--line-strong)}.invalid-event .event-title strong{color:var(--analysis-history)}
  .evidence-group.support{border-left:2px solid var(--up);padding-left:9px;margin-top:10px}.evidence-group.conflict{border-left:2px solid var(--line-strong);padding-left:9px}.evidence-group.waiting{border-left:2px dashed var(--line-strong);padding-left:9px}
  @container(min-width:620px){.module-groups{grid-template-columns:repeat(2,minmax(0,1fr))}.module-browser{max-height:55%}}
  @container(max-width:300px){.row-time{font-size:9px;max-width:67px;white-space:normal;text-align:right}.bottom .row-copy{flex-direction:column;gap:3px}.module-option{gap:6px}.ob-lifecycle>ol{grid-template-columns:1fr}.ob-lifecycle li>small{grid-column:2}}
  @media(pointer:coarse){.icon-button{width:34px;height:38px}.study{min-height:40px}.filters select{height:34px}.observation-row{min-height:49px}.add-picker{min-height:32px}.back{min-height:36px}}@media(prefers-reduced-motion:reduce){.observation-row{transition:none}}
</style>
