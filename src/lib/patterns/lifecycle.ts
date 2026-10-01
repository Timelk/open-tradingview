import type {ColumnView} from '../core/types';
import type {PatternMatch} from './types';

const MAX_OBSERVATION_BARS=10_000;

/** Append an independent, closed-bar reference-touch measurement. The legacy
 * field name `resolution` does not end the structure's lifecycle: subsequent
 * failures, invalidations, warnings and geometry must remain exactly intact.
 * OHLC cannot order risk and reference touches within one candle; retain the
 * conservative rule that an earlier or simultaneous risk event blocks it. */
export function resolvePatternLifecycle(match:PatternMatch,cols:ColumnView):PatternMatch {
  if(match.resolution||!Number.isFinite(match.confirmedAt)||!Number.isFinite(match.invalidation)||!match.targets.length)return match;
  if(match.status==='invalidated'&&!Number.isFinite(match.invalidatedAt))return match;
  const targetIndex=match.targets.length-1,target=match.targets[targetIndex],bullish=match.direction==='bullish';
  if(!Number.isFinite(target)||(bullish?target<=match.invalidation:target>=match.invalidation))return match;
  const time=cols.col('time'),open=cols.col('open'),high=cols.col('high'),low=cols.col('low'),close=cols.col('close');
  let end=Math.max(0,Math.min(cols.length,Math.floor(cols.closedLength??cols.length-1)));
  // A closed-series adapter may append an OHLC-less time sentinel. It supplies
  // the previous candle's closing timestamp, never an extra tradable candle.
  if(end&&[open[end-1],high[end-1],low[end-1],close[end-1]].every(Number.isNaN))end--;
  if(!end)return match;
  let lo=0,hi=end;
  while(lo<hi){const mid=(lo+hi)>>>1;if(time[mid]<match.confirmedAt)lo=mid+1;else hi=mid;}
  const start=lo;
  // A clipped window cannot establish the order of observations before its
  // first available candle. Missing evidence is never an inferred touch.
  if(start>=end||time[start]!==match.confirmedAt)return match;
  const step=start>0?time[start]-time[start-1]:cols.length>start+1?time[start+1]-time[start]:NaN;
  if(!Number.isFinite(step)||step<=0)return match;
  if(bullish?open[start]>=target:open[start]<=target)return match;
  const blockingEvents=(match.events??[]).filter(event=>event.kind==='failed-breakout'||event.kind==='invalidation');
  if(blockingEvents.some(event=>!Number.isFinite(event.time)||!Number.isFinite(event.knownAt)))return match;
  if(match.stage==='failed-breakout'&&!blockingEvents.length)return match;
  const blockedFrom=Math.min(Infinity,...blockingEvents.map(event=>event.time));
  for(let i=start;i<Math.min(end,start+MAX_OBSERVATION_BARS);i++){
    if(![time[i],open[i],high[i],low[i],close[i]].every(Number.isFinite)||low[i]>Math.min(open[i],close[i])||high[i]<Math.max(open[i],close[i])||low[i]>high[i])return match;
    if(i>start&&time[i]-time[i-1]!==step&&!consecutiveMonths(time[i-1],time[i]))return match;
    const knownAt=i+1<cols.length?time[i+1]:consecutiveMonths(time[i-1],time[i])?nextMonth(time[i]):time[i]+step;
    if(!Number.isFinite(knownAt)||knownAt<=time[i]||(knownAt-time[i]!==step&&!consecutiveMonths(time[i],knownAt)))return match;
    if(time[i]>=blockedFrom||(match.invalidatedAt!==undefined&&match.invalidatedAt<=knownAt))return match;
    // Conservative extra guard for Huzi: its structural invalidation uses close,
    // but an earlier risk wick still prevents this auxiliary touch measurement.
    if(bullish?low[i]<=match.invalidation:high[i]>=match.invalidation)return match;
    if(!(bullish?high[i]>=target:low[i]<=target))continue;
    return {...match,
      resolution:{kind:'target-reached',time:time[i],knownAt,price:target,targetIndex},
    };
  }
  return match;
}

const nextMonth=(time:number)=>{const value=new Date(time);return Date.UTC(value.getUTCFullYear(),value.getUTCMonth()+1,1);};
/** Calendar-month feeds have legitimate 28–31 day durations. Fixed-timeframe
 * gaps remain rejected instead of being mistaken for extra elapsed candles. */
function consecutiveMonths(previous:number,current:number):boolean {
  if(!Number.isFinite(previous)||!Number.isFinite(current))return false;
  const start=new Date(previous);
  return start.getUTCDate()===1&&start.getUTCHours()===0&&start.getUTCMinutes()===0&&start.getUTCSeconds()===0&&start.getUTCMilliseconds()===0&&nextMonth(previous)===current;
}
