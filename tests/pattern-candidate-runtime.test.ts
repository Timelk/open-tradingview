import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import type { BarInput, ColumnName, ColumnView, ParamValues } from '../src/lib/core/types';
import { IndicatorRegistry, registerBuiltins } from '../src/lib/indicators/registry';
import { IndicatorEngine } from '../src/lib/indicators/engine';
import type { OutMsg } from '../src/lib/indicators/worker';

const minute = 60_000;
const epoch = Date.parse('2026-08-15T00:00:00Z');
const keys: ColumnName[] = ['time', 'open', 'high', 'low', 'close', 'volume'];
const params: ParamValues = { pivotStrength: 2, lookback: 1500, tolerance: .04, family: '三角形', multiScale: false };
const req = { id: 'pattern-huzi', instanceId: 'huzi:observing', params };
const bar = (i: number, close: number): BarInput => ({ time: epoch + i * minute, open: close, high: close + .1, low: close - .1, close, volume: 10 });
function registry() { const reg = new IndicatorRegistry(); registerBuiltins(reg); return reg; }
function fixture(): ColumnStore {
  // First triangle breaks out; the most recent triangle has not. This fixture
  // checks that a changing observation cannot rewrite a real historical match.
  const anchors = [[0, 100], [10, 110], [20, 90], [30, 110], [40, 98], [50, 110], [55, 106], [63, 115], [70, 115],
    [80, 100], [90, 110], [100, 90], [110, 110], [120, 96], [130, 110], [136, 106]];
  const store = new ColumnStore(512);
  let leg = 0;
  for (let i = 0; i <= 136; i++) {
    while (leg + 1 < anchors.length - 1 && i > anchors[leg + 1][0]) leg++;
    const a = anchors[leg], b = anchors[leg + 1];
    store.appendBar(bar(i, a[1] + (b[1] - a[1]) * (i - a[0]) / (b[0] - a[0])));
  }
  return store;
}
afterEach(() => vi.unstubAllGlobals());

