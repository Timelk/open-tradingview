import type {ClosedRangeIndex} from '../analysis/closed-range-index';
import type {PatternEvent,PatternGuide,PatternMatch,PatternStage} from './types';

export interface PatternKnowledgeOptions {retestWindow?:number;
  /** Observation horizon after confirmation, as a multiple of the structure's
   * own span in bars (at least {@link MIN_OBSERVATION_BARS}). */
  observationRatio?:number}
export const DEFAULT_OBSERVATION_RATIO=2,MIN_OBSERVATION_BARS=24;
const GAP_WARNING='后续行情存在缺口；保留缺口前的历史结构，当前有效性未知。';
type Line={origin:number;value:number;slope:number};
const at=(line:Line,index:number)=>line.value+(index-line.origin)*line.slope;

/** Bars a confirmed structure is judged for: max(24, span × ratio). */
export function patternObservationBars(match:PatternMatch,index:ClosedRangeIndex,ratio=DEFAULT_OBSERVATION_RATIO):number {
  const first=match.points[0],last=match.points.at(-1);
  const span=first&&last?Math.max(1,index.lowerBound(last.time)-index.lowerBound(first.time)):1;
  const scale=Number.isFinite(ratio)&&ratio>0?ratio:DEFAULT_OBSERVATION_RATIO;
  return Math.max(MIN_OBSERVATION_BARS,Math.ceil(span*scale));
}

/** Refresh an already discovered geometry against the known closed prefix.
 * The viewport and the tile that discovered it are not replay cursors.
 * Geometry/confirmation never change. A structure is judged only inside its
 * observation window: reaching the reference target first completes it, and
 * surviving the window without failure ends it. A later move through the old
 * risk level is new market information, not a retroactive failure.
 * The caller must exclude matches confirmed after the prefix's known time. */
export function refreshPatternKnowledge(match:PatternMatch,index:ClosedRangeIndex,options:PatternKnowledgeOptions={}):PatternMatch {
  return withAtrPierce(match,refreshBase(match,index,options),index,options);
}

/** "2ATR 未扎 / 已扎": the first closed candle, inside the same observation window, whose wick went beyond the ATR
 * reference beyond D. It is independent of the structural invalidation above and never changes it; a match without
 * `signals.atr` (legacy caches, harmonicSignals off, other families) is returned untouched. Like every lifecycle
 * fact it stops at the candle that completed the structure or invalidated it. */
function withAtrPierce(original:PatternMatch,refreshed:PatternMatch,index:ClosedRangeIndex,options:PatternKnowledgeOptions):PatternMatch {
  const atr=original.signals?.atr;
  if(!atr||!Number.isFinite(atr.level))return refreshed;
  const {atrPierced:_stale,...clean}=refreshed;
  const end=index.closedLength,start=index.lowerBound(original.confirmedAt),times=index.cols.col('time');
  if(!end||!Number.isFinite(original.confirmedAt)||original.confirmedAt>index.knownAt(end-1)||start>=end||times[start]!==original.confirmedAt)return clean;
  const gap=index.firstInvalid(start,end),through=gap<0?end:gap;
  let to=Math.min(through,start+patternObservationBars(original,index,options.observationRatio));
  if(refreshed.resolution)to=Math.min(to,index.lowerBound(refreshed.resolution.time)+1);
  if(refreshed.invalidatedAt!==undefined)to=Math.min(to,index.lowerBound(refreshed.invalidatedAt));
  const bullish=original.direction==='bullish',hit=index.firstCross(bullish?'low':'high',start,to,bullish?'lt':'gt',atr.level);
  if(hit<0)return clean;
  const knownAt=index.knownAt(hit);
  return Number.isFinite(knownAt)?{...clean,atrPierced:{time:times[hit],knownAt,price:index.cols.col(bullish?'low':'high')[hit]}}:clean;
}

