import type { ColumnView, DerivedSeries, IncrementalCalculator, ParamValues } from '../core/types';
import type { IndicatorRegistry } from './registry';
import { TIMEFRAMES } from '../scene/types';
import { TimeframeCache } from './timeframe';
import {OscillatorDivergenceCalculator} from './divergence';

export interface IndicatorReq {
  id: string; params: ParamValues;
  instanceId?: string; timeframe?: string; baseIntervalMs?: number;
  patternWindow?: { fromTime:number; toTime:number };
}
interface Entry { req: IndicatorReq; key: string; runner?: IncrementalCalculator; mapped: DerivedSeries[]; initialized: boolean; divergence?:OscillatorDivergenceCalculator }
const signature = (req: IndicatorReq) => JSON.stringify([req.id, req.instanceId ?? '', req.timeframe ?? 'chart', req.baseIntervalMs ?? 60_000,
  Object.entries(req.params).sort(([a], [b]) => a.localeCompare(b))]);
export const calculationSignature = (reqs: IndicatorReq[]) => reqs.map(signature).join('\n');
export const requestSignature = (reqs: IndicatorReq[]) => reqs.map(req=>`${signature(req)}:${JSON.stringify(req.patternWindow??null)}`).join('\n');

/** Instance-owned recursions and shared UTC aggregations. A developing higher
 * timeframe value is previewed only at the last chart bar, never projected into
 * past bars. Confirmed strategies keep their own confirmation contract. */
export class IndicatorRuntime {
  private entries: Entry[] = [];
  private caches = new Map<number, TimeframeCache>();
  private previousLength = 0;
  dirtyFrom = 0;
  constructor(private reg: IndicatorRegistry) {}

  set(reqs: IndicatorReq[], reset = false): void {
    const previous = reset ? [] : [...this.entries];
    this.entries = reqs.map(request => {
      const key = signature(request), at = previous.findIndex(entry => entry.key === key);
      const req = { ...request, params: { ...request.params }, ...(request.patternWindow?{patternWindow:{...request.patternWindow}}:{}) };
      if (at >= 0) { const entry=previous.splice(at,1)[0];entry.req=req;return entry; }
      return { req, key, runner: this.reg.get(req.id).createIncremental?.(req.params), mapped: [], initialized: false };
    });
    if (reset) { this.caches.clear(); this.previousLength = 0; }
    else {
      const needed = new Set(reqs.map(req => TIMEFRAMES[req.timeframe ?? 'chart']).filter(Boolean));
      for (const interval of this.caches.keys()) if (!needed.has(interval)) this.caches.delete(interval);
    }
  }

