import type {ColumnView,ParamValues} from '../core/types';
import type {AnalysisObservation} from './types';
import {availableTime,closedBars,continuous,numberParam} from './features';

export interface PointFigureColumn {
  direction:'X'|'O';lowBox:number;highBox:number;fromTime:number;toTime:number;
  availableAt:number;completedAt?:number;segment:number;
}
export interface PointFigureMeasurement {
  boxSize:number;reversal:number;columns:number;countPrice:number;extension:number;
  rangeLow:number;rangeHigh:number;bullishReference:number;bearishReference?:number;
  fromTime:number;throughTime:number;availableAt:number;includesDeveloping:boolean;
}
export interface PointFigureResult {columns:PointFigureColumn[];boxSize:number;reversal:number;warnings:string[]}
function boxSetting(params:ParamValues):number {
  const box=params.boxMode==='ticks'?Number(params.tickSize)*Number(params.boxTicks):Number(params.boxSize??10);
  return Number.isFinite(box)&&box>0?box:NaN;
}

/** Fixed-box, close-only P&F. A turn omits the previous column's extreme box.
 * Price gaps do not get invented intrabar paths; data gaps begin a new segment.
 * Columns store grid bounds instead of allocating one object per price box. */
export function buildPointFigure(cols:ColumnView,params:ParamValues={}):PointFigureResult {
  const boxSize=boxSetting(params),reversal=Math.round(numberParam(params,'reversal',3,1,10));
  const result:PointFigureResult={columns:[],boxSize,reversal,warnings:[]};
  if(!Number.isFinite(boxSize)){result.warnings.push('请设置正的固定格值，或明确的 tickSize × boxTicks。');return result;}
  const n=closedBars(cols),t=cols.col('time'),c=cols.col('close'),depth=Math.round(numberParam(params,'lookback',1800,100,10000));
  const rangeFrom=Number(params.rangeFrom??0),rangeTo=Number(params.rangeTo??0);
  let anchor:number|undefined,segment=0,current:PointFigureColumn|undefined;
  for(let i=Math.max(0,n-depth);i<n;i++){
    if(rangeFrom>0&&t[i]<rangeFrom||rangeTo>0&&t[i]>rangeTo)continue;
    if(!Number.isFinite(t[i])||!Number.isFinite(c[i])||c[i]<=0||Math.abs(c[i]/boxSize)>1e12){
      anchor=undefined;current=undefined;segment++;if(!result.warnings.includes('无效价格打断了点数图列。'))result.warnings.push('无效价格打断了点数图列。');continue;
    }
    if(i>0&&!continuous(cols,i)){anchor=undefined;current=undefined;segment++;if(!result.warnings.includes('行情缺口分段，水平计数不会跨缺口。'))result.warnings.push('行情缺口分段，水平计数不会跨缺口。');}
    const up=Math.floor(c[i]/boxSize+1e-9),down=Math.ceil(c[i]/boxSize-1e-9),known=availableTime(cols,i);
    if(anchor===undefined){anchor=up;continue;}
    const add=(direction:'X'|'O',lowBox:number,highBox:number)=>{
      if(current)current.completedAt=known;
      current={direction,lowBox,highBox,fromTime:t[i],toTime:t[i],availableAt:known,segment};
      result.columns.push(current);
    };
    if(!current){if(up>=anchor+1)add('X',anchor+1,up);else if(down<=anchor-1)add('O',down,anchor-1);continue;}
    if(current.direction==='X'){
      if(up>current.highBox){current.highBox=up;current.toTime=t[i];current.availableAt=known;}
      else if(down<=current.highBox-reversal)add('O',down,current.highBox-1);
    }else{
      if(down<current.lowBox){current.lowBox=down;current.toTime=t[i];current.availableAt=known;}
      else if(up>=current.lowBox+reversal)add('X',current.lowBox+1,up);
    }
  }
  return result;
}

/** Horizontal count is an explicit measurement of a selected congestion, not
 * a claim that Wyckoff accumulation or an executable setup was detected. */
