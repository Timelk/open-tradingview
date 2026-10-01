import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import type { BarInput, ColumnName, ParamValues } from '../src/lib/core/types';
import { IndicatorRegistry, registerBuiltins } from '../src/lib/indicators/registry';
import { IndicatorRuntime } from '../src/lib/indicators/runtime';
import { IndicatorEngine } from '../src/lib/indicators/engine';
import type { OutMsg } from '../src/lib/indicators/worker';

const minute = 60_000;
const params: ParamValues = { pivotStrength: 2, lookback: 1500, tolerance: 0.04, maxPatterns: 12, showInvalidated: true, family: '三角形' };
const keys: ColumnName[] = ['time', 'open', 'high', 'low', 'close', 'volume'];
const req = { id: 'pattern-huzi', instanceId: 'huzi:test', params };
const bar = (time: number, price: number): BarInput => ({ time, open: price, high: price + 0.1, low: price - 0.1, close: price, volume: 100 });

function fixture(interval = minute): ColumnStore {
  const anchors = [[0, 100], [10, 110], [20, 90], [30, 110], [40, 98], [50, 110], [55, 106], [63, 115], [70, 115]];
  const store = new ColumnStore(128);
  let segment = 0;
  for (let i = 0; i <= 70; i++) {
    while (segment + 1 < anchors.length - 1 && i > anchors[segment + 1][0]) segment++;
    const a = anchors[segment], b = anchors[segment + 1];
    store.appendBar(bar(i * interval, a[1] + (b[1] - a[1]) * (i - a[0]) / (b[0] - a[0])));
  }
  return store;
}
function registry() { const reg = new IndicatorRegistry(); registerBuiltins(reg); return reg; }

afterEach(() => vi.unstubAllGlobals());

