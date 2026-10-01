import type {Pivot} from './pivots';

/**
 * Boundary search: draw a structure the way a person does.
 *
 * The zig-zag based fit takes "the last N alternating pivots" and rejects the whole candidate as soon as one
 * interior swing is off the line. A person instead picks the touches that lie ON each boundary and requires the
 * two lines to CONTAIN the price in between. This module finds exactly that: for the newest confirmed pivot it
 * looks for supporting lines through earlier same-side pivots (every same-side pivot in between stays on or
 * inside the line, within a small slack), pairs an upper and a lower line, counts the touches on them and
 * classifies the shape. Nothing here looks past `horizon`, so a replay at each confirmation is causal.
 */
export interface BoundaryLine {slope:number;intercept:number}
export type EnvelopeFamily='huzi-triangle'|'huzi-wedge'|'huzi-channel';
export interface BoundaryEnvelope {
  pivots:Pivot[];upper:BoundaryLine;lower:BoundaryLine;height:number;ratio:number;
  family:EnvelopeFamily;name:string;upperTouches:number;lowerTouches:number;
}
/** How far a wick may stab through a boundary, as a share of the structure's height, before the line is wrong.
 * People draw through candle bodies and let a long spike poke out; only closes (and wicks beyond this) count. */
export const WICK_ALLOWANCE=.3;
export interface BoundaryContext {
  open:Float64Array;high:Float64Array;low:Float64Array;close:Float64Array;
  /** Last bar index whose data may be used. */horizon:number;
  tolerance:number;radius:number;
  /** 5 for a completed structure, 4 for an early/forming one. */minTouches:number;
  minSpan:number;maxSpan:number;
  /** Supporting lines kept per side before pairing. */keep?:number;
  /** Also require price to stay inside the lines up to this bar (forming structures). */checkTo?:number;
}
export const boundaryAt=(line:BoundaryLine,index:number)=>line.slope*index+line.intercept;

export interface Classified {family:EnvelopeFamily;name:string;ratio:number}
/** Same shape vocabulary as the fitted envelope, with the dead zones between "flat" and "steep" closed. */
export function classifyBoundaries(upper:BoundaryLine,lower:BoundaryLine,first:number,last:number,height:number,tolerance:number):Classified|undefined {
  const span=last-first;
  const w0=boundaryAt(upper,first)-boundaryAt(lower,first),w1=boundaryAt(upper,last)-boundaryAt(lower,last);
  if(!(w0>0&&w1>0&&height>0&&span>0))return;
  const ratio=w1/w0,top=(boundaryAt(upper,last)-boundaryAt(upper,first))/height,bottom=(boundaryAt(lower,last)-boundaryAt(lower,first))/height;
  const flat=Math.max(.06,tolerance*2);
  if(ratio>=.75&&ratio<=1.25&&Math.abs(top-bottom)<=.12)return {ratio,family:'huzi-channel',name:Math.abs(top+bottom)/2<=flat?'水平通道':top+bottom>0?'上升通道':'下降通道'};
  if(ratio<.1||ratio>.88)return;
  if(Math.abs(top)<=flat&&bottom>flat)return {ratio,family:'huzi-triangle',name:'上升三角形'};
  if(Math.abs(bottom)<=flat&&top<-flat)return {ratio,family:'huzi-triangle',name:'下降三角形'};
  if(top<-flat&&bottom>flat)return {ratio,family:'huzi-triangle',name:'对称三角形'};
  if(top>flat&&bottom>top+.06)return {ratio,family:'huzi-wedge',name:'上升楔形'};
  if(bottom<-flat&&top<bottom-.06)return {ratio,family:'huzi-wedge',name:'下降楔形'};
}

interface Support {line:BoundaryLine;touches:Pivot[];first:Pivot}
const KEEP=3;

/** Price range spanned by the given pivots, used to scale the touch slack to the structure's own size. */
function rangeOf(highs:readonly Pivot[],lows:readonly Pivot[],from:number,to:number):number {
  let hi=-Infinity,lo=Infinity;
  for(const p of highs)if(p.index>=from&&p.index<=to&&p.value>hi)hi=p.value;
  for(const p of lows)if(p.index>=from&&p.index<=to&&p.value<lo)lo=p.value;
  return hi>lo?hi-lo:0;
}

/** Least-squares line through pivots; exact through two. */
function fit(points:readonly Pivot[]):BoundaryLine {
  if(points.length===2){const slope=(points[1].value-points[0].value)/(points[1].index-points[0].index);return {slope,intercept:points[0].value-slope*points[0].index};}
  const n=points.length;let mx=0,my=0;for(const p of points){mx+=p.index;my+=p.value;}mx/=n;my/=n;
  let num=0,den=0;for(const p of points){num+=(p.index-mx)*(p.value-my);den+=(p.index-mx)**2;}
  const slope=den>0?num/den:0;return {slope,intercept:my-slope*mx};
}

/** Lines through `end` and an earlier same-side pivot that no in-between same-side pivot crosses.
 * The end-point line is only a seed: the boundary is then refitted through every pivot that lies on it,
 * the way a person nudges a trendline to run through several touches rather than just the first and last. */
