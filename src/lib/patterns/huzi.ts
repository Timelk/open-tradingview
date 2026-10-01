import type { ColumnView, ParamValues } from '../core/types';
import type { PatternEvent, PatternGuide, PatternMatch, PatternPoint, PatternRatio, PatternStage } from './types';
import { appendPivot, confirmedPivotEvents, type Pivot } from './pivots';
import {resolvePatternLifecycle} from './lifecycle';
import { appendHuziSwing } from './huzi-swings';
import { harmonicView } from './harmonic-swings';
import { boundaryEnvelopes, WICK_ALLOWANCE, type BoundaryContext } from './huzi-boundary';
import { FLAG_POLE_RATIO } from './huzi-defaults';
import { zoneSetups } from './huzi-zone';
import { cupSetups } from './huzi-cup';
import { accelSetups } from './huzi-accel';
import { shoulderSetups } from './huzi-shoulders';

type Direction = 'bullish' | 'bearish';
/** Pivot radius cap for the boundary search (the zig-zag ladder is capped at 30). */
const BOUNDARY_MAX_RADIUS = 120;
export { FLAG_POLE_RATIO };
type Line = { slope: number; intercept: number };
type Setup = {
  pivots: Pivot[]; family: string; name: string; height: number; tolerance: number;
  upper: Line; lower: Line; radius: number; neckline?: Line; direction?: Direction;
  labels?: string[]; ratios: PatternRatio[]; formation: 'complete' | 'early';
  pole?: [Pivot, Pivot]; poleDirection?: Direction; poleHeight?: number; flagExpiresAt?: number; continuation?: boolean;
  availableFrom?: number; swingRetracement?: number;
  /** Boundaries were drawn through selected touches that contain the price (see huzi-boundary.ts). */
  boundary?: boolean;
  /** Structural stop for neckline-type setups; without it the last pivot (double: the two extremes) is used. */
  stop?: number;
  /** Curved support: the close must not lose it before the breakout (rising/falling acceleration). */
  floorAt?: (index: number) => number;
  /** Position of the head inside `pivots` when it is not the third one (complex shoulders). */
  headAt?: number;
  /** First bar of the enveloping lines when it is later than the first pivot (structure inside a shoulder). */
  envelopeFrom?: number;
  /** A horizontal band the price keeps testing from one side (`side` 1: from below, -1: from above). */
  band?: { top: number; bottom: number; side: 1 | -1 };
  /** A fitted curve drawn as a guide over bars `from..to`. */
  curve?: { at: (index: number) => number; from: number; to: number };
  /** Extra sentences for the description; each ends with a full stop so it can be translated on its own. */
  notes?: string[];
};
export type { Line, Setup, Direction };
const at = (line: Line, index: number) => line.slope * index + line.intercept;
const bounded = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const horizontal = (price: number): Line => ({ slope: 0, intercept: price });

function fitted(points: Pivot[]): Line {
  const x = points.reduce((sum, point) => sum + point.index, 0) / points.length;
  const y = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  let numerator = 0, denominator = 0;
  for (const point of points) { numerator += (point.index - x) * (point.value - y); denominator += (point.index - x) ** 2; }
  const slope = denominator > 0 ? numerator / denominator : 0;
  return { slope, intercept: y - slope * x };
}

export function headShoulders(p: Pivot[], radius: number, tolerance: number): Setup | undefined {
  const [left, neck1, head, neck2, right] = p;
  const sign = head.kind === 'high' ? 1 : -1;
  const neckline = fitted([neck1, neck2]);
  const height = sign * (head.value - at(neckline, head.index));
  const shoulderGap = Math.abs(left.value - right.value);
  const span = right.index - left.index;
  const balance = (head.index - left.index) / (right.index - head.index);
  const prominence = Math.min(sign * (head.value - left.value), sign * (head.value - right.value));
  if (height <= 0 || span < Math.max(12, radius * 6) || balance < 0.35 || balance > 2.85) return;
  if (shoulderGap > height * (0.22 + tolerance)) return;
  if (prominence < height * 0.18) return;
  if (sign * (left.value - at(neckline, left.index)) < height * 0.3 || sign * (right.value - at(neckline, right.index)) < height * 0.3) return;
  if (Math.abs(neckline.slope * span) > height * 0.4) return;
  const shoulders = fitted([left, right]);
  return { pivots: p, family: 'huzi-head-shoulders', name: sign > 0 ? '头肩顶' : '头肩底',
    height, tolerance: height * tolerance, upper: sign > 0 ? shoulders : neckline,
    lower: sign > 0 ? neckline : shoulders, radius, neckline, direction: sign > 0 ? 'bearish' : 'bullish',
    labels: ['L', 'N1', 'H', 'N2', 'R'], formation: 'complete',
    ratios: [
      { label: '左右肩偏差 / 头部高度', value: shoulderGap / height, expected: `≤ ${(0.22 + tolerance).toFixed(3)}` },
      { label: '最小头肩高差 / 头部高度', value: prominence / height, expected: '≥ 0.180' },
      { label: '左肩至头 / 头至右肩时长', value: balance, expected: '0.350–2.850' },
    ] };
}

