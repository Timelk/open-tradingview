<script lang="ts">
  import {t, locale} from '../../lib/i18n';
  import { onMount, tick, untrack } from 'svelte';
  import type { MarketSymbol } from '../../lib/watchlist/types';
  import {
    getMarketConnector,
    marketConnectors,
    synthesizeSymbolForConnector,
    type MarketConnector,
    type MarketSourceId,
  } from '../../lib/market/connectors';
  import { mergeSymbolCatalogs, searchRemoteCnAShareSymbols, symbolCatalogKey, type SqliteSymbolSourceStat } from '../../lib/market/symbol-catalog';
  import { surface, setSurfaceInteractive } from '../../lib/ui/motion';
  import ToolIcon from '../drawing/ToolIcon.svelte';
  import Sparkline from '../ui/Sparkline.svelte';
  import { symbolPreviews, previewKey, formatPreviewPrice, formatPreviewVolume } from '../../lib/market/symbol-previews';

  let {
    catalog,
    loading,
    error = '',
    mode,
    selectedSymbols,
    activeSource = 'binance',
    sqliteSources = [],
    onSelect,
    onClose,
    initialQuery = '',
    onRetry,
    onOpenConnectorSettings,
    onRemoteSymbolsFound,
  }: {
    catalog: MarketSymbol[];
    loading: boolean;
    error?: string;
    mode: 'switch' | 'add';
    selectedSymbols: string[];
    activeSource?: MarketSourceId;
    sqliteSources?: SqliteSymbolSourceStat[];
    onSelect: (symbol: string, source?: MarketSourceId, item?: MarketSymbol) => void;
    onClose: () => void;
    initialQuery?: string;
    onRetry?: () => void;
    onOpenConnectorSettings?: () => void;
    onRemoteSymbolsFound?: (symbols: MarketSymbol[], sources: SqliteSymbolSourceStat[]) => void;
  } = $props();

  let dialog: HTMLDialogElement, searchInput: HTMLInputElement;
  let resultsElement = $state<HTMLDivElement>();
  let query = $state(untrack(() => initialQuery));
  let sourceFilter = $state<string>('all');
  let quoteFilter = $state('all');
  let activeIndex = $state(0), scrollTop = $state(0), viewportHeight = $state(360);
  let closed = $state(false), message = $state(''), failed = $state(false), selecting = $state(false);
  let returnFocus: HTMLElement | null = null;
  let connectors = $state<MarketConnector[]>(marketConnectors.list().filter(c => c.id !== 'mock'));
  let remoteCnAShareResults = $state<MarketSymbol[]>([]);
  let remoteSearching = $state(false);
  const rowHeight = 56;
  const preferred = ['600519.SH', '300750.SZ', '002594.SZ', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
  const preferredQuotes = ['USDT', 'USD', 'CNY', 'USDC', 'FDUSD', 'BTC', 'ETH'];

  const normalizedQuery = $derived(
    query.normalize('NFKC').toUpperCase().trim().replace(/^(?:BINANCE|OKX|COINBASE|SSE|SZSE|BSE|CN):/, '')
  );

  const combinedCatalog = $derived(
    remoteCnAShareResults.length ? mergeSymbolCatalogs(catalog, remoteCnAShareResults) : catalog
  );

  const channelCatalog = $derived(
    sourceFilter === 'all'
      ? combinedCatalog
      : combinedCatalog.filter(item => (item.source ?? 'binance') === sourceFilter)
  );

  const quoteOptions = $derived(
    ['USDT', 'USD', 'CNY', 'USDC', 'BTC', 'ETH'].filter(asset =>
      channelCatalog.some(item => item.quoteAsset === asset)
    )
  );

  const results = $derived.by(() => {
    const rawTrimmed = query.trim();
    const needle = normalizedQuery.replace(/\.P$/, '').replace(/[\s/]/g, '');
    const filtered = channelCatalog
      .filter(item =>
        (quoteFilter === 'all' || item.quoteAsset === quoteFilter)
        && (
          !needle
          || item.symbol.toUpperCase().includes(needle)
          || item.baseAsset.toUpperCase().includes(needle)
          || item.quoteAsset.toUpperCase().includes(needle)
          || (item.name?.toUpperCase().includes(normalizedQuery) ?? false)
          || (item.exchangeLabel?.toUpperCase().includes(normalizedQuery) ?? false)
          || (item.marketBadge?.toUpperCase().includes(normalizedQuery) ?? false)
        )
      )
      .map((item, order) => {
        const isCurrentSource = (item.source ?? 'binance') === activeSource ? -2 : 0;
        const matchRank = needle
          ? item.symbol === needle || item.baseAsset === needle
            ? 0
            : item.name?.toUpperCase() === normalizedQuery
            ? 0
            : item.symbol.startsWith(needle) || item.baseAsset.startsWith(needle)
            ? 1
            : 2
          : preferred.includes(item.symbol)
          ? preferred.indexOf(item.symbol) - 20
          : 0;
        return { item, order, rank: matchRank + isCurrentSource };
      })
      .sort((a, b) => a.rank - b.rank || (needle ? quoteRank(a.item.quoteAsset) - quoteRank(b.item.quoteAsset) : 0) || a.order - b.order)
      .map(result => result.item);

    // If user typed a valid symbol code that is not yet in catalog, synthesize a direct entry so it can be opened & persisted to SQLite
    if (rawTrimmed.length >= 2) {
      const existingKeys = new Set(filtered.map(item => symbolCatalogKey(item)));
      const candidateConnectors = sourceFilter === 'all'
        ? connectors
        : connectors.filter(c => c.id === sourceFilter);
      for (const connector of candidateConnectors) {
        const syn = synthesizeSymbolForConnector(connector, rawTrimmed);
        if (syn && (quoteFilter === 'all' || syn.quoteAsset === quoteFilter)) {
          const key = symbolCatalogKey(syn);
          if (!existingKeys.has(key)) {
            existingKeys.add(key);
            filtered.push(syn);
          }
        }
      }
    }
    return filtered;
  });

  function quoteRank(asset: string) {
    const index = preferredQuotes.indexOf(asset);
    return index < 0 ? preferredQuotes.length : index;
  }

  function channelCount(sourceId: string): number {
    if (sourceId === 'all') return combinedCatalog.length;
    return combinedCatalog.filter(item => (item.source ?? 'binance') === sourceId).length;
  }

  function selectChannel(nextSource: string) {
    sourceFilter = nextSource;
    if (quoteFilter !== 'all') {
      const nextHasQuote = combinedCatalog.some(item => (nextSource === 'all' || (item.source ?? 'binance') === nextSource) && item.quoteAsset === quoteFilter);
      if (!nextHasQuote) quoteFilter = 'all';
    }
  }

  $effect(() => {
    const q = query.trim();
    const filter = sourceFilter;
    if (!q || (filter !== 'all' && filter !== 'cn-a')) {
      remoteCnAShareResults = [];
      remoteSearching = false;
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      remoteSearching = true;
      const found = await searchRemoteCnAShareSymbols(q, { limit: 30, signal: controller.signal });
      if(controller.signal.aborted)return;
      remoteSearching = false;
      if (found?.symbols?.length) {
        remoteCnAShareResults = found.symbols;
        onRemoteSymbolsFound?.(found.symbols, found.sources);
      }
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  const sqliteTotal = $derived(sqliteSources.reduce((sum, s) => sum + s.count, 0));
  const activeConnector = $derived(sourceFilter === 'all' ? undefined : getMarketConnector(sourceFilter));

  const firstVisible = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - 4));
  const lastVisible = $derived(Math.min(results.length, firstVisible + Math.ceil(viewportHeight / rowHeight) + 9));
  const visibleResults = $derived(results.slice(firstVisible, lastVisible));
  const activeId = $derived(results[activeIndex] ? `symbol-option-${symbolCatalogKey(results[activeIndex]).replace(/[^a-zA-Z0-9_-]/g, '-')}` : undefined);

  $effect(() => {
    results;
    activeIndex = 0; scrollTop = 0;
    untrack(() => { if (resultsElement) resultsElement.scrollTop = 0; });
  });
  $effect(() => {
    if (!resultsElement) return;
    const node = resultsElement;
    const observer = new ResizeObserver(() => viewportHeight = node.clientHeight);
    observer.observe(node);
    return () => observer.disconnect();
  });
  onMount(() => {
    const offConnectors = marketConnectors.subscribe(list => {
      connectors = list.filter(c => c.id !== 'mock');
    });
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal(); searchInput.focus();
    if (query) searchInput.setSelectionRange(query.length, query.length);
    return () => offConnectors();
  });
  function releaseModal() {
    if (!dialog) return;
    dialog.classList.add('closing'); setSurfaceInteractive(dialog, false);
    if (dialog.open) dialog.close();
  }
  function resumeModal() {
    if (!dialog?.classList.contains('closing')) return;
    closed = false; dialog.classList.remove('closing'); setSurfaceInteractive(dialog, true);
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal(); searchInput.focus();
  }
  function close() {
    if (closed) return;
    closed = true; releaseModal(); onClose();
    void tick().then(() => { if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus(); });
  }
  async function choose(item: MarketSymbol) {
    if (selecting) return;
    if (mode === 'add' && selectedSymbols.includes(item.symbol)) { message = `${item.symbol} 已在当前列表`; failed = false; return; }
    selecting = true;
    try {
      onSelect(item.symbol, item.source ?? activeSource, item);
      if (mode === 'switch') close();
      else {
        await tick();
        failed = !selectedSymbols.includes(item.symbol);
        message = failed ? `未能加入 ${item.symbol}，请重试。` : `已加入 ${item.symbol}，可继续添加其他品种`;
      }
    } catch (reason) { failed = true; message = reason instanceof Error ? reason.message : '操作未完成，请重试。'; }
    finally { selecting = false; }
  }
  async function moveActive(index: number, focusOption = false) {
    activeIndex = Math.max(0, Math.min(results.length - 1, index));
    if (resultsElement) {
      const top = activeIndex * rowHeight, bottom = top + rowHeight;
      if (top < resultsElement.scrollTop) resultsElement.scrollTop = top;
      else if (bottom > resultsElement.scrollTop + resultsElement.clientHeight) resultsElement.scrollTop = bottom - resultsElement.clientHeight;
      scrollTop = resultsElement.scrollTop;
    }
    await tick();
    if (focusOption && activeId) document.getElementById(activeId)?.focus();
  }
  function searchKeys(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); void moveActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1)); }
    else if (event.key === 'Enter' && results[activeIndex]) { event.preventDefault(); void choose(results[activeIndex]); }
  }
  function resultKeys(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    void moveActive(event.key === 'Home' ? 0 : event.key === 'End' ? results.length - 1 : activeIndex + (event.key === 'ArrowDown' ? 1 : -1), true);
  }
  // Market previews: re-render when the shared cache fills in.
  let previewVersion = $state(0);
  onMount(() => symbolPreviews.subscribe(() => { previewVersion = symbolPreviews.version; }));
  const preview = (item: MarketSymbol) => { previewVersion; return symbolPreviews.get(item); };
  // The preview pane follows the highlighted row after a short settle, so
  // holding an arrow key does not request every symbol it passes.
  let previewItem = $state<MarketSymbol | undefined>(undefined);
  $effect(() => {
    const item = results[activeIndex];
    const timer = setTimeout(() => { previewItem = item; }, previewItem ? 90 : 0);
    return () => clearTimeout(timer);
  });
  const siblings = $derived.by(() => {
    const item = previewItem; if (!item) return [];
    const key = symbolCatalogKey(item), base = item.baseAsset.toUpperCase();
    return combinedCatalog.filter(other => other.baseAsset.toUpperCase() === base && symbolCatalogKey(other) !== key && ['USDT', 'USD', 'USDC', 'FDUSD', 'CNY'].includes(other.quoteAsset))
      .sort((a, b) => quoteRank(a.quoteAsset) - quoteRank(b.quoteAsset)).slice(0, 6);
  });
  $effect(() => { symbolPreviews.request([...visibleResults, ...(previewItem ? [previewItem, ...siblings] : [])]); });
  function matchParts(symbol: string): [string, string, string] {
    const needle = normalizedQuery.replace(/\.P$/, '').replace(/[\s/]/g, '');
    const at = needle ? symbol.toUpperCase().indexOf(needle) : -1;
    return at < 0 ? [symbol, '', ''] : [symbol.slice(0, at), symbol.slice(at, at + needle.length), symbol.slice(at + needle.length)];
  }
  const changeText = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? '' : `${value >= 0 ? '↑' : '↓'} ${Math.abs(value).toFixed(2)}%`;
  function badgeGlyph(item: MarketSymbol): string {
    if (item.quoteAsset === 'CNY' && item.name) return item.name.trim().slice(0, 1);
    return item.baseAsset.slice(0, 1);
  }
