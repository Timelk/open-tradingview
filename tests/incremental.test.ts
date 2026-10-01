import { describe, it, expect } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import { IndicatorRegistry, registerBuiltins } from '../src/lib/indicators/registry';
import { IndicatorRuntime } from '../src/lib/indicators/runtime';
const reg = new IndicatorRegistry(); registerBuiltins(reg);
describe('incremental indicator equivalence', () => {
  for (const def of reg.list().filter(d=>d.kind!=='strategy')) it(`${def.id}: warmup, repeated live replacements, append and growth match pure reference`, () => {
    const store = new ColumnStore(8);
    const runtime = new IndicatorRuntime(reg);
    const params = reg.defaults(def.id);
    runtime.set([{id: def.id, params}]);
    const bar = (i: number, change = 0) => ({time: i * 60000, open: 100, high: 110 + Math.sin(i) * 4 + change, low: 88, close: 100 + Math.sin(i) * 6 + change, volume: i * 2 + 5 + change});
    for (let i = 0; i < 100; i++) {
      store.appendBar(bar(i));
      for (const change of [0, 1, -1, 0.5]) {
        store.updateLast(bar(i, change));
        const actual = runtime.compute(store, i);
        const expected = def.calc({cols:store, from:0, to:store.length},params);
        for(let j=0;j<expected.length;j++){
          expect(actual[j].observations).toEqual(expected[j].observations);
          expect(actual[j].dataWarning).toBe(expected[j].dataWarning);
        }
        for (let j = 0; j < expected.length; j++) for (let k = 0; k < store.length; k++) {
          const a = actual[j].values[k], b = expected[j].values[k];
          if (Number.isNaN(b)) expect(a).toBeNaN(); else expect(a).toBeCloseTo(b, 6);
        }
      }
    }
    runtime.set([{id:def.id,params}]);
    const actual=runtime.compute(store,0)[0],expected=def.calc({cols:store,from:0,to:100},params)[0];
    if(Number.isNaN(expected.values[99]))expect(actual.values[99]).toBeNaN();else expect(actual.values[99]).toBeCloseTo(expected.values[99],6);
    expect(actual.observations).toEqual(expected.observations);
  });
});
