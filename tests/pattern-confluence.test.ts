import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColumnName, ColumnView } from '../src/lib/core/types';
import type { PatternMatch } from '../src/lib/patterns/types';
import * as huzi from '../src/lib/patterns/huzi';
import * as harmonic from '../src/lib/patterns/harmonic';
import { buildConfluenceSeries, confluenceOptions, detectConfluence, evaluatePatternConfluence } from '../src/lib/patterns/confluence';

const step = 60_000;
function fixture(length = 101) {
  const columns = Object.fromEntries((['time', 'open', 'high', 'low', 'close', 'volume'] as ColumnName[]).map(name =>
    [name, Float64Array.from({length}, (_, i) => name === 'time' ? i * step : name === 'high' ? 101 : name === 'low' ? 99 : 100)])) as Record<ColumnName, Float64Array>;
  const cols: ColumnView = {length, col: name => columns[name]};
  return {columns, cols};
}
function geometry(): PatternMatch {
  return {id: 'fixture', family: '5-0', name: 'Fixture', direction: 'bullish',
    points: [{label: 'B', time: 60 * step, value: 90}, {label: 'C', time: 70 * step, value: 101}, {label: 'D', time: 80 * step, value: 89}],
    confirmedAt: 100 * step, invalidation: 85, targets: [110, 118], zone: {low: 88, high: 90}, ratios: [], description: '', status: 'confirmed'};
}
function evidence() {
  const {cols, columns} = fixture();
  columns.low[60] = 90; columns.low[80] = 89; columns.volume[99] = 200;
  const series = buildConfluenceSeries(cols);
  // Predicate tests isolate evidence pairing from indicator arithmetic. Real
  // arithmetic, warmup, gaps and prefix invariance are verified separately.
  series.rsi.fill(50); series.macd.fill(0); series.signal.fill(0);
  series.rsi[60] = 25; series.rsi[80] = 35; series.macd[60] = -3; series.macd[80] = -1;
  return {cols, columns, series, match: geometry()};
}

/** Real OHLC recurrences, with raw geometry injected independently of the
 * geometry detector so payload tests do not manufacture indicator values. */
function momentumFixture(mode: 'dual' | 'rsi-only' | 'macd-only' = 'dual') {
  const {cols, columns} = fixture(141), secondLow = mode === 'rsi-only' ? 60 : 89;
  const anchors = [[0, 110], [40, mode === 'macd-only' ? 100 : 110], [60, 90], [70, 108], [80, secondLow], [100, 100], [140, 102]];
  for (let i = 0; i < cols.length; i++) {
    let leg = 1; while (i > anchors[leg][0]) leg++;
    const a = anchors[leg - 1], b = anchors[leg];
    const value = mode === 'macd-only' && i <= 40 ? 100 + 5 * Math.sin(i * Math.PI / 2)
      : a[1] + (b[1] - a[1]) * (i - a[0]) / (b[0] - a[0]);
    columns.open[i] = columns.close[i] = value; columns.high[i] = value + 1; columns.low[i] = value - 1;
  }
  columns.volume[99] = 200;
  const match: PatternMatch = {...geometry(), invalidation: mode === 'rsi-only' ? 55 : 85,
    targets: mode === 'rsi-only' ? [130, 150] : [110, 118],
    points: geometry().points.map(point => ({...point, value: columns[point.label === 'C' ? 'high' : 'low'][point.time / step]}))};
  return {cols, columns, match};
}
afterEach(() => vi.restoreAllMocks());

