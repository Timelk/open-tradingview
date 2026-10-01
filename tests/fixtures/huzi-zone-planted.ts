/**
 * Planted "画门 / 水平带" structures at a KNOWN place: the price keeps testing one horizontal band (a ceiling from
 * below, or a floor from above), each test separated by a real pullback and the wicks stabbing a little through
 * the band, before it either goes through (`through`) or falls back through the deepest pullback (`held`).
 * Deterministic (seeded). The geometry follows the user's teaching chart; see src/lib/patterns/huzi-zone.ts.
 */
import {mulberry32,STEP_MS,type Planted} from './huzi-synthetic';

export type ZoneSide='ceiling'|'floor';
export type ZoneOutcome='through'|'held'|'none';
export interface ZoneOptions {
  side:ZoneSide;length:number;seed:number;
  /** number of tests of the band (3–5) */touches?:number;
  /** 0 clean … 1 very noisy interior */noise?:number;
  outcome?:ZoneOutcome;prefix?:number;tail?:number;
  /** band width as a share of the structure depth D (default .05) */spread?:number;
  /** shallowest pullback as a share of D (default .55) */dipMin?:number;
  /** How the pullbacks change from test to test. `irregular` (default) is what a door looks like; three tests with
   * deepening pullbacks are still not a triangle. `rising` (higher lows under a flat top) is an ascending triangle
   * and `flat` a rectangle: the zone detector must leave those to their own families. */
  dips?:'irregular'|'rising'|'falling'|'flat';
  /** explicit height of every test inside the band, 0 (top) … 1 (bottom), to force a wide or narrow band */levels?:number[];
}
export interface PlantedZone {
  bars:Planted['bars'];side:ZoneSide;outcome:ZoneOutcome;
  /** bar indices of the tests, first to last */touches:number[];dips:number[];
  first:number;last:number;
  /** first bar whose close is beyond the outcome's level (through the band / through the deepest pullback), or -1 */breakout:number;
  bandHigh:number;bandLow:number;deepest:number;depth:number;
  /** direction a detector should report for the planted outcome */direction:'bullish'|'bearish'|undefined;
}

