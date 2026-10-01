import type {ColumnView,ParamValues} from '../core/types';
import type {AnalysisFamily,AnalysisObservation} from './types';
export const numberParam=(p:ParamValues,key:string,fallback:number,min:number,max:number)=>{const n=Number(p[key]);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;};
export const closedBars=(cols:ColumnView)=>Math.max(0,Math.min(cols.length,Math.floor(cols.closedLength??cols.length-1)));
export function availableTime(cols:ColumnView,index:number):number {
  const times=cols.col('time');let step=cols.intervalMs??Infinity;
  if(!Number.isFinite(step)){for(let i=Math.max(1,index-8);i<=index;i++){const delta=times[i]-times[i-1];if(delta>0)step=Math.min(step,delta);}}
  if(!Number.isFinite(step))step=60_000;
  if(step>25*86400000){const d=new Date(times[index]);if(d.getUTCDate()===1)return Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);}
  return times[index]+step;
}
export function validCandle(cols:ColumnView,i:number):boolean {
  const o=cols.col('open')[i],h=cols.col('high')[i],l=cols.col('low')[i],c=cols.col('close')[i],v=cols.col('volume')[i],t=cols.col('time')[i];
  return [o,h,l,c,v,t].every(Number.isFinite)&&v>=0&&h>=Math.max(o,c)&&l<=Math.min(o,c)&&h>=l;
}
export function continuous(cols:ColumnView,i:number):boolean {
  if(i<=0)return true;
  const t=cols.col('time');let step=cols.intervalMs??(t[i]-t[i-1]);
  if(cols.intervalMs===undefined&&i>1){step=Infinity;for(let j=Math.max(1,i-8);j<i;j++){const delta=t[j]-t[j-1];if(delta>0)step=Math.min(step,delta);}}
  if(t[i]<=t[i-1]||!Number.isFinite(step))return false;
  if(t[i]-t[i-1]===step)return true;
  const d=new Date(t[i-1]);return step>25*86400000&&d.getUTCDate()===1&&t[i]===Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);
}
export function analyzeBars(cols:ColumnView,period=14){
  const n=closedBars(cols),atr=new Float64Array(n).fill(NaN),volumeRatio=new Float64Array(n).fill(NaN),segmentStart=new Int32Array(n);
  const h=cols.col('high'),l=cols.col('low'),c=cols.col('close'),v=cols.col('volume');let segment=0,trs:number[]=[],volumes:number[]=[];
  for(let i=0;i<n;i++){
    if(!validCandle(cols,i)||!continuous(cols,i)){segment=i;trs=[];volumes=[];segmentStart[i]=segment;if(!validCandle(cols,i)){segment=i+1;continue;}}
    segmentStart[i]=segment;
    if(volumes.length>=5){const ordered=[...volumes].sort((a,b)=>a-b),median=ordered[Math.floor(ordered.length/2)];if(median>0)volumeRatio[i]=v[i]/median;}
    const tr=i>segment?Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])):h[i]-l[i];trs.push(tr);if(trs.length>period)trs.shift();
    if(trs.length>=Math.min(5,period))atr[i]=trs.reduce((a,b)=>a+b,0)/trs.length;
    volumes.push(v[i]);if(volumes.length>20)volumes.shift();
  }
  return {n,atr,volumeRatio,segmentStart};
}
export function observation(cols:ColumnView,family:AnalysisFamily,name:string,index:number,direction:AnalysisObservation['direction'],price:number,evidence:string[],counterEvidence:string[],waitingFor:string[]):AnalysisObservation {
  const time=cols.col('time')[index];return {id:`${family}:${name}:${time}`,family,name,ruleVersion:`${family}/1.0`,direction,state:'confirmed',time,availableAt:availableTime(cols,index),throughTime:availableTime(cols,closedBars(cols)-1),points:[{label:name,time,value:price}],events:[],evidence,counterEvidence,waitingFor};
}