function refreshBase(match:PatternMatch,index:ClosedRangeIndex,options:PatternKnowledgeOptions):PatternMatch {
  if(!Number.isFinite(match.confirmedAt)||!Number.isFinite(match.invalidation))return match;
  const huzi=match.family.startsWith('huzi-'),time=index.cols.col('time'),end=index.closedLength;
  const start=index.lowerBound(match.confirmedAt);
  // A cached tile may contain later states: reconstruct from confirmation,
  // including on an intentional replay rewind. Do not recycle its reference.
  const {invalidatedAt:_invalidatedAt,resolution:_resolution,dataWarning:_dataWarning,stage:_stage,events:_events,observationEndedAt:_ended,...geometry}=match;
  let current:PatternMatch={...geometry,status:'confirmed'};
  if(!end||match.confirmedAt>index.knownAt(end-1))return {...current,dataWarning:'确认时间晚于当前可知数据；暂不判断后续状态。'};
  if(start<end&&time[start]!==match.confirmedAt){
    // Missing the candle immediately after confirmation means the order of
    // touches cannot be established. Preserve only the initial breakout.
    const initial=match.events?.filter(event=>event.kind==='breakout'&&event.knownAt===match.confirmedAt);
    return {...current,...(huzi&&initial?.length?{stage:'breakout' as const,events:initial}:{}),dataWarning:GAP_WARNING};
  }
  const gap=index.firstInvalid(start,end),through=gap<0?end:gap;
  const windowEnd=start+patternObservationBars(match,index,options.observationRatio),horizon=Math.min(through,windowEnd);
  const failed=index.firstCross(huzi?'close':match.direction==='bullish'?'low':'high',start,horizon,match.direction==='bullish'?'lt':'gt',match.invalidation);
  const base=current;
  if(huzi)current=huziState(base,match,index,start,through,failed,options);
  else if(failed>=0){
    const knownAt=index.knownAt(failed);
    if(Number.isFinite(knownAt))current={...current,status:'invalidated',invalidatedAt:knownAt};
  }
  // The reference touch is evaluated against the state before any failure; it
  // already rejects an adverse wick or close back inside at or before the touch,
  // so a touch here means the structure completed before it could fail.
  const completed=withReferenceTouch(failed<0?current:huzi?huziState(base,match,index,start,through,-1,options):base,index,start,horizon);
  if(completed.resolution){
    // Completion ends the story: later retests or returns belong to new moves.
    if(!huzi)return completed;
    const touch=index.lowerBound(completed.resolution.time);
    return {...huziState(base,match,index,start,Math.min(through,touch+1),-1,options),resolution:completed.resolution};
  }
  if(current.status==='invalidated')return current;
  // A gap inside the window blocks later claims until that data is repaired;
  // one after the window cannot change an already finished observation.
  if(gap>=0&&gap<windowEnd)return {...current,dataWarning:GAP_WARNING};
  if(windowEnd<=through){
    const knownAt=index.knownAt(windowEnd-1);
    if(Number.isFinite(knownAt))current={...current,observationEndedAt:knownAt};
  }
  return current;
}

function lineOf(guide:PatternGuide|undefined,index:ClosedRangeIndex):Line|undefined {
  if(!guide)return;
  const [a,b]=guide.points,from=index.lowerBound(a.time),times=index.cols.col('time');let to=index.lowerBound(b.time);
  if(from>=index.closedLength||times[from]!==a.time||![a.value,b.value].every(Number.isFinite))return;
  if(to>=index.closedLength||times[to]!==b.time){
    // A cached guide can project to a later retest. Its line is immutable
    // confirmation geometry; recover the bar scale without inspecting future
    // prices/timestamps when intentionally evaluating an earlier prefix.
    const date=new Date(a.time),nextMonth=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1),target=new Date(b.time);
    const monthly=date.getUTCDate()===1&&date.getUTCHours()===0&&date.getUTCMinutes()===0&&index.knownAt(from)===nextMonth;
    const duration=monthly?(target.getUTCFullYear()-date.getUTCFullYear())*12+target.getUTCMonth()-date.getUTCMonth():(b.time-a.time)/(index.knownAt(from)-a.time);
    if(!Number.isFinite(duration)||!Number.isInteger(duration))return;
    to=from+duration;
  }
  if(from===to)return;
  return {origin:from,value:a.value,slope:(b.value-a.value)/(to-from)};
}

