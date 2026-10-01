import { describe, expect, it } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import type { DerivedSeries, ParamValues } from '../src/lib/core/types';
import { IndicatorRegistry, registerBuiltins } from '../src/lib/indicators/registry';
import { IndicatorRuntime } from '../src/lib/indicators/runtime';

const registry = new IndicatorRegistry();
registerBuiltins(registry);
const ma = 'strategy-ma-cross';
const reversal = 'strategy-rsi-reversal';
const bar = (index: number, close: number) => ({
  time: index * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 10,
});
function storeOf(closes: number[], start = 0): ColumnStore {
  const store = new ColumnStore(8);
  closes.forEach((close, index) => store.appendBar(bar(start + index, close)));
  return store;
}
function snapshot(series: DerivedSeries[], length: number): number[][] {
  return series.map(value => Array.from(value.values.subarray(0, length)));
}
function anchors(series:DerivedSeries[],length:number){return series.map(value=>({offsets:value.markerOffsets?Array.from(value.markerOffsets.subarray(0,length)):undefined,values:value.markerValues?Array.from(value.markerValues.subarray(0,length)):undefined}));}
function expectAnchors(actual:DerivedSeries[],expected:DerivedSeries[],length:number){actual.forEach((series,index)=>{for(const field of ['markerOffsets','markerValues'] as const){if(!expected[index][field]){expect(series[field]).toBeUndefined();continue;}expect(series[field]).toBeDefined();for(let i=0;i<length;i++){const value=expected[index][field]![i];if(Number.isFinite(value))expect(series[field]![i]).toBeCloseTo(value,10);else expect(series[field]![i]).toBeNaN();}}});}
function sparse(length: number, points: Array<[number, number]>): number[] {
  const values = Array<number>(length).fill(NaN);
  points.forEach(([index, value]) => { values[index] = value; });
  return values;
}
function calculate(id: string, closes: number[], params: ParamValues): DerivedSeries[] {
  const cols = storeOf(closes);
  return registry.get(id).calc({ cols, from: 0, to: cols.length }, params);
}
const cases: Array<{ id: string; params: ParamValues; label: string }> = [
  { id: ma, params: { fast: 1, slow: 2, method: 'EMA' }, label: 'EMA crossover' },
  { id: ma, params: { fast: 1, slow: 2, method: 'SMA' }, label: 'SMA crossover' },
  { id: reversal, params: { period: 2, lower: 30, upper: 70 }, label: 'RSI reversal' },
];

