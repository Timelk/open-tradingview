import type {ColumnView,ParamValues} from '../core/types';
import {confirmedPivotEvents} from '../patterns/pivots';
import {harmonicView} from '../patterns/harmonic-swings';
import type {AnalysisObservation,AnalysisEvent} from './types';
import {analyzeBars,availableTime,numberParam,observation,validCandle} from './features';

/** Internal/external swing interpretation is explicit. A wick sweep and a
 * closed break are distinct events; break evidence never becomes an order. */
export function detectMarketStructure(input:ColumnView,params:ParamValues={}):AnalysisObservation[]{
  // Pivot confirmation excludes a forming tail. A fully closed packet needs
  // the same time-only sentinel as the identical prefix plus a forming candle.
  const cols=harmonicView(input);
  const {n,atr,segmentStart}=analyzeBars(cols),strength=Math.round(numberParam(params,'pivotStrength',3,1,20)),depth=numberParam(params,'lookback',1500,100,10000),margin=numberParam(params,'breakoutAtr',.1,0,1);
  const events=confirmedPivotEvents(cols,strength,depth),out:AnalysisObservation[]=[];let cursor=0,high:typeof events[number]|undefined,low:typeof high,previousHigh=NaN,previousLow=NaN,trend=0,highBroken=-1,lowBroken=-1,highSwept=-1,lowSwept=-1,segment=-1;
  for(let i=Math.max(0,n-depth);i<n;i++){
    if(segmentStart[i]!==segment){segment=segmentStart[i];high=low=undefined;previousHigh=previousLow=NaN;trend=0;highBroken=lowBroken=highSwept=lowSwept=-1;}
    // The whole bar is closed here. A pivot whose final confirmation candle
    // just closed is already knowable; waiting for the next candle to close
    // would delay HH/HL facts by one complete source timeframe.
    while(cursor<events.length&&events[cursor].confirmedAt<=availableTime(cols,i)){
      const p=events[cursor++];if(p.index<segment)continue;
      if(p.kind==='high'){previousHigh=high?.value??previousHigh;high=p;}else{previousLow=low?.value??previousLow;low=p;}
      if(params.showSwings===true){const label=p.kind==='high'?(p.value===previousHigh?'EQH 等高':p.value>previousHigh?'HH':'LH'):(p.value===previousLow?'EQL 等低':p.value>previousLow?'HL':'LL');if(Number.isFinite(p.kind==='high'?previousHigh:previousLow)){
        const point=observation(cols,'structure',label,p.index,'neutral',p.value,[`相对前一已确认${p.kind==='high'?'高':'低'}点；右侧 ${strength} 柱确认。`],['波段归类不是对未来方向的预测。'],[]);point.availableAt=p.confirmedAt;out.push(point);
      }}
    }
    if(!validCandle(cols,i)||!Number.isFinite(atr[i]))continue;
    const time=cols.col('time')[i],close=cols.col('close')[i],pad=atr[i]*margin;
    const add=(pivot:NonNullable<typeof high>,up:boolean,sweep:boolean)=>{
      const reversal=trend!==0&&trend!==(up?1:-1),label=sweep?(up?'扫过前高后回收':'扫过前低后收复'):reversal?'CHoCH 结构转向':'BOS 收盘破位';
      const item=observation(cols,'structure',label,i,sweep?(up?'bearish':'bullish'):(up?'bullish':'bearish'),sweep?(up?cols.col('high')[i]:cols.col('low')[i]):close,[`参考已知波段${up?'高':'低'}点 ${pivot.value}`,sweep?'影线越过参考位，收盘返回原侧。':`收盘越过参考位至少 ${margin} ATR。`],['这是本平台的波段结构定义；不推断机构意图或挂单。'],[sweep?'观察后续收盘是否保持回收。':'观察回访守位或再次收回。']);
      item.points.unshift({label:up?'前高':'前低',time:pivot.time,value:pivot.value});item.lines=[{role:'boundary',points:[{label:'参考位',time:pivot.time,value:pivot.value},{label:'事件',time,value:pivot.value}]}];
      item.events=[{id:`${item.id}:break`,kind:sweep?'sweep':'breakout',label,time,availableAt:item.availableAt,price:close,explanation:item.evidence.at(-1)!}];out.push(item);
    };
    if(high&&high.index!==highBroken&&close>high.value+pad){add(high,true,false);highBroken=high.index;trend=1;}
    else if(high&&high.index!==highBroken&&high.index!==highSwept&&cols.col('high')[i]>high.value+pad&&close<high.value){add(high,true,true);highSwept=high.index;}
    if(low&&low.index!==lowBroken&&close<low.value-pad){add(low,false,false);lowBroken=low.index;trend=-1;}
    else if(low&&low.index!==lowBroken&&low.index!==lowSwept&&cols.col('low')[i]<low.value-pad&&close>low.value){add(low,false,true);lowSwept=low.index;}
  }
  return out.sort((a,b)=>b.availableAt-a.availableAt).slice(0,numberParam(params,'maxObservations',60,10,300));
}

