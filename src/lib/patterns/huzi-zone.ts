import type {Pivot} from './pivots';
import type {Setup} from './huzi';
import type {PriceColumns} from './huzi-fit';
import {classifyBoundaries} from './huzi-boundary';

/**
 * 画门 / 水平带 — a horizontal band ("door") that price keeps testing from one side without getting through.
 *
 * Provenance, stated plainly: this is an INFERENCE, not the author's definition. Public sources do not define
 * the term. It is read from one teaching chart (candles rising to the same orange band three times, each time
 * from a deep pullback, before a sharp fall) and from the case log's wording: "高位三角 频繁画门",
 * "画门 上涨无力反转", "画门 反转". What is implemented is the geometry those examples share:
 *
 *  - at least three touches of one band (highs for a ceiling, lows for a floor), each a separate rejection:
 *    the price leaves the band by a real pullback between touches (≥ 0.5 × height), not a wiggle;
 *  - the band is narrow next to the structure (width ≤ (0.05 + tolerance) × height, height = mean touch to the
 *    deepest pullback), it was tested over at least 40 bars, and no close goes through it while it is tested;
 *  - it is not already a triangle / wedge / channel (a flat top over rising lows is an ascending triangle and
 *    belongs to that family — the same anchors are never reported twice).
 *
 * Touches are picked the way a person draws it: the newest touch fixes the side, older same-side pivots inside the
 * band are touches, same-side pivots clearly below the band are ignored sub-peaks. Two outcomes are offered for
 * every batch of touches and confirmed independently by the shared closed-candle rules: a close through the band
 * (with the market, "沿带突破"), or a close through the deepest pullback (the band held, "反向失败" — the case the
 * teaching chart shows). Nothing here reads a bar after the newest touch is confirmed.
 */
export const zoneMessages:Record<string,string>={
  '画门 · 压力带':'Zone · Resistance band','画门 · 支撑带':'Zone · Support band',
  '触点数':'Touches in the band','带宽 / 结构高度':'Band width / structure height','最浅回撤 / 结构高度':'Shallowest pullback / structure height',
  '水平带由 {0} 个触点组成，带宽为结构高度的 {1}%。':'The horizontal band is made of {0} touches; its width is {1}% of the structure height. ',
  '画门按教学图与案例标签推断：价格反复测试同一条水平带而未能突破。':'The zone is inferred from the teaching chart and case labels: price repeatedly tests one horizontal band without getting through. ',
  '这不是原作者的量化定义，仅为工程解释。':'This is not the author\'s quantitative definition, only an engineering interpretation. ',
};

/** Band width limit as a share of structure height, before the caller's tolerance is added. Measured, not assumed:
 * at 0.10 a random walk produced ~11 zones per 1500 bars (as many as real charts); 0.05 with the depth and span
 * limits below brings that to ~1.8, and the teaching chart's band is ~7% of its height. */
export const ZONE_BAND_SHARE=.05;
/** Every pullback leaves the band by at least this share of the structure height (and twice the band width). */
export const ZONE_DIP_SHARE=.5;
/** Shortest zone in bars: a door tested over fewer bars is a fragment (the author's examples run 80–330). */
export const ZONE_MIN_SPAN=40;
const MIN_TOUCHES=3,MAX_TOUCHES=6;
/** Same-side pivots examined, newest first. */
const SCAN=9;

interface Line {slope:number;intercept:number}
function fitLine(points:readonly Pivot[]):Line {
  const n=points.length;let mx=0,my=0;for(const p of points){mx+=p.index;my+=p.value;}mx/=n;my/=n;
  let num=0,den=0;for(const p of points){num+=(p.index-mx)*(p.value-my);den+=(p.index-mx)**2;}
  const slope=den>0?num/den:0;return {slope,intercept:my-slope*mx};
}
const lineAt=(line:Line,index:number)=>line.slope*index+line.intercept;

interface Zone {
  side:1|-1;pivots:Pivot[];touches:Pivot[];dips:Pivot[];
  /** Real prices: band edges, deepest pullback, mean of the touches. */
  bandHigh:number;bandLow:number;deepest:number;height:number;width:number;shallowest:number;
}

