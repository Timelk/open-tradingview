import { describe, expect, it } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import type { ParamValues } from '../src/lib/core/types';
import { detectHuzi } from '../src/lib/patterns/huzi';
import { appendHuziSwing } from '../src/lib/patterns/huzi-swings';
import type { Pivot } from '../src/lib/patterns/pivots';
import marketJson from './fixtures/huzi-recall-market.json?raw';
const market = JSON.parse(marketJson) as { bars: number[][] };

const minute = 60_000;
const defaults: ParamValues = { pivotStrength: 2, lookback: 1500, tolerance: .04, maxPatterns: 100, showInvalidated: true, family: '全部', extraStructures: false };
type Anchor = [number, number];
const shoulder: Anchor[] = [[0, 90], [20, 110], [40, 100], [60, 125], [80, 100], [88, 105], [96, 104], [110, 111], [135, 94], [145, 94]];
const triangle: Anchor[] = [[0, 100], [20, 110], [40, 90], [48, 97], [56, 95.8], [70, 110], [90, 98], [110, 110], [125, 106], [145, 115], [155, 115]];
const mirror = (anchors: Anchor[]): Anchor[] => anchors.map(([i, value]) => [i, 240 - value]);

function candles(anchors: Anchor[], end = anchors.at(-1)![0]): ColumnStore {
  const store = new ColumnStore(256);
  let leg = 0;
  for (let i = 0; i <= end; i++) {
    while (leg + 1 < anchors.length - 1 && i > anchors[leg + 1][0]) leg++;
    const [a, b] = [anchors[leg], anchors[leg + 1]];
    const close = a[1] + (b[1] - a[1]) * (i - a[0]) / (b[0] - a[0]);
    store.appendBar({ time: i * minute, open: close, high: close + .1, low: close - .1, close, volume: 100 });
  }
  return store;
}

