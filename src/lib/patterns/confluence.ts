import type { ColumnView, ParamValues } from '../core/types';
import type { PatternCandidate, PatternDivergenceEvidence, PatternMatch, PatternRatio } from './types';
import { detectHuzi } from './huzi';
import { detectHarmonics } from './harmonic';
import { detectHuziCandidates } from './huzi-candidates';
import { detectHarmonicCandidates } from './harmonic-candidates';
import { PATTERN_POOL_LIMIT } from './selection';
import { harmonicConsecutive, harmonicStep, harmonicView, validHarmonicBar } from './harmonic-swings';
import { resolvePatternLifecycle } from './lifecycle';

export const CONFLUENCE_FAMILIES = ['顺势收敛突破', '双背离极值反转'] as const;

const num = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

export interface ConfluenceSeriesOptions {
  /** Opt in only when the market is known to trade continuously. Without a
   * session calendar, overnight/lunch/weekend gaps are not missing candles. */
  requireContinuousTime?: boolean;
}

export interface ConfluenceOptions extends ConfluenceSeriesOptions {
  minVolumeRatio: number;
  minRiskReward: number;
  emaPeriod: number;
  rsiDivergenceMin: number;
  requireDualDivergence: boolean;
}

export function confluenceOptions(params: ParamValues = {}): ConfluenceOptions {
  return {
    minVolumeRatio: num(params.minVolumeRatio, 1.2, 0.8, 3.0),
    minRiskReward: num(params.minRiskReward, 0.45, 0.2, 2.0),
    emaPeriod: Math.round(num(params.emaPeriod, 50, 10, 200)),
    rsiDivergenceMin: num(params.rsiDivergenceMin, 1.0, 0.5, 10.0),
    requireDualDivergence: params.requireDualDivergence !== false,
    requireContinuousTime: params.requireContinuousTime === true,
  };
}

/** Closed, causal inputs can be reused to evaluate a raw geometry pool in research.
 * NaN means unavailable evidence, never a neutral indicator value. */
export interface ConfluenceSeries {
  close: Float64Array;
  high: Float64Array;
  low: Float64Array;
  vol: Float64Array;
  rsi: Float64Array;
  macd: Float64Array;
  signal: Float64Array;
  hist: Float64Array;
  volSma20: Float64Array;
  emaTrend: Float64Array;
  segmentStart: Int32Array;
  timeToIdx: Map<number, number>;
  closedCount: number;
}

function emaSeries(source: Float64Array, n: number, period: number, reset: Uint8Array): Float64Array {
  const out = new Float64Array(n).fill(NaN), k = 2 / (period + 1);
  let count = 0, sum = 0, value = NaN;
  for (let i = 0; i < n; i++) {
    if (reset[i] || !Number.isFinite(source[i])) { count = 0; sum = 0; value = NaN; }
    if (!Number.isFinite(source[i])) continue;
    count++;
    if (count <= period) {
      sum += source[i];
      if (count === period) value = sum / period;
    } else value = source[i] * k + value * (1 - k);
    out[i] = value;
  }
  return out;
}

export function buildConfluenceSeries(cols: ColumnView, emaPeriod = 50, options: ConfluenceSeriesOptions = {}): ConfluenceSeries {
  emaPeriod = Math.round(num(emaPeriod, 50, 10, 200));
  const time = cols.col('time'), close = cols.col('close'), high = cols.col('high'), low = cols.col('low'), vol = cols.col('volume');
  let n = Math.max(0, Math.min(cols.length, Math.floor(cols.closedLength ?? cols.length - 1)));
  while (n > 0 && !Number.isFinite(close[n - 1])) n--;
  const source = new Float64Array(n).fill(NaN), reset = new Uint8Array(n), segmentStart = new Int32Array(n);
  const step = options.requireContinuousTime ? harmonicStep({length: n, col: name => cols.col(name)}) : NaN;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const valid = validHarmonicBar(cols, i);
    const timeBreak = i > 0 && (time[i] <= time[i - 1] || options.requireContinuousTime === true && !harmonicConsecutive(time[i - 1], time[i], step));
    if (!i || !valid || !Number.isFinite(source[i - 1]) || timeBreak) { reset[i] = 1; start = i; }
    segmentStart[i] = start;
    if (valid) source[i] = close[i];
  }

  const rsi = new Float64Array(n).fill(NaN);
  let count = 0, avgGain = 0, avgLoss = 0;
  for (let i = 0; i < n; i++) {
    if (reset[i]) { count = 0; avgGain = 0; avgLoss = 0; continue; }
    const diff = source[i] - source[i - 1];
    if (!Number.isFinite(diff)) continue;
    const gain = Math.max(0, diff), loss = Math.max(0, -diff);
    count++;
    if (count <= 14) { avgGain += gain / 14; avgLoss += loss / 14; }
    else { avgGain = (avgGain * 13 + gain) / 14; avgLoss = (avgLoss * 13 + loss) / 14; }
    if (count >= 14) rsi[i] = avgLoss === 0 ? avgGain === 0 ? 50 : 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  const ema12 = emaSeries(source, n, 12, reset), ema26 = emaSeries(source, n, 26, reset);
  const macd = Float64Array.from(ema12, (value, i) => value - ema26[i]);
  const signal = emaSeries(macd, n, 9, reset), hist = Float64Array.from(macd, (value, i) => value - signal[i]);
  const volSma20 = new Float64Array(n).fill(NaN);
  let vSum = 0, vCount = 0;
  for (let i = 0; i < n; i++) {
    if (reset[i] || !Number.isFinite(vol[i]) || vol[i] < 0) { vSum = 0; vCount = 0; }
    if (!Number.isFinite(source[i]) || !Number.isFinite(vol[i]) || vol[i] < 0) continue;
    vSum += vol[i]; vCount++;
    if (vCount > 20) vSum -= vol[i - 20];
    if (vCount >= 20) volSma20[i] = vSum / 20;
  }
  const emaTrend = emaSeries(source, n, emaPeriod, reset), timeToIdx = new Map<number, number>();
  for (let i = 0; i < n; i++) if (Number.isFinite(time[i])) timeToIdx.set(time[i], i);
  return {close, high, low, vol, rsi, macd, signal, hist, volSma20, emaTrend, segmentStart, timeToIdx, closedCount: n};
}

