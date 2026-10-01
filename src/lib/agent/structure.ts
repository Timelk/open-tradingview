import type {ColumnView} from '../core/types';
import {formatTime,num,type BarRange,type TimeFormat} from './anchors';

/** Deterministic market structure from the loaded bars at full precision, so
 * a model never has to find pivots or average ranges by reading hundreds of
 * numbers (slow, and the usual source of misplaced lines). */
export interface Pivot {index:number;type:'high'|'low';price:number}
export interface StructureOptions {strength:number;maxPivots:number;tolerance:number;maxLevels:number;format:TimeFormat}

/** Wilder ATR across the range; the first true range uses the previous close when loaded. */
export function averageTrueRange(cols:ColumnView,range:BarRange,period=14):number {
  const high=cols.col('high'),low=cols.col('low'),close=cols.col('close');
  let atr=NaN,count=0,sum=0;
  for(let i=range.start;i<range.end;i++){
    const previous=i>0?close[i-1]:close[i],tr=Math.max(high[i]-low[i],Math.abs(high[i]-previous),Math.abs(low[i]-previous));
    if(count<period){sum+=tr;count++;if(count===period)atr=sum/period;}else atr=(atr*(period-1)+tr)/period;
  }
  return count<period?(count?sum/count:NaN):atr;
}
/** Confirmed fractal pivots: strictly above/below the `strength` bars on the
 * left, not exceeded by the `strength` bars on the right (first of equal extremes wins). */
