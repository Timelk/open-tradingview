import type {Pivot} from './pivots';
import type {Setup} from './huzi';
import {fitQuadratic,type PriceColumns,type Quadratic} from './huzi-fit';

/**
 * Channel acceleration ("通道加速"): a rally (or fall) whose pullback lows (highs) ride a curve that keeps getting
 * steeper, i.e. a parabolic / curved trendline.
 *
 * Definition provenance — inferred, not quoted. The reference author's term appears in four case labels
 * ("W底回踩 通道加速", "三角收敛 通道加速", "W 回踩 通道加速", "楔形 通道 上边线压制 通道加速") and in one chart: a small
 * ascending triangle riding a pink curve that steepens to the right. No public definition of the term was found.
 * The reading used here is the usual parabolic-curve / curved-trendline idea (an accelerating trend: the steeper the
 * curve, the higher the risk of a swift return to it; see the LuxAlgo trendline entry and the fan principle):
 *
 *  1. 4–7 same-side pivots (lows for a rise) that are strictly higher one after another;
 *  2. a least-squares parabola through them that opens the right way, rises at the first touch and is at least
 *     {@link ACCEL_STEEPENING}× as steep at the last touch (it really accelerates, it is not a bowl or a line);
 *  3. every touch within `tolerance × structure height` of the parabola, and the parabola clearly better than the
 *     best straight line (otherwise this is an ordinary rising channel);
 *  4. price never closes through the curve between the first and the last touch (wicks: twice the allowance);
 *  5. confirmation: a close through the highest (lowest) price since the first touch — the move keeps going — while
 *     the close stays above the curve. After the last touch the curve is continued by its tangent: it is a fixed
 *     line that cannot be re-fitted with later data. Losing it before the breakout abandons the structure; after the
 *     breakout, closing under the curve's value at the breakout candle invalidates it.
 *
 * The numbers are engineering thresholds, not the author's. The curve is a geometric fit, not his drawing.
 * Everything is causal: nothing past `ctx.horizon` is read.
 */
export const ACCEL_MIN_TOUCHES=4;
export const ACCEL_MAX_TOUCHES=7;
/** Slope at the last touch over slope at the first touch, on the fitted parabola. */
export const ACCEL_STEEPENING=1.8;
/** The best straight line must miss by at least this multiple of the parabola's own miss (or by more than the tolerance). */
export const ACCEL_LINE_ADVANTAGE=1.6;
/** The curve must climb at least this share of the structure's height (pullbacks may not dwarf the advance). */
export const ACCEL_MIN_RISE=.5;
/** The first touch must not sit at the curve's bottom: its slope has to be this share of the chord's slope. */
export const ACCEL_START_SLOPE=.1;

export const accelMessages:Record<string,string>={
  '通道加速 · 上行':'Channel acceleration · rising','通道加速 · 下行':'Channel acceleration · falling',
  '末 / 首触点曲线斜率比':'Curve slope at last / first touch','曲线最大残差 / 结构高度':'Largest curve miss / structure height',
  '曲线触点数':'Curve touches','曲线上升 / 结构高度':'Curve advance / structure height',
  '{0} 个低点落在一条越来越陡的抛物线上，末 / 首触点斜率比 {1}。':'{0} lows lie on a steepening parabola; the last / first touch slope ratio is {1}. ',
  '{0} 个高点落在一条越来越陡的下行抛物线上，末 / 首触点斜率比 {1}。':'{0} highs lie on a steepening falling parabola; the last / first touch slope ratio is {1}. ',
  '通道加速为依图与案例标签的推断定义，曲线是几何拟合而非原作者的画线；最后触点之后按切线延伸，收盘越过后放弃此结构，突破位取触点以来的最高价（下行取最低价）。':
    'Channel acceleration is an inferred definition based on the reference chart and case labels; the curve is a geometric fit, not the author\'s drawing. After the last touch it is continued by its tangent and the structure is abandoned once a close crosses it; the breakout level is the highest price since the first touch (the lowest for a fall). ',
};