/** The best zone whose newest touch is the stack's last pivot, or undefined. */
function findZone(stack:readonly Pivot[],radius:number,tolerance:number,price:PriceColumns):Zone|undefined {
  const newest=stack.at(-1);
  if(!newest||stack.length<5)return;
  const side:1|-1=newest.kind==='high'?1:-1,kind=newest.kind;
  // Same-kind pivots, newest first (stack indices).
  const own:number[]=[];
  for(let i=stack.length-1;i>=0&&own.length<SCAN;i--)if(stack[i].kind===kind)own.push(i);
  if(own.length<MIN_TOUCHES)return;
  let best:Zone|undefined;
  // Oldest start first: the widest reading is preferred, then whatever still holds together.
  for(let m=own.length-1;m>=MIN_TOUCHES-1;m--){
    const from=own[m],range=stack.slice(from);
    let top=-Infinity,deep=Infinity;
    for(const p of range){const v=side*p.value;if(p.kind===kind){if(v>top)top=v;}else if(v<deep)deep=v;}
    const rough=top-deep;
    if(!(rough>0))continue;
    const allow=rough*(ZONE_BAND_SHARE+tolerance);
    const touches=range.filter(p=>p.kind===kind&&side*p.value>=top-allow);
    if(touches.length<MIN_TOUCHES||touches.length>MAX_TOUCHES||touches[0]!==stack[from]||touches.at(-1)!==newest)continue;
    // Each pair of touches is separated by a real pullback: the deepest opposite pivot between them.
    const dips:Pivot[]=[];let ok=true;
    for(let t=1;t<touches.length&&ok;t++){
      const a=touches[t-1],b=touches[t];
      if(b.index-a.index<Math.max(4,radius*2)){ok=false;break;}
      let dip:Pivot|undefined;
      for(const p of range)if(p.kind!==kind&&p.index>a.index&&p.index<b.index&&(!dip||side*p.value<side*dip.value))dip=p;
      if(!dip){ok=false;break;}
      dips.push(dip);
    }
    if(!ok)continue;
    const values=touches.map(p=>p.value);
    const bandHigh=Math.max(...values),bandLow=Math.min(...values),width=bandHigh-bandLow;
    const mean=values.reduce((sum,v)=>sum+v,0)/values.length;
    // Side-normalised: a ceiling's dips lie below the band, a floor's above it.
    const deepest=side>0?Math.min(...dips.map(p=>p.value)):Math.max(...dips.map(p=>p.value));
    const height=side*(mean-deepest);
    if(!(height>0)||width>height*(ZONE_BAND_SHARE+tolerance))continue;
    const edge=side>0?bandLow:bandHigh;// the band edge nearest the pullbacks
    const gap=Math.max(ZONE_DIP_SHARE*height,2*width);
    let shallowest=Infinity;
    for(const dip of dips){const depth=side*(edge-dip.value);if(depth<gap){ok=false;break;}if(depth<shallowest)shallowest=depth;}
    if(!ok)continue;
    const first=touches[0].index,last=newest.index;
    if(last-first<Math.max(ZONE_MIN_SPAN,radius*6))continue;
    const pivots:Pivot[]=[];
    for(let t=0;t<touches.length;t++){pivots.push(touches[t]);if(t<dips.length)pivots.push(dips[t]);}
    // Not already an envelope: touches on one line and dips on another that classify as triangle / wedge / channel.
    const upper=fitLine(side>0?touches:dips),lower=fitLine(side>0?dips:touches);
    const envelopeHeight=Math.max(...pivots.map(p=>p.value))-Math.min(...pivots.map(p=>p.value));
    let error=0;
    for(const p of touches)error=Math.max(error,Math.abs(p.value-lineAt(side>0?upper:lower,p.index)));
    for(const p of dips)error=Math.max(error,Math.abs(p.value-lineAt(side>0?lower:upper,p.index)));
    if(error<=envelopeHeight*tolerance*1.5&&classifyBoundaries(upper,lower,first,last,envelopeHeight,tolerance))continue;
    // Safety net for pivots the swing compression may have dropped: nothing in the structure goes beyond the band.
    const tol=height*tolerance;
    let clear=true;
    for(let i=first;i<=last&&clear;i++){
      const wick=side>0?price.high[i]:price.low[i];
      if(!Number.isFinite(wick)||side*(wick-(side>0?bandHigh:bandLow))>tol*2)clear=false;
    }
    if(!clear)continue;
    best={side,pivots,touches,dips,bandHigh,bandLow,deepest,height,width,shallowest:shallowest/height};
    break;
  }
  return best;
}

/** Zones whose newest touch is the last pivot of `stack`. Two setups per zone (see the module note). */
export function zoneSetups(stack:Pivot[],radius:number,tolerance:number,price:PriceColumns):Setup[] {
  const zone=findZone(stack,radius,tolerance,price);
  if(!zone)return [];
  const {side,pivots,touches,bandHigh,bandLow,deepest,height,width}=zone;
  const ceiling=side>0,horizontal=(value:number)=>({slope:0,intercept:value});
  const prefix=ceiling?'T':'S',dipPrefix=ceiling?'D':'U';
  const labels=pivots.map((_,i)=>i%2===0?`${prefix}${i/2+1}`:`${dipPrefix}${(i-1)/2+1}`);
  const share=width/height;
  const ratios=[
    {label:'触点数',value:touches.length,expected:`≥ ${MIN_TOUCHES}`},
    {label:'带宽 / 结构高度',value:share,expected:`≤ ${(ZONE_BAND_SHARE+tolerance).toFixed(3)}`},
    {label:'最浅回撤 / 结构高度',value:zone.shallowest,expected:`≥ ${ZONE_DIP_SHARE.toFixed(3)}`},
  ];
  const notes=[
    `水平带由 ${touches.length} 个触点组成，带宽为结构高度的 ${(share*100).toFixed(1)}%。`,
    '画门按教学图与案例标签推断：价格反复测试同一条水平带而未能突破。','这不是原作者的量化定义，仅为工程解释。',
  ];
  const base={pivots,family:'huzi-zone',name:ceiling?'画门 · 压力带':'画门 · 支撑带',height,tolerance:height*tolerance,
    upper:horizontal(bandHigh),lower:horizontal(bandLow),radius,labels,ratios,notes,formation:'complete' as const,
    band:{top:bandHigh,bottom:bandLow,side}};
  // With the market: a ceiling breaks up through its top, a floor breaks down through its bottom.
  const through:Setup={...base,neckline:horizontal(ceiling?bandHigh:bandLow),direction:ceiling?'bullish':'bearish',stop:deepest};
  // The band held: the price falls back through the deepest pullback (ceiling) or climbs through it (floor).
  const held:Setup={...base,neckline:horizontal(deepest),direction:ceiling?'bearish':'bullish',stop:ceiling?bandHigh:bandLow};
  return [through,held];
}
