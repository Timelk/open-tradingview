<script lang="ts">
  import {t,locale,translateError} from '../../lib/i18n';
 import {commandSearchText,contextMenuLabel} from '../../lib/ui/context-menu';
 import {onMount,tick} from 'svelte';
 import {surface} from '../../lib/ui/motion';
 let {commands,onClose}:{commands:{id:string;label:string;literalLabel?:boolean;keywords?:string;shortcut?:string;run:()=>void|Promise<void>}[];onClose:()=>void}=$props();
 let dialog:HTMLDialogElement,input:HTMLInputElement;let query=$state(''),selected=$state(0),error=$state(''),recent=$state<string[]>([]);
 const results=$derived(commands.filter(c=>commandSearchText(c,$t).includes(query.toLowerCase().trim())).sort((a,b)=>{const rank=(id:string)=>recent.includes(id)?recent.indexOf(id):999;return rank(a.id)-rank(b.id);}));
 $effect(()=>{query;selected=0;});
 onMount(()=>{try{const raw=JSON.parse(localStorage.getItem('tvchart.commands.recent')??'[]');if(Array.isArray(raw))recent=raw.filter((x:unknown)=>typeof x==='string').slice(0,8);}catch{}const previous=document.activeElement as HTMLElement;dialog.showModal();input.focus();return()=>{if(dialog.open)dialog.close();if(previous?.isConnected&&!document.querySelector('dialog[open]'))previous.focus();};});
 function close(){dialog.close();onClose();}
 async function execute(index:number){const command=results[index];if(!command)return;try{recent=[command.id,...recent.filter(id=>id!==command.id)].slice(0,8);try{localStorage.setItem('tvchart.commands.recent',JSON.stringify(recent));}catch{}dialog.close();onClose();await tick();await command.run();}catch(e){error=e instanceof Error?e.message:'操作未完成';}}
 async function keys(event:KeyboardEvent){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();selected=(selected+(event.key==='ArrowDown'?1:-1)+Math.max(1,results.length))%Math.max(1,results.length);await tick();dialog.querySelector('[data-selected="true"]')?.scrollIntoView({block:'nearest'});}if(event.key==='Enter'){event.preventDefault();void execute(selected);}}
</script>
<dialog bind:this={dialog} aria-label={$t("搜索功能和快捷操作")} transition:surface={{enter:170,exit:100,y:4}} oncancel={e=>{e.preventDefault();close();}} onkeydown={keys}>
 <header><input bind:this={input} bind:value={query} aria-label={$t("搜索工作区功能")} placeholder={$t("搜索功能、布局或快捷操作")} role="combobox" aria-expanded="true" aria-controls="command-results" aria-activedescendant={results[selected]?'command-'+results[selected].id:undefined}/><button onclick={close} aria-label={$t("关闭功能搜索")}>Esc</button></header>
 <div class="command-list" id="command-results" role="listbox" aria-label={$t("工作区命令")}>{#each results as command,i (command.id)}<button role="option" id={'command-'+command.id} aria-selected={selected===i} data-selected={selected===i} onpointermove={()=>selected=i} onclick={()=>execute(i)}><span>{contextMenuLabel(command,$t)}{#if recent.includes(command.id)}<small>{$t("最近使用")}</small>{/if}</span>{#if command.shortcut}<kbd>{command.shortcut}</kbd>{/if}</button>{/each}{#if !results.length}<p>{$t("没有匹配的操作，试试“布局”“指标”或“形态”。")}</p>{/if}</div>
 {#if error}<p role="alert">{translateError(error,$locale)}</p>{/if}<footer>{$t("↑ ↓ 选择 · Enter 执行 · Esc 关闭")}</footer>
</dialog>
<style>
dialog{width:min(580px,calc(100vw - 24px));padding:0;border:1px solid var(--line);background:var(--surface-raised);color:var(--text);box-shadow:var(--shadow-lg);max-height:min(620px,85dvh);overflow:hidden}dialog[open]{display:flex;flex-direction:column}dialog::backdrop{background:color-mix(in srgb, var(--bg-panel) 47%, transparent)}header{display:flex;align-items:center;padding:14px;gap:10px;border-bottom:1px solid var(--line)}header input{flex:1;min-width:0;background:transparent;color:var(--text);border:0;height:38px;font:14px var(--font);padding:0 8px}header button{min-height:36px}footer{padding:11px 18px;border-top:1px solid var(--line);font-size:12px;color:var(--text-dim)}.command-list{overflow:auto;padding:6px}.command-list button{display:flex;align-items:center;justify-content:space-between;text-align:left;width:100%;min-height:44px;padding:9px 12px;font-size:13px;color:var(--text)}.command-list button[data-selected=true]{background:var(--selected)}small{font-size:11px;color:var(--text-dim);margin-left:12px}kbd{font:11px var(--mono);color:var(--text-dim)}p{padding:15px}@media(max-width:767px){header input{font-size:16px}.command-list button{min-height:48px}}
</style>
