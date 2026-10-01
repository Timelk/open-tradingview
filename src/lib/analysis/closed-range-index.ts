import type {ColumnView} from '../core/types';
export type RangeField='open'|'high'|'low'|'close';
export type RangeComparison='gt'|'gte'|'lt'|'lte';
const BLOCK=256,FIELDS:RangeField[]=['open','high','low','close'];
const monthAfter=(time:number)=>{const d=new Date(time);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);};
const monthStart=(time:number)=>{const d=new Date(time);return d.getUTCDate()===1&&d.getUTCHours()===0&&d.getUTCMinutes()===0&&d.getUTCSeconds()===0&&d.getUTCMilliseconds()===0;};
/** A bounded block index over known candles. Construction scans once, while
 * incremental closes update only dirty blocks. Queries never line-scan history. */
export class ClosedRangeIndex {
  cols:ColumnView;closedLength=0;
  private size=1;private minimum:Float64Array[]=[];private maximum:Float64Array[]=[];private invalid=new Uint32Array(2);
  private buffer:ArrayBufferLike|undefined;private firstTime=NaN;private cadence=60000;private calendar=false;
  constructor(cols:ColumnView,closedLength:number){this.cols=cols;this.update(cols,closedLength,0);}
  update(cols:ColumnView,closedLength:number,dirtyFrom:number){
    const old=this.closedLength,n=Math.max(0,Math.min(cols.length,Math.floor(closedLength))),time=cols.col('time'),blocks=Math.ceil(n/BLOCK);
    const reset=this.buffer!==time.buffer||this.firstTime!==time[0]||!this.minimum.length;let size=1;while(size<blocks)size*=2;
    this.cols=cols;this.closedLength=n;this.buffer=time.buffer;this.firstTime=time[0];
    this.calendar=monthStart(time[0])&&(cols.intervalMs?cols.intervalMs>=25*86400000:n>1&&monthAfter(time[0])===time[1]);
    this.cadence=cols.intervalMs&&cols.intervalMs>0?cols.intervalMs:n>1&&time[1]>time[0]?time[1]-time[0]:60000;
    if(size!==this.size||reset){this.size=size;this.minimum=FIELDS.map(()=>new Float64Array(size*2).fill(Infinity));this.maximum=FIELDS.map(()=>new Float64Array(size*2).fill(-Infinity));this.invalid=new Uint32Array(size*2);dirtyFrom=0;}
    const first=Math.max(0,Math.floor(Math.min(dirtyFrom,old,n)/BLOCK)),last=Math.max(blocks,Math.ceil(old/BLOCK));
    for(let block=first;block<Math.min(last,this.size);block++){
      const leaf=this.size+block,start=block*BLOCK,end=Math.min(n,start+BLOCK);
      for(let f=0;f<FIELDS.length;f++){let min=Infinity,max=-Infinity;const values=cols.col(FIELDS[f]);for(let i=start;i<end;i++){const v=values[i];if(Number.isFinite(v)){min=Math.min(min,v);max=Math.max(max,v);}}this.minimum[f][leaf]=min;this.maximum[f][leaf]=max;}
      let invalid=0;for(let i=start;i<end;i++)if(!this.valid(i))invalid++;this.invalid[leaf]=invalid;
      for(let parent=leaf>>1;parent;parent>>=1){for(let f=0;f<FIELDS.length;f++){this.minimum[f][parent]=Math.min(this.minimum[f][parent*2],this.minimum[f][parent*2+1]);this.maximum[f][parent]=Math.max(this.maximum[f][parent*2],this.maximum[f][parent*2+1]);}this.invalid[parent]=this.invalid[parent*2]+this.invalid[parent*2+1];}
    }
  }
  lowerBound(time:number){let lo=0,hi=this.closedLength;const times=this.cols.col('time');while(lo<hi){const mid=(lo+hi)>>>1;if(times[mid]<time)lo=mid+1;else hi=mid;}return lo;}
  knownAt(index:number){if(index<0||index>=this.closedLength)return NaN;const time=this.cols.col('time')[index];return this.calendar?monthAfter(time):time+this.cadence;}
  private valid(i:number){
    const t=this.cols.col('time'),o=this.cols.col('open')[i],h=this.cols.col('high')[i],l=this.cols.col('low')[i],c=this.cols.col('close')[i];
    return [t[i],o,h,l,c].every(Number.isFinite)&&l<=Math.min(o,c)&&h>=Math.max(o,c)&&l<=h&&(!i||(this.calendar?monthAfter(t[i-1])===t[i]:t[i]-t[i-1]===this.cadence));
  }
  private first(from:number,to:number,possible:(node:number)=>boolean,match:(index:number)=>boolean):number {
    from=Math.max(0,Math.floor(from));to=Math.min(this.closedLength,Math.ceil(to));if(to<=from)return -1;
    const left=Math.floor(from/BLOCK),right=Math.ceil(to/BLOCK);
    const find=(node:number,start:number,end:number):number=>{
      if(end<=left||start>=right||!possible(node))return -1;
      if(end-start===1){for(let i=Math.max(from,start*BLOCK);i<Math.min(to,end*BLOCK);i++)if(match(i))return i;return -1;}
      const mid=(start+end)>>>1,a=find(node*2,start,mid);return a<0?find(node*2+1,mid,end):a;
    };
    return find(1,0,this.size);
  }
  firstCross(field:RangeField,from:number,to:number,comparison:RangeComparison,level:number):number {
    if(!Number.isFinite(level))return -1;const f=FIELDS.indexOf(field),above=comparison==='gt'||comparison==='gte',inclusive=comparison==='gte'||comparison==='lte';
    const accepts=(value:number)=>Number.isFinite(value)&&(above?inclusive?value>=level:value>level:inclusive?value<=level:value<level);
    const tree=above?this.maximum[f]:this.minimum[f],values=this.cols.col(field);
    return this.first(from,to,node=>accepts(tree[node]),index=>accepts(values[index]));
  }
  firstInvalid(from:number,to:number):number{return this.first(from,to,node=>this.invalid[node]>0,index=>!this.valid(index));}
}
