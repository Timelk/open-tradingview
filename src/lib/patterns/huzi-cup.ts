import type {Pivot} from './pivots';
import type {Line, Setup} from './huzi';
import {fitQuadratic, type PriceColumns} from './huzi-fit';

/**
 * Rounded bases: cup and handle, and the bare rounded bottom / top ("圆弧").
 *
 * Sources (the engineering thresholds below are OURS, not the authors'; none is a published constant):
 * - William O'Neil, "How to Make Money in Stocks" (1988): a U-shaped cup (not a V), the right rim recovering
 *   most of the way back to the left rim, a shallow handle (a short pullback in the upper half of the cup) and a
 *   buy on a close above the handle; the measured move equals the cup's depth. O'Neil quotes depth as a share of
 *   price (12–33 %), which does not transfer to crypto, so depth is judged against the structure's own noise.
 * - StockCharts ChartSchool / LuxAlgo "Rounding Bottom": lows flatten out and then rise, the two sides are similar
 *   in a loose sense, the neckline is the left rim, no handle is required, a V-shaped trough is not a saucer.
 * - The community case log labels these "杯柄", "圆弧", "圆弧底", "小圆弧" (about 9 of 466 posts, structures 116–264 bars).
 *
 * Geometry, on the last confirmed zig-zag pivots [H1, T, H2] (+ [.., h] for the handle); mirrored for a top:
 *   depth D = min(H1, H2) − T;   width = H2.index − H1.index ≥ max(30, 3·radius), ≤ 500 bars
 *   trough T lies in 20–80 % of the width; the rims differ by ≤ 0.25·D (≤ 0.15·D without a handle)
 *   D ≥ 4× the mean candle range inside (so the "cup" is not just noise)
 *   no close above the rim (+ tolerance·D), no wick above it by more than 0.12·D, nothing lower than T − 0.08·D
 *   roundness: parabola through the closes opens the right way, its vertex sits in 15–85 % of the width and it
 *   explains ≥ 75 % of the variance; ≥ 40 % of the closes are in the lowest 30 % of the depth. The variance test
 *   alone cannot tell a parabola from a V (a V scores 0.94 against a parabola), the bowl share can: 0.55
 *   for a parabola, 0.30 for a V or for a W's two sharp dips
 *   handle: a pullback after H2 of 0.1–0.5·D that stays in the upper half of the cup and lasts ≤ half the width.
 * The neckline is the higher rim; a close beyond it is the breakout (see `confirm` in huzi.ts). The stop is the
 * cup's low, or the handle's low for a cup with handle (O'Neil places it under the handle). Target = depth.
 */
export const CUP_MIN_WIDTH = 30;
export const CUP_MAX_WIDTH = 500;
/** A base at least this many pivot radii wide: a pivot needs ±radius quiet bars, so anything narrower is one swing. */
export const CUP_MIN_WIDTH_RADII = 3;
export const CUP_MIN_DEPTH_RANGES = 4;
export const CUP_MIN_R2 = .75;
/** Where the trough and the parabola's vertex may sit across the width: a saucer is only loosely symmetric. */
export const CUP_TROUGH_SPAN = [.2, .8] as const;
export const CUP_VERTEX_SPAN = [.15, .85] as const;
export const CUP_MIN_BOWL = .4;
/** Rim difference limits, in units of the cup depth. */
export const CUP_MAX_RIM_DIFF = .25;
export const ARC_MAX_RIM_DIFF = .15;

/** English text for this module's names, ratios and sentences (aggregated in i18n/messages-huzi-extra.ts). */
export const cupMessages: Record<string, string> = {
  '杯柄': 'Cup and handle', '倒杯柄': 'Inverted cup and handle', '圆弧底': 'Rounded bottom', '圆弧顶': 'Rounded top',
  '杯深 / 区间平均波幅': 'Cup depth / mean candle range',
  '左右沿高差 / 杯深': 'Rim difference / cup depth',
  '杯底位置 / 杯宽': 'Trough position / cup width',
  '抛物线拟合 R²': 'Parabola fit R²',
  '杯内低位收盘占比': 'Share of closes in the lower part of the cup',
  '柄回撤 / 杯深': 'Handle pullback / cup depth',
  '柄宽 / 杯宽': 'Handle width / cup width',
  '杯形取自最近的三个交替拐点，以抛物线拟合收盘价；圆滑度与低位收盘占比用于排除 V 形。':
    'The cup is taken from the last three alternating pivots and a parabola is fitted to the closes; the roundness and the share of low closes rule out a V shape. ',
  '右沿之后的浅回撤为杯柄，停留在杯的上半部分，止损取柄的极值。':
    'The shallow pullback after the right rim is the handle. It stays in the upper half of the cup and the stop is the handle extreme. ',
  '无柄的圆弧：右沿之后直接向颈线推进，止损取杯底极值。':
    'A bare rounded base without a handle: after the right rim the price pushes straight to the neckline and the stop is the extreme of the base. ',
};

