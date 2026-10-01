import type {ColumnView,DerivedSeries} from '../core/types';
import {TIMEFRAMES,type IndicatorInstance} from '../scene/types';
import type {OscillatorDivergence} from './divergence';

export interface IndicatorDivergenceMark {
  divergence:OscillatorDivergence;
  /** Samples where the mounted oscillator actually displays the source values. */
  points:[{time:number;value:number},{time:number;value:number}];
  /** Current column indices, retained with the validated closed projection. */
  indices?:[number,number];
}
export interface DivergenceDensityOptions {maxMarks?:number;selectedId?:string}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
function exactIndex(cols:ColumnView,time:number):number {
  const times=cols.col('time');let lo=0,hi=cols.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(times[mid]<time)lo=mid+1;else hi=mid;}
  return lo<cols.length&&times[lo]===time?lo:-1;
}

/** Project independent evidence belonging to this output, without looking at
 * any price-pattern layer, default indicator parameters, or trade filters. */
export function projectIndicatorDivergences(line:DerivedSeries,target:IndicatorInstance,cols:ColumnView,
  chartTimeframe:string,window?:{fromTime:number;toTime:number}):IndicatorDivergenceMark[] {
  return projectCandidates(line,target,cols,chartTimeframe,window,line.divergences??[]);
}

function projectCandidates(line:DerivedSeries,target:IndicatorInstance,cols:ColumnView,chartTimeframe:string,
  window:{fromTime:number;toTime:number}|undefined,candidates:readonly OscillatorDivergence[],memo?:Map<OscillatorDivergence,IndicatorDivergenceMark|null>):IndicatorDivergenceMark[] {
  if(line.indicatorId!==target.instanceId||target.params.showDivergences===false||!line.divergences?.length)return [];
  const timeframe=target.timeframe==='chart'?chartTimeframe:target.timeframe;
  const sourceMs=TIMEFRAMES[timeframe],chartMs=TIMEFRAMES[chartTimeframe];
  if(!sourceMs||!chartMs||sourceMs<chartMs||sourceMs%chartMs!==0)return [];
  if(line.timeframe!==undefined&&(line.timeframe==='chart'?chartTimeframe:line.timeframe)!==timeframe)return [];
  const n=Math.max(0,Math.min(cols.length,cols.closedLength??cols.length-1)),times=cols.col('time'),higher=sourceMs>chartMs;
  if(!n)return [];
  const knownAt=n<cols.length?times[n]:times[n-1]+chartMs;
  const sample=(anchor:number)=>{
    const from=exactIndex(cols,anchor),time=higher?anchor+sourceMs:anchor,index=exactIndex(cols,time);
    if(from<0||from>=n||index<0||index>=n||!finite(line.values[index]))return;
    if(higher){
      if(anchor%sourceMs!==0||index>=cols.length-1||index-from!==sourceMs/chartMs)return;
      for(let i=from;i<index;i++)if(times[i]!==anchor+(i-from)*chartMs)return;
    }
    return {index,time,value:line.values[index]};
  };
  const seen=new Set<string>(),out:IndicatorDivergenceMark[]=[];
  for(const divergence of candidates){
    if(divergence.indicator!==target.id||divergence.plotIndex!==(line.plotIndex??0)||!finite(divergence.confirmedAt)||divergence.confirmedAt>knownAt)continue;
    const [first,second]=divergence.points;
    if(!first||!second||![first.time,second.time,first.value,second.value,first.price,second.price].every(finite)||first.time>=second.time||second.time>=divergence.confirmedAt)continue;
    const shift=higher?sourceMs:0;
    if(window&&(second.time+shift<window.fromTime||first.time+shift>window.toTime))continue;
    const key=`${divergence.plotIndex}:${divergence.direction}:${first.time}:${second.time}`;
    if(seen.has(key))continue;
    if(memo?.has(divergence)){const mark=memo.get(divergence);if(mark){seen.add(key);out.push(mark);}continue;}
    memo?.set(divergence,null);
    const a=sample(first.time),b=sample(second.time);
    if(!a||!b||a.index>=b.index||b.time>divergence.confirmedAt)continue;
    const sign=divergence.direction==='bullish'?1:-1;
    if(sign*(second.price-first.price)>=0||sign*(b.value-a.value)<=0)continue;
    let intact=true;for(let i=a.index;i<=b.index;i++)if(!finite(line.values[i])){intact=false;break;}
    if(!intact)continue;
    seen.add(key);
    const mark:IndicatorDivergenceMark={divergence,points:[{time:a.time,value:a.value},{time:b.time,value:b.value}],indices:[a.index,b.index]};
    memo?.set(divergence,mark);out.push(mark);
  }
  return out;
}