describe('HSCP indicator evidence', () => {
  it('requires full indicator warmup and keeps a flat market RSI neutral', () => {
    const {cols} = fixture();
    const series = buildConfluenceSeries(cols, 50);
    expect(Number.isNaN(series.rsi[13])).toBe(true); expect(series.rsi[14]).toBe(50);
    expect(Number.isNaN(series.macd[24])).toBe(true); expect(series.macd[25]).toBe(0);
    expect(Number.isNaN(series.signal[32])).toBe(true); expect(series.signal[33]).toBe(0);
    expect(Number.isNaN(series.emaTrend[48])).toBe(true); expect(series.emaTrend[49]).toBe(100);
    expect(Number.isNaN(series.volSma20[18])).toBe(true); expect(series.volSma20[19]).toBe(100);
    const early = {...geometry(), family: 'huzi-triangle', confirmedAt: 30 * step};
    expect(evaluatePatternConfluence(early, cols, series)).toBeNull();
  });

  it('resets warmup after invalid prices/volume and explicit continuous-market timestamp gaps', () => {
    const {cols, columns} = fixture(160);
    columns.close[70] = NaN;
    const invalid = buildConfluenceSeries(cols);
    expect(Number.isNaN(invalid.rsi[84])).toBe(true); expect(invalid.rsi[85]).toBe(50);
    expect(Number.isNaN(invalid.emaTrend[119])).toBe(true); expect(invalid.emaTrend[120]).toBe(100);
    columns.close[70] = 100;
    for (let i = 70; i < cols.length; i++) columns.time[i] += step;
    const gap = buildConfluenceSeries(cols, 50, {requireContinuousTime: true});
    expect(gap.segmentStart[70]).toBe(70); expect(Number.isNaN(gap.signal[102])).toBe(true); expect(gap.signal[103]).toBe(0);
    columns.volume[120] = NaN;
    const missingVolume = buildConfluenceSeries(cols);
    expect(Number.isNaN(missingVolume.volSma20[139])).toBe(true); expect(missingVolume.volSma20[140]).toBe(100);
  });

  it('carries trading-bar warmup through legitimate A-share lunch and overnight sessions', () => {
    const {cols, columns} = fixture(145), firstOpen = Date.UTC(2026, 8, 21, 1, 30);
    for (let i = 0; i < cols.length; i++) {
      const day = Math.floor(i / 48), sessionBar = i % 48;
      const minutes = sessionBar < 24 ? sessionBar * 5 : 210 + (sessionBar - 24) * 5;
      columns.time[i] = firstOpen + day * 86_400_000 + minutes * step;
    }
    columns.volume[99] = 200;
    const series = buildConfluenceSeries(cols, 50);
    expect(columns.time[24] - columns.time[23]).toBe(95 * step);
    expect(columns.time[48] - columns.time[47]).toBe(1115 * step);
    expect(series.segmentStart[48]).toBe(0); expect(series.segmentStart[96]).toBe(0);
    expect(series.emaTrend[49]).toBe(100); expect(series.rsi[99]).toBe(50);
    const match = {...geometry(), family: 'huzi-triangle', confirmedAt: columns.time[100],
      points: geometry().points.map(point => ({...point, time: columns.time[point.time / step]}))};
    expect(evaluatePatternConfluence(match, cols, series)?.branch).toBe('顺势收敛突破');
    // The stricter mode is explicit and therefore unsuitable for this market.
    const continuous = buildConfluenceSeries(cols, 50, {requireContinuousTime: true});
    expect(continuous.segmentStart[48]).toBe(48);
    expect(continuous.emaTrend.every(Number.isNaN)).toBe(true);
  });

  it('still resets on duplicate or decreasing timestamps without a calendar assumption', () => {
    const {cols, columns} = fixture(160);
    columns.time[70] = columns.time[69];
    const duplicate = buildConfluenceSeries(cols);
    expect(duplicate.segmentStart[70]).toBe(70); expect(Number.isNaN(duplicate.emaTrend[118])).toBe(true);
    expect(duplicate.emaTrend[119]).toBe(100);
    columns.time[70] = columns.time[69] - step;
    expect(buildConfluenceSeries(cols).segmentStart[70]).toBe(70);
  });

  it('does not consume hidden future or forming candle prices and volume', () => {
    const {cols, columns} = fixture(130);
    for (let i = 0; i < 100; i++) columns.close[i] = columns.open[i] = 100 + Math.sin(i / 10);
    const closed: ColumnView = {...cols, closedLength: 100};
    const before = buildConfluenceSeries(closed);
    for (const name of ['open', 'high', 'low', 'close', 'volume'] as ColumnName[]) columns[name].fill(99999, 100);
    const after = buildConfluenceSeries(closed);
    for (const key of ['rsi', 'macd', 'signal', 'emaTrend', 'volSma20'] as const) expect(after[key]).toEqual(before[key]);
    const prefix = buildConfluenceSeries({length: 81, col: name => columns[name]});
    for (const key of ['rsi', 'macd', 'signal', 'emaTrend', 'volSma20'] as const) expect(before[key].slice(0, 80)).toEqual(prefix[key]);
  });
});