  compute(cols: ColumnView, from: number, patternsOnly=false): DerivedSeries[] {
    const updated = new Set<number>(), result: DerivedSeries[] = [];
    this.dirtyFrom = Math.max(0, Math.min(from, cols.length));
    for (const entry of this.entries) {
      const { req, runner } = entry, sourceMs = TIMEFRAMES[req.timeframe ?? 'chart'], baseMs = req.baseIntervalMs ?? 60_000;
      const definition = this.reg.get(req.id);
      if(patternsOnly&&!['pattern','analysis'].includes(definition.category??''))continue;
      if (sourceMs && sourceMs < baseMs) continue; // Requires an independent lower-timeframe feed.
      const higher = !!sourceMs && sourceMs > baseMs;
      let view:ColumnView = {...cols,col:name=>cols.col(name),flow:name=>cols.flow?.(name),intervalMs:cols.intervalMs??baseMs}, dirty = entry.initialized ? from : 0, cache: TimeframeCache | undefined;
      if (higher) {
        cache = this.caches.get(sourceMs);
        if (!cache) { cache = new TimeframeCache(sourceMs); this.caches.set(sourceMs, cache); }
        if (!updated.has(sourceMs)) { cache.update(view, from); updated.add(sourceMs); }
        const offset = cache.offset, aggregateLength = Math.max(0, cache.store.length - offset);
        const baseClosed = cols.closedLength ?? Math.max(0, cols.length - 1);
        const bucketClosed = cols.length > 0 && baseClosed === cols.length &&
          cols.col('time')[cols.length - 1] + baseMs >= cache.store.timeAt(cache.store.length - 1) + sourceMs;
        view = { length: aggregateLength, intervalMs:sourceMs,closedLength: Math.max(0, aggregateLength - (bucketClosed ? 0 : 1)),
          col: name => cache!.store.col(name).subarray(offset, cache!.store.length),flow:name=>cache!.store.flow(name)?.subarray(offset,cache!.store.length) };
        dirty = entry.initialized ? patternsOnly&&from>=cols.length?view.length:Math.max(0, cache.dirty - offset) : 0;
      }
      if(['pattern','analysis'].includes(definition.category??'')){const source=view;view={length:source.length,intervalMs:source.intervalMs,closedLength:source.closedLength,col:name=>source.col(name),flow:name=>source.flow?.(name),patternWindow:req.patternWindow};}
      const out = runner ? runner.update(view, dirty) : definition.calc({ cols: view, from: dirty, to: view.length }, req.params);
      // Independent oscillator evidence is computed on the study's own closed
      // source bars, before higher-timeframe values are projected for display.
      // The calculator checkpoints confirmed pivots: forming ticks reuse the
      // same sparse array, while newly closed bars only inspect new pivots.
      if(['rsi','macd','kdj'].includes(req.id)&&out[0]){
        const primary=out[0];
        if(req.params.showDivergences!==false&&primary.plot==='line'){
          entry.divergence??=new OscillatorDivergenceCalculator({indicator:req.id,seriesName:primary.name,plotIndex:0},
            {divergenceStrength:typeof req.params.divergenceStrength==='number'?req.params.divergenceStrength:undefined});
          primary.divergences=entry.divergence.update(view,primary.values,dirty);
        }else{primary.divergences=undefined;entry.divergence=undefined;}
      }
      // Selecting the chart's explicit period must behave exactly like "chart";
      // an extra confirmation shift here used to freeze ordinary indicators.
      if (!higher) {
        result.push(...out.map((series, plotIndex) => ({ ...series, plotIndex, timeframe: req.timeframe ?? 'chart', indicatorId: req.instanceId ?? req.id })));
        entry.initialized = true; continue;
      }
      if (entry.mapped.length !== out.length) entry.mapped = out.map((series, plotIndex) => ({ ...series, plotIndex,
        timeframe: req.timeframe ?? 'chart', indicatorId: req.instanceId ?? req.id, values: new Float64Array(0), markerOffsets: undefined, markerValues: undefined }));
      // Undo the previous bar's provisional preview when the chart advances.
      // The worker must ship this earlier point as well as the new tail.
      let mapFrom = entry.initialized ? from : 0;
      if (definition.kind !== 'strategy' && cols.length > this.previousLength && this.previousLength > 0)
        mapFrom = Math.min(mapFrom, this.previousLength - 1);
      this.dirtyFrom = Math.min(this.dirtyFrom, mapFrom);
      out.forEach((series, index) => {
        const mapped = entry.mapped[index];
        if (mapped.values.length < cols.length) {
          const next = new Float64Array(Math.max(cols.length + 1024, mapped.values.length * 2)).fill(NaN); next.set(mapped.values); mapped.values = next;
        }
        // Display anchors on another timeframe need their own projection;
        // preserving source offsets would place the signal on the wrong bar.
        delete mapped.markerOffsets; delete mapped.markerValues;
        const marker = series.plot === 'markers', confirmed = marker && definition.kind === 'strategy';
        for (let i = mapFrom; i < cols.length; i++) {
          const livePreview = !marker && definition.kind !== 'strategy' && i === cols.length - 1;
          const bucket = cache!.map[i] - cache!.offset - (confirmed || livePreview ? 0 : 1);
          const boundary = i === 0 || cache!.map[i] !== cache!.map[i - 1];
          mapped.values[i] = bucket >= 0 && (!marker || boundary) ? series.values[bucket] : NaN;
        }
        mapped.name = series.name; mapped.color = series.color; mapped.pane = series.pane; mapped.plot = series.plot;
        mapped.markerSide = series.markerSide; mapped.plotIndex = index;
        mapped.patterns = series.patterns; mapped.patternScan = series.patternScan;
        mapped.candidates=series.candidates;
        mapped.observations=series.observations;mapped.dataWarning=series.dataWarning;
        mapped.divergences=series.divergences;
      });
      entry.initialized = true; result.push(...entry.mapped);
    }
    if(!patternsOnly)this.previousLength = cols.length;
    return result;
  }
}
