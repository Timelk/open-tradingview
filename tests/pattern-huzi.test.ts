import { describe, expect, it } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import { detectHuzi } from '../src/lib/patterns/huzi';
import type { ParamValues } from '../src/lib/core/types';

const defaults: ParamValues = { pivotStrength: 2, lookback: 1500, tolerance: 0.04, maxPatterns: 100, showInvalidated: true, family: '全部' };
const minute = 60_000;

function fixture(points: Array<[number, number]>, end?: number): ColumnStore {
  const store = new ColumnStore(128);
  const last = end ?? points.at(-1)![0];
  let segment = 0;
  for (let i = 0; i <= last; i++) {
    while (segment + 1 < points.length - 1 && i > points[segment + 1][0]) segment++;
    const a = points[segment], b = points[Math.min(segment + 1, points.length - 1)];
    const ratio = b[0] === a[0] ? 0 : (i - a[0]) / (b[0] - a[0]);
    const price = a[1] + (b[1] - a[1]) * ratio;
    store.appendBar({ time: i * minute, open: price, high: price + 0.1, low: price - 0.1, close: price, volume: 100 });
  }
  return store;
}
const ascending: Array<[number, number]> = [[0, 100], [10, 110], [20, 90], [30, 110], [40, 98], [50, 110], [55, 106], [63, 115], [70, 115]];
const names = (store: ColumnStore) => detectHuzi(store, defaults).map(match => match.name);
const mirror = (points: Array<[number, number]>) => points.map(([i, value]) => [i, 220 - value] as [number, number]);

