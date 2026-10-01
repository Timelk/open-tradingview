import type {ColumnName, ColumnView, ParamValues} from '../core/types';
import type {Pivot} from './pivots';
import {HARMONIC_RULES as RULES} from './harmonic-rules';
import {harmonicView,harmonicSwings,harmonicIntact,harmonicLegsIntact} from './harmonic-swings';
import {extraHarmonicSetups} from './harmonic-extra';
import type {PatternCandidate, PatternMatch, PatternRatio} from './types';

type Range = readonly [number, number];
type Zone = {low: number; high: number};
type Projection = {anchor: number; leg: number; range: Range};
const number = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
const inside = (v: number, [min, max]: Range, tolerance: number) => Number.isFinite(v) && v >= min * (1 - tolerance) - 1e-10 && v <= max * (1 + tolerance) + 1e-10;
const expected = ([min, max]: Range) => min === max ? min.toFixed(3) : `${min.toFixed(3)}–${max.toFixed(3)}`;
const ratio = (label: string, value: number, range: Range): PatternRatio => ({label, value, expected: expected(range)});

function intersect(projections: Projection[], side: number, tolerance: number): Zone | undefined {
  let low = -Infinity, high = Infinity;
  for (const p of projections) {
    const a = p.anchor - side * p.leg * p.range[0] * (1 - tolerance);
    const b = p.anchor - side * p.leg * p.range[1] * (1 + tolerance);
    low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b));
  }
  return Number.isFinite(low) && Number.isFinite(high) && low < high ? {low, high} : undefined;
}

/** A PRZ must remain on the side where this family's D can exist. */
function clip(zone: Zone, side: number, boundary: number, below: boolean): Zone | undefined {
  const epsilon = Math.max(1e-12, Math.abs(boundary) * 1e-10);
  if ((side > 0) === below) zone.high = Math.min(zone.high, boundary - epsilon);
  else zone.low = Math.max(zone.low, boundary + epsilon);
  return zone.low < zone.high ? zone : undefined;
}

function validBar(cols: ColumnView, i: number): boolean {
  const o = cols.col('open')[i], h = cols.col('high')[i], l = cols.col('low')[i], c = cols.col('close')[i], time = cols.col('time')[i];
  return [o, h, l, c, time].every(Number.isFinite) && l <= Math.min(o, c) && h >= Math.max(o, c) && l <= h &&
    (i === 0 || time > cols.col('time')[i - 1]);
}

/** Current observations can invalidate an unfinished projection. A wick beyond
 * C or the far edge is terminal for this observed scaffold, even if price returns.
 * This intentionally differs from immutable historical PatternMatch outputs. */
function stillOpen(cols: ColumnView, points: Pivot[], zone: Zone, side: number, last: number): boolean {
  if(!harmonicIntact(cols,points[0].index,last))return false;
  const c = points.at(-1)!, epsilon = Math.max(1e-12, Math.abs(c.value) * 1e-10);
  for (let i = points[0].index; i <= last; i++) {
    if (!validBar(cols, i)) return false;
    if (i <= c.index) continue;
    if (side > 0 ? cols.col('high')[i] > c.value + epsilon || cols.col('low')[i] < zone.low - epsilon :
      cols.col('low')[i] < c.value - epsilon || cols.col('high')[i] > zone.high + epsilon) return false;
  }
  return true;
}

function make(cols: ColumnView, last: number, family: string, name: string, points: Pivot[], labels: string[], zone: Zone,
  ratios: PatternRatio[], detail: string, confirmed: readonly PatternMatch[], variant = '', terminalLabel='D', availableAt?:number): PatternCandidate | undefined {
  const c = points.at(-1)!, side = c.kind === 'high' ? 1 : -1;
  if(!harmonicLegsIntact(cols,points))return;
  // Compare the actual scaffold, independent of visibility filters and whether
  // a historical completion subsequently became invalidated.
  if (confirmed.some(match => match.family === family && points.every((p, i) => match.points[i]?.time === p.time && match.points[i]?.value === p.value))) return;
  if (!stillOpen(cols, points, zone, side, last)) return;
  const current = cols.col('close')[last], reached = side > 0 ? cols.col('low')[last] <= zone.high : cols.col('high')[last] >= zone.low;
  return {
    id: `harmonic-candidate:${family}:${points.map(p => p.time).join(':')}${variant}`,
    family, name: `${name} · ${terminalLabel} 区观察`, direction: side > 0 ? 'bullish' : 'bearish',
    points: points.map((p, i) => ({label: labels[i], time: p.time, value: p.value})), zone, ratios,
    availableAt: availableAt??c.confirmedAt, observedAt: cols.col('time')[last],
    description: `基础 ${labels.join('')} 拐点已收盘确认；${terminalLabel} 尚未完成，图中区域为价格投影，不绘制虚构完成点。${detail}。${reached && current >= zone.low && current <= zone.high ? '当前报价进入投影区，仍待 ${terminalLabel} 点与反应确认' : '继续观察后续价格是否测试投影区'}。形成中报价可撤销此候选；越过 ${labels.at(-1)} 或 PRZ 远端后不继续沿用该结构。不是成交或入场信号。`,
  };
}