export interface AccelContext extends PriceColumns {
  /** Last bar index whose data may be used (causal replay at each pivot confirmation). */horizon:number;
  tolerance:number;radius:number;minSpan:number;maxSpan:number;
}

interface Candidate {
  touches:Pivot[];quad:Quadratic;s0:number;s1:number;residual:number;height:number;rise:number;level:number;
}

/** Same-side pivots ending at `end`, walking back and keeping each one that is clearly lower (in the mirrored sense)
 * than the one after it. A pivot that is not lower lies above the later touch, so above any rising curve through it. */
function chainOf(own:readonly Pivot[],end:Pivot,sgn:1|-1,minGap:number,maxSpan:number):Pivot[] {
  const chain=[end];
  for(let j=own.length-2;j>=0&&chain.length<ACCEL_MAX_TOUCHES;j--){
    const p=own[j],next=chain[0];
    if(end.index-p.index>maxSpan)break;
    if(sgn*(next.value-p.value)>0&&next.index-p.index>=minGap)chain.unshift(p);
  }
  return chain;
}

/** Largest miss of the least-squares straight line through the points. */
function lineMiss(xs:readonly number[],ys:readonly number[]):number {
  const n=xs.length;let mx=0,my=0;for(let i=0;i<n;i++){mx+=xs[i];my+=ys[i];}mx/=n;my/=n;
  let num=0,den=0;for(let i=0;i<n;i++){num+=(xs[i]-mx)*(ys[i]-my);den+=(xs[i]-mx)**2;}
  const slope=den>0?num/den:0;let miss=0;
  for(let i=0;i<n;i++)miss=Math.max(miss,Math.abs(ys[i]-(my+slope*(xs[i]-mx))));
  return miss;
}

function evaluate(touches:readonly Pivot[],sgn:1|-1,ctx:AccelContext):Candidate|undefined {
  const k=touches.length,first=touches[0],end=touches[k-1],span=end.index-first.index;
  if(span<ctx.minSpan||span>ctx.maxSpan)return;
  const xs=touches.map(p=>p.index),ys=touches.map(p=>sgn*p.value);
  // Cheap screen on the segment slopes before any fitting: an accelerating rise gets steeper towards the end.
  const seg:number[]=[];for(let i=1;i<k;i++)seg.push((ys[i]-ys[i-1])/(xs[i]-xs[i-1]));
  if(seg[k-2]<seg[0]*1.2)return;
  let flatter=0;for(let i=1;i<seg.length;i++)if(seg[i]<seg[i-1]*.8)flatter++;
  if(flatter>(k===4?0:1))return;
  const quad=fitQuadratic(xs,ys);
  if(!quad||!(quad.a>0))return;
  const s0=quad.slopeAt(first.index),s1=quad.slopeAt(end.index),chord=(ys[k-1]-ys[0])/span;
  if(!(s0>0)||!(s1>=ACCEL_STEEPENING*s0)||!(s0>=ACCEL_START_SLOPE*chord))return;
  // Structure height: the highest (lowest) price since the first touch over the first touch.
  const high=sgn>0?ctx.high:ctx.low,to=Math.min(end.index,ctx.horizon);
  let extreme=-Infinity,level=NaN;
  for(let i=first.index;i<=to;i++){
    const v=sgn*high[i];
    if(!Number.isFinite(v)||!Number.isFinite(ctx.close[i])||!Number.isFinite(sgn>0?ctx.low[i]:ctx.high[i]))return;
    if(v>extreme){extreme=v;level=high[i];}
  }
  const height=extreme-ys[0];
  if(!(height>0))return;
  const tolerance=ctx.tolerance*height;
  let residual=0;for(let i=0;i<k;i++)residual=Math.max(residual,Math.abs(ys[i]-quad.at(xs[i])));
  if(residual>tolerance)return;
  const rise=quad.at(end.index)-quad.at(first.index);
  if(rise<ACCEL_MIN_RISE*height)return;
  const line=lineMiss(xs,ys);
  if(!(line>=ACCEL_LINE_ADVANTAGE*residual)&&!(line>tolerance))return;
  // Price stays above the curve throughout (closes by the tolerance, wicks by twice it).
  const worst=sgn>0?ctx.low:ctx.high;
  for(let i=first.index;i<=to;i++){
    const curve=quad.at(i);
    if(sgn*ctx.close[i]<curve-tolerance||sgn*worst[i]<curve-2*tolerance)return;
  }
  return {touches:[...touches],quad,s0,s1,residual,height,rise,level};
}

