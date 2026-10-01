<script lang="ts">
  import {t} from '../lib/i18n';
  import { onMount } from 'svelte';
  import { SHORTCUT_GROUPS,isMacShortcutPlatform,shortcutKeyLabel } from '../lib/ui/shortcuts';
  import ToolIcon from './drawing/ToolIcon.svelte';
  let {onClose}:{onClose:()=>void}=$props();
  let dialog:HTMLDialogElement;
  let closed=false;
  let search=$state('');
  const groups=$derived(SHORTCUT_GROUPS.map(group=>({...group,shortcuts:group.shortcuts.filter(item=>([group.title,$t(group.title),item.label,$t(item.label),item.note??'',$t(item.note??''),...item.keys.flat().map(key=>$t(shortcutKeyLabel(key,mac)))].join(' ')).toLowerCase().includes(search.toLowerCase().trim()))})).filter(group=>group.shortcuts.length));
  const mac=isMacShortcutPlatform();
  function close(){if(closed)return;closed=true;dialog.close();onClose();}
  onMount(()=>{
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
    dialog.showModal();dialog.querySelector<HTMLButtonElement>('.close-help')?.focus();
    return ()=>{if(dialog.open)dialog.close();if(previous?.isConnected)previous.focus();};
  });
</script>

<dialog bind:this={dialog} class="keyboard-help" aria-labelledby="keyboard-help-title" oncancel={(e)=>{e.preventDefault();close();}} onclick={(e)=>{if(e.target!==dialog)return;const rect=dialog.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)close();}}>
  <header><div><h2 id="keyboard-help-title">{$t("键盘快捷键")}</h2><p>{$t("同一个按键会根据焦点所在区域执行不同操作。")}</p></div><button class="close-help" aria-label={$t("关闭快捷键帮助")} onclick={close}><ToolIcon name="close" size={20}/></button></header>
  <input class="shortcut-search" aria-label={$t("搜索快捷键")} placeholder={$t("搜索操作或按键")} bind:value={search}/><div class="shortcut-sections">
    {#each groups as group}
      <section aria-labelledby={`shortcuts-${group.id}`}>
        <h3 id={`shortcuts-${group.id}`}>{$t(group.title)}</h3><p class="context">{$t(group.context)}</p>
        <dl>{#each group.shortcuts as item}<div class="shortcut-row"><dt>{$t(item.label)}{#if item.note}<span>{$t(item.note)}</span>{/if}</dt><dd>
          {#each item.keys as chord,i}{#if i}<span class="or">{$t("或")}</span>{/if}<span class="chord">{#each chord as key}<kbd>{$t(shortcutKeyLabel(key,mac))}</kbd>{/each}</span>{/each}
        </dd></div>{/each}</dl>
      </section>
    {/each}
  </div>
  <footer><span>{$t("按")} <kbd>Esc</kbd> {$t("关闭此窗口")}</span><button onclick={close}>{$t("完成")}</button></footer>
</dialog>

<style>
  .keyboard-help{width:min(660px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--line-strong);background:var(--surface-raised);color:var(--text-strong);box-shadow:var(--shadow-lg);overflow:hidden}.keyboard-help[open]{display:flex;flex-direction:column}.keyboard-help::backdrop{background:color-mix(in srgb, var(--bg-panel) 44%, transparent)}
  header{display:flex;align-items:flex-start;gap:16px;padding:20px 22px 16px;border-bottom:1px solid var(--line-strong);flex-shrink:0}h2{font-size:18px;font-weight:500;margin:0;text-wrap:balance}header p{font-size:11px;color:var(--text-dim);margin:8px 0 0;line-height:1.7;text-wrap:pretty}.close-help{width:40px;height:40px;margin:-7px -8px 0 auto;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0}
  .shortcut-sections{overflow:auto;padding:0 22px 22px}section{padding-top:20px}h3{font-size:13px;font-weight:500;margin:0 0 7px;color:var(--text-strong)}.context{font-size:11px;color:var(--text-dim);line-height:1.8;margin:0 0 10px;text-wrap:pretty}dl{margin:0}.shortcut-row{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:36px;border-bottom:1px solid color-mix(in srgb, var(--line) 17%, transparent)}dt{font-size:11px;color:var(--text);line-height:1.7}dt>span{display:block;font-size:11px;color:var(--text-dim)}dd{margin:0;display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap;flex-shrink:0}.chord{display:inline-flex;gap:4px;align-items:center}.or{font-size:11px;color:var(--text-dim)}kbd{display:inline-flex;align-items:center;justify-content:center;min-width:23px;height:23px;padding:1px 6px;border:1px solid var(--line-strong);background:var(--bg-panel);font:11px var(--mono);font-variant-numeric:tabular-nums;color:var(--text-strong)}
  footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 22px;border-top:1px solid var(--line-strong);flex-shrink:0}footer>span{font-size:11px;color:var(--text-dim);display:flex;align-items:center;gap:6px}footer>button{min-width:72px;min-height:40px;background:var(--accent);color:white;font-size:12px;padding:6px 16px;border:1px solid var(--accent)}
  @media(max-width:480px){header{padding:16px}.shortcut-sections{padding:0 16px 16px}.shortcut-row{align-items:flex-start;gap:9px;padding:7px 0}dd{max-width:53%;flex-shrink:1}kbd{font-size:11px;min-width:21px;height:23px;padding-inline:4px}footer{padding:12px 16px}}
.shortcut-search{flex-shrink:0;margin:12px 20px 0;padding:9px 12px;background:var(--bg);border:1px solid var(--line);color:var(--text);font-size:13px}</style>
