import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartController, initialState } from '../src/lib/chart/controller';
import { Viewport } from '../src/lib/core/viewport';
import { DrawingEngine } from '../src/lib/drawing/engine';
import { registerDrawingBuiltins } from '../src/lib/drawing/builtins';
import { ToolRegistry } from '../src/lib/drawing/registry';
import { RangeMotion } from '../src/lib/interaction/range-motion';

type SurfaceName = 'gpu' | 'cpu' | 'axes' | 'overlay';
type PaintEvent = { surface: SurfaceName; operation: 'clear' | 'paint'; frame: number | null };

/** Canvas dimension setters destroy the previously presented bitmap. This
 * shell records that observable effect; rendering marks its replacement as
 * complete, so assertions can inspect the image at browser frame boundaries. */
class Surface {
  private w = 1088;
  private h = 626;
  hasImage = true;
  remove = vi.fn();
  constructor(readonly name: SurfaceName, private record: (event: Omit<PaintEvent, 'frame'>) => void) {}
  get width() { return this.w; }
  set width(value: number) { this.w = value; this.clear(); }
  get height() { return this.h; }
  set height(value: number) { this.h = value; this.clear(); }
  private clear() { this.hasImage = false; this.record({ surface: this.name, operation: 'clear' }); }
  paint() { this.hasImage = true; this.record({ surface: this.name, operation: 'paint' }); }
}

const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
});
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); });

function harness() {
  let frame: number | null = null, frameCount = 0;
  const events: PaintEvent[] = [];
  const record = (event: Omit<PaintEvent, 'frame'>) => events.push({ ...event, frame });
  const gpu = new Surface('gpu', record), cpu = new Surface('cpu', record);
  const axes = new Surface('axes', record), overlay = new Surface('overlay', record);
  const surfaces = [gpu, cpu, axes, overlay];
  const captures = new Set<number>();
  const host = {
    clientWidth: 1088, clientHeight: 626, style: { cursor: 'crosshair' },
    classList: { remove: vi.fn() }, hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => { captures.delete(id); },
  };
  const viewport = new Viewport(200, { from: 25.5, to: 125.5, plotW: 1000, plotH: 600 });
  const renderer = {
    resize: vi.fn((width: number, height: number, dpr: number) => {
      for (const surface of [gpu, cpu]) {
        surface.width = Math.round(width * dpr); surface.height = Math.round(height * dpr);
      }
    }), destroy: vi.fn(),
  };
  const controller = Object.assign(Object.create(ChartController.prototype), {
    host, viewport, renderer, overlay, axisCanvas: axes,
    ctx: { setTransform: vi.fn() }, axisContext: { setTransform: vi.fn() },
    width: 1088, height: 626, dpr: 1, resizePending: false,
    dead: false, dirty: false, overlayDirty: false, drag: null, pointer: null,
    viewportMotion: new RangeMotion({ min: viewport.from, max: viewport.to }),
    liveBarMotion: { active: false }, rangeMoving: false, liveFollowing: false,
    state: { ...initialState, loading: false }, store: { length: 200 },
    pendingPointer: null, inputStarted: null, frameTimes: [], fullFrameTimes: [], inputLatencies: [],
    presentedFrames: 0, fpsStart: 0, fpsFrames: 0, lastPublish: 0,
    readingKey: 'stable', makeReadingKey: () => 'stable', publish: vi.fn(),
    draw: vi.fn(() => { gpu.paint(); cpu.paint(); axes.paint(); }),
    drawOverlay: vi.fn(() => overlay.paint()),
    generation: 0, raf: 0, events: new AbortController(),
    observer: { disconnect: vi.fn() }, feed: null, engine: { destroy: vi.fn() }, unsubscribeScene: vi.fn(), unsubscribeLocale: vi.fn(),
    paneControls: { querySelector: () => null, remove: vi.fn() },
  });
  const registry = new ToolRegistry(); registerDrawingBuiltins(registry);
  const drawing = new DrawingEngine(registry, {
    paneAt: () => 'main',
    projection: () => ({
      pane: { id: 'main', top: 0, height: 600, width: 1000 },
      project: anchor => ({ x: anchor.time, y: anchor.value }), indexAt: time => time,
    }),
    anchorAt: pixel => ({ time: pixel.x, value: pixel.y }), zoomTo: () => {},
  }, kind => { if (kind !== 'overlay') controller.dirty = true; controller.overlayDirty = true; });
  controller.drawing = drawing;
  cleanup.push(() => { if (!controller.dead) controller.destroy(); });
  const assertPresented = () => expect(surfaces.map(surface => [surface.name, surface.hasImage]))
    .toEqual(surfaces.map(surface => [surface.name, true]));
  function tick() {
    frame = ++frameCount;
    try { controller.frame(frameCount * 16); } finally { frame = null; }
    assertPresented();
  }
  return { controller, host, viewport, renderer, drawing, captures, surfaces, events, tick, assertPresented };
}

