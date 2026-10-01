import {FLOW_COLUMNS,type ColumnName,type ColumnView,type DerivedSeries,type FlowColumnName} from '../core/types';
import type { ColumnStore } from '../core/datastore';
import { IndicatorRegistry } from './registry';
import type { OutMsg } from './worker';
import { IndicatorRuntime, requestSignature, calculationSignature, type IndicatorReq } from './runtime';

export interface AppliedIndicatorRange { from: number; length: number }
const keys: ColumnName[] = ['time', 'open', 'high', 'low', 'close', 'volume'];

/** One worker calculation at a time. Pending ticks collapse to a dirty range in
 * the primary store, retaining every candle's final OHLCV without a tick queue. */
export class IndicatorEngine {
  derived: DerivedSeries[] = [];
  readonly reg: IndicatorRegistry;
  onUpdate: (range: AppliedIndicatorRange) => void = () => {};
  onFallback: (reason: string) => void = () => {};
  private worker: Worker | null = null;
  private useWorker = false;
  private store: ColumnStore | null = null;
  private reqs: IndicatorReq[] = [];
  private tick = 0;
  private requestedConfigTick = 0;
  pending = false;
  private lastApplied = -1;
  private runtime: IndicatorRuntime;
  private epoch = 0;
  private inFlight: number | null = null;
  private dirtyFrom = Infinity;
  private configPending = false;
  private windowPending=false;
  private requestedWindowTick=0;
  private closedLength = 0;
  get mode(): 'worker' | 'main' { return this.useWorker ? 'worker' : 'main'; }

  constructor(reg: IndicatorRegistry) { this.reg = reg; this.runtime = new IndicatorRuntime(reg); }

  init(store: ColumnStore, reqs: IndicatorReq[], lastBarConfirmed = false): void {
    this.store = store; this.reqs = reqs.map(copyRequest); this.tick = 0; this.requestedConfigTick = 0;
    this.pending = true; this.lastApplied = -1; this.derived = [];
    this.dirtyFrom = Infinity; this.configPending = false; this.windowPending=false;this.requestedWindowTick=0;this.inFlight = 0;
    this.closedLength = Math.max(0, store.length - (lastBarConfirmed ? 0 : 1));
    this.runtime.set(reqs, true);
    const epoch = ++this.epoch;
    try {
      this.worker?.terminate();
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.useWorker = true;
      this.worker.onmessage = (ev: MessageEvent) => {
        if (epoch !== this.epoch) return;
        const message = ev.data as OutMsg;
        // Even an obsolete configuration response acknowledges the in-flight
        // job, otherwise a newer configuration could remain stuck forever.
        if (this.inFlight !== null && message.tick >= this.inFlight) this.inFlight = null;
        this.apply(message); this.flush();
      };
      this.worker.onerror = () => { if (epoch === this.epoch) this.enterFallback('worker error'); };
      const cols = snapshot(store, 0, store.capacity);
      this.worker.postMessage({ type: 'init', ...cols, length: store.length, capacity: store.capacity, closedLength: this.closedLength, reqs }, buffers(cols));
    } catch (e) { this.enterFallback(`worker init failed: ${String(e)}`); }
  }

  pushBar(_isNew: boolean, confirmed = false): void {
    if (!this.store?.length) return;
    this.tick++;
    this.closedLength = Math.max(0, this.store.length - (confirmed ? 0 : 1));
    this.dirtyFrom = Math.min(this.dirtyFrom, this.store.length - 1);
    this.growDerived();
    if (!this.useWorker || !this.worker) { this.recomputeMain(); return; }
    this.flush();
  }

  setReqs(reqs: IndicatorReq[]): void {
    if (requestSignature(reqs) === requestSignature(this.reqs)) return;
    const windowOnly=calculationSignature(reqs)===calculationSignature(this.reqs)&&reqs.every((req,index)=>
      JSON.stringify(req.patternWindow)===JSON.stringify(this.reqs[index]?.patternWindow)||['pattern','analysis'].includes(this.reg.get(req.id).category??''));
    this.reqs = reqs.map(copyRequest); this.runtime.set(reqs); this.tick++;
    this.pending=true;
    if(windowOnly){this.windowPending=true;this.requestedWindowTick=this.tick;}
    else{this.requestedConfigTick = this.tick;this.configPending = true;this.windowPending=false;}
    if (!this.useWorker || !this.worker) { this.recomputeMain(); return; }
    this.flush();
  }

