import type { ColumnName, ColumnView, ParamValues } from '../core/types';
import type { PatternCandidate, PatternMatch } from './types';
import { appendPivot, confirmedPivotEvents, type Pivot } from './pivots';
import { boundaryEnvelopes } from './huzi-boundary';

type Line = { slope: number; origin: number; value: number };
const bounded = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const valueAt = (line: Line, index: number) => line.value + line.slope * (index - line.origin);
const boundary = (points: Pivot[]): Line => ({
  origin: points[0].index, value: points[0].value,
  slope: (points.at(-1)!.value - points[0].value) / (points.at(-1)!.index - points[0].index),
});
const columns: ColumnName[] = ['time', 'open', 'high', 'low', 'close', 'volume'];

/** Observation-only engineering subset of the Huzi structure atlas. Two straight
 * boundary lines describe the latest 4/5/7 alternating contacts; there is no
 * guessed breakout direction, flag claim, trade target or historical signal.
 * Work is bounded to 600 closed candles plus pivot warmup, even on long feeds. */
export function detectHuziCandidates(input: ColumnView, params: ParamValues, confirmed: readonly PatternMatch[]): PatternCandidate[] {
  const closed = Math.max(0, Math.min(input.length, input.closedLength ?? input.length - 1));
  if (closed < 12) return [];
  const family = String(params.family ?? '全部');
  if (!['全部', '三角形', '楔形', '通道 / 旗形'].includes(family)) return [];
  const radius = Math.round(bounded(params.pivotStrength, 3, 1, 30));
  const strengths = params.multiScale === false ? [radius] : [...new Set([radius, Math.min(30, radius * 2), Math.min(30, radius * 4)])];
  const depth = Math.round(bounded(params.lookback, 600, 50, 600));
  const offset = Math.max(0, closed - depth - 2 * Math.max(...strengths));
  const actualEnd = Math.min(input.length, closed + 1), length = closed - offset + 1;
  const data = Object.fromEntries(columns.map(name => [name, input.col(name).subarray(offset, actualEnd)])) as Record<ColumnName, Float64Array>;
  const lastClosed = closed - offset - 1;
  // A closing exchange packet may have no next candle yet. Only the time
  // sentinel is synthetic; it establishes when the last pivot became knowable.
  if (closed === input.length) {
    const times = new Float64Array(length); times.set(data.time);
    const interval = times[lastClosed] - times[lastClosed - 1];
    if (!Number.isFinite(interval) || interval <= 0) return [];
    times[length - 1] = times[lastClosed] + interval;
    data.time = times;
  }
  const cols: ColumnView = { length, col: name => data[name] };
  let tail = Math.min(actualEnd - offset - 1, length - 1);
  // The registry also supplies a time-only closing sentinel. It is not a price
  // observation; preserve the actual last closed OHLC as the evaluation bar.
  if (['open', 'high', 'low', 'close', 'volume'].every(name => Number.isNaN(data[name as ColumnName][tail]))) tail--;
  const tolerance = bounded(params.tolerance, .04, .005, .15);
  const limit = Math.round(bounded(params.maxCandidates, 3, 1, 4));
  const minBars = Math.round(bounded(params.minStructureBars, 0, 0, 2000));
  const found: PatternCandidate[] = [];

  for (const strength of strengths) {
    const pivots: Pivot[] = [];
    for (const pivot of confirmedPivotEvents(cols, strength, depth)) {
      appendPivot(pivots, pivot);
      if (pivots.length > 7) pivots.splice(0, pivots.length - 7);
    }
    // Prefer the fuller structure; the four-contact alternative is explicitly
    // an early framework and cannot acquire a missing fifth point from a quote.
    for (const count of [7, 5, 4]) {
      if (pivots.length < count) continue;
      const points = pivots.slice(-count), first = points[0], last = points.at(-1)!;
      const span = last.index - first.index;
      if (span < Math.max(9, strength * 4, minBars) || tail - last.index > Math.min(120, Math.max(12, span / 2, strength * 3))) continue;
      const highs = points.filter(p => p.kind === 'high'), lows = points.filter(p => p.kind === 'low');
      if (highs.length < 2 || lows.length < 2) continue;
      const upper = boundary(highs), lower = boundary(lows);
      const height = Math.max(...points.map(p => p.value)) - Math.min(...points.map(p => p.value));
      const width = (index: number) => valueAt(upper, index) - valueAt(lower, index);
      const initialWidth = width(first.index), terminalWidth = width(last.index);
      if (height <= 0 || initialWidth <= 0 || terminalWidth <= 0 || width(tail) <= initialWidth * .08) continue;
      const slack = height * tolerance;
      if (points.some(p => Math.abs(p.value - valueAt(p.kind === 'high' ? upper : lower, p.index)) > slack)) continue;
      const ratio = terminalWidth / initialWidth;
      const top = upper.slope * span / height, bottom = lower.slope * span / height;
      const flat = Math.max(.06, tolerance * 2);
      let name: string, id: string, group: string;
      if (ratio >= .75 && ratio <= 1.25 && Math.abs(top - bottom) <= .12) {
        id = 'huzi-channel'; group = '通道 / 旗形';
        name = Math.abs(top + bottom) / 2 <= flat ? '水平通道' : top + bottom > 0 ? '上升通道' : '下降通道';
      } else if (ratio >= .1 && ratio <= .88) {
        if (Math.abs(top) <= flat && bottom > Math.max(.12, flat)) { name = '上升三角形'; id = 'huzi-triangle'; group = '三角形'; }
        else if (Math.abs(bottom) <= flat && top < -Math.max(.12, flat)) { name = '下降三角形'; id = 'huzi-triangle'; group = '三角形'; }
        else if (top < -flat && bottom > flat) { name = '对称三角形'; id = 'huzi-triangle'; group = '三角形'; }
        else if (top > flat && bottom > top + .12) { name = '上升楔形'; id = 'huzi-wedge'; group = '楔形'; }
        else if (bottom < -flat && top < bottom - .12) { name = '下降楔形'; id = 'huzi-wedge'; group = '楔形'; }
        else continue;
      } else continue;
      if (family !== '全部' && family !== group) continue;

      let intact = true;
      for (let i = first.index; i <= tail; i++) {
        const { open: o, high: h, low: l, close: c, time: t } = data;
        if (![o[i], h[i], l[i], c[i], t[i]].every(Number.isFinite) ||
          h[i] < Math.max(o[i], c[i], l[i]) || l[i] > Math.min(o[i], c[i]) ||
          i > first.index && t[i] <= t[i - 1] ||
          h[i] > valueAt(upper, i) + slack || l[i] < valueAt(lower, i) - slack) { intact = false; break; }
      }
      if (!intact) continue;
      const overlaps = (other: { family: string; points: readonly { time: number }[] }) => {
        if (other.family !== id) return false;
        const common = points.filter(p => other.points.some(q => q.time === p.time)).length;
        return common >= 3 && common / Math.min(points.length, other.points.length) >= .75;
      };
      if (confirmed.some(overlaps) || found.some(overlaps)) continue;
      found.push({
        id: `${id}:candidate:${points.map(p => p.time).join(':')}`, family: id, name,
        direction: 'neutral', availableAt: last.confirmedAt, observedAt: data.time[tail], pivotStrength: strength,
        points: points.map((p, i) => ({ label: String.fromCharCode(65 + i), time: p.time, value: p.value })),
        guides: [
          { role: 'upper', points: [{ label: '', time: data.time[first.index], value: valueAt(upper, first.index) }, { label: '', time: data.time[tail], value: valueAt(upper, tail) }] },
          { role: 'lower', points: [{ label: '', time: data.time[first.index], value: valueAt(lower, first.index) }, { label: '', time: data.time[tail], value: valueAt(lower, tail) }] },
        ],
        zone: { low: valueAt(lower, tail), high: valueAt(upper, tail) },
        ratios: [{ label: '末端 / 初始宽度', value: ratio, expected: id === 'huzi-channel' ? '0.75–1.25' : '0.10–0.88' }],
        description: `${count} 个已确认边界触点${count === 4 ? '，早期框架，尚无 E 点' : ''}；方向中性，观察收盘如何离开框架，未确认突破或交易信号。${strength} 根右侧收盘确认拐点；上下界由同侧首末触点确定，逐柱校验包含形成中的最新报价。当前越界、等待过久或逼近收敛顶点时撤下观察。此为原作者图解的有限几何工程子集；通道不自动命名为旗形，未使用 OI 或成交量确认。`,
      });
    }
  }
  if (params.boundarySearch !== false) found.push(...boundaryCandidates(data, tail, strengthLadder(params, radius), depth, tolerance, family, params, confirmed, found));
  return found.sort((a, b) => b.observedAt - a.observedAt || b.points.length - a.points.length || a.id.localeCompare(b.id)).slice(0, limit);
}

