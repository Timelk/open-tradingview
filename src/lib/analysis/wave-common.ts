import type {ColumnView,ParamValues} from '../core/types';
import type {Pivot} from '../patterns/pivots';
import {appendPivot,confirmedPivotEvents} from '../patterns/pivots';
import {harmonicView} from '../patterns/harmonic-swings';
import {analyzeBars,availableTime,numberParam} from './features';
import type {AnalysisObservation} from './types';

export function* waveSnapshots(input:ColumnView,params:ParamValues={}){
  const cols=harmonicView(input),features=analyzeBars(cols),base=Math.round(numberParam(params,'pivotStrength',3,1,20)),depth=numberParam(params,'lookback',1800,100,10000);
  const radii=params.multiScale===false?[base]:[...new Set([base,base*2,base*4].map(n=>Math.min(30,n)))];
  for(const radius of radii){
    const pivots:Pivot[]=[];
    for(const event of confirmedPivotEvents(cols,radius,depth)){
      const known=event.index+radius;
      if(known>=features.n||features.segmentStart[known]>Math.max(0,event.index-radius)){pivots.length=0;continue;}
      if(pivots.length&&pivots[0].index<features.segmentStart[known])pivots.length=0;
      if(!appendPivot(pivots,event))continue;
      if(pivots.length>40)pivots.shift();
      yield {cols,features,pivots,event,radius,known,availableAt:availableTime(cols,known)};
    }
  }
}
export const priceLine=(a:Pivot,b:Pivot,index:number)=>a.value+(b.value-a.value)*(index-a.index)/(b.index-a.index);
export function waveObservation(cols:ColumnView,pivots:readonly Pivot[],labels:string[],name:string,profile:string,availableAt:number):AnalysisObservation{
  const time=pivots.at(-1)!.time;
  return {id:`wave:${profile}:${pivots.map(p=>p.time).join(':')}`,family:'wave',name,ruleVersion:profile,direction:'neutral',state:'observing',time,availableAt,throughTime:availableAt,points:pivots.map((p,i)=>({label:labels[i],time:p.time,value:p.value})),events:[],evidence:[],counterEvidence:[],waitingFor:[]};
}