describe('chart resize presentation boundaries', () => {
  it('keeps the previous image between ResizeObserver notification and the next complete frame', () => {
    const h = harness(); h.host.clientWidth = 1288; h.host.clientHeight = 746;
    h.controller.scheduleResize();
    h.assertPresented(); expect(h.events).toEqual([]); expect(h.renderer.resize).not.toHaveBeenCalled();
    h.tick();
    expect(h.renderer.resize).toHaveBeenCalledWith(1288, 746, 1);
    expect(h.controller.draw).toHaveBeenCalledOnce(); expect(h.controller.drawOverlay).toHaveBeenCalledOnce();
    for (const surface of h.surfaces) {
      const operations = h.events.filter(event => event.surface === surface.name);
      expect(operations.some(event => event.operation === 'clear')).toBe(true);
      expect(operations.at(-1)).toEqual({ surface: surface.name, operation: 'paint', frame: 1 });
      expect(operations.every(event => event.frame === 1)).toBe(true);
    }
  });

  it('coalesces rapid notifications to the latest geometry and processes pending input against that geometry', () => {
    const h = harness();
    for (const width of [1188, 1228, 1288]) {
      h.host.clientWidth = width; h.host.clientHeight = 746; h.controller.scheduleResize(); h.assertPresented();
    }
    const input = vi.fn(() => {
      expect(h.viewport.plotW).toBe(1200); expect(h.viewport.plotH).toBe(720);
    });
    h.controller.pendingPointer = input;
    h.tick();
    expect(h.renderer.resize).toHaveBeenCalledOnce(); expect(h.renderer.resize).toHaveBeenCalledWith(1288, 746, 1);
    expect(input).toHaveBeenCalledOnce();
    expect(h.renderer.resize.mock.invocationCallOrder[0]).toBeLessThan(input.mock.invocationCallOrder[0]);
    expect(input.mock.invocationCallOrder[0]).toBeLessThan(h.controller.draw.mock.invocationCallOrder[0]);
    h.tick(); expect(h.renderer.resize).toHaveBeenCalledOnce(); expect(h.controller.draw).toHaveBeenCalledOnce();
    expect(h.events.every(event => event.frame === 1)).toBe(true);
  });

  it('does not clear any canvas when CSS geometry and pixel ratio have not changed', () => {
    const h = harness();
    h.controller.scheduleResize(); h.controller.scheduleResize(); h.tick();
    expect(h.renderer.resize).not.toHaveBeenCalled(); expect(h.events).toEqual([]);
  });

  it('applies a device-pixel-ratio change and repaints every canvas in the same frame without an observer notification', () => {
    const h = harness(); window.devicePixelRatio = 2;
    h.assertPresented(); expect(h.events).toEqual([]); h.tick();
    expect(h.renderer.resize).toHaveBeenCalledOnce(); expect(h.renderer.resize).toHaveBeenCalledWith(1088, 626, 2);
    for (const surface of h.surfaces) expect([surface.width, surface.height]).toEqual([2176, 1252]);
    expect(h.events.every(event => event.frame === 1)).toBe(true);
    expect(h.events.filter(event => event.operation === 'paint')).toHaveLength(4);
    expect([h.viewport.from, h.viewport.to]).toEqual([25.5, 125.5]);
  });

  it('ignores queued notifications and animation callbacks after destruction', () => {
    const h = harness(); h.host.clientWidth = 1288; h.controller.scheduleResize();
    h.controller.destroy();
    expect(h.controller.unsubscribeLocale).toHaveBeenCalledOnce();
    const queuedFrames = vi.mocked(requestAnimationFrame).mock.calls.length;
    h.controller.scheduleResize(); h.tick();
    expect(h.events).toEqual([]); expect(h.renderer.resize).not.toHaveBeenCalled();
    expect(h.controller.draw).not.toHaveBeenCalled(); expect(h.controller.drawOverlay).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(queuedFrames);
  });

  it('retains the viewport, active drawing edit, pointer ownership and undo history through a scheduled resize', () => {
    const h = harness();
    h.drawing.selectTool('trend-line');
    h.drawing.pointerDown({ x: 100, y: 100 }, 'main'); h.drawing.pointerMove({ x: 200, y: 200 });
    h.drawing.pointerUp({ x: 200, y: 200 }); h.drawing.selectTool('cursor');
    const before = structuredClone(h.drawing.document), originalPoints = before.drawings[0].points;
    expect(h.drawing.state.canUndo).toBe(true);
    h.drawing.pointerDown({ x: 100, y: 100 }, 'main'); h.drawing.pointerMove({ x: 130, y: 120 });
    const drag = { kind: 'drawing', id: 7 }; h.controller.drag = drag; h.captures.add(7);
    h.host.clientWidth = 1288; h.host.clientHeight = 746; h.controller.scheduleResize();
    h.assertPresented(); expect(h.drawing.hasGesture).toBe(true); h.tick();
    expect([h.viewport.from, h.viewport.to]).toEqual([25.5, 125.5]);
    expect(h.controller.drag).toBe(drag); expect(h.captures.has(7)).toBe(true);
    expect(h.drawing.hasGesture).toBe(true); expect(h.drawing.document).toEqual(before);
    h.drawing.pointerUp({ x: 150, y: 140 });
    expect(h.drawing.document.drawings[0].points).toEqual([{ time: 150, value: 140 }, originalPoints[1]]);
    h.drawing.undo(); expect(h.drawing.document).toEqual(before);
    h.drawing.undo(); expect(h.drawing.document.drawings).toEqual([]); expect(h.drawing.state.canUndo).toBe(false);
  });

  it('switches real drawing tools and selections without resizing or replacing the rendered chart', () => {
    const h = harness(), document = h.drawing.document;
    for (const tool of ['trend-line', 'fib-retracement', 'cursor']) {
      h.drawing.selectTool(tool); h.assertPresented(); h.tick();
      expect(h.drawing.document).toBe(document);
    }
    h.drawing.selectLayers([]); h.tick();
    expect(h.renderer.resize).not.toHaveBeenCalled();
    expect(h.events.some(event => event.operation === 'clear')).toBe(false);
    expect(h.controller.draw).toHaveBeenCalledTimes(4);
  });
});