interface TimeEntry {start:number;end:number;order:number;divergence:OscillatorDivergence}
/** Immutable archive interval index. Max-end pruning retains lines whose first
 * anchor is far before the viewport and whose second anchor is after it. */
class DivergenceTimeIndex {
  private entries:TimeEntry[];
  private maximum:Float64Array;
  private bullish:Int32Array;
  private bearish:Int32Array;
  private ids=new Map<string,number>();
  private leaves=1;
  constructor(archive:readonly OscillatorDivergence[]){
    this.entries=archive.flatMap((divergence,order)=>{
      const start=divergence.points[0]?.time,end=divergence.points[1]?.time;
      return finite(start)&&finite(end)&&start<end?[{start,end,order,divergence}]:[];
    }).sort((a,b)=>a.start-b.start||a.order-b.order);
    while(this.leaves<this.entries.length)this.leaves*=2;
    this.maximum=new Float64Array(this.leaves*2).fill(-Infinity);
    this.bullish=new Int32Array(this.leaves*2).fill(-1);this.bearish=new Int32Array(this.leaves*2).fill(-1);
    this.entries.forEach((entry,i)=>{this.maximum[this.leaves+i]=entry.end;this.ids.set(entry.divergence.id,i);
      (entry.divergence.direction==='bullish'?this.bullish:this.bearish)[this.leaves+i]=i;});
    for(let node=this.leaves-1;node>0;node--){this.maximum[node]=Math.max(this.maximum[node*2],this.maximum[node*2+1]);
      this.bullish[node]=this.latest(this.bullish[node*2],this.bullish[node*2+1]);this.bearish[node]=this.latest(this.bearish[node*2],this.bearish[node*2+1]);}
  }
  private latest(a:number,b:number):number {
    if(a<0)return b;if(b<0)return a;
    const first=this.entries[a],second=this.entries[b];
    return second.end>first.end||second.end===first.end&&second.order>first.order?b:a;
  }
  private bound(time:number,inclusive=false):number {
    let a=0,b=this.entries.length;while(a<b){const mid=(a+b)>>>1;if(this.entries[mid].start<time||inclusive&&this.entries[mid].start===time)a=mid+1;else b=mid;}return a;
  }
  /** One actual recent pair per direction and horizontal time bucket. Entire
   * archive geometry stays available; only overview display density changes.
   * Cached subtree representatives make queries O(buckets × log archive),
   * rather than collecting every historical pair before reducing the result. */
  queryDensity(from:number,to:number,maxMarks:number,selectedId?:string):OscillatorDivergence[] {
    if(this.entries.length<=maxMarks||!(to>from))return this.query(from,to);
    const found=new Set<number>(),buckets=Math.max(1,Math.floor(maxMarks/2));
    const representative=(left:number,right:number,tree:Int32Array)=>{
      const visit=(node:number,start:number,end:number):number=>{
        const latest=tree[node];if(start>=right||end<=left||latest<0||this.entries[latest].end<from)return -1;
        if(start>=left&&end<=right)return latest;
        const mid=(start+end)>>>1;return this.latest(visit(node*2,start,mid),visit(node*2+1,mid,end));
      };
      return left<right?visit(1,0,this.leaves):-1;
    };
    const add=(left:number,right:number)=>{for(const tree of [this.bullish,this.bearish]){const index=representative(left,right,tree);if(index>=0)found.add(index);}};
    // A long line may cross the viewport while both anchors lie outside it.
    // Keep a representative of that crossing evidence as well as local pairs.
    add(0,this.bound(from));
    for(let i=0;i<buckets;i++){
      const left=this.bound(from+(to-from)*i/buckets),right=i===buckets-1?this.bound(to,true):this.bound(from+(to-from)*(i+1)/buckets);
      add(left,right);
    }
    const selected=selectedId===undefined?undefined:this.ids.get(selectedId);
    if(selected!==undefined&&this.entries[selected].start<=to&&this.entries[selected].end>=from)found.add(selected);
    return [...found].map(index=>this.entries[index]).sort((a,b)=>a.order-b.order).map(entry=>entry.divergence);
  }
  query(from:number,to:number):OscillatorDivergence[]{
    const found:TimeEntry[]=[];
    const visit=(node:number,start:number,end:number)=>{
      if(start>=this.entries.length||this.maximum[node]<from||this.entries[start].start>to)return;
      if(end-start===1){found.push(this.entries[start]);return;}
      const mid=(start+end)>>>1;visit(node*2,start,mid);visit(node*2+1,mid,end);
    };
    visit(1,0,this.leaves);
    return found.sort((a,b)=>a.order-b.order).map(entry=>entry.divergence);
  }
}
interface ProjectionState {
  archive:OscillatorDivergence[];index:DivergenceTimeIndex;
  values:Float64Array;times:Float64Array;revision:number;signature:string;
  memo:Map<OscillatorDivergence,IndicatorDivergenceMark|null>;
  windowKey:string;marks:IndicatorDivergenceMark[];
}
/** One cache per chart controller. Callers must advance revision whenever
 * mutable values/timestamps are patched, including historical repairs. The
 * archive follows the runtime contract: replace its array for metadata edits.
 * A pan reuses sample validation; a data revision revalidates mutable evidence. */
