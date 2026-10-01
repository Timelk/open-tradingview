import type {PatternCandidate,PatternMatch,PatternScan} from '../patterns/types';
import type {AnalysisFamily,AnalysisObservation} from '../analysis/types';
import type {OscillatorDivergence} from '../indicators/divergence';
/** 核心共享类型：内核只依赖本文件，不依赖 Svelte。 */

export interface BarInput {
  time: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?:number;
  tradeCount?:number;
  takerBuyBase?:number;
  takerBuyQuote?:number;
}

/** Feed 推送事件：isNew=true 表示新开一根，false 表示更新最后一根。 */
export interface BarEvent extends BarInput {
  isNew: boolean;
  /** Exchange-confirmed closing update, before the next candle arrives. */
  confirmed?: boolean;
}

export type ColumnName = 'time' | 'open' | 'high' | 'low' | 'close' | 'volume';
export const FLOW_COLUMNS=['quoteVolume','tradeCount','takerBuyBase','takerBuyQuote'] as const;
export type FlowColumnName=typeof FLOW_COLUMNS[number];

/** 列存只读视图：指标 calc 与渲染器只拿视图，不拿 Store 本体。 */
export interface ColumnView {
  length: number;
  /** Declared source cadence when known; calendar-month timestamps stay calendar based. */
  intervalMs?:number;
  /** Optional explicit number of exchange-confirmed candles (may include last). */
  closedLength?:number;
  /** Optional viewport analysis window; price columns still retain live data. */
  patternWindow?:{fromTime:number;toTime:number};
  col(name: ColumnName): Float64Array;
  /** Unknown historical flow fields stay unavailable/NaN, never invented zero. */
  flow?(name:FlowColumnName):Float64Array|undefined;
}

/** 指标产出的派生序列：NaN 表示该位置无值（断点）。 */
export interface DerivedSeries {
  name: string;
  values: Float64Array;
  color: string;
  pane: 'main' | 'sub' | 'volume';
  plot: 'line' | 'hist' | 'markers' | 'patterns' | 'analysis';
  observations?:AnalysisObservation[];
  /** Independent closed-pivot evidence for this mounted oscillator output. */
  divergences?:OscillatorDivergence[];
  dataWarning?:string;
  patterns?:PatternMatch[];
  candidates?:PatternCandidate[];
  patternScan?:PatternScan;
  /** Marker series has one direction; NaN means no signal at this bar. */
  markerSide?: 'buy' | 'sell';
  /** Display-only intersection geometry; values retains confirmed signal data. */
  markerOffsets?: Float64Array;
  markerValues?: Float64Array;
  indicatorId?: string;
  plotIndex?: number;
  timeframe?: string;
}

export type ParamType = 'int' | 'float' | 'bool' | 'color' | 'select';

export interface ParamSchema {
  key: string;
  label: string;
  type: ParamType;
  def: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  optionLabels?:Record<string,string>;
}

export type ParamValues = Record<string, number | boolean | string>;

export interface CalcContext {
  cols: ColumnView;
  /** 脏窗口 [from, to)，增量重算只碰该区间；首次全量时为 [0, length)。 */
  from: number;
  to: number;
}

export interface IndicatorDef {
  id: string;
  name: string;
  kind?: 'indicator' | 'strategy';
  category?: 'pattern'|'analysis';
  analysisFamily?:AnalysisFamily|'harmonic'|'classic'|'confluence'|'flow';
  title?: string;
  description?: string;
  tags?: string[];
  source?: 'builtin' | 'custom';
  target: 'main' | 'sub' | 'volume';
  inputs: ParamSchema[];
  calc(ctx: CalcContext, params: ParamValues): DerivedSeries[];
  /** Optional persistent calculator; pure calc remains the reference/custom fallback. */
  createIncremental?(params: ParamValues): IncrementalCalculator;
}

export interface IncrementalCalculator {
  update(cols: ColumnView, from: number): DerivedSeries[];
}

export type OverlayKind = 'line' | 'hist' | 'markers' | 'band' | 'shapes' | 'drawings';
/** Producer-neutral visual objects projected by chart overlays. */
export interface OverlayDrawingSpec {
  id:string;kind:'line'|'box'|'label';x1:number;y1:number;x2:number;y2:number;
  xloc:'bar_index'|'bar_time';yloc:'price'|'abovebar'|'belowbar';style:string;
  stroke:string;fill:string;width:number;lineStyle:'solid'|'dashed'|'dotted';
  text:string;textColor:string;fontSize:number;fontWeight?:'normal'|'bold';
  textAlign:'left'|'center'|'right';textValign:'top'|'center'|'bottom';tooltip:string;
}
export interface OverlayShapeSpec {
  time:number;barIndex:number;offset:number;value:number|null;
  shape:'circle'|'square'|'diamond'|'triangleup'|'triangledown'|'arrowup'|'arrowdown'|'cross'|'xcross'|'labelup'|'labeldown'|'flag';
  location:'abovebar'|'belowbar'|'top'|'bottom'|'absolute';
  color:string;text:string;textColor:string;size:'auto'|'tiny'|'small'|'normal'|'large'|'huge';
}
export interface OverlayDrawing extends OverlayDrawingSpec {index1:number;index2:number}
export interface OverlayShape extends OverlayShapeSpec {index:number;sourceIndex:number}
export interface OverlayMarker {
  /** May fall between two candles for an interpolated signal intersection. */
  index:number;value:number;side:'buy'|'sell';time:number;
  signalKind?:'crossover'|'crossunder';label?:string;
}

export interface OverlayPlot {
  /** Compact overlay output can begin part-way through the loaded chart. */
  offset?: number;
  width?: number;
  colors?: (string|undefined)[];
  timeframe?: string;
  id?: string;
  name?: string;
  paneId?: string;
  kind: OverlayKind;
  values: Float64Array;
  color: string;
  pane: 'main' | 'sub' | 'volume';
  /** markers 专用：buy/sell 方向数组，与 values 等长，无信号为 0。 */
  side?: Int8Array;
  /** Sparse visual anchors for native indicator or external analysis signals. */
  markers?: readonly OverlayMarker[];
  shapes?: readonly OverlayShape[];
  drawings?: readonly OverlayDrawing[];
  /** band 的第二边界，与 values 形成填充区域。 */
  upper?: Float64Array;
}

export type FeedStatus = 'ok' | 'reconnecting' | 'error';

export interface Feed {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): void;
  onBar(cb: (e: BarEvent) => void): void;
  onStatus(cb: (s: FeedStatus) => void): void;
}