function doubleTurn(p: Pivot[], radius: number, tolerance: number, minSpan:number, minLeg:number): Setup | undefined {
  const [left, neck, right] = p, bullish = left.kind === 'low', sign = bullish ? 1 : -1;
  const height = sign * (neck.value - (left.value + right.value) / 2);
  const span = right.index - left.index, balance = (neck.index - left.index) / (right.index - neck.index);
  const difference = Math.abs(left.value - right.value);
  // Radius controls when a pivot is knowable, not an additional four-radius
  // minimum duration. The actual alternating anchors and explicit spacing are
  // checked here; confirm() still waits until all right windows have closed.
  if (height <= 0 || span < minSpan || neck.index-left.index<minLeg || right.index-neck.index<minLeg || balance < .3 || balance > 3.33 || difference > height * (.2 + tolerance)) return;
  const neckline = horizontal(neck.value), base = fitted([left, right]);
  return { pivots: p, family: 'huzi-double', name: bullish ? 'W 双底' : 'M 双顶', height,
    tolerance: height * tolerance, upper: bullish ? neckline : base, lower: bullish ? base : neckline,
    radius, neckline, direction: bullish ? 'bullish' : 'bearish', labels: bullish ? ['B1', 'N', 'B2'] : ['T1', 'N', 'T2'], formation: 'complete',
    ratios: [{ label: '双极值偏差 / 颈线高度', value: difference / height, expected: `≤ ${(0.2 + tolerance).toFixed(3)}` }] };
}

export function envelope(p: Pivot[], radius: number, tolerance: number, previous?: Pivot, poleRatio = FLAG_POLE_RATIO): Setup | undefined {
  const upperPoints = p.filter(point => point.kind === 'high'), lowerPoints = p.filter(point => point.kind === 'low');
  if (upperPoints.length < 2 || lowerPoints.length < 2) return;
  const upper = fitted(upperPoints), lower = fitted(lowerPoints);
  const begin = p[0].index, end = p.at(-1)!.index, span = end - begin;
  const height = Math.max(...p.map(point => point.value)) - Math.min(...p.map(point => point.value));
  if (height <= 0 || span < Math.max(p.length === 4 ? 9 : 12, radius * (p.length === 4 ? 4 : 6))) return;
  const error = Math.max(...p.map(point => Math.abs(point.value - at(point.kind === 'high' ? upper : lower, point.index))));
  if (error > height * tolerance * 1.5) return;
  const width0 = at(upper, begin) - at(lower, begin), width1 = at(upper, end) - at(lower, end);
  if (width0 <= 0 || width1 <= 0) return;
  const ratio = width1 / width0;
  const top = upper.slope * span / height, bottom = lower.slope * span / height;
  const flat = Math.max(0.06, tolerance * 2);
  let name: string, family: string;
  if (ratio >= .75 && ratio <= 1.25 && Math.abs(top - bottom) <= .12) {
    family = 'huzi-channel'; name = Math.abs(top + bottom) / 2 <= flat ? '水平通道' : top + bottom > 0 ? '上升通道' : '下降通道';
  } else if (ratio >= .1 && ratio <= .88) {
    if (Math.abs(top) <= flat && bottom > Math.max(.12, flat)) { name = '上升三角形'; family = 'huzi-triangle'; }
    else if (Math.abs(bottom) <= flat && top < -Math.max(.12, flat)) { name = '下降三角形'; family = 'huzi-triangle'; }
    else if (top < -flat && bottom > flat) { name = '对称三角形'; family = 'huzi-triangle'; }
    else if (top > flat && bottom > top + .12) { name = '上升楔形'; family = 'huzi-wedge'; }
    else if (bottom < -flat && top < bottom - .12) { name = '下降楔形'; family = 'huzi-wedge'; }
    else return;
  } else return;
  const setup: Setup = { pivots: p, family, name, height, tolerance: height * tolerance, upper, lower, radius,
    formation: p.length === 4 ? 'early' : 'complete',
    ratios: [{ label: '末端 / 初始宽度', value: ratio, expected: family === 'huzi-channel' ? '0.75–1.25' : '0.10–0.88' }] };
  if (family === 'huzi-channel' && previous && p.length === 5) applyFlag(setup, previous, top, bottom, flat, poleRatio);
  return setup;
}

/** A channel becomes a flag only when an already-confirmed directional pole
 * precedes a compact, opposite-sloping consolidation. These numerical limits
 * are explicit engineering filters, not discretionary-author profitability claims. */
function applyFlag(setup: Setup, previous: Pivot, top: number, bottom: number, flat: number, poleRatio: number): void {
  const p = setup.pivots, first = p[0], height = setup.height, span = p.at(-1)!.index - first.index;
  const poleHeight = Math.abs(first.value - previous.value), poleSpan = first.index - previous.index;
  const sign = first.kind === 'high' ? 1 : -1;
  const deepest = sign > 0 ? Math.min(...p.map(point => point.value)) : Math.max(...p.map(point => point.value));
  const retracement = sign * (first.value - deepest) / poleHeight;
  if (poleHeight >= poleRatio * height && poleSpan > 0 && poleSpan <= span * .75 && retracement > 0 && retracement <= .618 && sign * (top + bottom) / 2 < -flat) {
    setup.family = 'huzi-flag'; setup.name = sign > 0 ? '上涨旗形' : '下跌旗形';
    setup.pole = [previous, first]; setup.poleDirection = sign > 0 ? 'bullish' : 'bearish'; setup.poleHeight = poleHeight;
    setup.ratios.push({ label: '整理回撤 / 旗杆', value: retracement, expected: '≤ 0.618' });
  }
}

