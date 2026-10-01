import { describe, expect, it } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import { detectHuzi } from '../src/lib/patterns/huzi';
import type { ParamValues } from '../src/lib/core/types';

const minute = 60_000;
const defaults: ParamValues = {
  pivotStrength: 2, lookback: 1500, tolerance: 0.04,
  maxPatterns: 100, showInvalidated: true, family: '全部',
};
type Anchor = [index: number, price: number];

/** Each anchor is an actual price turn. In-between candles are ordinary linear
 * moves, with small symmetric wicks and a final still-forming candle. */
function candles(anchors: Anchor[], through = anchors.at(-1)![0]): ColumnStore {
  const store = new ColumnStore(256);
  let leg = 0;
  for (let i = 0; i <= through; i++) {
    while (leg + 1 < anchors.length - 1 && i > anchors[leg + 1][0]) leg++;
    const [a, b] = [anchors[leg], anchors[leg + 1]];
    const close = a[1] + (b[1] - a[1]) * (i - a[0]) / (b[0] - a[0]);
    store.appendBar({ time: i * minute, open: close, high: close + 0.1, low: close - 0.1, close, volume: 100 });
  }
  return store;
}

const inverted = (anchors: Anchor[]): Anchor[] => anchors.map(([index, value]) => [index, 240 - value]);
const doubleBottom: Anchor[] = [[0, 125], [10, 100], [20, 115], [30, 101], [43, 120], [50, 120]];
const channel: Anchor[] = [[0, 110], [10, 120], [20, 102], [30, 124], [40, 106], [50, 128]];
const bullishFlag: Anchor[] = [[0, 70], [5, 60], [20, 130], [30, 113], [40, 126], [50, 109], [60, 122], [65, 110], [76, 135], [80, 135]];

