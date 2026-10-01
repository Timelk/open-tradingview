<script lang="ts">
  import {t, locale} from '../../lib/i18n';
  import { tick, untrack, onMount } from 'svelte';
  import { panelMetrics, observeCoarsePointer, type PanelDensity } from '../../lib/ui/panel-density';
  import type { WatchlistStore } from '../../lib/watchlist/store';
  import type { MarketSymbol, TickerQuote, WatchlistQuoteSnapshot } from '../../lib/watchlist/types';
  import { WATCHLIST_QUOTE_STALE_MS } from '../../lib/watchlist/quotes';
  import { surface, setSurfaceInteractive } from '../../lib/ui/motion';
  import { quoteChange, quotePercent, quotePrice, quoteVolume } from './format';
  import ToolIcon from '../drawing/ToolIcon.svelte';

  let { store, quoteState, catalog, currentSymbol, onSelect, onAdd, onClose, onOrderChange, onRetry, density='compact', embedded=false }: {
    store: WatchlistStore; quoteState: WatchlistQuoteSnapshot; catalog: MarketSymbol[]; currentSymbol: string;
    onSelect: (symbol: string) => void; onAdd: () => void; onClose: () => void; onOrderChange?: (symbols: string[]) => void; onRetry?: () => void; density?:PanelDensity; embedded?:boolean;
  } = $props();
  let coarse=$state(false),detailsOpen=$state(true);
  const metrics=$derived(panelMetrics(density,coarse));
  onMount(()=>observeCoarsePointer(value=>coarse=value));
  let document = $state(untrack(() => store.snapshot));
  let canUndo = $state(untrack(() => store.canUndo)), storeError = $state(untrack(() => store.error));
  let menuOpen = $state(false), editing = $state<'create' | 'rename' | null>(null), nameDraft = $state('');
  let menuSession = $state(0);
  let message = $state(''), focusedSymbol = $state(''), dragging = $state(''), dropSymbol = $state(''), dropAfter = $state(false);
  let sortBy = $state<'manual' | 'price' | 'absolute' | 'change'>('manual'), sortDirection = $state<'asc' | 'desc'>('desc');
  let panel = $state<HTMLElement>();
  let menuButton: HTMLButtonElement;
  let listMenu=$state<HTMLDivElement>();
  let menuLeft=$state(8),menuTop=$state(8),menuMaxHeight=$state(300);
  let nameInput = $state<HTMLInputElement>();
  let lastOrder: string | null = null;
  $effect(()=>{if(!listMenu)return;const node=listMenu;untrack(()=>{node.showPopover();setSurfaceInteractive(node,true);positionMenu(node);if(!editing)node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();});const observer=new ResizeObserver(()=>positionMenu(node));observer.observe(node);return ()=>observer.disconnect();});
  $effect(() => store.subscribe(value => { document = value; canUndo = store.canUndo; storeError = store.error; }));
  const activeId = $derived(document.activeId);
  $effect(() => { activeId; untrack(() => { sortBy = 'manual'; focusedSymbol = ''; }); });
  const activeList = $derived(document.lists.find(list => list.id === document.activeId) ?? document.lists[0]);
  const marketBySymbol = $derived(new Map(catalog.map(item => [item.symbol, item])));
  const orderedSymbols = $derived.by(() => {
    const symbols = [...activeList.symbols];
    if (sortBy === 'manual') return symbols;
    return symbols.sort((a, b) => {
      const av = sortBy === 'price' ? quoteState.quotes[a]?.last : sortBy === 'absolute' ? quoteState.quotes[a]?.change : quoteState.quotes[a]?.changePercent;
      const bv = sortBy === 'price' ? quoteState.quotes[b]?.last : sortBy === 'absolute' ? quoteState.quotes[b]?.change : quoteState.quotes[b]?.changePercent;
      if (av === undefined || !Number.isFinite(av)) return bv === undefined || !Number.isFinite(bv) ? 0 : 1;
      if (bv === undefined || !Number.isFinite(bv)) return -1;
      return sortDirection === 'asc' ? av - bv : bv - av;
    });
  });
  const orderKey = $derived(`${document.activeId}:${orderedSymbols.join(',')}`);
  $effect(() => {
    const key = orderKey;
    if (key === lastOrder) return;
    lastOrder = key;
    untrack(() => onOrderChange?.([...orderedSymbols]));
  });
  const detailMarket = $derived(market(currentSymbol));
  const detailQuote = $derived(quoteState.quotes[currentSymbol]);
  const quoteCheckedAt = $derived.by(() => { quoteState; return Date.now(); });
  const stateLabel = $derived(quoteState.status === 'live' ? '实时' : quoteState.status === 'loading' ? '连接中' : quoteState.status === 'stale' ? '部分行情延迟' : '连接失败');
  const detailStale = $derived(stale(detailQuote));

  function market(symbol: string): MarketSymbol {
    const known = marketBySymbol.get(symbol); if (known) return known;
    const quote = ['FDUSD', 'USDT', 'USDC', 'BUSD', 'BTC', 'ETH', 'BNB', 'EUR', 'TRY'].find(asset => symbol.endsWith(asset));
    return { symbol, baseAsset: quote ? symbol.slice(0, -quote.length) : symbol, quoteAsset: quote ?? '' };
  }
  function stale(quote: TickerQuote | undefined): boolean { return !!quote && quoteCheckedAt - quote.updatedAt > WATCHLIST_QUOTE_STALE_MS; }
  function selectSymbol(symbol: string) { focusedSymbol = symbol; onSelect(symbol); }
  function changeList(id: string) { store.selectList(id); sortBy = 'manual'; message = ''; focusedSymbol = ''; menuOpen = false; editing = null; }
  function toggleMenu() { if (menuOpen) menuOpen = false; else { menuSession++; editing = null; menuOpen = true; } }
  function positionMenu(node:HTMLElement){
    if(!menuButton||!node.isConnected)return;
    const bounds=menuButton.getBoundingClientRect(),width=Math.min(225,window.innerWidth-16),height=node.offsetHeight;
    const below=window.innerHeight-bounds.bottom-12,above=bounds.top-12;
    const useBelow=below>=height||below>=above;
    menuMaxHeight=Math.max(70,useBelow?below:above);
    menuLeft=Math.max(8,Math.min(window.innerWidth-width-8,bounds.right-width));
    menuTop=useBelow?bounds.bottom+5:Math.max(8,bounds.top-Math.min(height,menuMaxHeight)-5);
  }
  function showMenu(event:CustomEvent){const node=event.currentTarget as HTMLDivElement;setSurfaceInteractive(node,true);node.showPopover();positionMenu(node);if(!editing)node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();}
  async function startEditing(mode: 'create' | 'rename') {
    menuOpen = true; editing = mode; nameDraft = mode === 'rename' ? activeList.name : ''; message = '';
    await tick(); nameInput?.focus(); if (mode === 'rename') nameInput?.select();
  }
  function saveName(event: SubmitEvent) {
    event.preventDefault();
    if (!nameDraft.trim()) { nameInput?.focus(); return; }
    const oldName = activeList.name;
    const success = editing === 'create' ? !!store.create(nameDraft) : store.rename(activeList.id, nameDraft) || nameDraft.trim() === oldName;
    if (success) { message = editing === 'create' ? `已创建 ${nameDraft.trim()}` : '列表名称已更新'; editing = null; menuOpen = false; menuButton?.focus(); }
  }
  function deleteList() {
    const name = activeList.name;
    if (store.deleteList(activeList.id)) { message = `已删除 ${name}，可撤销`; menuOpen = false; editing = null; menuButton?.focus(); }
  }
  async function remove(symbol: string) {
    const index = orderedSymbols.indexOf(symbol);
    if (!store.remove(symbol)) return;
    message = `已移除 ${symbol}，可撤销`;
    await tick();
    const next = orderedSymbols[Math.min(index, orderedSymbols.length - 1)];
    if (next) panel?.querySelector<HTMLButtonElement>(`[data-select-symbol="${next}"]`)?.focus();
    else panel?.querySelector<HTMLButtonElement>('[data-add-symbol]')?.focus();
  }
  function undo() { if (store.undo()) message = '已撤销上一步列表修改'; }
  function toggleSort(next: 'price' | 'absolute' | 'change') {
    if (sortBy !== next) { sortBy = next; sortDirection = 'desc'; }
    else if (sortDirection === 'desc') sortDirection = 'asc';
    else sortBy = 'manual';
    message = '';
  }
  function dragStart(symbol: string, event: DragEvent) {
    if (sortBy !== 'manual') { event.preventDefault(); return; }
    dragging = symbol;
    event.dataTransfer?.setData('text/plain', symbol);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }
  function dragOver(symbol: string, event: DragEvent) {
    if (!dragging || dragging === symbol || sortBy !== 'manual') return;
    event.preventDefault(); dropSymbol = symbol;
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropAfter = event.clientY > bounds.top + bounds.height / 2;
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }
  function drop(symbol: string, event: DragEvent) {
    event.preventDefault();
    if (dragging && dragging !== symbol && sortBy === 'manual') {
      const rest = activeList.symbols.filter(item => item !== dragging);
      const before = dropAfter ? rest[rest.indexOf(symbol) + 1] ?? null : symbol;
      if (store.move(dragging, before)) message = '自定义顺序已保存';
    }
    dragging = ''; dropSymbol = '';
  }
  function listKeys(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if ((event.key === ' ' || event.code === 'Space') && event.currentTarget instanceof HTMLElement && event.currentTarget.matches('.select-symbol')) {
      event.preventDefault(); event.stopPropagation();
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || !orderedSymbols.length) return;
      const current = event.currentTarget.dataset.selectSymbol;
      const index = orderedSymbols.indexOf(current ?? currentSymbol);
      const next = index < 0 ? event.shiftKey ? orderedSymbols.length - 1 : 0 : (index + (event.shiftKey ? -1 : 1) + orderedSymbols.length) % orderedSymbols.length;
      const symbol = orderedSymbols[next];
      selectSymbol(symbol);
      void tick().then(() => panel?.querySelector<HTMLButtonElement>(`[data-select-symbol="${symbol}"]`)?.focus());
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); undo(); return; }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const active = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-watch-symbol]')?.dataset.watchSymbol : undefined;
    const index = orderedSymbols.indexOf(active ?? focusedSymbol ?? currentSymbol);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? orderedSymbols.length - 1 : Math.max(0, Math.min(orderedSymbols.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    const symbol = orderedSymbols[next]; if (!symbol) return;
    focusedSymbol = symbol; panel?.querySelector<HTMLButtonElement>(`[data-select-symbol="${symbol}"]`)?.focus();
  }
  function outside(event: PointerEvent) {
    if (event.target instanceof Element && !event.target.closest('.watchlist-manager')) { menuOpen = false; editing = null; }
  }
</script>

<svelte:window onpointerdown={outside} onresize={()=>{if(menuOpen&&listMenu)positionMenu(listMenu);}}/>
{#snippet panelContent()}
  {#if !embedded}
  <header class="watchlist-heading"><strong>{$t("自选列表")}</strong><button data-add-symbol aria-label={$t("添加自选品种")} title={$t("添加品种")} onclick={onAdd}>＋</button><button aria-label={$t("关闭自选面板")} title={$t("关闭面板")} onclick={onClose}><ToolIcon name="close" size={17}/></button></header>
  {/if}
  <div class="list-picker"><select aria-label={$t("选择自选列表")} value={activeList.id} onchange={(event) => changeList(event.currentTarget.value)}>{#each document.lists as list}<option value={list.id}>{list.id==='default'&&list.name==='自选列表'?$t(list.name):list.name} · {list.symbols.length}</option>{/each}</select>{#if embedded}<button class="picker-add" data-add-symbol aria-label={$t("添加自选品种")} title={$t("添加品种")} onclick={onAdd}>＋</button>{/if}<div class="watchlist-manager"><button bind:this={menuButton} aria-label={$t("管理自选列表")} aria-haspopup="dialog" aria-expanded={menuOpen} title={$t("管理列表")} onclick={toggleMenu}><ToolIcon name="more" size={19}/></button>{#if menuOpen}{#key menuSession}<div bind:this={listMenu} class="list-menu" popover="manual" style:left={`${menuLeft}px`} style:top={`${menuTop}px`} style:max-height={`${menuMaxHeight}px`} data-menu-session={menuSession} role="dialog" aria-label={$t("管理自选列表")} tabindex="-1" transition:surface={{y:-3}} onintrostart={showMenu} onoutrostart={(event) => setSurfaceInteractive(event.currentTarget, false)} onoutroend={(event)=>event.currentTarget.hidePopover()} onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menuOpen = false; editing = null; menuButton.focus(); } }}>
      {#if editing}<form onsubmit={saveName}><label for="watchlist-name">{editing === 'create' ? $t("新建自选列表") : $t("重命名列表")}</label><input bind:this={nameInput} bind:value={nameDraft} id="watchlist-name" aria-label={$t("自选列表名称")} placeholder={$t("输入列表名称")} required maxlength="40"/><div><button type="button" onclick={() => editing = null}>{$t("取消")}</button><button type="submit" class="save-name" disabled={!nameDraft.trim()}>{$t("保存")}</button></div>{#if storeError}<p class="menu-error" role="status">{$t(storeError)}</p>{/if}</form>{:else}<button onclick={() => void startEditing('create')}><ToolIcon name="folder-add" size={16}/>{$t("新建列表")}</button><button onclick={() => void startEditing('rename')}><ToolIcon name="text" size={16}/>{$t("重命名")}</button><button disabled={!canUndo} onclick={() => { undo(); menuOpen = false; menuButton.focus(); }}><ToolIcon name="undo" size={16}/>{$t("撤销列表修改")}</button><button class="danger" disabled={document.lists.length <= 1} title={document.lists.length <= 1 ? $t("至少保留一个列表") : $t("删除后可撤销")} onclick={deleteList}><ToolIcon name="trash" size={16}/>{$t("删除此列表")}</button>{/if}
    </div>{/key}{/if}</div></div>
  <div class="quote-source"><span class:live={quoteState.status === 'live'} class:delayed={quoteState.status === 'stale' || quoteState.status === 'error'}></span><strong>{$t("BINANCE USDT 永续 · 24h")}</strong><span>{$t(stateLabel)}</span>{#if onRetry && (quoteState.status === 'error' || quoteState.status === 'stale')}<button aria-label={$t("重试自选行情")} onclick={onRetry}>{$t("重试")}</button>{/if}</div>
  <div class="watch-columns"><button class:sorted={sortBy === 'manual'} title={$t("恢复自定义顺序，可拖拽品种排序")} onclick={() => sortBy = 'manual'}>{$t("商品")} {sortBy === 'manual' ? '⋮' : ''}</button><button class:sorted={sortBy === 'price'} aria-label={$t("按最新价格排序")} title={$t("点击切换：降序、升序、自定义")} onclick={() => toggleSort('price')}>{$t("最新价")}{sortBy === 'price' ? sortDirection === 'desc' ? ' ↓' : ' ↑' : ''}</button><button class:sorted={sortBy === 'absolute'} aria-label={$t("按24小时涨跌额排序")} title={$t("24小时绝对涨跌；点击切换：降序、升序、自定义")} onclick={() => toggleSort('absolute')}>{$t("涨跌")}{sortBy === 'absolute' ? sortDirection === 'desc' ? ' ↓' : ' ↑' : ''}</button><button class:sorted={sortBy === 'change'} aria-label={$t("按24小时涨跌幅排序")} title={$t("24小时涨跌幅；点击切换：降序、升序、自定义")} onclick={() => toggleSort('change')}>{$t("涨跌%")}{sortBy === 'change' ? sortDirection === 'desc' ? ' ↓' : ' ↑' : ''}</button><span></span></div>
  <div class="watch-rows" role="list" aria-label={$t("{0}中的品种", {0: activeList.id==='default'&&activeList.name==='自选列表'?$t(activeList.name):activeList.name})}>
    {#each orderedSymbols as symbol (symbol)}
      {@const item = market(symbol)}{@const quote = quoteState.quotes[symbol]}{@const isStale = stale(quote)}
      <div class="watch-row" role="listitem" data-watch-symbol={symbol} class:selected={currentSymbol === symbol} class:dragging={dragging === symbol} class:drop-before={dropSymbol === symbol && !dropAfter} class:drop-after={dropSymbol === symbol && dropAfter} draggable={sortBy === 'manual'} ondragstart={(event) => dragStart(symbol, event)} ondragenter={(event) => dragOver(symbol, event)} ondragover={(event) => dragOver(symbol, event)} ondragleave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) dropSymbol = ''; }} ondrop={(event) => drop(symbol, event)} ondragend={() => { dragging = ''; dropSymbol = ''; }}>
        <button class="select-symbol" data-select-symbol={symbol} aria-label={$t("打开 {0} USDT 永续图表", {0: symbol})} aria-pressed={currentSymbol === symbol} title={$t("{0} / {1} · Binance USDT 永续{2}", {0: item.baseAsset, 1: item.quoteAsset, 2: isStale ? $t(" · 报价延迟") : ''})} onfocus={() => focusedSymbol = symbol} onkeydown={listKeys} onclick={() => selectSymbol(symbol)}><span class="row-symbol"><strong>{item.baseAsset}</strong><small>{item.quoteAsset}{isStale ? $t(" · 延迟") : !quote ? $t(" · 等待") : ''}</small></span><span class="row-price num" class:stale-quote={isStale} title={$t("最新价 {0} {1}", {0: quotePrice(quote?.last), 1: item.quoteAsset})}>{quotePrice(quote?.last)}</span><span class="row-absolute num" class:up={(quote?.change ?? 0) > 0} class:down={(quote?.change ?? 0) < 0} title={$t("24h 涨跌 {0} {1}", {0: quoteChange(quote?.change), 1: item.quoteAsset})}>{quoteChange(quote?.change)}</span><span class="row-change num" class:up={(quote?.changePercent ?? 0) > 0} class:down={(quote?.changePercent ?? 0) < 0} title={$t("24h 涨跌幅 {0}", {0: quotePercent(quote?.changePercent)})}>{quotePercent(quote?.changePercent)}</span></button><button class="remove-symbol" aria-label={$t("移除自选 {0}", {0: symbol})} title={$t("移出此列表（可撤销）")} onkeydown={listKeys} onclick={() => void remove(symbol)}><ToolIcon name="close" size={13}/></button>
      </div>
    {/each}
    {#if !orderedSymbols.length}<div class="empty-list"><ToolIcon name="objects" size={26}/><strong>{$t("列表还是空的")}</strong><p>{$t("加入常看的品种，随时切换图表。")}</p><button onclick={onAdd}>{$t("＋ 添加品种")}</button></div>{/if}
  </div>
  <div class="list-status"><span>{$t("{0} 个品种",{0:orderedSymbols.length})} · {sortBy === 'manual' ? $t("拖拽排序") : sortBy === 'price' ? $t("按价格排序") : sortBy === 'absolute' ? $t("按涨跌额排序") : $t("按涨跌幅排序")}</span><span title={$t("↑ ↓ 选择，Enter 打开；Space 下一品种，Shift + Space 上一品种")}>{$t("↑ ↓ / Enter · Space 切换")}</span></div>
  {#if message || storeError}<div class="watch-feedback" role="status"><span>{$t(storeError || message)}</span>{#if canUndo}<button aria-label={$t("撤销自选列表修改")} onclick={undo}>{$t("撤销")}</button>{/if}</div>{/if}
  {#if quoteState.error}<div class="quote-warning" role="status">{$t(quoteState.error)}</div>{/if}
  <section class="symbol-details" class:details-collapsed={!detailsOpen} aria-label={$t("当前品种详情")}><button class="detail-toggle" aria-expanded={detailsOpen} aria-label={detailsOpen?$t("收起当前品种详情"):$t("展开当前品种详情")} onclick={()=>detailsOpen=!detailsOpen}><span>{$t("品种详情")} <code>{currentSymbol}</code></span><strong class="num">{quotePrice(detailQuote?.last)}</strong><span class:closed={!detailsOpen}><ToolIcon name="down" size={12}/></span></button>{#if detailsOpen}<div class="detail-body"><div class="detail-heading"><span class="detail-asset">{detailMarket.baseAsset.slice(0, 1)}</span><div><h3>{detailMarket.baseAsset} <small>/ {detailMarket.quoteAsset}</small></h3><p>{$t("BINANCE · USDT 永续 · 24 小时统计")}</p></div></div><div class="detail-price num">{quotePrice(detailQuote?.last)}<span>{detailMarket.quoteAsset}</span></div><div class="detail-change num" class:up={(detailQuote?.changePercent ?? 0) > 0} class:down={(detailQuote?.changePercent ?? 0) < 0}><span>{quoteChange(detailQuote?.change)}</span><strong>{quotePercent(detailQuote?.changePercent)}</strong><small>{detailStale ? $t("报价延迟") : detailQuote ? '24h' : $t("等待报价")}</small></div><dl><div><dt>{$t("24h 最高")}</dt><dd class="num">{quotePrice(detailQuote?.high)}</dd></div><div><dt>{$t("24h 最低")}</dt><dd class="num">{quotePrice(detailQuote?.low)}</dd></div><div><dt>{$t("24h 成交量")} <span>{detailMarket.baseAsset}</span></dt><dd class="num">{quoteVolume(detailQuote?.volume)}</dd></div><div><dt>{$t("24h 成交额")} <span>{detailMarket.quoteAsset}</span></dt><dd class="num">{quoteVolume(detailQuote?.quoteVolume)}</dd></div></dl><div class="detail-update">{detailQuote ? $t("交易所更新 {0}", {0: new Date(detailQuote.updatedAt).toLocaleTimeString($locale, { hour12: false })}) : $t("公开行情正在连接")}<span>{$t("点选品种打开真实USDT 永续图表")}</span></div></div>{/if}</section>
{/snippet}
{#if embedded}
  <aside bind:this={panel} class="watchlist-panel" class:compact={density==='compact'} class:coarse={coarse} style:--watch-row-height={`${metrics.watchRow}px`} aria-label={$t("自选列表")} class:embedded>{@render panelContent()}</aside>
{:else}
  <aside bind:this={panel} class="watchlist-panel" class:compact={density==='compact'} class:coarse={coarse} style:--watch-row-height={`${metrics.watchRow}px`} aria-label={$t("自选列表")} transition:surface|global={{enter:160,exit:100,x:8,y:0}} onintrostart={(event)=>setSurfaceInteractive(event.currentTarget,true)} onoutrostart={(event)=>setSurfaceInteractive(event.currentTarget,false)}>{@render panelContent()}</aside>
{/if}

<style>
  .watchlist-panel{--watch-price:84px;--watch-absolute:72px;--watch-percent:64px;--watch-remove:22px;width:330px;flex:0 0 330px;min-height:0;display:flex;flex-direction:column;background:var(--bg-panel);border-left:1px solid var(--line-strong);color:var(--text);position:relative;z-index:7}.watchlist-heading{display:flex;align-items:center;height:46px;padding:6px 10px 6px 15px;border-bottom:1px solid var(--line-strong);gap:3px;flex-shrink:0}.watchlist-heading strong{font-size:12px;font-weight:500;margin-right:auto}.watchlist-heading button{display:flex;align-items:center;justify-content:center;width:29px;height:30px;padding:0;font-size:23px}.list-picker{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--line);flex-shrink:0}.list-picker select{flex:1;min-width:0;background:var(--surface-raised);border:1px solid var(--line-strong);height:32px;padding:0 26px 0 8px;font-size:11px;color:var(--text-dim)}.watchlist-manager{position:relative}.watchlist-manager>button{width:28px;height:30px;padding:0;display:flex;align-items:center;justify-content:center}.list-menu{position:fixed;inset:auto;margin:0;width:min(225px,calc(100vw - 16px));overflow:auto;color:inherit;z-index:25;padding:5px;background:var(--bg-hover);border:1px solid var(--line-strong);box-shadow:var(--shadow-md)}.list-menu>button{display:flex;align-items:center;gap:10px;width:100%;height:35px;font-size:11px;text-align:left;padding:7px 10px}.list-menu .danger{color:var(--down)}.list-menu form{padding:10px;display:flex;flex-direction:column;gap:11px}.list-menu label{font-size:11px;color:var(--text)}.list-menu input{background:var(--bg-panel);color:var(--text-strong);border:1px solid var(--line-strong);height:33px;padding:7px;font:11px var(--font);min-width:0}.list-menu form>div{display:flex;justify-content:flex-end;gap:7px}.list-menu form button{font-size:11px;border:1px solid var(--line-strong);padding:5px 12px}.save-name{background:var(--bg-active);color:var(--text-strong)}.menu-error{margin:0;font-size:11px;line-height:1.5;color:var(--warn)}.quote-source{display:flex;align-items:center;gap:6px;padding:7px 13px;font-size:11px;color:var(--text-dim);flex-shrink:0}.quote-source>span:first-child{height:5px;width:5px;border-radius:50%;background:var(--bg-active)}.quote-source>span.live{background:var(--up)}.quote-source>span.delayed{background:var(--warn)}.quote-source strong{font:11px var(--mono);color:var(--text-dim);font-weight:400}.quote-source>span:nth-last-child(1){margin-left:auto}.quote-source button{font-size:11px;color:var(--accent-strong);padding:1px 4px;margin-left:auto}.watch-columns{display:grid;grid-template-columns:minmax(0,1fr) var(--watch-price) var(--watch-absolute) var(--watch-percent) var(--watch-remove);column-gap:8px;padding-left:12px;height:29px;border-block:1px solid var(--line);flex-shrink:0}.watch-columns button{font-size:11px;padding:0 2px;justify-content:flex-end;text-align:right;color:var(--text-dim);white-space:nowrap}.watch-columns button:first-child{justify-content:flex-start;text-align:left}.watch-columns .sorted{color:var(--text-dim)}.watch-rows{min-height:80px;flex:1;overflow:auto;outline:none}.watch-rows:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}.watch-row{display:flex;align-items:center;height:var(--watch-row-height);min-height:var(--watch-row-height);border-left:2px solid transparent;border-bottom:1px solid var(--line);transition:background-color 120ms,border-color 120ms}.watch-row:hover,.watch-row:focus-within{background:var(--bg-hover)}.watch-row.selected{background:var(--bg-active);border-left-color:var(--accent)}.watch-row.dragging{opacity:.45}.watch-row.drop-before{box-shadow:inset 0 2px var(--accent)}.watch-row.drop-after{box-shadow:inset 0 -2px var(--accent)}.select-symbol{display:grid;grid-template-columns:minmax(0,1fr) var(--watch-price) var(--watch-absolute) var(--watch-percent);column-gap:8px;align-items:center;flex:1;min-width:0;height:100%;padding:4px 0 4px 10px;text-align:left;color:inherit;border:0}.select-symbol:hover{background:transparent;color:inherit}.row-symbol{min-width:0;display:flex;flex-direction:column;gap:5px}.row-symbol strong{font:600 11px var(--mono);color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row-symbol small{font:11px var(--mono);color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row-price,.row-absolute,.row-change{min-width:0;text-align:right;font-size:11px;white-space:nowrap;padding-right:2px;overflow:hidden;text-overflow:ellipsis}.row-price{color:var(--text)}.row-absolute,.row-change{color:var(--text-dim)}.row-price.stale-quote{color:var(--text-muted)}.remove-symbol{height:28px;width:var(--watch-remove);margin-left:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;padding:0;color:var(--text-dim);opacity:0}.watch-row:hover .remove-symbol,.watch-row:focus-within .remove-symbol{opacity:1}.up{color:var(--up)!important}.down{color:var(--down)!important}.list-status{display:flex;justify-content:space-between;padding:7px 11px;gap:7px;border-top:1px solid var(--line);color:var(--text-dim);font-size:11px;flex-shrink:0}.watch-feedback{display:flex;align-items:center;gap:6px;padding:8px 11px;font-size:11px;line-height:1.5;background:var(--bg-hover);color:var(--text);border-top:1px solid var(--line-strong);flex-shrink:0}.watch-feedback span{flex:1;min-width:0}.watch-feedback button{font-size:11px;padding:2px 5px;color:var(--accent-strong);border:1px solid var(--line-strong)}.quote-warning{padding:7px 11px;color:var(--warn);font-size:11px;line-height:1.5;border-top:1px solid var(--line-strong);max-height:58px;overflow:auto;flex-shrink:0}.empty-list{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px;color:var(--text-dim);gap:10px;min-height:160px}.empty-list strong{font-size:11px;font-weight:400;color:var(--text-dim)}.empty-list p{margin:0;font-size:11px;color:var(--text-dim);line-height:1.6}.empty-list button{font-size:11px;border:1px solid var(--line-strong);color:var(--accent-strong);padding:6px 11px}.symbol-details{border-top:1px solid var(--line-strong);padding:15px 15px 12px;flex-shrink:0;background:var(--surface-raised)}.detail-heading{display:flex;align-items:center;gap:10px}.detail-asset{width:32px;height:32px;border:1px solid var(--line-strong);display:flex;align-items:center;justify-content:center;font:14px var(--mono);color:var(--text);background:var(--bg-active)}.detail-heading>div{min-width:0;flex:1}.detail-heading h3{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 14px var(--mono);margin:0;color:var(--text-strong)}.detail-heading h3 small{font-size:11px;font-weight:400;color:var(--text-dim)}.detail-heading p{font-size:11px;color:var(--text-dim);margin:5px 0 0}.detail-price{font-size:26px;color:var(--text-strong);margin:16px 0 7px;line-height:1.15;letter-spacing:-.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.detail-price>span{font-size:11px;color:var(--text-dim);margin-left:8px;letter-spacing:0}.detail-change{display:flex;align-items:center;gap:9px;font-size:11px;color:var(--text-dim)}.detail-change strong{font-weight:400}.detail-change small{font:11px var(--font);color:var(--text-dim);margin-left:auto}.symbol-details dl{display:grid;grid-template-columns:1fr 1fr;column-gap:18px;row-gap:13px;margin:17px 0 14px}.symbol-details dl>div{min-width:0}.symbol-details dt{font-size:11px;color:var(--text-dim);margin-bottom:5px;white-space:nowrap}.symbol-details dt span{font:11px var(--mono);margin-left:2px;color:var(--text-dim)}.symbol-details dd{font-size:11px;color:var(--text-dim);margin:0;overflow:hidden;text-overflow:ellipsis}.detail-update{font-size:11px;color:var(--text-dim);display:flex;flex-direction:column;gap:5px}.detail-update>span{font-size:11px;color:var(--text-dim)}
  @media(prefers-reduced-motion:reduce){.watch-row{transition:none}}@media(pointer:coarse){.remove-symbol{opacity:1}}
  @media(max-height:720px){.symbol-details{padding-top:11px;padding-bottom:9px}.detail-price{font-size:22px;margin-top:12px}.symbol-details dl{row-gap:9px;margin-block:12px}.detail-update>span{display:none}.detail-heading p{margin-top:3px}.list-status>span:last-child{display:none}}
  @media(max-height:570px){.symbol-details{max-height:180px;overflow:auto}.detail-price{font-size:20px;margin-top:10px}.symbol-details dl{margin-bottom:7px}.detail-update{display:none}.watchlist-heading{height:40px}.quote-source{padding-block:4px}}
  @media(max-width:1000px){.watchlist-panel{position:absolute;right:39px;top:0;bottom:0;width:310px;box-shadow:-8px 0 24px rgb(0 0 0 / calc(0.33 * var(--shadow-strength)))}.watchlist-panel{--watch-price:78px;--watch-absolute:64px;--watch-percent:56px}}
  @media(max-width:470px){.watchlist-panel{width:min(310px,calc(100vw - 82px))}.watchlist-panel{--watch-price:65px;--watch-absolute:50px;--watch-percent:49px;--watch-remove:19px}.watch-columns{padding-left:8px;column-gap:5px}.select-symbol{padding-left:6px;column-gap:5px}.row-price,.row-absolute,.row-change{font-size:11px}.row-symbol strong{font-size:11px}.remove-symbol{width:var(--watch-remove)}.symbol-details{padding-inline:11px}.detail-price{font-size:23px}}

  .watchlist-panel{min-width:0;container:watchlist-width / inline-size}.watch-row{box-sizing:border-box}.compact .watchlist-heading{height:34px;padding:2px 8px 2px 10px}.compact .watchlist-heading strong{font-size:11px}.compact .watchlist-heading button{height:28px}.compact .list-picker{padding:4px 8px;gap:4px}.compact .list-picker select{height:27px;padding:0 24px 0 6px;font-size:11px}.compact .watchlist-manager>button{height:27px}.compact .quote-source{padding:5px 10px;font-size:11px}.compact .watch-columns{height:25px}.compact .watch-columns button{font-size:11px}.compact .select-symbol{padding-block:1px}.compact .row-symbol{flex-direction:row;align-items:baseline;gap:4px;overflow:hidden}.compact .row-symbol strong{font-size:11px;min-width:0;flex-shrink:1}.compact .row-symbol small{font-size:11px;min-width:0;max-width:49%;flex-shrink:0}.compact .remove-symbol{height:27px}.compact .list-status{padding:4px 8px;font-size:11px}.compact .empty-list{min-height:115px;padding:15px 10px;gap:7px}.coarse .remove-symbol{height:40px;opacity:1}.watch-feedback,.quote-warning{max-height:55px;overflow:auto;overflow-wrap:anywhere}
  .symbol-details{padding:0!important;max-height:none;background:var(--surface-raised)}.detail-toggle{display:flex;align-items:center;justify-content:flex-start;gap:7px;width:100%;min-width:0;height:34px;padding:4px 10px;text-align:left;border:0;color:var(--text-dim)}.detail-toggle>span:first-child{font-size:11px;min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.detail-toggle code{font:11px var(--mono);color:var(--text-dim);margin-left:5px}.detail-toggle strong{font-size:11px;font-weight:400;white-space:nowrap;max-width:42%;overflow:hidden;text-overflow:ellipsis}.detail-toggle>span:last-child{display:flex;flex-shrink:0;transition:transform 120ms ease-out}.detail-toggle .closed{transform:rotate(-90deg)}.details-collapsed{overflow:visible;flex-shrink:0}.detail-body{padding:7px 11px 10px;max-height:200px;overflow:auto;min-width:0}.detail-asset{width:25px;height:25px;font-size:12px;flex-shrink:0}.detail-heading{gap:8px}.detail-heading h3{font-size:12px}.detail-heading p{font-size:11px;margin-top:3px}.detail-price{font-size:21px;margin:10px 0 5px}.detail-change{font-size:11px;gap:7px}.symbol-details dl{margin:11px 0 9px;row-gap:8px}.symbol-details dt{font-size:11px;margin-bottom:3px}.symbol-details dd{font-size:11px}.detail-update{font-size:11px;gap:4px}.detail-update>span{font-size:11px}.compact .detail-toggle{height:31px}.compact .detail-body{max-height:178px}.compact .detail-update>span{display:none}
  .watchlist-panel.embedded{position:relative;inset:auto;width:100%;height:100%;max-width:100%;min-width:0;min-height:0;flex:1 1 auto;border:0;box-shadow:none;z-index:auto}.watchlist-panel.embedded .watch-rows{min-height:0}.watchlist-panel.embedded .list-picker{min-width:0}.watchlist-panel.embedded .list-status{white-space:nowrap;overflow:hidden}.watchlist-panel.embedded .list-status>span{min-width:0;overflow:hidden;text-overflow:ellipsis}.watchlist-panel.embedded .symbol-details{max-width:100%}
  @container watchlist-width (max-width:310px){.watch-columns{grid-template-columns:minmax(0,1fr) 74px 62px 54px 20px;column-gap:5px}.select-symbol{grid-template-columns:minmax(0,1fr) 74px 62px 54px;column-gap:5px}.remove-symbol{width:20px;margin-left:5px}.compact .row-symbol{gap:3px}.row-price,.row-absolute,.row-change{font-size:11px}.list-status>span:last-child{display:none}.detail-toggle code{display:none}}
  @container watchlist-width (max-width:260px){.watch-columns{grid-template-columns:minmax(0,1fr) 65px 48px 46px 19px;padding-left:8px;column-gap:4px}.select-symbol{grid-template-columns:minmax(0,1fr) 65px 48px 46px;padding-left:6px;column-gap:4px}.remove-symbol{width:19px;margin-left:4px}.compact .row-symbol strong{font-size:11px}.compact .row-symbol small{font-size:11px;max-width:42%}.quote-source strong{font-size:11px}.quote-source{gap:4px}.detail-toggle{padding-inline:8px}.watch-feedback{font-size:11px}.row-price,.row-absolute,.row-change{font-size:11px}}
  @container watchlist-width (min-width:600px){.watch-columns{grid-template-columns:minmax(0,1fr) 140px 110px 100px 28px;column-gap:12px}.select-symbol{grid-template-columns:minmax(0,1fr) 140px 110px 100px;column-gap:12px}.remove-symbol{width:28px;margin-left:12px}.row-price,.row-absolute,.row-change{font-size:11px}.compact .row-symbol strong{font-size:11px}.compact .row-symbol small{font-size:11px}.detail-body{display:grid;grid-template-columns:minmax(150px,1fr) minmax(150px,1fr) minmax(280px,2fr);column-gap:20px;align-items:center;max-height:130px}.detail-heading{grid-column:1}.detail-price{grid-column:2;grid-row:1;margin:0}.detail-change{grid-column:2;grid-row:2}.symbol-details dl{grid-column:3;grid-row:1 / 3;margin:0}.detail-update{grid-column:1;grid-row:2}.detail-toggle strong{margin-left:auto}}
  @media(prefers-reduced-motion:reduce){.detail-toggle>span:last-child{transition:none}}
  .picker-add{width:28px;height:30px;flex-shrink:0;display:flex;align-items:center;justify-content:center;padding:0;font-size:22px;line-height:1;color:var(--text)}.compact .picker-add{height:27px}.coarse .picker-add{height:40px;width:36px}
</style>
