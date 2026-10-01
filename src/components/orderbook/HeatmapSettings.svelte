<script lang="ts">
  import {t} from '../../lib/i18n';
  import type {ChartController} from '../../lib/chart/controller';
  import type {OrderFlowSettings} from '../../lib/flow/chart-order-flow';
  import {HEATMAP_THEMES,heatmapRampHex,resolveHeatmapIntensity,type HeatmapSensitivityPreset,type HeatmapThemeId} from '../../lib/flow/heatmap-themes';
  import {depthHeatmapIntensity} from '../../lib/render/orderbook-overlay';
  import {formatTerminalAmount} from '../../lib/flow/terminal-presentation';

  /** Chart-overlay section of the order-book settings sheet. */
  let {controller,settings,unitLabel,revision,locale,change}:{controller:ChartController;settings:OrderFlowSettings;unitLabel:string;revision:number;locale:string;change:(patch:Partial<OrderFlowSettings>)=>void}=$props();

  const theme=$derived(settings.theme??'stark');
  // The same pan-stable cell statistics the renderer normalizes against, so the
  // ramp handles and the painted colors always agree.
  const quantities=$derived.by(()=>{
    revision;
    const overlay=controller.getDepthOverlay?.();
    if(overlay?.scale?.quantities.length)return {overlay,values:overlay.scale.quantities};
    const book=controller.orderFlow?.aggregate(80),values:number[]=[];
    for(const row of [...(book?.bids??[]),...(book?.asks??[])])if(row.quantity>0)values.push(row.quantity);
    return {overlay:undefined,values};
  });
  const intensitySettings=$derived({sensitivity:settings.sensitivity,threshold:settings.threshold,ceiling:settings.ceiling,minBounds:settings.minBounds,maxBounds:settings.maxBounds});
  const intensity=$derived.by(()=>{
    const {overlay,values}=quantities;
    if(overlay)return depthHeatmapIntensity(overlay,intensitySettings);
    let maximum=0;for(const v of values)if(v>maximum)maximum=v;
    return resolveHeatmapIntensity(Array.from(values),maximum,intensitySettings);
  });
  const span=$derived(Math.max(1e-9,intensity.maxBounds-intensity.minBounds));
  const ratio=(value:number)=>Math.min(1,Math.max(0,(value-intensity.minBounds)/span));
  const low=$derived(ratio(intensity.threshold)),high=$derived(Math.max(low+.02,ratio(intensity.ceiling)));
  const hasData=$derived(quantities.values.length>0);

  const ramp=(id:HeatmapThemeId,side:'bid'|'ask')=>[0,.35,.7,.86,1].map(f=>`${heatmapRampHex(id,side,f)} ${f*100}%`).join(',');
  const twoTone=(id:HeatmapThemeId)=>HEATMAP_THEMES.find(item=>item.id===id)?.mode==='two-tone';
  // Two-tone themes show bids on the top half and asks on the bottom half.
  const swatch=(id:HeatmapThemeId)=>twoTone(id)
    ?`linear-gradient(90deg,${ramp(id,'bid')}) top/100% 50% no-repeat,linear-gradient(90deg,${ramp(id,'ask')}) bottom/100% 50% no-repeat`
    :`linear-gradient(90deg,${ramp(id,'bid')})`;
  const peak=(id:HeatmapThemeId)=>twoTone(id)?`linear-gradient(${heatmapRampHex(id,'bid',1)} 50%,${heatmapRampHex(id,'ask',1)} 50%)`:heatmapRampHex(id,'bid',1);
  const themeName=$derived($t(HEATMAP_THEMES.find(item=>item.id===theme)?.label??''));
  const amount=(value:number)=>value>0?formatTerminalAmount(value,locale):'0';

  const presets:Array<{id:Exclude<HeatmapSensitivityPreset,'custom'>;label:string;hint:string}>=[
    {id:'low',label:'少',hint:'只画最大的挂单墙'},{id:'med',label:'适中',hint:'默认：约前 15% 的价位上色'},{id:'high',label:'多',hint:'更多价位上色，适合冷门品种'},
  ];
  const toggles:Array<{key:'heatmap'|'profile'|'crossSection';label:string;hint:string}>=[
    {key:'heatmap',label:'深度热图',hint:'K 线下方按时间铺开的挂单量'},
    {key:'profile',label:'深度分布',hint:'价格轴旁的当前挂单剖面'},
    {key:'crossSection',label:'悬停明细',hint:'十字光标处显示附近价位与时刻的挂单表'},
  ];
  function toggle(key:'heatmap'|'profile'|'crossSection'){
    const next={...settings,[key]:!settings[key]};
    change({[key]:next[key],...(key!=='crossSection'?{lastDisplay:next.heatmap&&next.profile?'both':next.profile?'profile':'heatmap'}:{})});
  }

  // Threshold / ceiling handles on the ramp: pointer drag and keyboard.
  let track=$state<HTMLDivElement>(),dragging=$state<'threshold'|'ceiling'|null>(null);
  function place(handle:'threshold'|'ceiling',at:number){
    const gap=span*.02,value=intensity.minBounds+Math.min(1,Math.max(0,at))*span;
    if(handle==='threshold')change({sensitivity:'custom',threshold:Number(Math.max(intensity.minBounds,Math.min(value,intensity.ceiling-gap)).toPrecision(4)),ceiling:intensity.ceiling});
    else change({sensitivity:'custom',ceiling:Number(Math.min(intensity.maxBounds,Math.max(value,intensity.threshold+gap)).toPrecision(4)),threshold:intensity.threshold});
  }
  function pointer(event:PointerEvent){
    if(!dragging||!track)return;const box=track.getBoundingClientRect();
    if(box.width>0)place(dragging,(event.clientX-box.left)/box.width);
  }
  function grab(handle:'threshold'|'ceiling',event:PointerEvent){
    event.preventDefault();dragging=handle;(event.currentTarget as HTMLElement).focus();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }
  function trackDown(event:PointerEvent){
    if(event.target!==track||!track)return;const box=track.getBoundingClientRect(),at=(event.clientX-box.left)/box.width;
    // Clicking the bare track moves whichever handle is nearer.
    const handle=Math.abs(at-low)<=Math.abs(at-high)?'threshold':'ceiling';
    place(handle,at);dragging=handle;track.setPointerCapture?.(event.pointerId);
  }
  function nudge(handle:'threshold'|'ceiling',event:KeyboardEvent){
    const step=event.shiftKey?.01:.05,dir=event.key==='ArrowRight'||event.key==='ArrowUp'?1:event.key==='ArrowLeft'||event.key==='ArrowDown'?-1:0;
    if(!dir)return;event.preventDefault();place(handle,(handle==='threshold'?low:high)+dir*step);
  }
  function setUnitless(field:'minBounds'|'maxBounds',value:number){change({[field]:Number.isFinite(value)&&value>0?value:0});}
