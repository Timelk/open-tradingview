import type {PatternMatch,PatternPoint,PatternGuide} from './types';

const number=(value:number)=>Number.isFinite(value);
const exactPrice=(a:number,b:number)=>number(a)&&number(b)&&Math.abs(a-b)<=Math.max(1e-8,Math.max(Math.abs(a),Math.abs(b))*1e-10);
const samePoint=(a:PatternPoint,b:PatternPoint)=>a.time===b.time&&exactPrice(a.value,b.value);
const lexical=(a:string,b:string)=>a<b?-1:a>b?1:0;
const latestKnowledge=(p:PatternMatch)=>Math.max(p.confirmedAt,p.invalidatedAt??0,p.resolution?.knownAt??0,...(p.events??[]).map(e=>e.knownAt).filter(number));
const height=(p:PatternMatch)=>Math.max(...p.points.map(point=>point.value))-Math.min(...p.points.map(point=>point.value));
const breakout=(p:PatternMatch)=>p.events?.find(e=>e.kind==='breakout');
function bucket(p:PatternMatch):string {
  const event=breakout(p);
  return JSON.stringify([p.family,p.direction,p.name,p.confirmedAt,p.formation??'complete',p.points.length,
    event?[event.time,event.knownAt]:null,p.id.endsWith(':continuation')]);
}
function validGeometry(p:PatternMatch):boolean {
  return p.points.length>=3&&p.points.every(point=>number(point.time)&&number(point.value))
    &&number(p.confirmedAt)&&number(p.invalidation)&&number(p.zone.low)&&number(p.zone.high)
    &&p.targets.length>0&&p.targets.every(number);
}
function guideAt(guide:PatternGuide,time:number):number {
  const [a,b]=guide.points;
  return b.time===a.time?a.value:a.value+(b.value-a.value)*(time-a.time)/(b.time-a.time);
}
function sameRiskAndProjection(a:PatternMatch,b:PatternMatch,tolerance:number):boolean {
  const near=(x:number,y:number)=>number(x)&&number(y)&&Math.abs(x-y)<=tolerance;
  if(!near(a.invalidation,b.invalidation)||!near(a.zone.low,b.zone.low)||!near(a.zone.high,b.zone.high)
    ||a.targets.length!==b.targets.length||a.targets.some((target,i)=>!near(target,b.targets[i])))return false;
  const ae=breakout(a),be=breakout(b);
  if(!!ae!==!!be||ae&&be&&(!exactPrice(ae.value,be.value)||!near(ae.boundary,be.boundary)))return false;
  const ag=a.guides??[],bg=b.guides??[];
  if(ag.length!==bg.length)return false;
  return ag.every(guide=>{
    const counterpart=bg.find(other=>other.role===guide.role);if(!counterpart)return false;
    // Compare the actual guide line, not its later lifecycle-dependent endpoint.
    return near(guideAt(guide,a.points[0].time),guideAt(counterpart,a.points[0].time))
      &&near(guideAt(guide,a.confirmedAt),guideAt(counterpart,a.confirmedAt));
  });
}
function equivalent(a:PatternMatch,b:PatternMatch):boolean {
  if(!validGeometry(a)||!validGeometry(b)||bucket(a)!==bucket(b))return false;
  const range=Math.min(height(a),height(b));
  if(!(range>0))return false;
  // This is 2% of the STRUCTURE height, never 2% of the instrument price.
  const tolerance=Math.max(1e-8,range*.02);
  if(!sameRiskAndProjection(a,b,tolerance))return false;
  if(a.points.every((point,i)=>samePoint(point,b.points[i])))return true;
  // Other families retain every distinct internal anchor and leg geometry.
  if(a.family!=='huzi-double'||a.points.length!==3||!breakout(a)||!breakout(b))return false;
  const [a0,a1,a2]=a.points,[b0,b1,b2]=b.points;
  const ordered=(p:PatternMatch)=>p.points[0].time<p.points[1].time&&p.points[1].time<p.points[2].time&&p.points[2].time<p.confirmedAt;
  if(!ordered(a)||!ordered(b))return false;
  if(samePoint(a0,b0)&&samePoint(a2,b2)){
    // Same two exact extrema with a nearby plateau-neckline sample.
    const span=Math.min(a2.time-a0.time,b2.time-b0.time);
    return Math.abs(a1.time-b1.time)<=span*.1&&Math.abs(a1.value-b1.value)<=tolerance;
  }
  // A later near-flat B2/T2 refines the same first extremum + exact neckline,
  // and produces the SAME breakout, risk and targets. Preserve it only once.
  // Independent second extrema with a different neckline/confirmation survive.
  return samePoint(a0,b0)&&samePoint(a1,b1)&&Math.abs(a2.value-b2.value)<=tolerance;
}

/** Display only: call separately for each study instance BEFORE display-budget
 * selection, and reuse these representatives for both canvas and the row list.
 * Raw detection, evidence tiles, saved studies and research signals are untouched.
 * Selected geometry wins; otherwise prefer a valid/latest terminal refinement.
 * Complete-link grouping avoids A≈B≈C transitively erasing a distinct A/C pair. */
export function deduplicatePatternDisplay(patterns:readonly PatternMatch[],selectedId?:string):PatternMatch[]{
  const ranked=[...patterns].sort((a,b)=>Number(b.id===selectedId)-Number(a.id===selectedId)
    ||Number(b.status==='confirmed')-Number(a.status==='confirmed')
    ||Number(!b.dataWarning)-Number(!a.dataWarning)
    ||(b.points.at(-1)?.time??0)-(a.points.at(-1)?.time??0)
    ||latestKnowledge(b)-latestKnowledge(a)||lexical(a.id,b.id));
  const buckets=new Map<string,PatternMatch[][]>();
  for(const pattern of ranked){
    const key=bucket(pattern),groups=buckets.get(key)??[];
    const group=groups.find(members=>members.every(member=>equivalent(member,pattern)));
    if(group)group.push(pattern);else groups.push([pattern]);
    buckets.set(key,groups);
  }
  return [...buckets.values()].flatMap(groups=>groups.map(group=>group[0]))
    .sort((a,b)=>b.confirmedAt-a.confirmedAt||lexical(a.id,b.id));
}
