<script lang="ts">
  import {t, canonicalT, locale} from '../../lib/i18n';
  import type { ChartController } from '../../lib/chart/controller';
  import type { DataReading, IndicatorInstance } from '../../lib/scene/types';
  import type {DerivedSeries} from '../../lib/core/types';
  let {controller,instance,reading,locked=false}:{controller:ChartController;instance:IndicatorInstance;reading?:DataReading;locked?:boolean}=$props();
  const builtin=$derived(controller.registry.list().find(d=>d.id===instance.id)?.source==='builtin');
  const plotName=(name:string)=>builtin?$canonicalT(name):name;
  const isPattern=$derived(controller.registry.list().find(definition=>definition.id===instance.id)?.category==='pattern');
  const isAnalysis=$derived(controller.registry.list().find(definition=>definition.id===instance.id)?.category==='analysis');
  const plots=$derived.by(()=>{
    const outputs=new Map<number,{index:number;name:string;color:string;plot?:DerivedSeries['plot']}>();
    for(const value of reading?.values??[]){
      const index=value.plotIndex;if(index===undefined||!Number.isInteger(index)||index<0||index>63)continue;
      outputs.set(index,{index,name:value.name,plot:value.plot,color:typeof value.color==='string'&&/^#[\da-f]{6}$/i.test(value.color)?value.color:'#4d91ff'});
    }
    // Saved outputs remain editable while their study is waiting for data.
    for(const key of [...Object.keys(instance.plotStyles??{}),...instance.hiddenPlots.map(String)]){
      const index=Number(key);if(!Number.isInteger(index)||index<0||index>63||outputs.has(index))continue;
      outputs.set(index,{index,name:$t('输出 {0}',{0:index+1}),color:'#4d91ff'});
    }
    return [...outputs.values()].sort((a,b)=>a.index-b.index);
  });
</script>

<fieldset class="study-style-fields" disabled={locked} aria-label={$t("指标输出样式")}>
  <legend class="sr-only">{$t("指标输出样式")}</legend>
  <p class="style-note">{isAnalysis?$t("分析默认按方向与类型配色；自选颜色会统一覆盖该输出。线宽作用于区域边界和结构线，状态仍由文字与线型区分。"):isPattern?$t("分别设置看涨、看跌形态的显示、颜色与结构线宽。名称、区域与目标线开关位于输入参数。"):$t("分别调整每条输出的显示、颜色和线宽。柱状输出的宽度随图表缩放。")}</p>
  {#if plots.length}
    <div class="style-columns" aria-hidden="true"><span>{$t("输出")}</span><span>{$t("颜色")}</span><span>{$t("线宽 / 大小")}</span></div>
    <div class="plot-list">
      {#each plots as plot (plot.index)}
        {@const style=instance.plotStyles?.[String(plot.index)]}
        {@const color=style?.color??plot.color}
        {@const width=style?.width??1}
        {@const hidden=instance.hiddenPlots.includes(plot.index)}
        <div class="study-plot" class:hidden-plot={hidden}>
          <label class="plot-name" title={plotName(plot.name)}>
            <input type="checkbox" aria-label={$t("显示 {0}", {0: plotName(plot.name)})} checked={!hidden} onchange={()=>{if(!locked)controller.toggleIndicatorPlot(instance.instanceId,plot.index);}}/>
            <span class="line-swatch" aria-hidden="true" style:background={color} style:height={`${width}px`}></span>
            <span class="plot-label">{plotName(plot.name)}</span>
          </label>
          <label class="color-cell"><span class="sr-only">{plotName(plot.name)} {$t("颜色")}</span><input type="color" aria-label={$t("{0} 颜色", {0: plotName(plot.name)})} value={color} oninput={(e)=>{if(!locked)controller.setIndicatorPlotStyle(instance.instanceId,plot.index,{color:e.currentTarget.value});}}/></label>
          <div class="width-cell">{#if plot.plot==='hist'}<span class="automatic-width" title={$t("柱宽随图表缩放自动调整")}>{$t("自动")}</span>{:else}<label><span class="sr-only">{plotName(plot.name)} {$t("线宽")}</span><select aria-label={$t("{0} 线宽", {0: plotName(plot.name)})} value={width} onchange={(e)=>{if(!locked)controller.setIndicatorPlotStyle(instance.instanceId,plot.index,{width:Number(e.currentTarget.value)});}}>
            {#each [...new Set([1,2,3,4,6,8,width])].sort((a,b)=>a-b) as option}<option value={option}>{option} px</option>{/each}
          </select></label>{/if}</div>
        </div>
        {#if isAnalysis&&style?.color}<button class="reset-color" onclick={()=>{if(!locked)controller.setIndicatorPlotStyle(instance.instanceId,plot.index,{color:undefined});}}>{$t("恢复自动配色")}</button>{/if}
      {/each}
    </div>
  {:else}
    <p class="empty-outputs" role="status">{$t("指标输出就绪后，可在这里设置样式。")}</p>
  {/if}
</fieldset>

<style>
  .study-style-fields{margin:0;padding:0;border:0;min-width:0}.style-note{margin:0 0 20px;font-size:11px;line-height:1.8;color:var(--text-dim);text-wrap:pretty}
  .style-columns,.study-plot{display:grid;grid-template-columns:minmax(0,1fr) 54px 88px;align-items:center;gap:12px}.style-columns{padding:0 0 9px;font-size:11px;color:var(--text-dim)}.style-columns>span:not(:first-child){text-align:center}
  .study-plot{min-height:59px;border-top:1px solid var(--line-strong)}.plot-name{display:flex;align-items:center;gap:10px;min-width:0;min-height:44px;cursor:pointer;font-size:12px;color:var(--text)}.plot-name input{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:var(--accent)}.line-swatch{display:block;width:26px;flex:0 0 26px;max-height:8px}.plot-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hidden-plot .plot-label,.hidden-plot .line-swatch{opacity:.45}
  .color-cell,.width-cell{display:flex;align-items:center;justify-content:center;min-height:44px}.color-cell input{height:40px;width:44px;padding:5px;background:var(--surface-sunken);border:1px solid var(--line-strong);cursor:pointer}.width-cell>label{width:100%}.automatic-width{font-size:11px;color:var(--text-dim)}.width-cell select{width:100%;height:40px;padding:6px 8px;font:12px var(--mono);font-variant-numeric:tabular-nums;background:var(--surface-sunken);border:1px solid var(--line-strong);color:var(--text-strong)}
  .study-style-fields:disabled .plot-name{cursor:default}.study-style-fields:disabled input,.study-style-fields:disabled select{opacity:.45;cursor:default}.empty-outputs{padding:20px 0;font-size:12px;line-height:1.8;color:var(--text-dim)}
  .reset-color{font:11px var(--font);color:var(--accent);padding:5px 0;cursor:pointer}.reset-color:hover{text-decoration:underline}.reset-color:focus-visible{outline:1px solid var(--accent);outline-offset:2px}
  @media(max-width:460px){.style-columns,.study-plot{grid-template-columns:minmax(0,1fr) 44px 76px;gap:8px}.line-swatch{width:18px;flex-basis:18px}.plot-name{gap:7px}}
</style>
