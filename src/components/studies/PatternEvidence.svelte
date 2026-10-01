<script lang="ts">
  import {t,canonicalT,locale} from '../../lib/i18n';
  import type {PatternMatch} from '../../lib/patterns/types';
  import {patternEventLabel,patternStageLabel} from '../../lib/patterns/presentation';
  import {formatMarketPrice} from '../../lib/core/market-format';
  import type {SignalTag} from '../../lib/patterns/signal-tags';
  import SignalTagChip from './SignalTagChip.svelte';
  type Target={instanceId:string;patternId:string};
  let {pattern,tags=[],canJump,onJump}:{pattern:PatternMatch;tags?:readonly SignalTag[];canJump?:(target:Target)=>boolean;onJump?:(target:Target)=>void}=$props();
  const date=(time:number)=>new Date(time).toLocaleString($locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'});
</script>

{#if pattern.stage||pattern.resolution}
  <div class="structure-state" class:warning={pattern.stage==='failed-breakout'} class:invalid={pattern.stage==='invalidated'}>
    <strong>{$canonicalT((patternStageLabel(pattern))??'')}</strong>
    <span>{pattern.formation==='early'?$t("四点提前突破 · 无 E 点"):$t("{0} 个结构锚点", {"0": String(pattern.points.length)})}{#if pattern.pivotStrength} {$t("· 右侧")} {pattern.pivotStrength} {$t("柱确认")}{/if}</span>
  </div>
{/if}
{#if tags.length}
  <section class="signal-section" aria-label={$t("共振信号")}>
    <h4>{$t("共振信号")}</h4>
    <ul>
      {#each tags as tag (`${tag.kind}:${tag.label}:${tag.target?.patternId??''}`)}
        <li>
          <div class="signal-head"><SignalTagChip {tag}/>
            {#if tag.target&&canJump?.(tag.target)}<button class="signal-jump" title={$t("定位到该形态")} aria-label={`${$t("定位到该形态")}: ${$canonicalT(tag.label)}`} onclick={()=>onJump?.(tag.target!)}>{$t("定位到该形态")}</button>{/if}
          </div>
          <p>{$canonicalT(tag.detail)}</p>
        </li>
      {/each}
    </ul>
    <p class="signal-note">{$t("这些标签是阅读辅助，不是交易信号，也不代表成交或获利概率。")}</p>
  </section>
{/if}
{#if pattern.resolution}
  <details class="resolution"><summary>{$t("参考价触及记录")} <span>{$t("辅助信息")}</span></summary><div class="reference-record"><strong>{formatMarketPrice(pattern.resolution.price)}</strong><span>{date(pattern.resolution.knownAt)} UTC</span><p>{pattern.family.startsWith('huzi')?$t("参考价按形态或旗杆高度投射。"):$t("参考价为谐波第二参考位 T2。")} {$t("这只记录曾触及参考价；后续回落、失效仍继续追踪，不代表成交或盈利。")}</p></div></details>
{/if}
{#if pattern.dataWarning}<p class="data-warning" role="status">{$canonicalT(pattern.dataWarning)}</p>{/if}
{#if pattern.events?.length}
  <section class="event-history" aria-label={$t("结构演变记录")}>
    <h4>{$t("结构演变")} <span>{$t("闭柱确认 · UTC")}</span></h4>
    <ol>
      {#each pattern.events as event (`${event.kind}:${event.time}`)}
        <li class:warning={event.kind==='failed-breakout'} class:invalid={event.kind==='invalidation'}>
          <div class="event-heading"><strong>{$canonicalT(patternEventLabel(pattern,event))}</strong><time datetime={new Date(event.knownAt).toISOString()} title={$t("本柱位置 {0} UTC；收盘后可知时间 {1} UTC", {"0": String(date(event.time)), "1": String(date(event.knownAt))})}>{date(event.knownAt)}</time></div>
          <div class="event-prices"><span>{$t("收盘")} <b>{formatMarketPrice(event.value)}</b></span><span>{$t("当时边界")} <b>{formatMarketPrice(event.boundary)}</b></span></div>
        </li>
      {/each}
    </ol>
    <p>{$t("图上小标记落在事件发生的 K 线；这里记录收盘后可确认的时间。")}</p>
  </section>
{/if}

<style>
  .signal-section{margin:11px 0 0;padding:8px 0 2px;border-top:1px solid var(--line-strong)}.signal-section h4{margin:0 0 6px;font-size:11px;font-weight:550;color:var(--text)}
  .signal-section ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}.signal-section li{min-width:0}
  .signal-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}.signal-jump{font-size:10px;color:var(--accent-strong);padding:0;text-decoration:underline;text-underline-offset:2px}.signal-jump:hover{color:var(--text-strong)}
  .signal-section li p{margin:4px 0 0;font-size:10px;line-height:1.6;color:var(--text-dim);overflow-wrap:anywhere}.signal-note{margin:7px 0 0;font-size:10px;line-height:1.5;color:var(--text-dim)}
  .resolution{margin:10px 0;padding:9px 0;border-block:1px solid var(--line-strong);color:var(--text-dim);font-size:10px}.resolution summary{cursor:pointer;line-height:1.6}.resolution summary>span{float:right;color:var(--text-dim)}.reference-record{display:flex;flex-direction:column;gap:5px;padding-top:8px}.reference-record strong{font:11px var(--mono);color:var(--text)}.reference-record>span{font:10px var(--mono)}.resolution p{margin:0;line-height:1.7}
  .data-warning{font-size:11px;line-height:1.7;padding:8px;border-left:2px solid var(--warn);color:var(--warn);background:var(--bg-hover)}
  .structure-state{border-left:2px solid var(--line-strong);background:var(--bg-hover);padding:8px 9px;margin-top:11px;display:flex;flex-direction:column;gap:5px}.structure-state strong{font-size:11px;font-weight:550;color:var(--text)}.structure-state span{font-size:10px;line-height:1.5;color:var(--text-dim)}.structure-state.warning{border-color:var(--warn);background:var(--bg-hover)}.structure-state.warning strong{color:var(--warn)}.structure-state.invalid{border-color:var(--line-strong);background:var(--bg-hover)}.event-history{margin-top:12px;padding-top:10px;border-top:1px solid var(--line-strong)}.event-history h4{display:flex;justify-content:space-between;gap:8px;margin:0 0 9px;font-size:11px;font-weight:500;color:var(--text)}.event-history h4 span{font-size:10px;font-weight:400;color:var(--text-dim)}.event-history ol{list-style:none;padding:0;margin:0}.event-history li{position:relative;border-left:1px solid var(--line-strong);margin-left:3px;padding:0 0 13px 12px}.event-history li::before{content:'';position:absolute;left:-3px;top:5px;width:5px;height:5px;background:var(--bg-active)}.event-history li:last-child{padding-bottom:4px}.event-history li.warning::before{background:var(--warn)}.event-history li.invalid::before{background:var(--bg-active)}.event-heading{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.event-heading strong{font-size:11px;font-weight:500;color:var(--text)}.warning .event-heading strong{color:var(--warn)}.invalid .event-heading strong{color:var(--text-dim)}.event-heading time{font:10px var(--mono);color:var(--text-dim);white-space:nowrap}.event-prices{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 8px;font-size:10px;color:var(--text-dim);margin-top:6px}.event-prices b{font:10px var(--mono);color:var(--text)}.event-history p{font-size:10px;line-height:1.7;color:var(--text-dim);margin:7px 0 0}
</style>
