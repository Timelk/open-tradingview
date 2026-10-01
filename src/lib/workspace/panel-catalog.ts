import type {PanelDefinition} from './registry';

/** Panels are grouped by task; this order is the display order of the right
 * rail and of dock tabs (market → chart → research). */
export const PANEL_GROUPS=[{id:'market',title:'行情'},{id:'chart',title:'图表'},{id:'research',title:'研究'}] as const;

/** Built-in panel metadata without components (kept importable from tests). */
export const BUILTIN_PANELS:readonly Omit<PanelDefinition<never>,'component'>[]=[
  {id:'watchlist',title:'自选',icon:'watchlist',defaultZone:'right',group:'market'},
  {id:'orderbook',title:'盘口',icon:'orderbook',defaultZone:'right',preferredSize:380,minWidth:280,minHeight:260,motionPolicy:'none',group:'market'},
  {id:'objects',title:'对象树',icon:'layers',defaultZone:'right',group:'chart'},
  {id:'data',title:'数据',icon:'data',defaultZone:'bottom',group:'chart'},
  {id:'patterns',title:'分析',icon:'pattern',defaultZone:'right',preferredSize:360,minWidth:300,minHeight:240,group:'research'},
];
