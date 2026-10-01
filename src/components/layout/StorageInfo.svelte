<script lang="ts">
  import {t} from '../../lib/i18n';
  import {onMount} from 'svelte';
  import ToolIcon from '../drawing/ToolIcon.svelte';
  let {onClose}:{onClose:()=>void}=$props();
  const appVersion='open-tradingview · 图表与分析版';
  let dialog:HTMLDialogElement;
  let origin=$state('正在读取当前地址');
  let copyNotice=$state(''),copyFailed=$state(false),copying=$state(false);
  let closed=false,backdropPressed=false;
  function close(){if(closed)return;closed=true;if(dialog.open)dialog.close();onClose();}
  function outside(event:MouseEvent){if(!backdropPressed||event.target!==dialog)return;const bounds=dialog.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)close();}
  onMount(()=>{origin=window.location.origin;const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;dialog.showModal();dialog.querySelector<HTMLButtonElement>('.close-storage')?.focus();return()=>{if(dialog.open)dialog.close();if(previous?.isConnected&&!document.querySelector('dialog[open]'))previous.focus({preventScroll:true});};});
  async function copySummary(){
    if(copying)return;copying=true;copyNotice='';copyFailed=false;
    const summary=[$t('存储与版本诊断'),$t('界面版本：{version}',{version:$t(appVersion)}),$t('当前地址：{origin}',{origin}),$t('布局 / 绘图 / 自选 / 收藏：当前浏览器 localStorage'),$t('实时行情：当前会话内存'),$t('行情档案：本地服务 SQLite'),$t('深度采样：本地服务 SQLite')].join('\n');
    try{if(!navigator.clipboard?.writeText)throw Error('clipboard unavailable');await navigator.clipboard.writeText(summary);copyNotice='已复制诊断摘要。';}catch{copyFailed=true;copyNotice='复制失败，请手动选中所需信息复制。';}finally{copying=false;}
  }
</script>
<dialog bind:this={dialog} class="storage-dialog" aria-labelledby="storage-title" aria-describedby="storage-scope" oncancel={event=>{event.preventDefault();close();}} onpointerdown={event=>{const bounds=dialog.getBoundingClientRect();backdropPressed=event.target===dialog&&(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom);}} onclick={outside}>
  <header><div><h2 id="storage-title">{$t("存储与版本")}</h2><p id="storage-scope">{$t("浏览器偏好与本地行情数据分别保存")}</p></div><button type="button" class="close-storage" aria-label={$t("关闭存储与版本")} onclick={close}><ToolIcon name="close" size={17}/></button></header>
  <div class="storage-content">
    <section aria-labelledby="storage-address-title"><h3 id="storage-address-title">{$t("当前工作区")}</h3><dl><dt>{$t("当前地址")}</dt><dd class="mono address">{origin==='正在读取当前地址'?$t('正在读取当前地址'):origin}</dd><dt>{$t("界面版本")}</dt><dd>{$t(appVersion)}</dd></dl><p class="hint">{$t("协议、主机或端口不同，会使用各自的本地存储。")}</p></section>
    <section aria-labelledby="storage-map-title">
      <h3 id="storage-map-title">{$t("数据存放位置")}</h3>
      <table aria-label={$t("工作区数据的存储位置")}><thead><tr><th scope="col">{$t("数据")}</th><th scope="col">{$t("存储位置")}</th></tr></thead><tbody>
        <tr><th scope="row">{$t("布局 / 绘图 / 自选 / 收藏")}</th><td>localStorage<span class="secondary">{$t("当前浏览器 / 此地址")}</span></td></tr>
        <tr><th scope="row">{$t("实时行情")}</th><td>{$t("内存")}<span class="secondary">{$t("当前页面会话")}</span></td></tr>
        <tr><th scope="row">{$t("行情档案与人工录制")}</th><td>SQLite<span class="secondary mono">.data/market/market.sqlite</span></td></tr>
        <tr><th scope="row">{$t("近期深度采样")}</th><td>SQLite<span class="secondary mono">.data/depth/depth-samples.sqlite</span></td></tr>
      </tbody></table>
      <p class="hint">{$t("SQLite 由本地开发或预览服务提供，纯静态页面不包含这些服务。")}</p>
      <p class="hint backup-note">{$t("清除站点数据可能移除布局、绘图、自选和收藏；服务器行情档案另行保存在本地数据目录。")}</p>
    </section>
  </div>
  <footer><p class:copy-failed={copyFailed} role="status">{$t(copyNotice||'只读诊断，不会修改或清除数据。')}</p><button type="button" onclick={copySummary} disabled={copying}>{copying?$t("正在复制…"):$t("复制诊断摘要")}</button><button type="button" onclick={close}>{$t("关闭")}</button></footer>
