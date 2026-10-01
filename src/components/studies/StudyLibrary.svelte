<script lang="ts">
  import {t,locale,translateError,canonicalT} from '../../lib/i18n';
  import {onMount,tick,untrack} from 'svelte';
  import type {ChartController} from '../../lib/chart/controller';
  import {filterStudies,studyDisplayTitle,studyDisplayName,studyDisplayDescription,normalizeStudySection,studyTags,studyCatalog,studyPlacement,type StudyEntry,type StudySection,type StudyTag} from '../../lib/studies/catalog';
  import {loadStudyFavorites,saveStudyFavorites,STUDY_FAVORITES_KEY} from '../../lib/studies/favorites';
  import {surface,setSurfaceInteractive} from '../../lib/ui/motion';
  import ToolIcon from '../drawing/ToolIcon.svelte';
  import StudyPreview from './StudyPreview.svelte';

  let {controller,onClose,initialSection='all'}:{controller:ChartController;onClose:()=>void;initialSection?:StudySection}=$props();
  let dialog:HTMLDialogElement;
  let searchInput=$state<HTMLInputElement>();
  let query=$state(''),activeTag=$state<StudyTag|null>(null);
  let entries=$state(untrack(()=>studyCatalog(controller.registry.list())));
  let section=$state(untrack(()=>normalizeStudySection(initialSection)));
  let favorites=$state<string[]>(loadStudyFavorites());
  let instanceIds=$state(untrack(()=>controller.drawing.document.indicators.map(instance=>instance.id)));
  let closed=$state(false),message=$state(''),error=$state(false),recentlyAdded=$state('');
  let messageValues=$state<Record<string,unknown>>({}),messageEntry=$state<StudyEntry|null>(null);
  const shownMessage=$derived(messageEntry?$t(message,{...messageValues,name:studyDisplayTitle(messageEntry,$t)}):translateError(message,$locale));
  const entryTitle=(entry:StudyEntry)=>studyDisplayTitle(entry,$t);
  const entryDescription=(entry:StudyEntry)=>studyDisplayDescription(entry,$canonicalT);
  const counts=$derived.by(()=>{const next=new Map<string,number>();for(const id of instanceIds)next.set(id,(next.get(id)??0)+1);return next;});
  const results=$derived.by(()=>{const tagId=activeTag?.id;return filterStudies(entries,query,section,'all',favorites).filter(entry=>!tagId||studyTags(entry).some(tag=>tag.id===tagId));});
  const sections=$derived([
    {id:'all',label:'全部',icon:'layers',count:entries.length},
    {id:'builtin',label:'内置',icon:'indicator',count:entries.filter(entry=>entry.source==='builtin').length},
    {id:'pattern',label:'三类形态',icon:'pattern',count:filterStudies(entries,'','pattern','all',[]).length},
    {id:'analysis',label:'结构量价',icon:'data',count:filterStudies(entries,'','analysis','all',[]).length},
    {id:'favorites',label:'收藏夹',icon:'star',count:entries.filter(entry=>favorites.includes(entry.id)).length},
  ]);
  const sectionTitle=$derived({all:'全部指标与策略',builtin:'内置',pattern:'三类形态',analysis:'结构量价',favorites:'收藏夹'}[section]);
  const emptyTitle=$derived(query||activeTag?'没有符合条件的指标或策略':section==='favorites'?'还没有收藏':'暂无指标或策略');
  let previewId=$state('');
  const previewEntry=$derived(results.find(entry=>entry.id===previewId)??results[0]);
  const previewData=$derived(previewEntry?controller.studyPreview?.(previewEntry.id):undefined);
  let returnFocus:HTMLElement|null=null;
  let feedbackTimer:ReturnType<typeof setTimeout>|undefined;

  onMount(()=>{
    returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const unsubscribe=controller.drawing.subscribe(state=>{
      const next=state.scene.document.indicators.map(instance=>instance.id);
      if(next.length!==instanceIds.length||next.some((id,index)=>id!==instanceIds[index]))instanceIds=next;
    });
    const storageChanged=(event:StorageEvent)=>{if(event.key===STUDY_FAVORITES_KEY||event.key===null)favorites=loadStudyFavorites();};
    window.addEventListener('storage',storageChanged);
    dialog.showModal();searchInput?.focus();
    return()=>{unsubscribe();window.removeEventListener('storage',storageChanged);clearTimeout(feedbackTimer);};
  });
  function releaseModal(){if(!dialog)return;dialog.classList.add('closing');setSurfaceInteractive(dialog,false);if(dialog.open)dialog.close();}
  function resumeModal(){if(!dialog?.classList.contains('closing'))return;closed=false;dialog.classList.remove('closing');setSurfaceInteractive(dialog,true);returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;dialog.showModal();searchInput?.focus();}
  function close(){if(closed)return;closed=true;releaseModal();onClose();void tick().then(()=>{if(returnFocus?.isConnected&&returnFocus!==document.body)returnFocus.focus();else controller.focus();});}
  function feedback(text:string,failed=false,added='',values:Record<string,unknown>={},entry:StudyEntry|null=null){clearTimeout(feedbackTimer);message=text;messageValues=values;messageEntry=entry;error=failed;recentlyAdded=added;feedbackTimer=setTimeout(()=>{message='';recentlyAdded='';},failed?7000:4000);}
  function add(entry:StudyEntry){
    try{const instanceId=controller.addIndicator(entry.id);if(!instanceId){feedback(controller.drawing.state.error||'无法添加 {name}，请重试。',true,'',{},controller.drawing.state.error?null:entry);return;}const count=controller.drawing.document.indicators.filter(instance=>instance.id===entry.id).length;feedback('已添加 {name} · 图表中共 {count} 个实例',false,entry.id,{count},entry);}
    catch(reason){feedback(reason instanceof Error?reason.message:'无法添加 {name}，请重试。',true,'',{},reason instanceof Error?null:entry);}
  }
  function toggleFavorite(entry:StudyEntry){const wasFavorite=favorites.includes(entry.id),index=results.findIndex(result=>result.id===entry.id);favorites=wasFavorite?favorites.filter(id=>id!==entry.id):[...favorites,entry.id];const persisted=saveStudyFavorites(favorites);feedback((wasFavorite?'{name}已移出收藏夹':'{name}已加入收藏夹')+(persisted?'':'；浏览器未允许保存，本次会话仍可使用。'),!persisted,'',{},entry);if(wasFavorite&&section==='favorites')void tick().then(()=>{const remaining=dialog.querySelectorAll<HTMLButtonElement>('.favorite-study'),next=remaining[Math.min(index,remaining.length-1)];if(next)next.focus();else searchInput?.focus();});}
  function chooseSection(value:StudySection){section=normalizeStudySection(value);activeTag=null;entries=studyCatalog(controller.registry.list());}
  function rowTargets(){return Array.from(dialog.querySelectorAll<HTMLElement>('.study-row')).map(row=>row.querySelector<HTMLButtonElement>('.add-study')??row.querySelector<HTMLButtonElement>('.favorite-study')).filter((button):button is HTMLButtonElement=>!!button);}
  function resultKeys(event:KeyboardEvent){if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const rows=rowTargets();if(!rows.length)return;const activeRow=document.activeElement?.closest('.study-row'),current=rows.findIndex(row=>row.closest('.study-row')===activeRow);const index=event.key==='Home'?0:event.key==='End'?rows.length-1:(current+(event.key==='ArrowDown'?1:-1)+rows.length)%rows.length;rows[index]?.focus();}
  function toggleTag(tag:StudyTag){activeTag=activeTag?.id===tag.id?null:tag;}
  function trackPreview(event:Event){const row=(event.target as Element|null)?.closest?.('.study-row') as HTMLElement|null;const key=row?.dataset.studyKey;if(key&&key!==previewId)previewId=key;}
