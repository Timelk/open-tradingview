<script lang="ts">
  import {t,locale} from '../../../lib/i18n';
  import {untrack} from 'svelte';
  import type {WorkspacePanelProps} from '../panel-context';
  import Patterns from './Patterns.svelte';
  import AnalysisObservations from '../../studies/AnalysisObservations.svelte';
  import TradeFlowPanel from '../../studies/TradeFlowPanel.svelte';
  import AnalysisResearch from '../../studies/AnalysisResearch.svelte';
  let {context,density,zone,active=true,onClose}:WorkspacePanelProps=$props();
  let mode=$state<'patterns'|'observations'|'flow'|'research'>('patterns'),revision=$state(0);
  $effect(()=>context.controller.drawing.subscribe(()=>untrack(()=>revision++)));
  const analytical=$derived.by(()=>{context.chartState;revision;return context.controller.selectedAnalysisKey;});
  const pattern=$derived.by(()=>{context.chartState;revision;return context.controller.selectedPatternKey??context.controller.selectedCandidateKey;});
  $effect(()=>{if(analytical)mode='observations';});
  $effect(()=>{if(pattern)mode='patterns';});
  let previousCount=0;
  $effect(()=>{revision;const count=context.controller.drawing.document.indicators.filter(i=>context.controller.registry.list().some(d=>d.id===i.id&&d.category==='analysis')).length;if(count>previousCount&&untrack(()=>mode!=='research'&&mode!=='flow'))mode='observations';previousCount=count;});
</script>
<section class="analysis-workspace" aria-label={$t("技术分析工作台")}><nav aria-label={$t("分析工作区内容")}><button aria-pressed={mode==='patterns'} onclick={()=>mode='patterns'} title={$t("胡子和谐波的已确认 / 观察中结构")}>{$t("图表形态")}</button><button aria-pressed={mode==='observations'} onclick={()=>mode='observations'} title={$t("K线、市场结构、供需、VSA、威科夫证据")}>{$t("结构与量价")}</button><button aria-pressed={mode==='flow'} onclick={()=>mode='flow'} title={$t("公开成交流、逐价分布与盘口；只在显示时订阅")}>{$t("成交")}</button><button aria-pressed={mode==='research'} onclick={()=>mode='research'} title={$t("逐柱回放、自验收、人工复核和手动锚点")}>{$t("研究")}</button></nav>
  <div hidden={mode!=='patterns'}><Patterns {context} {density} {zone} {onClose} active={active&&mode==='patterns'}/></div>
  <div hidden={mode!=='observations'}><AnalysisObservations {context} {density} {zone}/></div>
  <div hidden={mode!=='flow'}><TradeFlowPanel {context} {density} {zone} {onClose} active={active&&mode==='flow'}/></div>
  <div hidden={mode!=='research'}><AnalysisResearch {context} {density} {zone} {onClose} active={active&&mode==='research'}/></div>
</section>
<style>.analysis-workspace{width:100%;min-width:0;flex:1;height:100%;min-height:0;display:flex;flex-direction:column}.analysis-workspace>nav{display:flex;gap:2px;border-bottom:1px solid var(--line-strong);background:var(--bg-panel);padding:0 7px;flex-shrink:0}.analysis-workspace>nav button{padding:8px 7px;font-size:11px;border-bottom:2px solid transparent;color:var(--text-dim)}.analysis-workspace>nav button[aria-pressed=true]{border-color:var(--accent);color:var(--text-strong);background:var(--bg-hover)}.analysis-workspace>nav button:hover{color:var(--text-strong);background:var(--bg-active)}.analysis-workspace>nav button:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}.analysis-workspace>div{flex:1;min-height:0;overflow:hidden}.analysis-workspace>div[hidden]{display:none}</style>