describe('Huzi structural patterns', () => {
  it('recognizes ascending/descending and symmetric triangles from alternating confirmed swings', () => {
    expect(names(fixture(ascending))).toContain('上升三角形');
    expect(names(fixture(mirror(ascending)))).toContain('下降三角形');
    expect(names(fixture([[0, 110], [10, 120], [20, 90], [30, 116], [40, 96], [50, 112], [55, 106], [65, 118], [70, 118]]))).toContain('对称三角形');
  });

  it('derives direction from the actual breakout, including upward breaks of descending triangles', () => {
    const points: Array<[number, number]> = [[0, 110], [10, 130], [20, 100], [30, 122], [40, 100], [50, 114], [55, 106], [63, 122], [70, 122]];
    const match = detectHuzi(fixture(points), defaults).find(value => value.name === '下降三角形');
    expect(match?.direction).toBe('bullish');
    expect(match?.confirmedAt).toBeGreaterThan(50 * minute);
  });

  it('distinguishes rising/falling wedges from parallel channels', () => {
    const wedge: Array<[number, number]> = [[0, 100], [10, 110], [20, 90], [30, 114], [40, 101], [50, 118], [55, 112], [64, 126], [70, 128]];
    expect(names(fixture(wedge))).toContain('上升楔形');
    expect(names(fixture(mirror(wedge)))).toContain('下降楔形');
    const channel = fixture([[0, 100], [10, 110], [20, 90], [30, 115], [40, 95], [50, 120], [55, 110], [65, 126], [70, 128]]);
    expect(detectHuzi(channel, { ...defaults, family: '楔形' })).toHaveLength(0);
  });

  it('recognizes both head-and-shoulder orientations only after a neckline break', () => {
    const top: Array<[number, number]> = [[0, 90], [10, 110], [20, 100], [30, 125], [40, 100], [50, 111], [63, 94], [70, 94]];
    const bearish = detectHuzi(fixture(top), defaults).find(value => value.name === '头肩顶');
    expect(bearish?.direction).toBe('bearish');
    expect(bearish?.points.map(point => point.label)).toEqual(['L', 'N1', 'H', 'N2', 'R']);
    expect(bearish?.invalidation).toBeGreaterThan(111);
    expect(names(fixture(mirror(top)))).toContain('头肩底');
    expect(detectHuzi(fixture(top, 53), defaults)).toHaveLength(0);
  });

  it('ignores a forming-candle break and wick-only excursions', () => {
    const store = fixture(ascending, 55);
    expect(detectHuzi(store, defaults)).toHaveLength(0);
    store.appendBar({ time: 56 * minute, open: 106, high: 140, low: 106, close: 125, volume: 100 });
    expect(detectHuzi(store, defaults)).toHaveLength(0);
    // Once that bar closes below the boundary, its isolated wick does not confirm a pattern.
    store.updateLast({ time: 56 * minute, open: 106, high: 140, low: 105, close: 106, volume: 100 });
    store.appendBar({ time: 57 * minute, open: 106, high: 107, low: 105, close: 106, volume: 100 });
    expect(detectHuzi(store, defaults)).toHaveLength(0);
  });

  it('never labels a historical anchor as the time the pattern became knowable', () => {
    const complete = detectHuzi(fixture(ascending), defaults).find(match => match.name === '上升三角形')!;
    expect(complete).toBeDefined();
    const knownBar = complete.confirmedAt / minute;
    expect(knownBar).toBeGreaterThan(complete.points.at(-1)!.time / minute + 2);
    expect(detectHuzi(fixture(ascending, knownBar - 1), defaults).some(match => match.id === complete.id)).toBe(false);
    expect(detectHuzi(fixture(ascending, knownBar), defaults).find(match => match.id === complete.id)?.confirmedAt).toBe(complete.confirmedAt);
  });

  it('keeps anchors fixed and records a later false-break invalidation separately', () => {
    const before = detectHuzi(fixture(ascending), defaults).find(match => match.name === '上升三角形')!;
    const later = fixture([...ascending, [75, 80], [79, 80]]);
    const after = detectHuzi(later, defaults).find(match => match.id === before.id)!;
    expect(after.points).toEqual(before.points);
    expect(after.confirmedAt).toBe(before.confirmedAt);
    expect(after.invalidation).toBe(before.invalidation);
    expect(after.status).toBe('invalidated');
    expect(after.invalidatedAt).toBeGreaterThan(after.confirmedAt);
    expect(detectHuzi(later, { ...defaults, showInvalidated: false }).some(match => match.id === before.id)).toBe(false);
  });

  it('bounds output, respects the family filter and rejects too-short or malformed data', () => {
    expect(detectHuzi(fixture(ascending), { ...defaults, family: '头肩形' }).every(match => match.family === 'huzi-head-shoulders')).toBe(true);
    expect(detectHuzi(fixture(ascending), { ...defaults, maxPatterns: 1 }).length).toBeLessThanOrEqual(1);
    expect(detectHuzi(fixture([[0, 100], [5, 105]]), defaults)).toEqual([]);
    const malformed = fixture(ascending); malformed.col('close')[30] = NaN;
    expect(detectHuzi(malformed, { ...defaults, family: '三角形' })).toEqual([]);
  });
});

 describe('Huzi confirmation evidence and lifecycle', () => {
  it('exports the fitted boundary used by detection, including the actual confirmation price', () => {
    const adjusted = ascending.map(([index, value]) => [index, index === 30 ? value + .4 : value] as [number, number]);
    const match = detectHuzi(fixture(adjusted), { ...defaults, family: '三角形' }).find(value => value.name === '上升三角形')!;
    const upper = match.guides?.find(guide => guide.role === 'upper')!;
    expect(upper).toBeDefined();
    // Least-squares fit to 110.1, 110.5, 110.1 is 110.2333, whereas
    // the former endpoint chord incorrectly rendered a flat 110.1 line.
    expect(upper.points[0].value).toBeCloseTo(110.233333, 5);
    expect(upper.points[1].value).toBeCloseTo(match.events![0].boundary);
    expect(match.events?.[0]).toMatchObject({ kind: 'breakout', knownAt: match.confirmedAt });
    expect(match.events![0].time).toBe(match.confirmedAt - minute);
    expect((match.zone.low + match.zone.high) / 2).toBeCloseTo(match.events![0].boundary);
  });

  it('requires every requested close and cannot use a forming candle as the final confirmation', () => {
    const one = detectHuzi(fixture(ascending), { ...defaults, family: '三角形', breakoutCloses: 1 })[0];
    const three = detectHuzi(fixture(ascending), { ...defaults, family: '三角形', breakoutCloses: 3 })[0];
    expect(three.confirmedAt).toBe(one.confirmedAt + 2 * minute);
    const prefix = fixture(ascending, three.confirmedAt / minute - 1);
    expect(detectHuzi(prefix, { ...defaults, family: '三角形', breakoutCloses: 3 })).toEqual([]);
  });

  it('keeps four-point early breaks opt-in and labels them separately from five-touch structures', () => {
    const early = fixture([[0, 100], [10, 110], [20, 90], [30, 110], [40, 98], [50, 115], [54, 115]]);
    expect(detectHuzi(early, { ...defaults, family: '三角形' })).toEqual([]);
    const matches = detectHuzi(early, { ...defaults, family: '三角形', allowEarly: true });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].formation).toBe('early');
    expect(matches[0].points).toHaveLength(4);
    expect(matches[0].confirmedAt).toBeGreaterThan(40 * minute);
  });

  it.each(['open', 'high', 'low', 'close'] as const)('refuses to recognize a head-and-shoulders through an invalid %s candle', field => {
    const top: Array<[number, number]> = [[0, 90], [10, 110], [20, 100], [30, 125], [40, 100], [50, 111], [63, 94], [70, 94]];
    const broken = fixture(top); broken.col(field)[25] = NaN;
    expect(detectHuzi(broken, { ...defaults, family: '头肩形' })).toEqual([]);
  });

  it('does not cross a malformed confirmation candle or an impossible high/low bar', () => {
    const malformed = fixture(ascending); malformed.col('high')[57] = malformed.col('low')[57] - 1;
    expect(detectHuzi(malformed, { ...defaults, family: '三角形' })).toEqual([]);
    const outOfOrder = fixture(ascending); outOfOrder.col('time')[57] = outOfOrder.col('time')[56];
    expect(detectHuzi(outOfOrder, { ...defaults, family: '三角形' })).toEqual([]);
  });

  it('preserves recognition across future missing data but stops claiming an updated lifecycle', () => {
    const prior = detectHuzi(fixture(ascending), { ...defaults, family: '三角形' })[0];
    const broken = fixture([...ascending, [75, 80], [79, 80]]); broken.col('close')[72] = NaN;
    const match = detectHuzi(broken, { ...defaults, family: '三角形' }).find(pattern => pattern.id === prior.id)!;
    expect(match.confirmedAt).toBe(prior.confirmedAt);
    expect(match.stage).toBe(prior.stage);
    expect(match.description).toContain('生命周期停在缺口之前');
  });

  it('records guarded retests, failed breaks and final invalidation without rewriting the initial evidence', () => {
    const before = detectHuzi(fixture(ascending), { ...defaults, family: '三角形' })[0];
    const replay = fixture([...ascending.filter(([index]) => index <= 63), [65, 110.6], [66, 114], [67, 108], [68, 95], [70, 95]]);
    const after = detectHuzi(replay, { ...defaults, family: '三角形' }).find(pattern => pattern.id === before.id)!;
    expect(after.points).toEqual(before.points);
    expect(after.confirmedAt).toBe(before.confirmedAt);
    expect(after.events?.map(event => event.kind)).toEqual(['breakout', 'retest', 'failed-breakout', 'invalidation']);
    expect(after.stage).toBe('invalidated');
    for (const event of after.events!) expect(event.knownAt).toBe(event.time + minute);
  });

  it('uses the same original confirmation in every eligible historical prefix', () => {
    const store = fixture(ascending), matches = detectHuzi(store, defaults);
    for (const match of matches) {
      const prefix = fixture(ascending, match.confirmedAt / minute);
      expect(detectHuzi(prefix, defaults).find(candidate => candidate.id === match.id)?.confirmedAt).toBe(match.confirmedAt);
      expect(detectHuzi(fixture(ascending, match.confirmedAt / minute - 1), defaults).some(candidate => candidate.id === match.id)).toBe(false);
    }
  });
});