describe('HSCP gates use the evidence they claim', () => {
  it('accepts regular dual divergence on the same two lower price lows', () => {
    const {cols, series, match} = evidence();
    const evaluated = evaluatePatternConfluence(match, cols, series)!;
    expect(evaluated.branch).toBe('双背离极值反转');
    expect(evaluated.hasRsiDiv && evaluated.hasMacdDiv).toBe(true);
    expect(evaluated.divergence).toEqual({firstTime: 60 * step, secondTime: 80 * step, source: 'anchors'});
  });

  it('rejects higher-low momentum improvement mislabeled as regular bullish divergence', () => {
    const {cols, columns, series, match} = evidence();
    columns.low[80] = 95; match.points[2].value = 95;
    expect(evaluatePatternConfluence(match, cols, series)).toBeNull();
  });

  it('requires price to make a new extreme, including when lows are equal', () => {
    const {cols, columns, series, match} = evidence();
    columns.low[80] = 90; match.points[2].value = 90;
    expect(evaluatePatternConfluence(match, cols, series)).toBeNull();
  });

  it('does not substitute histogram recovery for the specified MACD line divergence', () => {
    const {cols, series, match} = evidence();
    series.macd[80] = -4; series.hist[60] = -5; series.hist[80] = -1;
    expect(evaluatePatternConfluence(match, cols, series)).toBeNull();
    const single = evaluatePatternConfluence(match, cols, series, confluenceOptions({requireDualDivergence: false}))!;
    expect(single.hasRsiDiv).toBe(true); expect(single.hasMacdDiv).toBe(false);
  });

  it('does not merge RSI evidence from anchors with MACD evidence from a different pair', () => {
    const {cols, columns, series, match} = evidence();
    columns.low[80] = 99; columns.low[90] = 89;
    match.points[2] = {label: 'D', time: 90 * step, value: 89};
    series.rsi[90] = 35; series.macd[90] = -4;
    columns.low[74] = 88; columns.low[94] = 87;
    series.rsi[74] = 40; series.rsi[94] = 35; series.macd[74] = -3; series.macd[94] = -1;
    expect(evaluatePatternConfluence(match, cols, series)).toBeNull();
  });

  it('applies the corresponding higher-high rule to bearish divergence', () => {
    const {cols, columns, series, match} = evidence();
    for (let i = 0; i < cols.length; i++) {
      const oldLow = columns.low[i]; columns.low[i] = 200 - columns.high[i]; columns.high[i] = 200 - oldLow;
      series.rsi[i] = 100 - series.rsi[i]; series.macd[i] *= -1; series.signal[i] *= -1;
    }
    match.direction = 'bearish'; match.invalidation = 115; match.targets = [90, 82];
    match.points = match.points.map(point => ({...point, value: 200 - point.value}));
    expect(evaluatePatternConfluence(match, cols, series)?.hasMacdDiv).toBe(true);
    columns.high[80] = 105; match.points[2].value = 105;
    expect(evaluatePatternConfluence(match, cols, series)).toBeNull();
  });

  it('never bypasses the volume threshold through a stale pivot spike or low-base step expansion', () => {
    const {cols, columns} = fixture();
    columns.volume[80] = 800; columns.volume[98] = 10; columns.volume[99] = 12;
    const match = {...geometry(), family: 'huzi-triangle'};
    const series = buildConfluenceSeries(cols);
    expect(evaluatePatternConfluence(match, cols, series, confluenceOptions({minVolumeRatio: 3}))).toBeNull();
    columns.volume.fill(100); columns.volume[99] = 200;
    const passing = evaluatePatternConfluence(match, cols, buildConfluenceSeries(cols))!;
    expect(passing.volRatio).toBeCloseTo(200 / 105);
    expect(evaluatePatternConfluence(match, cols, buildConfluenceSeries(cols), confluenceOptions({minVolumeRatio: 2}))).toBeNull();
  });

  it('rejects unknown or missing confirmation timestamps and reversed target ordering', () => {
    const {cols, series, match} = evidence();
    expect(evaluatePatternConfluence({...match, confirmedAt: 100.5 * step}, cols, series)).toBeNull();
    expect(evaluatePatternConfluence({...match, confirmedAt: 120 * step}, cols, series)).toBeNull();
    expect(evaluatePatternConfluence({...match, targets: [110, 105]}, cols, series)).toBeNull();
  });

  it('does not relabel an ordinary head-and-shoulders reversal as continuation', () => {
    const {cols, series, match} = evidence();
    series.rsi.fill(50); series.macd.fill(0);
    const head = {...match, family: 'huzi-head-shoulders'};
    expect(evaluatePatternConfluence(head, cols, series)).toBeNull();
    expect(evaluatePatternConfluence({...head, id: 'head:continuation'}, cols, series)?.branch).toBe('顺势收敛突破');
  });
});

