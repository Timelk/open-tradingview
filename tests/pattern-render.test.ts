import { describe, expect, it } from 'vitest';
import { drawPatterns, hitPattern, type PatternPaintOptions } from '../src/lib/render/patterns';
import type { PatternMatch } from '../src/lib/patterns/types';

type PathOperation = { op: string; args: number[] };
type Paint = {
  op: string; args: unknown[]; path: PathOperation[];
  fill: unknown; stroke: unknown; alpha: number;
};

/** A drawing surface recorder, deliberately independent of the pattern layout.
 * Recording completed paths checks what reaches Canvas, not only hit metadata. */
function canvas() {
  const paints: Paint[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1 };
  const stack: Record<string, unknown>[] = [];
  let path: PathOperation[] = [];
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[String(key)];
      if (key === 'measureText') return (text: string) => ({ width: text.length * 7 });
      return (...args: unknown[]) => {
        if (key === 'save') stack.push({ ...state });
        else if (key === 'restore') Object.assign(state, stack.pop());
        else if (key === 'beginPath') path = [];
        else if (['moveTo', 'lineTo', 'arc', 'rect', 'closePath'].includes(String(key))) {
          path.push({ op: String(key), args: args as number[] });
        }
        paints.push({
          op: String(key), args, path: path.map(part => ({ ...part, args: [...part.args] })),
          fill: state.fillStyle, stroke: state.strokeStyle, alpha: Number(state.globalAlpha),
        });
      };
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, paints };
}

const project = (time: number, value: number) => ({ x: time * 2, y: 240 - value });
const bounds = { left: 0, right: 320, top: 0, bottom: 250 };
function options(patch: Partial<PatternPaintOptions> = {}): PatternPaintOptions {
  return { instanceId: 'huzi-study', color: '#45D6B0', width: 1.5,
    labels: false, zones: false, targets: false, project, bounds, barWidth: 5, occupied: [], ...patch };
}
function huzi(patch: Partial<PatternMatch> = {}): PatternMatch {
  return {
    id: 'huzi-triangle:fixture', family: 'huzi-triangle', name: '对称三角形', direction: 'bullish',
    points: [
      { label: 'A', time: 10, value: 160 }, { label: 'B', time: 30, value: 105 },
      { label: 'C', time: 50, value: 150 }, { label: 'D', time: 70, value: 115 },
      { label: 'E', time: 90, value: 136 },
    ],
    confirmedAt: 130, zone: { low: 150, high: 160 }, invalidation: 110, targets: [180],
    ratios: [], description: 'Independent geometry and event fixture', status: 'confirmed', stage: 'breakout',
    guides: [
      { role: 'upper', points: [{ label: '上沿', time: 5, value: 168 }, { label: '上沿', time: 120, value: 147 }] },
      { role: 'lower', points: [{ label: '下沿', time: 5, value: 100 }, { label: '下沿', time: 120, value: 129 }] },
    ],
    events: [{ kind: 'breakout', time: 125, knownAt: 130, value: 156, boundary: 152 }],
    ...patch,
  };
}

const linePath = (a: { x: number; y: number }, b: { x: number; y: number }): PathOperation[] => [
  { op: 'moveTo', args: [a.x, a.y] }, { op: 'lineTo', args: [b.x, b.y] },
];
const filledPolygons = (paints: Paint[]) => paints.filter(paint => paint.op === 'fill' &&
  paint.path.some(part => part.op === 'closePath') && !paint.path.some(part => part.op === 'arc'));