it('does not recycle a not-yet-confirmed structure after an earlier break has already returned inside', () => {
  const earlierBreak = fixture([[0, 100], [20, 110], [40, 90], [60, 110], [80, 98], [100, 110], [103, 99], [107, 109], [115, 118], [125, 118]]);
  const matches = detectHuzi(earlierBreak, { ...defaults, pivotStrength: 8, family: '三角形' });
  expect(matches.some(match => match.points[0].time === 20 * minute && match.points.at(-1)!.time === 100 * minute)).toBe(false);
});


it('cannot publish confirmation using a missing or non-monotonic next-candle timestamp', () => {
  const match = detectHuzi(fixture(ascending), { ...defaults, family: '三角形' })[0];
  const prefix = fixture(ascending, match.confirmedAt / minute);
  prefix.col('time')[prefix.length - 1] = NaN;
  expect(detectHuzi(prefix, { ...defaults, family: '三角形' })).toEqual([]);
  prefix.col('time')[prefix.length - 1] = prefix.col('time')[prefix.length - 2];
  expect(detectHuzi(prefix, { ...defaults, family: '三角形' })).toEqual([]);
});


 describe('conservative Huzi head-and-shoulders continuation', () => {
  const top: Array<[number, number]> = [[0, 90], [10, 110], [20, 100], [30, 125], [40, 100], [50, 111], [55, 104], [70, 132], [75, 132]];
  it.each([false, true])('requires the actual head to break after the five pivots are knowable (mirrored=%s)', inverted => {
    const points = inverted ? mirror(top) : top;
    const matches = detectHuzi(fixture(points), { ...defaults, family: '头肩形' });
    const continuation = matches.find(match => match.id.endsWith(':continuation'))!;
    expect(continuation).toBeDefined();
    expect(continuation.name).toBe(inverted ? '头肩中继下破' : '头肩中继上破');
    expect(continuation.direction).toBe(inverted ? 'bearish' : 'bullish');
    expect(continuation.events![0].boundary).toBeCloseTo(continuation.points[2].value);
    expect(continuation.guides?.some(guide => guide.role === 'neckline')).toBe(true);
    expect(continuation.guides?.some(guide => guide.role === (inverted ? 'lower' : 'upper'))).toBe(true);
    expect(detectHuzi(fixture(points, continuation.confirmedAt / minute - 1), { ...defaults, family: '头肩形' }).some(match => match.id === continuation.id)).toBe(false);
  });

  it('does not call a mere shoulder-line break a continuation', () => {
    const shoulderOnly = fixture(top, 65);
    expect(shoulderOnly.col('close')[64]).toBeGreaterThan(111);
    expect(detectHuzi(shoulderOnly, { ...defaults, family: '头肩形' }).some(match => match.id.endsWith(':continuation'))).toBe(false);
  });

  it('never relabels a traditional neckline break as continuation after a later rally', () => {
    const traditional = fixture([[0, 90], [10, 110], [20, 100], [30, 125], [40, 100], [50, 111], [58, 94], [74, 140], [78, 140]]);
    const matches = detectHuzi(traditional, { ...defaults, family: '头肩形' });
    const original = matches.find(match => match.name === '头肩顶' && match.points[0].time === 10 * minute)!;
    expect(original).toBeDefined();
    expect(original.direction).toBe('bearish');
    expect(original.status).toBe('invalidated');
    expect(matches.some(match => match.id === original.id + ':continuation')).toBe(false);
  });
});