/** Explicit three-candle FVG and displacement-origin zones, not actual orders. */
export function detectSupplyDemand(cols:ColumnView,params:ParamValues={}):AnalysisObservation[]{
  const {n,atr,segmentStart}=analyzeBars(cols),o=cols.col('open'),h=cols.col('high'),l=cols.col('low'),c=cols.col('close'),t=cols.col('time'),out:AnalysisObservation[]=[];
  const depth=numberParam(params,'lookback',1500,100,10000),minGap=numberParam(params,'minGapAtr',.15,.02,2),displacement=numberParam(params,'displacementAtr',1.3,.5,5),kind=String(params.family??'全部');
  for(let i=Math.max(2,n-depth);i<n;i++){
    if(i-segmentStart[i]<2||!validCandle(cols,i)||!Number.isFinite(atr[i]))continue;
    let zone:{low:number;high:number;fromTime:number;toTime:number}|undefined,bull=false,name='';
    if(kind!=='Supply / Demand'&&l[i]-h[i-2]>=atr[i]*minGap&&c[i-1]>o[i-1]){zone={low:h[i-2],high:l[i],fromTime:t[i-2],toTime:t[i]};bull=true;name='FVG 看涨价差区';}
    if(kind!=='Supply / Demand'&&l[i-2]-h[i]>=atr[i]*minGap&&c[i-1]<o[i-1]){zone={low:h[i],high:l[i-2],fromTime:t[i-2],toTime:t[i]};name='FVG 看跌价差区';}
    if(!zone&&kind!=='FVG'&&Math.abs(c[i]-o[i])>=atr[i]*displacement&&Math.abs(c[i-1]-o[i-1])<atr[i]*.6){bull=c[i]>o[i];zone={low:l[i-1],high:h[i-1],fromTime:t[i-1],toTime:t[i]};name=bull?'Demand 需求区':'Supply 供给区';}
    if(!zone)continue;
    const item=observation(cols,'supply-demand',name,i,bull?'bullish':'bearish',bull?zone.low:zone.high,[name.startsWith('FVG')?'三柱第一与第三柱影线价格区间未重叠。':`小实体基底后出现至少 ${displacement} ATR 的实体推进。`],['这是从价格推断的区域，不是已观察到的挂单或真实流动性缺口。'],['观察首次回访、完全回补或收盘穿越远端。']);
    item.zone=zone;item.points.unshift({label:'区域起点',time:zone.fromTime,value:bull?zone.low:zone.high});
    for(let j=i+1;j<n;j++){
      if(segmentStart[j]!==segmentStart[i]){item.dataWarning='后续行情缺口，区域状态暂停。';break;}
      const filled=name.startsWith('FVG')?(bull?l[j]<=zone.low:h[j]>=zone.high):(bull?c[j]<zone.low:c[j]>zone.high);
      if(filled){item.state='invalidated';item.invalidatedAt=availableTime(cols,j);item.events.push({id:`${item.id}:closed`,kind:'invalidation',label:name.startsWith('FVG')?'已回补':'区域穿越',time:t[j],availableAt:item.invalidatedAt,price:c[j],explanation:'实际行情达到该区域的撤销条件。'});zone.toTime=t[j];break;}
      zone.toTime=t[j];
    }
    out.push(item);
  }
  return out.reverse().slice(0,numberParam(params,'maxObservations',40,5,150));
}

export function detectVsa(cols:ColumnView,params:ParamValues={}):AnalysisObservation[]{
  const {n,atr,volumeRatio}=analyzeBars(cols),out:AnalysisObservation[]=[],h=cols.col('high'),l=cols.col('low'),c=cols.col('close');
  const threshold=numberParam(params,'volumeRatio',1.8,1.2,5),depth=numberParam(params,'lookback',1500,100,10000);
  for(let i=Math.max(0,n-depth);i<n;i++){
    const span=h[i]-l[i];if(!validCandle(cols,i)||!Number.isFinite(volumeRatio[i])||!Number.isFinite(atr[i])||span<=0)continue;
    const v=volumeRatio[i],spread=span/atr[i],position=(c[i]-l[i])/span;
    const name=v>=threshold&&spread<.8?'高量窄幅':v>=threshold&&spread>=1.4?'高量宽幅':v<=.5&&spread<.7?'低量测试候选':undefined;if(!name)continue;
    const item=observation(cols,'vsa',name,i,'neutral',c[i],[`成交量 / 前20柱中位量 ${v.toFixed(2)}`,`振幅 / ATR ${spread.toFixed(2)}`,`收盘位置 ${(position*100).toFixed(0)}%`],['量价现象不等于已识别吸收者身份；不使用成交量代替持仓量。'],['结合此前区间与后续推进，验证而非直接推断涨跌。']);out.push(item);
  }
  return out.reverse().slice(0,numberParam(params,'maxObservations',60,5,200));
}
