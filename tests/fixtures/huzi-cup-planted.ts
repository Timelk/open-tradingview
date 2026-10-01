import {mulberry32,STEP_MS,type Planted} from './huzi-synthetic';

/**
 * Deterministic cup / rounded-base generator for the Huzi cup detector.
 *
 * The base is drawn as a fraction of its own depth: `profile(u)` is how far below the rim the price is at u ∈ [0, 1]
 * across the base. A round cup is a parabola, a V is a triangle, a W is two sharp dips. A rise leads into the left
 * rim, the right rim recovers, an optional handle pulls back and a decisive close breaks the rim. Everything scales
 * with the depth, so the same shapes serve every width. `mirror` flips prices around 100 for the inverted cup.
 */
export type CupShape='cup'|'arc'|'v'|'w'|'low-rim'|'fall';
export interface CupOptions {
  shape:CupShape;width:number;seed:number;mirror?:boolean;
  /** 0 clean … 1 noisy closes and wicks */noise?:number;prefix?:number;tail?:number;
}
export interface PlantedCup {
  bars:Planted['bars'];shape:CupShape;mirror:boolean;
  /** Left rim, trough, right rim, handle low (only for a cup), breakout close — bar indexes. */
  leftRim:number;trough:number;rightRim:number;handleLow?:number;breakout:number;
  depth:number;rim:number;
  direction:'bullish'|'bearish';
}
const tri=(u:number,centre:number,half:number)=>Math.max(0,1-Math.abs(u-centre)/half);
/** Fraction of the depth below the rim at position u of the base. */
function profile(shape:CupShape,u:number):number {
  switch(shape){
    case 'cup':case 'arc':case 'low-rim':return 1-(2*u-1)**2;
    case 'v':return 1-Math.abs(2*u-1);
    case 'w':return Math.max(tri(u,.25,.25),tri(u,.75,.25));
    case 'fall':return u;
  }
}

export function plantCup(options:CupOptions):PlantedCup {
  const rnd=mulberry32(options.seed),noise=options.noise??.4,W=options.width,mirror=options.mirror===true;
  const depth=8+rnd()*6,prefix=options.prefix??300,tail=options.tail??30;
  const hasHandle=options.shape==='cup'||options.shape==='v'||options.shape==='w'||options.shape==='low-rim';
  const handleLen=Math.max(5,Math.round(W*(.16+rnd()*.12))),handleDepth=depth*(.16+rnd()*.24);
  // Without a handle a small pullback still separates the right rim from the breakout, as it does on real charts.
  const pullLen=Math.max(6,Math.round(W*.2)),pullDepth=depth*(.018+rnd()*.02);
  const restLen=hasHandle?handleLen:pullLen,restDepth=hasHandle?handleDepth:pullDepth;
  const breakGap=4+Math.floor(rnd()*4);
  const total=prefix+W+1+restLen+breakGap+1+tail;
  const rim=100+depth*3,base=prefix; // bull orientation: index of the left rim is `base`
  const close=new Float64Array(total),open=new Float64Array(total),high=new Float64Array(total),low=new Float64Array(total);
  const level=(i:number)=>{
    if(i<base){
      // approach: wander well under the rim, then climb into it over the last third
      const climb=Math.round(prefix/3),f=i<base-climb?0:(i-(base-climb))/climb;
      return rim-depth*2.6*(1-f)+(rnd()-.5)*depth*.09;
    }
    const u=(i-base)/W;
    if(i<=base+W){
      const rightRim=options.shape==='low-rim'?rim-depth*.55:rim-(rnd()-.5)*.1*depth;
      // the right rim may sit a little off the left one; a low rim recovers only ~45 % of the way
      const rimAt=rim+(rightRim-rim)*Math.max(0,(u-.5)*2)**2;
      if(options.shape==='fall')return rim-depth*Math.min(1,u*1.05)+(rnd()-.5)*depth*.03;
      return rimAt-depth*profile(options.shape,u)+(rnd()-.5)*2*noise*.03*depth;
    }
    return NaN;
  };
  for(let i=0;i<=base+W;i++)close[i]=level(i);
  const rightRim=close[base+W];
  // rest after the right rim: handle (a half sine) or the small pullback
  for(let k=1;k<=restLen;k++){
    const f=k/restLen;
    close[base+W+k]=rightRim-restDepth*Math.sin(Math.PI*Math.min(1,f*1.02))**.9+(rnd()-.5)*2*noise*.02*depth;
  }
  const restEnd=base+W+restLen,breakAt=restEnd+breakGap;
  let previous=close[restEnd];
  for(let i=restEnd+1;i<total;i++){
    if(i<breakAt)previous+=(rightRim-previous)*.35+(rnd()-.5)*depth*.03;
    else if(i===breakAt)previous=rim+depth*.42;
    else previous+=depth*(.05+rnd()*.1)+(rnd()-.5)*depth*.08;
    close[i]=previous;
  }
  // OHLC with wicks; the rims carry a small spike so they are the pivots a chart reader would see
  for(let i=0;i<total;i++){
    open[i]=i===0?close[0]:close[i-1];
    const body=Math.abs(close[i]-open[i]),wick=(.15+rnd()*.5)*Math.max(depth*.012,body*.5+depth*.02*(.5+noise));
    high[i]=Math.max(open[i],close[i])+wick;low[i]=Math.min(open[i],close[i])-wick;
  }
  const leftRim=base,rightRimIndex=base+W;
  high[leftRim]=Math.max(high[leftRim],close[leftRim])+depth*.04;
  high[rightRimIndex]=Math.max(high[rightRimIndex],close[rightRimIndex])+depth*.04;
  let trough=base;for(let i=base;i<=base+W;i++)if(low[i]<low[trough])trough=i;
  let handleLow:number|undefined;
  if(options.shape==='cup'){handleLow=rightRimIndex+1;for(let i=rightRimIndex+1;i<=restEnd;i++)if(low[i]<low[handleLow])handleLow=i;}
  const flip=(v:number)=>mirror?200-v:v;
  const bars=Array.from({length:total},(_,i)=>{
    const o=flip(open[i]),h=flip(mirror?low[i]:high[i]),l=flip(mirror?high[i]:low[i]),c=flip(close[i]);
    return [i*STEP_MS,o,h,l,c,100+rnd()*40] as Planted['bars'][number];
  });
  return {bars,shape:options.shape,mirror,leftRim,trough,rightRim:rightRimIndex,handleLow,breakout:breakAt,depth,rim:flip(rim),direction:mirror?'bearish':'bullish'};
}
