<script lang="ts">
  import WatchlistPanel from '../../watchlist/WatchlistPanel.svelte';
  import type { WorkspacePanelProps } from '../panel-context';
  let {context,density,onClose}:WorkspacePanelProps=$props();
</script>
<WatchlistPanel embedded {density} store={context.watchlistStore} quoteState={context.quoteState} catalog={context.catalog} currentSymbol={context.chartState.symbol} onSelect={context.onSelectSymbol} onAdd={context.onAddSymbol} {onClose} onRetry={context.onRetryQuotes} onOrderChange={context.onWatchOrder}/>
