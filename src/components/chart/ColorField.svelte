<script lang="ts">
  import {untrack} from 'svelte';
  import {t} from '../../lib/i18n';
  import {normalizeColor} from '../../lib/chart/appearance';
  let {id,label,value,disabled=false,resetKey=0,onchange,onvalidity}:{id:string;label:string;value:string;disabled?:boolean;resetKey?:number;onchange:(color:string)=>void;onvalidity?:(valid:boolean)=>void}=$props();
  let text=$state(''),invalid=$state(false),seenReset=-1;
  const swatches=['#26a69a','#ef5350','#72a7ef','#ffffff','#151718'];
  $effect(()=>{const next=value,reset=resetKey;untrack(()=>{const keepTypedValue=seenReset===reset&&normalizeColor(text)===next;seenReset=reset;if(keepTypedValue)return;text=next;invalid=false;onvalidity?.(true);});});
  function change(next:string){text=next;const color=normalizeColor(next);invalid=!color;onvalidity?.(!invalid);if(color)onchange(color);}
  function choose(next:string){text=next;invalid=false;onvalidity?.(true);onchange(next);}
</script>

<div class="color-field" class:disabled>
  <label for={id}>{label}</label>
  <div class="color-editor" class:invalid>
    <input class="picker" type="color" value={value} aria-label={$t('选择{label}',{label})} {disabled} oninput={event=>choose(event.currentTarget.value)} />
    <input {id} class="hex" value={text} spellcheck={false} autocomplete="off" maxlength="9" aria-invalid={invalid} aria-describedby={invalid?`${id}-error`:undefined} {disabled} oninput={event=>change(event.currentTarget.value)} onblur={()=>{if(!invalid)text=normalizeColor(text)??value;}} />
    <details class="swatches">
      <summary aria-label={$t('常用颜色')} title={$t('常用颜色')} tabindex={disabled?-1:0} aria-disabled={disabled}>⌄</summary>
      <div class="swatch-popover" aria-label={$t('常用颜色')}>
        {#each swatches as color}<button type="button" style:--swatch={color} aria-label={$t('使用颜色 {color}',{color})} {disabled} onclick={event=>{choose(color);event.currentTarget.closest('details')?.removeAttribute('open');}}></button>{/each}
      </div>
    </details>
  </div>
  {#if invalid}<small class="color-error" id={`${id}-error`}>{$t('输入 #RGB 或 #RRGGBB 颜色。')}</small>{/if}
</div>

<style>
  .color-field{min-width:0;display:flex;flex-direction:column;gap:6px;position:relative}.color-field>label{color:var(--text-dim);font-size:11px;line-height:1.35}.color-editor{min-width:0;display:flex;align-items:center;border:1px solid var(--line);background:var(--bg);height:34px}.color-editor:focus-within{border-color:var(--focus,var(--accent));box-shadow:0 0 0 1px var(--focus,var(--accent))}.color-editor.invalid{border-color:var(--down)}.picker{width:32px;height:30px;min-width:32px;padding:5px;border:0;background:transparent;cursor:pointer}.picker::-webkit-color-swatch-wrapper{padding:0}.picker::-webkit-color-swatch{border:1px solid var(--line);border-radius:0}.hex{font:11px var(--mono);letter-spacing:.02em;color:var(--text);background:transparent;border:0;min-width:0;width:100%;padding:5px 2px;outline:none}.swatches{position:relative;height:100%;flex:none}.swatches summary{height:100%;width:25px;display:grid;place-items:center;cursor:pointer;color:var(--text-dim);list-style:none;border-left:1px solid var(--line)}.swatches summary::-webkit-details-marker{display:none}.swatches summary:hover{background:var(--bg-hover);color:var(--text)}.swatch-popover{position:absolute;z-index:4;right:0;top:calc(100% + 5px);display:flex;gap:5px;background:var(--bg-panel);padding:7px;border:1px solid var(--line);box-shadow:var(--shadow-md)}.swatch-popover button{width:25px;height:25px;border:1px solid var(--line);background:var(--swatch);padding:0;cursor:pointer}.swatch-popover button:focus-visible,summary:focus-visible{outline:2px solid var(--focus,var(--accent));outline-offset:2px}.disabled{opacity:.45}.disabled .swatches{pointer-events:none}.color-error{font-size:10px;color:var(--down);line-height:1.4}.picker:disabled,.hex:disabled{cursor:not-allowed}@media(pointer:coarse){.color-editor{height:40px}.swatch-popover button{width:32px;height:32px}}
</style>
