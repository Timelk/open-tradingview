<script lang="ts">
  import {t,locale,formatDate} from '../lib/i18n';
  import {agentBridge} from '../lib/agent/client';
  const status=agentBridge.status;
  let panel:HTMLDetailsElement,trigger:HTMLElement;
  // Hidden where the page has no local hub (static hosting): nothing to connect to.
  $: shown=$status.connection==='connected'||$status.connection==='connecting';
  // "Connected" means an AI client is really there (live MCP process or HTTP session), not just this page's link to the hub.
  $: agents=$status.agents;
  $: tone=$status.connection!=='connected'?'waiting':$status.busy?'busy':!agents.length?'idle':$status.writable?'ready':'readonly';
  $: label=$status.connection!=='connected'?'AI 桥接重连中':$status.busy?'AI 操作中':agents.length?'AI 已连接':'AI 未连接';
  $: names=[...new Set(agents.map(agent=>agent.name))];
  const time=(value:number)=>formatDate(value,{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'},$locale);
  function dismiss(event:PointerEvent){if(panel?.open&&event.target instanceof Node&&!panel.contains(event.target))panel.open=false;}
  function keydown(event:KeyboardEvent){if(event.key==='Escape'&&panel?.open){const inside=event.target instanceof Node&&panel.contains(event.target);panel.open=false;if(inside){event.preventDefault();event.stopPropagation();trigger?.focus();}}}
</script>
<svelte:window on:pointerdown={dismiss} on:keydown|capture={keydown}/>
{#if shown}
  <details bind:this={panel} class="agent" data-tone={tone}>
    <summary bind:this={trigger} aria-label={$t('AI 图表桥接')}><i></i>{$t(label)}{#if agents.length&&$status.connection==='connected'&&!$status.busy}<b>{names[0]}{names.length>1?` +${names.length-1}`:''}</b>{/if}{#if !$status.writable}<span>{$t('只读')}</span>{/if}</summary>
    <section aria-label={$t('AI 图表桥接')}>
      <strong>{$t('AI 图表桥接')}</strong>
      <p>{$t('本机 AI Agent 通过 MCP 读取行情、指标与形态证据，并用可编辑绘图、叠加层和指标标注当前图表。')}</p>
      <dl>
        <dt>{$t('本页')}</dt><dd>{$t($status.connection==='connected'?'已接入本地服务':'重试中')}</dd>
        <dt>{$t('AI 客户端')}</dt><dd>{agents.length?$t('{0} 个在线',{0:agents.length}):$t('无')}</dd>
        {#each agents as agent (agent.id)}<dt class="agent-name" title={agent.name}>{agent.name}</dt><dd title={$t('连接于')+' '+time(agent.since)}>{agent.transport==='stdio'?'stdio':'HTTP'} · {time(agent.since)}</dd>{/each}
        <dt>{$t('本页调用')}</dt><dd>{$status.calls}</dd>
        {#if $status.lastCall}<dt>{$t('最近调用')}</dt><dd title={$status.lastCall.agent}>{$status.lastCall.method}{$status.lastCall.ok?'':' ✕'} · {time($status.lastCall.at)}</dd>{/if}
      </dl>
      {#if !agents.length}<p class="hint">{$t('还没有 AI 客户端连接。在 Claude Code 等工具中添加 MCP 服务即可，方法见接入说明。')}</p>{/if}
      <a href="/llms.txt" target="_blank" rel="noopener">{$t('接入说明')} · /llms.txt ↗</a>
      <label><input type="checkbox" checked={$status.writable} on:change={event=>agentBridge.setWritable(event.currentTarget.checked)}/>{$t('允许 AI 修改图表')}</label>
      <small>{$t('关闭后 AI 仍可读取，但不能绘制、修改或切换视图。AI 绘图带作者标记，可在对象树中编辑或删除，也可撤销。')}</small>
    </section>
  </details>
{/if}
<style>
  .agent{position:relative;padding-left:10px;border-left:1px solid var(--line)}
  summary{display:inline-flex;align-items:center;gap:6px;cursor:pointer;list-style:none;padding:6px 2px;font-size:10px}
  summary::-webkit-details-marker{display:none}
  summary:hover,.agent[open] summary{color:var(--text)}
  summary:focus-visible{outline:1px solid var(--accent);outline-offset:-2px}
  summary i{width:5px;height:5px;border-radius:50%;background:var(--up)}
  summary b{font-weight:500;color:var(--text)}
  summary span{padding:1px 4px;border:1px solid var(--line);border-radius:3px;color:var(--text-dim)}
  .agent[data-tone=waiting] i,.agent[data-tone=idle] i{background:var(--text-dim)}
  .agent[data-tone=idle] summary i{background:transparent;box-shadow:inset 0 0 0 1px var(--text-dim)}
  .agent[data-tone=readonly] i{background:var(--accent)}
  .agent[data-tone=busy] i{background:var(--accent);animation:pulse .9s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.25}}
  @media (prefers-reduced-motion:reduce){.agent[data-tone=busy] i{animation:none}}
  section{position:absolute;left:0;bottom:calc(100% + 5px);width:min(300px,calc(100vw - 24px));padding:14px;background:var(--surface-raised,var(--bg-panel));border:1px solid var(--line);border-radius:var(--radius-md);box-shadow:var(--shadow-md);white-space:normal;color:var(--text);line-height:1.5}
  strong{font-weight:550}
  p,small{display:block;margin:6px 0 0;color:var(--text-dim);font-size:11px}
  .hint{color:var(--text)}
  /* Labels shrink (ellipsis); values keep their full width so times are never cut. */
  dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px 16px;margin:12px 0}
  dt{min-width:0;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  dt.agent-name{color:var(--text);font:11px var(--mono)}
  dd{margin:0;text-align:right;font:11px var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
  a{display:inline-block;margin:10px 0 4px;color:var(--accent);font-size:11px;text-decoration:none}
  a:hover,a:focus-visible{text-decoration:underline}
  label{display:flex;align-items:center;gap:8px;min-height:28px;cursor:pointer}
  input{margin:0;accent-color:var(--accent)}
</style>