describe('pattern drawing and chart picking', () => {
  it('only paints an isolated historical reference-touch marker when target references are explicitly shown', () => {
    const pattern = huzi({ guides: undefined, events: undefined, confirmedAt: -100,
      resolution: {kind:'target-reached',time:100,knownAt:110,price:180,targetIndex:0} });
    pattern.points = pattern.points.map(point => ({...point,time:point.time-300}));
    const hidden = canvas(), shown = canvas();
    expect(drawPatterns(hidden.ctx,[pattern],options())).toEqual([]);
    const hits = drawPatterns(shown.ctx,[pattern],options({targets:true}));
    expect(hits).toHaveLength(1);
    expect(hitPattern(hits,project(100,180))?.pattern.id).toBe(pattern.id);
  });
  it('shows a returned breakout as historical even when it is not selected, without changing its geometry', () => {
    const pattern = huzi({ stage: 'failed-breakout' });
    const overview = canvas(), hiddenLabels = canvas();
    const hits = drawPatterns(overview.ctx, [pattern], options({ labels: true }));
    const reference = drawPatterns(hiddenLabels.ctx, [pattern], options());
    const titles = overview.paints.filter(paint => paint.op === 'fillText').map(paint => String(paint.args[0]));
    expect(titles.some(title => title.includes('突破回落'))).toBe(true);
    expect(titles.some(title => /^[↗↘]/.test(title))).toBe(false);
    expect(hits[0].segments).toEqual(reference[0].segments);
    expect(hits[0].pattern).toBe(pattern);
  });

  it('identifies the actual shoulders and head when a head-and-shoulders pattern is selected', () => {
    const pattern = huzi({ family: 'huzi-head-shoulders', name: '头肩底', events: [] });
    pattern.points = pattern.points.map((point, index) => ({ ...point, label: ['L', 'N1', 'H', 'N2', 'R'][index] }));
    const { ctx, paints } = canvas();
    drawPatterns(ctx, [pattern], options({ labels: true, selectedId: pattern.id }));
    const texts = paints.filter(paint => paint.op === 'fillText').map(paint => paint.args[0]);
    expect(texts).toEqual(expect.arrayContaining(['左肩', '颈点1', '头部', '颈点2', '右肩']));
  });

  it('paints the supplied fitted boundaries and makes their extensions selectable', () => {
    const pattern = huzi({ events: [] });
    const { ctx, paints } = canvas();
    const hits = drawPatterns(ctx, [pattern], options());
    for (const guide of pattern.guides!) {
      const [a, b] = guide.points.map(point => project(point.time, point.value));
      expect(paints.some(paint => paint.op === 'stroke' && JSON.stringify(paint.path) === JSON.stringify(linePath(a, b)))).toBe(true);
      expect(hits[0].segments).toContainEqual([a, b]);
    }
    // This location is beyond E, on the upper fitted guide, not on the swing path.
    expect(hitPattern(hits, { x: 217, y: 90.9 })?.pattern.id).toBe(pattern.id);
    const inferredDiagonal = [project(10, 160), project(90, 136)];
    expect(hits[0].segments).not.toContainEqual(inferredDiagonal);
  });

  it('does not shade Huzi swings as two harmonic triangles', () => {
    const { ctx, paints } = canvas();
    drawPatterns(ctx, [huzi({ events: [] })], options());
    expect(filledPolygons(paints)).toEqual([]);
    expect(paints.filter(paint => paint.op === 'arc')).toHaveLength(5);
  });

  it('anchors breakout glyphs and their zone at the event candle, not E or the later known time', () => {
    const pattern = huzi();
    const { ctx, paints } = canvas();
    const hits = drawPatterns(ctx, [pattern], options({ zones: true }));
    const diamond = filledPolygons(paints).find(paint => paint.path.filter(part => part.op === 'lineTo').length === 3)!;
    expect(diamond).toBeDefined();
    const vertices = diamond.path.filter(part => part.op !== 'closePath').map(part => part.args);
    expect(vertices.reduce((sum, point) => sum + point[0], 0) / vertices.length).toBe(250);
    expect(vertices.reduce((sum, point) => sum + point[1], 0) / vertices.length).toBe(84);
    expect(paints.find(paint => paint.op === 'fillRect')?.args.slice(0, 2)).toEqual([250, 80]);
    expect(hitPattern(hits, project(125, 156))?.pattern.id).toBe(pattern.id);
    expect(hits[0].bounds.left).toBeGreaterThan(project(90, 136).x);
  });

  it('places a later retest square on its own candle and preserves both event hit targets', () => {
    const pattern = huzi();
    pattern.events!.push({ kind: 'retest', time: 144, knownAt: 145, value: 150, boundary: 149 });
    const { ctx, paints } = canvas();
    const hits = drawPatterns(ctx, [pattern], options());
    const square = paints.find(paint => paint.op === 'fill' && paint.path.length === 1 && paint.path[0].op === 'rect');
    expect(square?.path[0].args).toEqual([284, 86, 8, 8]);
    expect(hitPattern(hits, project(144, 150))?.pattern.id).toBe(pattern.id);
    expect(hitPattern(hits, project(125, 156))?.pattern.id).toBe(pattern.id);
  });

  it('visually distinguishes failed breakouts and invalidated structures from active ones', () => {
    const states: Array<[Partial<PatternMatch>, string]> = [
      [{}, '#45D6B0'], [{ stage: 'failed-breakout' }, '#d1aa65'],
      [{ status: 'invalidated', stage: 'invalidated' }, '#8290a0'],
    ];
    for (const [patch, color] of states) {
      const pattern = huzi({ ...patch, events: [] });
      const { ctx, paints } = canvas();
      drawPatterns(ctx, [pattern], options());
      const upper = pattern.guides![0].points.map(point => project(point.time, point.value));
      const paintedGuide = paints.find(paint => paint.op === 'stroke' && JSON.stringify(paint.path) === JSON.stringify(linePath(upper[0], upper[1])));
      expect(paintedGuide?.stroke).toBe(color);
    }
  });

  it('clips picking to the pane even when a visible guide extends outside it', () => {
    const pattern = huzi({ events: [], guides: [{ role: 'upper', points: [
      { label: '上沿', time: -25, value: 180 }, { label: '上沿', time: 50, value: 180 },
    ] }] });
    const { ctx, paints } = canvas();
    const hits = drawPatterns(ctx, [pattern], options());
    expect(paints.some(paint => paint.op === 'clip')).toBe(true);
    expect(hitPattern(hits, { x: 20, y: 60 })?.pattern.id).toBe(pattern.id);
    expect(hitPattern(hits, { x: -2, y: 60 })).toBeUndefined();
    expect(hitPattern(hits, { x: 20, y: -1 })).toBeUndefined();
  });

  it('preserves harmonic triangle fills and D-point selection while restoring the shared canvas state', () => {
    const harmonic = huzi({ id: 'harmonic:fixture', family: 'harmonic-gartley', name: 'Gartley', guides: undefined, events: undefined, stage: undefined });
    const { ctx, paints } = canvas();
    ctx.globalAlpha = .5;
    const hits = drawPatterns(ctx, [harmonic], options({ instanceId: 'harmonic-study', opacity: .4 }));
    expect(filledPolygons(paints)).toHaveLength(2);
    expect(filledPolygons(paints).every(paint => paint.alpha > 0 && paint.alpha < .2)).toBe(true);
    expect(hitPattern(hits, project(90, 136))?.instanceId).toBe('harmonic-study');
    expect(ctx.globalAlpha).toBe(.5);
  });
});

