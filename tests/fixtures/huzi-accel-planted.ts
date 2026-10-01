/**
 * Planted accelerating trends for the channel-acceleration detector.
 *
 * The user's reference picture and the case labels ("通道加速") show a rally whose pullback lows ride a curve that
 * keeps getting steeper. Here that curve is a parabola: the lows are planted ON it (with small placement error),
 * the price swings up between them and stays above it, and a decisive close above the highest swing so far follows.
 * Deterministic (seeded). Negative shapes share the same skeleton so a detector cannot tell them apart by texture:
 *  - `line`   the lows lie on a straight line (an ordinary rising channel), no acceleration;
 *  - `decel`  concave: the rally slows down;
 *  - `jump`   flat lows and one abrupt step at the very end;
 *  - `broken` a genuine accelerating curve that the price falls far through half way.
 */
import {mulberry32,STEP_MS} from './huzi-synthetic';

export type AccelShape='accel'|'line'|'decel'|'jump'|'broken';
export interface AccelOptions {
  direction:'up'|'down';
  /** Bars from the first to the last touch. */
  length:number;
  seed:number;
  /** 0 clean … 1 very noisy */
  noise?:number;
  /** Touch count, 4–7. */
  touches?:number;
  shape?:AccelShape;
  /** Curvature k of y = R·((1−k)u + k·u²): the end slope is (1+k)/(1−k) times the start slope. */
  curvature?:number;
  prefix?:number;
  tail?:number;
}
export interface PlantedAccel {
  bars:Array<[number,number,number,number,number,number]>;
  direction:'bullish'|'bearish';
  /** bar index of the first touch, last touch and the breakout close */
  first:number;last:number;breakout:number;
  touches:number[];
  /** The planted curve in price terms (mirrored for `down`). */
  curve:(index:number)=>number;
  /** Highest swing since the first touch (lowest for `down`): the level the breakout must close through. */
  neckline:number;
  /** Rise (fall) of the structure, R. */
  rise:number;
  /** `broken` only: the bar of the low that falls far through the curve. */
  dip?:number;
}