export class IndicatorDivergenceProjectionCache {
  private states=new WeakMap<DerivedSeries,ProjectionState>();
  clear():void {this.states=new WeakMap();}
  project(line:DerivedSeries,target:IndicatorInstance,cols:ColumnView,chartTimeframe:string,
    window?:{fromTime:number;toTime:number},revision=0,density:DivergenceDensityOptions={}):IndicatorDivergenceMark[]{
    const archive=line.divergences;
    if(!archive?.length||line.indicatorId!==target.instanceId||target.params.showDivergences===false)return [];
    const times=cols.col('time'),n=Math.max(0,Math.min(cols.length,cols.closedLength??cols.length-1));
    const signature=[target.id,target.instanceId,target.timeframe,line.timeframe,line.plotIndex??0,chartTimeframe,
      cols.length,n,times[0],times[n-1],times[n]].join(':');
    let state=this.states.get(line);
    if(!state||state.archive!==archive){
      state={archive,index:new DivergenceTimeIndex(archive),values:line.values,times,revision,signature,memo:new Map(),windowKey:'',marks:[]};
      this.states.set(line,state);
    }else if(state.revision!==revision||state.values!==line.values||state.times.buffer!==times.buffer||state.times.byteOffset!==times.byteOffset||state.signature!==signature){
      state.values=line.values;state.times=times;state.revision=revision;state.signature=signature;state.memo.clear();state.windowKey='';
    }
    const maxMarks=typeof density.maxMarks==='number'&&Number.isFinite(density.maxMarks)?Math.max(2,Math.floor(density.maxMarks)):undefined;
    const windowKey=(window?`${window.fromTime}:${window.toTime}`:'all')+`:${maxMarks??'full'}:${density.selectedId??''}`;
    if(state.windowKey===windowKey)return state.marks;
    const sourceMs=TIMEFRAMES[target.timeframe==='chart'?chartTimeframe:target.timeframe],chartMs=TIMEFRAMES[chartTimeframe],shift=sourceMs>chartMs?sourceMs:0;
    const candidates=window?maxMarks===undefined?state.index.query(window.fromTime-shift,window.toTime-shift)
      :state.index.queryDensity(window.fromTime-shift,window.toTime-shift,maxMarks,density.selectedId):archive;
    state.marks=projectCandidates(line,target,cols,chartTimeframe,window,candidates,state.memo);state.windowKey=windowKey;
    return state.marks;
  }
}
