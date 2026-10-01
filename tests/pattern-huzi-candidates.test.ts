import { describe, expect, it } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import type { ColumnView, ParamValues } from '../src/lib/core/types';
import { detectHuziCandidates } from '../src/lib/patterns/huzi-candidates';
import type { PatternMatch } from '../src/lib/patterns/types';

const minute = 60_000;
const epoch = Date.parse('2026-08-15T00:00:00Z');
type Anchor = [number, number];
const defaults: ParamValues = { pivotStrength: 2, lookback: 1500, tolerance: .04, family: '全部', multiScale: false };
const triangle: Anchor[] = [[0, 100], [10, 110], [20, 90], [30, 110], [40, 96], [50, 110], [56, 106]];
const wedge: Anchor[] = [[0, 100], [10, 110], [20, 90], [30, 113], [40, 101], [50, 116], [56, 111]];
const channel: Anchor[] = [[0, 100], [10, 110], [20, 100], [30, 112], [40, 102], [50, 114], [60, 104], [70, 116], [76, 111]];
const inverse = (anchors: Anchor[]) => anchors.map(([i, price]): Anchor => [i, 240 - price]);
function candles(anchors: Anchor[], end = anchors.at(-1)![0]): ColumnStore {
  const store = new ColumnStore();
  let leg = 0;
  for (let i = 0; i <= end; i++) {
    while (leg + 1 < anchors.length - 1 && i > anchors[leg + 1][0]) leg++;
    const a = anchors[leg], b = anchors[leg + 1];
    const close = a[1] + (b[1] - a[1]) * (i - a[0]) / (b[0] - a[0]);
    store.appendBar({ time: epoch + i * minute, open: close, high: close + .1, low: close - .1, close, volume: 10 });
  }
  return store;
}