describe('HSCP pool and lifecycle contract', () => {
  function mockPool(matches: PatternMatch[]) {
    vi.spyOn(huzi, 'detectHuzi').mockReturnValue(matches);
    vi.spyOn(harmonic, 'detectHarmonics').mockReturnValue([]);
  }

  it('retains invalidated history and more than 200 entries when the scan requests them', () => {
    const {cols, columns} = fixture(); columns.volume[99] = 200;
    const matches = Array.from({length: 240}, (_, i): PatternMatch => ({...geometry(), id: `shape-${i}`, family: 'huzi-triangle',
      status: i % 2 ? 'invalidated' : 'confirmed', ...(i % 2 ? {invalidatedAt: 103 * step} : {})}));
    mockPool(matches);
    const all = detectConfluence(cols, {showInvalidated: true, maxPatterns: 1000});
    expect(all).toHaveLength(240); expect(all.filter(match => match.status === 'invalidated')).toHaveLength(120);
    expect(detectConfluence(cols, {maxPatterns: 1000})).toHaveLength(120);
    expect(detectConfluence(cols, {showInvalidated: true, maxPatterns: 7})).toHaveLength(7);
    expect(huzi.detectHuzi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({showInvalidated: true, maxPatterns: 1000}));
  });

  it('recomputes lifecycle after adding a second Huzi reference, avoiding inherited T1 resolution', () => {
    const {cols, columns} = fixture(111); columns.volume[99] = 200;
    columns.high[100] = 112;
    const match: PatternMatch = {...geometry(), family: 'huzi-triangle', targets: [110],
      resolution: {kind: 'target-reached', time: 100 * step, knownAt: 101 * step, price: 110, targetIndex: 0}};
    mockPool([match]);
    const first = detectConfluence(cols, {showInvalidated: true})[0];
    expect(first.targets).toEqual([110, 116.18]); expect(first.resolution).toBeUndefined();
    expect(first.description).not.toContain('T1 减半推保本');
    columns.high[101] = 118;
    const second = detectConfluence(cols, {showInvalidated: true})[0];
    expect(second.resolution?.targetIndex).toBe(1); expect(second.resolution?.price).toBe(116.18);
  });

  it('accepts explicit closure with a synthetic time sentinel without consuming synthetic prices', () => {
    const {cols, columns} = fixture(100); columns.volume[99] = 200;
    mockPool([{...geometry(), family: 'huzi-triangle'}]);
    expect(detectConfluence({...cols, closedLength: 100}, {showInvalidated: true})).toHaveLength(1);
    expect(detectConfluence(cols, {showInvalidated: true})).toHaveLength(0);
  });

  it('publishes both passing indicators from the selected same-pair evidence with cloneable numeric samples', () => {
    const {cols, match} = momentumFixture();
    mockPool([match]);
    const result = detectConfluence(cols, {showInvalidated: true, rsiDivergenceMin: 3})[0];
    const series = buildConfluenceSeries(cols);
    expect(result.divergences).toEqual([
      {indicator: 'rsi', series: 'rsi', params: {period: 14}, minDelta: 3,
        points: [{time: 60 * step, value: series.rsi[60]}, {time: 80 * step, value: series.rsi[80]}]},
      {indicator: 'macd', series: 'dif', params: {fast: 12, slow: 26, signal: 9},
        points: [{time: 60 * step, value: series.macd[60]}, {time: 80 * step, value: series.macd[80]}]},
    ]);
    expect(structuredClone(result)).toEqual(result);
    expect(JSON.parse(JSON.stringify(result.divergences))).toEqual(result.divergences);
    expect(result.id).toBe(`hscp:${match.id}`); expect(result.family).toBe(match.family); expect(result.points).toEqual(match.points);
  });

  for (const [mode, indicator] of [['rsi-only', 'rsi'], ['macd-only', 'macd']] as const) {
    it(`publishes only the actual passing ${indicator} evidence when single divergence is permitted`, () => {
      const {cols, match} = momentumFixture(mode);
      mockPool([match]);
      expect(detectConfluence(cols, {showInvalidated: true})).toHaveLength(0);
      const result = detectConfluence(cols, {showInvalidated: true, requireDualDivergence: false})[0];
      expect(result.divergences).toHaveLength(1); expect(result.divergences![0].indicator).toBe(indicator);
      expect(result.divergences![0].points.map(point => point.time)).toEqual([60 * step, 80 * step]);
    });
  }

  it('does not invent or inherit a divergence payload for a continuation with no passing divergence', () => {
    const {cols, columns} = fixture(); columns.volume[99] = 200;
    const stale: PatternMatch = {...geometry(), family: 'huzi-triangle', divergences: [{indicator: 'rsi', series: 'rsi', params: {period: 14},
      points: [{time: 60 * step, value: 25}, {time: 80 * step, value: 35}], minDelta: 1}]};
    mockPool([stale]);
    const result = detectConfluence(cols, {showInvalidated: true})[0];
    expect(result).toBeDefined(); expect(result).not.toHaveProperty('divergences');
  });

  it('keeps confirmed divergence samples identical after a prefix is extended or future prices change', () => {
    const {cols, columns, match} = momentumFixture();
    mockPool([match]);
    const prefix: ColumnView = {...cols, length: 101, closedLength: 100};
    const before = detectConfluence(prefix, {showInvalidated: true})[0];
    expect(before.divergences).toHaveLength(2);
    const extended = detectConfluence(cols, {showInvalidated: true})[0];
    expect(extended.divergences).toEqual(before.divergences);
    for (let i = 100; i < cols.length; i++) {
      columns.open[i] = columns.close[i] = 500 + i; columns.high[i] = 501 + i; columns.low[i] = 499 + i; columns.volume[i] = 5000;
    }
    const revisedFuture = detectConfluence(cols, {showInvalidated: true})[0];
    expect(revisedFuture.divergences).toEqual(before.divergences);
  });
});