</dialog>

<style>
  .storage-dialog{position:fixed;inset:0;margin:auto;width:min(680px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--line,#364253);border-radius:0;background:var(--bg-panel,#1c222a);color:var(--text,#e7eef7);box-shadow:var(--shadow-lg);overflow:hidden;font-size:12px}
  .storage-dialog[open]{display:flex;flex-direction:column}
  .storage-dialog::backdrop{background:color-mix(in srgb, var(--bg-panel) 43%, transparent)}
  header{display:flex;align-items:flex-start;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line,#364253)}
  h2{margin:0;font-size:16px;font-weight:600;line-height:1.4}
  header p{margin:4px 0 0;color:var(--text-dim,#a4b3c6);font-size:11px;line-height:1.5}
  button{min-height:30px;padding:4px 10px;border:1px solid var(--line,#364253);border-radius:0;color:var(--text,#e7eef7);background:transparent;font:inherit;white-space:nowrap}
  button:hover{background:var(--selected,#26374d)}
  button:focus-visible{outline:2px solid var(--accent,#91baf2);outline-offset:2px}
  button:disabled{opacity:.55}
  .close-storage{display:flex;align-items:center;justify-content:center;margin-left:auto;width:30px;min-width:30px;height:30px;padding:0}
  .storage-content{padding:0 16px;overflow:auto;overscroll-behavior:contain;min-height:0;user-select:text}
  section{padding:13px 0}
  section+section{border-top:1px solid var(--line,#364253)}
  h3{margin:0 0 10px;font-size:12px;line-height:1.5;font-weight:600}
  dl{display:grid;grid-template-columns:132px minmax(0,1fr);gap:7px 12px;margin:0;line-height:1.55}
  dt{color:var(--text-dim,#a4b3c6)}
  dd{margin:0;min-width:0;overflow-wrap:anywhere}
  .mono{font-family:var(--mono,ui-monospace,monospace);font-size:11px}
  .address{color:var(--accent,#91baf2);font-size:12px}
  .secondary{display:block;margin-top:2px;color:var(--text-dim,#a4b3c6);font-size:11px}
  .hint{margin:9px 0 0;color:var(--text-dim,#a4b3c6);font-size:11px;line-height:1.7;text-wrap:pretty}
  table{border-collapse:collapse;table-layout:fixed;width:100%;font-size:12px;line-height:1.5}
  th,td{padding:7px 8px;border-bottom:1px solid var(--line,#364253);text-align:left;vertical-align:top;overflow-wrap:anywhere}
  th{width:43%;font-weight:400}
  thead th{font-size:11px;color:var(--text-dim,#a4b3c6);background:var(--bg-panel)}
  tbody th{color:var(--text-dim,#a4b3c6)}
  .backup-note{margin-top:12px}
  footer{display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid var(--line,#364253)}
  footer p{flex:1;margin:0;font-size:11px;line-height:1.5;color:var(--text-dim,#a4b3c6)}
  footer p.copy-failed{color:var(--warn)}
  @media(max-width:500px){.storage-dialog{width:calc(100vw - 16px);max-height:calc(100dvh - 16px)}header,.storage-content{padding-inline:12px}dl{grid-template-columns:100px minmax(0,1fr);gap:7px 9px}footer{padding:10px 12px;flex-wrap:wrap}footer p{flex-basis:100%}footer button:first-of-type{margin-left:auto}th,td{padding-inline:5px}}
  @media(pointer:coarse){button{min-height:44px}.close-storage{width:44px;min-width:44px;height:44px}}
</style>