export interface ConfluenceEvaluation {
  branch: typeof CONFLUENCE_FAMILIES[number];
  volRatio: number;
  rr1: number;
  rsiDelta: number;
  hasRsiDiv: boolean;
  hasMacdDiv: boolean;
  trendAligned: boolean;
  t1: number;
  t2: number;
  divergence?: { firstTime: number; secondTime: number; source: 'anchors' | 'recent-swings' };
}

interface DivergencePair {
  first: number;
  second: number;
  source: 'anchors' | 'recent-swings';
  rsiDelta: number;
  hasRsiDiv: boolean;
  hasMacdDiv: boolean;
}

/** A regular divergence is price making a new extreme while momentum weakens.
 * Both indicators must refer to the same two price extrema; evidence from
 * unrelated swing pairs must never be OR-ed into a synthetic dual divergence. */
function divergencePair(series: ConfluenceSeries, first: number, second: number, bull: boolean,
  minDelta: number, source: DivergencePair['source']): DivergencePair | undefined {
  if (second <= first + 2 || series.segmentStart[first] !== series.segmentStart[second]) return;
  const prices = bull ? series.low : series.high;
  if (![prices[first], prices[second], series.rsi[first], series.rsi[second], series.macd[first], series.macd[second], series.signal[first], series.signal[second]].every(Number.isFinite)) return;
  const epsilon = Math.max(1e-12, Math.abs(prices[first]) * 1e-10);
  if (bull ? prices[second] >= prices[first] - epsilon : prices[second] <= prices[first] + epsilon) return;
  const rsiDelta = bull ? series.rsi[second] - series.rsi[first] : series.rsi[first] - series.rsi[second];
  const macdDelta = bull ? series.macd[second] - series.macd[first] : series.macd[first] - series.macd[second];
  return {first, second, source, rsiDelta, hasRsiDiv: rsiDelta >= minDelta, hasMacdDiv: macdDelta > epsilon};
}

/** Evaluate one immutable raw shape at its first knowable closed candle. The
 * result describes gates, not a fill, position, win probability or backtest. */
