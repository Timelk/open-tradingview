import { describe, expect, it } from 'vitest';
import { drawPatternCandidates } from '../src/lib/render/pattern-candidates';
import { hitPattern, type PatternPaintOptions } from '../src/lib/render/patterns';
import type { PatternCandidate } from '../src/lib/patterns/types';

type PathPart = { op: string; args: number[] };
type Paint = { op: string; args: unknown[]; path: PathPart[]; alpha: number };
function canvas() {
  const paints: Paint[] = [], state: Record<string, unknown> = { globalAlpha: 1 }, stack: Record<string, unknown>[] = [];
  let path: PathPart[] = [];
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[String(key)];
      if (key === 'measureText') return (value: string) => ({ width: value.length * 7 });
      return (...args: unknown[]) => {
        if (key === 'save') stack.push({ ...state });
        else if (key === 'restore') Object.assign(state, stack.pop());
        else if (key === 'beginPath') path = [];
        else if (['moveTo', 'lineTo', 'arc', 'rect', 'closePath'].includes(String(key))) path.push({ op: String(key), args: args as number[] });
        paints.push({ op: String(key), args, path: path.map(part => ({ op: part.op, args: [...part.args] })), alpha: Number(state.globalAlpha) });
      };
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, paints };
}
const project = (time: number, value: number) => ({ x: time * 2, y: 240 - value });
function options(patch: Partial<PatternPaintOptions> = {}): PatternPaintOptions {
  return {
    instanceId: 'candidate-study', color: '#98b7d8', width: 1.5, labels: false, zones: true, targets: false,
    project, bounds: { left: 0, right: 320, top: 0, bottom: 250 }, barWidth: 5, occupied: [], ...patch,
  };
}
function harmonic(patch: Partial<PatternCandidate> = {}): PatternCandidate {
  return {
    id: 'gartley:candidate', family: 'harmonic-gartley', name: 'Gartley', direction: 'bullish',
    points: [{ label: 'X', time: 10, value: 100 }, { label: 'A', time: 30, value: 160 },
      { label: 'B', time: 50, value: 122 }, { label: 'C', time: 70, value: 145 }],
    observedAt: 100, availableAt: 74, zone: { low: 110, high: 115 }, ratios: [], description: 'Observation only', ...patch,
  };
}
const linePath = (a: { x: number; y: number }, b: { x: number; y: number }): PathPart[] => [
  { op: 'moveTo', args: [a.x, a.y] }, { op: 'lineTo', args: [b.x, b.y] },
];

describe('observation geometry rendering contract', () => {
  it('draws only observed XABC anchors and a projected PRZ band without an invented D or trade glyph', () => {
    const candidate = harmonic(), { ctx, paints } = canvas();
    const hits = drawPatternCandidates(ctx, [candidate], options({ selectedId: candidate.id, labels: true }));
    for (let i = 1; i < candidate.points.length; i++) {
      const a = candidate.points[i - 1], b = candidate.points[i];
      expect(paints.some(paint => paint.op === 'stroke' && JSON.stringify(paint.path) === JSON.stringify(linePath(project(a.time, a.value), project(b.time, b.value))))).toBe(true);
    }
    const arcs = paints.filter(paint => paint.op === 'arc');
    expect(arcs.map(paint => paint.args.slice(0, 2))).toEqual(candidate.points.map(p => [project(p.time, p.value).x, project(p.time, p.value).y]));
    const labels = paints.filter(paint => paint.op === 'fillText').map(paint => String(paint.args[0]));
    expect(labels.filter(label => ['X', 'A', 'B', 'C', 'D'].includes(label))).toEqual(['X', 'A', 'B', 'C']);
    expect(labels.some(label => /观察中.*PRZ/.test(label))).toBe(true);
    expect(labels.some(label => /买入|卖出|[↑↓↗↘]/.test(label))).toBe(false);
    expect(paints.some(paint => paint.op === 'fill' && paint.path.some(part => part.op === 'closePath'))).toBe(false);
    const band = paints.find(paint => paint.op === 'fillRect' && paint.alpha < .2)!;
    expect(band).toBeDefined();
    expect(band.args[0]).toBe(project(70, 145).x);
    expect(band.args[1]).toBe(project(100, 115).y);
    expect(band.args[3]).toBe(project(100, 110).y - project(100, 115).y);
    expect(hits[0].candidate).toBe(candidate);
  });

  it('draws neutral Huzi boundaries as supplied and never converts its envelope into a horizontal PRZ', () => {
    const candidate = harmonic({ id: 'huzi:candidate', family: 'huzi-triangle', name: '对称三角形', direction: 'neutral',
      guides: [
        { role: 'upper', points: [{ label: '', time: 5, value: 168 }, { label: '', time: 100, value: 147 }] },
        { role: 'lower', points: [{ label: '', time: 5, value: 100 }, { label: '', time: 100, value: 129 }] },
      ], zone: { low: 129, high: 147 },
    });
    const { ctx, paints } = canvas();
    const hits = drawPatternCandidates(ctx, [candidate], options({ labels: true }));
    expect(hits[0].segments).toEqual(candidate.guides!.map(guide => guide.points.map(p => project(p.time, p.value))));
    for (const guide of candidate.guides!) {
      const [a, b] = guide.points.map(p => project(p.time, p.value));
      expect(paints.some(paint => paint.op === 'stroke' && JSON.stringify(paint.path) === JSON.stringify(linePath(a, b)))).toBe(true);
    }
    expect(paints.filter(paint => paint.op === 'fillRect' && paint.alpha < .2)).toEqual([]);
    const labels = paints.filter(paint => paint.op === 'fillText').map(paint => String(paint.args[0]));
    expect(labels).toEqual(['观察中 · 对称三角形']);
    expect(labels.some(label => label.includes('PRZ'))).toBe(false);
  });

  it('uses the same clipped hit-testing contract as confirmed patterns', () => {
    const candidate = harmonic({ direction: 'neutral', guides: [{ role: 'upper', points: [
      { label: '', time: -25, value: 180 }, { label: '', time: 50, value: 180 },
    ] }] });
    const { ctx, paints } = canvas();
    const hits = drawPatternCandidates(ctx, [candidate], options());
    expect(paints.some(paint => paint.op === 'clip')).toBe(true);
    expect(hitPattern(hits, { x: 20, y: 60 })?.candidate.id).toBe(candidate.id);
    expect(hitPattern(hits, { x: -2, y: 60 })).toBeUndefined();
    expect(hitPattern(hits, { x: 20, y: -1 })).toBeUndefined();
    expect(hitPattern(hits, { x: 321, y: 60 })).toBeUndefined();
  });

  it('honors disabled zones for unselected observations and restores shared canvas opacity', () => {
    const candidate = harmonic(), { ctx, paints } = canvas();
    ctx.globalAlpha = .5;
    const hits = drawPatternCandidates(ctx, [candidate], options({ zones: false, labels: false, opacity: .4 }));
    expect(paints.filter(paint => ['fillRect', 'strokeRect'].includes(paint.op))).toEqual([]);
    expect(hits[0].segments).toHaveLength(candidate.points.length - 1);
    expect(ctx.globalAlpha).toBe(.5);
    expect(paints.filter(paint => paint.op === 'stroke').every(paint => paint.alpha > 0 && paint.alpha <= .2)).toBe(true);
  });
});
