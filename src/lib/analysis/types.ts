import type {PatternPoint} from '../patterns/types';

/** Analytical evidence is separate from an executable strategy or price target. */
export type AnalysisFamily='candlestick'|'structure'|'wyckoff'|'supply-demand'|'vsa'|'smc'|'wave'|'cycle';
export interface AnalysisEvent {
  id:string;kind:string;label:string;time:number;availableAt:number;price:number;explanation:string;
}
export interface AnalysisLine {role:'boundary'|'structure'|'projection';label?:string;points:PatternPoint[]}
export interface AnalysisObservation {
  id:string;family:AnalysisFamily;name:string;ruleVersion:string;
  direction:'bullish'|'bearish'|'neutral';state:'observing'|'confirmed'|'invalidated';
  /** Geometry time, the first time its evidence was knowable, and latest evaluated closed time. */
  time:number;availableAt:number;throughTime:number;
  points:PatternPoint[];lines?:AnalysisLine[];
  zone?:{low:number;high:number;fromTime:number;toTime:number};
  events:AnalysisEvent[];evidence:string[];counterEvidence:string[];waitingFor:string[];
  phase?:string;alternatives?:string[];invalidatedAt?:number;
  /** Bounded research ranges can end without being a current opportunity. */
  trackingEndedAt?:number;trackingEndReason?:'departure'|'expired';
  dataWarning?:string;
}
export interface AnalysisRow {instanceId:string;layerName:string;timeframe:string;visible:boolean;observation:AnalysisObservation}