/** The boundary search finds channels from their touches alone, so the pole is looked for explicitly: the flag
 * starts where the pole ends (the first touch, the top of a bullish pole) and the pole starts at the most extreme
 * opposite pivot shortly before it. The move must be an actual impulse, not a drift with retracements. */
function boundaryFlag(setup: Setup, highs: readonly Pivot[], lows: readonly Pivot[], high: Float64Array, low: Float64Array, close: Float64Array, tolerance: number, poleRatio: number): void {
  const p = setup.pivots, first = p[0], span = p.at(-1)!.index - first.index, height = setup.height;
  const sign = first.kind === 'high' ? 1 : -1, pool = sign > 0 ? lows : highs;
  let previous: Pivot | undefined;
  for (const candidate of pool) {
    if (candidate.index >= first.index) break;
    if (candidate.index < first.index - Math.floor(span * .75)) continue;
    if (!previous || sign * (previous.value - candidate.value) > 0) previous = candidate;
  }
  if (!previous || Math.abs(first.value - previous.value) < poleRatio * height) return;
  // The first touch must be the end of the pole: nothing between the pole's start and it goes further.
  let path = 0;
  for (let i = previous.index; i <= first.index; i++) {
    if (sign * ((sign > 0 ? high[i] : low[i]) - first.value) > setup.tolerance) return;
    if (i > previous.index) path += Math.abs(close[i] - close[i - 1]);
  }
  if (!(path > 0) || Math.abs(close[first.index] - close[previous.index]) / path < .45) return;
  const top = setup.upper.slope * span / height, bottom = setup.lower.slope * span / height;
  applyFlag(setup, previous, top, bottom, Math.max(0.06, tolerance * 2), poleRatio);
}

/** Was the move INTO the structure with the breakout (continuation) or against it (reversal)? Uses only
 * candles before the first touch. A net approach smaller than half the structure's height is not a trend. */
export function trendContext(close: Float64Array, first: number, span: number, height: number, direction: Direction): { kind: 'continuation' | 'reversal'; ratio: number; approach: Direction } | undefined {
  const from = Math.max(0, first - Math.max(12, Math.round(span * .8)));
  if (first - from < 8 || !(height > 0)) return;
  const move = close[first] - close[from], ratio = Math.abs(move) / height;
  if (!(ratio >= .5)) return;
  const approach: Direction = move > 0 ? 'bullish' : 'bearish';
  return { kind: approach === direction ? 'continuation' : 'reversal', ratio, approach };
}

function validBar(cols: ColumnView, index: number): boolean {
  const o = cols.col('open')[index], h = cols.col('high')[index], l = cols.col('low')[index], c = cols.col('close')[index], t = cols.col('time')[index];
  return Number.isFinite(o) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c) && Number.isFinite(t) &&
    h >= Math.max(o, c, l) && l <= Math.min(o, c, h) && (index === 0 || t > cols.col('time')[index - 1]);
}