describe('independent candidate and confirmed pattern updates', () => {
  it('reuses unchanged preview geometry and closed results while quotes can withdraw the observation', () => {
    const reg = registry(), store = fixture(), runner = reg.get(req.id).createIncremental!(params);
    const first = runner.update(store, 0), history = first.slice(0, 2).map(series => series.patterns), scan = first[0].patternScan;
    const confirmed = history.flatMap(patterns => patterns ?? []);
    const candidates = first[2].candidates!;
    expect(confirmed.length).toBeGreaterThan(0);
    expect(candidates.length).toBeGreaterThan(0);
    const confirmationTimes = confirmed.map(pattern => [pattern.id, pattern.confirmedAt]);
    const checkHistory = (out: ReturnType<typeof runner.update>) => {
      expect(out[0].patterns).toBe(history[0]);
      expect(out[1].patterns).toBe(history[1]);
      expect(out[0].patternScan).toBe(scan);
      expect(out[1].patternScan).toBe(scan);
      expect(out.flatMap(series => series.patterns ?? []).map(pattern => [pattern.id, pattern.confirmedAt])).toEqual(confirmationTimes);
    };

    store.updateLast({ ...bar(136, 107), volume: 25 });
    const unchanged = runner.update(store, 136);
    checkHistory(unchanged);
    expect(unchanged[2].candidates).toBe(candidates);
    store.updateLast({ ...bar(136, 107), high: 130, volume: 30 });
    const withdrawn = runner.update(store, 136);
    checkHistory(withdrawn);
    expect(withdrawn[2].candidates).toEqual([]);
    store.updateLast({ ...bar(136, 107), high: 130, volume: 35 });
    expect(runner.update(store, 136)[2].candidates).toBe(withdrawn[2].candidates);
    store.updateLast(bar(136, 107));
    const returned = runner.update(store, 136);
    checkHistory(returned);
    expect(returned[2].candidates).toEqual(candidates);
    expect(returned[2].candidates).not.toBe(candidates);
  });

  it('survives a closing-packet sentinel and advances on the new forming candle', () => {
    const reg = registry(), store = fixture(), runner = reg.get(req.id).createIncremental!(params);
    const forming = runner.update(store, 0), before = forming[2].candidates!;
    expect(before.length).toBeGreaterThan(0);
    const view: ColumnView = { length: store.length, closedLength: store.length, col: name => store.col(name) };
    const closed = runner.update(view, store.length - 1);
    expect(closed[0].patternScan?.throughTime).toBe(epoch + 136 * minute);
    expect(closed[2].candidates).toBe(before);
    const scan = closed[0].patternScan, geometry = closed[0].patterns;
    store.appendBar(bar(137, 107));
    const next = runner.update(store, store.length - 1);
    expect(next[0].patternScan).toBe(scan);
    expect(next[0].patterns).toBe(geometry);
    expect(next[2].candidates?.[0].points).toEqual(before[0].points);
    expect(next[2].candidates?.[0].availableAt).toBe(before[0].availableAt);
    expect(next[2].candidates?.[0].observedAt).toBe(epoch + 137 * minute);
    expect(next[2].candidates?.[0].guides?.every(guide => guide.points[1].time === epoch + 137 * minute)).toBe(true);
  });

  it('transfers only changed candidate metadata, including explicit withdrawal, through the real worker and engine', async () => {
    vi.resetModules();
    const messages: OutMsg[] = [];
    const port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(message: OutMsg, transfer: Transferable[] = []) { messages.push(structuredClone(message, { transfer })); },
    };
    vi.stubGlobal('self', port);
    await import('../src/lib/indicators/worker');
    class ClientWorker {
      static current: ClientWorker;
      onmessage: ((event: { data: OutMsg }) => void) | null = null;
      constructor() { ClientWorker.current = this; }
      postMessage() {} terminate() {}
      deliver(message: OutMsg) { this.onmessage?.({ data: message }); }
    }
    vi.stubGlobal('Worker', ClientWorker);
    const store = fixture(), engine = new IndicatorEngine(registry());
    engine.init(store, [req]);
    const columns = Object.fromEntries(keys.map(name => [name, store.col(name).slice()]));
    port.onmessage!({ data: { type: 'init', ...columns, length: store.length, capacity: store.capacity, reqs: [req] } });
    const initial = messages.at(-1)!;
    expect(initial.type).toBe('full');
    ClientWorker.current.deliver(initial);
    const preview = engine.derived[2].candidates, history = engine.derived.slice(0, 2).map(series => series.patterns), scan = engine.derived[0].patternScan;
    expect(preview?.length).toBeGreaterThan(0);
    expect(history.flatMap(patterns => patterns ?? []).length).toBeGreaterThan(0);

    const tick = (value: BarInput, number: number, closedLength = store.length - 1) => {
      port.onmessage!({ data: { type: 'bar', bar: value, isNew: false, length: store.length, capacity: store.capacity, tick: number, closedLength } });
      const message = messages.at(-1)!;
      if (message.type !== 'tail') throw Error('Expected candidate tail patch');
      ClientWorker.current.deliver(message);
      return message;
    };
    const same = tick({ ...bar(136, 107), volume: 20 }, 1);
    expect(same.patches).toHaveLength(3);
    expect(same.patches.every(patch => !Object.hasOwn(patch, 'candidates'))).toBe(true);
    expect(same.patches.every(patch => !Object.hasOwn(patch, 'patterns') && !Object.hasOwn(patch, 'patternScan'))).toBe(true);
    expect(engine.derived[2].candidates).toBe(preview);

    const gone = tick({ ...bar(136, 107), high: 130 }, 2);
    expect(Object.hasOwn(gone.patches[2], 'candidates')).toBe(true);
    expect(gone.patches[2].candidates).toEqual([]);
    expect(engine.derived[2].candidates).toEqual([]);
    expect(engine.derived[0].patterns).toBe(history[0]);
    expect(engine.derived[1].patterns).toBe(history[1]);
    expect(engine.derived[0].patternScan).toBe(scan);
    const stillGone = tick({ ...bar(136, 107), high: 130, volume: 40 }, 3);
    expect(Object.hasOwn(stillGone.patches[2], 'candidates')).toBe(false);
    expect(engine.derived[2].candidates).toEqual([]);

    const reappeared = tick(bar(136, 107), 4);
    expect(reappeared.patches[2].candidates).toEqual(preview);
    expect(engine.derived[2].candidates).toEqual(preview);
    const closing = tick(bar(136, 107), 5, store.length);
    expect(closing.patches[0].patternScan?.throughTime).toBe(epoch + 136 * minute);
    expect(engine.derived[2].candidates).toEqual(preview);
    engine.destroy();
  });
});