describe('Huzi causal structural levels', () => {
  it.each([false, true])('respects the multi-scale switch for a fragmented %s shoulder', (inverted) => {
    const anchors: Anchor[] = [[0, 90], [20, 110], [40, 100], [60, 125], [80, 100], [88, 105], [91, 104], [110, 111], [135, 94], [145, 94]];
    const store = candles(inverted ? mirror(anchors) : anchors);
    const params = { ...defaults, structuralSwings: false, family: '头肩形' };
    const multi = detectHuzi(store, { ...params, multiScale: true });
    const expected = multi.find(match => match.name === (inverted ? '头肩底' : '头肩顶'))!;
    expect(expected).toBeDefined();
    expect(expected.pivotStrength).toBeGreaterThan(Number(defaults.pivotStrength));
    expect(detectHuzi(store, { ...params, multiScale: false }).some(match => match.id === expected.id)).toBe(false);
    expect(detectHuzi(store, params)).toEqual(multi);
  });

  it.each([
    ['complex right shoulder', shoulder, '头肩顶'],
    ['complex inverted right shoulder', mirror(shoulder), '头肩底'],
    ['small pullback inside an ascending triangle leg', triangle, '上升三角形'],
    ['small pullback inside a descending triangle leg', mirror(triangle), '下降三角形'],
  ] as const)('recovers %s without loosening geometry or tolerance', (_label, anchors, name) => {
    // The zig-zag fit needs the amplitude level; boundary search is switched off to test that path on its own.
    const zigzag = { ...defaults, boundarySearch: false };
    expect(detectHuzi(candles([...anchors]), { ...zigzag, structuralSwings: false }).some(match => match.name === name)).toBe(false);
    const match = detectHuzi(candles([...anchors]), zigzag).find(value => value.name === name)!;
    expect(match).toBeDefined();
    expect(match.description).toContain('幅度层级过滤');
    expect(match.description).toContain('23.6%');
  });

  it.each([
    ['ascending', triangle, '上升三角形'],
    ['descending', mirror(triangle), '下降三角形'],
  ] as const)('boundary search recovers the %s triangle without any amplitude level, ignoring the interior wiggle', (_label, anchors, name) => {
    const search = detectHuzi(candles([...anchors]), { ...defaults, structuralSwings: false }).filter(match => match.name === name && match.description.includes('贴边触点'));
    expect(search.length).toBeGreaterThan(0);
    // Boundaries run through selected touches and contain the price: no candle closes outside them by more than the tolerance.
    for (const match of search) {
      expect(match.ratios.some(ratio => ratio.label === '上 / 下边界触点')).toBe(true);
      expect(match.guides!.map(guide => guide.role).sort()).toEqual(['lower', 'upper']);
    }
    expect(detectHuzi(candles([...anchors]), { ...defaults, structuralSwings: false, boundarySearch: false }).some(match => match.name === name)).toBe(false);
  });

  it.each([shoulder, triangle, mirror(shoulder), mirror(triangle)].map(anchors => ({ anchors })))('publishes structural matches exactly when their evidence first becomes available', ({ anchors }) => {
    const full = detectHuzi(candles(anchors), defaults);
    expect(full.length).toBeGreaterThan(0);
    for (const expected of full) {
      const index = expected.confirmedAt / minute;
      expect(detectHuzi(candles(anchors, index - 1), defaults).some(match => match.id === expected.id)).toBe(false);
      const first = detectHuzi(candles(anchors, index), defaults).find(match => match.id === expected.id)!;
      expect(first?.confirmedAt).toBe(expected.confirmedAt);
      expect(first?.points).toEqual(expected.points);
      expect(first?.invalidation).toBe(expected.invalidation);
    }
  });

  it('does not erase a material opposing swing or one that is not followed by an extension', () => {
    const points = (values: number[]): Pivot[] => values.map((value, index) => ({ index: index * 10, time: index * 10 * minute, value, kind: index % 2 ? 'high' : 'low', confirmedAt: (index * 10 + 3) * minute }));
    for (const values of [[100, 120, 105, 125], [100, 120, 116, 119], [100, 120, 99, 125]]) {
      const stack: Pivot[] = [];
      for (const point of points(values)) appendHuziSwing(stack, point, .382);
      expect(stack.map(point => point.value)).toEqual(values);
    }
    const stack: Pivot[] = [];
    const input = points([100, 120, 116, 125]);
    input.slice(0, 3).forEach(point => appendHuziSwing(stack, point, .236));
    expect(stack).toHaveLength(3);
    appendHuziSwing(stack, input[3], .236);
    expect(stack).toEqual([input[0], input[3]]);
    expect(stack[1].confirmedAt).toBe(input[3].confirmedAt);
  });

  it('retains every-candle envelope validation after removing local swing noise', () => {
    const malformed = candles(triangle);
    malformed.col('high')[65] = 150;
    const match = detectHuzi(malformed, { ...defaults, family: '三角形' }).find(value => value.points[0].time === 20 * minute && value.points.at(-1)!.time === 110 * minute);
    expect(match).toBeUndefined();
    const bad = candles(shoulder);
    bad.col('close')[95] = NaN;
    expect(detectHuzi(bad, { ...defaults, family: '头肩形' })).toEqual([]);
  });

  it('does not let the forming candle rewrite a recovered structure', () => {
    const store = candles(triangle);
    const initial = detectHuzi(store, defaults);
    const index = store.length - 1;
    store.col('high')[index] = 200;
    store.col('low')[index] = 1;
    store.col('close')[index] = 190;
    expect(detectHuzi(store, defaults)).toEqual(initial);
  });
});

describe('Huzi multi-contact market regression', () => {
  const params = { ...defaults, pivotStrength: 3, structuralSwings: false, family: '楔形' };
  const id = 'huzi-wedge:1787665680000:1787665980000:1787667360000:1787667600000:1787668140000:1787668200000:1787668380000';
  function actualBars(through = Infinity): ColumnStore {
    const store = new ColumnStore(128);
    for (const [time, open, high, low, close, volume] of market.bars) {
      if (time > through) break;
      store.appendBar({ time, open, high, low, close, volume });
    }
    return store;
  }

  it('fits seven complete boundary contacts that a five-point-only scan misses', () => {
    const match = detectHuzi(actualBars(), params).find(value => value.id === id)!;
    expect(match).toBeDefined();
    expect(match.name).toBe('上升楔形');
    expect(match.direction).toBe('bearish');
    expect(match.points.map(point => point.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(match.confirmedAt).toBe(1787668740000);
    expect(match.description).toContain('7 个连续边界触点');
    const first = detectHuzi(actualBars(match.confirmedAt), params).find(value => value.id === id)!;
    expect(first?.points).toEqual(match.points);
    expect(first?.confirmedAt).toBe(match.confirmedAt);
    expect(detectHuzi(actualBars(match.confirmedAt - minute), params).some(value => value.id === id)).toBe(false);
  });
});