function huziState(base:PatternMatch,original:PatternMatch,index:ClosedRangeIndex,start:number,through:number,failed:number,options:PatternKnowledgeOptions):PatternMatch {
  const breakout=original.events?.find(event=>event.kind==='breakout'&&event.knownAt===original.confirmedAt);
  const times=index.cols.col('time'),close=index.cols.col('close'),low=index.cols.col('low'),high=index.cols.col('high');
  if(!breakout)return {...base,dataWarning:'缺少原始突破事件，无法重建结构生命周期。'};
  const breakIndex=index.lowerBound(breakout.time);
  if(breakIndex>=index.closedLength||times[breakIndex]!==breakout.time)return {...base,stage:'breakout',events:[breakout],dataWarning:'缺少原始突破柱，无法重建结构生命周期。'};
  const bullish=original.direction==='bullish',sign=bullish?1:-1;
  const role=original.id.endsWith(':continuation')?(bullish?'upper':'lower'):original.guides?.some(guide=>guide.role==='neckline')?'neckline':bullish?'upper':'lower';
  const breakLine=lineOf(original.guides?.find(guide=>guide.role===role),index);
  const tolerance=(original.zone.high-original.zone.low)/2,margin=Math.max(tolerance*.25,Math.abs(close[breakIndex])*1e-9);
  const events:PatternEvent[]=[breakout];let stage:PatternStage='breakout',guideEnd=breakIndex;
  const rawWindow=options.retestWindow,retestWindow=typeof rawWindow==='number'&&Number.isFinite(rawWindow)?Math.round(Math.max(1,Math.min(200,rawWindow))):30;
  const upper=lineOf(original.guides?.find(guide=>guide.role==='upper'),index),lower=lineOf(original.guides?.find(guide=>guide.role==='lower'),index);
  const finiteEnvelope=!original.guides?.some(guide=>guide.role==='neckline')&&original.family!=='huzi-channel'&&original.family!=='huzi-flag';
  const apex=finiteEnvelope&&upper&&lower&&upper.slope<lower.slope?breakIndex+(at(upper,breakIndex)-at(lower,breakIndex))/(lower.slope-upper.slope):Infinity;
  const lifecycleEnd=Math.min(breakIndex+retestWindow,finiteEnvelope?Math.ceil(apex)-1:Infinity);
  let departed=bullish?low[breakIndex]>breakout.boundary+tolerance:high[breakIndex]<breakout.boundary-tolerance;
  if(breakLine&&Number.isFinite(tolerance)&&tolerance>=0){
    for(let j=start;j<Math.min(through,lifecycleEnd+1,failed<0?Infinity:failed);j++){
      const boundary=at(breakLine,j),distance=sign*(close[j]-boundary),knownAt=index.knownAt(j);
      if(!Number.isFinite(knownAt))break;
      if(stage!=='failed-breakout'&&distance < -tolerance){
        stage='failed-breakout';guideEnd=j;events.push({kind:'failed-breakout',time:times[j],knownAt,value:close[j],boundary});
      }else if(stage==='breakout'&&departed&&distance>=margin&&(bullish?low[j]<=boundary+tolerance:high[j]>=boundary-tolerance)){
        stage='retest';guideEnd=j;events.push({kind:'retest',time:times[j],knownAt,value:close[j],boundary});
      }
      if(bullish?low[j]>boundary+tolerance:high[j]<boundary-tolerance)departed=true;
    }
  }
  let invalidatedAt:number|undefined;
  if(failed>=0){
    const knownAt=index.knownAt(failed);
    if(Number.isFinite(knownAt)){
      invalidatedAt=knownAt;stage='invalidated';events.push({kind:'invalidation',time:times[failed],knownAt,value:close[failed],boundary:original.invalidation});
    }
  }
  // Guides follow actual breakout/retest/failure events, never a reference
  // price touch, and do not project past a deliberate replay cutoff.
  const guides=original.guides?.map(guide=>{
    if(guide.role==='pole'||guide.role==='curve')return guide;
    const line=lineOf(guide,index);if(!line)return guide;
    if(guide.points[1].time===times[guideEnd])return guide;
    return {...guide,points:[guide.points[0],{...guide.points[1],time:times[guideEnd],value:at(line,guideEnd)}] as PatternGuide['points']};
  });
  return {...base,stage,events,...(guides?{guides}:{}),...(invalidatedAt===undefined?{}:{status:'invalidated',invalidatedAt}),
    ...(!breakLine?{dataWarning:'缺少原始拟合边界；保留已知突破及固定失效检查，回踩状态未知。'}:{})};
}

function withReferenceTouch(match:PatternMatch,index:ClosedRangeIndex,start:number,through:number):PatternMatch {
  if(start>=through||!match.targets.length)return match;
  const targetIndex=match.targets.length-1,target=match.targets[targetIndex],bullish=match.direction==='bullish';
  if(!Number.isFinite(target)||(bullish?target<=match.invalidation:target>=match.invalidation))return match;
  const open=index.cols.col('open')[start];
  if(!Number.isFinite(open)||(bullish?open>=target:open<=target))return match;
  const touch=index.firstCross(bullish?'high':'low',start,through,bullish?'gte':'lte',target);
  if(touch<0)return match;
  // A wick touching risk (including equality) at or before the reference is
  // ambiguous/adverse, even when Huzi's structural stop is close based.
  if(index.firstCross(bullish?'low':'high',start,touch+1,bullish?'lte':'gte',match.invalidation)>=0)return match;
  const time=index.cols.col('time')[touch],knownAt=index.knownAt(touch);
  if(!Number.isFinite(knownAt)||knownAt<=time||match.invalidatedAt!==undefined&&match.invalidatedAt<=knownAt)return match;
  if(match.events?.some(event=>(event.kind==='failed-breakout'||event.kind==='invalidation')&&event.time<=time))return match;
  return {...match,resolution:{kind:'target-reached',time,knownAt,price:target,targetIndex}};
}
