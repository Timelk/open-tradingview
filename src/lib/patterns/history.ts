import type {BarInput,ColumnName} from '../core/types';
import type {ColumnStore} from '../core/datastore';
import type {IndicatorRegistry} from '../indicators/registry';
import {TIMEFRAMES,type IndicatorInstance} from '../scene/types';
import {nextOpenTime,validBar} from '../feed/binance-feed';

export const MAX_PATTERN_HISTORY_BARS=20_000;
const integer=(value:unknown,fallback:number,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,Math.round(value))):fallback;

/** Required BASE candles, not aggregated study candles. Include both pivot
 * edges, one forming group and one potentially partial first aggregate bucket.
 * Lower-timeframe requests cannot be reconstructed from the chart's OHLCV. */
export function neededPatternBars(instances:readonly Pick<IndicatorInstance,'id'|'params'|'timeframe'>[],registry:Pick<IndicatorRegistry,'get'>,baseInterval:string|number):number {
  const baseMs=typeof baseInterval==='number'?baseInterval:TIMEFRAMES[baseInterval];
  if(!Number.isFinite(baseMs)||baseMs<=0)return 0;
  let required=0;
  for(const instance of instances){
    let category:string|undefined;
    try{category=registry.get(instance.id).category;}catch{continue;}
    if(!['pattern','analysis'].includes(category??''))continue;
    const sourceMs=instance.timeframe==='chart'?baseMs:TIMEFRAMES[instance.timeframe];
    if(!sourceMs||sourceMs<baseMs||sourceMs%baseMs!==0)continue;
    const depth=integer(instance.params.lookback,1500,100,10000),strength=integer(instance.params.pivotStrength,3,1,30);
    const radius=instance.params.multiScale===false?strength:Math.min(30,strength*8);
    required=Math.max(required,(depth+2*radius+2)*(sourceMs/baseMs));
  }
  return Math.min(MAX_PATTERN_HISTORY_BARS,required);
}

/** Atomic in-place prepend. Live updates received during the request remain in
 * the current store's tail; stale/overlapping history cannot replace them.
 * Returns the index shift for viewport/derived-cache rebasing by the caller. */
export function prependPatternHistory(store:ColumnStore,older:readonly BarInput[],interval:string):number {
  if(!older.length)return 0;
  for(let i=0;i<older.length;i++){
    if(!validBar(older[i]))throw new Error('Invalid history OHLCV');
    if(i&&nextOpenTime(older[i-1].time,interval)!==older[i].time)throw new Error('History is unordered, duplicated or incomplete');
  }
  if(store.length&&nextOpenTime(older.at(-1)!.time,interval)!==store.timeAt(0))throw new Error('History must precede current chart without a gap or overlap');
  const count=older.length;store.prepend(older);
  return count;
}