describe('pattern worker transport and timeframe semantics', () => {
  it('recalculates a corrected closed wick even when its close and timestamp are unchanged',()=>{
    const reg=registry(),store=fixture(),runner=reg.get('pattern-huzi').createIncremental!(params);
    const before=runner.update(store,0).flatMap(series=>series.patterns??[]).find(p=>p.name==='上升三角形')!;
    expect(before).toBeDefined();expect(before.events?.some(e=>e.kind==='retest')).toBe(false);
    store.col('low')[69]=110;
    const corrected=runner.update(store,69).flatMap(series=>series.patterns??[]).find(p=>p.id===before.id)!;
    expect(corrected.events?.find(e=>e.kind==='retest')?.time).toBe(69*minute);
    expect(corrected.confirmedAt).toBe(before.confirmedAt);
    expect(corrected.points).toEqual(before.points);
  });
  it('retains sparse geometry and scan metadata in real full/tail messages while transferred arrays detach safely', async () => {
    vi.resetModules();
    const messages: OutMsg[] = [], transfers: number[][] = [];
    const port = {
      postMessage: (message: OutMsg, transfer: Transferable[] = []) => {
        transfers.push(transfer.map(value => (value as ArrayBuffer).byteLength));
        messages.push(structuredClone(message, { transfer }));
      },
      onmessage: null as ((event: { data: unknown }) => void) | null,
    };
    vi.stubGlobal('self', port);
    await import('../src/lib/indicators/worker');
    const store = fixture();
    const columns = Object.fromEntries(keys.map(name => [name, store.col(name).slice()]));
    port.onmessage!({ data: { type: 'init', ...columns, length: store.length, capacity: store.capacity, reqs: [req] } });
    const full = messages.at(-1)!;
    if (full.type !== 'full') throw new Error('expected full');
    const original = full.series.flatMap(series => series.patterns ?? []).find(pattern => pattern.name === '上升三角形')!;
    expect(original).toBeDefined();
    expect(full.series[0]).toMatchObject({ indicatorId: req.instanceId, plotIndex: 0, plot: 'patterns', patternScan: { throughTime: 69 * minute } });
    expect(full.series[0].values.every(Number.isNaN)).toBe(true);
    expect(transfers[0]).toEqual([store.length * 8, store.length * 8,store.length * 8]);

    port.onmessage!({ data: { type: 'bar', bar: bar(70 * minute, 80), isNew: false, length: 71, capacity: store.capacity, tick: 1 } });
    const forming = messages.at(-1)!;
    if (forming.type !== 'tail') throw new Error('expected tail');
    expect(forming.patches[0]).toMatchObject({ start: 70, indicatorId: req.instanceId, plot: 'patterns' });
    expect(forming.patches.every(series => !Object.hasOwn(series,'patterns') && !Object.hasOwn(series,'patternScan'))).toBe(true);
    expect(transfers[1]).toEqual([8, 8,8]);

    port.onmessage!({ data: { type: 'bar', bar: bar(71 * minute, 80), isNew: true, length: 72, capacity: store.capacity, tick: 2 } });
    const closed = messages.at(-1)!;
    if (closed.type !== 'tail') throw new Error('expected tail');
    const invalid = closed.patches.flatMap(series => series.patterns ?? []).find(pattern => pattern.id === original.id)!;
    expect(invalid.status).toBe('invalidated');
    expect(invalid.invalidatedAt).toBe(71 * minute);
    expect(invalid.points).toEqual(original.points);
    expect(invalid.confirmedAt).toBe(original.confirmedAt);
    expect(original.status).toBe('confirmed');
    expect(closed.patches[0].patternScan?.throughTime).toBe(70 * minute);
  });

  it('keeps higher-timeframe anchors and confirmation timestamps exact and reuses patterns inside the unfinished bucket', () => {
    const higher = fixture(5 * minute), base = new ColumnStore(512);
    for (let i = 0; i < higher.length; i++) {
      // One minute in the final 5-minute bucket remains open.
      for (let offset = 0; offset < (i === higher.length - 1 ? 1 : 5); offset++) base.appendBar(bar(i * 5 * minute + offset * minute, higher.col('close')[i]));
    }
    const direct = new IndicatorRuntime(registry()); direct.set([{...req,baseIntervalMs:5*minute}]);
    const expected = direct.compute(higher, 0).flatMap(series => series.patterns ?? []);
    expect(expected.length).toBeGreaterThan(0);
    const runtime = new IndicatorRuntime(registry());
    runtime.set([{ ...req, timeframe: '5m', baseIntervalMs: minute }]);
    const out = runtime.compute(base, 0);
    expect(out.flatMap(series => series.patterns ?? [])).toEqual(expected);
    expect(out[0].patternScan?.throughTime).toBe(69 * 5 * minute);
    const geometry = out[0].patterns, scan = out[0].patternScan;
    base.updateLast(bar(350 * minute, 80));
    const replacement = runtime.compute(base, base.length - 1);
    expect(replacement[0].patterns).toBe(geometry);
    expect(replacement[0].patternScan).toBe(scan);
    for (let i = 351; i < 355; i++) { base.appendBar(bar(i * minute, 80)); runtime.compute(base, i); }
    expect(runtime.compute(base, 354)[0].patterns).toBe(geometry);
    base.appendBar(bar(355 * minute, 80));
    const nextBucket = runtime.compute(base, 355);
    const invalid = nextBucket.flatMap(series => series.patterns ?? []).find(pattern => pattern.id === expected[0].id)!;
    expect(invalid.invalidatedAt).toBe(355 * minute);
    expect(invalid.points).toEqual(expected[0].points);
    expect(invalid.confirmedAt).toBe(expected[0].confirmedAt);
  });

  it('does not add an extra confirmation-bar delay when the explicit study timeframe equals the chart', () => {
    const store = fixture(), runtime = new IndicatorRuntime(registry());
    runtime.set([{ ...req, instanceId: 'chart', timeframe: 'chart' }, { ...req, instanceId: 'fixed', timeframe: '1m', baseIntervalMs: minute }]);
    const out = runtime.compute(store, 0);
    const chart = out.filter(series => series.indicatorId === 'chart').flatMap(series => series.patterns ?? []);
    const fixed = out.filter(series => series.indicatorId === 'fixed').flatMap(series => series.patterns ?? []);
    expect(fixed.length).toBeGreaterThan(0);
    expect(fixed).toEqual(chart);
    const geometry = out[0].patterns;
    store.updateLast(bar(70 * minute, 1));
    expect(runtime.compute(store, 70)[0].patterns).toBe(geometry);
  });

  it('applies a sparse tail replacement to the main-thread engine without retaining obsolete pattern metadata', () => {
    class TestWorker {
      static current: TestWorker;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor() { TestWorker.current = this; }
      postMessage() {} terminate() {}
      send(data: unknown) { this.onmessage?.({ data }); }
    }
    vi.stubGlobal('Worker', TestWorker);
    const store = fixture(), reg = registry(), runtime = new IndicatorRuntime(reg);
    runtime.set([req]);
    const series = runtime.compute(store, 0), engine = new IndicatorEngine(reg);
    engine.init(store, [req]);
    TestWorker.current.send({ type: 'full', tick: 0, series });
    expect(engine.derived[0].patterns?.length).toBeGreaterThan(0);
    const originalGeometry=engine.derived[0].patterns;
    TestWorker.current.send({type:'tail',tick:0,length:71,patches:[{name:series[0].name,indicatorId:req.instanceId,plotIndex:0,plot:'patterns',pane:'main',color:series[0].color,start:70,values:Float64Array.of(NaN)}]});
    expect(engine.derived[0].patterns).toBe(originalGeometry);
    const replacement = { ...series[0], patterns: [], patternScan: { ...series[0].patternScan!, throughTime: 70 * minute }, start: 70, values: Float64Array.of(NaN) };
    TestWorker.current.send({ type: 'tail', tick: 1, length: 71, patches: [replacement] });
    expect(engine.derived[0].patterns).toEqual([]);
    expect(engine.derived[0].patternScan?.throughTime).toBe(70 * minute);
    const cleared = { ...replacement, patterns: undefined, patternScan: undefined };
    TestWorker.current.send({ type: 'tail', tick: 2, length: 71, patches: [cleared] });
    expect(engine.derived[0].patterns).toBeUndefined();
    expect(engine.derived[0].patternScan).toBeUndefined();
    engine.destroy();
  });
});
