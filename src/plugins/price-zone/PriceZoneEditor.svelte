<script lang="ts">
  import {t} from '../../lib/i18n';
  import type { ToolEditorProps } from '../../components/drawing/plugin-registry';
  let {drawing,update,disabled=false}:ToolEditorProps=$props();
</script>
<div class="zone-editor">
  <label>{$t('区域名称')}<input aria-label={$t('区域名称')} value={String(drawing.props.label)} {disabled} maxlength="80" onchange={(e)=>update({label:e.currentTarget.value})} /></label>
  <div class="zone-intent" aria-label={$t('价格区域用途')}>
    {#each ['观察','支撑','阻力'] as intent}<button class:chosen={drawing.props.intent===intent} aria-pressed={drawing.props.intent===intent} {disabled} onclick={()=>update({intent})}>{$t(intent)}</button>{/each}
  </div>
</div>
<style>
  .zone-editor{display:grid;gap:14px}.zone-editor label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-dim)}input{width:220px;flex:1;min-width:0;background:var(--bg);border:1px solid var(--line);color:var(--text);padding:8px;font-size:12px}.zone-intent{display:flex}.zone-intent button{padding:8px 16px;font-size:12px;border:1px solid var(--line)}.chosen{color:#b9cfff;background:#2962ff25}
</style>