function supports(own:readonly Pivot[],end:Pivot,side:1|-1,highs:readonly Pivot[],lows:readonly Pivot[],ctx:BoundaryContext):Support[] {
  const out:Support[]=[],minGap=Math.max(4,ctx.radius*2);
  // `own` is oldest-first; only pivots within the maximum span can start a line.
  let lo=0,hi=own.length;while(lo<hi){const mid=(lo+hi)>>>1;if(own[mid].index<end.index-ctx.maxSpan)lo=mid+1;else hi=mid;}
  for(let k=lo;k<own.length;k++){
    const a=own[k];
    if(a.index>=end.index-minGap)break;
    const range=rangeOf(highs,lows,a.index,end.index);if(!(range>0))continue;
    // A pivot within `slack` of the line is a touch; a wick may stab through it by up to `poke` (2× tolerance).
    const slack=range*ctx.tolerance*1.5,poke=range*ctx.tolerance*2;
    let line=fit([a,end]);
    const collect=(candidate:BoundaryLine):{touches:Pivot[];ok:boolean}=>{
      const touches:Pivot[]=[];
      for(const p of own){
        if(p.index<a.index)continue;
        if(p.index>end.index)break;
        const offset=side*(p.value-boundaryAt(candidate,p.index));// > 0: beyond the line
        if(offset>poke){
          // A spike that stabs through is not a touch, and it does not spoil the line while its body stays inside.
          const body=side>0?Math.max(ctx.open[p.index],ctx.close[p.index]):Math.min(ctx.open[p.index],ctx.close[p.index]);
          if(offset<=range*WICK_ALLOWANCE&&!(side*(body-boundaryAt(candidate,p.index))>poke))continue;
          return {touches,ok:false};
        }
        // Touches on one side must be separate swings, not neighbouring wiggles of the same one.
        if(offset>=-slack&&(!touches.length||p.index-touches.at(-1)!.index>=ctx.radius*2))touches.push(p);
      }
      return {touches,ok:true};
    };
    let result=collect(line);
    if(result.ok&&result.touches.length>=3){
      const refit=fit(result.touches),again=collect(refit);
      if(again.ok&&again.touches.length>=result.touches.length){line=refit;result=again;}
    }
    const touches=result.touches;
    if(!result.ok||touches.length<2||touches[0].index!==a.index||touches.at(-1)!.index!==end.index)continue;
    out.push({line,touches,first:a});
  }
  return out.sort((x,y)=>y.touches.length-x.touches.length||x.first.index-y.first.index).slice(0,ctx.keep??KEEP);
}

/**
 * Envelopes whose latest touch is `end`. `highs` / `lows` are every confirmed pivot so far (raw, oldest first),
 * already including `end`. Returns at most `keep`×`keep` pairs; the caller de-duplicates across replay steps.
 */
export function boundaryEnvelopes(highs:readonly Pivot[],lows:readonly Pivot[],end:Pivot,ctx:BoundaryContext):BoundaryEnvelope[] {
  const side:1|-1=end.kind==='high'?1:-1,own=side===1?highs:lows,other=side===1?lows:highs;
  const otherLast=other.at(-1);
  if(!otherLast||otherLast.index>=end.index||own.length<2||other.length<2)return [];
  const ownLines=supports(own,end,side,highs,lows,ctx),otherLines=supports(other,otherLast,side===1?-1:1,highs,lows,ctx);
    const found:BoundaryEnvelope[]=[];
  for(const mine of ownLines)for(const theirs of otherLines){
    const upperSupport=side===1?mine:theirs,lowerSupport=side===1?theirs:mine;
    const first=Math.min(upperSupport.first.index,lowerSupport.first.index),last=end.index,span=last-first;
    if(span<ctx.minSpan||span>ctx.maxSpan)continue;
    // Both boundaries take shape together: a line that only starts touching the price far into the structure
    // is a different, shorter structure, not the second side of this one.
    if(Math.abs(upperSupport.first.index-lowerSupport.first.index)>span*.4)continue;
    const all=[...upperSupport.touches,...lowerSupport.touches].sort((a,b)=>a.index-b.index||(a.kind==='high'?-1:1));
    if(all.length<ctx.minTouches||all.length>12)continue;
    // Alternating: a structure is bounded from both sides in turn, not two lines touched in separate runs.
    let switches=0;for(let i=1;i<all.length;i++)if(all[i].kind!==all[i-1].kind)switches++;
    if(switches<all.length-2)continue;
    let hi=-Infinity,lo=Infinity;for(const p of all){if(p.value>hi)hi=p.value;if(p.value<lo)lo=p.value;}
    const height=hi-lo;if(!(height>0))continue;
    const upper=upperSupport.line,lower=lowerSupport.line,kind=classifyBoundaries(upper,lower,first,last,height,ctx.tolerance);
    if(!kind)continue;
    // Price must stay inside the lines through the structure (and up to `checkTo` while it is still forming).
    const tol=height*ctx.tolerance,wick=Math.max(tol*2,height*WICK_ALLOWANCE),to=Math.min(ctx.horizon,Math.max(last,ctx.checkTo??last));let inside=true;
    for(let i=first;i<=to;i++){
      const u=boundaryAt(upper,i),l=boundaryAt(lower,i);
      if(u<=l||ctx.close[i]>u+tol||ctx.close[i]<l-tol||ctx.high[i]>u+wick||ctx.low[i]<l-wick){inside=false;break;}
    }
    if(!inside)continue;
    found.push({pivots:all,upper,lower,height,ratio:kind.ratio,family:kind.family,name:kind.name,upperTouches:upperSupport.touches.length,lowerTouches:lowerSupport.touches.length});
  }
  return found;
}