describe('Huzi additional structures from the author diagram atlas', () => {
  it.each([
    ['W bottom', doubleBottom, 'bullish'],
    ['M top', inverted(doubleBottom), 'bearish'],
  ] as const)('recognizes %s only after crossing the intervening swing level', (_label, anchors, direction) => {
    const before = detectHuzi(candles([...anchors], 34), defaults);
    expect(before.filter(match => match.family === 'huzi-double')).toEqual([]);
    const match = detectHuzi(candles([...anchors]), defaults).find(match => match.family === 'huzi-double');
    expect(match).toBeDefined();
    expect(match!.direction).toBe(direction);
    expect(match!.points).toHaveLength(3);
    expect(match!.confirmedAt).toBeGreaterThan(30 * minute);
    if (direction === 'bullish') expect(match!.targets[0]).toBeGreaterThan(match!.zone.high);
    else expect(match!.targets[0]).toBeLessThan(match!.zone.low);
  });

  it('does not turn a deep third low into a double bottom simply because price later rallies', () => {
    const unbalanced: Anchor[] = [[0, 125], [10, 100], [20, 115], [30, 87], [43, 120], [50, 120]];
    const doubles = detectHuzi(candles(unbalanced), defaults).filter(match => match.family === 'huzi-double');
    expect(doubles).toEqual([]);
  });

  it.each([
    ['rising upper break', [...channel, [55, 118], [65, 140], [70, 140]] as Anchor[], 'bullish'],
    ['rising lower break', [...channel, [65, 98], [70, 98]] as Anchor[], 'bearish'],
    ['falling lower break', inverted([...channel, [55, 118], [65, 140], [70, 140]]), 'bearish'],
    ['falling upper break', inverted([...channel, [65, 98], [70, 98]]), 'bullish'],
  ] as const)('uses the actual close direction for a %s', (_label, anchors, direction) => {
    const match = detectHuzi(candles([...anchors]), defaults).find(value => value.family === 'huzi-channel');
    expect(match).toBeDefined();
    expect(match!.direction).toBe(direction);
    expect(match!.points.length).toBeGreaterThanOrEqual(5);
  });

  it.each([
    ['bull flag', bullishFlag, 'bullish'],
    ['bear flag', inverted(bullishFlag), 'bearish'],
  ] as const)('identifies a %s with an impulse and opposite sloping parallel consolidation', (_label, anchors, direction) => {
    const match = detectHuzi(candles([...anchors]), defaults).find(value => value.family === 'huzi-flag');
    expect(match).toBeDefined();
    expect(match!.direction).toBe(direction);
    expect(match!.confirmedAt).toBeGreaterThan(60 * minute);
  });

  it('classifies a break against the pole as a channel break instead of a continuation flag', () => {
    const reverse: Anchor[] = [...bullishFlag.slice(0, 7), [72, 90], [80, 90]];
    const matches = detectHuzi(candles(reverse), defaults);
    expect(matches.some(match => match.family === 'huzi-flag')).toBe(false);
    expect(matches.some(match => match.family === 'huzi-channel' && match.direction === 'bearish')).toBe(true);
  });

  it('requires a material, relatively fast pole instead of naming every parallel consolidation a flag', () => {
    const smallPole: Anchor[] = [[0, 115], [5, 110], ...bullishFlag.slice(2)];
    const slowPole: Anchor[] = [[0, 70], [5, 60], ...bullishFlag.slice(2).map(([i, price]): Anchor => [i + 25, price])];
    for (const anchors of [smallPole, slowPole]) {
      const matches = detectHuzi(candles(anchors), defaults);
      expect(matches.some(match => match.family === 'huzi-flag')).toBe(false);
      expect(matches.some(match => match.family === 'huzi-channel')).toBe(true);
    }
  });

  it('rejects a deeply retraced pole as a continuation flag', () => {
    const deep: Anchor[] = [[0, 85], [5, 80], [20, 130], [30, 104], [40, 119], [50, 93], [60, 108], [65, 95], [76, 130], [80, 130]];
    expect(detectHuzi(candles(deep), defaults).some(match => match.family === 'huzi-flag')).toBe(false);
  });

  it('ignores a forming-candle or isolated wick flag breakout', () => {
    const store = candles(bullishFlag, 63);
    const flags = () => detectHuzi(store, defaults).filter(match => match.family === 'huzi-flag');
    expect(flags()).toEqual([]);
    store.appendBar({ time: 64 * minute, open: 115, high: 141, low: 114, close: 140, volume: 100 });
    expect(flags()).toEqual([]);
    store.updateLast({ time: 64 * minute, open: 115, high: 141, low: 114, close: 115, volume: 100 });
    store.appendBar({ time: 65 * minute, open: 115, high: 116, low: 114, close: 115, volume: 100 });
    expect(flags()).toEqual([]);
  });

  it('never backdates a flag confirmation and keeps the same closed-history anchors', () => {
    const match = detectHuzi(candles(bullishFlag), defaults).find(value => value.family === 'huzi-flag');
    expect(match).toBeDefined();
    const knownAt = match!.confirmedAt / minute;
    expect(detectHuzi(candles(bullishFlag, knownAt - 1), defaults).some(value => value.id === match!.id)).toBe(false);
    const first = detectHuzi(candles(bullishFlag, knownAt), defaults).find(value => value.id === match!.id);
    expect(first?.confirmedAt).toBe(match!.confirmedAt);
    expect(first?.points).toEqual(match!.points);
  });

  it('lets the new categories be selected independently', () => {
    const doubles = detectHuzi(candles(doubleBottom), { ...defaults, family: '双底 / 双顶' });
    expect(doubles.length).toBeGreaterThan(0);
    expect(doubles.every(match => match.family === 'huzi-double')).toBe(true);
    const channels = detectHuzi(candles(bullishFlag), { ...defaults, family: '通道 / 旗形' });
    expect(channels.length).toBeGreaterThan(0);
    expect(channels.every(match => ['huzi-flag', 'huzi-channel'].includes(match.family))).toBe(true);
  });

  it('downgrades a would-be flag after further confirmed rotations consume the original impulse', () => {
    const prolonged: Anchor[] = [...bullishFlag.slice(0, 7), [70, 105], [80, 118], [90, 101], [103, 132], [108, 132]];
    const matches = detectHuzi(candles(prolonged), defaults);
    expect(matches.some(match => match.family === 'huzi-channel' && match.direction === 'bullish')).toBe(true);
    expect(matches.some(match => match.family === 'huzi-flag')).toBe(false);
  });
});

