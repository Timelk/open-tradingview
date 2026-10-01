import { describe, expect, it } from 'vitest';
import { PaneLayout } from '../src/lib/core/pane-layout';
import { zoomPriceRange } from '../src/lib/core/price-scale';

describe('resizable pane layout', () => {
  const ids = ['main', 'volume', 'macd', 'rsi'];
  it('only changes the two neighboring panes and keeps total height', () => {
    const layout = new PaneLayout(), before = layout.resolve(ids, 800);
    layout.resizePair(before, 1, 24);
    const after = layout.resolve(ids, 800);
    expect(after[0].height).toBeCloseTo(before[0].height);
    expect(after[1].height).toBeCloseTo(before[1].height + 24);
    expect(after[2].height).toBeCloseTo(before[2].height - 24);
    expect(after[3].top).toBeCloseTo(before[3].top);
    expect(after.reduce((sum, pane) => sum + pane.height, 0)).toBeCloseTo(800);
  });
  it('clamps extreme dragging and fits even a very short container', () => {
    const layout = new PaneLayout();
    layout.resizePair(layout.resolve(ids, 800), 0, 100000);
    for (const total of [800, 400, 120, 0]) {
      const panes = layout.resolve(ids, total);
      expect(panes.every(p => Number.isFinite(p.height) && p.height >= layout.minimum(total, ids.length) - 1e-8)).toBe(true);
      expect(panes.reduce((sum, p) => sum + p.height, 0)).toBeCloseTo(total);
    }
  });
  it('keeps proportions on container resize and restores a hidden pane', () => {
    const layout = new PaneLayout();
    layout.resizePair(layout.resolve(ids, 800), 0, -50);
    const original = layout.resolve(ids, 800);
    expect(layout.resolve(ids, 1600)[1].height).toBeCloseTo(original[1].height * 2);
    layout.resolve(['main', 'volume', 'macd'], 800);
    expect(layout.resolve(ids, 800)).toEqual(original);
    layout.reset();
    expect(layout.resolve(ids, 800)).toEqual(new PaneLayout().resolve(ids, 800));
  });
});

describe('manual price scale', () => {
  it('zooms vertically around its anchor without changing the center price', () => {
    expect(zoomPriceRange({ min: 100, max: 200 }, 2)).toEqual({ min: 125, max: 175 });
    const zoomed = zoomPriceRange({ min: -50, max: 50 }, 2, .25);
    expect(zoomed.max - (zoomed.max - zoomed.min) * .25).toBe(25);
  });
  it('rejects invalid factors and keeps repeated extreme zooms finite', () => {
    const start = { min: 100, max: 200 };
    expect(zoomPriceRange(start, NaN)).toEqual(start);
    let range = start;
    for (let i = 0; i < 100; i++) range = zoomPriceRange(range, 10000);
    expect(range.max).toBeGreaterThan(range.min);
    for (let i = 0; i < 100; i++) range = zoomPriceRange(range, .00001);
    expect(Number.isFinite(range.max - range.min)).toBe(true);
  });
});