  destroy(): void {
    this.epoch++; this.worker?.terminate(); this.worker = null; this.useWorker = false;
    this.store = null; this.inFlight = null; this.dirtyFrom = Infinity; this.configPending = false;this.windowPending=false;
  }

  private flush(): void {
    if (!this.worker || !this.store || this.inFlight !== null || (!this.configPending&&!this.windowPending && !Number.isFinite(this.dirtyFrom))) return;
    if(this.windowPending&&!this.configPending){
      this.inFlight=this.tick;this.windowPending=false;
      try{this.worker.postMessage({type:'pattern-window',reqs:this.reqs,tick:this.tick});}
      catch(error){this.enterFallback(`pattern window update failed: ${String(error)}`);}
      return;
    }
    const store = this.store, start = Math.min(this.dirtyFrom, Math.max(0, store.length - 1));
    const columns = snapshot(store, start, store.length);
    const reqs = this.configPending ? this.reqs : undefined;
    this.inFlight = this.tick; this.dirtyFrom = Infinity; this.configPending = false;this.windowPending=false;
    try {
      this.worker.postMessage({ type: 'sync', start, columns, length: store.length, capacity: store.capacity,
        tick: this.tick, closedLength: this.closedLength, ...(reqs ? { reqs } : {}) }, buffers(columns));
    } catch (error) { this.enterFallback(`worker update failed: ${String(error)}`); }
  }

  private growDerived(): void {
    const capacity = this.store?.capacity ?? 0;
    for (const series of this.derived) for (const field of ['values', 'markerOffsets', 'markerValues'] as const) {
      const values = series[field];
      if (values && values.length < capacity) {
        const grown = new Float64Array(capacity).fill(NaN); grown.set(values); series[field] = grown;
      }
    }
  }

  private apply(msg: OutMsg): void {
    if (msg.tick < this.lastApplied || msg.tick < this.requestedConfigTick) return;
    this.lastApplied = msg.tick;
    if (msg.type === 'full') {
      this.pending = msg.tick<this.requestedWindowTick;
      const cap = this.store?.capacity ?? msg.series[0]?.values.length ?? 0;
      this.derived = msg.series.map(series => {
        const copy = (values: Float64Array) => { const arr = new Float64Array(Math.max(cap, values.length)).fill(NaN); arr.set(values); return arr; };
        return { ...series, values: copy(series.values), ...(series.markerOffsets ? { markerOffsets: copy(series.markerOffsets) } : {}), ...(series.markerValues ? { markerValues: copy(series.markerValues) } : {}) };
      });
    } else if(msg.type==='patterns'){
      if(msg.tick<this.requestedWindowTick)return;
      this.pending=false;
      for(const patch of msg.patches){
        const series=this.derived.find(item=>item.indicatorId===patch.indicatorId&&(patch.plotIndex!==undefined?item.plotIndex===patch.plotIndex:item.name===patch.name));
        if(!series||!['patterns','analysis'].includes(series.plot))continue;
        series.patterns=patch.patterns;series.patternScan=patch.patternScan;series.candidates=patch.candidates;
        series.observations=patch.observations;series.dataWarning=patch.dataWarning;
      }
    } else {
      for (const patch of msg.patches) {
        const series = this.derived.find(item => item.indicatorId === patch.indicatorId &&
          (patch.plotIndex !== undefined && item.plotIndex !== undefined ? item.plotIndex === patch.plotIndex : item.name === patch.name));
        if (!series) continue;
        if (series.values.length < msg.length) {
          const next = new Float64Array(Math.max(this.store?.capacity ?? 0, msg.length)).fill(NaN); next.set(series.values); series.values = next;
        }
        series.values.set(patch.values, patch.start);
        for (const field of ['markerOffsets', 'markerValues'] as const) {
          const values = patch[field]; if (!values) { delete series[field]; continue; }
          const previous = series[field];
          if (!previous || previous.length < series.values.length) { const next = new Float64Array(series.values.length).fill(NaN); if (previous) next.set(previous); series[field] = next; }
          series[field]!.set(values, patch.start);
        }
        series.name = patch.name; series.color = patch.color; series.pane = patch.pane; series.plot = patch.plot;
        series.timeframe = patch.timeframe; series.markerSide = patch.markerSide; series.plotIndex = patch.plotIndex;
        if (Object.hasOwn(patch, 'patterns')) series.patterns = patch.patterns;
        if (Object.hasOwn(patch, 'patternScan')) series.patternScan = patch.patternScan;
        if (Object.hasOwn(patch, 'candidates')) series.candidates = patch.candidates;
        if (Object.hasOwn(patch, 'observations')) series.observations = patch.observations;
        if (Object.hasOwn(patch, 'dataWarning')) series.dataWarning = patch.dataWarning;
        if (Object.hasOwn(patch, 'divergences')) series.divergences = patch.divergences;
      }
    }
    this.onUpdate(msg.type === 'full'
      ? { from: 0, length: msg.length ?? msg.series[0]?.values.length ?? 0 }
      : msg.type==='patterns'?{from:msg.length,length:msg.length}
      : { from: msg.patches.reduce((from, patch) => Math.min(from, patch.start), msg.length), length: msg.length });
  }