it('keeps both real SOL AB=CD legs drawable when zooming around D with A/B and confirmation offscreen',()=>{
  const end=1773691200000,step=4*3_600_000;
  const fixtures=[
    {id:'equal',times:[1772251200000,1772640000000,1773000000000,end],prices:[77.06,94.15,80.18,97.65],confirmedAt:1773878400000},
    {id:'extended',times:[1773230400000,1773403200000,1773475200000,end],prices:[84.3,93.38,86.41,97.65],confirmedAt:1773748800000},
  ];
  const patterns:PatternMatch[]=fixtures.map(f=>({id:f.id,family:'AB=CD',name:f.id,direction:'bearish',status:'confirmed',
    points:f.times.map((time,i)=>({label:'ABCD'[i],time,value:f.prices[i]})),confirmedAt:f.confirmedAt,
    zone:{low:97,high:98},invalidation:99,targets:[91],ratios:[],description:'SOLUSDT 4h public geometry'}));
  const source=JSON.stringify(patterns);
  for(const [left,right] of [[-120,40],[-40,20],[-10,5],[-2,2]]){
    const drawing=canvas(),projection=(time:number,value:number)=>({x:((time-end)/step-left)/(right-left)*320,y:(100-value)/30*240});
    const hits=drawPatterns(drawing.ctx,patterns,options({project:projection,labels:true,zones:true,barWidth:320/(right-left)}));
    expect(hits.map(hit=>hit.pattern.id)).toEqual(['equal','extended']);
    const renderedNames=drawing.paints.filter(p=>p.op==='fillText').map(p=>String(p.args[0]));
    expect(renderedNames.some(text=>text.includes('equal'))).toBe(true);expect(renderedNames.some(text=>text.includes('extended'))).toBe(true);
    for(const hit of hits)expect(hit.segments.some(([a,b])=>Math.max(a.x,b.x)>=0&&Math.min(a.x,b.x)<=320)).toBe(true);
    const d=projection(end,97.65);
    expect(drawing.paints.filter(p=>p.op==='stroke'&&p.path.some(s=>s.op==='lineTo'&&s.args[0]===d.x&&s.args[1]===d.y)).length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(patterns)).toBe(source);
  }
});