const horizontal = (price: number): Line => ({ slope: 0, intercept: price });

interface Geometry {
  sign: 1 | -1; depth: number; width: number; position: number; rimDiff: number; range: number; bowl: number; r2: number;
  /** The higher rim in signed space (the neckline). */rim: number;
  curve: (index: number) => number;
}

/** Everything about a three-pivot base; `undefined` when it is not a round cup. */
function base(a: Pivot, b: Pivot, c: Pivot, radius: number, tolerance: number, price: PriceColumns, handle: boolean): Geometry | undefined {
  const sign: 1 | -1 = a.kind === 'high' ? 1 : -1;
  const width = c.index - a.index;
  if (width < Math.max(CUP_MIN_WIDTH, radius * CUP_MIN_WIDTH_RADII) || width > CUP_MAX_WIDTH) return;
  const sa = sign * a.value, sb = sign * b.value, sc = sign * c.value;
  const rim = Math.max(sa, sc), depth = Math.min(sa, sc) - sb;
  if (!(depth > 0)) return;
  const position = (b.index - a.index) / width;
  if (position < CUP_TROUGH_SPAN[0] || position > CUP_TROUGH_SPAN[1]) return;
  const rimDiff = Math.abs(sa - sc) / depth;
  if (rimDiff > (handle ? CUP_MAX_RIM_DIFF : ARC_MAX_RIM_DIFF)) return;
  const { high, low, close } = price;
  const tol = depth * tolerance, wick = depth * .12, deepest = sb - depth * .08, lowBand = sb + depth * .3;
  let range = 0, inBowl = 0;
  for (let i = a.index; i <= c.index; i++) {
    const h = high[i], l = low[i], k = close[i];
    if (!(Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(k))) return;
    const top = sign > 0 ? h : -l, bottom = sign > 0 ? l : -h, closeSigned = sign * k;
    if (closeSigned > rim + tol || top > rim + wick || bottom < deepest) return;
    range += h - l;
    if (closeSigned <= lowBand) inBowl++;
  }
  const count = width + 1;
  range /= count;
  if (!(range > 0) || depth < CUP_MIN_DEPTH_RANGES * range) return;
  const bowl = inBowl / count;
  if (bowl < CUP_MIN_BOWL) return;
  // Parabola through the (signed) closes: a bowl in signed space for both the cup and the inverted cup.
  const xs: number[] = [], ys: number[] = [];
  for (let i = a.index; i <= c.index; i++) { xs.push(i); ys.push(sign * close[i]); }
  const fit = fitQuadratic(xs, ys);
  if (!fit || !(fit.a > 0) || fit.r2 < CUP_MIN_R2) return;
  const vertex = fit.origin - fit.b / (2 * fit.a);
  if (vertex < a.index + width * CUP_VERTEX_SPAN[0] || vertex > a.index + width * CUP_VERTEX_SPAN[1]) return;
  return { sign, depth, width, position, rimDiff, range, bowl, r2: fit.r2, rim, curve: index => sign * fit.at(index) };
}

/** A pullback after the right rim that a handle may be: shallow, in the upper half of the cup, short, and contained. */
function handleOf(geometry: Geometry, b: Pivot, c: Pivot, d: Pivot, tolerance: number, price: PriceColumns): number | undefined {
  const { sign, depth, width, rim } = geometry;
  const sb = sign * b.value, sc = sign * c.value, sd = sign * d.value;
  const retrace = (sc - sd) / depth, length = d.index - c.index;
  if (retrace < .1 || retrace > .5 || sd < sb + depth * .5 || length < 3 || length > width * .5) return;
  const tol = depth * tolerance, wick = depth * .12;
  for (let i = c.index; i <= d.index; i++) {
    const h = price.high[i], l = price.low[i], k = price.close[i];
    if (!(Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(k))) return;
    // The handle stays under the rim (no breakout yet) and above the cup's floor.
    if (sign * k > rim + tol || (sign > 0 ? h : -l) > rim + wick || (sign > 0 ? l : -h) < sd - wick) return;
  }
  return retrace;
}

