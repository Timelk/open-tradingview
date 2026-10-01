<script lang="ts">
  import {t,canonicalT,locale} from '../../lib/i18n';
  import type {PatternCandidateRow} from '../../lib/patterns/types';
  import {formatMarketPrice} from '../../lib/core/market-format';
  import ToolIcon from '../drawing/ToolIcon.svelte';

  let {mode='list',rows=[],row,selectedKey=null,waiting=false,onSelect,onSettings}:{
    mode?:'list'|'detail';rows?:PatternCandidateRow[];row?:PatternCandidateRow;selectedKey?:string|null;
    waiting?:boolean;onSelect:(row:PatternCandidateRow)=>void;onSettings:(instanceId:string)=>void;
  }=$props();
  const shortDate=$derived(new Intl.DateTimeFormat($locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'}));
  const fullDate=$derived(new Intl.DateTimeFormat($locale,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'}));
  const date=(time:number,full=false)=>Number.isFinite(time)?(full?fullDate:shortDate).format(new Date(time)):'—';
  const key=(item:PatternCandidateRow)=>`${item.instanceId}:${item.candidate.id}`;
  const direction=(item:PatternCandidateRow)=>item.candidate.direction==='neutral'?'方向待定':item.candidate.direction==='bullish'?'潜在向上反转':'潜在向下反转';
  function listKeys(event:KeyboardEvent){
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    const list=(event.currentTarget as HTMLElement).closest('.candidate-list');
    const items=Array.from(list?.querySelectorAll<HTMLButtonElement>('.candidate-result')??[]);
    if(!items.length)return;
    event.preventDefault();
    const index=items.indexOf(document.activeElement as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[next]?.focus();
  }
</script>

{#if mode==='list'}
  <div class="candidate-list" role="group" aria-label={$t("观察中的未确认形态")}>
    <p class="observation-note"><span class="dash-sample" aria-hidden="true"></span>{$t("虚线表示观察结构，随行情更新或撤销。")}</p>
    {#each rows as item (key(item))}
      <button class="candidate-result" class:chosen={key(item)===selectedKey} aria-pressed={key(item)===selectedKey}
        title={$t("{0} · 观察中，尚未确认\n{1}\n评估于 {2} UTC\n单击定位，双击设置", {"0": String($canonicalT((item.candidate.name)??'')), "1": String($canonicalT((direction(item))??'')), "2": String(date(item.candidate.observedAt,true))})}
        onkeydown={listKeys} onclick={()=>onSelect(item)} ondblclick={()=>onSettings(item.instanceId)}>
        <span class="candidate-icon"><ToolIcon name={item.candidate.direction==='neutral'?'pattern':'fib'} size={14}/></span>
        <span class="result-copy"><strong>{$canonicalT(item.candidate.name)}</strong><small>{item.layerName} · {item.timeframe}{#if !item.visible} {$t("· 已隐藏")}{/if}</small></span>
        <span class="result-meta"><span>{$t("观察中")}</span><small>{$canonicalT(direction(item))}</small></span>
      </button>
    {:else}
      <div class="candidate-empty" role="status"><ToolIcon name="search" size={23}/><strong>{waiting?$t("正在查找当前结构"):$t("暂无符合规则的观察结构")}</strong><p>{$t("观察列表只保留仍在形成的当前结构。历史完成形态请切换「已确认」；此列表不会补画尚未发生的拐点。")}</p></div>
    {/each}
  </div>
{:else if row}
  {@const candidate=row.candidate}
  {@const neutral=candidate.direction==='neutral'}
  <section class="candidate-detail" aria-label={$t("观察形态详情")}>
    <header class="detail-header"><div><span class="detail-eyebrow">{$t("观察中 · 尚未确认")}</span><h3>{$canonicalT(candidate.name)}</h3><small>{$canonicalT(direction(row))}</small></div><button title={$t("再次定位此观察结构")} aria-label={$t("定位所选观察结构")} onclick={()=>row&&onSelect(row)}><ToolIcon name="fit" size={16}/></button><button title={$t("设置所属识别器")} aria-label={$t("设置观察形态识别器")} onclick={()=>row&&onSettings(row.instanceId)}><ToolIcon name="gear" size={16}/></button></header>
    {#if !row.visible}<button class="hidden-notice" onclick={()=>row&&onSettings(row.instanceId)}><ToolIcon name="hidden" size={14}/>{$t("图层或观察输出当前不可见 · 查看设置")}</button>{/if}
    <p class="candidate-state">{neutral?$t("边界触点已形成，尚未确认突破。向上或向下离开框架仍需后续行情验证。"):$t("基础拐点已形成，D 点尚未完成。潜在反转区是价格投影，不代表反转已经发生。")}</p>
    {#if candidate.zone}<dl class="zone"><dt>{neutral?$t("当前框架范围"):$t("潜在 D 区 · PRZ")}</dt><dd>{formatMarketPrice(candidate.zone.low)} <span>—</span> {formatMarketPrice(candidate.zone.high)}</dd></dl>{/if}
    <details class="rule-explanation"><summary>{$t("结构依据与等待条件")}</summary><p>{$canonicalT(candidate.description)}</p></details>
    {#if candidate.ratios.length}<table class="ratios"><caption>{$t("已发生结构的比例")}</caption><thead><tr><th scope="col">{$t("比例")}</th><th scope="col">{$t("实际")}</th><th scope="col">{$t("规则")}</th></tr></thead><tbody>{#each candidate.ratios as ratio}<tr><th scope="row">{$canonicalT(ratio.label)}</th><td>{ratio.value.toFixed(3)}</td><td>{$canonicalT(ratio.expected)}</td></tr>{/each}</tbody></table>{/if}
    <dl class="dates">{#if candidate.availableAt!==undefined}<div><dt>{$t("基础结构首次可知")}</dt><dd>{date(candidate.availableAt,true)} UTC</dd></div>{/if}<div><dt>{$t("最近评估柱")}</dt><dd>{date(candidate.observedAt,true)} UTC</dd></div></dl>
    <details class="anchors" open><summary>{$t("已发生的锚点")} <span>{candidate.points.length}</span></summary><table><thead><tr><th scope="col">{$t("点")}</th><th scope="col">{$t("价格")}</th><th scope="col">{$t("UTC 时间")}</th></tr></thead><tbody>{#each candidate.points as point}<tr><th scope="row">{$canonicalT(point.label)}</th><td>{formatMarketPrice(point.value)}</td><td>{date(point.time,true)}</td></tr>{/each}</tbody></table></details>
    <p class="footnote">{$t("虚线结构可能随最新行情变化或撤下，不是已确认形态或买卖信号。")}{neutral?$t("等待实际突破，不预设多空方向。"):$t("图中不绘制尚未发生的 D 点。")}</p>
  </section>
{:else}
  <div class="detail-placeholder"><ToolIcon name="cross" size={20}/><p>{$t("选择一个观察结构")}<br/><span>{$t("查看实际锚点、边界与等待条件")}</span></p></div>
{/if}

<style>
  .candidate-list{overflow:auto;min-height:80px;flex:1}.observation-note{display:flex;align-items:center;gap:6px;margin:0;padding:5px 10px 8px;color:var(--text-dim);font-size:10px;line-height:1.6}.dash-sample{width:17px;border-top:1px dashed var(--warn);flex-shrink:0}.candidate-result{display:flex;align-items:center;gap:6px;width:100%;min-height:44px;padding:7px 9px;border-top:1px solid var(--line);border-left:2px solid transparent;text-align:left;transition:background-color 100ms,border-color 100ms}.candidate-result:hover{background:var(--bg-hover)}.candidate-result.chosen{background:var(--bg-hover);border-left-color:var(--warn)}.candidate-icon{display:flex;flex-shrink:0;color:var(--warn)}.result-copy{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}.result-copy strong{font-size:11px;font-weight:500;color:var(--text);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.result-copy small{font-size:10px;color:var(--text-dim);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.result-meta{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex-shrink:0;font-size:10px;color:var(--warn)}.result-meta small{font-size:10px;color:var(--text-dim)}.candidate-empty{min-height:140px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px 20px;color:var(--text-dim);gap:9px;text-align:center}.candidate-empty strong{font-size:11px;font-weight:500;color:var(--text)}.candidate-empty p{margin:0;font-size:10px;line-height:1.9;color:var(--text-dim);text-wrap:pretty}.candidate-detail{padding:13px 11px 11px}.detail-header{display:flex;align-items:center;gap:3px}.detail-header>div{min-width:0;flex:1}.detail-eyebrow{font-size:10px;color:var(--warn)}.detail-header h3{font-size:13px;font-weight:550;line-height:1.5;margin:5px 0;color:var(--text-strong)}.detail-header small{font-size:10px;color:var(--text-dim)}.detail-header>button{width:25px;height:27px;padding:0;display:flex;align-items:center;justify-content:center;color:var(--text-dim)}.detail-header>button:hover{background:var(--bg-active)}.hidden-notice{display:flex;align-items:center;gap:6px;font-size:10px;background:var(--bg-active);color:var(--accent-strong);padding:7px;width:100%;margin-top:10px;text-align:left}.candidate-state,.footnote,.rule-explanation p{font-size:10px;line-height:1.8;color:var(--text-dim);text-wrap:pretty}.candidate-state{padding:9px 0;margin:8px 0;border-bottom:1px solid var(--line-strong)}.zone{display:flex;flex-direction:column;gap:7px;margin:12px 0}.zone dt{font-size:10px;color:var(--text-dim)}.zone dd{font:11px var(--mono);font-variant-numeric:tabular-nums;color:var(--warn);margin:0;overflow-wrap:anywhere}.zone dd span{color:var(--text-dim)}.rule-explanation{margin:12px 0;border-block:1px solid var(--line-strong);padding:9px 0;font-size:10px;color:var(--text-dim)}.rule-explanation summary,.anchors summary{cursor:pointer}.rule-explanation p{margin:8px 0 0}.ratios,.anchors table{width:100%;border-collapse:collapse;margin-top:10px}.ratios caption{text-align:left;font-size:10px;color:var(--text);margin-bottom:8px}.ratios th,.ratios td,.anchors th,.anchors td{padding:6px 0;border-bottom:1px solid var(--line);text-align:right;font:10px var(--mono);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.ratios th:first-child,.anchors th:first-child{text-align:left;color:var(--text)}.ratios thead th,.anchors thead th{font:10px var(--font);color:var(--text-dim)}.ratios tbody td:last-child{color:var(--text-dim);padding-left:9px}.dates{display:flex;flex-direction:column;gap:8px;margin:13px 0;font-size:10px}.dates>div{display:flex;flex-wrap:wrap;justify-content:space-between;gap:5px}.dates dt{color:var(--text-dim)}.dates dd{font:10px var(--mono);font-variant-numeric:tabular-nums;margin:0;color:var(--text)}.anchors{border-top:1px solid var(--line);padding-top:10px;font-size:10px;color:var(--text-dim)}.anchors summary span{font:10px var(--mono);margin-left:5px}.anchors td:last-child{font-size:9px}.footnote{color:var(--text-dim);margin:12px 0 0}.detail-placeholder{padding:20px 12px;display:flex;align-items:center;justify-content:center;gap:10px;color:var(--text-dim)}.detail-placeholder p{margin:0;font-size:11px;line-height:1.8;color:var(--text)}.detail-placeholder span{font-size:10px;color:var(--text-dim)}button:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}@media(prefers-reduced-motion:reduce){.candidate-result{transition:none}}@media(pointer:coarse){.candidate-result{min-height:54px}}
</style>
