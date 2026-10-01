<script lang="ts">
  import {t} from '../lib/i18n';
  import { drawingPlugins } from '../plugins/drawing-tools';
  import { onMount } from 'svelte';
  import ToolIcon from './drawing/ToolIcon.svelte';
  import { ChartController, type ChartState, type DrawingSelection, type StudyPaneLayout } from '../lib/chart/controller';
  export let onState: (s:ChartState)=>void;
  export let onDrawingSelection:(selection:DrawingSelection|null)=>void=()=>{};
  export let onOpenProperties:(ids:string[])=>void=()=>{};
  export let onPatternSelection:()=>void=()=>{};
  export let onPaneLayout:(panes:StudyPaneLayout[])=>void=()=>{};
  export let onReady: (c:ChartController)=>void;
  export let onOpenAppearance:()=>void=()=>{};
  let host: HTMLDivElement, gpu: HTMLCanvasElement, cpu: HTMLCanvasElement, overlay: HTMLCanvasElement;
  onMount(()=>{
    const controller=new ChartController(host,gpu,cpu,overlay,onState,drawingPlugins.core);
    controller.interactiveStudyLabels=true;controller.onPaneLayout=panes=>onPaneLayout(panes);
    controller.onDrawingSelection=(selection)=>onDrawingSelection(selection);
    controller.onOpenProperties=(ids)=>onOpenProperties(ids);
    controller.onPatternSelection=()=>onPatternSelection();
    if(import.meta.env.DEV)Object.assign(window,{__chart:controller});
    onReady(controller);
    return ()=>{controller.destroy();if(import.meta.env.DEV)delete (window as unknown as {__chart?:ChartController}).__chart;};
  });
</script>
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="chart-host" bind:this={host} tabindex="0" role="application" aria-label={$t("交互 K 线图。拖拽平移，滚轮缩放，方向键平移，拖右侧刻度缩放价格，拖分隔线调整窗格高度，Home 全部历史，End 返回最新。")}>
  <canvas bind:this={gpu} aria-hidden="true"></canvas>
  <canvas bind:this={cpu} aria-hidden="true"></canvas>
  <canvas bind:this={overlay} aria-hidden="true"></canvas>
</div>
<button class="chart-appearance-entry" aria-label={$t('图表外观设置')} title={$t('图表外观设置')} aria-haspopup="dialog" on:click={onOpenAppearance}><ToolIcon name="gear" size={15}/><span>{$t('外观')}</span></button>
<style>
  .chart-host{position:absolute;inset:0;cursor:crosshair;touch-action:none;outline:none;overflow:hidden}
  .chart-host:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}
  canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
  .chart-appearance-entry{position:absolute;right:0;bottom:0;z-index:4;width:87px;height:26px;display:flex;align-items:center;justify-content:center;gap:6px;padding:0 8px;background:var(--chart-glass-bg,var(--bg));color:var(--chart-glass-text-muted,var(--text-dim));border:0;border-top:1px solid var(--chart-glass-border,var(--line));border-left:1px solid var(--chart-glass-border,var(--line));border-radius:0;backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));-webkit-backdrop-filter:var(--chart-glass-blur,blur(10px) saturate(135%));font-size:11px;font-weight:500;cursor:pointer;touch-action:manipulation}
  .chart-appearance-entry:hover,.chart-appearance-entry:focus-visible{background:var(--chart-glass-bg-hover,var(--bg-hover));color:var(--chart-glass-text,var(--text))}
  .chart-appearance-entry:focus-visible{outline:2px solid var(--accent);outline-offset:-3px}
  .chart-appearance-entry:active{color:var(--accent)}
  @media(pointer:coarse){.chart-appearance-entry{height:40px;bottom:0}}
</style>
