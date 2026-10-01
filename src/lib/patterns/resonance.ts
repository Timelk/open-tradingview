import type {PatternMatch} from './types';
import {orderSignalTags,type SignalTag} from './signal-tags';

/**
 * Cross-layer resonance for harmonic matches. Practitioners describe a setup as "8h Shark 1.13 + 4h Crab 1.618",
 * or "AB=CD on 2h, symmetrical triangle at the end, entered on the 15-minute triangle". Every pattern layer is
 * computed on its own timeframe, so the join is made here, on the full match pools of the current symbol's layers:
 *
 * - **Multi-timeframe** (`multi-tf`): a harmonic on another timeframe, same direction, whose PRZ overlaps this PRZ
 *   by at least {@link PRZ_OVERLAP_SHARE} of the narrower one, and whose D lies within {@link MULTI_TF_D_BARS} bars of
 *   the larger of the two timeframes from this D.
 * - **Terminal structure** (`terminal`, `lower-tf`): a Huzi triangle / wedge / channel / flag on the same or a smaller
 *   timeframe that starts between {@link TERMINAL_BEFORE_BARS} harmonic bars before D and {@link TERMINAL_AFTER_BARS}
 *   after it and resolves in the direction the harmonic expects (a bullish D followed by a triangle that breaks up).
 *   A larger timeframe cannot be "the end" of a smaller one's leg, so it never counts.
 *
 * The windows are engineering choices, not the practitioners' numbers (they give none). The function is pure:
 * no randomness, no clock, inputs untouched. Causality: `asOf` drops every match that was not yet confirmed at that
 * time, and each tag records `knownAt`, the first time both sides of it were known, so a replayed or historical view
 * can hide a tag until then.
 */
export interface ResonanceLayer {
  instanceId:string;
  /** `pattern-harmonic`, `pattern-huzi`; other definitions (HSCP included) are ignored. */
  definitionId:string;
  timeframeMs:number;
  /** Shown in tags, e.g. `4h`. */
  timeframeLabel:string;
  /** The layer's full pool, not just what the panel displays. */
  matches:readonly PatternMatch[];
}
export interface ResonanceTag extends SignalTag {
  kind:'multi-tf'|'terminal'|'lower-tf';
  target:{instanceId:string;patternId:string};
  knownAt:number;
}

export const TERMINAL_BEFORE_BARS=2;
export const TERMINAL_AFTER_BARS=12;
export const PRZ_OVERLAP_SHARE=.5;
export const MULTI_TF_D_BARS=3;
export const MAX_RESONANCE_TAGS=4;
export const resonanceKey=(instanceId:string,patternId:string)=>`${instanceId}:${patternId}`;

const STRUCTURES=new Set(['huzi-triangle','huzi-wedge','huzi-channel','huzi-flag']);
/** HSCP wraps Huzi / harmonic geometry under its own id; it is a filter, not a fresh structure. */
const isHarmonic=(match:PatternMatch)=>!match.family.startsWith('huzi')&&!match.id.startsWith('hscp:')&&match.points.length>=3;

interface Item {match:PatternMatch;layer:ResonanceLayer;at:number}
const byTime=(a:Item,b:Item)=>a.at-b.at||a.match.id.localeCompare(b.match.id);
function lowerBound(items:readonly Item[],time:number):number {
  let lo=0,hi=items.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(items[mid].at<time)lo=mid+1;else hi=mid;}
  return lo;
}
const barsText=(value:number)=>String(Math.round(value*10)/10);

/** Share of the narrower PRZ that the two zones have in common; a zero-width PRZ counts as fully shared when it lies
 * inside the other one. */
function overlapShare(a:{low:number;high:number},b:{low:number;high:number}):number {
  if(![a.low,a.high,b.low,b.high].every(Number.isFinite))return 0;
  const overlap=Math.min(a.high,b.high)-Math.max(a.low,b.low);
  if(overlap<0)return 0;
  const narrow=Math.min(a.high-a.low,b.high-b.low);
  return narrow>0?Math.min(1,overlap/narrow):1;
}

