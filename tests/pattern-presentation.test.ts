import {it,expect} from 'vitest';
import {matchesPatternStage,patternChartLabel,patternEventLabel,patternIsActive,patternStageLabel} from '../src/lib/patterns/presentation';
import type {PatternMatch} from '../src/lib/patterns/types';

const match=(extra:Partial<PatternMatch>={}):PatternMatch=>({id:'m',family:'huzi-channel',name:'通道',direction:'bullish',points:[],confirmedAt:1000,zone:{low:99,high:101},invalidation:90,targets:[120],ratios:[],description:'',status:'confirmed',stage:'breakout',...extra});
it('separates a return into the structure from both active confirmation and final invalidation',()=>{
  const value=match({stage:'failed-breakout'});
  expect(patternIsActive(value)).toBe(false);
  expect(matchesPatternStage(value,'confirmed')).toBe(false);
  expect(matchesPatternStage(value,'invalidated')).toBe(false);
  expect(matchesPatternStage(value,'failed-breakout')).toBe(true);
  expect(patternStageLabel(value)).toBe('突破回落');
});
it('does not call a historical result beyond a data gap currently valid, and preserves harmonic status',()=>{
  expect(patternIsActive(match({dataWarning:'gap'}))).toBe(false);
  expect(patternStageLabel(match({dataWarning:'gap'}))).toBe('数据中断');
  const harmonic=match({family:'Bat',stage:undefined});
  expect(matchesPatternStage(harmonic,'confirmed')).toBe(true);
  expect(patternStageLabel(harmonic)).toBe('已确认');
  expect(patternEventLabel(match({direction:'bearish'}),{kind:'retest',time:0,knownAt:1,value:100,boundary:99})).toBe('反抽受压');
});
it('never presents returned, invalidated or data-interrupted structures as a live directional label',()=>{
  for(const value of [match({stage:'failed-breakout'}),match({status:'invalidated',stage:'invalidated'}),match({dataWarning:'gap'})]){
    expect(patternChartLabel(value)).toContain(patternStageLabel(value));
    expect(patternChartLabel(value)).not.toMatch(/^[↗↘]/);
  }
  expect(patternChartLabel(match())).toMatch(/^↗/);
});
it('treats a reached reference target as a completed structure rather than a live setup',()=>{
  const value=match({resolution:{kind:'target-reached',time:2000,knownAt:3000,price:120,targetIndex:0}});
  expect(patternStageLabel(value)).toBe('已达标');
  expect(patternChartLabel(value)).toBe('✓ 通道 · 已达标');
  expect(patternIsActive(value)).toBe(false);
  expect(matchesPatternStage(value,'resolved')).toBe(true);
  expect(matchesPatternStage(value,'confirmed')).toBe(false);
  expect(matchesPatternStage(value,'ended')).toBe(false);
  const later={...value,stage:'invalidated' as const,status:'invalidated' as const};
  expect(patternIsActive(later)).toBe(false);expect(patternChartLabel(later)).toContain('结构失效');
  expect(patternChartLabel(later)).not.toMatch(/^[↗↘✓]/);
});
it('marks a structure whose observation window elapsed as finished, not live',()=>{
  const value=match({observationEndedAt:5000});
  expect(patternStageLabel(value)).toBe('已走完');expect(patternIsActive(value)).toBe(false);
  expect(patternChartLabel(value)).toBe('· 通道 · 已走完');
  expect(matchesPatternStage(value,'ended')).toBe(true);expect(matchesPatternStage(value,'confirmed')).toBe(false);
});
it('preserves actual invalidation ahead of completion, and completion ahead of later warnings',()=>{
  const extra={resolution:{kind:'target-reached' as const,time:2000,knownAt:3000,price:120,targetIndex:0},dataWarning:'later gap'};
  expect(patternStageLabel(match({...extra,status:'invalidated',stage:'retest'}))).toBe('已失效');
  expect(patternStageLabel(match({...extra,stage:'failed-breakout'}))).toBe('已达标');
  expect(patternStageLabel(match({...extra}))).toBe('已达标');
  expect(patternStageLabel(match({dataWarning:'gap',observationEndedAt:5000}))).toBe('数据中断');
});
