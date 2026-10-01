import type {ColumnView,ParamValues} from '../core/types';
import type {AnalysisObservation} from './types';
import {analyzeBars,availableTime,numberParam} from './features';

export interface CycleEstimate {
  periodBars:number;periodRange:[number,number];amplitude:number;explainedVariance:number;
  stability:number;phase:number;phaseRange:[number,number];nextTroughBars:[number,number];
  leftPeriod:number;rightPeriod:number;
}
interface Fit {period:number;a:number;b:number;explained:number;energy:number}
const tau=Math.PI*2;
function detrend(values:readonly number[]):number[]{
  const n=values.length,mean=values.reduce((a,b)=>a+b,0)/n,mid=(n-1)/2;let xy=0,xx=0;
  for(let i=0;i<n;i++){xy+=(i-mid)*(values[i]-mean);xx+=(i-mid)**2;}
  const slope=xx?xy/xx:0;return values.map((y,i)=>y-mean-slope*(i-mid));
}
function fit(values:readonly number[],period:number,offset=0):Fit {
  let ss=0,cc=0,sc=0,ys=0,yc=0,energy=0;const w=tau/period;
  for(let i=0;i<values.length;i++){const sin=Math.sin(w*(i+offset)),cos=Math.cos(w*(i+offset)),y=values[i];ss+=sin*sin;cc+=cos*cos;sc+=sin*cos;ys+=y*sin;yc+=y*cos;energy+=y*y;}
  const det=ss*cc-sc*sc;if(det<=1e-12||energy<=1e-20)return {period,a:0,b:0,explained:0,energy};
  const a=(yc*ss-ys*sc)/det,b=(ys*cc-yc*sc)/det,explained=Math.max(0,Math.min(1,(a*yc+b*ys)/energy));return {period,a,b,explained,energy};
}
function scan(values:readonly number[],min:number,max:number,offset=0):Fit[]{
  const out:Fit[]=[];for(let period=min;period<=max;period++)out.push(fit(values,period,offset));return out;
}
const best=(fits:Fit[])=>fits.reduce((a,b)=>b.explained>a.explained?b:a);
/** Trailing-only harmonic regression with sequential residual extraction.
 * This estimates observable periodic components; it is not the complete Hurst
 * nominal/phasing methodology. Stability is a split-window diagnostic, and
 * phase ranges are heuristics, never calibrated forecast confidence levels. */
