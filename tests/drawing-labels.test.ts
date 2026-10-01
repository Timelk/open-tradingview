import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STYLE, type Drawing, type Primitive, type Projection } from '../src/lib/drawing/types';
import { drawingFontSize, labelHeight, readableLabelColor, LABEL_BACKGROUND } from '../src/lib/drawing/labels';
import { primitiveHit, renderPrimitives } from '../src/lib/drawing/primitives';
import { registerDrawingBuiltins } from '../src/lib/drawing/builtins';
import { ToolRegistry } from '../src/lib/drawing/registry';
import { parseDrawingDocument } from '../src/lib/drawing/store';
import { parseSceneDocument } from '../src/lib/scene/serialization';
import { SceneStore } from '../src/lib/scene/store';
import { emptyScene, layerOf } from '../src/lib/scene/types';

type Text = Extract<Primitive, { kind: 'text' }>;
type Path = Extract<Primitive, { kind: 'path' }>;
const registry = new ToolRegistry(); registerDrawingBuiltins(registry);
const projection = (top = 0, height = 800): Projection => ({
  pane: { id: 'main', top, height, width: 1000 }, project: point => ({ x: point.time, y: point.value }), indexAt: time => time,
});
function drawing(toolId = 'fib-retracement', fontSize?: number): Drawing {
  const tool = registry.get(toolId)!;
  const points = [{ time: 100, value: 140 }, { time: 320, value: 460 }, { time: 320, value: 520 }, { time: 460, value: 250 }];
  return {
    id: 'drawing', toolId, paneId: 'main', points: points.slice(0, tool.points ?? 2),
    style: { ...DEFAULT_STYLE, ...(fontSize === undefined ? {} : { fontSize }) },
    props: Object.fromEntries((tool.fields ?? []).map(field => [field.key, field.default])), locked: false, hidden: false,
  };
}
function legacyDrawing(toolId = 'fib-retracement'): Drawing {
  const result = drawing(toolId); delete result.style.fontSize; return result;
}
function scene(item: Drawing) {
  const doc = emptyScene(); doc.drawings = [item]; doc.layers = [layerOf(item.id, 'drawing', '标签测试')]; return doc;
}
function reactive<T extends object>(value: T, cache = new WeakMap<object, object>()): T {
  const old = cache.get(value); if (old) return old as T;
  const proxy = new Proxy(value, { get(target, key, receiver) {
    const result = Reflect.get(target, key, receiver);
    return result && typeof result === 'object' ? reactive(result, cache) : result;
  } });
  cache.set(value, proxy); return proxy;
}
const texts = (primitives: Primitive[]) => primitives.filter((item): item is Text => item.kind === 'text');
const paths = (primitives: Primitive[]) => primitives.filter((item): item is Path => item.kind === 'path');

