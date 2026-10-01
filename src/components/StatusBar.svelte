<script lang="ts">
  import {onMount} from 'svelte';
  import {t,locale,formatNumber} from '../lib/i18n';
  import type {ChartState} from '../lib/chart/controller';
  import {connectorConfigStore} from '../lib/market/connector-config';
  import {chartConnectionPresentation} from '../lib/chart/status-presentation';
  import AgentBridgeStatus from './AgentBridgeStatus.svelte';
  export let state:ChartState;
  export let onRebuild:()=>void;
  let configs=connectorConfigStore.list(),diagnostics:HTMLDetailsElement,trigger:HTMLElement;
  onMount(()=>connectorConfigStore.subscribe(value=>configs=value));
  $: connection=chartConnectionPresentation(state,configs.find(c=>c.source===state.source)?.mode);
  function dismiss(event:PointerEvent){if(diagnostics?.open&&event.target instanceof Node&&!diagnostics.contains(event.target))diagnostics.open=false;}
  function keydown(event:KeyboardEvent){if(event.key==='Escape'&&diagnostics?.open){const inside=event.target instanceof Node&&diagnostics.contains(event.target);diagnostics.open=false;if(inside){event.preventDefault();event.stopPropagation();trigger?.focus();}}}
</script>
<svelte:window on:pointerdown={dismiss} on:keydown|capture={keydown}/>
<footer class="statusbar">
  <span class="connection" data-state={connection.tone}><i></i>{$t(connection.label)}</span>
  <span class="mode">{$t(connection.badge)}</span>
  <AgentBridgeStatus/>
  <div class="spacer"></div>
  <details bind:this={diagnostics} class="diagnostics">
    <summary bind:this={trigger} aria-label={$t('行情与性能诊断')}>{$t('诊断')}</summary>
    <section aria-label={$t('行情与性能诊断')}>
      <strong>{$t('行情与性能诊断')}</strong>
      {#if state.error||state.warning}<p role="status">{$t(state.error||state.warning)}</p>{/if}
      <dl>
        <dt>{$t('已加载 K 线')}</dt><dd>{formatNumber(state.total,{},$locale)}</dd>
        <dt>{$t('可见 / 绘制')}</dt><dd>{formatNumber(state.visible,{},$locale)} / {formatNumber(state.rendered,{},$locale)}</dd>
        <dt>LOD</dt><dd>{state.factor}×</dd><dt>FPS</dt><dd>{state.fps||'—'}</dd>
        <dt>{$t('绘制耗时')}</dt><dd>{state.renderMs.toFixed(1)} ms</dd><dt>Tick</dt><dd>{state.tickMs.toFixed(2)} ms</dd>
        <dt>{$t('渲染后端')}</dt><dd>{state.backend}</dd><dt>{$t('计算位置')}</dt><dd>{state.engine==='worker'?'Worker':state.engine==='—'?'—':$t('主线程')}</dd>
      </dl>
      {#if state.backend==='Canvas2D'}<button on:click={onRebuild}>{$t('重建渲染')}</button>{/if}
    </section>
  </details>
</footer>
<style>
  .statusbar{position:relative;display:flex;align-items:center;gap:10px;height:26px;min-height:26px;padding:0 10px;border-top:1px solid var(--line);background:var(--bg-panel);font:11px/1 var(--font);color:var(--text-dim);white-space:nowrap;z-index:12}.connection{display:inline-flex;align-items:center;gap:6px}.connection i{width:5px;height:5px;border-radius:50%;background:var(--up)}.connection[data-state=waiting] i,.connection[data-state=simulation] i{background:var(--accent)}.connection[data-state=error]{color:var(--down)}.connection[data-state=error] i{background:var(--down)}.connection[data-state=history] i{background:var(--text-dim)}.mode{font-size:10px;padding-left:10px;border-left:1px solid var(--line)}.spacer{flex:1}.diagnostics summary{cursor:pointer;list-style:none;padding:6px;font-size:10px}.diagnostics summary::-webkit-details-marker{display:none}.diagnostics summary:hover,.diagnostics[open] summary{color:var(--text)}.diagnostics section{position:absolute;right:7px;bottom:calc(100% + 5px);width:min(280px,calc(100vw - 24px));padding:14px;background:var(--surface-raised,var(--bg-panel));border:1px solid var(--line);border-radius:var(--radius-md);box-shadow:var(--shadow-md);white-space:normal;color:var(--text);line-height:1.5}.diagnostics strong{font-weight:550}.diagnostics p{color:var(--accent);font-size:11px;overflow-wrap:anywhere}.diagnostics dl{display:grid;grid-template-columns:1fr auto;gap:7px 20px;margin:12px 0 0}.diagnostics dt{color:var(--text-dim)}.diagnostics dd{margin:0;font:11px var(--mono);font-variant-numeric:tabular-nums}.diagnostics button{margin-top:12px;min-height:28px;width:100%;border:1px solid var(--line)}summary:focus-visible{outline:1px solid var(--accent);outline-offset:-2px}
</style>
