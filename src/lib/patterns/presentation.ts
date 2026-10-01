import type {PatternEvent,PatternMatch,PatternStage} from './types';

export const PATTERN_STAGE_LABELS:Record<PatternStage,string>={
  breakout:'已突破',retest:'回踩确认','failed-breakout':'突破回落',invalidated:'结构失效',
};
export const PATTERN_EVENT_LABELS:Record<PatternEvent['kind'],string>={
  breakout:'收盘突破',retest:'回踩守住','failed-breakout':'收回框架',invalidation:'越过失效位',
};
export function patternStageLabel(pattern:PatternMatch):string {
  if(pattern.status==='invalidated'||pattern.stage==='invalidated')return pattern.stage==='invalidated'?'结构失效':'已失效';
  // Reaching the reference target inside the observation window completes it.
  if(pattern.resolution)return '已达标';
  if(pattern.stage==='failed-breakout')return PATTERN_STAGE_LABELS['failed-breakout'];
  if(pattern.dataWarning)return '数据中断';
  if(pattern.observationEndedAt!==undefined)return '已走完';
  return pattern.stage?PATTERN_STAGE_LABELS[pattern.stage]:'已确认';
}
/** Finished structures: target reached or observation window elapsed. */
export function patternIsFinished(pattern:PatternMatch):boolean {
  return pattern.status==='confirmed'&&(!!pattern.resolution||pattern.observationEndedAt!==undefined);
}
/** Still being watched: confirmed, not yet finished, failed or interrupted. */
export function patternIsActive(pattern:PatternMatch):boolean {
  return !pattern.dataWarning&&pattern.status==='confirmed'&&pattern.stage!=='failed-breakout'&&pattern.stage!=='invalidated'&&!patternIsFinished(pattern);
}
/** '中继' / '反转' for envelope structures whose approach was clear; undefined when it was not. */
export function patternContextLabel(pattern:PatternMatch):string|undefined {
  return pattern.context?pattern.context.kind==='continuation'?'中继':'反转':undefined;
}
/** Lifecycle warnings must remain visible even in the compact chart overview. */
export function patternChartLabel(pattern:PatternMatch,selected=false):string {
  const active=patternIsActive(pattern);
  const glyph=active?(pattern.direction==='bullish'?'↗':'↘'):pattern.resolution&&pattern.status==='confirmed'?'✓':pattern.stage==='failed-breakout'&&pattern.status!=='invalidated'?'↩':'·';
  const state=selected||!active?` · ${patternStageLabel(pattern)}`:'';
  const context=patternContextLabel(pattern);
  // A divergence at D is what a reader of a harmonic looks for first, so it stays visible even in the compact label.
  return `${glyph} ${pattern.name}${context?` · ${context}`:''}${pattern.signals?.macd?' · 背离':''}${pattern.formation==='early'?' · 无E点':''}${state}`;
}
export function matchesPatternStage(pattern:PatternMatch,filter:string):boolean {
  if(filter==='all')return true;
  // Auxiliary observation filter, independent of the actual structural state.
  if(filter==='resolved')return !!pattern.resolution;
  if(filter==='ended')return pattern.status==='confirmed'&&!pattern.resolution&&pattern.observationEndedAt!==undefined;
  if(filter==='confirmed')return patternIsActive(pattern);
  if(filter==='invalidated')return pattern.status==='invalidated';
  return pattern.stage===filter;
}
export function patternEventLabel(pattern:PatternMatch,event:PatternEvent):string {
  return event.kind==='retest'&&pattern.direction==='bearish'?'反抽受压':PATTERN_EVENT_LABELS[event.kind];
}
