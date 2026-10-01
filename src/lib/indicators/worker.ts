import { IndicatorRegistry, registerBuiltins } from './registry';
import { IndicatorRuntime } from './runtime';
import type { IndicatorReq } from './runtime';
import {FLOW_COLUMNS,type BarInput,type ColumnName,type DerivedSeries,type FlowColumnName} from '../core/types';
type FlowColumns=Partial<Record<FlowColumnName,Float64Array>>;
export type { IndicatorReq } from './runtime';

export interface TailPatch {
  name: string; timeframe?: string; plotIndex?: number; indicatorId?: string; start: number; values: Float64Array;
  color: string; pane: DerivedSeries['pane']; plot: DerivedSeries['plot']; markerSide?: DerivedSeries['markerSide'];
  markerOffsets?: Float64Array; markerValues?: Float64Array;
  /** Omission means unchanged; an own undefined value explicitly clears it. */
  patterns?: DerivedSeries['patterns']; patternScan?: DerivedSeries['patternScan'];
  candidates?:DerivedSeries['candidates'];
  observations?:DerivedSeries['observations'];dataWarning?:string;
  divergences?:DerivedSeries['divergences'];
}
export type PatternMetadataPatch=Pick<DerivedSeries,'name'|'indicatorId'|'plotIndex'|'patterns'|'patternScan'|'candidates'|'observations'|'dataWarning'>;
export type OutMsg =
  | { type: 'full'; tick: number; series: DerivedSeries[]; length?: number }
  | { type: 'tail'; tick: number; patches: TailPatch[]; length: number }
  | { type: 'patterns'; tick:number; patches:PatternMetadataPatch[]; length:number };
type InMsg =
  | ({ type: 'init'; length: number; capacity: number; closedLength?: number; reqs: IndicatorReq[];flow?:FlowColumns } & Record<ColumnName, Float64Array>)
  | { type: 'bar'; bar: BarInput; isNew: boolean; length: number; capacity: number; tick: number; closedLength?: number }
  | { type: 'set'; reqs: IndicatorReq[]; tick: number }
  | { type:'pattern-window';reqs:IndicatorReq[];tick:number }
  | { type: 'sync'; columns: Record<ColumnName, Float64Array>&{flow?:FlowColumns}; start: number; length: number; capacity: number; tick: number; closedLength?: number; reqs?: IndicatorReq[] };

const port = self as unknown as { postMessage(message: OutMsg, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<InMsg>) => void) | null };
const reg = new IndicatorRegistry(); registerBuiltins(reg);
const runtime = new IndicatorRuntime(reg);
let mirror: Record<ColumnName, Float64Array>, len = 0, closedLength = 0;
let flow:FlowColumns={};
const keys: ColumnName[] = ['time', 'open', 'high', 'low', 'close', 'volume'];
const metadata = new Map<string, Pick<DerivedSeries, 'patterns' | 'patternScan' | 'candidates'|'observations'|'dataWarning'|'divergences'>>();
function compute(from: number) { return runtime.compute({ length: len, closedLength, col: name => mirror[name],flow:name=>flow[name] }, from); }
function sliceSeries(series: DerivedSeries, start: number, end: number, full = false): DerivedSeries {
  const result = { ...series, values: series.values.slice(start, end),
    ...(series.markerOffsets ? { markerOffsets: series.markerOffsets.slice(start, end) } : {}),
    ...(series.markerValues ? { markerValues: series.markerValues.slice(start, end) } : {}) };
  const key = `${series.indicatorId}:${series.plotIndex ?? series.name}`, previous = metadata.get(key);
  for (const field of ['patterns', 'patternScan','candidates','observations','dataWarning','divergences'] as const) {
    if (!full && previous && previous[field] === series[field]) delete result[field];
    else if (!full && previous && previous[field] !== undefined && series[field] === undefined) Object.assign(result, { [field]: undefined });
  }
  metadata.set(key, { patterns: series.patterns, patternScan: series.patternScan,candidates:series.candidates,observations:series.observations,dataWarning:series.dataWarning,divergences:series.divergences });
  return result;
}
function transfers(series: DerivedSeries[]): ArrayBuffer[] {
  return series.flatMap(item => [item.values, item.markerOffsets, item.markerValues].filter((values): values is Float64Array => !!values).map(values => values.buffer as ArrayBuffer));
}
function full(tick: number, from = 0) {
  metadata.clear();
  const series = compute(from).map(item => sliceSeries(item, 0, len, true));
  port.postMessage({ type: 'full', tick, series, length: len }, transfers(series));
}
function tail(tick: number, from: number) {
  const output = compute(from), start = Math.min(from, runtime.dirtyFrom);
  const patches = output.map(series => ({ ...sliceSeries(series, start, len), start }));
  port.postMessage({ type: 'tail', tick, length: len, patches }, transfers(patches));
}
function grow(capacity: number) {
  if (mirror.time.length >= capacity) return;
  for (const key of keys) { const next = new Float64Array(capacity); next.set(mirror[key]); mirror[key] = next; }
  for(const key of FLOW_COLUMNS){const previous=flow[key];if(previous){const next=new Float64Array(capacity).fill(NaN);next.set(previous);flow[key]=next;}}
}
port.onmessage = ({ data: message }) => {
  if (message.type === 'init') {
    mirror = { time: message.time, open: message.open, high: message.high, low: message.low, close: message.close, volume: message.volume };
    flow=message.flow??{};
    len = message.length; closedLength = message.closedLength ?? Math.max(0, len - 1);
    runtime.set(message.reqs, true); full(0);
  } else if (message.type === 'set') {
    runtime.set(message.reqs); full(message.tick, Math.max(0, len - 1));
  } else if(message.type==='pattern-window'){
    runtime.set(message.reqs);
    const output=runtime.compute({length:len,closedLength,col:name=>mirror[name],flow:name=>flow[name]},len,true);
    const patches=output.map(series=>{
      // Always include metadata here: a window request can supersede a previous
      // response. Never transfer the full ordinary indicator arrays for a pan.
      const patch={name:series.name,indicatorId:series.indicatorId,plotIndex:series.plotIndex,patterns:series.patterns,patternScan:series.patternScan,candidates:series.candidates,observations:series.observations,dataWarning:series.dataWarning};
      metadata.set(`${series.indicatorId}:${series.plotIndex??series.name}`,{patterns:series.patterns,patternScan:series.patternScan,candidates:series.candidates,observations:series.observations,dataWarning:series.dataWarning});
      return patch;
    });
    port.postMessage({type:'patterns',tick:message.tick,patches,length:len});
  } else if (message.type === 'sync') {
    grow(message.capacity);
    for (const key of keys) mirror[key].set(message.columns[key], message.start);
    for(const key of FLOW_COLUMNS){const values=message.columns.flow?.[key];if(values){flow[key]??=new Float64Array(message.capacity).fill(NaN);flow[key]!.set(values,message.start);}else flow[key]?.fill(NaN,message.start,message.length);}
    len = message.length; closedLength = message.closedLength ?? Math.max(0, len - 1);
    if (message.reqs) { runtime.set(message.reqs); full(message.tick, message.start); }
    else tail(message.tick, message.start);
  } else {
    grow(message.capacity); len = message.length; closedLength = message.closedLength ?? Math.max(0, len - 1);
    const index = len - 1;
    for (const key of keys) mirror[key][index] = message.bar[key];
    for(const key of FLOW_COLUMNS){const value=message.bar[key];if(Number.isFinite(value))flow[key]??=new Float64Array(message.capacity).fill(NaN);if(flow[key])flow[key]![index]=value??NaN;}
    tail(message.tick, index);
  }
};
