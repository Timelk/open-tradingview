import type {ColumnView,ParamValues} from '../core/types';
import type {AnalysisObservation} from './types';
import {analyzeBars,numberParam,observation,validCandle} from './features';

/** Closed-candle geometries, never automatic orders. All context is from the
 * preceding contiguous bars; no later reaction is borrowed for confirmation. */
export function detectCandlesticks(cols:ColumnView,params:ParamValues={}):AnalysisObservation[]{
  const {n,atr,segmentStart}=analyzeBars(cols),o=cols.col('open'),h=cols.col('high'),l=cols.col('low'),c=cols.col('close');
  const out:AnalysisObservation[]=[],depth=numberParam(params,'lookback',1500,100,10000),bodyMax=numberParam(params,'dojiBody',.1,.02,.25),wickMin=numberParam(params,'pinWick',2.5,1.5,6),context=numberParam(params,'trendBars',5,3,30);
  for(let i=Math.max(0,n-depth);i<n;i++){
    if(!validCandle(cols,i))continue;
    const span=h[i]-l[i],body=Math.abs(c[i]-o[i]),a=atr[i];if(span<=0||!Number.isFinite(a)||span<a*.25)continue;
    const lower=Math.min(o[i],c[i])-l[i],upper=h[i]-Math.max(o[i],c[i]);
    const enough=i-segmentStart[i]>=context,prior=enough?c[i-1]-c[i-context]:0;
    const add=(name:string,direction:AnalysisObservation['direction'],evidence:string[],warning:string)=>{
      if(params.family&&params.family!=='全部'&&!name.includes(String(params.family)))return;
      out.push(observation(cols,'candlestick',name,i,direction,direction==='bullish'?l[i]:direction==='bearish'?h[i]:c[i],evidence,[warning],['结合所在区间与后续收盘反应；本模块不自动生成交易。']));
    };
    if(body/span<=bodyMax)add('Doji 十字星','neutral',[`实体占振幅 ${(body/span*100).toFixed(1)}%`,`振幅 / ATR ${(span/a).toFixed(2)}`],'十字星仅表示当前柱实体较小，不预设反转方向。');
    if(lower>=Math.max(body,a*.04)*wickMin&&upper<=span*.2&&body<=span*.35&&(!params.requireTrend||enough&&prior<0))add('Pin Bar 下影','bullish',[`下影 / 实体 ${(lower/Math.max(body,a*.001)).toFixed(2)}`,`收盘位于本柱 ${((c[i]-l[i])/span*100).toFixed(0)}% 高度`],prior>=0?'此前没有明确下降背景；仅满足影线几何。':'长下影不能独立证明反转已经发生。');
    if(upper>=Math.max(body,a*.04)*wickMin&&lower<=span*.2&&body<=span*.35&&(!params.requireTrend||enough&&prior>0))add('Pin Bar 上影','bearish',[`上影 / 实体 ${(upper/Math.max(body,a*.001)).toFixed(2)}`],prior<=0?'此前没有明确上升背景；仅满足影线几何。':'长上影不能独立证明反转已经发生。');
    if(i>segmentStart[i]){
      const prevBody=Math.abs(c[i-1]-o[i-1]);
      if(body>=a*.25&&body>prevBody*1.05&&c[i]>o[i]&&c[i-1]<o[i-1]&&o[i]<=c[i-1]&&c[i]>=o[i-1]&&(!params.requireTrend||enough&&prior<0))add('Engulfing 看涨吞没','bullish',['本柱阳线实体包住前一根阴线实体；只比较实体，不要求吞没全部影线。'],'吞没成立于本柱收盘；不等于之后必然上涨。');
      if(body>=a*.25&&body>prevBody*1.05&&c[i]<o[i]&&c[i-1]>o[i-1]&&o[i]>=c[i-1]&&c[i]<=o[i-1]&&(!params.requireTrend||enough&&prior>0))add('Engulfing 看跌吞没','bearish',['本柱阴线实体包住前一根阳线实体。'],'吞没成立于本柱收盘；不等于之后必然下跌。');
    }
    if(i-segmentStart[i]>=2){
      const first=Math.abs(c[i-2]-o[i-2]),middle=Math.abs(c[i-1]-o[i-1]),mid=(c[i-2]+o[i-2])/2;
      const small=middle<=first*.35&&first>=a*.5&&body>=first*.4,gap=params.requireGap===true;
      if(small&&c[i-2]<o[i-2]&&c[i]>o[i]&&c[i]>=mid&&(!gap||Math.max(o[i-1],c[i-1])<c[i-2])&&(!params.requireTrend||enough&&prior<0))add('Morning Star 晨星','bullish',['阴线、小实体、阳线恢复首根实体中点。',gap?'要求中间实体向下跳空。':'24/7 市场版本，不强制跳空。'],'三柱组合的方向性需要背景与后续行情验证。');
      if(small&&c[i-2]>o[i-2]&&c[i]<o[i]&&c[i]<=mid&&(!gap||Math.min(o[i-1],c[i-1])>c[i-2])&&(!params.requireTrend||enough&&prior>0))add('Evening Star 暮星','bearish',['阳线、小实体、阴线跌回首根实体中点。',gap?'要求中间实体向上跳空。':'24/7 市场版本，不强制跳空。'],'三柱组合不直接代表交易信号。');
    }
  }
  return out.slice(-Math.round(numberParam(params,'maxObservations',80,10,300))).reverse();
}