export function findPivots(cols:ColumnView,range:BarRange,strength:number):Pivot[] {
  const high=cols.col('high'),low=cols.col('low'),out:Pivot[]=[];
  for(let i=range.start+strength;i<range.end-strength;i++){
    let isHigh=true,isLow=true;
    for(let j=i-strength;j<=i+strength&&(isHigh||isLow);j++){
      if(j===i)continue;
      if(j<i?high[j]>=high[i]:high[j]>high[i])isHigh=false;
      if(j<i?low[j]<=low[i]:low[j]<low[i])isLow=false;
    }
    if(isHigh)out.push({index:i,type:'high',price:high[i]});
    if(isLow)out.push({index:i,type:'low',price:low[i]});
  }
  return out;
}
/** Least squares on closes: slope per bar, fit quality and a ±2σ channel. */
export function regression(cols:ColumnView,range:BarRange){
  const close=cols.col('close'),n=range.end-range.start;if(n<3)return null;
  let sx=0,sy=0,sxx=0,sxy=0;
  for(let k=0;k<n;k++){const y=close[range.start+k];sx+=k;sy+=y;sxx+=k*k;sxy+=k*y;}
  const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx),intercept=(sy-slope*sx)/n,mean=sy/n;
  let residual=0,total=0;for(let k=0;k<n;k++){const y=close[range.start+k];residual+=(y-intercept-slope*k)**2;total+=(y-mean)**2;}
  const sigma=Math.sqrt(residual/n),r2=total?1-residual/total:0;
  return {slope,intercept,sigma,r2,n,mean};
}
export function computeStructure(cols:ColumnView,range:BarRange,intervalMs:number,options:StructureOptions){
  const t=(index:number)=>formatTime(cols.col('time')[index],options.format),n=cols.length,count=range.end-range.start;
  if(count<2)return {range:{bars:count},note:'range has fewer than 2 bars'};
  const high=cols.col('high'),low=cols.col('low'),close=cols.col('close'),open=cols.col('open');
  let top=range.start,bottom=range.start;
  for(let i=range.start;i<range.end;i++){if(high[i]>high[top])top=i;if(low[i]<low[bottom])bottom=i;}
  const last=range.end-1,atr=averageTrueRange(cols,range),fit=regression(cols,range);
  const pivots=findPivots(cols,range,options.strength),previous:Partial<Record<'high'|'low',Pivot>>={};
  const labelled=pivots.map((pivot,i)=>{
    const prior=previous[pivot.type];previous[pivot.type]=pivot;
    const label=!prior?null:pivot.type==='high'?(pivot.price>prior.price?'HH':pivot.price<prior.price?'LH':'EH'):(pivot.price<prior.price?'LL':pivot.price>prior.price?'HL':'EL');
    const opposite=[...pivots.slice(0,i)].reverse().find(item=>item.type!==pivot.type);
    return {...pivot,label,leg:opposite?Math.abs(pivot.price-opposite.price):null};
  });
  // Pivot clusters within tolerance × ATR become levels; score favours touches, then recency.
  const band=Math.max(1e-12,(Number.isFinite(atr)?atr:(high[top]-low[bottom])/20)*options.tolerance),sorted=[...pivots].sort((a,b)=>a.price-b.price);
  const clusters:Pivot[][]=[];
  for(const pivot of sorted){const current=clusters.at(-1),mean=current?current.reduce((sum,p)=>sum+p.price,0)/current.length:NaN;if(current&&pivot.price-mean<=band)current.push(pivot);else clusters.push([pivot]);}
  const price=close[last];
  const levels=clusters.map(group=>{
    const mean=group.reduce((sum,p)=>sum+p.price,0)/group.length,newest=Math.max(...group.map(p=>p.index)),oldest=Math.min(...group.map(p=>p.index));
    return {group,mean,newest,oldest,score:group.length+(newest-range.start)/Math.max(1,count)};
  }).filter(level=>level.group.length>=2||level.newest>=range.end-Math.max(20,count/4))
    .sort((a,b)=>b.score-a.score).slice(0,options.maxLevels).sort((a,b)=>b.mean-a.mean)
    .map(level=>({price:num(level.mean),low:num(Math.min(...level.group.map(p=>p.price))),high:num(Math.max(...level.group.map(p=>p.price))),touches:level.group.length,
      highs:level.group.filter(p=>p.type==='high').length,lows:level.group.filter(p=>p.type==='low').length,first:t(level.oldest),last:t(level.newest),
      side:level.mean>price?'resistance':'support',distancePct:num((level.mean/price-1)*100),distanceAtr:Number.isFinite(atr)?num((level.mean-price)/atr):null}));
  const above=levels.filter(level=>level.side==='resistance').at(-1),below=levels.find(level=>level.side==='support');
  const channel=fit&&{slopePerBar:num(fit.slope),slopePctPer100Bars:num(fit.slope*100/fit.mean*100),r2:num(fit.r2),sigma:num(fit.sigma),
    start:{time:t(range.start),value:num(fit.intercept)},end:{time:t(last),value:num(fit.intercept+fit.slope*(count-1))},
    direction:Math.abs(fit.slope*count)<fit.sigma?'flat':fit.slope>0?'up':'down'};
  return {
    range:{from:t(range.start),to:t(last),bars:count,barsAgoEnd:n-1-last,intervalMs,
      high:{time:t(top),value:num(high[top])},low:{time:t(bottom),value:num(low[bottom])},
      open:num(open[range.start]),close:num(price),changePct:num((price/open[range.start]-1)*100),positionInRange:num((price-low[bottom])/Math.max(1e-12,high[top]-low[bottom]))},
    atr14:{value:num(atr),pctOfPrice:num(atr/price*100)},
    trend:channel,
    pivots:{strength:options.strength,total:labelled.length,
      items:labelled.slice(-options.maxPivots).map(p=>({type:p.type,label:p.label,time:t(p.index),price:num(p.price),barsAgo:n-1-p.index,legAtr:p.leg!==null&&Number.isFinite(atr)?num(p.leg/atr):null}))},
    levels:{band:num(band),items:levels},
    nearest:{resistance:above?{price:above.price,distancePct:above.distancePct}:null,support:below?{price:below.price,distancePct:below.distancePct}:null},
  };
}