describe('registered strategy signals', () => {
  it('exposes searchable strategy metadata, editable defaults and directional main-pane markers', () => {
    expect(registry.list().filter(def => def.kind === 'strategy').map(def => def.id).sort())
      .toEqual(['pattern-confluence','pattern-harmonic','pattern-huzi',ma, reversal]);
    expect(registry.get('pattern-confluence')).toMatchObject({kind:'strategy',category:'pattern',target:'main'});
    expect(registry.defaults(ma)).toEqual({ fast: 9, slow: 21, method: 'EMA' });
    expect(registry.defaults(reversal)).toEqual({ period: 14, lower: 30, upper: 70 });
    for (const id of [ma, reversal]) {
      const def = registry.get(id);
      expect(def).toMatchObject({ kind: 'strategy', source: 'builtin', target: 'main' });
      expect(def.title).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.tags?.length).toBeGreaterThan(0);
      expect(def.createIncremental).toBeTypeOf('function');
      const out = calculate(id, [10, 10], registry.defaults(id));
      expect(out.map(({ name, markerSide, plot, pane }) => ({ name, markerSide, plot, pane })))
        .toEqual([
          { name: '买入', markerSide: 'buy', plot: 'markers', pane: 'main' },
          { name: '卖出', markerSide: 'sell', plot: 'markers', pane: 'main' },
        ]);
    }
  });

  for (const method of ['EMA', 'SMA']) {
    it(`${method}: marks crossings on the next candle at the completed candle's close`, () => {
      const closes = [10, 10, 10, 12, 12, 8, 8, 12, 12];
      const out = calculate(ma, closes, { fast: 1, slow: 2, method });
      expect(snapshot(out, closes.length)).toEqual([
        sparse(9, [[4, 12], [8, 12]]), sparse(9, [[6, 8]]),
      ]);
    });

    it(`${method}: requires a fully warmed previous slow average before accepting a crossing`, () => {
      const out = calculate(ma, [10, 12, 8, 12, 8, 12, 8], { fast: 1, slow: 5, method });
      expect(snapshot(out, 7)).toEqual([sparse(7, [[6, 12]]), sparse(7, [])]);
    });
  }

  it('RSI marks exits from oversold/overbought after the candle closes', () => {
    const out = calculate(reversal, [10, 8, 6, 10, 12, 10, 8, 12, 12], { period: 2, lower: 30, upper: 70 });
    expect(snapshot(out, 9)).toEqual([sparse(9, [[4, 10], [8, 12]]), sparse(9, [[6, 10]])]);
    expect(out.every(series=>series.markerOffsets===undefined&&series.markerValues===undefined)).toBe(true);
  });

  it('anchors a confirmed SMA signal to the true intersection without moving its confirmation or reported price',()=>{
    const out=calculate(ma,[5,4,3,2,3,5],{fast:1,slow:2,method:'SMA'});
    expect(out[0].values[4]).toBeNaN();expect(out[0].values[5]).toBe(3);
    expect(out[0].markerOffsets![5]).toBe(-1.5);expect(out[0].markerValues![5]).toBe(2.5);
    expect(out[0].markerOffsets!.slice(0,5).every(Number.isNaN)).toBe(true);expect(out[1].markerValues!.every(Number.isNaN)).toBe(true);
    const touching=calculate(ma,[10,10,10,12,12],{fast:1,slow:2,method:'SMA'});expect(touching[0].values[4]).toBe(12);expect(touching[0].markerOffsets![4]).toBe(-2);expect(touching[0].markerValues![4]).toBe(10);
  });

  it('RSI includes an exact threshold touch and does not signal when entering an extreme', () => {
    // RSI(1): NaN, 0, 50, 100, 50, 0, 50. Only exits generate signals.
    const out = calculate(reversal, [10, 8, 8, 10, 10, 8, 8], { period: 1, lower: 0, upper: 100 });
    expect(snapshot(out, 7)).toEqual([sparse(7, [[3, 8]]), sparse(7, [[5, 10]])]);
  });

  for (const { id, params, label } of cases) {
    it(`${label}: live replacements are stable and appending confirms signals without changing history`, () => {
      const store = new ColumnStore(8), runtime = new IndicatorRuntime(registry);
      runtime.set([{ id, params, instanceId: 'live' }]);
      let previous: number[][] = [[], []];
      let totalSignals = 0;
      for (let index = 0; index < 36; index++) {
        const close = 100 + Math.sin(index / 2) * 12;
        store.appendBar(bar(index, close));
        const initial=runtime.compute(store,index),appended = snapshot(initial, store.length),display=anchors(initial,store.length);
        expect(appended.map(values => values.slice(0, index))).toEqual(previous);
        for (const change of [30, -30, 0.5]) {
          store.updateLast(bar(index, close + change));
          const next=runtime.compute(store,index),updated = snapshot(next, store.length);
          expect(updated).toEqual(appended);
          expect(anchors(next,store.length)).toEqual(display);
          const reference = registry.get(id).calc({ cols: store, from: 0, to: store.length }, params);
          expect(updated).toEqual(snapshot(reference, store.length));
          expectAnchors(next,reference,store.length);
        }
        totalSignals += appended.filter(values => Number.isFinite(values[index])).length;
        previous = appended;
      }
      expect(totalSignals).toBeGreaterThan(2);
    });
  }

  it('duplicate strategies have independent parameters, output buffers and instance identities', () => {
    const store = storeOf([10, 10, 10, 12, 12, 8, 8, 12, 12]);
    const runtime = new IndicatorRuntime(registry);
    const requests = [
      { id: ma, instanceId: 'fast', params: { fast: 1, slow: 2, method: 'SMA' } },
      { id: ma, instanceId: 'slow', params: { fast: 2, slow: 5, method: 'SMA' } },
    ];
    runtime.set(requests);
    const output = runtime.compute(store, 0);
    expect(output.map(series => series.indicatorId)).toEqual(['fast', 'fast', 'slow', 'slow']);
    expect(output.map(series => series.plotIndex)).toEqual([0, 1, 0, 1]);
    expect(output[0].values).not.toBe(output[2].values);
    expect(output[0].markerOffsets).not.toBe(output[2].markerOffsets);expect(output[0].markerValues).not.toBe(output[2].markerValues);
    expect(snapshot(output.slice(0, 2), store.length)).not.toEqual(snapshot(output.slice(2), store.length));
    requests.forEach((request, index) => {
      const reference = registry.get(ma).calc({ cols: store, from: 0, to: store.length }, request.params);
      expect(snapshot(output.slice(index * 2, index * 2 + 2), store.length)).toEqual(snapshot(reference, store.length));
    });
  });
  it('preserves historical anchors across incremental buffer growth and removes them after a corrected historical crossing',()=>{
    const store=storeOf([5,4,3,2,3,5]),runtime=new IndicatorRuntime(registry),params={fast:1,slow:2,method:'SMA'};runtime.set([{id:ma,params}]);const first=runtime.compute(store,0),oldBuffer=first[0].markerOffsets;
    for(let i=6;i<1050;i++){store.appendBar(bar(i,10+Math.sin(i/4)*2));runtime.compute(store,i);}
    const grown=runtime.compute(store,1049);expect(grown[0].markerOffsets).not.toBe(oldBuffer);expect(grown[0].markerOffsets!.length).toBe(grown[0].values.length);expect(grown[0].markerValues!.length).toBe(grown[0].values.length);expect(grown[0].markerOffsets![5]).toBe(-1.5);expect(grown[0].markerValues![5]).toBe(2.5);
    expectAnchors(grown,registry.get(ma).calc({cols:store,from:0,to:store.length},params),store.length);
    store.col('close')[4]=2;const corrected=runtime.compute(store,4);expect(corrected[0].values[5]).toBeNaN();expect(corrected[0].markerOffsets![5]).toBeNaN();expect(corrected[0].markerValues![5]).toBeNaN();
  });
});