function confirm(cols: ColumnView, setup: Setup, breakoutCloses: number, retestWindow: number, waitBars:number, waitRatio:number): PatternMatch | undefined {
  const { pivots: p, height, tolerance, upper, lower, neckline, radius } = setup;
  const first = p[0].index, last = p.at(-1)!.index, span = last - first;
  const close = cols.col('close'), high = cols.col('high'), low = cols.col('low'), time = cols.col('time');
  const end = cols.length - 1;
  const head = setup.family === 'huzi-head-shoulders' ? p[setup.headAt ?? 2] : undefined;
  // Lines drawn through selected touches let a long spike stab through them; the closes must stay inside.
  const wick = setup.boundary ? Math.max(tolerance * 2, height * WICK_ALLOWANCE) : tolerance * 2;
  const lineFrom = setup.envelopeFrom ?? first, floorSign = setup.direction === 'bearish' ? -1 : 1;
  for (let i = setup.pole?.[0].index ?? first; i <= last; i++) {
    if (!validBar(cols, i)) return;
    // Pivot extraction may deliberately omit an ambiguous outside candle, but
    // its real extrema still belong to the formation. H must represent the
    // dominant extreme between L and R; do not veto later prices or back-fit a
    // neckline restriction across a period when its second point was unknown.
    if (head && (head.kind === 'high' ? high[i] > head.value : low[i] < head.value)) return;
    if (setup.band && i >= first && (setup.band.side > 0 ? close[i] > setup.band.top + tolerance : close[i] < setup.band.bottom - tolerance)) return;
    if (setup.floorAt && i >= first && (floorSign * (close[i] - setup.floorAt(i)) < -tolerance || floorSign * ((floorSign > 0 ? low[i] : high[i]) - setup.floorAt(i)) < -tolerance * 2)) return;
    if (!neckline && i >= lineFrom && (close[i] > at(upper, i) + tolerance || close[i] < at(lower, i) - tolerance || high[i] > at(upper, i) + wick || low[i] < at(lower, i) - wick)) return;
  }
  // Every structural point must already be confirmed when the first counted
  // breakout candle closes. Never borrow E from later data to backdate D's break.
  const start = Math.max(last + radius, setup.availableFrom ?? 0);
  const apex = upper.slope < lower.slope ? (upper.intercept - lower.intercept) / (lower.slope - upper.slope) : Infinity;
  // The waiting budget starts when the structure is knowable. A large radius
  // must not silently consume most of that budget before observation begins.
  const waiting=waitBars>0?waitBars:Math.max(24,Math.ceil(span*waitRatio));
  const deadline = Math.min(end, start + waiting, neckline || setup.family.includes('channel') || setup.family.includes('flag') ? Infinity : Math.ceil(apex));
  let streak = 0, counterStreak = 0, streakDirection: Direction | undefined, preConfirmationBreak: Direction | undefined;
  for (let i = last + 1; i < deadline; i++) {
    if (!validBar(cols, i)) return;
    // Before a classic neckline breakout, a new extreme beyond H replaces the
    // proposed head even when the candle closes back above/below the shoulder.
    // Continuation intentionally waits for a break of H, so its post-R trigger
    // follows its own rule. Historical confirmations are not checked here.
    if (head && !setup.continuation && (head.kind === 'high' ? high[i] > head.value : low[i] < head.value)) return;
    const upperPrice = at(upper, i), lowerPrice = at(lower, i);
    const margin = Math.max(tolerance * .25, Math.abs(close[i]) * 1e-9);
    if (setup.floorAt && floorSign * (close[i] - setup.floorAt(i)) < -tolerance) return;
    let direction: Direction | undefined;
    if (neckline) {
      const sign = setup.direction === 'bullish' ? 1 : -1;
      if (setup.continuation) {
        // Continuation is a deliberately conservative subset: crossing a
        // shoulder is insufficient; the full head extreme must be reclaimed.
        // A previously established traditional neckline break is terminal and
        // cannot be relabelled continuation after the market later reverses.
        counterStreak = sign * (close[i] - at(neckline, i)) < -margin ? counterStreak + 1 : 0;
        if (counterStreak >= breakoutCloses) return;
        if (sign * (close[i] - p[setup.headAt ?? 2].value) > margin) direction = setup.direction;
      } else {
        const stop = setup.stop ?? (setup.family === 'huzi-double' ? (sign > 0 ? Math.min(p[0].value, p[2].value) : Math.max(p[0].value, p[2].value)) : p.at(-1)!.value);
        if (sign * (close[i] - stop) < -tolerance) return;
        if (sign * (close[i] - at(neckline, i)) > margin) direction = setup.direction;
      }
    } else {
      if (upperPrice <= lowerPrice) return;
      if (close[i] > upperPrice + margin) direction = 'bullish';
      else if (close[i] < lowerPrice - margin) direction = 'bearish';
    }
    if (i < start) {
      // A structure not yet knowable cannot survive an earlier break-and-return
      // and then be recycled as a fresh second breakout much later.
      if (direction) {
        if (preConfirmationBreak && preConfirmationBreak !== direction) return;
        preConfirmationBreak = direction;
      } else if (preConfirmationBreak) return;
      continue;
    }
    if (preConfirmationBreak && direction !== preConfirmationBreak) return;
    preConfirmationBreak = undefined;
    if (!direction) { streak = 0; streakDirection = undefined; continue; }
    streak = direction === streakDirection ? streak + 1 : 1; streakDirection = direction;
    if (streak < breakoutCloses) continue;
    if (!Number.isFinite(time[i + 1]) || time[i + 1] <= time[i]) return;
    const bullish = direction === 'bullish', sign = bullish ? 1 : -1;
    const breakLine = setup.continuation ? horizontal(p[setup.headAt ?? 2].value) : neckline ?? (bullish ? upper : lower), boundary = at(breakLine, i);
    const stop = setup.stop ?? (setup.family === 'huzi-double' ? (bullish ? Math.min(p[0].value, p[2].value) : Math.max(p[0].value, p[2].value)) : p.at(-1)!.value);
    const invalidation = setup.continuation ? at(neckline!, i) - sign * tolerance : setup.floorAt ? setup.floorAt(i) - sign * tolerance : neckline ? stop - sign * tolerance : bullish ? lowerPrice - tolerance : upperPrice + tolerance;
    const family = setup.family === 'huzi-flag' && (direction !== setup.poleDirection || (setup.flagExpiresAt !== undefined && setup.flagExpiresAt <= time[i + 1])) ? 'huzi-channel' : setup.family;
    const name = family !== setup.family ? (upper.slope + lower.slope > 0 ? '上升通道' : '下降通道') : setup.name;
    const events: PatternEvent[] = [{ kind: 'breakout', time: time[i], knownAt: time[i + 1], value: close[i], boundary }];
    let stage: PatternStage = 'breakout', invalidatedAt: number | undefined, dataInterrupted = false;
    const finiteEnvelope = !neckline && family !== 'huzi-channel' && family !== 'huzi-flag';
    const lifecycleEnd = Math.min(i + retestWindow, finiteEnvelope ? Math.ceil(apex) - 1 : Infinity);
    let departed = bullish ? low[i] > boundary + tolerance : high[i] < boundary - tolerance;
    let guideEnd = i;
    for (let j = i + 1; j < end; j++) {
      if (!validBar(cols, j) || !Number.isFinite(time[j + 1]) || time[j + 1] <= time[j]) { dataInterrupted = true; break; }
      // Test the ORIGINAL fitted line at this candle, never a horizontal
      // approximation. Once a contraction reaches its apex it no longer has
      // a valid inside/outside region; only the fixed risk level survives.
      const currentBoundary = at(breakLine, j);
      const distance = sign * (close[j] - currentBoundary);
      if (sign * (close[j] - invalidation) < 0) {
        invalidatedAt = time[j + 1]; stage = 'invalidated';
        events.push({ kind: 'invalidation', time: time[j], knownAt: time[j + 1], value: close[j], boundary: invalidation }); break;
      }
      if (j > lifecycleEnd) continue;
      if (stage !== 'failed-breakout' && distance < -tolerance) {
        stage = 'failed-breakout'; guideEnd = j; events.push({ kind: 'failed-breakout', time: time[j], knownAt: time[j + 1], value: close[j], boundary: currentBoundary });
      } else if (stage === 'breakout' && departed && distance >= margin &&
        (bullish ? low[j] <= currentBoundary + tolerance : high[j] >= currentBoundary - tolerance)) {
        stage = 'retest'; guideEnd = j; events.push({ kind: 'retest', time: time[j], knownAt: time[j + 1], value: close[j], boundary: currentBoundary });
      }
      if (bullish ? low[j] > currentBoundary + tolerance : high[j] < currentBoundary - tolerance) departed = true;
    }
    const guide = (role: PatternGuide['role'], line: Line): PatternGuide => ({ role, points: [
      { label: role, time: time[lineFrom], value: at(line, lineFrom) }, { label: role, time: time[guideEnd], value: at(line, guideEnd) },
    ] });
    const guides: PatternGuide[] = neckline ? [guide('neckline', neckline)] : [guide('upper', upper), guide('lower', lower)];
    if (setup.band) guides.push(guide('upper', horizontal(setup.band.top)), guide('lower', horizontal(setup.band.bottom)));
    if (setup.curve) {
      // The curve is sampled bar by bar over the bars it was fitted on; it never projects past known data.
      const { at: curveAt, from, to } = setup.curve, steps = Math.min(40, Math.max(2, to - from)), path: PatternPoint[] = [];
      for (let k = 0; k <= steps; k++) {
        const index = Math.round(from + (to - from) * k / steps);
        if (path.length && path.at(-1)!.time === time[index]) continue;
        path.push({ label: 'curve', time: time[index], value: curveAt(index) });
      }
      if (path.length >= 2 && path.every(point => Number.isFinite(point.value))) guides.push({ role: 'curve', points: [path[0], path.at(-1)!], path });
    }
    if (setup.continuation) guides.push(guide(bullish ? 'upper' : 'lower', breakLine));
    if (setup.pole && family === 'huzi-flag') guides.push({ role: 'pole', points: setup.pole.map(point => ({ label: '旗杆', time: point.time, value: point.value })) as PatternGuide['points'] });
    const labels = setup.labels ?? p.map((_, index) => String.fromCharCode(65 + index));
    const context = (!neckline && (family === 'huzi-triangle' || family === 'huzi-wedge' || family === 'huzi-channel') || family === 'huzi-zone') ? trendContext(close, first, span, height, direction) : undefined;
    return {
      // A zone can end either way on the same anchors (through the band, or back through the pullback low): one id each.
      id: `${family}:${p.map(point => point.time).join(':')}${setup.continuation ? ':continuation' : ''}${family === 'huzi-zone' ? `:${direction}` : ''}`,
      family, name, direction,ruleVersion:'huzi/2.0-explicit-time',
      points: p.map((point, index) => ({ label: labels[index], time: point.time, value: point.value })),
      confirmedAt: time[i + 1], zone: { low: boundary - tolerance, high: boundary + tolerance },
      invalidation, targets: [boundary + sign * (family === 'huzi-flag' ? setup.poleHeight! : height)],
      ratios: context ? [...setup.ratios, { label: '先行走势 / 结构高度', value: context.ratio, expected: '≥ 0.500 才判定中继 / 反转' }] : setup.ratios,
      ...(context ? { context: { kind: context.kind, ratio: context.ratio } } : {}),
      description: `胡子图表结构 · ${radius} 根右侧收盘确认拐点，连续 ${breakoutCloses} 根收盘${bullish ? '向上' : '向下'}突破${setup.continuation ? '头部极值（中继的保守工程子集）' : neckline ? '颈线' : '实际拟合边界'}。全部锚点可知后，最多等待 ${waiting} 柱破位（${waitBars>0?'显式窗口':`自动 max(24, 结构跨度×${waitRatio})`}）。突破价带固定保留；脱离边界后在 ${retestWindow} 柱内按原拟合线观察回踩${finiteEnvelope ? '，至收敛顶点前停止结构观察' : ''}。收盘回入结构记突破回落，越${setup.continuation ? '原颈线' : setup.floorAt ? '加速曲线' : neckline ? '极值' : '对侧边界'}才失效。目标按${family === 'huzi-flag' ? '旗杆' : '结构'}高度投射；几何阈值为工程解释；容差、确认柱数与窗口可调，未使用成交量或未平仓量确认。${[
        ...(context ? [`先行走势${context.approach === 'bullish' ? '上行' : '下行'}，向${bullish ? '上' : '下'}突破，判为${context.kind === 'continuation' ? '中继' : '反转'}。`] : []),
        ...(setup.formation === 'early' ? ['四点提前突破（无 E 点），未等待第五触点。'] : p.length > 5 && !setup.notes?.length ? [`${p.length} 个连续边界触点。`] : []),
        ...(setup.boundary ? ['边界取自贴边触点并包住其间价格（不要求内部小拐点落在线上）。'] : []),
        ...(setup.swingRetracement ? [`幅度层级过滤：仅压缩前腿 ${(setup.swingRetracement * 100).toFixed(1)}% 以内且随后已确认延伸的小回撤。`] : []),
        ...(setup.notes ?? []),
        ...(dataInterrupted ? ['后续存在无效行情，生命周期停在缺口之前，不能视为最新状态。'] : []),
      ].join('')}`,
      status: invalidatedAt === undefined ? 'confirmed' : 'invalidated', stage, formation: setup.formation, pivotStrength: radius, guides, events,
      ...(invalidatedAt === undefined ? {} : { invalidatedAt }),
      ...(dataInterrupted ? { dataWarning: '后续行情存在缺口；以下为缺口前的结构状态，暂不判断当前有效性。' } : {}),
    };
  }
}

