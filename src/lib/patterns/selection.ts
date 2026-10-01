import type {ParamValues} from '../core/types';
import type {PatternMatch} from './types';
import {EARLY_MIN_BARS,FLAG_POLE_RATIO,MIN_STRUCTURE_BARS} from './huzi-defaults';

export const PATTERN_POOL_LIMIT=1000;
export const DEFAULT_PATTERN_DISPLAY_LIMIT=50;
export const MAX_PATTERN_DISPLAY_LIMIT=200;
export interface PatternTimeWindow {fromTime:number;toTime:number}

/** Hide actually invalidated structures by default. Geometrically resolved
 * observations remain distinct from ongoing setups and unsuccessful patterns. */
export function patternHistoryMode(params:ParamValues):'all'|'active' {
  return params.historyDisplay==='all'?'all':'active';
}

/** Upgrade only legacy defaults. Keep custom limits and every explicitly saved
 * new mode; running this twice is a no-op and does not rewrite indicator inputs.
 * v3: the harmonic ratio tolerance default moved from 0.04 to 0.06; only the
 * untouched legacy default is upgraded, never a user-chosen value. */
export function migratePatternDisplayParams(params:ParamValues,id?:string):ParamValues {
  const legacyDisplay=params.patternDisplayVersion!==3;
  // A classic-pattern layer saved before the scale / boundary-search / extended-structure inputs existed has none of
  // them: the panel would show the new defaults while the detector fell back to "no filter". New layers are created
  // with every default, so a missing `minStructureBars` identifies an old layer, and the fill happens once.
  const legacyHuzi=id==='pattern-huzi'&&params.minStructureBars===undefined;
  // Likewise a harmonic layer saved before the D-point reading aids (MACD divergence, ATR reference, pin bar).
  const legacyHarmonic=id==='pattern-harmonic'&&params.harmonicSignals===undefined;
  if(!legacyDisplay&&!legacyHuzi&&!legacyHarmonic)return params;
  const migrated:ParamValues={...params,patternDisplayVersion:3};
  if(legacyDisplay){
    if(params.patternDisplayVersion!==2){
      migrated.historyDisplay='active';delete migrated.showInvalidated;
      if(params.maxPatterns===12)migrated.maxPatterns=DEFAULT_PATTERN_DISPLAY_LIMIT;
    }
    if(id==='pattern-harmonic'&&params.tolerance===.04)migrated.tolerance=.06;
  }
  if(legacyHuzi){
    const fill=(key:string,value:number|boolean)=>{if(migrated[key]===undefined)migrated[key]=value;};
    fill('minStructureBars',MIN_STRUCTURE_BARS);fill('earlyMinBars',EARLY_MIN_BARS);fill('flagPoleRatio',FLAG_POLE_RATIO);
    fill('boundarySearch',true);fill('largeScales',true);fill('extraStructures',true);
  }
  if(legacyHarmonic){
    const fill=(key:string,value:number|boolean)=>{if(migrated[key]===undefined)migrated[key]=value;};
    fill('harmonicSignals',true);fill('atrPeriod',14);fill('atrStopMultiple',2);fill('requireDivergence',false);
  }
  return migrated;
}

/** Geometry and its first confirmation occupy one continuous range. Later
 * retests/invalidation are separate event intervals: a failure six months later
 * must not make an old structure occupy every intervening empty viewport. */
export function patternIntersectsWindow(pattern:PatternMatch,window:PatternTimeWindow,includeReferences=false):boolean {
  const from=Math.min(window.fromTime,window.toTime),to=Math.max(window.fromTime,window.toTime);
  if(Number.isNaN(from)||Number.isNaN(to))return false;
  const core=[...(pattern.points??[]).map(point=>point.time),pattern.confirmedAt,
    ...(pattern.events??[]).filter(event=>event.kind==='breakout').flatMap(event=>[event.time,event.knownAt])].filter(Number.isFinite);
  const intersects=(start:number,end:number)=>Math.max(start,end)>=from&&Math.min(start,end)<=to;
  if(core.length&&intersects(Math.min(...core),Math.max(...core)))return true;
  if(includeReferences&&pattern.resolution&&intersects(pattern.resolution.time,pattern.resolution.knownAt))return true;
  return (pattern.events??[]).some(event=>Number.isFinite(event.time)&&Number.isFinite(event.knownAt)&&intersects(event.time,event.knownAt));
}

/** Spread a limited drawing budget over elapsed time, not merely array ranks.
 * Rank-only sampling lets a very busy recent month erase sparse older months.
 * Fill unused slots evenly from remaining rows after sampling time targets. */
function sampleDates(matches:PatternMatch[],limit:number):PatternMatch[] {
  if(matches.length<=limit)return matches;
  if(limit===1)return [matches.at(-1)!];
  const chosen=new Set<number>([0,matches.length-1]);
  const first=matches[0].confirmedAt,last=matches.at(-1)!.confirmedAt;
  for(let i=1;i<limit-1;i++){
    const target=first+(last-first)*i/(limit-1);
    let lo=0,hi=matches.length-1;
    while(lo<hi){const mid=(lo+hi)>>>1;if(matches[mid].confirmedAt<target)lo=mid+1;else hi=mid;}
    if(lo>0&&target-matches[lo-1].confirmedAt<matches[lo].confirmedAt-target)lo--;
    chosen.add(lo);
  }
  const needed=limit-chosen.size;
  if(needed>0){
    const remaining=matches.map((_,index)=>index).filter(index=>!chosen.has(index));
    for(let i=0;i<needed;i++)chosen.add(remaining[Math.floor((i+.5)*remaining.length/needed)]);
  }
  return [...chosen].map(index=>matches[index]);
}

/** The limit applies within the optional actual viewport. Display choices never
 * change recognition, confirmation timestamps or the worker's historical pool. */
export function selectPatterns(matches:readonly PatternMatch[],params:ParamValues,window?:PatternTimeWindow):PatternMatch[] {
  const requested=Number(params.maxPatterns??DEFAULT_PATTERN_DISPLAY_LIMIT);
  const limit=Number.isFinite(requested)?Math.max(1,Math.min(MAX_PATTERN_DISPLAY_LIMIT,Math.round(requested))):DEFAULT_PATTERN_DISPLAY_LIMIT;
  const activeOnly=patternHistoryMode(params)==='active';
  const eligible=matches.filter(pattern=>(!activeOnly||pattern.status!=='invalidated')&&(!window||patternIntersectsWindow(pattern,window,params.showTargets===true)))
    .sort((a,b)=>a.confirmedAt-b.confirmedAt||a.id.localeCompare(b.id));
  return sampleDates(eligible,limit).sort((a,b)=>b.confirmedAt-a.confirmedAt||a.id.localeCompare(b.id));
}