  private enterFallback(reason: string): void {
    this.epoch++; // Ignore any already queued callbacks from the failed worker.
    this.useWorker = false;
    try { this.worker?.terminate(); } catch { /* Already terminated. */ }
    this.worker = null; this.inFlight = null;
    this.runtime.set(this.reqs, true); this.dirtyFrom = 0;
    this.recomputeMain(); this.onFallback(reason);
  }

  private recomputeMain(): void {
    if (!this.store) return;
    const store = this.store, full = this.configPending || this.lastApplied < 0;
    const from = Math.min(this.dirtyFrom, Math.max(0, store.length - 1));
    const view: ColumnView = { length: store.length, closedLength: this.closedLength, col: name => store.col(name),flow:name=>store.flow(name) };
    if(this.windowPending&&!this.configPending&&this.lastApplied>=0&&!Number.isFinite(this.dirtyFrom)){
      const updates=this.runtime.compute(view,store.length,true);
      for(const update of updates){const previous=this.derived.find(item=>item.indicatorId===update.indicatorId&&item.plotIndex===update.plotIndex);if(previous){previous.patterns=update.patterns;previous.patternScan=update.patternScan;previous.candidates=update.candidates;previous.observations=update.observations;previous.dataWarning=update.dataWarning;}}
      this.pending=false;this.windowPending=false;this.lastApplied=this.tick;this.onUpdate({from:store.length,length:store.length});return;
    }
    this.derived = this.runtime.compute(view, from);
    this.pending = false; this.configPending = false;this.windowPending=false; this.dirtyFrom = Infinity; this.lastApplied = this.tick;
    this.onUpdate({ from: full ? 0 : this.runtime.dirtyFrom, length: store.length });
  }
}

type Snapshot=Record<ColumnName,Float64Array>&{flow?:Partial<Record<FlowColumnName,Float64Array>>};
function snapshot(store: ColumnStore, start: number, end: number):Snapshot {
  const result=Object.fromEntries(keys.map(name => [name, store.col(name).slice(start, end)])) as unknown as Snapshot;
  for(const name of FLOW_COLUMNS){const values=store.flow(name);if(values){result.flow??={};result.flow[name]=values.slice(start,end);}}
  return result;
}
function buffers(columns:Snapshot):ArrayBuffer[]{return [...keys.map(key=>columns[key]),...Object.values(columns.flow??{})].map(column=>column.buffer as ArrayBuffer);}
function copyRequest(req:IndicatorReq):IndicatorReq{return {...req,params:{...req.params},...(req.patternWindow?{patternWindow:{...req.patternWindow}}:{})};}