</script>

<dialog bind:this={dialog} class="symbol-search-dialog" class:closing={closed} aria-labelledby="symbol-search-title" aria-hidden={closed} transition:surface|global={{enter:160,exit:110,y:6}} onintrostart={resumeModal} onoutrostart={releaseModal} oncancel={(event) => { event.preventDefault(); close(); }} onclick={(event) => { if (event.target === dialog) { const b = dialog.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) close(); } }}>
  <h2 id="symbol-search-title" class="sr-only">{mode === 'add' ? $t("添加自选品种") : $t("商品搜索")}</h2>
  <div class="search-field">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>
    {#if activeConnector}<span class="scope-chip">{$t(activeConnector.shortLabel)}<button aria-label={$t("查看全部渠道品种")} onclick={() => { selectChannel('all'); searchInput.focus(); }}><ToolIcon name="close" size={12}/></button></span>{/if}
    <input bind:this={searchInput} bind:value={query} aria-label={$t("搜索交易品种")} role="combobox" aria-controls="symbol-search-results" aria-expanded="true" aria-autocomplete="list" aria-activedescendant={activeId} placeholder={mode === 'add' ? $t("添加自选：代码、名称或交易对") : $t("搜索代码、名称或交易对，例如 BTC、SOL-USD、600519")} autocomplete="off" spellcheck="false" onkeydown={searchKeys}/>
    {#if query}<button class="clear-query" aria-label={$t("清空品种搜索")} onclick={() => { query = ''; searchInput.focus(); }}><ToolIcon name="close" size={15}/></button>{/if}
    <button class="close-dialog" aria-label={$t("关闭商品搜索")} title={$t("关闭 · Esc")} onclick={close}><kbd>esc</kbd></button>
  </div>
  <div class="filter-bar">
    <div class="channel-filters" role="tablist" aria-label={$t("数据源渠道筛选")}>
      <button role="tab" class:active={sourceFilter === 'all'} aria-selected={sourceFilter === 'all'} onclick={() => selectChannel('all')}>{$t("全部")}<small>{channelCount('all').toLocaleString($locale)}</small></button>
      {#each connectors as connector (connector.id)}
        <button role="tab" class:active={sourceFilter === connector.id} aria-selected={sourceFilter === connector.id} onclick={() => selectChannel(connector.id)}>{$t(connector.shortLabel)}<small>{channelCount(connector.id).toLocaleString($locale)}</small></button>
      {/each}
    </div>
    {#if onOpenConnectorSettings}<button type="button" class="connector-settings-btn" title={$t("数据源配置")} aria-label={$t("数据源配置")} onclick={() => { close(); onOpenConnectorSettings?.(); }}><ToolIcon name="gear" size={15}/></button>{/if}
  </div>
  <div class="search-body">
    <section class="results-col" aria-label={$t("品种搜索结果")}>
      <div class="market-filters" aria-label={$t("报价资产筛选")}>
        <button class:active={quoteFilter === 'all'} aria-pressed={quoteFilter === 'all'} onclick={() => quoteFilter = 'all'}>{$t("全部计价")}</button>
        {#each quoteOptions as asset}<button class:active={quoteFilter === asset} aria-pressed={quoteFilter === asset} onclick={() => quoteFilter = asset}>{asset}</button>{/each}
        <span>{loading || remoteSearching ? $t("正在查找品种…") : $t("{0} 个品种", {0: results.length.toLocaleString($locale)})}</span>
      </div>
      <div bind:this={resultsElement} class="symbol-results" role="listbox" id="symbol-search-results" aria-label={$t("品种搜索结果")} aria-busy={loading} tabindex="-1" onkeydown={resultKeys} onscroll={(event) => scrollTop = event.currentTarget.scrollTop}>
        {#if results.length}
          <div aria-hidden="true" style:height={`${firstVisible * rowHeight}px`}></div>
          {#each visibleResults as item, offset (symbolCatalogKey(item))}
            {@const index = firstVisible + offset}
            {@const added = selectedSymbols.includes(item.symbol)}
            {@const optionId = `symbol-option-${symbolCatalogKey(item).replace(/[^a-zA-Z0-9_-]/g, '-')}`}
            {@const data = preview(item)}
            {@const parts = matchParts(item.symbol)}
            <button id={optionId} role="option" aria-selected={activeIndex === index} aria-disabled={mode === 'add' && added} class="symbol-option" class:highlighted={activeIndex === index} class:already-added={mode === 'add' && added} tabindex={activeIndex === index ? 0 : -1} onfocus={() => activeIndex = index} onpointermove={() => { if (activeIndex !== index) activeIndex = index; }} onclick={() => void choose(item)}>
              <span class="asset-badge" class:cn-badge={item.source === 'cn-a'} class:cb-badge={item.source === 'coinbase'} class:okx-badge={item.source === 'okx'} aria-hidden="true">{badgeGlyph(item)}</span>
              <span class="symbol-label">
                <strong>{parts[0]}{#if parts[1]}<mark>{parts[1]}</mark>{/if}{parts[2]}</strong>
                <small>{item.name && item.name !== item.baseAsset ? item.name : `${item.baseAsset} / ${item.quoteAsset}`}<i> · </i><span class="source-pill" data-source={item.source ?? 'binance'}>{item.exchangeLabel || (item.source ?? 'BINANCE').toUpperCase()}</span>{$t(item.marketBadge || "USDT 永续")}</small>
              </span>
              <Sparkline values={data.spark?.closes} width={64} height={22} loading/>
              <span class="quote-cell">
                <b>{formatPreviewPrice(data.quote?.last, $locale)}</b>
                <small class:up={(data.quote?.changePercent ?? 0) >= 0} class:down={(data.quote?.changePercent ?? 0) < 0}>{changeText(data.quote?.changePercent)}</small>
              </span>
              {#if mode === 'add'}<span class="symbol-add-status">{added ? $t("✓ 已加入") : $t("＋ 添加")}</span>{/if}
            </button>
          {/each}
          <div aria-hidden="true" style:height={`${Math.max(0, results.length - lastVisible) * rowHeight}px`}></div>
        {:else}
          <div class="search-empty">
            <ToolIcon name="candles" size={30}/>
            <strong>{loading ? $t("正在获取交易品种") : error && !catalog.length ? $t("品种目录暂不可用") : $t("没有找到匹配的品种")}</strong>
            <p>{loading ? $t("正在获取可交易品种…") : error && !catalog.length ? $t(error) : $t("尝试输入其他代码（如 BTCUSDT、BTC-USD、600519），或切换渠道筛选。")}</p>
            {#if onRetry && error && !loading}<button onclick={onRetry}>{$t("重试品种目录")}</button>{/if}
            {#if (query || sourceFilter !== 'all' || quoteFilter !== 'all') && !loading}
              <button onclick={() => { query = ''; sourceFilter = 'all'; quoteFilter = 'all'; searchInput.focus(); }}>{$t("查看全部渠道品种")}</button>
            {/if}
          </div>
        {/if}
      </div>
    </section>
    <aside class="preview-col" aria-label={$t("品种预览")}>
      {#if previewItem}
        {@const data = preview(previewItem)}
        {@const change = data.quote?.changePercent}
        {#key previewKey(previewItem)}
          <div class="preview-card" in:surface={{y:3,enter:150}}>
            <header class="preview-head">
              <span class="asset-badge large" class:cn-badge={previewItem.source === 'cn-a'} class:cb-badge={previewItem.source === 'coinbase'} class:okx-badge={previewItem.source === 'okx'} aria-hidden="true">{badgeGlyph(previewItem)}</span>
              <div><strong>{previewItem.symbol}</strong><small>{previewItem.name || `${previewItem.baseAsset} / ${previewItem.quoteAsset}`}</small></div>
              <span class="source-pill" data-source={previewItem.source ?? 'binance'}>{previewItem.exchangeLabel || (previewItem.source ?? 'BINANCE').toUpperCase()}</span>
            </header>
            <div class="preview-price"><b>{formatPreviewPrice(data.quote?.last, $locale)}</b><span class:up={(change ?? 0) >= 0} class:down={(change ?? 0) < 0}>{changeText(change)}</span><small>{data.span === '30d' ? $t("较前收 · 近 30 日") : '24h'}</small></div>
            <div class="preview-chart">
              {#if data.spark}<Sparkline values={data.spark.closes} width={300} height={96} area label={data.span === '30d' ? $t("{0} 近 30 个交易日走势",{0:previewItem.symbol}) : $t("{0} 近 24 小时走势",{0:previewItem.symbol})}/>
              {:else}<Sparkline width={300} height={96} loading/>{/if}
            </div>
            <dl class="preview-stats">
              <div><dt>{data.span === '30d' ? $t("当日最高") : $t("24h 最高")}</dt><dd>{formatPreviewPrice(data.quote?.high, $locale)}</dd></div>
              <div><dt>{data.span === '30d' ? $t("当日最低") : $t("24h 最低")}</dt><dd>{formatPreviewPrice(data.quote?.low, $locale)}</dd></div>
              <div><dt>{data.span === '30d' ? $t("当日成交量") : $t("24h 成交量")}</dt><dd>{formatPreviewVolume(data.quote?.volume)}</dd></div>
              <div><dt>{$t("24h 成交额")}</dt><dd>{formatPreviewVolume(data.quote?.quoteVolume)}</dd></div>
            </dl>
            {#if siblings.length}
              <h3>{$t("其他渠道")} <small>{siblings.length}</small></h3>
              <div class="venues">
                {#each siblings as other (symbolCatalogKey(other))}
                  {@const otherData = preview(other)}
                  <button class="venue" onclick={() => void choose(other)}>
                    <span class="source-pill" data-source={other.source ?? 'binance'}>{other.exchangeLabel || (other.source ?? 'BINANCE').toUpperCase()}</span>
                    <span class="venue-name"><b>{other.symbol}</b><small>{$t(other.marketBadge || "USDT 永续")}</small></span>
                    <Sparkline values={otherData.spark?.closes} width={48} height={18} loading/>
                    <span class="quote-cell"><b>{formatPreviewPrice(otherData.quote?.last, $locale)}</b><small class:up={(otherData.quote?.changePercent ?? 0) >= 0} class:down={(otherData.quote?.changePercent ?? 0) < 0}>{changeText(otherData.quote?.changePercent)}</small></span>
                  </button>
                {/each}
              </div>
            {/if}
            <button class="preview-open" onclick={() => void choose(previewItem!)} disabled={mode === 'add' && selectedSymbols.includes(previewItem.symbol)}>{mode === 'add' ? (selectedSymbols.includes(previewItem.symbol) ? $t("✓ 已加入") : $t("加入自选")) : $t("打开图表")}<kbd>↵</kbd></button>
          </div>
        {/key}
      {:else}
        <div class="preview-empty"><ToolIcon name="candles" size={26}/><p>{$t("用 ↑ ↓ 或鼠标悬停查看品种预览")}</p></div>
      {/if}
    </aside>
  </div>
  {#if error && catalog.length}<p class="catalog-warning" role="status">{$t(error)}{#if onRetry}<button onclick={onRetry}>{$t("重试")}</button>{/if}</p>{/if}
  <footer>
    <span class="hints" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd>{$t("选择")}<kbd>↵</kbd>{mode === 'add' ? $t("加入") : $t("打开")}<kbd>esc</kbd>{$t("关闭")}</span>
    <span class="footer-status" class:failed role="status" aria-live="polite">{$t(message)}</span>
    <details class="catalog-details"><summary>{$t("目录信息")}</summary><small>{$t("本地品种记录：{0}",{0:sqliteTotal.toLocaleString($locale)})} · SQLite <code>.data/market/market.sqlite</code></small></details>
    {#if mode === 'add'}<button class="done" onclick={close}>{$t("完成")}</button>{/if}
  </footer>
</dialog>

<style>
  .symbol-search-dialog{position:fixed;inset:0;margin:9vh auto auto;width:min(1040px,calc(100vw - 32px));height:min(620px,calc(100dvh - 12vh - 16px));padding:0;border:1px solid color-mix(in srgb,var(--line) 80%,var(--ink) 8%);border-radius:12px;background:color-mix(in srgb,var(--bg-panel) 96%,transparent);color:var(--text);overflow:hidden;flex-direction:column;max-height:none;max-width:none;box-shadow:var(--shadow-lg);z-index:46}
  .symbol-search-dialog[open],.symbol-search-dialog.closing{display:flex}
  .symbol-search-dialog::backdrop{background:color-mix(in srgb, var(--bg-panel) 60%, transparent);backdrop-filter:blur(3px);animation:backdrop-in 180ms ease-out both}
  .symbol-search-dialog.closing::backdrop{animation:none;background:transparent}

  .search-field{display:flex;align-items:center;gap:12px;height:62px;padding:0 14px 0 20px;border-bottom:1px solid var(--line);color:var(--text-dim);flex-shrink:0}
  .search-field input{background:transparent;border:0;outline:0;flex:1;min-width:0;height:100%;padding:0;color:var(--text-strong);font:400 17px var(--font);letter-spacing:.01em}
  .search-field input::placeholder{color:color-mix(in srgb,var(--text-dim) 75%,transparent)}
  .search-field input:focus-visible{outline:none}
  .scope-chip{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 4px 0 9px;border-radius:var(--radius-md);background:var(--bg-hover);color:var(--text);font:500 12px var(--font);white-space:nowrap}
  .scope-chip button{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;min-height:18px;padding:0;border:0;border-radius:var(--radius-sm);color:var(--text-dim);background:transparent}
  .scope-chip button:hover{color:var(--text);background:var(--line)}
  .clear-query{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;min-height:26px;padding:0;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--text-dim)}
  .clear-query:hover{color:var(--text);background:var(--bg-hover)}
  .close-dialog{padding:0;border:0;background:transparent;min-height:0}
  kbd{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 5px;border:1px solid var(--line);border-bottom-width:2px;border-radius:var(--radius-sm);background:var(--bg);color:var(--text-dim);font:500 10.5px var(--mono);line-height:1}
  .close-dialog:hover kbd{color:var(--text);border-color:var(--text-dim)}

  .filter-bar{display:flex;align-items:center;gap:8px;padding:0 12px 0 14px;border-bottom:1px solid var(--line);flex-shrink:0}
  .channel-filters{display:flex;align-items:stretch;gap:2px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none;height:42px}
  .channel-filters button{position:relative;display:inline-flex;align-items:center;gap:6px;padding:0 12px;border:0;border-radius:0;background:transparent;color:var(--text-dim);font:500 13px var(--font);white-space:nowrap;min-height:0}
  .channel-filters button small{font:400 10.5px var(--mono);color:color-mix(in srgb,var(--text-dim) 70%,transparent)}
  .channel-filters button::after{content:'';position:absolute;left:10px;right:10px;bottom:-1px;height:2px;border-radius:var(--radius-xs);background:var(--accent);transform:scaleX(0);transition:transform 180ms cubic-bezier(.22,1,.36,1)}
  .channel-filters button:hover{color:var(--text)}
  .channel-filters button.active{color:var(--text-strong)}
  .channel-filters button.active::after{transform:scaleX(1)}
  .connector-settings-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;min-height:30px;padding:0;border:1px solid var(--line);border-radius:var(--radius-md);background:transparent;color:var(--text-dim)}
  .connector-settings-btn:hover{color:var(--text);background:var(--bg-hover)}

  .search-body{display:grid;grid-template-columns:minmax(0,1fr) 348px;flex:1;min-height:0}
  .results-col{display:flex;flex-direction:column;min-width:0;min-height:0}
  .market-filters{display:flex;align-items:center;gap:5px;padding:10px 14px 8px;flex-shrink:0;overflow-x:auto;scrollbar-width:none}
  .market-filters button{height:24px;min-height:24px;padding:0 9px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--text-dim);font:500 11px var(--mono);white-space:nowrap}
  .market-filters button:hover{color:var(--text);border-color:color-mix(in srgb,var(--text-dim) 60%,transparent)}
  .market-filters button.active{color:var(--text-strong);background:var(--bg-hover);border-color:color-mix(in srgb,var(--text-dim) 45%,transparent)}
  .market-filters>span{margin-left:auto;padding-left:8px;font-size:11px;color:var(--text-dim);white-space:nowrap}
  .symbol-results{overflow:auto;min-height:0;flex:1;outline:none;padding:0 8px 8px;scrollbar-width:thin}

  .symbol-option{display:flex;align-items:center;gap:12px;width:100%;height:56px;min-height:56px;padding:0 12px;border:0;border-radius:9px;text-align:left;color:var(--text);background:transparent;transition:background-color 120ms ease}
  .symbol-option:hover{background:transparent}
  .symbol-option.highlighted{background:var(--bg-hover)}
  .symbol-option:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}
  .symbol-option.already-added{opacity:.6}
  .asset-badge{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:color-mix(in srgb,var(--accent) 16%,var(--bg));color:color-mix(in srgb,var(--accent) 80%,var(--ink));font:600 13px var(--mono);flex-shrink:0}
  .asset-badge.large{width:40px;height:40px;font-size:16px}
  .asset-badge.cn-badge{background:color-mix(in srgb,var(--down) 18%,var(--bg));color:var(--warn);font-family:var(--font)}
  .asset-badge.cb-badge{background:color-mix(in srgb,var(--accent) 20%,var(--bg));color:var(--accent-strong)}
  .asset-badge.okx-badge{background:color-mix(in srgb,var(--text-strong) 14%,var(--bg));color:var(--text-strong)}
  .symbol-label{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
  .symbol-label strong{font:600 13.5px var(--mono);letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .symbol-label mark{background:transparent;color:var(--accent)}
  .symbol-label small{display:flex;align-items:center;gap:0;font-size:11.5px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .symbol-label small i{font-style:normal;padding:0 4px;opacity:.6}
  .symbol-label small .source-pill{margin-right:5px}
  .source-pill{display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:var(--radius-sm);background:var(--bg);color:var(--text-dim);font:600 9.5px var(--mono);letter-spacing:.04em;white-space:nowrap}
  .source-pill[data-source="okx"]{color:var(--text-strong)}.source-pill[data-source="coinbase"]{color:var(--accent-strong)}.source-pill[data-source="cn-a"]{color:var(--warn)}.source-pill[data-source="binance"]{color:var(--warn)}
  .quote-cell{display:flex;flex-direction:column;align-items:flex-end;gap:3px;min-width:82px;font:500 12.5px var(--mono);font-variant-numeric:tabular-nums}
  .quote-cell b{font-weight:500;color:var(--text-strong)}
  .quote-cell small{font-size:11px;color:var(--text-dim);min-height:12px}
  .up{color:var(--up)!important}.down{color:var(--down)!important}
  .symbol-add-status{width:62px;text-align:right;font-size:11px;color:var(--accent)}
  .already-added .symbol-add-status{color:var(--text-dim)}

  .preview-col{border-left:1px solid var(--line);background:color-mix(in srgb,var(--bg) 55%,transparent);min-height:0;overflow:auto;scrollbar-width:thin}
  .preview-card{display:flex;flex-direction:column;gap:12px;padding:16px 16px 0;min-height:100%;box-sizing:border-box}
  .preview-head{display:flex;align-items:center;gap:11px}
  .preview-head>div{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
  .preview-head strong{font:600 15px var(--mono);color:var(--text-strong)}
  .preview-head small{font-size:11.5px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .preview-price{display:flex;align-items:baseline;gap:9px;font-variant-numeric:tabular-nums}
  .preview-price b{font:600 24px var(--mono);color:var(--text-strong);letter-spacing:-.01em}
  .preview-price span{font:500 13px var(--mono)}
  .preview-price small{margin-left:auto;font-size:10.5px;color:var(--text-dim)}
  .preview-chart{height:96px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-lg)}
  .preview-chart :global(svg){width:100%;height:96px}
  .preview-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;margin:0}
  .preview-stats div{display:flex;flex-direction:column;gap:3px}
  .preview-stats dt{font-size:10.5px;color:var(--text-dim)}
  .preview-stats dd{margin:0;font:500 12.5px var(--mono);color:var(--text)}
  .preview-card h3{display:flex;align-items:center;gap:6px;margin:4px 0 -6px;font:600 11px var(--font);color:var(--text-dim);letter-spacing:.04em}
  .preview-card h3 small{font:400 10.5px var(--mono);opacity:.75}
  .venues{display:flex;flex-direction:column;gap:2px}
  .venue{display:flex;align-items:center;gap:9px;width:100%;height:40px;min-height:40px;padding:0 8px;border:0;border-radius:var(--radius-md);background:transparent;color:var(--text);text-align:left;transition:background-color 120ms ease}
  .venue:hover{background:var(--bg-hover)}
  .venue-name{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
  .venue-name b{font:500 12px var(--mono)}
  .venue-name small{font-size:10.5px;color:var(--text-dim)}
  .venue .quote-cell{min-width:70px;font-size:11.5px}
  .preview-open{position:sticky;bottom:0;display:inline-flex;align-items:center;justify-content:center;gap:8px;margin-top:auto;margin-bottom:14px;height:36px;min-height:36px;box-shadow:0 -14px 18px -6px var(--bg-panel);border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);border-radius:var(--radius-lg);background:color-mix(in srgb,var(--accent) 16%,var(--bg-panel));color:var(--text-strong);font:600 12.5px var(--font)}
  .preview-open:hover{background:color-mix(in srgb,var(--accent) 24%,var(--bg-panel))}
  .preview-open kbd{height:18px;background:transparent}
  .preview-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--text-dim);font-size:11.5px;padding:24px;text-align:center}

  .search-empty{height:100%;min-height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:30px;color:var(--text-dim);text-align:center}
  .search-empty strong{font-size:13px;font-weight:500;color:var(--text)}
  .search-empty p{font-size:11.5px;line-height:1.8;max-width:380px;margin:0}
  .search-empty button{border:1px solid var(--line);border-radius:var(--radius-md);font-size:11.5px;padding:6px 12px}
  .catalog-warning{font-size:11px;line-height:1.6;margin:0;padding:8px 20px;border-top:1px solid var(--line);color:var(--warn)}
  .catalog-details summary{cursor:pointer;font-size:10.5px;color:var(--text-dim)}
  .catalog-details small{display:block;margin-top:6px;overflow-wrap:anywhere;font-size:10.5px;color:var(--text-dim)}
  .catalog-details code{font-size:10px}
  footer{display:flex;align-items:center;gap:16px;padding:0 16px 0 20px;height:42px;min-height:42px;border-top:1px solid var(--line);flex-shrink:0;background:color-mix(in srgb,var(--bg) 45%,transparent)}
  .hints{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text-dim);white-space:nowrap}
  .hints kbd:not(:first-child){margin-left:6px}
  .hints kbd+kbd{margin-left:0}
  .footer-status{flex:1;min-width:0;font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .footer-status.failed{color:var(--warn)}
  footer .done{height:28px;min-height:28px;padding:0 14px;border:1px solid var(--line);border-radius:var(--radius-md);font-size:12px}

  @keyframes backdrop-in{from{background:transparent;backdrop-filter:blur(0)}to{background:color-mix(in srgb, var(--bg-panel) 60%, transparent);backdrop-filter:blur(3px)}}
  @media(prefers-reduced-motion:reduce){.symbol-search-dialog::backdrop{animation:none}.channel-filters button::after,.symbol-option,.venue{transition:none}}
  @media(max-width:860px){.search-body{grid-template-columns:minmax(0,1fr)}.preview-col{display:none}}
  @media(max-width:600px){.symbol-search-dialog{margin:12px auto auto;width:calc(100vw - 16px);height:calc(100dvh - 24px)}.search-field{height:54px;padding-left:14px}.search-field input{font-size:15px}.hints{display:none}.quote-cell{min-width:70px}.symbol-option :global(.sparkline){display:none}}
</style>
