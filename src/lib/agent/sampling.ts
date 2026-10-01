import type {ColumnView,FlowColumnName} from '../core/types';
import {FLOW_COLUMNS} from '../core/types';
import {formatTime,num,type BarRange,type TimeFormat} from './anchors';

/** Downsampling keeps agent payloads bounded without inventing values: bars
 * aggregate as OHLCV buckets, series report the last value of each bucket. */
export const MAX_POINTS=5000;
export function bucketSize(range:BarRange,maxPoints:number):number {
  const count=range.end-range.start;return count>maxPoints?Math.ceil(count/maxPoints):1;
}
export const BAR_FIELDS=['time','open','high','low','close','volume',...FLOW_COLUMNS] as const;
export type BarField=typeof BAR_FIELDS[number];
export function aggregateBars(cols:ColumnView,range:BarRange,size:number,fields:readonly BarField[],format:TimeFormat):(string|number|null)[][] {
  const time=cols.col('time'),open=cols.col('open'),high=cols.col('high'),low=cols.col('low'),close=cols.col('close'),volume=cols.col('volume');
  const flows=new Map(FLOW_COLUMNS.map(name=>[name,cols.flow?.(name)]));
  const rows:(string|number|null)[][]=[];
  for(let start=range.start;start<range.end;start+=size){
    const end=Math.min(range.end,start+size);let hi=-Infinity,lo=Infinity,vol=0;
    const sums=new Map<FlowColumnName,number>();
    for(let i=start;i<end;i++){
      hi=Math.max(hi,high[i]);lo=Math.min(lo,low[i]);vol+=volume[i];
      for(const [name,values] of flows)if(values&&Number.isFinite(values[i]))sums.set(name,(sums.get(name)??0)+values[i]);
    }
    rows.push(fields.map(field=>field==='time'?formatTime(time[start],format):field==='open'?num(open[start]):field==='high'?num(hi):field==='low'?num(lo):field==='close'?num(close[end-1]):field==='volume'?num(vol):sums.has(field)?num(sums.get(field)!):null));
  }
  return rows;
}
/** Bucket-aligned samples of a derived/overlay series whose array begins at `offset`. */
export function sampleSeries(values:ArrayLike<number>,offset:number,range:BarRange,size:number):(number|null)[] {
  const out:(number|null)[]=[];
  for(let start=range.start;start<range.end;start+=size){
    const end=Math.min(range.end,start+size);let value=NaN;
    for(let i=end-1;i>=start&&!Number.isFinite(value);i--){const at=i-offset;if(at>=0&&at<values.length)value=values[at];}
    out.push(num(value));
  }
  return out;
}
export function bucketTimes(cols:ColumnView,range:BarRange,size:number,format:TimeFormat):(string|number|null)[] {
  const time=cols.col('time'),out:(string|number|null)[]=[];
  for(let start=range.start;start<range.end;start+=size)out.push(formatTime(time[start],format));
  return out;
}
