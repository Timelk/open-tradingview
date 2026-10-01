/** Independent acceptance fixtures. This file deliberately has no production
 * imports. It creates and labels geometry from a written rule sheet before any
 * detector executes. These are engineering ground truth, not market accuracy. */
export type BenchmarkCase={id:string;label:string;module:string;rows:number[][];params:Record<string,unknown>;expected:boolean;oracle:string[];variant:string;anchorTimes?:number[];targetTime?:number;earliestKnownAt?:number};
const epoch=Date.UTC(2026,0,5),step=60_000,tolerance=.04;
let noiseSeed=0x19283746;const seeded=()=>{noiseSeed=(Math.imul(noiseSeed,1664525)+1013904223)>>>0;return noiseSeed/4294967296;};
const band=(v:number,lo:number,hi=lo)=>Number.isFinite(v)&&v>=lo*(1-tolerance)-1e-9&&v<=hi*(1+tolerance)+1e-9;
const harmonicTemplates:Record<string,number[]>={Gartley:[100,200,138.2,183.2,121.4],Bat:[100,200,150,180,111.4],Butterfly:[100,200,121.4,173,73],Crab:[100,200,140,190,38.2],'Deep Crab':[100,200,110,180,38.2],Shark:[100,200,160,220,111.4],Cypher:[100,200,150,230,127.82],'AB=CD':[200,140,180,120],'Three Drives':[200,160,184.72,153.3256,172.7273392,148.087130416]};
const normalize=(v:number[])=>v.at(-1)!<v.at(-2)!?v:v.map(p=>-p);
export function harmonicOracle(family:string,raw:number[]):boolean{
 const p=normalize(raw);
 if(family==='AB=CD'){const [a,b,c,d]=p,ab=a-b,bc=c-b,cd=c-d;return ab>0&&bc>0&&cd>0&&c<a&&d<b&&band(bc/ab,.382,.886)&&band(cd/ab,1)&&band(cd/bc,1.13,2.618);}
 if(family==='Three Drives'){const [o,d1,a,d2,b,d3]=p,v1=o-d1,r1=a-d1,v2=a-d2,r2=b-d2,v3=b-d3;return Math.min(v1,r1,v2,r2,v3)>0&&o>a&&a>b&&d1>d2&&d2>d3&&band(r1/v1,.618,.786)&&band(r2/v2,.618,.786)&&[1.13,1.27,1.618].some(v=>band(v2/r1,v)&&band(v3/r2,v));}
 if(family==='Shark'){const [o,x,a,b,c]=p,ox=x-o,xa=x-a,ab=b-a,bc=b-c;return ox>0&&xa>0&&a>o&&b>x&&c<a&&band(ab/xa,1.13,1.618)&&band(bc/ab,1.618,2.24)&&band((x-c)/ox,.886,1.13);}
 const [x,a,b,c,d]=p,xa=a-x,ab=a-b,bc=c-b,cd=c-d;
 if(family==='Cypher')return xa>0&&ab>0&&b>x&&c>a&&d>x&&d<b&&band(ab/xa,.382,.618)&&band((c-x)/xa,1.13,1.414)&&band((c-d)/(c-x),.786);
 if(!(xa>0&&ab>0&&bc>0&&cd>0&&b>x&&c<a&&d<b))return false;
 const r={b:ab/xa,c:bc/ab,d:(a-d)/xa,bc:cd/bc,ab:cd/ab};
 if(!band(r.c,.382,.886))return false;
 switch(family){
  case 'Gartley':return d>x&&band(r.b,.618)&&band(r.d,.786)&&band(r.bc,1.13,1.618)&&band(r.ab,1);
  case 'Bat':return d>x&&r.b<.618&&band(r.b,.382,.618)&&band(r.d,.886)&&band(r.bc,1.618,2.618)&&r.ab>=1*(1-tolerance);
  case 'Butterfly':return d<x&&band(r.b,.786)&&band(r.d,1.27)&&band(r.bc,1.618,2.618)&&band(r.ab,1,1.27);
  case 'Crab':return d<x&&band(r.b,.382,.618)&&band(r.d,1.618)&&band(r.bc,2.618,3.618)&&r.ab>=1*(1-tolerance);
  case 'Deep Crab':return d<x&&r.b>=.886&&r.b<1&&band(r.d,1.618)&&band(r.bc,2,3.618)&&r.ab>=1*(1-tolerance);
 }
 return false;
}
function linear(anchors:number[],tail:number[],jitter=0):{rows:number[][];times:number[]}{
 const values=[anchors[0]+(anchors[1]-anchors[0])*.15,anchors[0]+(anchors[1]-anchors[0])*.1,anchors[0]+(anchors[1]-anchors[0])*.05],times:number[]=[];
 for(let leg=0;leg<anchors.length;leg++){times.push(epoch+values.length*step);values.push(anchors[leg]);if(leg<anchors.length-1)for(let i=1;i<12;i++)values.push(anchors[leg]+(anchors[leg+1]-anchors[leg])*i/12+jitter*Math.sin((leg*12+i)*1.47));}
 values.push(...tail);return {rows:values.map((v,i)=>[epoch+i*step,v,v,v,v,100]),times};
}
const mirrorRows=(rows:number[][])=>rows.map(([t,o,h,l,c,v])=>[t,700-o,700-l,700-h,700-c,v]);
const scaleRows=(rows:number[][],scale:number,shift=0)=>rows.map(([t,o,h,l,c,v])=>[t,shift+o*scale,shift+h*scale,shift+l*scale,shift+c*scale,v]);
const bar=(index:number,o:number,h:number,l:number,c:number)=>[epoch+index*step,o,h,l,c,100];
export function buildBenchmarkCases():BenchmarkCase[]{
 const cases:BenchmarkCase[]=[];
 noiseSeed=0x19283746;
 for(const [family,base] of Object.entries(harmonicTemplates))for(let sample=0;sample<24;sample++){
  let p=[...base],variant=sample<4?'canonical-affine':sample<8?'seeded-interior-perturbation':sample<12?'terminal-boundary':'ratio-negative';
  if(sample>=8&&sample<12){const factor=sample%2===0?1.038:1.075;p[p.length-1]=p.at(-2)!-(p.at(-2)!-p.at(-1)!)*factor;}
  if(sample>=12&&sample<16)p[p.length-1]=p.at(-2)!-(p.at(-2)!-p.at(-1)!)*(sample%2?1.35:.65);
  if(sample>=16){const amplitude=Math.max(...base)-Math.min(...base);p=base.map(v=>v+(seeded()-.5)*amplitude*.07);variant='seeded-independent-anchor-perturbation';}
  const expected=harmonicOracle(family,p),tail=Array.from({length:8},(_,i)=>p.at(-1)!+(p.at(-2)!-p.at(-1)!)*.035*(i+1)),generated=linear(p,tail,sample>=4&&sample<8?.006:0),scale=.7+(sample%4)*.3;
  let rows=scaleRows(generated.rows,scale,300);if(sample%2)rows=mirrorRows(rows);
  cases.push({id:`harmonic-${family.replace(/\W/g,'')}-${sample}`,label:family,module:'harmonic',rows,params:{family,pivotStrength:2,tolerance:.04,multiScale:false,structuralSwings:false,includeAlternateABCD:false,maxPatterns:1000,showInvalidated:true},expected,oracle:['Pre-registered ratio sheet; signed leg measurements independent of production imports.',`Anchor geometry: ${p.join(', ')}`,`Allowed measurement tolerance ${tolerance}; Three Drives uses equal-duration legs.`],variant,anchorTimes:generated.times,targetTime:generated.times.at(-1),earliestKnownAt:generated.times.at(-1)!+3*step});
 }
 const classics=[
  {label:'Head Shoulders',family:'huzi-head-shoulders',pick:'头肩形',good:[100,114,88,114,101],bad:[100,114,105,114,101],breakout:119},
  {label:'Double',family:'huzi-double',pick:'双底 / 双顶',good:[100,114,101],bad:[100,114,108],breakout:119},
  {label:'Triangle',family:'huzi-triangle',pick:'三角形',good:[95,120,101,120,107],bad:[95,120,95,120,95],breakout:126},
  {label:'Wedge',family:'huzi-wedge',pick:'楔形',good:[100,120,96,110,92],bad:[100,120,90,110,80],breakout:126},
  {label:'Flag',family:'huzi-flag',pick:'通道 / 旗形',good:[70,130,120,126,116,122],bad:[115,130,120,126,116,122],breakout:139},
 ];
 for(const spec of classics)for(let sample=0;sample<16;sample++){
  const positive=sample<8,p=[...(positive?spec.good:spec.bad)],last=p.at(-1)!,prior=p.at(-2)!,away=last+(prior-last)*.25;
  const tail=[...Array.from({length:4},(_,i)=>last+(away-last)*(i+1)/4),...Array.from({length:14},(_,i)=>away+(spec.breakout-away)*(i+1)/14),spec.breakout,spec.breakout];
  let {rows,times}=linear(p,tail,sample%4===3?.008:0);rows=scaleRows(rows,.8+(sample%4)*.2,50);if(sample%2)rows=mirrorRows(rows);
  cases.push({id:`classic-${spec.label.replace(/\s/g,'')}-${sample}`,label:spec.label,module:'classic',rows,params:{family:spec.pick,pivotStrength:2,tolerance:.04,multiScale:false,structuralSwings:false,showInvalidated:true,maxPatterns:1000},expected:positive,variant:positive?'geometric-affine-perturbation':'single-rule-counterexample',oracle:[`Independent construction: ${spec.label}, target family ${spec.family}.`,positive?'Symmetric contacts/parallel or convergent analytic boundaries; later neckline/boundary break.':'One defining relation intentionally removed: dominant head / equal bottoms / convergence / wedge slope difference / directional pole.'],targetTime:times.at(-1)});
 }
 for(const label of ['Pin Bar','Engulfing','Doji','Morning Star'])for(let sample=0;sample<16;sample++){
  const positive=sample<8,rows=Array.from({length:30},(_,i)=>bar(i,115-i*.3+.2,115-i*.3+.7,115-i*.3-.7,115-i*.3)),index=rows.length;
  if(label==='Pin Bar')rows.push(positive?bar(index,105,106,99,105.7):bar(index,105,107,104,106.5));
  if(label==='Doji')rows.push(positive?bar(index,105,108,102,105.25):bar(index,105,108,102,107));
  if(label==='Engulfing'){rows.push(bar(index,106,106.3,103.7,104));rows.push(positive?bar(index+1,103.8,107.4,103.5,107.2):bar(index+1,104.5,106,104,105.5));}
  if(label==='Morning Star'){rows.push(bar(index,109,109.2,103.8,104));rows.push(bar(index+1,103.7,104,103,103.8));rows.push(positive?bar(index+2,104,108,103.8,107.5):bar(index+2,104,105.5,103.8,105));}
  const target=rows.at(-1)![0];let data=scaleRows(rows,.75+(sample%4)*.25,20);if(sample%2&&label!=='Morning Star')data=mirrorRows(data);
  cases.push({id:`candle-${label.replace(/\s/g,'')}-${sample}`,label,module:'candlestick',rows:data,params:{family:label,requireTrend:false,maxObservations:300},expected:positive,targetTime:target,earliestKnownAt:target+step,variant:positive?'manual-body-wick-positive':'manual-body-wick-negative',oracle:[`${label}: hand-labelled final closed candle/three-candle body relation.`,`No trend profitability inference; positive=${positive}.`]});
 }
 for(let sample=0;sample<16;sample++){
  const expected=sample<8,p=expected?[100,120,95,105,88.5]:[100,120,95,116,88.5],{rows,times}=linear(p,Array.from({length:12},(_,i)=>88.5+i*1.8));let data=scaleRows(rows,1,40);if(sample%2)data=mirrorRows(data);
  cases.push({id:`wolfe-${sample}`,label:'Wolfe',module:'wolfe',rows:data,params:{pivotStrength:2,multiScale:false,maxObservations:300},expected,anchorTimes:times,targetTime:times.at(-1),variant:expected?'convergent-five-point':'nonconvergent-upper-edge',oracle:['Independent 1-3 slope -5/24, 2-4 slope -15/24 for positive; negative upper slope -4/24 fails convergence.','Point 5 crosses lower line before apex; later close returns inside.']});
 }
 for(let sample=0;sample<16;sample++){
  const expected=sample<8,p=expected?[100,120,110,150,130,160]:sample%2?[100,130,125,140,135,170]:[100,120,110,150,119,160],{rows,times}=linear(p,Array.from({length:8},(_,i)=>p.at(-1)!-(i+1)*.5));let data=scaleRows(rows,1,40);if(sample%2)data=mirrorRows(data);
  cases.push({id:`elliott-${sample}`,label:'Elliott hard rules',module:'elliott',rows:data,params:{pivotStrength:2,multiScale:false,requireSubwaves:false,showABC:false,showDeveloping:false,maxObservations:300},expected,anchorTimes:times,targetTime:times.at(-1),variant:expected?'hard-rule-skeleton-positive':'wave-3-shortest-or-wave-4-overlap',oracle:['This stratum tests declared ordinary impulse hard rules only; it does NOT label full nested Elliott truth.','2 retracement <100%; wave3 beyond wave1 and not shortest; wave4 avoids wave1 territory.']});
 }
 for(let sample=0;sample<16;sample++){
  const expected=sample<8,prices=expected?[100,105,100,105,100,105,100,105]:[100,115,111,125,121,135,131,145],rows=prices.map((v,i)=>bar(i,v,v,v,v));
  cases.push({id:`point-figure-${sample}`,label:'P&F horizontal count',module:'point-figure',rows:scaleRows(rows,sample%2?.5:1),params:{boxSize:sample%2?.5:1,reversal:3,countColumns:9},expected,variant:expected?'hand-counted-common-row':'disjoint-trending-columns',oracle:[expected?'Six completed alternating columns share one count row; extension = 6 × box × 3.':'Columns are disjoint at any common horizontal row, so no congestion count.']});
 }
 for(let sample=0;sample<16;sample++){
  const expected=sample<8,rows=Array.from({length:74},(_,i)=>bar(i,110+Math.sin(i*.45)-.2,110+Math.sin(i*.45)+.5,110+Math.sin(i*.45)-.5,110+Math.sin(i*.45)));
  rows[30]=bar(30,110,120,100,110);
  rows[60]=bar(60,110,111,109,110);rows[61]=bar(61,112,113,111,112);rows[62]=bar(62,113,114,112,113);rows[63]=bar(63,110,111,109,110);rows[64]=bar(64,108,109,107,108);
  rows[65]=bar(65,107,108,sample>=8&&sample<12?101:99,104);
  rows[66]=sample>=12?bar(66,104,113.5,103.8,113):bar(66,104,122,103.8,121);
  rows[67]=bar(67,121,122.5,119,122);for(let i=68;i<74;i++)rows[i]=bar(i,120,121,119,120);
  let data=sample%2?mirrorRows(rows):rows;
  cases.push({id:`ict-${sample}`,label:'ICT sweep-MSS-FVG',module:'ict',rows:data,params:{timeZone:'UTC',sessionStart:0,sessionEnd:60,killzoneStart:60,killzoneEnd:120,reference:'session',entryModel:'fvg',pivotStrength:2,displacementAtr:1,breakoutAtr:0,minGapAtr:.1,maxObservations:300},expected,targetTime:epoch+65*step,variant:expected?'prelabelled-event-chain':sample<12?'missing-session-sweep':'missing-displacement-MSS',oracle:['Prior complete UTC session range is [100,120]. Known local reaction high=114 before sweep.','Positive: row65 sweeps session low and recovers; row66 displaces above prior high; row67 low119 > row65 high108 gives closed FVG.','Negative removes sweep or qualifying displacement/MSS; mirrored cases reverse all inequalities.']});
 }
 return cases;
}
