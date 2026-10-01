<script lang="ts">
  import {t,canonicalT,locale} from '../../../lib/i18n';
  import {untrack} from 'svelte';
  import type {WorkspacePanelProps} from '../panel-context';
  import PatternEvidence from '../../studies/PatternEvidence.svelte';
  import PatternCoverage from '../../studies/PatternCoverage.svelte';
  import PatternCandidates from '../../studies/PatternCandidates.svelte';
  import ReviewControls from '../../studies/ReviewControls.svelte';
  import {patternHistoryMode} from '../../../lib/patterns/selection';
  import {matchesPatternStage,patternIsActive,patternStageLabel} from '../../../lib/patterns/presentation';
  import type {PatternCandidateRow,PatternRow} from '../../../lib/patterns/types';
  import {matchesResonanceFilter,orderSignalTags,patternSignalTags,type ResonanceFilter,type SignalTag} from '../../../lib/patterns/signal-tags';
  import SignalTagChip from '../../studies/SignalTagChip.svelte';
  import {formatMarketPrice} from '../../../lib/core/market-format';
  import ToolIcon from '../../drawing/ToolIcon.svelte';

  let {context,density,zone}:WorkspacePanelProps=$props();
  let revision=$state(0),instanceFilter=$state('all'),direction=$state('all'),status=$state('all'),resonanceFilter=$state<ResonanceFilter>('all');
  let error=$state(''),selectionRevision=$state(0);
  let resultMode=$state<'confirmed'|'observing'>('confirmed');
  let detailColumn=$state<HTMLDivElement>();
  $effect(()=>{selectedKey;selectedCandidateKey;resultMode;if(detailColumn)detailColumn.scrollTop=0;});
  $effect(()=>context.controller.drawing.subscribe(()=>untrack(()=>revision++)));
  const studies=$derived.by(()=>{context.chartState;revision;return context.controller.getPatternStudies();});
  const rows=$derived.by(()=>{context.chartState;revision;return context.controller.getPatternRows();});
  const candidates=$derived.by(()=>{context.chartState;revision;return context.controller.getPatternCandidates();});
  const selectedKey=$derived.by(()=>{context.chartState;revision;selectionRevision;return context.controller.selectedPatternKey;});
  const selectedCandidateKey=$derived.by(()=>{context.chartState;revision;selectionRevision;return context.controller.selectedCandidateKey;});
  // Resonance is joined over the full pools of every layer, not only what is displayed; the row list just reads it.
  const resonance=$derived.by(()=>{context.chartState;revision;return context.controller.getPatternResonance();});
  const rowTags=$derived.by(()=>new Map<string,SignalTag[]>(rows.map(row=>[key(row),orderSignalTags([...patternSignalTags(row.pattern),...(resonance.get(key(row))??[])])])));
  const hasHarmonic=$derived(studies.some(study=>study.definitionId==='pattern-harmonic'));
  $effect(()=>{if(!hasHarmonic&&resonanceFilter!=='all')resonanceFilter='all';});
  const MAX_CHIPS=3;
  const selected=$derived(rows.find(row=>key(row)===selectedKey));
  const selectedCandidate=$derived(candidates.find(row=>candidateKey(row)===selectedCandidateKey));
  const filteredCandidates=$derived(candidates.filter(row=>(instanceFilter==='all'||row.instanceId===instanceFilter)
    &&(direction==='all'||row.candidate.direction===direction))
    .sort((a,b)=>b.candidate.observedAt-a.candidate.observedAt||a.candidate.id.localeCompare(b.candidate.id)));
  $effect(()=>{if(selectedCandidateKey)resultMode='observing';});
  $effect(()=>{if(selectedKey)resultMode='confirmed';});
  const selectedTolerance=$derived(selected?Number(context.controller.drawing.document.indicators.find(i=>i.instanceId===selected.instanceId)?.params.tolerance??.04):.04);
  const filtered=$derived(rows.filter(row=>(instanceFilter==='all'||row.instanceId===instanceFilter)
    &&(direction==='all'||row.pattern.direction===direction)&&matchesPatternStage(row.pattern,status)
    &&matchesResonanceFilter(resonanceFilter,rowTags.get(key(row))??[]))
    .sort((a,b)=>b.pattern.confirmedAt-a.pattern.confirmedAt||a.pattern.id.localeCompare(b.pattern.id)));
  const filteredStudy=$derived(studies.find(study=>study.instanceId===instanceFilter));
  const waiting=$derived(studies.some(study=>study.pending));
  const activeCount=$derived(rows.filter(row=>patternIsActive(row.pattern)).length);
  const excludedHistory=$derived.by(()=>{
    revision;
    return studies.filter(study=>(instanceFilter==='all'||study.instanceId===instanceFilter)
      &&patternHistoryMode(context.controller.drawing.document.indicators.find(instance=>instance.instanceId===study.instanceId)?.params??{})==='active');
  });
  $effect(()=>{if(instanceFilter!=='all'&&!studies.some(study=>study.instanceId===instanceFilter))instanceFilter='all';});
  const dateFormat=$derived(new Intl.DateTimeFormat($locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'}));
  const fullDateFormat=$derived(new Intl.DateTimeFormat($locale,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'}));
  const key=(row:PatternRow)=>`${row.instanceId}:${row.pattern.id}`;
  const candidateKey=(row:PatternCandidateRow)=>`${row.instanceId}:${row.candidate.id}`;
  const date=(time:number,full=false)=>(Number.isFinite(time)?(full?fullDateFormat:dateFormat).format(new Date(time)): '—');
  function add(id:string){
    error='';
    try{
      const instanceId=context.controller.addIndicator(id);
      if(!instanceId){error=context.controller.drawing.state.error||'未能添加形态识别器，请重试。';return;}
      instanceFilter=instanceId;
    }catch(reason){error=reason instanceof Error?reason.message:'未能添加形态识别器。';}
  }
  const canJump=(target:{instanceId:string;patternId:string})=>rows.some(row=>row.instanceId===target.instanceId&&row.pattern.id===target.patternId);
  function jump(target:{instanceId:string;patternId:string}){const row=rows.find(item=>item.instanceId===target.instanceId&&item.pattern.id===target.patternId);if(row)select(row);}
  function select(row:PatternRow){resultMode='confirmed';context.controller.selectPattern(row.instanceId,row.pattern.id,true);selectionRevision++;}
  function selectCandidate(row:PatternCandidateRow){resultMode='observing';context.controller.selectPatternCandidate(row.instanceId,row.candidate.id,true);selectionRevision++;}
  function settings(id:string){context.onOpenProperties([id]);}
  function toggle(id:string){const layer=context.controller.drawing.document.layers.find(layer=>layer.id===id);if(layer)context.controller.drawing.updateLayers([id],{visible:!layer.visible});}
  function listKeys(event:KeyboardEvent){
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    const list=(event.currentTarget as HTMLElement).closest('.pattern-list');
    const items=Array.from(list?.querySelectorAll<HTMLButtonElement>('.pattern-result')??[]);
    if(!items.length)return;
    event.preventDefault();
    const index=items.indexOf(document.activeElement as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[next]?.focus();
  }
</script>

<section class="patterns-panel" class:comfortable={density==='comfortable'} class:bottom={zone==='bottom'} aria-label={$t("形态策略工作区")}>
  <header class="panel-toolbar">
    <div class="market"><strong>{context.chartState.symbol}</strong><span>{context.chartState.source==='mock'?$t("模拟 · "):''}{context.chartState.interval}</span></div>
    <label class="add-picker" title={$t("添加独立的形态识别器，可分别设置参数和周期")}>
      <ToolIcon name="plus" size={13}/><span>{$t("添加")}</span>
      <select aria-label={$t("添加形态识别器")} value="" onchange={event=>{if(event.currentTarget.value)add(event.currentTarget.value);event.currentTarget.value='';}}>
        <option value="" disabled>{$t("添加形态识别器")}</option><option value="pattern-huzi">{$t("胡子形态")}</option><option value="pattern-harmonic">{$t("谐波形态")}</option><option value="pattern-confluence">{$t("量价共振形态")}</option>
      </select>
    </label>
  </header>
  {#if error}<div class="panel-error" role="alert">{$canonicalT(error)}<button aria-label={$t("关闭形态错误提示")} onclick={()=>error=''}><ToolIcon name="close" size={13}/></button></div>{/if}
  {#if !studies.length}
    <div class="panel-empty">
      <span class="empty-symbol"><ToolIcon name="pattern" size={30}/></span>
      <h3>{$t("让价格结构更清晰")}</h3>
      <p>{$t("添加识别器，在当前图表标注形态、关键比例和潜在反转区域。")}</p>
      <button class="add-empty" onclick={()=>add('pattern-huzi')}><ToolIcon name="pattern" size={17}/><span><strong>{$t("胡子形态")}</strong><small>{$t("三角、头肩、双底顶与通道旗形")}</small></span><ToolIcon name="plus" size={15}/></button>
      <button class="add-empty" onclick={()=>add('pattern-harmonic')}><ToolIcon name="fib" size={17}/><span><strong>{$t("谐波形态")}</strong><small>{$t("斐波那契比例与形态完成区")}</small></span><ToolIcon name="plus" size={15}/></button>
      <button class="add-empty" onclick={()=>add('pattern-confluence')}><ToolIcon name="layers" size={17}/><span><strong>{$t("量价共振形态")}</strong><small>{$t("顺势收敛突破与双背离反转 · 量能与赔率门控")}</small></span><ToolIcon name="plus" size={15}/></button>
      <p class="empty-footnote">{$t("只展示行情中符合规则的结构。形态确认不等于交易成交。")}</p>
    </div>
  {:else}
    <div class="study-manager" aria-label={$t("已挂载的形态识别器")}>
      {#each studies as study (study.instanceId)}
        {@const locked=context.controller.layerStatus(study.instanceId).locked}
        <div class="detector" class:muted={!study.visible} class:current={instanceFilter===study.instanceId}>
          <button class="detector-name" title={$t("{0} · 单击筛选，双击设置", {"0": String(study.name)})} aria-pressed={instanceFilter===study.instanceId} onclick={()=>instanceFilter=instanceFilter===study.instanceId?'all':study.instanceId} ondblclick={()=>settings(study.instanceId)}><ToolIcon name={study.definitionId==='pattern-harmonic'?'fib':study.definitionId==='pattern-confluence'?'layers':'pattern'} size={14}/><span>{study.name}</span><small>{study.timeframe}</small></button>
          <span class="detector-count" title={study.pending?$t("正在识别当前行情"):$t("已识别的形态数量")}>{study.pending?'…':study.count}</span>
          <div class="detector-actions">
            <button aria-label={`${study.visible?$t("隐藏"):$t("显示")} ${study.name}`} title={locked?$t("图层已锁定"):study.visible?$t("隐藏图表标注"):$t("显示图表标注")} disabled={locked} onclick={()=>toggle(study.instanceId)}><ToolIcon name={study.visible?'eye':'hidden'} size={14}/></button>
            <button aria-label={$t("设置 {0}", {"0": String(study.name)})} title={$t("设置参数、周期与样式")} onclick={()=>settings(study.instanceId)}><ToolIcon name="gear" size={14}/></button>
            <button aria-label={$t("删除 {0}", {"0": String(study.name)})} title={locked?$t("图层已锁定"):$t("删除此识别器")} disabled={locked} onclick={()=>context.controller.drawing.removeLayers([study.instanceId])}><ToolIcon name="trash" size={14}/></button>
          </div>
        </div>
      {/each}
    </div>
    <div class="panel-workspace" class:no-detail={resultMode==='observing'?!selectedCandidate:!selected}>
      <div class="results-column">
        <div class="results-summary"><span>{$t("识别结果")} <b>{rows.length}</b></span><span title={$t("已确认且尚未收回框架或收盘失效的结构")}>{$t("成立")} <b>{activeCount}</b></span>{#if waiting}<span role="status">{$t("更新中…")}</span>{/if}</div>
        <div class="result-modes" role="group" aria-label={$t("形态结果类型")}>
          <button class:active={resultMode==='confirmed'} aria-pressed={resultMode==='confirmed'} title={$t("已满足确认条件的历史形态")} onclick={()=>resultMode='confirmed'}>{$t("已确认")} <span>{rows.length}</span></button>
          <button class:active={resultMode==='observing'} aria-pressed={resultMode==='observing'} title={$t("当前正在形成的结构，可能更新或撤销，尚非交易信号")} onclick={()=>resultMode='observing'}>{$t("观察中")} <span>{candidates.length}</span><i aria-hidden="true"></i></button>
        </div>
        <div class="result-filters">
          <select aria-label={$t("筛选形态识别器")} bind:value={instanceFilter} title={$t("筛选形态识别器")}><option value="all">{$t("全部识别器")}</option>{#each studies as study (study.instanceId)}<option value={study.instanceId}>{study.name} · {study.timeframe}</option>{/each}</select>
          <select aria-label={$t("筛选形态方向")} bind:value={direction} title={resultMode==='observing'?$t("仅筛选潜在反转方向，胡子观察结构为中性"):$t("筛选形态方向")}><option value="all">{$t("方向")}</option><option value="bullish">{resultMode==='observing'?$t("潜在向上"):$t("看涨")}</option><option value="bearish">{resultMode==='observing'?$t("潜在向下"):$t("看跌")}</option>{#if resultMode==='observing'||direction==='neutral'}<option value="neutral">{$t("待定")}</option>{/if}</select>
          <select aria-label={$t("筛选形态状态")} bind:value={status} disabled={resultMode==='observing'} title={resultMode==='observing'?$t("观察结构尚未确认，不适用突破与失效筛选"):$t("筛选形态状态")}><option value="all">{$t("全部状态")}</option><option value="confirmed">{$t("仍成立")}</option><option value="resolved">{$t("已达标")}</option><option value="ended">{$t("已走完")}</option><option value="breakout">{$t("已突破")}</option><option value="retest">{$t("回踩 / 反抽")}</option><option value="failed-breakout">{$t("突破回落")}</option><option value="invalidated">{$t("已失效")}</option></select>
          {#if hasHarmonic}<select class="resonance-filter" aria-label={$t("筛选谐波共振信号")} bind:value={resonanceFilter} disabled={resultMode==='observing'} title={$t("只对谐波形态有意义；选择后其他形态会被隐藏")}><option value="all">{$t("共振")}</option><option value="macd">{$t("有 MACD 背离")}</option><option value="atr">{$t("2ATR 未扎")}</option><option value="terminal">{$t("有末端结构")}</option><option value="multi">{$t("有多周期共振")}</option></select>{/if}
        </div>
        {#if resultMode==='confirmed'&&status==='invalidated'&&excludedHistory.length}<div class="history-note"><p>{$t("当前筛选中的")} {excludedHistory.length} {$t("个识别器正在使用「不展示失效结构」过滤。")}</p><button onclick={()=>settings(excludedHistory[0].instanceId)} title={$t("在输入参数中选择全部确认历史")}>{$t("查看设置")}</button></div>{/if}
        {#if filteredStudy?.scan}<p class="scan-note" title={`${date(filteredStudy.scan.fromTime,true)} — ${date(filteredStudy.scan.throughTime,true)} UTC\n${$canonicalT(filteredStudy.scan.note)}`}>{$t("已扫描")} {filteredStudy.scan.bars.toLocaleString($locale)} {$t("根 · 至少")} {filteredStudy.scan.confirmationBars} {$t("根右侧收盘确认")}</p>{/if}
        <PatternCoverage studies={filteredStudy?[filteredStudy]:studies} chartState={context.chartState} loading={context.chartState.patternHistoryLoading} error={context.chartState.patternHistoryError} onHistory={()=>void context.controller.loadPatternHistory()} onSettings={settings} onShowHistory={id=>context.controller.setParam(id,'historyDisplay','all')} onLatest={()=>context.controller.followLatest()} onRescan={()=>context.controller.rescanPatterns()}/>
        {#if resultMode==='observing'}
          <PatternCandidates rows={filteredCandidates} selectedKey={selectedCandidateKey} {waiting} onSelect={selectCandidate} onSettings={settings}/>
        {:else}
        <div class="pattern-list" role="group" aria-label={$t("已识别形态，按确认时间倒序")}>
          {#each filtered as row (key(row))}
            <button class="pattern-result" onkeydown={listKeys} class:chosen={selectedKey===key(row)} class:invalidated={row.pattern.status==='invalidated'} class:failed-breakout={row.pattern.stage==='failed-breakout'} aria-pressed={selectedKey===key(row)} title={$t("{0} · {1}\n确认于 {2} UTC\n单击定位到图表；双击设置", {"0": String($canonicalT((row.pattern.name)??'')), "1": String(row.pattern.direction==='bullish'?$t("看涨"):$t("看跌")), "2": String(date(row.pattern.confirmedAt,true))})} onclick={()=>select(row)} ondblclick={()=>settings(row.instanceId)}>
              <span class="direction" class:bullish={row.pattern.direction==='bullish'} class:bearish={row.pattern.direction==='bearish'}><ToolIcon name={row.pattern.direction==='bullish'?'mark-up':'mark-down'} size={14}/></span>
              <span class="result-copy"><strong>{$canonicalT((row.pattern.name)??'')}{#if row.pattern.context}<em class="context-tag" class:continuation={row.pattern.context.kind==='continuation'}>{$t(row.pattern.context.kind==='continuation'?'中继':'反转')}</em>{/if}</strong><small>{row.layerName} · {row.timeframe}{#if !row.visible} {$t("· 已隐藏")}{/if}</small>
                {#if rowTags.get(key(row))?.length}{@const tags=rowTags.get(key(row))!}<span class="signal-tags">{#each tags.slice(0,MAX_CHIPS) as tag (`${tag.kind}:${tag.label}:${tag.target?.patternId??''}`)}<SignalTagChip {tag}/>{/each}{#if tags.length>MAX_CHIPS}<em class="signal-more" title={$t("另有 {0} 个信号标签",{"0":String(tags.length-MAX_CHIPS)})}>+{tags.length-MAX_CHIPS}</em>{/if}</span>{/if}</span>
              <span class="result-meta"><time datetime={new Date(row.pattern.confirmedAt).toISOString()}>{date(row.pattern.confirmedAt)}</time><small>{row.pattern.direction==='bullish'?$t("上破 / 多"):$t("下破 / 空")} · {$canonicalT((patternStageLabel(row.pattern))??'')}</small></span>
            </button>
          {:else}
            <div class="results-empty" role="status"><ToolIcon name="search" size={23}/><strong>{waiting?$t("正在识别行情结构"):status==='invalidated'&&excludedHistory.length?$t("尚未包含失效历史"):$t("暂无符合条件的形态")}</strong><p>{status==='invalidated'&&excludedHistory.length?$t("在识别器的输入参数中开启「包含已失效形态」，重新识别后会显示对应历史。"):rows.length?$t("切换识别器、方向或状态筛选查看其他结果。"):$t("识别器会随已收盘 K 线更新。可调整参数或切换周期，识别结果取决于已加载的行情范围。")}</p>{#if rows.length}<button onclick={()=>{instanceFilter='all';direction='all';status='all';}}>{$t("清除筛选")}</button>{/if}</div>
          {/each}
        </div>
        {/if}
        <footer class="list-footer"><span>{resultMode==='observing'?$t("当前结构 · 未确认"):$t("确认时间 · UTC")}</span><span>{$t("单击定位 / 双击设置")}</span></footer>
      </div>
      <div class="detail-column" bind:this={detailColumn}>
        {#if resultMode==='observing'}
          <PatternCandidates mode="detail" row={selectedCandidate} onSelect={selectCandidate} onSettings={settings}/>
        {:else if selected}
          {@const match=selected.pattern}
          <section class="pattern-detail" aria-label={$t("所选形态详情")}>
            <header class="detail-header"><div><span class="detail-eyebrow">{$t("形态解析")}</span><h3>{$canonicalT((match.name)??'')}<small class:bullish={match.direction==='bullish'} class:bearish={match.direction==='bearish'}>{match.direction==='bullish'?$t("看涨"):$t("看跌")}</small></h3></div><button title={$t("再次定位此形态")} aria-label={$t("定位所选形态")} onclick={()=>select(selected)}><ToolIcon name="fit" size={16}/></button><button title={$t("设置所属识别器")} aria-label={$t("设置所选形态识别器")} onclick={()=>settings(selected.instanceId)}><ToolIcon name="gear" size={16}/></button></header>
            {#if !selected.visible}<button class="hidden-notice" onclick={()=>settings(selected.instanceId)}><ToolIcon name="hidden" size={14}/>{$t("图层或输出当前不可见 · 查看显示设置")}</button>{/if}
            <PatternEvidence pattern={match} tags={rowTags.get(key(selected))??[]} {canJump} onJump={jump}/>
            <details class="rule-explanation"><summary>{$t("识别依据与限制")} <span>{$t("容差")} {(selectedTolerance*100).toFixed(1)}%</span></summary><p class="description">{$canonicalT((match.description)??'')}</p></details>
            <dl class="key-levels"><div><dt>{match.family.startsWith('huzi')?$t("关键区域"):$t("潜在反转区 PRZ")}</dt><dd>{formatMarketPrice(match.zone.low)} <span>—</span> {formatMarketPrice(match.zone.high)}</dd></div><div><dt>{$t("失效参考价")}</dt><dd class="invalidation">{formatMarketPrice(match.invalidation)}</dd></div>{#each match.targets as target,index}<div><dt>{$t("参考目标")} {index+1}</dt><dd>{formatMarketPrice(target)}</dd></div>{/each}</dl>
            {#if match.ratios.length}<table class="ratio-table"><caption>{$t("结构比例校验")}</caption><thead><tr><th scope="col">{$t("比例")}</th><th scope="col">{$t("实际")}</th><th scope="col">{$t("规则")}</th></tr></thead><tbody>{#each match.ratios as ratio}<tr><th scope="row">{$canonicalT(ratio.label)}</th><td>{ratio.value.toFixed(3)}</td><td>{$canonicalT(ratio.expected)}</td></tr>{/each}</tbody></table>{/if}
            <dl class="confirmation"><div><dt>{$t("确认时间")}</dt><dd>{date(match.confirmedAt,true)} UTC</dd></div>{#if match.invalidatedAt}<div><dt>{$t("失效时间")}</dt><dd>{date(match.invalidatedAt,true)} UTC</dd></div>{:else if match.resolution}<div><dt>{$t("达标时间")}</dt><dd>{date(match.resolution.knownAt,true)} UTC</dd></div>{:else if match.observationEndedAt!==undefined}<div><dt>{$t("观察结束")}</dt><dd>{date(match.observationEndedAt,true)} UTC</dd></div>{/if}</dl>
            <details class="anchor-details"><summary>{$t("查看结构锚点")} <span>{match.points.length}</span></summary><table><thead><tr><th scope="col">{$t("点")}</th><th scope="col">{$t("价格")}</th><th scope="col">{$t("UTC 时间")}</th></tr></thead><tbody>{#each match.points as point}<tr><th scope="row">{$canonicalT(point.label)}</th><td>{formatMarketPrice(point.value)}</td><td title={date(point.time,true)}>{date(point.time)}</td></tr>{/each}</tbody></table></details>
            <ReviewControls {context} kind="pattern" instanceId={selected.instanceId} sourceId={match.id}/>
            <p class="confirmation-note">{$t("锚点标在结构发生处，确认时间晚于锚点。关键价位用于结构观察，不是委托或回测成交。")}</p>
          </section>
        {:else}<div class="detail-placeholder"><ToolIcon name="cross" size={20}/><p>{$t("选择一个形态")}<br/><span>{$t("查看比例、关键价位与确认依据")}</span></p></div>{/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .result-modes{display:flex;gap:14px;min-height:29px;padding:0 10px;margin-bottom:7px;border-bottom:1px solid var(--line);flex-shrink:0}.result-modes button{display:flex;gap:5px;align-items:center;padding:4px 1px 7px;border-bottom:2px solid transparent;font-size:11px;color:var(--text-dim);position:relative}.result-modes button:hover{color:var(--text-strong)}.result-modes button.active{border-bottom-color:var(--accent);color:var(--text-strong)}.result-modes button span{font:10px var(--mono);font-variant-numeric:tabular-nums;color:var(--text-dim)}.result-modes button i{display:block;width:12px;border-top:1px dashed var(--warn);margin-left:2px}.result-filters select:disabled{opacity:.4;cursor:default}
  .rule-explanation{margin:12px 0;border-block:1px solid var(--line-strong);padding:9px 0;font-size:11px;color:var(--text-dim)}.rule-explanation summary{cursor:pointer}.rule-explanation summary span{float:right;color:var(--text-dim);font-size:10px}.rule-explanation .description{margin-bottom:0}
  .result-filters .resonance-filter{grid-column:1/-1}
  .signal-tags{display:flex;flex-wrap:wrap;gap:4px;min-width:0}.signal-more{padding:1px 5px;border-radius:var(--radius-xs);font:500 10px/1.3 var(--font);font-style:normal;color:var(--text-dim);background:var(--bg-hover)}
  .context-tag{margin-left:6px;padding:1px 5px;border-radius:var(--radius-xs);font:500 10px/1.3 var(--font);font-style:normal;color:var(--warn);background:var(--warn-soft);vertical-align:1px}.context-tag.continuation{color:var(--accent-strong);background:var(--accent-soft)}
  .patterns-panel{width:100%;height:100%;display:flex;flex-direction:column;min-width:0;min-height:0;color:var(--text);font-size:11px;background:var(--bg-panel)}.panel-toolbar{height:37px;min-height:37px;padding:0 10px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px}.market{display:flex;align-items:center;gap:8px;min-width:0;flex:1}.market strong{font:600 11px var(--mono);text-overflow:ellipsis;overflow:hidden;white-space:nowrap}.market>span{font:11px var(--mono);color:var(--text-dim)}.add-picker{position:relative;display:flex;align-items:center;gap:4px;height:25px;padding:0 7px;border:1px solid var(--line-strong);color:var(--accent-strong);cursor:pointer}.add-picker:hover,.add-picker:focus-within{background:var(--bg-active);border-color:var(--line-strong)}.add-picker select{position:absolute;inset:0;width:100%;opacity:0;cursor:pointer}.panel-error{padding:8px 10px;display:flex;gap:7px;align-items:flex-start;color:var(--down);border-bottom:1px solid var(--line-strong);font-size:11px;line-height:1.6}.panel-error button{padding:2px;margin-left:auto;display:flex}.panel-empty{padding:28px 18px;overflow:auto;display:flex;flex-direction:column;align-items:stretch}.empty-symbol{color:var(--text-dim)}.panel-empty h3{font-size:14px;font-weight:550;margin:16px 0 8px;color:var(--text-strong)}.panel-empty p{font-size:11px;color:var(--text-dim);line-height:1.8;margin:0 0 21px;text-wrap:pretty}.add-empty{display:flex;align-items:center;gap:10px;padding:12px 10px;border:1px solid var(--line-strong);text-align:left;margin-bottom:8px;color:var(--accent-strong);background:var(--surface-raised);transition:background-color 120ms,border-color 120ms}.add-empty:hover{border-color:var(--line-strong);background:var(--bg-active)}.add-empty>span{display:flex;flex-direction:column;flex:1;gap:5px}.add-empty strong{font-size:12px;font-weight:500;color:var(--text-strong)}.add-empty small{font-size:10px;color:var(--text-dim)}.panel-empty .empty-footnote{font-size:10px;margin:15px 0 0;color:var(--text-dim)}.study-manager{flex-shrink:0;padding:4px 0;border-bottom:1px solid var(--line);max-height:154px;overflow:auto}.detector{display:flex;align-items:center;min-height:32px;padding:0 6px 0 7px;border-left:2px solid transparent;gap:3px}.detector.current{border-left-color:var(--accent);background:var(--bg-hover)}.detector:hover{background:var(--bg-hover)}.detector.muted .detector-name{color:var(--text-dim)}.detector-name{display:flex;align-items:center;gap:6px;min-width:0;flex:1;padding:5px 0;text-align:left;font-size:11px;white-space:nowrap}.detector-name>span{overflow:hidden;text-overflow:ellipsis}.detector-name small{margin-left:auto;font:10px var(--mono);color:var(--text-dim)}.detector-count{font:10px var(--mono);color:var(--text-dim);text-align:center;min-width:21px}.detector-actions{display:flex}.detector-actions button{display:flex;align-items:center;justify-content:center;width:23px;height:25px;padding:0;color:var(--text-dim)}.detector-actions button:hover{color:var(--text-strong);background:var(--bg-active)}.detector-actions button:disabled{opacity:.35;cursor:default}.panel-workspace{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}.results-column{display:flex;flex-direction:column;min-height:170px;flex:0 0 36%;max-height:320px;overflow:auto}.results-summary{display:flex;align-items:center;gap:12px;min-height:32px;padding:0 10px;color:var(--text-dim);flex-shrink:0}.results-summary span:last-child{margin-left:auto}.results-summary b{font:11px var(--mono);color:var(--text);margin-left:3px}.result-filters{display:grid;grid-template-columns:minmax(0,1fr) 68px 88px;gap:5px;padding:0 9px 8px;flex-shrink:0}.result-filters select{min-width:0;max-width:100%;height:26px;min-height:26px;background-color:var(--bg-panel);border:1px solid var(--line-strong);color:var(--text);font:11px var(--font);padding:0 22px 0 6px}.history-note{margin:0 9px 8px;padding:7px;border:1px solid var(--line-strong);background:var(--bg-hover);color:var(--text-dim);font-size:10px;line-height:1.6;display:flex;gap:7px;align-items:center}.history-note p{margin:0;flex:1}.history-note button{font-size:10px;padding:4px 5px;color:var(--text);white-space:nowrap;background:var(--bg-active)}.scan-note{font-size:10px;color:var(--text-dim);padding:0 10px;margin:0 0 7px;line-height:1.5}.pattern-list{overflow:auto;min-height:80px;flex:1}.pattern-result{display:flex;align-items:center;gap:6px;width:100%;min-height:45px;padding:7px 9px;border-top:1px solid var(--line);border-left:2px solid transparent;text-align:left;transition:background-color 100ms,border-color 100ms}.pattern-result:hover{background:var(--bg-hover)}.pattern-result.chosen{background:var(--bg-active);border-left-color:var(--accent)}.direction{width:16px;display:flex;flex-shrink:0}.bullish{color:var(--up)}.bearish{color:var(--down)}.result-copy{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}.result-copy strong{font-size:11px;font-weight:500;color:var(--text);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.result-copy small{font-size:10px;color:var(--text-dim);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.result-meta{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex-shrink:0}.result-meta time{font:10px var(--mono);font-variant-numeric:tabular-nums;color:var(--text)}.result-meta small{font-size:10px;color:var(--text-dim)}.failed-breakout .result-meta small{color:var(--warn)}.invalidated .result-copy strong,.invalidated .direction{color:var(--text-dim)}.results-empty{min-height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px 22px;color:var(--text-dim);gap:9px;text-align:center}.results-empty strong{font-size:11px;font-weight:500;color:var(--text)}.results-empty p{margin:0;font-size:10px;line-height:1.9;color:var(--text-dim);text-wrap:pretty}.results-empty button{padding:5px 9px;margin-top:3px;border:1px solid var(--line-strong);font-size:10px;color:var(--accent-strong)}.list-footer{display:flex;justify-content:space-between;gap:6px;min-height:24px;align-items:center;font-size:10px;color:var(--text-dim);padding:0 10px;border-block:1px solid var(--line);flex-shrink:0}.detail-column{flex:1 1 0;min-height:0;overflow:auto}.detail-placeholder{padding:20px 12px;display:flex;align-items:center;justify-content:center;gap:10px;color:var(--text-dim)}.detail-placeholder p{margin:0;font-size:11px;line-height:1.8;color:var(--text)}.detail-placeholder span{font-size:10px;color:var(--text-dim)}.pattern-detail{padding:13px 11px 11px}.detail-header{display:flex;align-items:center;gap:3px}.detail-header>div{min-width:0;flex:1}.detail-eyebrow{font-size:10px;letter-spacing:.7px;color:var(--text-dim)}.detail-header h3{font-size:13px;font-weight:550;line-height:1.5;margin:4px 0 0;color:var(--text-strong);display:flex;align-items:center;gap:8px;flex-wrap:wrap}.detail-header h3 small{font-size:10px;font-weight:400}.detail-header>button{width:25px;height:27px;padding:0;display:flex;align-items:center;justify-content:center;color:var(--text-dim)}.detail-header>button:hover{background:var(--bg-active)}.hidden-notice{display:flex;align-items:center;gap:6px;font-size:10px;background:var(--bg-active);color:var(--accent-strong);padding:7px;width:100%;margin-top:10px;text-align:left}.hidden-notice:disabled{opacity:.5;cursor:default}.description{font-size:10px;line-height:1.8;color:var(--text-dim);margin:12px 0;text-wrap:pretty}.key-levels{padding:8px 0;margin:0;border-block:1px solid var(--line-strong);display:flex;flex-direction:column;gap:9px}.key-levels>div{display:flex;flex-wrap:wrap;align-items:baseline;gap:5px 8px;justify-content:space-between}.key-levels dt{font-size:10px;color:var(--text-dim)}.key-levels dd{margin:0;font:11px var(--mono);font-variant-numeric:tabular-nums;color:var(--text-strong);text-align:right;overflow-wrap:anywhere}.key-levels dd span{color:var(--text-muted)}.key-levels .invalidation{color:var(--down)}.ratio-table{width:100%;margin-top:15px;border-collapse:collapse;table-layout:auto}.ratio-table caption{text-align:left;font-size:10px;color:var(--text);margin-bottom:8px}.ratio-table th,.ratio-table td{padding:6px 0;border-bottom:1px solid var(--line);text-align:right;font:10px var(--mono);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.ratio-table th:first-child{text-align:left;color:var(--text)}.ratio-table thead th{font:10px var(--font);color:var(--text-dim)}.ratio-table tbody td:last-child{color:var(--text-dim);padding-left:9px}.confirmation{display:flex;flex-direction:column;gap:6px;margin:13px 0 0;font-size:10px}.confirmation>div{display:flex;justify-content:space-between;gap:6px}.confirmation dt{color:var(--text-dim)}.confirmation dd{font:10px var(--mono);font-variant-numeric:tabular-nums;margin:0;color:var(--text)}.anchor-details{margin-top:12px;border-top:1px solid var(--line);padding-top:10px;font-size:10px;color:var(--text-dim)}.anchor-details summary{cursor:pointer;line-height:1.5}.anchor-details summary span{font:10px var(--mono);margin-left:5px;color:var(--text-dim)}.anchor-details table{width:100%;border-collapse:collapse;font:10px var(--mono);margin-top:7px}.anchor-details th,.anchor-details td{text-align:right;padding:5px 0;font-weight:400}.anchor-details th:first-child{text-align:left}.anchor-details thead{color:var(--text-dim)}.confirmation-note{font-size:10px;color:var(--text-dim);line-height:1.8;margin:12px 0 0;text-wrap:pretty}.comfortable .detector{min-height:38px}.comfortable .pattern-result{min-height:53px}.patterns-panel :is(button,select):focus-visible{outline:1px solid var(--accent);outline-offset:-1px}.bottom .panel-workspace{display:grid;grid-template-columns:minmax(280px,1fr) minmax(280px,1fr);overflow:hidden}.bottom .results-column{min-height:0;min-width:0;max-height:none}.bottom .detail-column{overflow:auto;border-left:1px solid var(--line-strong)}.bottom .pattern-detail{padding:14px 18px}.bottom .detail-placeholder{height:100%}@container(max-width:599px){.bottom .panel-workspace{display:flex;overflow:auto}.bottom .detail-column{overflow:visible;border-left:0}}@media(prefers-reduced-motion:reduce){.pattern-result,.add-empty{transition:none}}@media(pointer:coarse){.detector-actions button{width:31px;height:34px}.result-filters select{height:32px}.detector{min-height:38px}.pattern-result{min-height:54px}}
  .study-manager{flex-shrink:1;min-height:0;max-height:min(154px,25%)}
  .results-column{flex:0 1 44%;min-height:min(220px,60%);max-height:none;overscroll-behavior:contain}
  .results-column>.pattern-list,.results-column :global(.candidate-list){flex:1 0 96px}
  .detail-column{overscroll-behavior:contain}
  .panel-workspace.no-detail .results-column{flex:1 1 0;min-height:0;max-height:none}
  .panel-workspace.no-detail .detail-column{display:none}
  .bottom .panel-workspace.no-detail{grid-template-columns:minmax(0,1fr)}
  @container(max-width:599px){.bottom .panel-workspace{overflow:hidden}.bottom .detail-column{overflow:auto;min-height:0}}
</style>
