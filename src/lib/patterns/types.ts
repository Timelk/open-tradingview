/** Sparse, time-anchored analytical output; never a broker order or user drawing. */
export interface PatternPoint { label:string; time:number; value:number }
export interface PatternRatio { label:string; value:number; expected:string }
/** Serializable, confirmed momentum evidence on the same two price extrema.
 * Values are the detector's causal samples; a mounted indicator may resolve
 * these timestamps against its own matching-parameter series for drawing. */
export interface PatternDivergenceEvidence {
  indicator:'rsi'|'macd';
  series:'rsi'|'dif';
  params:Record<string,number>;
  points:[{time:number;value:number},{time:number;value:number}];
  minDelta?:number;
}
export interface PatternGuide {
  role:'upper'|'lower'|'neckline'|'pole'|'curve';
  /** The exact detection line, projected only through available closed data. For a `curve` these are its two ends. */
  points:[PatternPoint,PatternPoint];
  /** A curved guide (parabolic support, rounded base): the fitted curve sampled bar by bar, ends included. */
  path?:PatternPoint[];
}
export interface PatternEvent {
  kind:'breakout'|'retest'|'failed-breakout'|'invalidation';
  /** Candle location and the later time its closed result became available. */
  time:number;knownAt:number;value:number;boundary:number;
}
export type PatternStage='breakout'|'retest'|'failed-breakout'|'invalidated';
/** A current analytical hypothesis. It is deliberately not a PatternMatch:
 * there is no confirmation, trade direction promise, stop or profit target. */
export interface PatternCandidate {
  id:string;family:string;name:string;
  direction:'bullish'|'bearish'|'neutral';
  points:PatternPoint[];guides?:PatternGuide[];
  observedAt:number;availableAt?:number;
  zone?:{low:number;high:number};
  ratios:PatternRatio[];description:string;pivotStrength?:number;
}
export interface PatternCandidateRow {
  instanceId:string;layerName:string;timeframe:string;visible:boolean;candidate:PatternCandidate;
}
/** Reading aids at a completed harmonic D, computed from closed candles only. They are evidence for the reader
 * (professionals read a harmonic completion together with momentum, an ATR-sized stop and the D candle), never an
 * order, a fill or a win probability. */
export interface PatternSignals {
  /** Regular MACD(12,26,9) DIF divergence between D and the previous same-side extreme: price makes an equal or
   * new extreme while DIF does not. `source` says where the earlier extreme came from; `equalExtreme` marks the
   * looser double-bottom / double-top form where price only matched the earlier extreme. */
  macd?:{kind:'bullish'|'bearish';source:'anchors'|'swing';equalExtreme?:boolean;
    first:{time:number;price:number;dif:number};second:{time:number;price:number;dif:number}};
  /** ATR at D and the price `multiple` ATRs beyond D. Whether a wick has pierced it is judged against later closed
   * candles and recorded in `PatternMatch.atrPierced`. */
  atr?:{period:number;value:number;multiple:number;level:number};
  /** The D candle rejects the PRZ with a long wick and a small body (a pin bar). */
  pin?:{wickShare:number;bodyShare:number};
}
export interface PatternMatch {
  id:string;
  /** The detector's observable rule profile, independent of data version. */
  ruleVersion?:string;
  family:string;
  name:string;
  direction:'bullish'|'bearish';
  points:PatternPoint[];
  /** First chart time at which all required closed candles are available. */
  confirmedAt:number;
  zone:{low:number;high:number};
  invalidation:number;
  targets:number[];
  ratios:PatternRatio[];
  /** Only indicators that passed the confirmed same-pair divergence rule. */
  divergences?:PatternDivergenceEvidence[];
  description:string;
  status:'confirmed'|'invalidated';
  invalidatedAt?:number;
  guides?:PatternGuide[];
  events?:PatternEvent[];
  stage?:PatternStage;
  formation?:'complete'|'early';
  pivotStrength?:number;
  /** Historical confirmation survives a later data gap, but is not current. */
  dataWarning?:string;
  resolution?:{kind:'target-reached';time:number;knownAt:number;price:number;targetIndex:number;atConfirmation?:boolean};
  /** Move into the structure versus the breakout: the same wedge is a continuation after a decline and a
   * reversal after an advance. Absent when the approach was too small to call. */
  context?:{kind:'continuation'|'reversal';ratio:number};
  signals?:PatternSignals;
  /** The first closed candle whose wick went beyond `signals.atr.level` ("扎"); absent while it has held ("未扎"). */
  atrPierced?:{time:number;knownAt:number;price:number};
  /** Known time at which the observation window closed without a failure or
   * target touch. Later prices no longer judge this structure. */
  observationEndedAt?:number;
}
export interface PatternScan {
  fromTime:number;
  throughTime:number;
  bars:number;
  confirmationBars:number;
  note:string;
  requestedBars?:number;
  durationMs?:number;
  computedAt?:number;
  matched?:number;
  invalidated?:number;
  poolLimit?:number;
  poolCapped?:boolean;
  scope?:'viewport'|'latest';
  requestedFromTime?:number;
  requestedThroughTime?:number;
  /** Lifecycle evaluation uses the closed-data boundary, not the viewport. */
  knowledgeThroughTime?:number;
  evidenceRanges?:Array<{fromTime:number;throughTime:number}>;
  scanTruncated?:boolean;
  tileCount?:number;
}
export interface PatternRow {
  instanceId:string;
  layerName:string;
  timeframe:string;
  visible:boolean;
  color:string;
  pattern:PatternMatch;
}
export interface PatternStudy {
  instanceId:string;
  name:string;
  definitionId:string;
  timeframe:string;
  visible:boolean;
  locked?:boolean;
  pending:boolean;
  scan?:PatternScan;
  count:number;
  filteredInvalidated?:number;
  limited?:number;
  outsideViewport?:number;
  latestMatchTime?:number;
  latestDisplayedMatchTime?:number;
}
