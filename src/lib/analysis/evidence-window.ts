import type {ColumnView} from '../core/types';
export const MAX_EVIDENCE_BARS=10000,EVIDENCE_TILE_BARS=2048;
export interface EvidenceWindow {key:string;start:number;end:number;coreStart:number;coreEnd:number}
export interface EvidencePlan {windows:EvidenceWindow[];knowledgeEnd:number;mode:'full'|'tiles';requestedBars:number;truncated:boolean}
/** Count covered input candles once even where neighboring evidence overlaps. */
export function evidenceBarCount(windows:readonly EvidenceWindow[]):number {
  let end=0,total=0;for(const window of [...windows].sort((a,b)=>a.start-b.start)){total+=Math.max(0,window.end-Math.max(end,window.start));end=Math.max(end,window.end);}return total;
}
/** The viewport is a spatial interest region, never an as-of/knowledge cursor.
 * Small loaded datasets have one fixed evidence window; large datasets use
 * deterministic overlapping tiles, independent of pixel scale or prefetch span. */
export function planEvidenceWindows(cols:ColumnView,closedLength:number,interest=cols.patternWindow,options:{rightContext?:number;maxTiles?:number}={}):EvidencePlan {
  const n=Math.max(0,Math.min(cols.length,Math.floor(closedLength))),times=cols.col('time');
  if(!n)return {windows:[],knowledgeEnd:0,mode:'full',requestedBars:0,truncated:false};
  if(n<=MAX_EVIDENCE_BARS)return {windows:[{key:`full:${times[0]}:${n}`,start:0,end:n,coreStart:0,coreEnd:n}],knowledgeEnd:n,mode:'full',requestedBars:n,truncated:false};
  const bound=(time:number,inclusive=false)=>{let lo=0,hi=n;while(lo<hi){const mid=(lo+hi)>>>1;if(times[mid]<time||inclusive&&times[mid]===time)lo=mid+1;else hi=mid;}return lo;};
  const right=Math.max(0,Math.min(4000,Math.round(options.rightContext??64))),left=MAX_EVIDENCE_BARS-EVIDENCE_TILE_BARS-right;
  const a=interest?bound(Math.min(interest.fromTime,interest.toTime)):Math.max(0,n-EVIDENCE_TILE_BARS),b=interest?bound(Math.max(interest.fromTime,interest.toTime),true):n;
  // A structure overlapping the viewport may only be confirmed later. Include
  // nearby owner tiles, still bounded by actual known data and detector depth.
  const first=Math.max(0,Math.floor(Math.min(a,n-1)/EVIDENCE_TILE_BARS)-1),last=Math.min(Math.ceil(n/EVIDENCE_TILE_BARS)-1,Math.floor((Math.max(a,b-1)+left)/EVIDENCE_TILE_BARS));
  const maxTiles=Math.max(1,Math.min(16,Math.round(options.maxTiles??8))),count=last-first+1,chosen:Array<number>=[];
  for(let tile=first;tile<=last&&chosen.length<maxTiles;tile++)chosen.push(tile);
  const windows=chosen.map(tile=>{const coreStart=tile*EVIDENCE_TILE_BARS,coreEnd=Math.min(n,coreStart+EVIDENCE_TILE_BARS),start=Math.max(0,coreStart-left),end=Math.min(n,coreEnd+right);return {key:`tile:${times[coreStart]}:${times[start]}:${end-start}`,start,end,coreStart,coreEnd};});
  return {windows,knowledgeEnd:n,mode:'tiles',requestedBars:Math.max(0,b-a),truncated:count>chosen.length};
}
/** Preserve the actual next timestamp for detector availability; explicit
 * closedLength prevents it being consumed as future price evidence. */
export function evidenceView(cols:ColumnView,window:EvidenceWindow):ColumnView {
  const tail=Math.min(cols.length,window.end+1),start=window.start;
  return {length:tail-start,closedLength:window.end-start,intervalMs:cols.intervalMs,col:name=>cols.col(name).subarray(start,tail),flow:name=>cols.flow?.(name)?.subarray(start,tail)};
}
