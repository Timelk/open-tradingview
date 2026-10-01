import { describe, expect, it } from 'vitest';
import { panelMetrics, reanchorVirtualScroll } from '../src/lib/ui/panel-density';

describe('panel density geometry', () => {
  it('uses explicit border-box metrics shared by virtual layout and CSS', () => {
    expect(panelMetrics('compact')).toEqual({ watchRow: 32, treeRow: 32, paneHeading: 28, plotRow: 24 });
    expect(panelMetrics('comfortable')).toEqual({ watchRow: 40, treeRow: 40, paneHeading: 32, plotRow: 28 });
    expect(panelMetrics('compact', true)).toEqual(panelMetrics('comfortable', true));
    expect(panelMetrics('compact', true).treeRow).toBeGreaterThanOrEqual(40);
  });

  it('retains the same leading visible object when row density changes', () => {
    const before = [{ key: 'pane', top: 0, height: 28 }, { key: 'ma', top: 28, height: 32 }, { key: 'macd', top: 60, height: 104 }, { key: 'line', top: 164, height: 32 }];
    const after = [{ key: 'pane', top: 0, height: 32 }, { key: 'ma', top: 32, height: 40 }, { key: 'macd', top: 72, height: 124 }, { key: 'line', top: 196, height: 40 }];
    expect(reanchorVirtualScroll(before, after, 60)).toBe(72);
    expect(reanchorVirtualScroll(before, after, 112)).toBe(134);
    expect(reanchorVirtualScroll(before, after, 180)).toBe(216);
    expect(reanchorVirtualScroll(after, before, 216)).toBe(180);
  });

  it('keeps a safe scroll value when a filtered anchor no longer exists', () => {
    expect(reanchorVirtualScroll([{ key: 'removed', top: 0, height: 32 }], [], 12)).toBe(12);
    expect(reanchorVirtualScroll([], [], -20)).toBe(0);
  });
});
