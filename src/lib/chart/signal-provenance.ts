import type {IndicatorInstance} from '../scene/types';

/** Explain the actual originating study, never infer an MA signal from color. */
export function studySignalProvenance(instance:IndicatorInstance|undefined,side:'buy'|'sell'):{sourceTag:string;trigger:string} {
  if(instance?.id==='strategy-rsi-reversal'){
    const {period=14,lower=30,upper=70}=instance.params;
    return {sourceTag:'RSI',trigger:`RSI(${period}) ${side==='buy'?`上穿超卖阈值 ${lower}`:`下穿超买阈值 ${upper}`} · 已收盘确认 · 仅指标信号`};
  }
  if(instance?.id==='strategy-ma-cross'){
    const {method='EMA',fast=9,slow=21}=instance.params;
    return {sourceTag:'均线',trigger:`${method}(${fast}) ${side==='buy'?'上穿':'下穿'} ${method}(${slow}) · 已收盘确认 · 仅指标信号`};
  }
  return {sourceTag:'指标',trigger:'指标输出的研究信号，不代表实际成交'};
}