type Recorded = { kind: 'stroke' | 'background' | 'text'; args: Array<number | string>; font: string; color: string };
function canvas(dpr = 1) {
  const calls: Recorded[] = [];
  const stack: Array<{ font: string; fillStyle: string; globalAlpha: number; textAlign: string; textBaseline: string }> = [];
  const ctx = {
    font: '10px sans-serif', fillStyle: '', strokeStyle: '', globalAlpha: 1, textAlign: 'left', textBaseline: 'alphabetic',
    lineWidth: 1, lineJoin: 'round', lineCap: 'round',
    save() { stack.push({ font: ctx.font, fillStyle: ctx.fillStyle, globalAlpha: ctx.globalAlpha, textAlign: ctx.textAlign, textBaseline: ctx.textBaseline }); },
    restore() { const value = stack.pop(); if (value) Object.assign(ctx, value); },
    setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), fill: vi.fn(),
    setTransform: vi.fn(), scale: vi.fn(), getTransform: () => ({ a: dpr, d: dpr }),
    measureText(text: string) {
      const size = Number.parseFloat(ctx.font);
      // Deliberately unlike the fallback estimate, to detect stale hit bounds.
      const width = [...text].reduce((sum, char) => sum + (char.codePointAt(0)! > 255 ? 1.15 : .77) * size, 0);
      return { width, actualBoundingBoxAscent: size * .8, actualBoundingBoxDescent: size * .2 };
    },
    stroke() { calls.push({ kind: 'stroke', args: [], font: ctx.font, color: ctx.strokeStyle }); },
    fillRect(x: number, y: number, width: number, height: number) { calls.push({ kind: 'background', args: [x, y, width, height], font: ctx.font, color: ctx.fillStyle }); },
    fillText(text: string, x: number, y: number) { calls.push({ kind: 'text', args: [text, x, y], font: ctx.font, color: ctx.fillStyle }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, scale: ctx.scale, setTransform: ctx.setTransform };
}
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map(at => Number.parseInt(value.slice(at, at + 2), 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

describe('drawing label compatibility and persistent styles', () => {
  it('imports old documents without a style fontSize and retains legacy text size through scene normalization', () => {
    const fib = legacyDrawing(), text = legacyDrawing('text'); text.id = 'legacy-text'; text.props.fontSize = 14;
    const encoded = JSON.stringify({ version: 1, drawings: [fib, text] });
    const parsed = parseDrawingDocument(encoded, registry);
    expect(drawingFontSize(parsed[0])).toBe(13); expect(drawingFontSize(parsed[1])).toBe(14);
    const doc = parseSceneDocument(encoded, registry), store = new SceneStore(); store.replaceDocument(doc);
    const restored = parseSceneDocument(JSON.stringify(store.document), registry);
    expect(restored.drawings[1].props.fontSize).toBe(14);
    expect(drawingFontSize(restored.drawings[1])).toBe(14);
    expect(texts(registry.get('text')!.build(restored.drawings[1], projection()))[0].size).toBe(14);
  });

  it('uses shared style size before legacy text props and primitive hints, with a readable bounded default', () => {
    const item = legacyDrawing('text'); item.props.fontSize = 14;
    expect(DEFAULT_STYLE.fontSize).toBe(13); expect(drawingFontSize(item, 20)).toBe(14);
    item.style.fontSize = 24; expect(drawingFontSize(item, 20)).toBe(24);
    delete item.style.fontSize; delete item.props.fontSize;
    expect(drawingFontSize(item, 20)).toBe(20); expect(drawingFontSize(item)).toBe(13);
    item.style.fontSize = 6; expect(drawingFontSize(item)).toBe(12);
    item.style.fontSize = 50; expect(drawingFontSize(item)).toBe(32);
  });

  it('preserves proxied font sizes without retaining mutable references and supports preview commit/cancel and undo', () => {
    const store = new SceneStore(), source = scene(drawing('fib-retracement', 13));
    store.replaceDocument(reactive(source)); source.drawings[0].style.fontSize = 32;
    expect(store.document.drawings[0].style.fontSize).toBe(13);
    store.beginPreview();
    for (const fontSize of [18, 24, 28]) {
      const update = reactive(structuredClone(store.document)); update.drawings[0].style.fontSize = fontSize;
      store.commitDocument(update); update.drawings[0].style.fontSize = 12;
      expect(store.document.drawings[0].style.fontSize).toBe(fontSize);
    }
    expect(store.canUndo).toBe(false); expect(() => structuredClone(store.document)).not.toThrow();
    store.finishPreview(true); store.undo(); expect(store.document.drawings[0].style.fontSize).toBe(13);
    expect(store.canUndo).toBe(false); store.redo(); expect(store.document.drawings[0].style.fontSize).toBe(28);
    store.beginPreview(); const temporary = structuredClone(store.document); temporary.drawings[0].style.fontSize = 32;
    store.commitDocument(reactive(temporary)); store.finishPreview(false); expect(store.document.drawings[0].style.fontSize).toBe(28);
    expect(parseSceneDocument(JSON.stringify(store.document), registry).drawings[0].style.fontSize).toBe(28);
  });

  it('rejects invalid font sizes atomically at import and scene history boundaries', () => {
    const store = new SceneStore(); store.replaceDocument(scene(drawing('text', 14)));
    const before = structuredClone(store.document);
    for (const value of [11, 33, NaN, Infinity, '24']) {
      const bad = structuredClone(before); bad.drawings[0].style.fontSize = value as number;
      expect(() => parseSceneDocument(JSON.stringify(bad), registry)).toThrow();
      expect(() => store.commitDocument(reactive(bad))).toThrow();
      expect(store.document).toEqual(before); expect(store.canUndo).toBe(false);
    }
    for (const fontSize of [12, 32]) expect(() => parseSceneDocument(JSON.stringify(scene(drawing('text', fontSize))), registry)).not.toThrow();
  });
});

describe('built-in label size and Fibonacci layout', () => {
  it('shares font size across all labeled builtins and avoids a competing text fontSize property field', () => {
    expect(registry.get('text')!.fields?.map(field => field.key)).toEqual(['text']);
    for (const id of ['horizontal-line', 'fib-retracement', 'abcd-pattern', 'long-position', 'short-position', 'date-price-range', 'text']) {
      for (const fontSize of [13, 24]) {
        const item = drawing(id, fontSize), labels = texts(registry.get(id)!.build(item, projection()));
        expect(labels.length, id).toBeGreaterThan(0);
        expect(labels.every(label => label.size === fontSize), id).toBe(true);
      }
    }
  });

  it('keeps every Fibonacci level at its original price while fitting large labels within a short pane', () => {
    const item = drawing('fib-retracement', 24), view = projection(100, 70);
    item.points = [{ time: 100, value: 115 }, { time: 300, value: 150 }];
    const primitives = registry.get(item.toolId)!.build(item, view), labels = texts(primitives).sort((a, b) => a.at.y - b.at.y);
    const levels = [0, .236, .382, .5, .618, .786, 1];
    const horizontal = paths(primitives).filter(path => path.points.length === 2
      && path.points[0].x === 100 && path.points[1].x === 300 && path.points[0].y === path.points[1].y);
    expect(horizontal).toHaveLength(levels.length);
    expect(horizontal.map(path => path.points[0].y)).toEqual(levels.map(ratio => 150 - 35 * ratio));
    expect(labels.length).toBeGreaterThan(0); expect(labels.length).toBeLessThan(levels.length);
    for (const label of labels) {
      expect(label.at.y - labelHeight(label.size!) / 2).toBeGreaterThanOrEqual(view.pane.top);
      expect(label.at.y + labelHeight(label.size!) / 2).toBeLessThanOrEqual(view.pane.top + view.pane.height);
    }
    for (let i = 1; i < labels.length; i++) expect(labels[i].at.y - labels[i - 1].at.y)
      .toBeGreaterThanOrEqual((labelHeight(labels[i].size!) + labelHeight(labels[i - 1].size!)) / 2);
    const connectors = paths(primitives).filter(path => !horizontal.includes(path) && path !== primitives[0]);
    expect(connectors.length).toBeGreaterThan(0);
    expect(item.points).toEqual([{ time: 100, value: 115 }, { time: 300, value: 150 }]);
  });

  it('does not move any Fibonacci horizontal line when changing only label font size', () => {
    const item = drawing(), tool = registry.get(item.toolId)!;
    const levels = (fontSize: number) => paths(tool.build({ ...item, style: { ...item.style, fontSize } }, projection()))
      .filter(path => path.points.length === 2 && path.points[0].y === path.points[1].y
        && path.points[0].x === 100 && path.points[1].x === 320).map(path => path.points);
    expect(levels(13)).toHaveLength(7); expect(levels(24)).toEqual(levels(13));
  });

  it('ensures dark user-selected label colors remain readable against the dark label background', () => {
    for (const color of ['#101010', '#005500', '#310077', '#4d91ff', '#ffffff']) {
      const foreground = luminance(readableLabelColor(color)), background = luminance(LABEL_BACKGROUND);
      expect((Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('label painting and hit bounds', () => {
  it('paints every stroke before any label and paints each opaque background before its text', () => {
    const c = canvas(), item = drawing('text', 24);
    const primitives: Primitive[] = [
      { kind: 'text', at: { x: 100, y: 50 }, text: '第一行', size: 24, background: true },
      { kind: 'path', points: [{ x: 0, y: 50 }, { x: 500, y: 50 }] },
      { kind: 'text', at: { x: 100, y: 100 }, text: '第二行', size: 24, background: true },
      { kind: 'path', points: [{ x: 0, y: 100 }, { x: 500, y: 100 }] },
    ];
    renderPrimitives(c.ctx, primitives, item);
    expect(c.calls.map(call => call.kind)).toEqual(['stroke', 'stroke', 'background', 'text', 'background', 'text']);
  });

  it('scales backgrounds with measured text and font size using CSS pixels for both standard and Retina contexts', () => {
    const renders = [13, 24].map(fontSize => {
      const primitive: Text = { kind: 'text', at: { x: 200, y: 100 }, text: '字号 Label', size: fontSize, background: true };
      const normal = canvas(1), retina = canvas(2), item = drawing('text', fontSize);
      renderPrimitives(normal.ctx, [primitive], item); renderPrimitives(retina.ctx, [primitive], item);
      expect(retina.calls).toEqual(normal.calls); expect(retina.scale).not.toHaveBeenCalled(); expect(retina.setTransform).not.toHaveBeenCalled();
      expect(normal.calls.find(call => call.kind === 'text')!.font).toMatch(new RegExp(`^${fontSize}px `));
      const bounds = normal.calls.find(call => call.kind === 'background')!.args as number[];
      expect(bounds[3]).toBeGreaterThan(fontSize);
      return bounds;
    });
    expect(renders[1][2]).toBeGreaterThan(renders[0][2]); expect(renders[1][3]).toBeGreaterThan(renders[0][3]);
  });

  it.each(['left', 'center', 'right'] as const)('matches rendered %s-aligned bounds and refreshes cached hit bounds after resizing text', align => {
    const primitive: Text = { kind: 'text', at: { x: 240, y: 100 }, text: '宽WWW', align, size: 13, background: true };
    let smaller: number[] = [];
    for (const fontSize of [13, 24]) {
      primitive.size = fontSize;
      const c = canvas(); renderPrimitives(c.ctx, [primitive], drawing('text', fontSize));
      const [x, y, width, height] = c.calls.find(call => call.kind === 'background')!.args as number[];
      expect(primitiveHit({ x: x + .1, y: y + .1 }, primitive, 0)).toBe(true);
      expect(primitiveHit({ x: x + width - .1, y: y + height - .1 }, primitive, 0)).toBe(true);
      expect(primitiveHit({ x: x - 1, y: y + height / 2 }, primitive, 0)).toBe(false);
      expect(primitiveHit({ x: x + width + 1, y: y + height / 2 }, primitive, 0)).toBe(false);
      expect(primitiveHit({ x: x + width / 2, y: y - 1 }, primitive, 0)).toBe(false);
      expect(primitiveHit({ x: x + width / 2, y: y + height + 1 }, primitive, 0)).toBe(false);
      if (smaller.length) expect(width).toBeGreaterThan(smaller[2]);
      smaller = [x, y, width, height];
    }
  });

  it('provides a font-aware fallback hit region before a label has first rendered', () => {
    const small: Text = { kind: 'text', at: { x: 100, y: 100 }, text: 'Label', size: 13, background: true };
    const large: Text = { ...small, at: { ...small.at }, size: 24 };
    expect(primitiveHit({ x: 110, y: 100 }, small, 0)).toBe(true);
    expect(primitiveHit({ x: 110, y: 100 }, large, 0)).toBe(true);
    expect(primitiveHit({ x: 110, y: 115 }, small, 0)).toBe(false);
    expect(primitiveHit({ x: 110, y: 115 }, large, 0)).toBe(true);
  });
});
