import {describe,it,expect} from 'vitest';
import {studySignalProvenance} from '../src/lib/chart/signal-provenance';
import type {IndicatorInstance} from '../src/lib/scene/types';

const instance=(id:string,params:IndicatorInstance['params']):IndicatorInstance=>({id,instanceId:id,timeframe:'chart',params,hiddenPlots:[]});
describe('signal provenance',()=>{
  it('identifies RSI threshold signals independently of EMA crossings and uses the instance settings',()=>{
    expect(studySignalProvenance(instance('strategy-rsi-reversal',{period:7,lower:25,upper:80}),'sell')).toEqual({sourceTag:'RSI',trigger:'RSI(7) 下穿超买阈值 80 · 已收盘确认 · 仅指标信号'});
    expect(studySignalProvenance(instance('strategy-rsi-reversal',{}),'buy').trigger).toContain('上穿超卖阈值 30');
  });
  it('identifies the two actual MA periods and never claims an indicator signal is a fill',()=>{
    expect(studySignalProvenance(instance('strategy-ma-cross',{method:'SMA',fast:10,slow:60}),'sell')).toEqual({sourceTag:'均线',trigger:'SMA(10) 下穿 SMA(60) · 已收盘确认 · 仅指标信号'});
    expect(studySignalProvenance(undefined,'sell').sourceTag).toBe('指标');
  });
});