export function evaluatePatternConfluence(match: PatternMatch, cols: ColumnView, series: ConfluenceSeries,
  options: ConfluenceOptions = confluenceOptions()): ConfluenceEvaluation | null {
  if (match.formation === 'early' || !Number.isFinite(match.confirmedAt) || !Number.isFinite(match.invalidation) || !match.targets?.length) return null;
  const time = cols.col('time'), n = series.closedCount;
  // An exact next timestamp is required. A missing bar is not a confirmation.
  const afterIdx = series.timeToIdx.get(match.confirmedAt) ?? (n < cols.length && time[n] === match.confirmedAt ? n : -1);
  const cIdx = afterIdx - 1;
  if (cIdx < 0 || cIdx >= n || ![series.emaTrend[cIdx], series.signal[cIdx], series.rsi[cIdx]].every(Number.isFinite)) return null;
  const bull = match.direction === 'bullish', side = bull ? 1 : -1, refPrice = series.close[cIdx];
  if (!Number.isFinite(refPrice) || refPrice <= 0) return null;
  const t1 = match.targets[0], t2 = match.targets[1] ?? (refPrice + (t1 - refPrice) * 1.618);
  const trueRisk = side * (refPrice - match.invalidation), reward1 = side * (t1 - refPrice);
  if (![trueRisk, reward1, t2].every(Number.isFinite) || trueRisk <= 0 || reward1 <= 0 || side * (t2 - t1) <= 0) return null;
  const rr1 = reward1 / trueRisk;
  if (rr1 < options.minRiskReward) return null;

  const baseline = series.volSma20[cIdx], volume = series.vol[cIdx];
  if (!Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(volume) || volume < 0) return null;
  const volRatio = volume / baseline;
  if (volRatio < options.minVolumeRatio) return null;

  const pts = match.points.map(point => ({point, index: series.timeToIdx.get(point.time)}))
    .filter((item): item is {point: PatternMatch['points'][number]; index: number} => item.index !== undefined && item.index <= cIdx);
  const extrema = pts.filter(({point, index}) => Math.abs(point.value - (bull ? series.low[index] : series.high[index])) <= Math.max(1e-12, Math.abs(point.value) * 1e-10));
  const pairs: DivergencePair[] = [];
  if (extrema.length >= 2) {
    const pair = divergencePair(series, extrema.at(-2)!.index, extrema.at(-1)!.index, bull, options.rsiDivergenceMin, 'anchors');
    if (pair) pairs.push(pair);
  }
  // A fallback swing needs a closed bar on both sides. Neither the forming bar
  // nor the current confirmation bar's unknown successor can validate a pivot.
  const winStart = Math.max(series.segmentStart[cIdx] + 1, cIdx - 28, pts[0]?.index ?? 0), mid = Math.floor((winStart + cIdx) / 2);
  const prices = bull ? series.low : series.high;
  const swing = (from: number, through: number): number | undefined => {
    let best: number | undefined;
    for (let i = from; i < through; i++) {
      const local = bull ? prices[i] <= prices[i - 1] && prices[i] < prices[i + 1] : prices[i] >= prices[i - 1] && prices[i] > prices[i + 1];
      if (local && (best === undefined || (bull ? prices[i] < prices[best] : prices[i] > prices[best]))) best = i;
    }
    return best;
  };
  const first = swing(winStart, mid), second = swing(mid, cIdx);
  if (first !== undefined && second !== undefined) {
    const pair = divergencePair(series, first, second, bull, options.rsiDivergenceMin, 'recent-swings');
    if (pair) pairs.push(pair);
  }
  const satisfies = (pair: DivergencePair) => options.requireDualDivergence ? pair.hasRsiDiv && pair.hasMacdDiv : pair.hasRsiDiv || pair.hasMacdDiv;
  const evidence = pairs.find(satisfies);
  const hasRsiDiv = evidence?.hasRsiDiv ?? false, hasMacdDiv = evidence?.hasMacdDiv ?? false;
  const trendAligned = bull ? refPrice >= series.emaTrend[cIdx] : refPrice <= series.emaTrend[cIdx];
  // Ordinary head-and-shoulders reversals cannot acquire a continuation label
  // merely because price crossed EMA; only their explicit continuation variant can.
  const continuation = ['huzi-triangle', 'huzi-wedge', 'huzi-channel', 'huzi-flag'].includes(match.family) || match.family === 'huzi-head-shoulders' && match.id.endsWith(':continuation');
  const branch = continuation && trendAligned ? '顺势收敛突破' : evidence ? '双背离极值反转' : undefined;
  if (!branch) return null;
  return {branch, volRatio, rr1, rsiDelta: evidence?.rsiDelta ?? 0, hasRsiDiv, hasMacdDiv, trendAligned, t1, t2,
    ...(evidence ? {divergence: {firstTime: time[evidence.first], secondTime: time[evidence.second], source: evidence.source}} : {})};
}

/** HSCP is an experimental filter over causal Huzi/harmonic geometry. Return
 * the historical pool under the same contract as those detectors; UI limits and
 * active-only display selection belong to the presentation layer. */
