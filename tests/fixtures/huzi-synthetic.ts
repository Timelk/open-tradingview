/**
 * Planted-structure generator for the Huzi detector.
 *
 * Real case logs give labels but not positions (the annotated screenshots are gone), so recall cannot be
 * measured on them. Here the structure is planted at a KNOWN place inside noisy price action: touches lie on
 * two boundary lines, interior sub-swings and wicks stay inside them, then a decisive close breaks out. The
 * generator is deterministic (seeded) and only draws what the atlas describes: converging / parallel
 * boundaries with alternating touches, and head-and-shoulders with a neckline.
 */
export type PlantedKind='sym-triangle'|'asc-triangle'|'desc-triangle'|'rising-wedge'|'falling-wedge'|'up-channel'|'down-channel'|'head-shoulders-top'|'head-shoulders-bottom';
export interface PlantedOptions {kind:PlantedKind;length:number;seed:number;/** 0 clean … 1 very noisy interior */noise?:number;touches?:number;breakout?:'up'|'down'|'auto';prefix?:number;tail?:number}
export interface Planted {
  bars:Array<[number,number,number,number,number,number]>;
  family:'huzi-triangle'|'huzi-wedge'|'huzi-channel'|'huzi-head-shoulders';
  direction:'bullish'|'bearish';
  /** bar index of the first touch, last touch and the breakout close */
  first:number;last:number;breakout:number;
  upper:(index:number)=>number;lower:(index:number)=>number;width0:number;
  touches:number[];
}
export function mulberry32(seed:number){let a=seed>>>0;return ()=>{a=(a+0x6D2B79F5)>>>0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
export const STEP_MS=3_600_000;

interface Shape {upper:(x:number)=>number;lower:(x:number)=>number;family:Planted['family'];bias:'up'|'down'|'either'}
/** x in [0,1] over first→last touch; values are relative to a centre line at 0, width w0 = 1. */
function shape(kind:PlantedKind):Shape {
  switch(kind){
    case 'sym-triangle':return {family:'huzi-triangle',bias:'either',upper:x=>.5*(1-.8*x),lower:x=>-.5*(1-.8*x)};
    case 'asc-triangle':return {family:'huzi-triangle',bias:'up',upper:()=>.5,lower:x=>-.5+.8*x};
    case 'desc-triangle':return {family:'huzi-triangle',bias:'down',upper:x=>.5-.8*x,lower:()=>-.5};
    case 'rising-wedge':return {family:'huzi-wedge',bias:'down',upper:x=>.5+.5*x,lower:x=>-.5+1.1*x};
    case 'falling-wedge':return {family:'huzi-wedge',bias:'up',upper:x=>.5-1.1*x,lower:x=>-.5-.5*x};
    case 'up-channel':return {family:'huzi-channel',bias:'either',upper:x=>.5+.9*x,lower:x=>-.5+.9*x};
    case 'down-channel':return {family:'huzi-channel',bias:'either',upper:x=>.5-.9*x,lower:x=>-.5-.9*x};
    default:return {family:'huzi-head-shoulders',bias:'either',upper:()=>.5,lower:()=>-.5};
  }
}

export function plant(options:PlantedOptions):Planted {
  const rnd=mulberry32(options.seed),noise=options.noise??.5,L=options.length;
  const s=shape(options.kind),price0=100,w0=8+rnd()*6;
  const prefix=options.prefix??260,tailBars=options.tail??24;
  if(s.family==='huzi-head-shoulders')return plantHeadShoulders(options,rnd,prefix,tailBars,w0);
  const touchesN=options.touches??5;
  const bull=options.breakout==='up'||(options.breakout!=='down'&&(s.bias==='up'||(s.bias==='either'&&rnd()<.5)));
  const startOnUpper=rnd()<.5;
  const centre=(x:number)=>0;void centre;
  const ub=(x:number)=>s.upper(x)*w0,lb=(x:number)=>s.lower(x)*w0;
  // touch times, jittered, alternating sides
  const times:number[]=[];for(let k=0;k<touchesN;k++){const base=L*k/(touchesN-1),jitter=k===0||k===touchesN-1?0:(rnd()-.5)*.16*L/(touchesN-1)*2;times.push(Math.round(base+jitter));}
  const sides=times.map((_,k)=>((k%2===0)===startOnUpper?1:-1) as 1|-1);
  // approach: random walk into the structure, then the structure skeleton
  const total=prefix+L+1+18+tailBars;
  const close=new Float64Array(total),high=new Float64Array(total),low=new Float64Array(total),open=new Float64Array(total);
  const startIdx=prefix,at=(i:number)=>i-startIdx;
  const width=(i:number)=>ub(at(i)/L)-lb(at(i)/L);
  const mid=(i:number)=>(ub(at(i)/L)+lb(at(i)/L))/2;
  let level=price0;
  const approachDrift=(bull?-1:1)*w0*.5/prefix*(rnd()<.5?1:-1)*0+ (rnd()-.5)*.04;
  for(let i=0;i<prefix;i++){level+=approachDrift*w0+ (rnd()-.5)*w0*.09;close[i]=level;}
  const base=close[prefix-1];
  // skeleton vertices on the boundary lines (+ small placement error)
  const vertices:Array<{i:number;v:number}>=[];
  for(let k=0;k<touchesN;k++){
    const x=times[k]/L,line=sides[k]===1?ub(x):lb(x),err=(rnd()-.5)*(.03+.09*noise)*w0*(1-.5*x);
    vertices.push({i:startIdx+times[k],v:base+line+err});
  }
  // interior sub-swings inside each leg
  const dense:Array<{i:number;v:number}>=[];
  for(let k=0;k<vertices.length-1;k++){
    dense.push(vertices[k]);
    const a=vertices[k],b=vertices[k+1],extra=Math.floor(rnd()*(1+noise*4.5));
    const cuts=Array.from({length:extra},()=>.15+rnd()*.7).sort((p,q)=>p-q);
    for(const c of cuts){
      const i=Math.round(a.i+(b.i-a.i)*c);if(i<=a.i||i>=b.i)continue;
      const lin=a.v+(b.v-a.v)*c,x=at(i)/L,room=Math.max(.001,Math.min(ub(x)+base-lin,lin-(lb(x)+base)));
      dense.push({i,v:lin+(rnd()-.5)*2*noise*.42*room});
    }
  }
  dense.push(vertices.at(-1)!);
  // path through the vertices (closes), staying inside the envelope
  const lastI=dense.at(-1)!.i;
  let seg=0;
  for(let i=startIdx;i<=lastI;i++){
    while(seg<dense.length-2&&i>dense[seg+1].i)seg++;
    const a=dense[seg],b=dense[seg+1],f=b.i===a.i?0:(i-a.i)/(b.i-a.i),lin=a.v+(b.v-a.v)*Math.min(1,Math.max(0,f));
    const x=at(i)/L,upperNow=base+ub(x),lowerNow=base+lb(x),room=Math.min(upperNow-lin,lin-lowerNow);
    close[i]=lin+(rnd()-.5)*Math.max(0,room)*.55*noise;
  }
  // continue inside the shape for a few bars, then break out decisively
  const inside=6+Math.floor(rnd()*6),breakAt=lastI+inside;
  let prev=close[lastI];
  for(let i=lastI+1;i<total;i++){
    const x=Math.min(1.35,at(i)/L),upperNow=base+ub(x),lowerNow=base+lb(x),w=Math.max(.15*w0,upperNow-lowerNow);
    if(i<breakAt){prev=prev+(mid(lastI)+base-prev)*.25+(rnd()-.5)*w*.18;prev=Math.min(upperNow-.04*w,Math.max(lowerNow+.04*w,prev));}
    else if(i===breakAt)prev=bull?upperNow+.55*w:lowerNow-.55*w;
    else prev+=(bull?1:-1)*w0*(.06+rnd()*.14)+(rnd()-.5)*w0*.1;
    close[i]=prev;
  }
  // OHLC: wicks stay inside the boundary until the breakout; touch bars put the wick ON the line
  const touchSet=new Map<number,1|-1>(times.map((t,k)=>[startIdx+t,sides[k]]));
  for(let i=0;i<total;i++){
    open[i]=i===0?close[0]:close[i-1];
    const body=Math.abs(close[i]-open[i]),wick=(.15+rnd()*.5)*Math.max(.25*w0*.1,body*.6+w0*.02);
    let hi=Math.max(open[i],close[i])+wick,lo=Math.min(open[i],close[i])-wick;
    if(i>=startIdx&&i<=lastI+inside-1){
      const x=at(i)/L,upperNow=base+ub(x),lowerNow=base+lb(x);
      // real wicks sometimes stab through a boundary; messy charts do it more and further
      const poke=rnd()<.14*noise?rnd()*.11*noise*w0:0;
      hi=Math.min(hi,upperNow+.004*w0+(rnd()<.5?poke:0));lo=Math.max(lo,lowerNow-.004*w0-(rnd()<.5?poke:0));
      const side=touchSet.get(i);if(side===1)hi=upperNow+(rnd()-.5)*(.012+.04*noise)*w0;if(side===-1)lo=lowerNow+(rnd()-.5)*(.012+.04*noise)*w0;
      hi=Math.max(hi,Math.max(open[i],close[i]));lo=Math.min(lo,Math.min(open[i],close[i]));
    }
    high[i]=hi;low[i]=lo;
  }
  const bars=Array.from({length:total},(_,i)=>[i*STEP_MS,open[i],high[i],low[i],close[i],100+rnd()*40] as [number,number,number,number,number,number]);
  return {bars,family:s.family,direction:bull?'bullish':'bearish',first:startIdx+times[0],last:lastI,breakout:breakAt,
    upper:i=>base+ub(at(i)/L),lower:i=>base+lb(at(i)/L),width0:w0,touches:times.map(t=>startIdx+t)};
}

function plantHeadShoulders(options:PlantedOptions,rnd:()=>number,prefix:number,tailBars:number,w0:number):Planted {
  const top=options.kind==='head-shoulders-top',L=options.length,noise=options.noise??.5,sign=top?1:-1;
  const startIdx=prefix,total=prefix+L+20+tailBars,base=100;
  const close=new Float64Array(total),open=new Float64Array(total),high=new Float64Array(total),low=new Float64Array(total);
  let level=base;for(let i=0;i<prefix;i++){level+=(rnd()-.5)*w0*.09-sign*w0*.5/prefix;close[i]=level;}
  const start=close[prefix-1];
  // skeleton: start, LS, N1, H, N2, RS, then the neckline break
  const p=[0,.16,.32,.52,.7,.86,1].map(f=>Math.round(f*L));
  const neck=start+sign*w0*.2,shoulderH=start+sign*w0*(.85+rnd()*.15),headH=start+sign*w0*(1.5+rnd()*.3);
  const vals=[start,shoulderH,neck,headH,neck+sign*(rnd()-.5)*.06*w0,shoulderH+sign*(rnd()-.5)*.25*w0,neck];
  const vertices=p.map((t,k)=>({i:startIdx+t,v:vals[k]}));
  const dense:Array<{i:number;v:number}>=[];
  for(let k=0;k<vertices.length-1;k++){
    dense.push(vertices[k]);
    const a=vertices[k],b=vertices[k+1],extra=Math.floor(rnd()*(1+noise*3));
    for(const c of Array.from({length:extra},()=>.2+rnd()*.6).sort((x,y)=>x-y)){
      const i=Math.round(a.i+(b.i-a.i)*c);if(i<=a.i||i>=b.i)continue;
      const lin=a.v+(b.v-a.v)*c;dense.push({i,v:lin+(rnd()-.5)*noise*.5*Math.abs(b.v-a.v)*.5});
    }
  }
  dense.push(vertices.at(-1)!);
  const lastI=dense.at(-1)!.i;let seg=0;
  for(let i=startIdx;i<=lastI;i++){
    while(seg<dense.length-2&&i>dense[seg+1].i)seg++;
    const a=dense[seg],b=dense[seg+1],f=b.i===a.i?0:(i-a.i)/(b.i-a.i);
    close[i]=a.v+(b.v-a.v)*Math.min(1,Math.max(0,f))+(rnd()-.5)*w0*.05*noise;
  }
  const breakAt=lastI+3;let prev=close[lastI];
  for(let i=lastI+1;i<total;i++){
    if(i<breakAt)prev+=(rnd()-.5)*w0*.06;else if(i===breakAt)prev=neck-sign*w0*.45;else prev+=-sign*w0*(.05+rnd()*.12)+(rnd()-.5)*w0*.08;
    close[i]=prev;
  }
  for(let i=0;i<total;i++){
    open[i]=i===0?close[0]:close[i-1];
    const wick=(.1+rnd()*.35)*w0*.08;
    high[i]=Math.max(open[i],close[i])+wick;low[i]=Math.min(open[i],close[i])-wick;
  }
  const bars=Array.from({length:total},(_,i)=>[i*STEP_MS,open[i],high[i],low[i],close[i],100+rnd()*40] as [number,number,number,number,number,number]);
  return {bars,family:'huzi-head-shoulders',direction:top?'bearish':'bullish',first:vertices[0].i,last:vertices.at(-1)!.i,breakout:breakAt,
    upper:()=>neck,lower:()=>neck,width0:w0,touches:vertices.map(v=>v.i)};
}

/** Column view over planted / hand-built bars, cut after `cut` candles (default: a few bars past the breakout). */
export function viewOf(bars:Planted['bars'],cut=bars.length){
  const rows=bars.slice(0,cut),n=rows.length,c:Record<string,Float64Array>={};
  ['time','open','high','low','close','volume'].forEach((name,j)=>{c[name]=Float64Array.from(rows.map(r=>r[j]));});
  return {length:n,closedLength:n-1,intervalMs:STEP_MS,col:(x:string)=>c[x]} as never;
}
/** A structure preceded by an advance or a decline, so continuation / reversal can be called. */
export function withApproach(kind:PlantedKind,seed:number,approach:'up'|'down',breakout:'up'|'down'){
  const t=plant({kind,length:120,seed,noise:.3,prefix:300,breakout});
  const base=t.bars[t.first][4],w=t.width0,k=(approach==='up'?-1:1)*(3.2*w)/100;
  for(let i=t.first-1;i>=0;i--)t.bars[i][4]=base+k*Math.min(t.first-i,100)+Math.sin(i*1.7)*w*.02;
  for(let i=0;i<t.first;i++){const open=i===0?t.bars[0][4]:t.bars[i-1][4],c=t.bars[i][4];t.bars[i][1]=open;t.bars[i][2]=Math.max(open,c)+w*.01;t.bars[i][3]=Math.min(open,c)-w*.01;}
  return t;
}

/** An impulse (the flag's pole) that ends exactly at the structure's first touch. The pole is steep and efficient,
 * `multiple` × the structure width tall, and runs `poleBars` candles. `side` says which line the first touch lies on. */
export function withPole(kind:'down-channel'|'up-channel',seed:number,breakout:'up'|'down',poleBars=30,multiple=4.6,noise=.3,length=120){
  const t=plant({kind,length,seed,noise,prefix:300,breakout});
  const first=t.bars[t.first],onUpper=Math.abs(first[2]-t.upper(t.first))<Math.abs(first[3]-t.lower(t.first));
  // Bull pole ends on a top (upper touch first); bear pole ends on a bottom.
  const bullPole=onUpper,base=bullPole?t.upper(t.first):t.lower(t.first),w=t.width0,start=base+(bullPole?-1:1)*multiple*w;
  const from=t.first-poleBars;
  for(let i=0;i<t.first;i++){
    const c=i<from?start+Math.sin(i*1.3)*w*.03:start+(base-start)*((i-from+1)/poleBars)*(i===t.first-1?.985:1)+Math.sin(i*1.9)*w*.02;
    const open=i===0?c:t.bars[i-1][4];t.bars[i][4]=c;t.bars[i][1]=open;t.bars[i][2]=Math.max(open,c)+w*.012;t.bars[i][3]=Math.min(open,c)-w*.012;
  }
  return {...t,bullPole};
}

/** Long spikes that stab through a boundary without a body following them, as on real charts where the drawn
 * line ignores an outlier wick. `share` is the spike's length as a share of the structure's own height. */
export function withSpikes(t:Planted,share:number,count=2){
  const rnd=mulberry32(t.first*31+count),height=1.9*t.width0,quiet=t.touches;
  let done=0;
  for(let guard=0;guard<200&&done<count;guard++){
    const i=t.first+8+Math.floor(rnd()*(t.last-t.first-16));
    if(quiet.some(q=>Math.abs(q-i)<=3))continue;
    const up=done%2===0;
    if(up)t.bars[i][2]=Math.max(t.bars[i][2],t.upper(i)+share*height);else t.bars[i][3]=Math.min(t.bars[i][3],t.lower(i)-share*height);
    done++;
  }
  return t;
}