</script>

<dialog bind:this={dialog} class="study-library" class:closing={closed} aria-labelledby="study-library-title" aria-hidden={closed} transition:surface|global={{enter:140,exit:100,y:4}} onintrostart={resumeModal} onoutrostart={releaseModal} oncancel={event=>{event.preventDefault();close();}} onclick={event=>{if(event.target===dialog){const bounds=dialog.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)close();}}}>
  <header class="library-header">
    <h2 id="study-library-title" class="sr-only">{$t("指标与策略")}</h2>
    <div class="library-search"><ToolIcon name="search" size={18}/><input bind:this={searchInput} bind:value={query} aria-label={$t("搜索指标或策略")} placeholder={$t("搜索指标、策略或关键词")} autocomplete="off" spellcheck="false" onkeydown={event=>{if(event.key==='ArrowDown'){event.preventDefault();rowTargets()[0]?.focus();}}}/>{#if query}<button class="clear-search" aria-label={$t("清空指标搜索")} title={$t("清空搜索")} onclick={()=>{query='';searchInput?.focus();}}><ToolIcon name="close" size={14}/></button>{/if}</div>
    <button class="close-library" aria-label={$t("关闭指标与策略")} title={$t("关闭 · Esc")} onclick={close}><kbd>esc</kbd></button>
  </header>
  <div class="library-content">
    <nav class="library-nav" aria-label={$t("指标库分类")}>
      {#each sections as item}<button class:current={section===item.id} aria-pressed={section===item.id} onclick={()=>chooseSection(item.id as StudySection)}><ToolIcon name={item.icon} size={15}/><span>{$t(item.label)}</span><small>{item.count}</small></button>{/each}
    </nav>
    <section class="library-results" aria-label={$t(sectionTitle)}>
      <div class="results-heading"><h3>{$t(sectionTitle)}</h3><span>{results.length} {$t("项")}</span>{#if activeTag}<button class="active-tag" title={$t("清除标签筛选")} onclick={()=>activeTag=null}>{$t(activeTag.label)}<ToolIcon name="close" size={11}/></button>{/if}</div>
      <div class="results-scroll" role="region" aria-label={$t("指标与策略结果")}>
        {#if results.length}
          <ul class="study-list" onpointerover={trackPreview} onfocusin={trackPreview}>
            {#each results as entry (entry.id)}
              {@const favorite=favorites.includes(entry.id)}{@const count=counts.get(entry.id)??0}{@const title=entryTitle(entry)}{@const addLabel=$t('添加 {name}',{name:title})}
              <li class="study-row" data-study-key={entry.id} class:just-added={recentlyAdded===entry.id}>
                <button class="favorite-study" onkeydown={resultKeys} class:saved={favorite} aria-label={$t(favorite?'取消收藏 {name}':'收藏 {name}',{name:title})} aria-pressed={favorite} title={$t(favorite?'取消收藏':'加入收藏夹')} onclick={()=>toggleFavorite(entry)}><ToolIcon name="star" size={15}/></button>
                <div class="study-copy">
                  <button class="add-study" onkeydown={resultKeys} aria-label={addLabel} data-tooltip={entryDescription(entry)||$t('添加到{placement}',{placement:$t(studyPlacement(entry.target))})} onclick={()=>add(entry)}><span>{title}</span>{#if entry.title!==entry.name}<code>{studyDisplayName(entry,$t)}</code>{/if}</button>
                  <div class="study-tags" aria-label={$t('{name} 标签',{name:title})}>{#each studyTags(entry,$canonicalT) as tag (tag.id)}<button class="study-tag" onkeydown={resultKeys} class:muted={tag.tone==='muted'} class:filtered={activeTag?.id===tag.id} aria-label={`${title}: ${tag.label}`} aria-pressed={activeTag?.id===tag.id} data-tooltip={$t('{description}\n点击筛选「{tag}」',{description:tag.description,tag:tag.label})} onclick={()=>toggleTag(tag)}>{tag.label}</button>{/each}</div>
                </div>
                <button class="add-action" onkeydown={resultKeys} class:added={count>0} aria-label={$t('{action}到当前图表',{action:addLabel})} data-tooltip={$t('添加一个独立实例到当前图表')} onclick={()=>add(entry)}>{#if recentlyAdded===entry.id}{$t("已添加")}{:else if count>0}<span>{$t("已添加")} {count}</span><ToolIcon name="plus" size={11}/>{:else}<ToolIcon name="plus" size={12}/>{$t("添加")}{/if}</button>
              </li>
            {/each}
          </ul>
        {:else}
          <div class="no-results"><ToolIcon name={section==='favorites'?'star':'search'} size={26}/><strong>{$t(emptyTitle)}</strong><p>{query||activeTag?$t("清除搜索或标签筛选后重试。"):section==='favorites'?$t("点击列表左侧的星标，收藏常用指标与分析模块。"):$t("当前分类没有已注册的分析模块。")}</p>{#if query||activeTag}<button onclick={()=>{query='';activeTag=null;searchInput?.focus();}}>{$t("清除筛选")}</button>{:else if section==='favorites'}<button onclick={()=>chooseSection('all')}>{$t("浏览全部")}</button>{/if}</div>
        {/if}
      </div>
    </section>
    <aside class="library-preview" aria-label={$t("指标预览")} aria-live="polite">
      {#if previewEntry}
        {@const entry=previewEntry}{@const count=counts.get(entry.id)??0}
        {#key entry.id}<div class="preview-body" in:surface={{y:3,enter:150}}>
          <div class="preview-title"><strong>{entryTitle(entry)}</strong>{#if entry.title!==entry.name}<code>{studyDisplayName(entry,$t)}</code>{/if}</div>
          <div class="preview-meta"><span>{$t(studyPlacement(entry.target))}</span>{#if count}<span class="in-chart">{$t("图表中 {count} 个",{count})}</span>{/if}</div>
          {#if previewData}<StudyPreview data={previewData}/><p class="preview-caption">{$t("基于当前图表最近 {0} 根 K 线 · 默认参数",{0:previewData.close.length})}</p>{:else}<div class="preview-placeholder"><ToolIcon name={entry.kind==='strategy'&&!entry.category?'trend':'pattern'} size={24}/><p>{$t(entry.category==='pattern'?'添加到图表后显示识别结果':entry.category==='analysis'?'添加到图表后显示结构与量价分析':entry.kind==='strategy'?'添加到图表后显示信号标注':'当前数据不足以生成预览')}</p></div>{/if}
          {#if entryDescription(entry)}<p class="preview-description">{entryDescription(entry)}</p>{/if}
          <button class="preview-add" onclick={()=>add(entry)}><ToolIcon name="plus" size={14}/>{count?$t("再添加一个"):$t("添加到图表")}</button>
        </div>{/key}
      {/if}
    </aside>
  </div>
  <footer class="library-footer"><span class:error role="status" aria-live="polite">{shownMessage||$t("点击名称或「添加」挂载 · 点击标签筛选 · 悬停或聚焦标签查看说明")}</span><button onclick={close}>{$t("完成")}</button></footer>
</dialog>

<style>
  .study-library{position:fixed;inset:0;margin:9vh auto auto;width:min(1040px,calc(100vw - 32px));height:min(620px,calc(100dvh - 12vh - 16px));max-width:none;max-height:none;padding:0;border:1px solid color-mix(in srgb,var(--line) 80%,var(--ink) 8%);border-radius:12px;background:color-mix(in srgb,var(--bg-panel) 96%,transparent);color:var(--text);box-shadow:var(--shadow-lg);overflow:hidden;flex-direction:column;z-index:45;font-size:12px}
  .study-library[open],.study-library.closing{display:flex}.study-library::backdrop{background:color-mix(in srgb,var(--bg-panel) 60%,transparent);backdrop-filter:blur(3px)}.study-library.closing{pointer-events:none}
  button,input{font:inherit;border-radius:var(--radius-md)}button:focus-visible,input:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}
  .library-header{display:flex;align-items:center;gap:10px;height:62px;padding:0 14px 0 20px;border-bottom:1px solid var(--line);flex-shrink:0}.library-search{display:flex;align-items:center;gap:12px;flex:1;min-width:0;height:100%;color:var(--text-dim)}
  .library-search input{border:0;outline:0;background:transparent;color:var(--text-strong);flex:1;min-width:0;padding:0;height:100%;font:400 17px var(--font)}.library-search input::placeholder{color:color-mix(in srgb,var(--text-dim) 75%,transparent)}
  .clear-search,.close-library{width:40px;height:40px;min-height:40px;padding:0;display:flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--text-dim)}.clear-search:hover,.close-library:hover{background:var(--bg-hover);color:var(--text)}
  kbd{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 5px;border:1px solid var(--line);border-bottom-width:2px;border-radius:var(--radius-sm);background:var(--bg);color:var(--text-dim);font:500 10.5px var(--mono);line-height:1}
  .library-content{display:flex;flex:1;min-height:0}.library-nav{width:144px;flex-shrink:0;border-right:1px solid var(--line);padding:10px 0;display:flex;flex-direction:column;gap:2px;background:var(--bg)}
  .library-nav>button{display:flex;align-items:center;gap:8px;padding:0 10px;min-height:40px;color:var(--text-dim);text-align:left;font-size:11px;white-space:nowrap;margin:0 8px;transition:background-color 120ms ease,color 120ms ease}.library-nav>button:hover,.library-nav>button.current{color:var(--text-strong);background:var(--bg-hover)}.library-nav small{margin-left:auto;font:10px var(--mono);color:var(--text-dim);font-variant-numeric:tabular-nums}
  .library-results{flex:1;min-width:0;display:flex;flex-direction:column}.results-heading{display:flex;align-items:center;gap:9px;padding:10px 14px;min-height:38px;border-bottom:1px solid var(--line);flex-shrink:0}.results-heading h3{font-size:11px;font-weight:500;margin:0;color:var(--text)}.results-heading>span{font:10px var(--mono);color:var(--text-dim);font-variant-numeric:tabular-nums}.active-tag{margin-left:auto;display:flex;align-items:center;gap:6px;padding:3px 6px;border:1px solid var(--line-strong);color:var(--text);font-size:10px}
  .results-scroll{overflow:auto;flex:1;min-height:0;overscroll-behavior:contain}.study-list{list-style:none;margin:0;padding:4px 8px 8px}.study-row{display:flex;align-items:center;gap:6px;min-height:58px;padding:7px 10px 7px 2px;border-radius:9px;transition:background-color 120ms ease}.study-row:hover,.study-row:focus-within{background:var(--bg-hover)}.study-row.just-added{background:color-mix(in srgb,var(--up) 14%,transparent)}
  .favorite-study{display:flex;align-items:center;justify-content:center;width:36px;height:40px;flex-shrink:0;padding:0;color:var(--text-dim)}.favorite-study.saved{color:var(--warn)}.favorite-study.saved :global(svg){fill:color-mix(in srgb,var(--warn) 20%,transparent)}.study-copy{min-width:0;flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:4px}
  .add-study{display:inline-flex;align-items:center;justify-content:flex-start;gap:7px;min-width:0;text-align:left;padding:0;min-height:20px;color:var(--text);font-size:12.5px;border:0;background:transparent;cursor:pointer}.add-study:hover>span{color:var(--accent)}.add-study>span{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-weight:500}.add-study code{font:10px var(--mono);color:var(--accent);background:var(--bg);padding:1px 5px;border-radius:var(--radius-xs);border:1px solid var(--line);flex-shrink:0}
  .study-tags{display:flex;align-items:center;gap:4px;flex-wrap:wrap}.study-tag{padding:1px 5px;min-height:19px;line-height:1.4;font-size:10px;color:var(--text-dim);background:var(--bg);border:1px solid var(--line);cursor:pointer;white-space:nowrap}.study-tag:hover,.study-tag.filtered{color:var(--text-strong);border-color:var(--text-dim);background:var(--bg-active)}.study-tag.muted{background:transparent}.add-action{display:flex;align-items:center;justify-content:center;gap:4px;min-height:36px;flex-shrink:0;padding:4px 6px;font-size:11px;white-space:nowrap;min-width:58px;color:var(--accent);border:1px solid var(--line-strong)}.add-action.added{color:var(--text-dim)}.add-action:hover{background:var(--bg-active)}
  .library-footer{display:flex;align-items:center;gap:12px;min-height:43px;padding:7px 15px;border-top:1px solid var(--line);flex-shrink:0}.library-footer>span{font-size:10px;line-height:1.7;color:var(--text-dim);flex:1;min-width:0}.library-footer>span.error{color:var(--warn)}.library-footer>button{border:1px solid var(--line-strong);background:var(--bg-active);color:var(--text);min-height:36px;padding:3px 12px;font-size:11px}
  .no-results{min-height:210px;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--text-dim);gap:10px}.no-results strong{font-size:13px;font-weight:500;color:var(--text)}.no-results p{max-width:280px;line-height:1.8;font-size:11px;margin:0}.no-results button{padding:6px 10px;min-height:40px;border:1px solid var(--line-strong);font-size:11px;color:var(--text)}
  .library-preview{width:320px;flex-shrink:0;border-left:1px solid var(--line);background:color-mix(in srgb,var(--bg) 55%,transparent);overflow:auto;scrollbar-width:thin}.preview-body{display:flex;flex-direction:column;gap:12px;padding:18px 16px 16px;min-height:100%;box-sizing:border-box}.preview-title{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.preview-title strong{font-size:15px;font-weight:600;color:var(--text-strong);text-wrap:balance}.preview-title code{font:10.5px var(--mono);color:var(--accent);background:var(--bg);padding:1px 6px;border-radius:var(--radius-sm)}
  .preview-meta{display:flex;gap:6px;margin-top:-4px}.preview-meta span{font-size:10.5px;padding:2px 7px;border-radius:999px;background:var(--bg);color:var(--text-dim);font-variant-numeric:tabular-nums}.preview-meta .in-chart{color:var(--up)}.preview-caption{margin:-4px 0 0;font-size:10.5px;color:var(--text-dim)}.preview-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:176px;border-radius:var(--radius-lg);border:1px dashed var(--line);color:var(--text-dim);text-align:center;padding:16px}.preview-placeholder p{margin:0;font-size:11.5px;line-height:1.6}.preview-description{margin:0;font-size:12px;line-height:1.7;color:var(--text);text-wrap:pretty}
  .preview-add{display:inline-flex;align-items:center;justify-content:center;gap:6px;margin-top:auto;min-height:40px;border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);border-radius:var(--radius-lg);background:color-mix(in srgb,var(--accent) 16%,var(--bg-panel));color:var(--text-strong);font:600 12.5px var(--font)}.preview-add:hover{background:color-mix(in srgb,var(--accent) 24%,var(--bg-panel))}
  @media(max-width:900px){.library-preview{display:none}}@media(max-width:650px){.library-header{padding:0 12px}.library-nav{width:116px}.library-nav>button{padding-inline:6px;gap:5px}.study-row{padding-right:6px;gap:3px}.favorite-study{width:30px}.add-study{font-size:11px}.add-study code{display:none}.add-action{min-width:46px;font-size:10px}.study-tag{font-size:9px;padding-inline:4px}.library-footer{padding-inline:12px}}
  @media(max-width:470px){.study-library{width:calc(100vw - 16px);height:calc(100dvh - 24px);margin:12px auto}.library-content{flex-direction:column}.library-nav{width:100%;flex-direction:row;border-right:0;border-bottom:1px solid var(--line);padding:3px;gap:0}.library-nav>button{flex:1;justify-content:center;padding:0 4px;margin:0;min-width:0;font-size:10px}.library-nav small,.library-nav :global(svg){display:none}.library-results{min-height:0}.results-heading{padding-block:8px;min-height:33px}}
  @media(pointer:coarse){.favorite-study,.add-action{min-height:40px}.study-tag{min-height:27px}.study-row{padding-block:9px}}@media(prefers-reduced-motion:reduce){.study-row,.library-nav>button{transition:none}}
</style>