export function measurePointFigure(result:PointFigureResult,params:ParamValues={}):PointFigureMeasurement|undefined {
  const active=result.columns.at(-1);if(!active)return;
  const include=params.includeDeveloping===true,max=Math.round(numberParam(params,'countColumns',9,5,60));
  const columns=result.columns.filter(c=>c.segment===active.segment&&(include||c.completedAt!==undefined)).slice(-max);
  if(columns.length<5)return;
  const supplied=Number(params.countPrice??0);
  let chosen=columns;
  // Automatic selection is bounded to a suffix sharing one horizontal row.
  // It cannot count disjoint trend columns as a congestion base.
  while(chosen.length>=5){
    const commonLow=Math.max(...chosen.map(c=>c.lowBox)),commonHigh=Math.min(...chosen.map(c=>c.highBox));
    const row=supplied>0?Math.round(supplied/result.boxSize):Math.floor((commonLow+commonHigh)/2);
    if(commonLow<=commonHigh&&row>=commonLow&&row<=commonHigh){
      const low=Math.min(...chosen.map(c=>c.lowBox))*result.boxSize,high=Math.max(...chosen.map(c=>c.highBox))*result.boxSize;
      const extension=chosen.length*result.boxSize*result.reversal;
      const bearish=high-extension;
      return {boxSize:result.boxSize,reversal:result.reversal,columns:chosen.length,countPrice:row*result.boxSize,
        extension,rangeLow:low,rangeHigh:high,bullishReference:low+extension,
        ...(bearish>0?{bearishReference:bearish}:{}),fromTime:chosen[0].fromTime,
        throughTime:chosen.at(-1)!.toTime,availableAt:Math.max(...chosen.map(c=>include?c.availableAt:c.completedAt!)),
        includesDeveloping:chosen.some(c=>c.completedAt===undefined)};
    }
    chosen=chosen.slice(1);
  }
}

export function detectPointFigure(cols:ColumnView,params:ParamValues={}):AnalysisObservation[] {
  const result=buildPointFigure(cols,params),last=result.columns.at(-1);if(!last)return [];
  const measurement=measurePointFigure(result,params),current=result.columns.filter(c=>c.segment===last.segment).slice(-Math.round(numberParam(params,'countColumns',9,5,60)));
  const from=current[0].fromTime,to=last.toTime;
  const item:AnalysisObservation={id:`point-figure:${from}:${result.boxSize}:${result.reversal}`,family:'structure',name:'P&F 水平计数 · 独立测量',
    ruleVersion:'point-figure/close-fixed-1',direction:'neutral',state:'observing',time:from,
    availableAt:measurement?.availableAt??last.availableAt,throughTime:last.availableAt,
    points:current.map(c=>({label:`${c.direction} ${c.highBox-c.lowBox+1}格`,time:c.toTime,value:(c.direction==='X'?c.highBox:c.lowBox)*result.boxSize})),
    lines:current.map(c=>({role:'structure',label:`${c.direction} 列`,points:[{label:c.direction,time:c.fromTime,value:(c.direction==='X'?c.lowBox:c.highBox)*result.boxSize},{label:c.direction,time:c.toTime,value:(c.direction==='X'?c.highBox:c.lowBox)*result.boxSize}]})),
    events:[],evidence:[`收盘价构列；固定格值 ${result.boxSize}，反转 ${result.reversal} 格`,
      'X 表示上涨列，O 表示下跌列；时间只用于定位，计数单位是列，不是 K 线根数'],
    counterEvidence:['水平计数是独立价格测量，不确认吸筹 / 派发，不修改形态状态。'],waitingFor:[],
    ...(result.warnings.length?{dataWarning:result.warnings.join(' ')}:{})};
  if(measurement){
    item.zone={low:measurement.rangeLow,high:measurement.rangeHigh,fromTime:measurement.fromTime,toTime:to};
    item.evidence.push(`计数行 ${measurement.countPrice}；${measurement.columns} 列 × ${measurement.boxSize} 格值 × ${measurement.reversal} 反转 = ${measurement.extension}`);
    item.evidence.push(measurement.includesDeveloping?'包含尚未反转封闭的末列，计数可变。':'仅计入已反转封闭的列。');
    const direction=String(params.measureDirection??'both');
    if(direction!=='bearish')item.lines!.push({role:'projection',label:'P&F 向上测量参考',points:[{label:'',time:measurement.fromTime,value:measurement.bullishReference},{label:'计数参考',time:to,value:measurement.bullishReference}]});
    if(direction!=='bullish'&&measurement.bearishReference!==undefined)item.lines!.push({role:'projection',label:'P&F 向下测量参考',points:[{label:'',time:measurement.fromTime,value:measurement.bearishReference},{label:'计数参考',time:to,value:measurement.bearishReference}]});
    if(measurement.bearishReference===undefined)item.counterEvidence.push('向下算术参考非正，不绘制该无效价位。');
    item.phase='水平计数测量 · 未作为交易信号';item.waitingFor=['结合所选拥挤区间是否真实破位，独立审查计数边界。'];
  }else{
    item.phase='已构列 · 尚无合格水平计数';item.waitingFor=['至少五列穿过共同计数行；可调整固定格值或明确选择拥挤区间。'];
    item.counterEvidence.push('当前范围不满足共同水平计数行，未生成价格投影。');
  }
  return [item];
}