/** A head-and-shoulders read from shoulders that are structures of their own (huzi-shoulders.ts). The classic
 * template always has five anchors; when both read the same move at the same time, the classic one is kept. */
const extendedShoulders = (match: PatternMatch) => match.family === 'huzi-head-shoulders' && match.points.length !== 5;

function sameMove(a: PatternMatch, b: PatternMatch, interval: number): boolean {
  // A rounded base and the same base with a handle are one move (the handle version is listed first, see below).
  const kin = (family: string) => family === 'huzi-arc' ? 'huzi-cup' : family;
  if (kin(a.family) !== kin(b.family) || a.direction !== b.direction) return false;
  // The trough of a flat-bottomed base wobbles between scales and the right rim between two equal highs; the same
  // left rim, a right rim within a tenth of the width and the same breakout are the same base.
  if (kin(a.family) === 'huzi-cup') return a.points[0].time === b.points[0].time &&
    Math.abs(a.points[2].time - b.points[2].time) <= (a.points[2].time - a.points[0].time) * .1 &&
    Math.abs(a.confirmedAt - b.confirmedAt) <= interval * Math.max(a.pivotStrength ?? 1, b.pivotStrength ?? 1) * 3;
  const common = a.points.filter(point => b.points.some(candidate => candidate.time === point.time)).length;
  if (common < Math.min(3, a.points.length) || common / Math.min(a.points.length, b.points.length) < .6) return false;
  return Math.abs(a.confirmedAt - b.confirmedAt) <= interval * Math.max(a.pivotStrength ?? 1, b.pivotStrength ?? 1) * 3;
}