describe('confirmed strategy timeframe mapping', () => {
  it('a fixed timeframe matching the chart preserves confirmation timing without an additional delay', () => {
    const store = storeOf([10, 10, 10, 12, 12, 8, 8, 12, 12]);
    const runtime = new IndicatorRuntime(registry), params = { fast: 1, slow: 2, method: 'SMA' };
    runtime.set([
      { id: ma, instanceId: 'chart', params, timeframe: 'chart' },
      { id: ma, instanceId: 'fixed', params, timeframe: '1m', baseIntervalMs: 60_000 },
    ]);
    const output = runtime.compute(store, 0);
    const expected = [sparse(9, [[4, 12], [8, 12]]), sparse(9, [[6, 8]])];
    expect(snapshot(output.slice(0, 2), 9)).toEqual(expected);
    expect(snapshot(output.slice(2), 9)).toEqual(expected);
    expectAnchors(output.slice(2),output.slice(0,2),9);expect(output[2].markerOffsets).not.toBe(output[0].markerOffsets);
  });

  it('higher-timeframe signals appear once at the confirmation bucket boundary, without a second delay', () => {
    const closes = [10, 10, 10, 12, 12, 8, 8, 12, 12].flatMap(close => Array<number>(5).fill(close));
    const store = storeOf(closes), runtime = new IndicatorRuntime(registry);
    runtime.set([{ id: ma, params: { fast: 1, slow: 2, method: 'SMA' }, timeframe: '5m', baseIntervalMs: 60_000 }]);
    const output=runtime.compute(store,0);expect(snapshot(output, closes.length)).toEqual([
      sparse(45, [[20, 12], [40, 12]]), sparse(45, [[30, 8]]),
    ]);
    expect(output.every(series=>series.markerOffsets===undefined&&series.markerValues===undefined)).toBe(true);
  });

  it('higher-timeframe open-bucket replacements and appends cannot repaint or repeat a confirmed signal', () => {
    const closes = [10, 10, 10, 12].flatMap(close => Array<number>(5).fill(close));
    const store = storeOf(closes), runtime = new IndicatorRuntime(registry);
    runtime.set([{ id: ma, params: { fast: 1, slow: 2, method: 'EMA' }, timeframe: '5m', baseIntervalMs: 60_000 }]);
    expect(snapshot(runtime.compute(store, 0), 20)).toEqual([sparse(20, []), sparse(20, [])]);
    for (let index = 20; index < 25; index++) {
      store.appendBar(bar(index, 100));
      runtime.compute(store, index);
      for (const close of [1, 200, 12]) {
        store.updateLast(bar(index, close));
        expect(snapshot(runtime.compute(store, index), store.length)).toEqual([
          sparse(index + 1, [[20, 12]]), sparse(index + 1, []),
        ]);
      }
    }
  });

  it('an initial partial higher-timeframe bucket cannot seed or warm up the strategy', () => {
    // Begin at minute 2, so the initial 100-price bucket is incomplete and excluded.
    const closes = [100, 100, 100, ...[10, 20, 20, 8, 8, 20, 20].flatMap(close => Array<number>(5).fill(close))];
    const store = storeOf(closes, 2), runtime = new IndicatorRuntime(registry);
    runtime.set([{ id: ma, params: { fast: 1, slow: 2, method: 'SMA' }, timeframe: '5m', baseIntervalMs: 60_000 }]);
    expect(snapshot(runtime.compute(store, 0), closes.length)).toEqual([
      sparse(38, [[33, 20]]), sparse(38, [[23, 8]]),
    ]);
  });
});