function setupOf(c:Candidate,sgn:1|-1,ctx:AccelContext):Setup {
  const bull=sgn>0,first=c.touches[0],end=c.touches.at(-1)!,{quad}=c,k=c.touches.length;
  const at=(index:number)=>sgn*quad.at(index);
  const endValue=quad.at(end.index),endSlope=quad.slopeAt(end.index);
  // Real-price curve; beyond the last touch its tangent is used, never the (steeper and steeper) parabola.
  const floorAt=(index:number)=>sgn*(index<=end.index?quad.at(index):endValue+endSlope*(index-end.index));
  const slope=(at(end.index)-at(first.index))/(end.index-first.index),chordLine={slope,intercept:at(first.index)-slope*first.index};
  const horizontal={slope:0,intercept:c.level};
  const ratio=c.s1/c.s0;
  return {
    pivots:c.touches,family:'huzi-accel',name:bull?'通道加速 · 上行':'通道加速 · 下行',height:c.height,tolerance:c.height*ctx.tolerance,
    // The breakout is a neckline-type event, so the envelope lines are placeholders; the guides are the level and the curve.
    upper:bull?horizontal:chordLine,lower:bull?chordLine:horizontal,radius:ctx.radius,neckline:horizontal,direction:bull?'bullish':'bearish',
    formation:'complete',floorAt,curve:{at,from:first.index,to:end.index},
    ratios:[
      {label:'末 / 首触点曲线斜率比',value:ratio,expected:`≥ ${ACCEL_STEEPENING.toFixed(3)}`},
      {label:'曲线最大残差 / 结构高度',value:c.residual/c.height,expected:`≤ ${ctx.tolerance.toFixed(3)}`},
      {label:'曲线触点数',value:k,expected:`≥ ${ACCEL_MIN_TOUCHES}`},
      {label:'曲线上升 / 结构高度',value:c.rise/c.height,expected:`≥ ${ACCEL_MIN_RISE.toFixed(3)}`},
    ],
    notes:[`${k} 个${bull?'低':'高'}点落在一条越来越陡的${bull?'':'下行'}抛物线上，末 / 首触点斜率比 ${ratio.toFixed(2)}。`,
      '通道加速为依图与案例标签的推断定义，曲线是几何拟合而非原作者的画线；最后触点之后按切线延伸，收盘越过后放弃此结构，突破位取触点以来的最高价（下行取最低价）。'],
  };
}

/** Accelerating (curved) trends. Called with every same-side pivot so far at each confirmed pivot `end`, which is
 * always the latest touch: a low starts a rising structure, a high a falling one. At most two structures per call
 * (most touches, and the tightest fit); the caller de-duplicates across calls. */
export function accelSetups(highs:readonly Pivot[],lows:readonly Pivot[],end:Pivot,ctx:AccelContext):Setup[] {
  const sgn:1|-1=end.kind==='low'?1:-1,own=sgn>0?lows:highs;
  if(own.length<ACCEL_MIN_TOUCHES||own.at(-1)?.index!==end.index||end.index>ctx.horizon)return [];
  const chain=chainOf(own,end,sgn,Math.max(4,ctx.radius*2),ctx.maxSpan);
  let best:Candidate|undefined,tightest:Candidate|undefined;
  for(let k=chain.length;k>=ACCEL_MIN_TOUCHES;k--){
    const c=evaluate(chain.slice(chain.length-k),sgn,ctx);
    if(!c)continue;
    if(!best)best=c;
    if(!tightest||c.residual/c.height<tightest.residual/tightest.height)tightest=c;
  }
  if(!best)return [];
  return [best,...(tightest&&tightest!==best?[tightest]:[])].map(c=>setupOf(c,sgn,ctx));
}
