import {describe, expect, it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import type {ColumnView} from '../src/lib/core/types';
import {detectHarmonicCandidates} from '../src/lib/patterns/harmonic-candidates';
import {detectHarmonics} from '../src/lib/patterns/harmonic';

const minute = 60_000;
const params = {pivotStrength: 2, tolerance: .04, multiScale: false, showInvalidated: true, maxPatterns: 100};
const fixtures: [string, number[]][] = [
  ['AB=CD', [200, 140, 180, 120]],
  ['Gartley', [100, 200, 138.2, 183.2, 121.4]],
  ['Bat', [100, 200, 150, 180, 111.4]],
  ['Butterfly', [100, 200, 121.4, 173, 73]],
  ['Crab', [100, 200, 140, 190, 38.2]],
  ['Deep Crab', [100, 200, 110, 180, 38.2]],
  ['Alternate Bat', [100, 200, 161.8, 190, 87]],
  ['5-0', [250, 100, 200, 70, 330, 200]],
];

function candles(anchors: number[]): ColumnStore {
  const store = new ColumnStore(128), values: number[] = [];
  const lead = anchors[0] + (anchors[1] - anchors[0]) * .15;
  values.push(lead, (lead + anchors[0]) / 2);
  anchors.forEach((v, index) => {
    values.push(v);
    if (index < anchors.length - 1) for (let j = 1; j < 4; j++) values.push(v + (anchors[index + 1] - v) * j / 4);
  });
  for (let j = 1; j <= 3; j++) values.push(anchors.at(-1)! + (anchors.at(-2)! - anchors.at(-1)!) * j * .1);
  values.forEach((v, i) => store.appendBar({time: Date.UTC(2026, 8, 22) + i * minute, open: v, high: v, low: v, close: v, volume: 1}));
  return store;
}
const prefix = (store: ColumnView, length: number): ColumnView => ({length, col: name => store.col(name)});

describe('prospective harmonic zones with no invented completion', () => {
  for (const [family, anchors] of fixtures) for (const mirrored of [false, true]) {
    it(`projects ${mirrored ? 'bearish' : 'bullish'} ${family} from confirmed observed pivots`, () => {
      const prices = mirrored ? anchors.map(v => 600 - v) : anchors;
      const store = candles(prices), cIndex = (anchors.length - 2) * 4 + 2;
      const cols = prefix(store, cIndex + 4);
      const results = detectHarmonicCandidates(cols, {...params, family, includeAlternateABCD: false}, []);
      expect(results).toHaveLength(1);
      const candidate = results[0];
      expect(candidate.direction).toBe(mirrored ? 'bearish' : 'bullish');
      expect(candidate.points.map(p => p.value)).toEqual(prices.slice(0, -1));
      expect(candidate.points.map(p => p.label).join('')).toBe(family === '5-0' ? '0XABC' : family === 'AB=CD' ? 'ABC' : 'XABC');
      expect(candidate.zone!.low).toBeLessThanOrEqual(prices.at(-1)!);
      expect(candidate.zone!.high).toBeGreaterThanOrEqual(prices.at(-1)!);
      expect(candidate.availableAt).toBe(store.col('time')[cIndex + 3]);
      expect(candidate.observedAt).toBe(store.col('time')[cols.length - 1]);
      expect(candidate).not.toHaveProperty('confirmedAt');
      expect(candidate).not.toHaveProperty('targets');
      expect(candidate).not.toHaveProperty('invalidation');
      expect(detectHarmonicCandidates(prefix(store, cIndex + 3), {...params, family}, []).some(p => p.id === candidate.id)).toBe(false);
    });
  }

  it('does not invent a zone when B is outside the family or projection bands do not overlap', () => {
    for (const anchors of [[100, 200, 150, 183.2, 121.4], [100, 200, 138.2, 163.2, 121.4]]) {
      const store = candles(anchors);
      expect(detectHarmonicCandidates(prefix(store, 18), {...params, family: 'Gartley'}, [])).toEqual([]);
    }
  });

  it.each([false, true])('withdraws on current-bar geometry damage and respects price mirroring %s', (mirrored) => {
    const prices = mirrored ? fixtures[1][1].map(v => 600 - v) : fixtures[1][1];
    const store = candles(prices), cols = prefix(store, 18);
    const settings = {...params, family: 'Gartley'};
    const initial = detectHarmonicCandidates(cols, settings, [])[0];
    expect(initial).toBeDefined();
    if (mirrored) store.col('high')[17] = initial.zone!.high + 1;
    else store.col('low')[17] = initial.zone!.low - 1;
    expect(detectHarmonicCandidates(cols, settings, [])).toEqual([]);
    const next = candles(prices);
    if (mirrored) next.col('low')[17] = prices[3] - 1;
    else next.col('high')[17] = prices[3] + 1;
    expect(detectHarmonicCandidates(prefix(next, 18), settings, [])).toEqual([]);
  });

  it('does not resurrect a violated candidate just because the most recent price came back', () => {
    const store = candles(fixtures[1][1]), cols = prefix(store, 18);
    store.col('low')[16] = 110;
    expect(detectHarmonicCandidates(cols, {...params, family: 'Gartley'}, [])).toEqual([]);
  });

  it('hands off to an actual completed shape without duplicating its scaffold', () => {
    const store = candles(fixtures[1][1]), settings = {...params, family: 'Gartley'};
    const live = detectHarmonicCandidates(prefix(store, 18), settings, [])[0];
    const completed = detectHarmonics(store, settings);
    expect(completed).toHaveLength(1);
    expect(detectHarmonicCandidates(store, {...settings, multiScale: true}, completed).some(p => p.id === live.id)).toBe(false);
    // The shared confirmed pool also suppresses a slower-scale hypothesis,
    // irrespective of whether that completed match is visible or invalidated.
    expect(detectHarmonicCandidates(prefix(store, 18), settings, completed).some(p => p.id === live.id)).toBe(false);
    expect(detectHarmonicCandidates(prefix(store, 18), settings, [{...completed[0], status: 'invalidated'}]).some(p => p.id === live.id)).toBe(false);
  });

  it('uses the actual last observation with an exchange-close time sentinel', () => {
    const store = candles(fixtures[1][1]), settings = {...params, family: 'Gartley'};
    const normal = detectHarmonicCandidates(prefix(store, 18), settings, [])[0];
    for (const key of ['open', 'high', 'low', 'close', 'volume'] as const) store.col(key)[18] = NaN;
    const result = detectHarmonicCandidates(prefix(store, 19), settings, [])[0];
    expect(result.id).toBe(normal.id);
    expect(result.zone).toEqual(normal.zone);
    expect(result.observedAt).toBe(store.col('time')[17]);
    expect(result.availableAt).toBe(normal.availableAt);
    store.col('close')[17] = NaN;
    expect(detectHarmonicCandidates(prefix(store, 19), settings, [])).toEqual([]);
  });

  it('deduplicates scales, bounds the recent pool, and respects the alternate AB=CD switch', () => {
    const store = candles([200, 100, 161.8, 0]);
    const cols = prefix(store, 14);
    const all = detectHarmonicCandidates(cols, {...params, family: 'AB=CD', multiScale: true}, []);
    expect(all.length).toBeGreaterThan(0);
    expect(all.length).toBeLessThanOrEqual(2);
    expect(new Set(all.map(p => p.id)).size).toBe(all.length);
    expect(all.some(p => p.name.includes('延伸'))).toBe(true);
    expect(detectHarmonicCandidates(cols, {...params, family: 'AB=CD', includeAlternateABCD: false}, []).every(p => !p.name.includes('延伸'))).toBe(true);
  });
});