function xabc(cols: ColumnView, last: number, points: Pivot[], tolerance: number, family: string, confirmed: readonly PatternMatch[]): PatternCandidate[] {
  const [x, a, b, c] = points, side = c.kind === 'high' ? 1 : -1;
  const xa = side * (a.value - x.value), ab = side * (a.value - b.value), bc = side * (c.value - b.value);
  if (Math.min(xa, ab, bc) <= 0 || side * (b.value - x.value) <= 0 || side * (a.value - c.value) <= 0 || !inside(bc / ab, [.382, .886], tolerance)) return [];
  const results: PatternCandidate[] = [], rb = ab / xa;
  for (const rule of RULES) {
    if (family !== '全部' && family !== rule.family || !inside(rb, rule.b, tolerance)) continue;
    if (rule.family === 'Bat' && rb >= .618 || rule.family === 'Deep Crab' && (rb < .886 || rb >= 1) || rule.family === 'Alternate Bat' && rb > .382) continue;
    const projections: Projection[] = [{anchor: a.value, leg: xa, range: [rule.d, rule.d]}, {anchor: c.value, leg: bc, range: rule.bc}];
    if (rule.abcd) projections.push({anchor: c.value, leg: ab, range: rule.abcd});
    let zone = intersect(projections, side, tolerance);
    if (zone) zone = clip(zone, side, b.value, true);
    if (zone) zone = clip(zone, side, x.value, !rule.retracement);
    if (!zone) continue;
    const result = make(cols, last, rule.family, rule.name, points, ['X', 'A', 'B', 'C'], zone,
      [ratio('AB / XA', rb, rule.b), ratio('BC / AB', bc / ab, [.382, .886])],
      `PRZ 由 ${rule.d} XA 与 ${expected(rule.bc)} BC${rule.abcd ? '、AB=CD' : ''} 投影的容差带交集确定`, confirmed);
    if (result) results.push(result);
  }
  return results;
}

function abc(cols: ColumnView, last: number, points: Pivot[], tolerance: number, alternate: boolean, confirmed: readonly PatternMatch[]): PatternCandidate[] {
  const [a, b, c] = points, side = c.kind === 'high' ? 1 : -1;
  const ab = side * (a.value - b.value), bc = side * (c.value - b.value);
  if (Math.min(ab, bc) <= 0 || side * (a.value - c.value) <= 0 || !inside(bc / ab, [.382, .886], tolerance)) return [];
  const results: PatternCandidate[] = [];
  for (const multiple of alternate ? [1, 1.27, 1.618] : [1]) {
    const projection = multiple === 1 ? undefined : [1.618, 2, 2.24, 2.618, 3.14, 3.618].find(v => inside(multiple * ab / bc, [v, v], tolerance));
    if (multiple !== 1 && projection === undefined) continue;
    const zone = intersect([{anchor: c.value, leg: ab, range: [multiple, multiple]}, {anchor: c.value, leg: bc, range: projection === undefined ? [1.13, 2.618] : [projection, projection]}], side, tolerance);
    if (!zone || !clip(zone, side, b.value, true)) continue;
    const result = make(cols, last, 'AB=CD', multiple === 1 ? '等幅 AB=CD' : `${multiple} 延伸 AB=CD`, points, ['A', 'B', 'C'], zone,
      [ratio('BC / AB', bc / ab, [.382, .886])], `${multiple} AB 与 BC 投影共同定义潜在 D 区`, confirmed, `:${multiple}`);
    if (result) results.push(result);
  }
  return results;
}