describe('Huzi current unbroken framework candidates', () => {
  it.each([
    ['上升三角形', triangle], ['下降三角形', inverse(triangle)],
    ['上升楔形', wedge], ['下降楔形', inverse(wedge)],
    ['上升通道', channel], ['下降通道', inverse(channel)],
  ] as const)('draws an unbroken %s without predicting its eventual direction', (name, anchors) => {
    const results = detectHuziCandidates(candles([...anchors]), defaults, []);
    const match = results.find(candidate => candidate.name === name)!;
    expect(match).toBeDefined();
    expect(match.direction).toBe('neutral');
    expect(match.points.length).toBeGreaterThanOrEqual(4);
    expect(match.guides?.map(guide => guide.role)).toEqual(['upper', 'lower']);
    expect(match.zone!.low).toBeLessThan(match.zone!.high);
    expect(match).not.toHaveProperty('confirmedAt');
    expect(match).not.toHaveProperty('targets');
    expect(match.description).toContain('工程子集');
    expect(match.description).toContain('未确认突破');
  });

  it('labels four contacts as an early framework without inventing the E point', () => {
    const results = detectHuziCandidates(candles(triangle, 46), defaults, []);
    const match = results.find(candidate => candidate.name === '上升三角形')!;
    expect(match.points.map(p => p.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(match.description).toContain('尚无 E 点');
    expect(match.availableAt).toBe(epoch + 43 * minute);
    expect(match.observedAt).toBe(epoch + 46 * minute);
  });

  it('prefers seven actual contacts over a duplicate four-contact suffix', () => {
    const results = detectHuziCandidates(candles(channel), defaults, []);
    expect(results).toHaveLength(1);
    expect(results[0].points).toHaveLength(7);
    expect(results[0].points.map(p => p.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  });

  it('only gains a new anchor after its right-hand candles close', () => {
    const full = detectHuziCandidates(candles(triangle), defaults, []).find(p => p.points.length === 5)!;
    expect(full).toBeDefined();
    expect(full.availableAt).toBe(epoch + 53 * minute);
    expect(full.observedAt).toBe(epoch + 56 * minute);
    expect(detectHuziCandidates(candles(triangle, 52), defaults, []).some(p => p.id === full.id)).toBe(false);
    expect(detectHuziCandidates(candles(triangle, 53), defaults, []).find(p => p.id === full.id)?.points).toEqual(full.points);
    const store = candles(triangle, 52);
    const closed: ColumnView = { length: store.length, closedLength: store.length, col: name => store.col(name) };
    expect(detectHuziCandidates(closed, defaults, []).find(p => p.id === full.id)?.availableAt).toBe(full.availableAt);
  });

  it('withdraws a framework on a forming-candle excursion without emitting a confirmed breakout', () => {
    const store = candles(triangle);
    const before = detectHuziCandidates(store, defaults, []);
    expect(before.length).toBeGreaterThan(0);
    store.col('high')[store.length - 1] = 130;
    expect(detectHuziCandidates(store, defaults, [])).toEqual([]);
    // A still-forming excursion can retreat. This is a mutable observation,
    // not a persisted breakout event or a rewrite of already confirmed pivots.
    store.col('high')[store.length - 1] = store.col('close')[store.length - 1] + .1;
    expect(detectHuziCandidates(store, defaults, [])[0].points).toEqual(before[0].points);
  });

  it('rejects a closed historical excursion even when the current quote returns inside', () => {
    const store = candles(triangle);
    store.col('high')[54] = 150;
    expect(detectHuziCandidates(store, defaults, [])).toEqual([]);
  });

  it('evaluates the real last candle when the registry supplies a time-only closing sentinel', () => {
    const store = candles(triangle), index = store.length;
    store.appendBar({ time: epoch + index * minute, open: NaN, high: NaN, low: NaN, close: NaN, volume: NaN });
    const result = detectHuziCandidates(store, defaults, []);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].observedAt).toBe(epoch + (index - 1) * minute);
    expect(result[0].guides?.every(guide => guide.points[1].time === result[0].observedAt)).toBe(true);
  });

  it('removes a candidate once its anchor structure has a confirmed match', () => {
    const store = candles(triangle), candidates = detectHuziCandidates(store, defaults, []);
    const candidate = candidates[0];
    const confirmed: PatternMatch = {
      ...candidate, direction: 'bullish', confirmedAt: epoch + 57 * minute,
      status: 'confirmed', zone: candidate.zone!, invalidation: 90, targets: [120],
    };
    expect(detectHuziCandidates(store, defaults, [confirmed])).toEqual([]);
  });

  it('does not resurrect a broken and invalidated anchor set as a new observation', () => {
    const store = candles(triangle), candidate = detectHuziCandidates(store, defaults, [])[0];
    const confirmed: PatternMatch = {
      ...candidate, direction: 'bearish', confirmedAt: epoch + 57 * minute,
      status: 'invalidated', invalidatedAt: epoch + 60 * minute,
      zone: candidate.zone!, invalidation: 120, targets: [90],
    };
    expect(detectHuziCandidates(store, defaults, [confirmed])).toEqual([]);
  });

  it('does not extend a converging boundary past its apex or keep an obsolete channel', () => {
    const expiringTriangle: Anchor[] = [...triangle.slice(0, -1), [100, 110]];
    expect(detectHuziCandidates(candles(expiringTriangle), defaults, [])).toEqual([]);
    const expiringChannel: Anchor[] = [[0, 105], [10, 110], [20, 100], [30, 110], [40, 100], [50, 110], [55, 105], [150, 105]];
    expect(detectHuziCandidates(candles(expiringChannel), defaults, [])).toEqual([]);
  });

  it('honors family selection and rejects malformed current data', () => {
    const store = candles(triangle);
    expect(detectHuziCandidates(store, { ...defaults, family: '头肩形' }, [])).toEqual([]);
    expect(detectHuziCandidates(store, { ...defaults, family: '通道 / 旗形' }, [])).toEqual([]);
    store.col('close')[store.length - 1] = NaN;
    expect(detectHuziCandidates(store, defaults, [])).toEqual([]);
  });

  it('reads only a bounded tail regardless of total loaded chart history', () => {
    const store = candles(triangle), padding = 100_000, slices: number[] = [];
    const input: ColumnView = {
      length: padding + store.length,
      col: name => ({
        subarray(start: number, end: number) {
          slices.push(end - start);
          const out = new Float64Array(end - start).fill(NaN);
          out.set(store.col(name).subarray(0, store.length), padding - start);
          return out;
        },
      }) as unknown as Float64Array,
    };
    const results = detectHuziCandidates(input, defaults, []);
    expect(results[0].points).toEqual(detectHuziCandidates(store, defaults, [])[0].points);
    expect(Math.max(...slices)).toBeLessThanOrEqual(661);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
