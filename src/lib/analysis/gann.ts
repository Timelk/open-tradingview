import type {ColumnView,ParamValues} from '../core/types';
import type {AnalysisObservation,AnalysisLine} from './types';
import {analyzeBars,availableTime,numberParam,validCandle} from './features';

export const GANN_RATIOS=[{label:'1×8',ratio:1/8},{label:'1×4',ratio:1/4},{label:'1×3',ratio:1/3},{label:'1×2',ratio:1/2},{label:'1×1',ratio:1},{label:'2×1',ratio:2},{label:'3×1',ratio:3},{label:'4×1',ratio:4},{label:'8×1',ratio:8}] as const;
/** Price/time coordinates, independent of pixel slope or chart zoom. A caller
 * must supply the manual anchor and unit; no attractive pivot is invented. */
export function gannPriceAt(time:number,anchorTime:number,anchorPrice:number,priceUnit:number,timeUnitMs:number,ratio=1,direction=1):number {
  if(![time,anchorTime,anchorPrice,priceUnit,timeUnitMs,ratio,direction].every(Number.isFinite)||priceUnit<=0||timeUnitMs<=0)return NaN;
  return anchorPrice+direction*(time-anchorTime)/timeUnitMs*priceUnit*ratio;
}
export function detectGann(cols:ColumnView,params:ParamValues={}):AnalysisObservation[]{
  const {n,segmentStart}=analyzeBars(cols),anchorTime=Number(params.anchorTime),anchorPrice=Number(params.anchorPrice),priceUnit=Number(params.priceUnit);
  if(!n||!Number.isFinite(anchorTime)||!Number.isFinite(anchorPrice)||anchorPrice<=0||!Number.isFinite(priceUnit)||priceUnit<=0)return [];
  const times=cols.col('time'),knownAt=availableTime(cols,n-1);if(anchorTime<times[0]||anchorTime>=knownAt||!validCandle(cols,n-1))return [];
  let anchorIndex=0;while(anchorIndex+1<n&&times[anchorIndex+1]<=anchorTime)anchorIndex++;
  if(!validCandle(cols,anchorIndex))return [];
  const barDuration=availableTime(cols,anchorIndex)-times[anchorIndex],timeUnitBars=numberParam(params,'timeUnitBars',1,.01,1000),explicit=Number(params.timeUnitMs),timeUnit=Number.isFinite(explicit)&&explicit>0?explicit:timeUnitBars*barDuration;
  if(params.timeUnitMs!==undefined&&(!Number.isFinite(explicit)||explicit<0)||barDuration>25*86400000&&!(explicit>0))return [];
  if(!Number.isFinite(timeUnit)||timeUnit<=0)return [];
  const horizon=knownAt+Math.round(numberParam(params,'projectionBars',60,1,500))*barDuration,directions=params.direction==='down'?[-1]:params.direction==='both'?[1,-1]:[1];
  const anchor={label:'手动锚点',time:anchorTime,value:anchorPrice},lines:AnalysisLine[]=[];
  for(const direction of directions)for(const {label,ratio} of GANN_RATIOS){
    // Stop bearish arithmetic lines before non-positive price so log views
    // remain valid; the mathematical scale is never changed by rendering.
    const end=direction<0?Math.min(horizon,anchorTime+anchorPrice/(priceUnit*ratio)*timeUnit*(1-1e-8)):horizon;
    if(end<=anchorTime)continue;
    lines.push({role:'projection',label:`${direction>0?'↑':'↓'} ${label} · 价格单位/时间单位`,points:Array.from({length:17},(_,i)=>{const time=anchorTime+(end-anchorTime)*i/16;return {label:i===0?'锚点':label,time,value:gannPriceAt(time,anchorTime,anchorPrice,priceUnit,timeUnit,ratio,direction)};})});
  }
  const item:AnalysisObservation={id:`cycle:gann:${anchorTime}:${anchorPrice}:${priceUnit}:${timeUnit}:${String(params.direction??'up')}`,family:'cycle',name:'Gann 显式价时标尺',ruleVersion:'gann-explicit-arithmetic/1.0',direction:'neutral',state:'observing',time:anchorTime,availableAt:knownAt,throughTime:knownAt,points:[anchor],lines,events:[],phase:'手动研究标尺',
    evidence:[`锚点 ${new Date(anchorTime).toISOString()} / ${anchorPrice}；由用户输入，不由算法挑选。`,`1×1 = 每 ${timeUnit.toFixed(0)} 毫秒变化 ${priceUnit} 价格单位；所有角度依此物理单位计算。`,'缩放和视图宽高不会改变相同时间对应的投射价格；屏幕角度不固定为 45°。'],counterEvidence:['使用线性价格/绝对时间标尺；它不是自动预测器。','日历月不能用固定柱时长替代；需明确输入绝对 timeUnitMs。','穿越线条只记录测量事件，不产生买入卖出指令。'],waitingFor:['可调整手动锚点与价格/时间单位进行可重复研究。']};
  if(segmentStart[n-1]>anchorIndex)item.dataWarning='锚点之后行情存在缺口；投射线可计算，跨缺口穿越事件不推断。';
  const oneDirection=directions.length===1?directions[0]:0;
  if(oneDirection)for(let i=anchorIndex+1;i<n;i++){
    if(segmentStart[i]>i-1)continue;
    const previous=cols.col('close')[i-1]-gannPriceAt(times[i-1],anchorTime,anchorPrice,priceUnit,timeUnit,1,oneDirection),current=cols.col('close')[i]-gannPriceAt(times[i],anchorTime,anchorPrice,priceUnit,timeUnit,1,oneDirection);
    if(previous*current<0)item.events.push({id:`${item.id}:cross:${times[i]}`,kind:'scale-cross',label:current>0?'收盘上穿 1×1':'收盘下穿 1×1',time:times[i],availableAt:knownAt,price:cols.col('close')[i],explanation:'以当前手动标尺复核的历史穿越；未声称这条手动研究线在当时已建立。'});
  }
  item.events=item.events.slice(-100);return [item];
}