</script>

<div class="overlay-settings">
  <h3 class="sheet-heading">{$t('主图叠加')}<small>{$t('关闭盘口面板后仍然显示')}</small></h3>
  <div class="switch-list">
    {#each toggles as item (item.key)}
      <label class="switch-row">
        <span class="switch-copy"><b>{$t(item.label)}</b><small>{$t(item.hint)}</small></span>
        <input type="checkbox" role="switch" checked={Boolean(settings[item.key])} onchange={()=>toggle(item.key)}/>
      </label>
    {/each}
  </div>

  <div class="render-group" class:dormant={!settings.heatmap&&!settings.profile}>
    <div class="field">
      <div class="field-head"><span>{$t('配色')}</span><em>{themeName}</em></div>
      <div class="swatches" role="radiogroup" aria-label={$t('热图配色')}>
        {#each HEATMAP_THEMES as item (item.id)}
          <button type="button" role="radio" class="swatch" class:chosen={theme===item.id} aria-checked={theme===item.id} aria-label={$t(item.label)} title={$t(item.label)} style:background={swatch(item.id)} onclick={()=>change({theme:item.id})}></button>
        {/each}
      </div>
    </div>

    <div class="field">
      <div class="field-head"><span>{$t('色阶')}</span>{#if settings.sensitivity==='custom'}<button type="button" class="link" onclick={()=>change({sensitivity:'med',threshold:0,ceiling:0})}>{$t('恢复自动')}</button>{:else}<em>{$t('自动')}</em>{/if}</div>
      <!-- svelte-ignore a11y_no_static_element_interactions (The handles inside are the accessible sliders; the bare track is a pointer shortcut.) -->
      <div class="ramp" class:empty={!hasData} bind:this={track} onpointerdown={trackDown} onpointermove={pointer} onpointerup={()=>dragging=null} onpointercancel={()=>dragging=null}
        style:--low={`${low*100}%`} style:--high={`${high*100}%`} style:--ramp={swatch(theme)} style:--peak={peak(theme)} style:--glow={heatmapRampHex(theme,'bid',.9)}>
        <span class="ramp-culled" aria-hidden="true"></span><span class="ramp-fill" aria-hidden="true"></span><span class="ramp-peak" aria-hidden="true"></span>
        {#each [{id:'threshold',at:low,value:intensity.threshold,label:'起画'},{id:'ceiling',at:high,value:intensity.ceiling,label:'饱和'}] as handle (handle.id)}
          <span class="handle" class:active={dragging===handle.id} role="slider" tabindex="0" style:left={`${handle.at*100}%`}
            aria-label={$t(handle.label)} aria-valuemin={intensity.minBounds} aria-valuemax={intensity.maxBounds} aria-valuenow={handle.value} aria-valuetext={`${amount(handle.value)} ${unitLabel}`}
            onpointerdown={e=>grab(handle.id as 'threshold'|'ceiling',e)} onpointermove={pointer} onpointerup={()=>dragging=null} onkeydown={e=>nudge(handle.id as 'threshold'|'ceiling',e)}></span>
        {/each}
      </div>
      <div class="ramp-legend">
        <span><i class="culled-dot"></i>{$t('起画')} <b>{amount(intensity.threshold)}</b></span>
        <span>{$t('饱和')} <b>{amount(intensity.ceiling)}</b> {unitLabel}</span>
      </div>
      {#if !hasData}<p class="note">{$t('等待深度数据')}</p>{/if}
      <div class="segmented" role="radiogroup" aria-label={$t('上色范围')}>
        {#each presets as preset (preset.id)}
          <button type="button" role="radio" aria-checked={settings.sensitivity===preset.id} class:chosen={settings.sensitivity===preset.id} title={$t(preset.hint)} onclick={()=>change({sensitivity:preset.id,threshold:0,ceiling:0})}>{$t(preset.label)}</button>
        {/each}
      </div>
    </div>

    <div class="field inline">
      <span>{$t('不透明度')}</span>
      <input type="range" min="0.05" max="0.95" step="0.05" value={settings.opacity} aria-label={$t('热图不透明度')} oninput={e=>change({opacity:e.currentTarget.valueAsNumber})}/>
      <output>{Math.round(settings.opacity*100)}%</output>
    </div>
    <div class="field inline">
      <span>{$t('价位行高')}</span>
      <div class="segmented compact" role="radiogroup" aria-label={$t('价位行高')}>
        <button type="button" role="radio" aria-checked={settings.resolution!=='4k'} class:chosen={settings.resolution!=='4k'} title={$t('每个价位 2px，更醒目')} onclick={()=>change({resolution:'hd'})}>{$t('标准')}</button>
        <button type="button" role="radio" aria-checked={settings.resolution==='4k'} class:chosen={settings.resolution==='4k'} title={$t('每个价位 1px，价位更细')} onclick={()=>change({resolution:'4k'})}>{$t('精细')}</button>
      </div>
    </div>

    <details class="advanced">
      <summary>{$t('统计范围')}</summary>
      <p class="note">{$t('色阶两端的取值范围，留空为自动。')}</p>
      <div class="bounds">
        <label>{$t('下限')}<input type="number" min="0" step="any" value={settings.minBounds||''} placeholder={amount(intensity.minBounds)} onchange={e=>setUnitless('minBounds',e.currentTarget.valueAsNumber)}/></label>
        <label>{$t('上限')}<input type="number" min="0" step="any" value={settings.maxBounds||''} placeholder={amount(intensity.maxBounds)} onchange={e=>setUnitless('maxBounds',e.currentTarget.valueAsNumber)}/></label>
      </div>
    </details>
  </div>
</div>

<style>
  .overlay-settings{display:grid;gap:10px}
  .sheet-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0;font:600 10px var(--font);letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim)}
  .sheet-heading small{font-weight:400;letter-spacing:0;text-transform:none;font-size:10px;opacity:.8}
  .switch-list{display:grid;border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden}
  .switch-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;cursor:pointer;transition:background var(--motion-fast,110ms) ease}
  .switch-row+.switch-row{border-top:1px solid var(--line)}
  .switch-row:hover{background:var(--bg-hover)}
  .switch-copy{display:grid;gap:2px;min-width:0}
  .switch-copy b{font:500 11.5px var(--font);color:var(--text)}
  .switch-copy small{font-size:10px;color:var(--text-dim);line-height:1.4}
  input[role=switch]{appearance:none;flex-shrink:0;position:relative;width:28px;height:16px;margin:0;border:1px solid var(--line);border-radius:999px;background:var(--bg);cursor:pointer;transition:background 160ms ease,border-color 160ms ease}
  input[role=switch]::after{content:'';position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:var(--text-dim);transition:transform 180ms cubic-bezier(.22,1,.36,1),background 160ms ease}
  input[role=switch]:checked{background:color-mix(in srgb,var(--accent) 32%,var(--bg));border-color:var(--accent)}
  input[role=switch]:checked::after{transform:translateX(12px);background:var(--text)}
  input[role=switch]:focus-visible{outline:1px solid var(--accent);outline-offset:2px}
  .render-group{display:grid;gap:12px;padding:2px 0 0;transition:opacity 160ms ease}
  .render-group.dormant{opacity:.5}
  .field{display:grid;gap:6px}
  .field-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--text-dim);font-size:11px}
  .field-head em{font-style:normal;font-size:10px;color:var(--text)}
  .link{min-height:0;height:auto;padding:0;font-size:10px;color:var(--accent);background:none}
  .link:hover{background:none;text-decoration:underline}
  .swatches{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:5px}
  .swatch{height:14px;min-height:14px;padding:0;border-radius:var(--radius-xs);box-shadow:inset 0 0 0 1px var(--line);transition:transform var(--motion-fast,110ms) ease,box-shadow var(--motion-fast,110ms) ease}
  .swatch:hover{transform:translateY(-1px)}
  .swatch.chosen{box-shadow:inset 0 0 0 1px var(--line),0 0 0 1px var(--bg-panel),0 0 0 2px var(--accent)}
  .ramp{--low:20%;--high:80%;position:relative;height:18px;margin:4px 5px 0;border-radius:var(--radius-xs);background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);touch-action:none;cursor:pointer}
  .ramp>span[aria-hidden]{position:absolute;top:1px;bottom:1px;pointer-events:none;border-radius:var(--radius-xs)}
  .ramp-culled{left:1px;width:calc(var(--low) - 1px);background:repeating-linear-gradient(135deg,transparent 0 3px,color-mix(in srgb,var(--line) 90%,transparent) 3px 4px)}
  .ramp-fill{left:var(--low);width:calc(var(--high) - var(--low));background:var(--ramp)}
  .ramp-peak{left:var(--high);right:1px;background:var(--peak);box-shadow:0 0 8px color-mix(in srgb,var(--glow) 40%,transparent)}
  .ramp.empty .ramp-fill,.ramp.empty .ramp-peak{opacity:.35}
  .handle{position:absolute;top:-4px;bottom:-4px;width:10px;margin-left:-5px;cursor:ew-resize;outline:none;touch-action:none}
  .handle::before{content:'';position:absolute;left:4px;top:0;bottom:0;width:2px;border-radius:1px;background:var(--text);box-shadow:0 0 0 1px var(--line)}
  .handle::after{content:'';position:absolute;left:1px;bottom:-3px;width:8px;height:8px;border-radius:var(--radius-xs);background:var(--text);box-shadow:0 1px 3px rgb(0 0 0 / calc(0.53 * var(--shadow-strength)));transition:transform var(--motion-fast,110ms) ease}
  .handle:hover::after,.handle.active::after{transform:scale(1.2)}
  .handle:focus-visible::after{outline:1px solid var(--accent);outline-offset:2px}
  .ramp-legend{display:flex;justify-content:space-between;gap:8px;margin-top:3px;font:10px var(--mono);color:var(--text-dim)}
  .ramp-legend b{font-weight:500;color:var(--text)}
  .culled-dot{display:inline-block;width:8px;height:8px;margin-right:4px;vertical-align:-1px;border-radius:var(--radius-xs);background:repeating-linear-gradient(135deg,transparent 0 2px,var(--text-dim) 2px 3px);box-shadow:inset 0 0 0 1px var(--line)}
  .note{margin:0;font-size:10px;color:var(--text-dim);line-height:1.5}
  .segmented{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:2px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--bg)}
  .segmented button{min-height:24px;height:24px;padding:0 6px;border-radius:var(--radius-sm);font:500 11px var(--font);transition:background var(--motion-fast,110ms) ease,color var(--motion-fast,110ms) ease}
  .segmented button.chosen{background:var(--bg-hover);color:var(--text);box-shadow:0 1px 2px rgb(0 0 0 / calc(0.27 * var(--shadow-strength)))}
  .segmented.compact{min-width:118px}
  .field.inline{grid-template-columns:auto 1fr auto;align-items:center;gap:10px;color:var(--text-dim);font-size:11px}
  .field.inline .segmented{grid-column:2/4;justify-self:end}
  .field.inline input[type=range]{width:100%;height:18px;padding:0;border:0;background:none;accent-color:var(--accent)}
  .field.inline output{font:10px var(--mono);color:var(--text);min-width:30px;text-align:right}
  .advanced>summary{font-size:11px;color:var(--text-dim);cursor:pointer;padding:2px 0;list-style:none}
  .advanced>summary::before{content:'›';display:inline-block;width:12px;transition:transform var(--motion-fast,110ms) ease}
  .advanced[open]>summary::before{transform:rotate(90deg)}
  .advanced>summary::-webkit-details-marker{display:none}
  .advanced[open]{display:grid;gap:6px}
  .bounds{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .bounds label{display:grid;gap:4px;font-size:10px;color:var(--text-dim)}
  .bounds input{width:100%}
  @media(pointer:coarse){.switch-row{padding-block:11px}.segmented button{min-height:36px;height:36px}.swatch{height:24px;min-height:24px}.handle{width:22px;margin-left:-11px}.handle::before{left:10px}.handle::after{left:7px}}
  @media(prefers-reduced-motion:reduce){.switch-row,input[role=switch],input[role=switch]::after,.render-group,.swatch,.handle::after,.segmented button{transition:none}}
</style>
