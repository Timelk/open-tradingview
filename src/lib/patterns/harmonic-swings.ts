import type {ColumnName,ColumnView,ParamValues} from '../core/types';
import {appendHuziSwing} from './huzi-swings';
import {confirmedPivotEvents,type Pivot} from './pivots';
import {harmonicNumber} from './harmonic-rules';

/** Honor explicit exchange closure and never consume hidden later candles. */
export function harmonicView(input:ColumnView):ColumnView {
  if(input.closedLength===undefined)return input;
  const closed=Math.max(0,Math.min(input.length,Math.floor(input.closedLength)));
  if(closed<input.length)return {length:closed+1,closedLength:closed,col:name=>input.col(name)};
  const arrays={} as Record<ColumnName,Float64Array>;
  for(const name of ['time','open','high','low','close','volume'] as ColumnName[]){arrays[name]=new Float64Array(closed+1).fill(NaN);arrays[name].set(input.col(name).subarray(0,closed));}
  const t=input.col('time'),step=closed>1?t[closed-1]-t[closed-2]:60_000;
  const lastDate=new Date(t[closed-1]),month=Date.UTC(lastDate.getUTCFullYear(),lastDate.getUTCMonth()+1,1);
  arrays.time[closed]=closed?closed>1&&harmonicConsecutive(t[closed-2],t[closed-1],NaN)?month:t[closed-1]+step:0;
  return {length:closed+1,closedLength:closed,col:name=>arrays[name]};
}
export function validHarmonicBar(cols:ColumnView,i:number):boolean {
  const o=cols.col('open')[i],h=cols.col('high')[i],l=cols.col('low')[i],c=cols.col('close')[i];
  return [cols.col('time')[i],o,h,l,c].every(Number.isFinite)&&l<=Math.min(o,c)&&h>=Math.max(o,c)&&l<=h;
}
export function harmonicStep(cols:ColumnView):number {
  const t=cols.col('time');
  // Do not estimate a historical cadence from a later bar or future outlier.
  for(let i=1;i<cols.length;i++){const d=t[i]-t[i-1];if(d>0&&Number.isFinite(d))return d;}
  return Infinity;
}
export function harmonicConsecutive(previous:number,current:number,step:number):boolean {
  if(current-previous===step)return true;
  const d=new Date(previous);
  return d.getUTCDate()===1&&d.getUTCHours()===0&&d.getUTCMinutes()===0&&d.getUTCSeconds()===0&&d.getUTCMilliseconds()===0&&Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)===current;
}
export function harmonicIntact(cols:ColumnView,start:number,end:number,step=harmonicStep(cols)):boolean {
  const t=cols.col('time');
  for(let i=start;i<=end;i++)if(!validHarmonicBar(cols,i)||(i>start&&!harmonicConsecutive(t[i-1],t[i],step)))return false;
  return true;
}
/** A time-radius zigzag may omit a competing wick whose own right-hand
 * confirmation never completes. Omitting the pivot cannot erase its price:
 * every interior candle of a measured harmonic leg must stay between that
 * leg's actual extrema. Contained internal corrections remain valid.
 * End candles are excluded from the interior test: OHLC cannot order their
 * two wicks, and the endpoint's selected high/low is checked independently. */
export function harmonicLegsIntact(cols:ColumnView,points:readonly Pivot[]):boolean {
  if(points.length<2)return false;
  const highs=cols.col('high'),lows=cols.col('low'),times=cols.col('time');
  const step=harmonicStep(cols);
  for(let i=0;i<points.length;i++){
    const point=points[i],epsilon=Math.max(1e-12,Math.abs(point.value)*1e-10);
    if(!Number.isInteger(point.index)||point.index<0||point.index>=cols.length-1||!validHarmonicBar(cols,point.index)||
      point.time!==times[point.index]||Math.abs(point.value-(point.kind==='high'?highs[point.index]:lows[point.index]))>epsilon)return false;
    if(!i)continue;
    const previous=points[i-1];
    if(previous.index>=point.index||previous.kind===point.kind)return false;
    const ceiling=Math.max(previous.value,point.value),floor=Math.min(previous.value,point.value),rounding=Math.max(1e-12,Math.abs(ceiling)*1e-10,Math.abs(floor)*1e-10);
    for(let j=previous.index+1;j<=point.index;j++){
      if(!validHarmonicBar(cols,j)||!harmonicConsecutive(times[j-1],times[j],step))return false;
      if(j<point.index&&(highs[j]>ceiling+rounding||lows[j]<floor-rounding))return false;
    }
  }
  return true;
}
export interface HarmonicSwing {pivots:readonly Pivot[];event:Pivot;radius:number;retracement:number}
/** Both forming and confirmed detectors use identical causal scale stacks.
 * A gap flushes the stack, including a pivot whose confirmation spans the gap. */
export function* harmonicSwings(cols:ColumnView,params:ParamValues,lookback:number):Generator<HarmonicSwing> {
  const strength=Math.round(harmonicNumber(params.pivotStrength,3,1,30));
  const radii=params.multiScale===false?[strength]:[...new Set([strength,strength*2,strength*4,strength*8].map(v=>Math.min(30,v)))];
  const step=harmonicStep(cols),time=cols.col('time');
  for(const radius of radii){
    const levels=(params.structuralSwings===false?[0]:[0,.236,.382]).map(retracement=>({retracement,pivots:[] as Pivot[]}));
    for(const event of confirmedPivotEvents(cols,radius,lookback)){
      for(const level of levels){
        const previous=level.pivots.at(-1);
        if(!harmonicIntact(cols,previous?previous.index:Math.max(0,event.index-radius),event.index+radius,step)||!harmonicConsecutive(time[event.index+radius],event.confirmedAt,step))level.pivots.length=0;
        if(!harmonicIntact(cols,Math.max(0,event.index-radius),event.index+radius,step)||!harmonicConsecutive(time[event.index+radius],event.confirmedAt,step))continue;
        if(appendHuziSwing(level.pivots,event,level.retracement))yield {pivots:level.pivots,event,radius,retracement:level.retracement};
      }
    }
  }
}