const BOUNDARY_MAX_RADIUS = 120;
/** Scales for the boundary search: the reference structures span ~50–330 bars, so the ladder reaches 32× the base radius. */
function strengthLadder(params: ParamValues, radius: number): number[] {
  if (params.multiScale === false) return [radius];
  const factors = params.largeScales === false ? [1, 2, 4, 8] : [1, 2, 4, 8, 16, 32];
  return [...new Set(factors.map(factor => Math.min(BOUNDARY_MAX_RADIUS, radius * factor)))];
}

/** Forming structures found the way a person draws them: touches on two boundary lines that contain the price
 * so far, no breakout yet. The newest confirmed pivots (either side) are tried as the latest touch. */
function boundaryCandidates(data: Record<ColumnName, Float64Array>, tail: number, ladder: number[], depth: number, tolerance: number,
  family: string, params: ParamValues, confirmed: readonly PatternMatch[], existing: readonly PatternCandidate[]): PatternCandidate[] {
  const minBars = Math.round(bounded(params.minStructureBars, 0, 0, 2000));
  const out: PatternCandidate[] = [];
  const cols: ColumnView = { length: tail + 1, col: name => data[name] };
  for (const strength of ladder) {
    const events = confirmedPivotEvents(cols, strength, depth, BOUNDARY_MAX_RADIUS);
    if (events.length < 5) continue;
    const highs: Pivot[] = [], lows: Pivot[] = [];
    for (let index = 0; index < events.length; index++) (events[index].kind === 'high' ? highs : lows).push(events[index]);
    const maxSpan = Math.min(600, Math.max(120, strength * 60)), minSpan = Math.max(18, strength * 6, minBars);
    // Any of the last two pivots may be the latest touch (the very last can be a wiggle beyond the boundary).
    for (const end of events.slice(-2)) {
      const upto = (list: Pivot[]) => list.filter(pivot => pivot.index <= end.index);
      for (const minTouches of [5, 4]) {
        for (const envelope of boundaryEnvelopes(upto(highs), upto(lows), end, { open: data.open, high: data.high, low: data.low, close: data.close, horizon: tail, checkTo: tail, tolerance, radius: strength, minTouches, minSpan, maxSpan })) {
          const group = envelope.family === 'huzi-triangle' ? '三角形' : envelope.family === 'huzi-wedge' ? '楔形' : '通道 / 旗形';
          if (family !== '全部' && family !== group) continue;
          const first = envelope.pivots[0], last = envelope.pivots.at(-1)!, span = last.index - first.index;
          if (tail - last.index > Math.min(120, Math.max(12, span / 2, strength * 3))) continue;
          // A malformed or non-increasing candle anywhere in the structure, including the live one, rejects it:
          // comparisons with NaN would otherwise read as "inside the lines".
          let sound = true;
          for (let i = first.index; i <= tail && sound; i++) {
            const { open: o, high: h, low: l, close: c, time: t } = data;
            sound = [o[i], h[i], l[i], c[i], t[i]].every(Number.isFinite) && h[i] >= Math.max(o[i], c[i], l[i]) && l[i] <= Math.min(o[i], c[i], h[i]) && (i === first.index || t[i] > t[i - 1]);
          }
          if (!sound) continue;
          const widthAt = (index: number) => envelope.upper.slope * index + envelope.upper.intercept - (envelope.lower.slope * index + envelope.lower.intercept);
          if (widthAt(tail) <= widthAt(first.index) * .08) continue;
          const points = envelope.pivots;
          const overlaps = (other: { family: string; points: readonly { time: number }[] }) => {
            if (other.family !== envelope.family) return false;
            const common = points.filter(p => other.points.some(q => q.time === p.time)).length;
            return common >= 3 && common / Math.min(points.length, other.points.length) >= .75;
          };
          if (confirmed.some(overlaps) || existing.some(overlaps) || out.some(overlaps)) continue;
          const at = (line: { slope: number; intercept: number }, index: number) => line.slope * index + line.intercept;
          out.push({
            id: `${envelope.family}:candidate:${points.map(p => p.time).join(':')}`, family: envelope.family, name: envelope.name,
            direction: 'neutral', availableAt: last.confirmedAt, observedAt: data.time[tail], pivotStrength: strength,
            points: points.map((p, i) => ({ label: String.fromCharCode(65 + i), time: p.time, value: p.value })),
            guides: [
              { role: 'upper', points: [{ label: '', time: data.time[first.index], value: at(envelope.upper, first.index) }, { label: '', time: data.time[tail], value: at(envelope.upper, tail) }] },
              { role: 'lower', points: [{ label: '', time: data.time[first.index], value: at(envelope.lower, first.index) }, { label: '', time: data.time[tail], value: at(envelope.lower, tail) }] },
            ],
            zone: { low: at(envelope.lower, tail), high: at(envelope.upper, tail) },
            ratios: [{ label: '末端 / 初始宽度', value: envelope.ratio, expected: envelope.family === 'huzi-channel' ? '0.75–1.25' : '0.10–0.88' },
              { label: '上 / 下边界触点', value: envelope.upperTouches + envelope.lowerTouches, expected: `≥ ${minTouches}` }],
            description: `${points.length} 个边界触点${points.length === 4 ? '，早期框架，尚无 E 点' : ''}；方向中性，观察收盘如何离开框架，未确认突破或交易信号。${strength} 根右侧收盘确认拐点；边界取自贴边触点并包住其间价格，逐柱校验包含形成中的最新报价。当前越界、等待过久或逼近收敛顶点时撤下观察。此为原作者图解的有限几何工程子集；通道不自动命名为旗形，未使用 OI 或成交量确认。`,
          });
        }
      }
    }
  }
  return out;
}