export function estimateCausalCycles(values:readonly number[],params:ParamValues={}):CycleEstimate[]{
  const min=Math.round(numberParam(params,'minPeriod',10,6,150)),max=Math.min(Math.floor(values.length/3),Math.round(numberParam(params,'maxPeriod',120,min,300)));
  if(values.length<Math.max(40,min*4)||max<min||!values.every(Number.isFinite))return [];
  const residual=detrend(values),originalEnergy=residual.reduce((sum,v)=>sum+v*v,0),scale=Math.max(1,...values.map(Math.abs));
  if(originalEnergy<=values.length*scale*scale*1e-16)return [];
  const minimum=numberParam(params,'minFit',.18,.05,.8),limit=Math.round(numberParam(params,'maxCycles',3,1,4)),out:CycleEstimate[]=[];
  for(let component=0;component<limit;component++){
    const fits=scan(residual,min,max).filter(f=>out.every(prior=>Math.abs(prior.periodBars-f.period)/prior.periodBars>.12));if(!fits.length)break;
    const peak=best(fits),explained=peak.explained*peak.energy/originalEnergy;if(explained<minimum)break;
    const adjacent=fits.filter(f=>Math.abs(f.period-peak.period)<=peak.period*.2&&f.explained>=peak.explained*.9),periodRange:[number,number]=[Math.min(...adjacent.map(f=>f.period)),Math.max(...adjacent.map(f=>f.period))];
    const split=Math.floor(residual.length/2),left=best(scan(residual.slice(0,split),min,Math.min(max,Math.floor(split/2)))),right=best(scan(residual.slice(split),min,Math.min(max,Math.floor((residual.length-split)/2)),split));
    const amplitudeLeft=Math.hypot(left.a,left.b),amplitudeRight=Math.hypot(right.a,right.b),periodAgreement=Math.max(0,1-Math.abs(left.period-right.period)/peak.period),amplitudeAgreement=Math.min(amplitudeLeft,amplitudeRight)/Math.max(amplitudeLeft,amplitudeRight,1e-15);
    const stability=periodAgreement*amplitudeAgreement;
    const angle=tau*(values.length-1)/peak.period+Math.atan2(-peak.b,peak.a),phase=((angle/tau)%1+1)%1;
    const phaseError=Math.min(.45,.04+(1-peak.explained)*.18+(1-stability)*.25),delay=((.5-phase+1)%1)*peak.period;
    out.push({periodBars:peak.period,periodRange,amplitude:Math.hypot(peak.a,peak.b),explainedVariance:explained,stability,phase,phaseRange:[phase-phaseError,phase+phaseError],nextTroughBars:[Math.max(0,delay-phaseError*peak.period),delay+phaseError*peak.period],leftPeriod:left.period,rightPeriod:right.period});
    for(let i=0;i<residual.length;i++)residual[i]-=peak.a*Math.cos(tau*i/peak.period)+peak.b*Math.sin(tau*i/peak.period);
  }
  return out;
}
export function detectHurstCycles(cols:ColumnView,params:ParamValues={}):AnalysisObservation[]{
  const {n,segmentStart}=analyzeBars(cols);if(!n)return [];
  const end=n-1,start=Math.max(segmentStart[end],n-Math.round(numberParam(params,'windowBars',600,60,2048))),values=Array.from(cols.col('close').subarray(start,n));
  const models=estimateCausalCycles(values,params),knownAt=availableTime(cols,end),step=knownAt-cols.col('time')[end],price=cols.col('close')[end];
  return models.map((model,index)=>{
    const point={label:'当前周期观测',time:cols.col('time')[end],value:price},phaseName=model.phase>.5?'估计上升半周':'估计下降半周';
    const partners=models.filter((other,j)=>j!==index&&[2,3].some(ratio=>Math.abs(Math.max(other.periodBars,model.periodBars)/Math.min(other.periodBars,model.periodBars)-ratio)<ratio*.1));
    const from=knownAt+model.nextTroughBars[0]*step,to=knownAt+model.nextTroughBars[1]*step;
    return {id:`cycle:hurst-estimate:${point.time}:${model.periodBars}`,family:'cycle',name:`Hurst 周期估计 · ${model.periodBars} 柱`,ruleVersion:'hurst-trailing-regression/1.0',direction:'neutral',state:'observing',time:point.time,availableAt:knownAt,throughTime:knownAt,points:[point],
      lines:[{role:'projection',label:'下一波谷相位范围（非价格预测）',points:[{label:'相位窗起',time:from,value:price},{label:'相位窗止',time:to,value:price}]}],events:[],phase:`${phaseName} · ${(model.phase*360).toFixed(0)}° · ${model.stability>=.65?'分窗较稳定':'分窗不稳定'}`,
      evidence:[`仅使用最近 ${values.length} 根连续闭柱，尾窗去线性趋势，不使用居中滤波或未来柱。`,`主要周期 ${model.periodBars} 柱，邻近拟合范围 ${model.periodRange.join('–')} 柱；该分量解释尾窗去趋势方差 ${(model.explainedVariance*100).toFixed(1)}%。`,`前/后半窗独立周期 ${model.leftPeriod}/${model.rightPeriod} 柱，稳定性诊断 ${model.stability.toFixed(2)}。`,partners.length?`存在近似谐和分量：${partners.map(p=>p.periodBars).join('、')} 柱。`:'未观察到配套谐和分量，不能断言完整名义周期模型。'],
      counterEvidence:['周期估计与方向预测分开；分量可能漂移或被其他分量抵消。','解释方差不是准确率；相位窗是启发式范围，不是统计置信区间。','这是 Hurst 风格因果周期分析基础，不等同于原课程完整定相流程。'],waitingFor:['观察后续闭柱是否保持波长、振幅与相位稳定。'],alternatives:models.filter((_,j)=>j!==index).map(m=>`${m.periodBars} 柱分量 · 稳定性 ${m.stability.toFixed(2)}`),
    } satisfies AnalysisObservation;
  });
}