function setupOf(pivots: Pivot[], geometry: Geometry, radius: number, tolerance: number, handle?: number): Setup {
  const { sign, depth, width, position, rimDiff, range, bowl, r2 } = geometry;
  const [a, b, c] = pivots, d = pivots[3];
  const bullish = sign > 0;
  const rimPrice = bullish ? Math.max(a.value, c.value) : Math.min(a.value, c.value);
  const neckline = horizontal(rimPrice), floor = horizontal(b.value);
  const name = d ? (bullish ? '杯柄' : '倒杯柄') : (bullish ? '圆弧底' : '圆弧顶');
  const ratios = [
    { label: '杯深 / 区间平均波幅', value: depth / range, expected: `≥ ${CUP_MIN_DEPTH_RANGES.toFixed(3)}` },
    { label: '左右沿高差 / 杯深', value: rimDiff, expected: `≤ ${(d ? CUP_MAX_RIM_DIFF : ARC_MAX_RIM_DIFF).toFixed(3)}` },
    { label: '杯底位置 / 杯宽', value: position, expected: `${CUP_TROUGH_SPAN[0].toFixed(3)}–${CUP_TROUGH_SPAN[1].toFixed(3)}` },
    { label: '抛物线拟合 R²', value: r2, expected: `≥ ${CUP_MIN_R2.toFixed(3)}` },
    { label: '杯内低位收盘占比', value: bowl, expected: `≥ ${CUP_MIN_BOWL.toFixed(3)}` },
  ];
  if (d && handle !== undefined) {
    ratios.push({ label: '柄回撤 / 杯深', value: handle, expected: '0.100–0.500' },
      { label: '柄宽 / 杯宽', value: (d.index - c.index) / width, expected: '≤ 0.500' });
  }
  return {
    pivots, family: d ? 'huzi-cup' : 'huzi-arc', name, height: depth, tolerance: depth * tolerance,
    upper: bullish ? neckline : floor, lower: bullish ? floor : neckline, radius, neckline,
    direction: bullish ? 'bullish' : 'bearish', labels: bullish ? ['H1', 'T', 'H2', 'h'] : ['L1', 'P', 'L2', 'l'],
    formation: 'complete', stop: (d ?? b).value, ratios,
    curve: { at: geometry.curve, from: a.index, to: c.index },
    notes: [d ? '右沿之后的浅回撤为杯柄，停留在杯的上半部分，止损取柄的极值。' : '无柄的圆弧：右沿之后直接向颈线推进，止损取杯底极值。',
      '杯形取自最近的三个交替拐点，以抛物线拟合收盘价；圆滑度与低位收盘占比用于排除 V 形。'],
  };
}

/** Called with the zig-zag stack at every confirmed pivot. A cup with handle is offered when the newest pivot is
 * the handle low; the bare rounded base when it is the right rim. Both share the neckline, so the caller treats a
 * bare base and a cup with handle on the same anchors and the same breakout as one move (see `sameMove`). */
export function cupSetups(stack: Pivot[], radius: number, tolerance: number, price: PriceColumns): Setup[] {
  const out: Setup[] = [];
  const n = stack.length;
  if (n >= 4) {
    const [a, b, c, d] = stack.slice(-4);
    if (a.kind === c.kind && b.kind === d.kind && a.kind !== b.kind && a.index < b.index && b.index < c.index && c.index < d.index) {
      const geometry = base(a, b, c, radius, tolerance, price, true);
      const retrace = geometry && handleOf(geometry, b, c, d, tolerance, price);
      if (geometry && retrace !== undefined) out.push(setupOf([a, b, c, d], geometry, radius, tolerance, retrace));
    }
  }
  if (n >= 3) {
    const [a, b, c] = stack.slice(-3);
    if (a.kind === c.kind && a.kind !== b.kind && a.index < b.index && b.index < c.index) {
      const geometry = base(a, b, c, radius, tolerance, price, false);
      if (geometry) out.push(setupOf([a, b, c], geometry, radius, tolerance));
    }
  }
  return out;
}