/** Bounded, causal interpretation of the supplied Huzi learning journals.
 * Confirmation is a chart observation; it never submits a trading order. */
export function detectHuzi(input: ColumnView, params: ParamValues): PatternMatch[] {
  // Share the closed-prefix adapter with harmonics: explicit closedLength can
  // hide later source candles, or require a timestamp-only close sentinel.
  input = harmonicView(input);
  if (input.length < 16) return [];
  const radius = Math.round(bounded(params.pivotStrength, 3, 1, 30));
  const lookback = Math.round(bounded(params.lookback, 1500, 50, 10000));
  const tolerance = bounded(params.tolerance, .04, .005, .2);
  const maximum = Math.round(bounded(params.maxPatterns, 12, 1, 1000));
  const breakoutCloses = Math.round(bounded(params.breakoutCloses, 1, 1, 3));
  const retestWindow = Math.round(bounded(params.retestWindow, 30, 1, 200));
  const minDoubleSpan=Math.round(bounded(params.minDoubleSpan,6,4,200)),minDoubleLeg=Math.round(bounded(params.minDoubleLeg,2,1,100));
  const waitBars=Math.round(bounded(params.breakoutWaitBars,0,0,2000)),waitRatio=bounded(params.breakoutWaitRatio,2,.5,6);
  const family = params.family ?? '全部';
  // Zones, rounded bases, acceleration curves and shoulder composites; the classic families above are unaffected.
  const extraStructures = params.extraStructures !== false;
  const flagPoleRatio = bounded(params.flagPoleRatio, FLAG_POLE_RATIO, .5, 6);
  // Slicing gives all loops a hard bound even on the million-bar mock feed.
  const offset = Math.max(0, input.length - lookback - 62);
  const columns = { time: input.col('time').subarray(offset, input.length), open: input.col('open').subarray(offset, input.length), high: input.col('high').subarray(offset, input.length), low: input.col('low').subarray(offset, input.length), close: input.col('close').subarray(offset, input.length), volume: input.col('volume').subarray(offset, input.length) };
  const cols: ColumnView = { length: input.length - offset, col: name => columns[name] };
  const found = new Map<string, PatternMatch>();
  // Bars between a structure's first and last anchor, kept beside the match for the minimum-size filter.
  const spans = new Map<string, number>();
  const remember = (match: PatternMatch, setup: Setup) => spans.set(match.id, setup.pivots.at(-1)!.index - setup.pivots[0].index);
  const minStructureBars = Math.round(bounded(params.minStructureBars, 0, 0, 2000));
  const earlyMinBars = Math.round(bounded(params.earlyMinBars, 0, 0, 2000));
  // The reference structures span ~50–330 bars; scales up to 32× the base radius reach them.
  const largeScales = params.largeScales !== false;
  const strengths = params.multiScale === false ? [radius] : [...new Set([radius,...(params.includeFinerScale===true?[Math.max(1,Math.floor(radius/2))]:[]),Math.min(30,radius*2),Math.min(30,radius*4),Math.min(30,radius*8),
    ...(largeScales ? [Math.min(BOUNDARY_MAX_RADIUS, radius * 16), Math.min(BOUNDARY_MAX_RADIUS, radius * 32)] : [])])];
  for (const strength of strengths) {
    const levels = (params.structuralSwings === false ? [0] : [0, .236, .382]).map(retracement => ({ retracement, stack: [] as Pivot[] }));
    const evaluated = new Set<string>();
    const pivotEvents = confirmedPivotEvents(cols, strength, lookback, BOUNDARY_MAX_RADIUS);
    for (let eventIndex = 0; eventIndex < pivotEvents.length; eventIndex++) {
      const event = pivotEvents[eventIndex];
      for (const { retracement, stack } of levels) {
        if (!appendHuziSwing(stack, event, retracement)) continue;
        const setups: Array<Setup | undefined> = [];
        if (stack.length >= 3 && (family === '全部' || family === '双底 / 双顶')) setups.push(doubleTurn(stack.slice(-3), strength, tolerance,minDoubleSpan,minDoubleLeg));
        if (stack.length >= 5 && (family === '全部' || family === '头肩形')) {
          const head = headShoulders(stack.slice(-5), strength, tolerance);
          if (head) {
            setups.push(head);
            setups.push({ ...head, continuation: true, direction: head.direction === 'bullish' ? 'bearish' : 'bullish',
              name: head.direction === 'bullish' ? '头肩中继下破' : '头肩中继上破' });
          }
        }
        if (family === '全部' || family === '三角形' || family === '楔形' || family === '通道 / 旗形') {
          for (const size of params.allowEarly === true ? [5, 7, 9, 4] : [5, 7, 9]) {
            if (stack.length < size) continue;
            const structure = envelope(stack.slice(-size), strength, tolerance, stack.at(-size - 1), flagPoleRatio);
            if (structure && (family === '全部' || family === '三角形' && structure.family === 'huzi-triangle' || family === '楔形' && structure.family === 'huzi-wedge' || family === '通道 / 旗形' && ['huzi-channel', 'huzi-flag'].includes(structure.family))) setups.push(structure);
          }
        }
        if (extraStructures) {
          const price = { open: cols.col('open'), high: cols.col('high'), low: cols.col('low'), close: cols.col('close') };
          if (family === '全部' || family === '画门 / 水平带') setups.push(...zoneSetups(stack, strength, tolerance, price));
          if (family === '全部' || family === '杯柄 / 圆弧') setups.push(...cupSetups(stack, strength, tolerance, price));
          if (family === '全部' || family === '头肩形') setups.push(...shoulderSetups(stack, strength, tolerance, price));
        }
        for (const setup of setups) {
          if (!setup) continue;
          const key = `${setup.family}:${setup.pivots.map(point => point.index).join(':')}:${Boolean(setup.continuation)}${setup.family === 'huzi-zone' ? `:${setup.direction}` : ''}`;
          if (evaluated.has(key)) continue;
          evaluated.add(key);
          setup.availableFrom = event.index + strength;
          if (retracement) setup.swingRetracement = retracement;
          if (setup.family === 'huzi-flag') {
            const after = [setup.pivots.at(-1)!];
            for (const later of pivotEvents.slice(eventIndex + 1)) {
              appendPivot(after, later);
              if (after.length >= 3) { setup.flagExpiresAt = later.confirmedAt; break; }
            }
          }
          const match = confirm(cols, setup, breakoutCloses, retestWindow,waitBars,waitRatio);
          if (!match) continue;
          const existing = found.get(match.id);
          if (!existing || match.confirmedAt < existing.confirmedAt) { found.set(match.id, match); remember(match, setup); }
        }
      }
    }
  }
  // Boundary search: pick the touches that lie ON each boundary and require the lines to contain the price,
  // as a person draws it. Larger scales matter here: the reference structures span ~70–260 bars.
  const boundaryOn = params.boundarySearch !== false && (family === '全部' || family === '三角形' || family === '楔形' || family === '通道 / 旗形');
  const accelerationOn = extraStructures && (family === '全部' || family === '通道加速');
  if (boundaryOn || accelerationOn) {
    const open = cols.col('open'), high = cols.col('high'), low = cols.col('low'), close = cols.col('close');
    const ladder = params.multiScale === false ? [radius] : [...new Set([radius, radius * 2, radius * 4, radius * 8, radius * 16, radius * 32].map(value => Math.min(BOUNDARY_MAX_RADIUS, value)))];
    for (const strength of ladder) {
      const events = confirmedPivotEvents(cols, strength, lookback, BOUNDARY_MAX_RADIUS);
      if (events.length < 5) continue;
      const highs: Pivot[] = [], lows: Pivot[] = [], evaluated = new Set<string>();
      const maxSpan = Math.min(600, Math.max(120, strength * 60)), minSpan = Math.max(18, strength * 6);
      for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
        const event = events[eventIndex];
        (event.kind === 'high' ? highs : lows).push(event);
        const horizon = Math.min(cols.length - 2, event.index + strength);
        if (accelerationOn) {
          for (const setup of accelSetups(highs, lows, event, { open, high, low, close, horizon, tolerance, radius: strength, minSpan, maxSpan })) {
            const key = `${setup.family}:${setup.pivots.map(point => point.index).join(':')}`;
            if (evaluated.has(key)) continue;
            evaluated.add(key);
            setup.availableFrom = event.index + strength;
            const match = confirm(cols, setup, breakoutCloses, retestWindow, waitBars, waitRatio);
            if (!match) continue;
            const existing = found.get(match.id);
            if (!existing || match.confirmedAt < existing.confirmedAt) { found.set(match.id, match); remember(match, setup); }
          }
        }
        for (const minTouches of boundaryOn && params.allowEarly === true ? [5, 4] : boundaryOn ? [5] : []) {
          const context: BoundaryContext = { open, high, low, close, horizon, tolerance, radius: strength, minTouches, minSpan, maxSpan };
          for (const envelope of boundaryEnvelopes(highs, lows, event, context)) {
            if (family === '三角形' && envelope.family !== 'huzi-triangle' || family === '楔形' && envelope.family !== 'huzi-wedge' || family === '通道 / 旗形' && envelope.family !== 'huzi-channel') continue;
            const key = `${envelope.family}:${envelope.pivots.map(point => point.index).join(':')}`;
            if (evaluated.has(key)) continue;
            evaluated.add(key);
            const setup: Setup = { pivots: envelope.pivots, family: envelope.family, name: envelope.name, height: envelope.height, tolerance: envelope.height * tolerance,
              upper: envelope.upper, lower: envelope.lower, radius: strength, boundary: true, availableFrom: event.index + strength,
              formation: envelope.pivots.length === 4 ? 'early' : 'complete',
              ratios: [{ label: '末端 / 初始宽度', value: envelope.ratio, expected: envelope.family === 'huzi-channel' ? '0.75–1.25' : '0.10–0.88' },
                { label: '上 / 下边界触点', value: envelope.upperTouches + envelope.lowerTouches, expected: `≥ ${minTouches}` }] };
            // Like the zig-zag path, only a compact five-touch consolidation can be a flag: longer ones have consumed the pole.
            if (envelope.family === 'huzi-channel' && envelope.pivots.length === 5) {
              boundaryFlag(setup, highs, lows, high, low, close, tolerance, flagPoleRatio);
              if (setup.family === 'huzi-flag') {
                // A flag that has not broken out after three further swings is a channel (same rule as the zig-zag path).
                const after = [setup.pivots.at(-1)!];
                for (const later of events.slice(eventIndex + 1)) { appendPivot(after, later); if (after.length >= 3) { setup.flagExpiresAt = later.confirmedAt; break; } }
              }
            }
            const match = confirm(cols, setup, breakoutCloses, retestWindow, waitBars, waitRatio);
            if (!match) continue;
            const existing = found.get(match.id);
            if (!existing || match.confirmedAt < existing.confirmedAt) { found.set(match.id, match); remember(match, setup); }
          }
        }
      }
    }
  }
  // Earliest causal recognition wins before newest-first presentation. A wider
  // scale discovered later must not replace a historical confirmation timestamp.
  const rawInterval = cols.length > 2 ? cols.col('time')[cols.length - 2] - cols.col('time')[cols.length - 3] : 1;
  const interval = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 1;
  const unique: PatternMatch[] = [];
  for (const match of [...found.values()].sort((a, b) => a.confirmedAt - b.confirmedAt || Number(extendedShoulders(a)) - Number(extendedShoulders(b)) || (a.pivotStrength ?? 0) - (b.pivotStrength ?? 0) || Number(b.family === 'huzi-cup') - Number(a.family === 'huzi-cup'))) {
    const span = spans.get(match.id) ?? Infinity;
    if (span < minStructureBars || match.formation === 'early' && span < earlyMinBars) continue;
    if (!unique.some(other => sameMove(other, match, interval))) unique.push(match);
  }
  return unique.map(match=>resolvePatternLifecycle(match,cols)).filter(match => match.status !== 'invalidated' || params.showInvalidated === true)
    .sort((a, b) => b.confirmedAt - a.confirmedAt || a.id.localeCompare(b.id)).slice(0, maximum);
}