export function plantZone(options:ZoneOptions):PlantedZone {
  const rnd=mulberry32(options.seed),noise=options.noise??.4,L=options.length,n=Math.max(2,Math.min(5,options.touches??3));
  const s=options.side==='ceiling'?1:-1,outcome=options.outcome??'through',spread=options.spread??.05,dipMin=options.dipMin??.55;
  const w0=8+rnd()*6,D=w0*2,prefix=options.prefix??260,tailBars=options.tail??30;
  const base=100+1000;// far from zero so a floor's mirror stays positive
  const price=(u:number)=>base+s*u;
  const band=D,poke=(rnd()-.4)*spread*D;// u of the band's mean level is D
  // Touch times: the first bar of the structure is the first touch. Spread evenly with jitter.
  const times:number[]=[0];
  for(let k=1;k<n;k++)times.push(Math.round(L*k/(n-1)+(k===n-1?0:(rnd()-.5)*.14*L/(n-1))));
  const level=(k:number)=>band+(rnd()-.5)*spread*D+(k===0?poke*.2:0);
  const touchU=times.map((_,k)=>options.levels?band+(.5-options.levels[k%options.levels.length])*spread*D:level(k));
  // Pullbacks between tests: each at least dipMin·D deep, at most D.
  const shape=options.dips??'irregular',gaps=times.length-1;
  const depthAt=(k:number)=>{
    if(shape==='flat')return .8;
    if(shape==='rising')return gaps>1?1-.55*k/(gaps-1):.8;
    if(shape==='falling'||(shape==='irregular'&&gaps===2))return gaps>1?dipMin+(1-dipMin)*(.3+.7*k/(gaps-1)):.8;
    return dipMin+rnd()*(1-dipMin);
  };
  const dipU=times.slice(1).map((_,k)=>band-D*depthAt(k));
  const dipT=times.slice(1).map((t,k)=>Math.round((times[k]+t)/2+(rnd()-.5)*.2*(t-times[k])));
  const startIdx=prefix,total=prefix+L+1+40+tailBars;
  const close=new Float64Array(total),open=new Float64Array(total),high=new Float64Array(total),low=new Float64Array(total);
  // Approach: noise around a level below the band, then a ramp of `ramp` bars up to the first test.
  const ramp=Math.min(30,prefix-10);
  let u=band*.45;
  for(let i=0;i<prefix-ramp;i++){u+=(rnd()-.5)*w0*.2-(u-band*.45)*.05;close[i]=price(Math.max(-2*D,Math.min(band*.7,u)));}
  // Skeleton vertices (closes stay a little inside the band, so the band is only ever touched by wicks).
  const inside=band-.04*D;
  const vertices:Array<{i:number;v:number}>=[{i:startIdx-ramp,v:Math.min(band*.7,Math.max(band*.2,u))}];
  for(let k=0;k<n;k++){
    vertices.push({i:startIdx+times[k],v:Math.min(touchU[k]-.03*D,inside)});
    if(k<n-1)vertices.push({i:startIdx+dipT[k],v:dipU[k]});
  }
  const dense:Array<{i:number;v:number}>=[];
  for(let k=0;k<vertices.length-1;k++){
    dense.push(vertices[k]);
    const a=vertices[k],b=vertices[k+1],extra=Math.floor(rnd()*(1+noise*3));
    for(const c of Array.from({length:extra},()=>.2+rnd()*.6).sort((x,y)=>x-y)){
      const i=Math.round(a.i+(b.i-a.i)*c);if(i<=a.i||i>=b.i)continue;
      const lin=a.v+(b.v-a.v)*c,room=Math.max(.001,Math.min(inside-lin,(lin-Math.min(a.v,b.v))+.1*D));
      dense.push({i,v:Math.min(inside,lin+(rnd()-.5)*2*noise*.3*Math.min(room,Math.abs(b.v-a.v)*.5+.01))});
    }
  }
  dense.push(vertices.at(-1)!);
  const lastI=dense.at(-1)!.i;
  let seg=0;
  for(let i=startIdx-ramp;i<=lastI;i++){
    while(seg<dense.length-2&&i>dense[seg+1].i)seg++;
    const a=dense[seg],b=dense[seg+1],f=b.i===a.i?0:(i-a.i)/(b.i-a.i);
    const lin=a.v+(b.v-a.v)*Math.min(1,Math.max(0,f));
    close[i]=price(Math.min(inside,lin+(rnd()-.5)*noise*.06*D));
  }
  // After the last test: a few bars inside, then the outcome.
  const deepest=Math.min(...dipU),dipLevel=band-deepest;void dipLevel;
  let prev=close[lastI];const lead=8+Math.floor(rnd()*6);
  for(let i=lastI+1;i<total;i++){
    const k=i-lastI;
    let target:number;
    if(outcome==='through'){
      target=k<lead?band*.78+(rnd()-.5)*.1*D:k===lead?band+.5*D:band+.5*D+(k-lead)*D*(.05+rnd()*.1);
      prev=k<lead?prev+(target-prev)*.3:target;
      if(k<lead)prev=Math.min(inside,prev);
    }else if(outcome==='held'){
      const to=deepest-.6*D,steps=14;
      target=k<=steps?band*.9+(to-band*.9)*(k/steps)**1.25:to-(k-steps)*D*(.03+rnd()*.06);
      prev=target+(rnd()-.5)*.05*D;
      if(k<3)prev=Math.min(inside,band*.9-(k*.1*D));
    }else{
      prev=prev+(band*.7-prev)*.2+(rnd()-.5)*.2*D;prev=Math.min(inside,Math.max(deepest+.2*D,prev));
    }
    close[i]=price(prev);
  }
  // OHLC. The wicks of the touch and pullback bars sit exactly on their levels; neighbours stay strictly inside.
  const wickOf=(i:number)=>Math.min(.06*D,(.1+rnd()*.5)*Math.max(.02*D,Math.abs(close[i]-(i?close[i-1]:close[0]))*.6));
  for(let i=0;i<total;i++){
    open[i]=i===0?close[0]:close[i-1];
    const w=wickOf(i);
    high[i]=Math.max(open[i],close[i])+w;low[i]=Math.min(open[i],close[i])-w;
  }
  const touchBars=times.map(t=>startIdx+t),dipBars=dipT.map(t=>startIdx+t);
  const clampNeighbours=(i:number,fn:(j:number)=>void)=>{for(let j=Math.max(0,i-7);j<=Math.min(total-1,i+7);j++)if(j!==i)fn(j);};
  touchBars.forEach((i,k)=>{
    const top=price(touchU[k]);
    // Only the wick reaches the band; a spike above it never comes with a body.
    const sHigh=s>0?Math.max(top,Math.max(open[i],close[i])+.01*D):0,sLow=s<0?Math.min(top,Math.min(open[i],close[i])-.01*D):0;
    if(s>0)high[i]=sHigh;else low[i]=sLow;
    clampNeighbours(i,j=>{if(s>0)high[j]=Math.min(high[j],high[i]-.006*D);else low[j]=Math.max(low[j],low[i]+.006*D);});
  });
  dipBars.forEach((i,k)=>{
    const bottom=price(dipU[k]);
    if(s>0)low[i]=Math.min(low[i],bottom);else high[i]=Math.max(high[i],bottom);
    clampNeighbours(i,j=>{if(s>0)low[j]=Math.max(low[j],low[i]+.006*D);else high[j]=Math.min(high[j],high[i]-.006*D);});
  });
  // Every candle stays a real candle, whatever the clamps did.
  for(let i=0;i<total;i++){
    high[i]=Math.max(high[i],open[i],close[i]);low[i]=Math.min(low[i],open[i],close[i]);
  }
  const bandU=band,deepU=deepest;
  const beyondBand=(c:number)=>s*(c-price(bandU))>0.02*D,beyondDeep=(c:number)=>s*(c-price(deepU))<-.02*D;
  let breakout=-1;
  for(let i=lastI+1;i<total&&outcome!=='none';i++){
    if(outcome==='through'?beyondBand(close[i]):beyondDeep(close[i])){breakout=i;break;}
  }
  const bars=Array.from({length:total},(_,i)=>[i*STEP_MS,open[i],high[i],low[i],close[i],100+rnd()*40] as Planted['bars'][number]);
  const hi=Math.max(...touchBars.map(i=>s>0?high[i]:low[i])),lo=Math.min(...touchBars.map(i=>s>0?high[i]:low[i]));
  const direction=outcome==='none'?undefined:outcome==='through'?(s>0?'bullish':'bearish'):(s>0?'bearish':'bullish');
  return {bars,side:options.side,outcome,touches:touchBars,dips:dipBars,first:touchBars[0],last:touchBars.at(-1)!,breakout,
    bandHigh:Math.max(hi,lo),bandLow:Math.min(hi,lo),deepest:price(deepU),depth:D,direction};
}

