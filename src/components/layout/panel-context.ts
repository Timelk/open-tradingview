import type { Component } from 'svelte';
import type { ChartController,ChartState } from '../../lib/chart/controller';
import type { WatchlistStore } from '../../lib/watchlist/store';
import type { MarketSymbol,WatchlistQuoteSnapshot } from '../../lib/watchlist/types';
import type { DockZone } from '../../lib/workspace/layout';

/** Panels receive services and lightweight readings; chart canvases and feeds
 * remain owned by the workspace, independent of docking or visibility. */
export interface WorkspacePanelContext {
  controller:ChartController;chartState:ChartState;watchlistStore:WatchlistStore;
  quoteState:WatchlistQuoteSnapshot;catalog:MarketSymbol[];
  onSelectSymbol:(symbol:string)=>void;onAddSymbol:()=>void;onRetryQuotes:()=>void;
  onWatchOrder:(symbols:string[])=>void;onOpenLibrary:()=>void;
  onOpenProperties:(ids:string[])=>void;onTreeSelection:()=>void;
  onOpenPanel:(id:string)=>void;
  onExpandAnalysis?:()=>void;
}
export interface WorkspacePanelProps {
  context:WorkspacePanelContext;active?:boolean;density:'compact'|'comfortable';zone:DockZone;onClose:()=>void;
}
export type WorkspacePanelComponent=Component<WorkspacePanelProps>;