describe('Huzi closed-candle lifecycle observations', () => {
  const initial: Anchor[] = [...channel, [55, 118], [65, 140], [70, 140]];
  const currentChannel = () => detectHuzi(candles(initial), defaults).find(value => value.family === 'huzi-channel')!;

  it('observes a retest against the original sloped line, not the horizontal breakout price band', () => {
    const original = currentChannel();
    expect(original).toBeDefined();
    const sequence: Anchor[] = [...initial, [75, 133.5], [80, 139]];
    const match = detectHuzi(candles(sequence), defaults).find(value => value.id === original.id)!;
    const retest = match.events?.find(event => event.kind === 'retest');
    expect(retest).toBeDefined();
    expect(retest!.time).toBe(75 * minute);
    expect(retest!.knownAt).toBe(76 * minute);
    expect(retest!.boundary).toBeCloseTo(133.1, 6);
    expect(retest!.boundary).toBeGreaterThan(original.zone.high);
    expect(match.stage).toBe('retest');
    expect(match.invalidation).toBe(original.invalidation);
  });

  it('waits for the retest candle to close and respects the observation window', () => {
    const original = currentChannel();
    const sequence: Anchor[] = [...initial, [75, 133.5], [80, 139]];
    const forming = detectHuzi(candles(sequence, 75), defaults).find(value => value.id === original.id)!;
    expect(forming.events?.some(event => event.kind === 'retest')).toBe(false);
    const closed = detectHuzi(candles(sequence, 76), defaults).find(value => value.id === original.id)!;
    expect(closed.events?.some(event => event.kind === 'retest')).toBe(true);
    const expired = detectHuzi(candles(sequence), { ...defaults, retestWindow: 3 }).find(value => value.id === original.id)!;
    expect(expired.events?.some(event => event.kind === 'retest')).toBe(false);
  });

  it('distinguishes returning inside the structure from crossing its fixed invalidation level', () => {
    const original = currentChannel();
    const sequence: Anchor[] = [...initial, [75, 129], [80, 129]];
    const failed = detectHuzi(candles(sequence), defaults).find(value => value.id === original.id)!;
    expect(failed.stage).toBe('failed-breakout');
    expect(failed.status).toBe('confirmed');
    expect(failed.events?.some(event => event.kind === 'failed-breakout')).toBe(true);
    expect(failed.invalidatedAt).toBeUndefined();
    const broken = detectHuzi(candles([...sequence, [88, 90], [92, 90]]), defaults).find(value => value.id === original.id)!;
    expect(broken.stage).toBe('invalidated');
    expect(broken.confirmedAt).toBe(original.confirmedAt);
    expect(broken.invalidatedAt).toBeGreaterThan(failed.events!.find(event => event.kind === 'failed-breakout')!.knownAt);
  });

  it('stops triangle retest observations after its apex while retaining the fixed invalidation reference', () => {
    const triangle: Anchor[] = [[0, 100], [10, 110], [20, 90], [30, 110], [40, 98], [50, 110], [55, 106], [63, 115], [70, 115]];
    const original = detectHuzi(candles(triangle), defaults).find(value => value.family === 'huzi-triangle')!;
    expect(original).toBeDefined();
    const afterApex: Anchor[] = [...triangle, [85, 108]];
    const observed = detectHuzi(candles(afterApex), defaults).find(value => value.id === original.id)!;
    expect(observed.events?.map(event => event.kind)).toEqual(['breakout']);
    const stopped = detectHuzi(candles([...afterApex, [90, 95], [94, 95]]), defaults).find(value => value.id === original.id)!;
    expect(stopped.stage).toBe('invalidated');
    expect(stopped.invalidation).toBe(original.invalidation);
  });
});