export function computeResonance(layers:readonly ResonanceLayer[],options:{asOf?:number}={}):Map<string,ResonanceTag[]> {
  const asOf=options.asOf??Infinity,result=new Map<string,ResonanceTag[]>();
  const known=(match:PatternMatch)=>Number.isFinite(match.confirmedAt)&&match.confirmedAt<=asOf;
  const harmonic:Array<{layer:ResonanceLayer;items:Item[]}>=[],huzi:Array<{layer:ResonanceLayer;items:Item[]}>=[];
  for(const layer of layers){
    if(!(layer.timeframeMs>0))continue;
    if(layer.definitionId==='pattern-harmonic'){
      const items=layer.matches.filter(m=>isHarmonic(m)&&known(m)).map(match=>({match,layer,at:match.points.at(-1)!.time})).filter(item=>Number.isFinite(item.at)).sort(byTime);
      harmonic.push({layer,items});
    }else if(layer.definitionId==='pattern-huzi'){
      const items=layer.matches.filter(m=>STRUCTURES.has(m.family)&&known(m)).map(match=>({match,layer,at:match.points[0]?.time??NaN})).filter(item=>Number.isFinite(item.at)).sort(byTime);
      huzi.push({layer,items});
    }
  }
  for(const {layer,items} of harmonic){
    const own=layer.timeframeMs;
    for(const item of items){
      const {match,at:d}=item,multi:Array<ResonanceTag&{rank:number}>=[],structure:Array<ResonanceTag&{rank:number}>=[];
      for(const other of harmonic){
        if(other.layer.instanceId===layer.instanceId||other.layer.timeframeMs===own)continue;
        const larger=Math.max(own,other.layer.timeframeMs),window=MULTI_TF_D_BARS*larger;
        const best=new Map<string,{item:Item;share:number;gap:number}>();
        for(let i=lowerBound(other.items,d-window);i<other.items.length&&other.items[i].at<=d+window;i++){
          const candidate=other.items[i];
          if(candidate.match.direction!==match.direction)continue;
          const share=overlapShare(match.zone,candidate.match.zone);
          if(share<PRZ_OVERLAP_SHARE)continue;
          const gap=Math.abs(candidate.at-d),held=best.get(candidate.match.family);
          if(!held||share>held.share+1e-9||Math.abs(share-held.share)<=1e-9&&gap<held.gap)best.set(candidate.match.family,{item:candidate,share,gap});
        }
        for(const {item:candidate,share,gap} of best.values()){
          const label=`${other.layer.timeframeLabel} ${candidate.match.family}`;
          const largerLabel=larger===own?layer.timeframeLabel:other.layer.timeframeLabel;
          multi.push({kind:'multi-tf',label,tone:'good',rank:share*1e6-gap/larger,
            detail:`${other.layer.timeframeLabel} 周期的 ${candidate.match.family} 同向完成，PRZ 与本形态重叠 ${Math.round(share*100)}%，D 点相隔 ${barsText(gap/larger)} 根 ${largerLabel} K 线。`,
            target:{instanceId:other.layer.instanceId,patternId:candidate.match.id},knownAt:Math.max(match.confirmedAt,candidate.match.confirmedAt)});
        }
      }
      for(const other of huzi){
        // The structure sits on the harmonic's own timeframe or a smaller one.
        if(other.layer.timeframeMs>own)continue;
        const from=d-TERMINAL_BEFORE_BARS*own,to=d+TERMINAL_AFTER_BARS*own;
        let best:Item|undefined;
        for(let i=lowerBound(other.items,from);i<other.items.length&&other.items[i].at<=to;i++){
          const candidate=other.items[i];
          if(candidate.match.direction!==match.direction)continue;
          // Closest start to D; earlier confirmation breaks a tie so the pick never depends on input order.
          if(!best||Math.abs(candidate.at-d)<Math.abs(best.at-d)||Math.abs(candidate.at-d)===Math.abs(best.at-d)&&candidate.match.confirmedAt<best.match.confirmedAt)best=candidate;
        }
        if(!best)continue;
        const same=other.layer.timeframeMs===own,bars=barsText(Math.abs(best.at-d)/own),before=best.at<d;
        const name=best.match.name,tf=other.layer.timeframeLabel;
        const detail=same
          ?before?`${name} 起于 D 点前 ${bars} 根 ${tf} K 线，方向与谐波一致：末端结构。`:`${name} 起于 D 点后 ${bars} 根 ${tf} K 线，方向与谐波一致：末端结构。`
          :before?`${tf} 周期的 ${name} 起于 D 点前 ${bars} 根 ${layer.timeframeLabel} K 线，方向与谐波一致：更小周期切入参考。`
            :`${tf} 周期的 ${name} 起于 D 点后 ${bars} 根 ${layer.timeframeLabel} K 线，方向与谐波一致：更小周期切入参考。`;
        structure.push({kind:same?'terminal':'lower-tf',label:same?`末端 ${name}`:`${tf} ${name} 切入`,tone:'neutral',detail,rank:-Math.abs(best.at-d)/own,
          target:{instanceId:other.layer.instanceId,patternId:best.match.id},knownAt:Math.max(match.confirmedAt,best.match.confirmedAt)});
      }
      if(!multi.length&&!structure.length)continue;
      // Other timeframes first (best overlap first), then the structure at the end (same timeframe before smaller,
      // nearer before farther).
      multi.sort((a,b)=>b.rank-a.rank||a.label.localeCompare(b.label));
      structure.sort((a,b)=>Number(a.kind==='lower-tf')-Number(b.kind==='lower-tf')||b.rank-a.rank||a.label.localeCompare(b.label));
      const tags=orderSignalTags([...multi,...structure]).slice(0,MAX_RESONANCE_TAGS).map(({rank:_rank,...tag})=>tag as ResonanceTag);
      result.set(resonanceKey(layer.instanceId,match.id),tags);
    }
  }
  return result;
}