export function plantAccel(options:AccelOptions):PlantedAccel {
  const rnd=mulberry32(options.seed*7919+options.length),noise=options.noise??.4,L=options.length;
  const shape=options.shape??'accel',n=Math.max(4,Math.min(7,options.touches??5)),prefix=options.prefix??260,tailBars=options.tail??24;
  const bull=options.direction==='up';
  const unit=5+rnd()*4,R=10*unit,base=400,y0=base;
  const k=options.curvature??(shape==='accel'||shape==='broken'?.5+rnd()*.25:shape==='decel'?-.55:0);
  const F=prefix;
  const curveU=(u:number)=>{
    if(shape==='jump')return u<.8?.06*R*u:.06*R*.8+(u-.8)/.2*(R-.048*R);
    return R*((1-k)*u+k*u*u);
  };
  const curve=(i:number)=>y0+curveU((i-F)/L);
  // touch times: evenly spaced with jitter, alternating with swing highs in between
  const times:number[]=[];
  for(let j=0;j<n;j++){
    const gap=L/(n-1),jitter=j===0||j===n-1?0:(rnd()-.5)*.24*gap;
    times.push(F+Math.round(gap*j+jitter));
  }
  const last=times.at(-1)!;
  const err=()=>(rnd()-.5)*2*(.008+.016*noise)*R;
  const vertices:Array<{i:number;v:number;kind:'low'|'high'}>=[];
  // `broken`: an extra, deep low half way through the structure (the price falls through the curve).
  let dipBar:number|undefined;
  const dipInterval=Math.min(n-2,Math.max(1,Math.round(.5*(n-1))));
  let highest=-Infinity;
  for(let j=0;j<n;j++){
    const i=times[j],lowValue=curve(i)+err();
    vertices.push({i,v:lowValue,kind:'low'});
    if(j<n-1){
      const next=times[j+1],f=.35+rnd()*.3,ip=Math.round(i+(next-i)*f);
      const amp=R*(.1+.12*rnd()+.1*noise);
      const nextLow=curve(next);
      const peak=Math.max(curve(ip)+amp,nextLow+.04*R);
      vertices.push({i:ip,v:peak,kind:'high'});
      highest=Math.max(highest,peak);
      if(shape==='broken'&&j===dipInterval){
        // The fall through the curve happens on the way down to the next touch.
        const dip=Math.round((ip+next)/2);dipBar=dip;
        vertices.push({i:dip,v:curve(dip)-.9*R,kind:'low'});
      }
    }
  }
  vertices.sort((a,b)=>a.i-b.i);
  const inside=4+Math.floor(rnd()*5),breakAt=last+inside;
  const total=breakAt+1+tailBars;
  // Price path: prefix wander → vertex to vertex → decisive close above the highest swing → drift on.
  const close=new Float64Array(total),open=new Float64Array(total),high=new Float64Array(total),low=new Float64Array(total);
  let level=y0;
  for(let i=0;i<F;i++){level+=(y0-level)*.06+(rnd()-.5)*.04*R;close[i]=level;}
  close[F-1]=y0+(rnd()-.5)*.01*R;
  const path=(i:number)=>{
    let s=0;while(s<vertices.length-2&&i>vertices[s+1].i)s++;
    const a=vertices[s],b=vertices[s+1],f=b.i===a.i?0:Math.min(1,Math.max(0,(i-a.i)/(b.i-a.i)));
    return a.v+(b.v-a.v)*f;
  };
  for(let i=F;i<=last;i++)close[i]=path(i)+(rnd()-.5)*.03*R*noise;
  const breakClose=highest+.07*R+(rnd()-.5)*.02*R;
  for(let i=last+1;i<=breakAt;i++){
    const f=(i-last)/inside;
    close[i]=vertices.at(-1)!.v+(breakClose-vertices.at(-1)!.v)*Math.pow(f,.85)+(rnd()-.5)*.012*R*(i<breakAt?1:0);
  }
  close[breakAt]=breakClose;
  for(let i=breakAt+1;i<total;i++)close[i]=close[i-1]+R*(.012+rnd()*.03)+(rnd()-.5)*.02*R;
  // OHLC: touch bars put the wick exactly on the planted low, swing bars on the planted high.
  const lowSet=new Map(vertices.filter(v=>v.kind==='low').map(v=>[v.i,v.v])),highSet=new Map(vertices.filter(v=>v.kind==='high').map(v=>[v.i,v.v]));
  for(let i=0;i<total;i++){
    open[i]=i===0?close[0]:close[i-1];
    const wick=(.15+rnd()*.7)*.006*R;
    high[i]=Math.max(open[i],close[i])+wick;low[i]=Math.min(open[i],close[i])-wick;
    const lv=lowSet.get(i),hv=highSet.get(i);
    if(lv!==undefined){close[i]=Math.max(close[i],lv+.012*R);open[i]=Math.max(open[i],lv+.012*R);low[i]=lv;high[i]=Math.max(high[i],open[i],close[i]);}
    if(hv!==undefined){close[i]=Math.min(close[i],hv-.012*R);open[i]=Math.min(open[i],hv-.012*R);high[i]=hv;low[i]=Math.min(low[i],open[i],close[i]);}
  }
  const flip=(v:number)=>bull?v:2*base-v;
  const bars:PlantedAccel['bars']=Array.from({length:total},(_,i)=>{
    const o=flip(open[i]),c=flip(close[i]),h=bull?high[i]:flip(low[i]),l=bull?low[i]:flip(high[i]);
    return [i*STEP_MS,o,h,l,c,100+rnd()*40];
  });
  return {bars,direction:bull?'bullish':'bearish',first:F,last,breakout:breakAt,touches:times,curve:i=>flip(curve(i)),neckline:flip(highest),rise:R,...(dipBar===undefined?{}:{dip:dipBar})};
}