export function detectConfluence(input: ColumnView, params: ParamValues = {}): PatternMatch[] {
  const cols = harmonicView(input), familyFilter = typeof params.family === 'string' ? params.family : '全部';
  const options = confluenceOptions(params);
  // HSCP runs its own divergence gate on the raw geometry; the harmonic reading aids would only add a second, differently
  // defined divergence to its descriptions and ratios.
  const subParams: ParamValues = {...params, family: '全部', maxPatterns: PATTERN_POOL_LIMIT, showInvalidated: true, harmonicSignals: false};
  const rawMatches = [...detectHuzi(cols, subParams), ...detectHarmonics(cols, subParams)];
  const series = buildConfluenceSeries(cols, options.emaPeriod, options), results: PatternMatch[] = [];
  for (const match of rawMatches) {
    const evaluated = evaluatePatternConfluence(match, cols, series, options);
    if (!evaluated || familyFilter !== '全部' && evaluated.branch !== familyFilter) continue;
    const dual = evaluated.hasRsiDiv && evaluated.hasMacdDiv;
    const prefix = evaluated.branch === '顺势收敛突破' ? '顺势共振' : dual ? '双背离共振' : '指标背离共振';
    const enrichedRatios: PatternRatio[] = [
      {label: '初始盈亏比 R:R', value: evaluated.rr1, expected: `>= ${options.minRiskReward.toFixed(2)}`},
      {label: '确认柱量能 / SMA20', value: evaluated.volRatio, expected: `>= ${options.minVolumeRatio.toFixed(2)}x`},
      ...(evaluated.hasRsiDiv ? [{label: 'RSI(14) 同侧极值背离差', value: evaluated.rsiDelta, expected: `>= ${options.rsiDivergenceMin.toFixed(1)}`}] : []),
      ...match.ratios,
    ];
    const divergences: PatternDivergenceEvidence[] = [];
    if (evaluated.divergence) {
      const {firstTime, secondTime} = evaluated.divergence;
      const first = series.timeToIdx.get(firstTime)!, second = series.timeToIdx.get(secondTime)!;
      if (evaluated.hasRsiDiv) divergences.push({indicator: 'rsi', series: 'rsi', params: {period: 14},
        points: [{time: firstTime, value: series.rsi[first]}, {time: secondTime, value: series.rsi[second]}], minDelta: options.rsiDivergenceMin});
      if (evaluated.hasMacdDiv) divergences.push({indicator: 'macd', series: 'dif', params: {fast: 12, slow: 26, signal: 9},
        points: [{time: firstTime, value: series.macd[first]}, {time: secondTime, value: series.macd[second]}]});
    }
    const note = `HSCP 实验性量价共振（${evaluated.branch}）· 闭柱确认量能 ${evaluated.volRatio.toFixed(2)}x SMA20，按确认收盘价测量初始 T1 盈亏比 ${evaluated.rr1.toFixed(2)}${evaluated.trendAligned ? `，价格处于 EMA(${options.emaPeriod}) 顺势侧` : ''}${dual ? '，同一对价格新极值具备 RSI(14) 与 MACD 线双背离' : evaluated.hasRsiDiv || evaluated.hasMacdDiv ? '，具备同侧价格新极值的单指标背离' : ''}。目标为几何参考；尚不代表入场成交、分批止盈或追踪止损策略，收益需独立含成本回测。`;
    // A Huzi T1 touch cannot be inherited as if the added T2 had been touched.
    const {resolution: _resolution, divergences: _divergences, ...geometry} = match;
    const enriched = resolvePatternLifecycle({...geometry, id: `hscp:${match.id}`, ruleVersion: 'confluence-hscp/2.0-evidence',
      name: `${prefix} · ${match.name}`, targets: [evaluated.t1, evaluated.t2], ratios: enrichedRatios,
      ...(divergences.length ? {divergences} : {}), description: `${note} ${match.description}`}, cols);
    if (params.showInvalidated === true || enriched.status !== 'invalidated') results.push(enriched);
  }
  const limit = Math.round(num(params.maxPatterns, 12, 1, PATTERN_POOL_LIMIT));
  return results.sort((a, b) => b.confirmedAt - a.confirmedAt || a.id.localeCompare(b.id)).slice(0, limit);
}

export function detectConfluenceCandidates(cols: ColumnView, params: ParamValues, confirmed: readonly PatternMatch[] = []): PatternCandidate[] {
  const familyFilter = typeof params.family === 'string' ? params.family : '全部';
  const subParams: ParamValues = {...params, family: '全部'};
  // Candidates are incomplete geometry, so volume, divergence and executable
  // R:R are pending. Do not turn an RSI uptick or a neutral direction into a
  // claim that any of the eventual confirmation gates has already passed.
  const rawCandidates = [
    ...(familyFilter === '双背离极值反转' ? [] : detectHuziCandidates(cols, subParams, confirmed)),
    ...(familyFilter === '顺势收敛突破' ? [] : detectHarmonicCandidates(cols, subParams, confirmed)),
  ];
  return rawCandidates.map(cand => ({...cand, id: `hscp-cand:${cand.id}`, name: `共振观察 · ${cand.name}`,
    description: `HSCP 未完成结构 · 量能、趋势或同组指标背离、确认价格盈亏比均待完成时校验，当前不构成共振信号。${cand.description}`})).slice(0, 24);
}
