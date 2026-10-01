import { TIMEFRAMES } from '../scene/types';
import { marketConnectors, type MarketSourceId } from '../market/connectors';

export interface MarketSelection { source:MarketSourceId;symbol:string;interval:string }
export const MARKET_SELECTION_KEY='tvchart.market-selection.usdm.v1';
const fallback:MarketSelection={source:'binance',symbol:'BTCUSDT',interval:'15m'};
type StoragePort=Pick<Storage,'getItem'|'setItem'>;
function browserStorage():StoragePort|undefined {try{return typeof localStorage==='undefined'?undefined:localStorage;}catch{return undefined;}}
function validated(value:unknown):MarketSelection|null {
  if(!value||typeof value!=='object')return null;
  const input=value as Partial<MarketSelection>;
  if(typeof input.source!=='string'||typeof input.symbol!=='string'||typeof input.interval!=='string'||!Object.hasOwn(TIMEFRAMES,input.interval))return null;
  const connector=marketConnectors.get(input.source);
  const symbol=connector?.normalizeSymbol(input.symbol)??null;
  return connector&&symbol?{source:connector.id,symbol,interval:input.interval}:null;
}
export function loadMarketSelection(storage=browserStorage()):MarketSelection {
  try{return validated(JSON.parse(storage?.getItem(MARKET_SELECTION_KEY)??'null'))??{...fallback};}catch{return {...fallback};}
}
export function saveMarketSelection(selection:MarketSelection,storage=browserStorage()):void {
  const value=validated(selection);if(!value)return;
  try{storage?.setItem(MARKET_SELECTION_KEY,JSON.stringify(value));}catch{/* Chart navigation remains available when storage is disabled. */}
}

export type IntervalGroupId='minutes'|'hours'|'days';
export interface IntervalCatalogItem { id:string;label:string;group:IntervalGroupId }
export const INTERVAL_CATALOG:readonly IntervalCatalogItem[]=[
  {id:'1m',label:'1 分钟',group:'minutes'},
  {id:'3m',label:'3 分钟',group:'minutes'},
  {id:'5m',label:'5 分钟',group:'minutes'},
  {id:'15m',label:'15 分钟',group:'minutes'},
  {id:'30m',label:'30 分钟',group:'minutes'},
  {id:'1h',label:'1 小时',group:'hours'},
  {id:'2h',label:'2 小时',group:'hours'},
  {id:'4h',label:'4 小时',group:'hours'},
  {id:'6h',label:'6 小时',group:'hours'},
  {id:'12h',label:'12 小时',group:'hours'},
  {id:'1d',label:'1 天',group:'days'},
  {id:'3d',label:'3 天',group:'days'},
  {id:'7d',label:'7 天',group:'days'},
  {id:'30d',label:'30 天',group:'days'},
];
export const FAVORITE_INTERVALS_KEY='tvchart.favorite-intervals.v1';
export const DEFAULT_FAVORITE_INTERVALS:readonly string[]=['1m','5m','15m','30m','1h','4h','1d','7d','30d'];
export function normalizeFavoriteIntervals(value:unknown):string[] {
  if(!Array.isArray(value))return [...DEFAULT_FAVORITE_INTERVALS];
  const valid=Array.from(new Set(value.filter((item):item is string=>typeof item==='string'&&Object.hasOwn(TIMEFRAMES,item))));
  return valid.length?valid.sort((a,b)=>TIMEFRAMES[a]-TIMEFRAMES[b]):[...DEFAULT_FAVORITE_INTERVALS];
}
export function loadFavoriteIntervals(storage=browserStorage()):string[] {
  try{
    const raw=storage?.getItem(FAVORITE_INTERVALS_KEY);
    return raw?normalizeFavoriteIntervals(JSON.parse(raw)):[...DEFAULT_FAVORITE_INTERVALS];
  }catch{return [...DEFAULT_FAVORITE_INTERVALS];}
}
export function saveFavoriteIntervals(favorites:readonly string[],storage=browserStorage()):string[] {
  const normalized=normalizeFavoriteIntervals(favorites);
  try{storage?.setItem(FAVORITE_INTERVALS_KEY,JSON.stringify(normalized));}catch{}
  return normalized;
}
export function toggleFavoriteInterval(favorites:readonly string[],interval:string,storage=browserStorage()):string[] {
  if(!Object.hasOwn(TIMEFRAMES,interval))return normalizeFavoriteIntervals(favorites);
  const current=normalizeFavoriteIntervals(favorites);
  const next=current.includes(interval)?(current.length>1?current.filter(item=>item!==interval):current):[...current,interval];
  return saveFavoriteIntervals(next,storage);
}
export function toolbarIntervals(favorites:readonly string[],activeInterval:string):string[] {
  const base=normalizeFavoriteIntervals(favorites);
  if(Object.hasOwn(TIMEFRAMES,activeInterval)&&!base.includes(activeInterval)){
    return [...base,activeInterval].sort((a,b)=>TIMEFRAMES[a]-TIMEFRAMES[b]);
  }
  return base;
}