/** The planted zone found in `matches`: a `huzi-zone` heading the right way, anchored at the first test and ending
 * on one of the later tests (the earliest known reading may stop before the last test), confirmed at the outcome. */
export function foundZone<T extends {family:string;direction:string;points:Array<{time:number}>;confirmedAt:number}>(matches:readonly T[],t:PlantedZone):T|undefined {
  const bar=(time:number)=>Math.round(time/STEP_MS),slack=4;
  return matches.find(m=>m.family==='huzi-zone'&&m.direction===t.direction
    &&Math.abs(bar(m.points[0].time)-t.first)<=slack
    &&bar(m.points.at(-1)!.time)>=t.touches[2]-slack&&bar(m.points.at(-1)!.time)<=t.last+slack
    &&Math.abs(bar(m.confirmedAt)-(t.breakout+1))<=2);
}

/** Geometric random walk with candle bodies and wicks: no band anywhere, only chance. */
export function randomWalk(seed:number,length=1500):Planted['bars'] {
  const r=mulberry32(seed);let p=100;const bars:Planted['bars']=[];
  const gauss=()=>{let sum=0;for(let k=0;k<6;k++)sum+=r();return (sum-3)/Math.sqrt(.5);};
  for(let i=0;i<length;i++){
    const open=p;p=p*Math.exp(gauss()*.006);
    bars.push([i*STEP_MS,open,Math.max(open,p)*(1+r()*.003),Math.min(open,p)*(1-r()*.003),p,100]);
  }
  return bars;
}