function fiveZero(cols: ColumnView, last: number, points: Pivot[], tolerance: number, confirmed: readonly PatternMatch[]): PatternCandidate | undefined {
  const [zero, x, a, b, c] = points, side = c.kind === 'high' ? 1 : -1;
  const xa = side * (a.value - x.value), ab = side * (a.value - b.value), bc = side * (c.value - b.value);
  if (Math.min(xa, ab, bc) <= 0 || side * (zero.value - a.value) <= 0 || side * (x.value - b.value) <= 0 || side * (c.value - a.value) <= 0 ||
    !inside(ab / xa, [1.13, 1.618], tolerance) || !inside(bc / ab, [1.618, 2.24], tolerance)) return;
  const half = c.value - side * bc * .5, reciprocal = c.value - side * ab;
  // Volume Two's 5-0 uses 50% BC plus reciprocal AB=CD as an auxiliary
  // projection; it does not impose CD/AB == 1 on every valid 5-0.
  const zone = {low: Math.min(half, reciprocal) - bc * .5 * tolerance, high: Math.max(half, reciprocal) + bc * .5 * tolerance};
  return make(cols, last, '5-0', '5-0 回撤', points, ['0', 'X', 'A', 'B', 'C'], zone,
    [ratio('AB / XA', ab / xa, [1.13, 1.618]), ratio('BC / AB', bc / ab, [1.618, 2.24])],
    '50% BC 为完成投影，Reciprocal AB=CD 为区域辅助参考', confirmed);
}

/** Latest provisional scaffolds, not a historical candidate backtest. The
 * bounded 600-bar window and shared scale stacks make tick-level work predictable.
 * This is latest-tail coverage, not the full historical scan depth. References:
 * Carney Volume One pp.43–45, 79; Volume Two ch.3; extra-family profiles
 * are documented alongside their shared projections in harmonic-extra.ts. */
export function detectHarmonicCandidates(source: ColumnView, params: ParamValues, confirmed: readonly PatternMatch[]): PatternCandidate[] {
  const input=harmonicView(source);
  const lookback = Math.round(number(params.lookback, 1500, 50, 10000)), depth = Math.min(600, lookback);
  const offset = Math.max(0, input.length - depth - 62), columns = {} as Record<ColumnName, Float64Array>;
  for (const key of ['time', 'open', 'high', 'low', 'close', 'volume'] as ColumnName[]) columns[key] = input.col(key).subarray(offset, input.length);
  const cols: ColumnView = {length: input.length - offset, col: name => columns[name]};
  let last = cols.length - 1;
  // The exchange-close path appends only a time sentinel for pivot confirmation.
  if (['open', 'high', 'low', 'close'].every(name => Number.isNaN(columns[name as ColumnName][last]))) last--;
  if (last < 6 || !validBar(cols, last)) return [];
  const tolerance = number(params.tolerance, .04, .001, .15), family = String(params.family ?? '全部');
  const found = new Map<string, PatternCandidate>();
  // Consume the same final state per scale/hierarchy as confirmed detection.
  // Keep discovery time separate from the surviving C anchor after compression.
  const snapshots=new Map<string,{pivots:Pivot[];knownAt:number;radius:number}>();
  for(const state of harmonicSwings(cols,params,depth))snapshots.set(`${state.radius}:${state.retracement}`,{pivots:[...state.pivots],knownAt:state.event.confirmedAt,radius:state.radius});
  for (const {pivots,knownAt,radius} of snapshots.values()) {
    const results: PatternCandidate[] = [];
    if (pivots.length >= 4) results.push(...xabc(cols, last, pivots.slice(-4), tolerance, family, confirmed));
    if ((family === '全部' || family === 'AB=CD') && pivots.length >= 3) results.push(...abc(cols, last, pivots.slice(-3), tolerance, params.includeAlternateABCD !== false, confirmed));
    if ((family === '全部' || family === '5-0') && pivots.length >= 5) {
      const candidate = fiveZero(cols, last, pivots.slice(-5), tolerance, confirmed); if (candidate) results.push(candidate);
    }
    for(const setup of extraHarmonicSetups(pivots,params)){
      // A third drive that has already exceeded the allowed elapsed duration
      // cannot continue advertising a time-symmetric projected completion.
      if(setup.expiresIndex!==undefined&&last>setup.expiresIndex)continue;
      const candidate=make(cols,last,setup.family,setup.name,setup.points,setup.labels,setup.zone,setup.ratios,setup.reference,confirmed,'',setup.terminalLabel,knownAt);
      if(candidate)results.push(candidate);
    }
    for (const candidate of results) {
      candidate.availableAt=Math.max(candidate.availableAt??0,knownAt);
      candidate.pivotStrength = radius;
      const previous = found.get(candidate.id);
      if (!previous || candidate.availableAt! < previous.availableAt!) found.set(candidate.id, candidate);
    }
  }
  const counts = new Map<string, number>();
  return [...found.values()].sort((a, b) => b.points.at(-1)!.time - a.points.at(-1)!.time || a.id.localeCompare(b.id))
    .filter(candidate => {const n = counts.get(candidate.family) ?? 0; counts.set(candidate.family, n + 1); return n < 2;}).slice(0, 8);
}
