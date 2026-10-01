import type {DatasetSnapshot} from '../history/types';
import {nextOpenTime} from '../feed/binance-feed';
/** OHLC only contains complete candles: a cursor inside a candle must not see
 * that candle's eventual high/low/close. Historical depth can remain subsecond. */
export function closedPriceCount(dataset:DatasetSnapshot,cursor:number):number {
  if(!Number.isFinite(cursor))throw Error('回放时间无效');
  let lo=0,hi=dataset.bars.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(nextOpenTime(dataset.bars[mid].time,dataset.interval)<=cursor)lo=mid+1;else hi=mid;}
  return lo;
}
export function closedPricePrefix(dataset:DatasetSnapshot,cursor:number):DatasetSnapshot {
  const lo=closedPriceCount(dataset,cursor);
  return {...dataset,bars:dataset.bars.slice(0,lo),markPrices:dataset.markPrices?.filter(p=>lo>0&&p.time<nextOpenTime(dataset.bars[lo-1].time,dataset.interval))};
}
