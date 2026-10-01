import type {DatasetSnapshot,MarketBar} from './types';
import {marketIdentity} from '../market/identity';
export const MAX_HISTORY_BARS=20_000;
export interface HistoryProgress {completed:number;total:number;stage:string}
export async function datasetFingerprint(dataset:DatasetSnapshot):Promise<string>{
  const bytes=new Float64Array(dataset.bars.length*6);
  dataset.bars.forEach((bar,i)=>bytes.set([bar.time,bar.open,bar.high,bar.low,bar.close,bar.volume],i*6));
  const prefix=new TextEncoder().encode(`${marketIdentity(dataset)}:${dataset.quoteCurrency??''}:${dataset.tickSize??''}:${JSON.stringify(dataset.contract??null)}:${JSON.stringify(dataset.markPrices??null)}:`);
  const all=new Uint8Array(prefix.length+bytes.byteLength);all.set(prefix);all.set(new Uint8Array(bytes.buffer),prefix.length);
  const digest=await crypto.subtle.digest('SHA-256',all);return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
export function validateDatasetBars(bars:readonly MarketBar[],intervalMs:number):void {
  if(!bars.length)throw Error('所选区间没有已收盘行情');
  if(bars.length>MAX_HISTORY_BARS)throw Error(`单次最多读取 ${MAX_HISTORY_BARS.toLocaleString()} 根历史行情，请缩短区间或使用更高周期`);
  for(let i=0;i<bars.length;i++){
    const b=bars[i];if(![b.time,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)||b.time<0||b.volume<0||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close))throw Error(`第 ${i+1} 根行情无效`);
    if(i){
      const prev=bars[i-1].time,diff=b.time-prev;
      const prevDate=new Date(prev),calendarMonthNext=intervalMs>=25*86_400_000?Date.UTC(prevDate.getUTCFullYear(),prevDate.getUTCMonth()+1,1):NaN;
      if(diff!==intervalMs&&b.time!==calendarMonthNext)throw Error(`行情在 ${new Date(b.time).toISOString()} 附近存在缺口或重复，已停止历史读取`);
    }
  }
}
