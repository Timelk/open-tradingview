<script lang="ts">
  import {t, locale} from '../lib/i18n';
  import type { IndicatorDef } from '../lib/core/types';
  import type { IndicatorReq } from '../lib/indicators/runtime';
  export let definitions:IndicatorDef[]=[];
  export let requests:IndicatorReq[]=[];
  export let pending=false;
  export let onToggle:(id:string,on:boolean)=>void;
  export let onParam:(id:string,key:string,value:number|string|boolean)=>void;
  export let onClose:()=>void;
</script>
<aside class="panel" aria-label={$t("指标参数面板")}>
  <div class="panel-title"><strong>{$t("指标与参数")}</strong><button aria-label={$t("关闭指标面板")} on:click={onClose}>×</button></div>
  <div class="panel-note">{pending?$t("正在计算指标…"):$t("修改参数后自动应用")}</div>
  <div class="indicator-list">
    {#each definitions as def}
      {@const req=requests.find(r=>r.id===def.id)}
      <section class:enabled={!!req}>
        <label class="indicator-title"><input type="checkbox" checked={!!req} on:change={(e)=>onToggle(def.id,e.currentTarget.checked)} /><strong>{(def.source==='builtin'?$t(def.name):def.name)}</strong><span>{def.target==='main'?$t("主图叠加"):def.target==='volume'?$t("成交量"):$t("独立副图")}</span></label>
        {#if req}<div class="params">
          {#each def.inputs as param}
            <label class="param"><span>{$t(param.label)}</span>
              {#if param.type==='int'||param.type==='float'}<input aria-label={`${(def.source==='builtin'?$t(def.name):def.name)} ${$t(param.label)}`} type="number" min={param.min} max={param.max} step={param.step??1} value={req.params[param.key] as number} on:change={(e)=>onParam(def.id,param.key,e.currentTarget.valueAsNumber)} />
              {:else if param.type==='bool'}<input aria-label={`${(def.source==='builtin'?$t(def.name):def.name)} ${$t(param.label)}`} type="checkbox" checked={!!req.params[param.key]} on:change={(e)=>onParam(def.id,param.key,e.currentTarget.checked)} />
              {:else if param.type==='select'}<select aria-label={`${(def.source==='builtin'?$t(def.name):def.name)} ${$t(param.label)}`} value={String(req.params[param.key])} on:change={(e)=>onParam(def.id,param.key,e.currentTarget.value)}>{#each param.options??[] as option}<option value={option}>{$t(param.optionLabels?.[option]??option)}</option>{/each}</select>
              {:else}<input aria-label={`${(def.source==='builtin'?$t(def.name):def.name)} ${$t(param.label)}`} type="color" value={String(req.params[param.key])} on:change={(e)=>onParam(def.id,param.key,e.currentTarget.value)} />{/if}
            </label>
          {/each}
        </div>{/if}
      </section>
    {/each}
  </div>
  <div class="key-guide"><span class="label">{$t("操作指南")}</span><div><span>{$t("平移图表")}</span><kbd>{$t("拖拽 / ← →")}</kbd></div><div><span>{$t("缩放图表")}</span><kbd>{$t("滚轮 / + −")}</kbd></div><div><span>{$t("纵向比例")}</span><kbd>{$t("拖右侧刻度")}</kbd></div><div><span>{$t("窗格高度")}</span><kbd>{$t("拖分隔线")}</kbd></div><div><span>{$t("恢复比例 / 布局")}</span><kbd>{$t("双击对应边缘")}</kbd></div><div><span>{$t("还原最大化")}</span><kbd>Esc</kbd></div><div><span>{$t("百万根全览")}</span><kbd>Home</kbd></div><div><span>{$t("回到最新")}</span><kbd>{$t("End / 双击")}</kbd></div></div>
</aside>
<style>
  .panel{width:246px;flex-shrink:0;background:var(--bg-panel);border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0;overflow:auto}
  .panel-title{display:flex;align-items:center;justify-content:space-between;padding:3px 12px;min-height:43px;border-bottom:1px solid var(--line)}.panel-title button{font-size:21px;width:36px;height:36px}
  .panel-note{font-size:11px;color:var(--text-dim);padding:10px 14px 4px}.indicator-list{padding:4px 0}
  section{border-bottom:1px solid var(--line);padding:4px 13px 8px}.indicator-title{display:flex;align-items:center;gap:8px;cursor:pointer;min-height:34px}.indicator-title strong{font-family:var(--mono);font-weight:500}.indicator-title span{margin-left:auto;font-size:11px;color:var(--text-dim)}
  .enabled .indicator-title strong{color:var(--text)}input[type=checkbox]{accent-color:var(--accent);width:13px;height:13px;margin:0;cursor:pointer}
  .params{display:grid;gap:6px;padding:0 0 5px 21px}.param{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--text-dim);font-size:11px}.param input:not([type=checkbox]),.param select{width:77px;min-height:28px;padding:4px 6px;font:11px var(--mono);border:1px solid var(--line);background:var(--bg);color:var(--text)}
  .key-guide{margin-top:auto;padding:20px 14px;color:var(--text-dim);font-size:11px}.label{letter-spacing:1px;display:block;margin-bottom:12px}.key-guide div{display:flex;justify-content:space-between;line-height:25px}kbd{font:11px var(--mono);color:var(--text-dim)}
  @media(max-width:760px){.panel{position:absolute;right:0;top:0;bottom:0;z-index:4;width:230px}}
</style>
