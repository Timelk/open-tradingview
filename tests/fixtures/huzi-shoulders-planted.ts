import {mulberry32,STEP_MS} from './huzi-synthetic';

/**
 * Head and shoulders with complex shoulders, planted at a KNOWN place. Price runs through named anchors in
 * straight legs (small seeded noise on the legs only), so every pivot sits where the plan says. Everything is
 * drawn as a top and mirrored for a bottom. Values: neckline ≈ 100, head 125, shoulders ≈ 112.
 */
export type ShoulderSide='simple'|'double-peak';
export type SubStructure='wedge'|'up-channel'|'down-channel'|'triangle';
export interface ShoulderPlan {
  top?:boolean;
  /** 'double-peak' on the left is L1 (the higher peak), a dip, L2, then N1. */
  left?:ShoulderSide;
  /** 'double-peak' on the right is R1, a dip, R2 (the higher peak, the last pivot). A sub-structure is drawn between two straight boundaries. */
  right?:ShoulderSide|SubStructure;
  /** Where the price goes after the last pivot: through the neckline, out of the sub-structure, or up through the head. */
  breakout?:'neckline'|'down'|'up'|'head'|'none';
  /** Value of N2 (default 100); a different N2 tilts the neckline. */
  neck2?:number;
  /** Value of the left dip `a` of a double-peak left shoulder. */
  leftDip?:number;
  /** Right-shoulder peaks: R1 and R2 for a double peak (default 111 / 113), R for a simple shoulder (default 112). */
  peaks?:[number,number];
  /** Put the right shoulder above the head. */
  shoulderAboveHead?:boolean;
  seed?:number;noise?:number;prefix?:number;tail?:number;
}
export interface PlantedShoulders {
  bars:Array<[number,number,number,number,number,number]>;
  top:boolean;
  /** Bar indexes of the named anchors. */
  marks:Record<string,number>;
  /** Bar index of the last shoulder pivot, of the breakout close, and the head's price extreme. */
  last:number;breakout:number;head:number;
}
type Anchor=[number,number];
const CEILING=250;

interface Lines {upper:(t:number)=>number;lower:(t:number)=>number;times:number[];kinds:Array<'high'|'low'>}
/** The right shoulder as two straight boundaries with alternating touches; τ = 0 is N2 (a low). */
function sub(kind:SubStructure):Lines {
  switch(kind){
    case 'wedge':return {upper:t=>105.6+.115*t,lower:t=>100+.18*t,times:[0,12,20,30,38,48],kinds:['low','high','low','high','low','high']};
    case 'up-channel':return {upper:t=>106+.12*t,lower:t=>100+.12*t,times:[0,12,22,32,42,52],kinds:['low','high','low','high','low','high']};
    case 'down-channel':return {upper:t=>113-.06*t,lower:t=>101-.06*t,times:[0,12,22,34,44,56],kinds:['low','high','low','high','low','high']};
    default:return {upper:t=>112-.09*t,lower:t=>100+.08*t,times:[0,12,22,34,44,56],kinds:['low','high','low','high','low','high']};
  }
}

export function plantShoulders(plan:ShoulderPlan={}):PlantedShoulders {
  const top=plan.top!==false,seed=plan.seed??1,noise=plan.noise??0,rnd=mulberry32(seed*7919+13);
  const marks:Record<string,number>={};
  const anchors:Anchor[]=[];let t=0;
  const go=(name:string|undefined,dt:number,value:number)=>{t+=dt;anchors.push([t,value]);if(name)marks[name]=t;return t;};
  const prefix=plan.prefix??30;
  anchors.push([0,82]);t=0;
  go(undefined,prefix-8,90);
  const left=plan.left??'simple';
  if(left==='double-peak'){
    go('L',8,113);go('a',9,plan.leftDip??100.4);go('L2',9,107);go('N1',10,100);
  }else{go('L',8,112);go('N1',14,100);}
  go('H',20,125);
  const right=plan.right??'simple',neck2=plan.neck2??100;
  const [p1,p2]=plan.peaks??(right==='double-peak'?[111,113]:[112,112]);
  let lastPivot:number;
  let lines:Lines|undefined;
  if(right==='simple'){
    go('N2',18,neck2);lastPivot=go('R',18,plan.shoulderAboveHead?128:p1);
  }else if(right==='double-peak'){
    go('N2',18,neck2);go('R1',14,p1);go('x',8,104.5);lastPivot=go('R',10,plan.shoulderAboveHead?128:p2);
  }else{
    lines=sub(right);
    const t0=t+16;
    lines.times.forEach((tau,k)=>{
      const value=lines!.kinds[k]==='high'?lines!.upper(tau):lines!.lower(tau);
      go(k===0?'N2':`s${k}`,t0+tau-t,value);
    });
    lastPivot=t;marks.R=t;
  }
  marks.last=lastPivot;
  const breakout=plan.breakout??(lines?'down':'neckline');
  let breakAt=lastPivot;
  const origin=marks.N2,middle=(bar:number)=>lines?(lines.upper(bar-origin)+lines.lower(bar-origin))/2:106;
  if(breakout==='head'){
    go(undefined,5,110);breakAt=go('break',7,130);go(undefined,5,132);
  }else if(breakout==='none'){
    go(undefined,plan.tail??8,middle(t+8));
  }else if(lines){
    go(undefined,5,middle(t+5));
    const bar=t+5,edge=breakout==='down'?lines.lower(bar-origin)-4:lines.upper(bar-origin)+4;
    breakAt=go('break',5,edge);
    go(undefined,9,breakout==='down'?edge-8:Math.min(edge+6,119));
  }else{
    go(undefined,6,105);breakAt=go('break',6,92);go(undefined,10,84);
  }
  // Straight legs between anchors, seeded noise only between them.
  const close:number[]=[];
  let seg=0;
  for(let i=0;i<=anchors.at(-1)![0];i++){
    while(seg<anchors.length-2&&i>anchors[seg+1][0])seg++;
    const [a,pa]=anchors[seg],[b,pb]=anchors[seg+1];
    const onAnchor=anchors.some(([x])=>x===i);
    close.push(pa+(pb-pa)*(i-a)/(b-a)+(onAnchor?0:(rnd()-.5)*noise));
  }
  const flip=(value:number)=>top?value:CEILING-value;
  const bars=close.map((c,i)=>{
    const o=i?close[i-1]:c,hi=Math.max(o,c)+.1,lo=Math.min(o,c)-.1;
    return (top?[i*STEP_MS,o,hi,lo,c,100]:[i*STEP_MS,flip(o),flip(lo),flip(hi),flip(c),100]) as PlantedShoulders['bars'][number];
  });
  return {bars,top,marks,last:lastPivot,breakout:breakAt,head:marks.H};
}

/** A single wick beyond the head (a close stays inside), `bars` after the last shoulder pivot. */
export function wickThroughHead(p:PlantedShoulders,bars=3,beyond=2):void {
  const i=p.last+bars,row=p.bars[i],head=p.top?125:CEILING-125;
  if(p.top)row[2]=head+beyond;else row[3]=head-beyond;
}
