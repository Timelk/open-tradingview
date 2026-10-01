import { describe, expect, it } from 'vitest';
import { Viewport } from '../src/lib/core/viewport';

describe('Viewport', () => {
  it('xOf 与 indexAt 互逆', () => {
    const v = new Viewport(1000, { from: 0, to: 100, plotW: 900, plotH: 400 });
    expect(v.xOf(0)).toBeCloseTo(0, 6);
    expect(v.xOf(100)).toBeCloseTo(900, 6);
    expect(v.indexAt(450)).toBeCloseTo(50, 6);
    expect(v.barWidth).toBeCloseTo(9, 6);
  });

  it('pan 平移区间', () => {
    const v = new Viewport(1000, { from: 0, to: 100, plotW: 900, plotH: 400 });
    v.panBy(90); // 右移 90px = 10 根
    expect(v.from).toBeCloseTo(-10, 6);
    expect(v.to).toBeCloseTo(90, 6);
  });

  it('zoom 锚点处索引不动', () => {
    const v = new Viewport(1000, { from: 0, to: 100, plotW: 900, plotH: 400 });
    const anchorIdx = v.indexAt(450);
    v.zoomAt(450, 2); // 放大 2 倍
    expect(v.to - v.from).toBeCloseTo(50, 6);
    expect(v.indexAt(450)).toBeCloseTo(anchorIdx, 6);
  });

  it('zoom 有上下限不翻转', () => {
    const v = new Viewport(1000, { from: 0, to: 100, plotW: 900, plotH: 400 });
    for (let i = 0; i < 50; i++) v.zoomAt(450, 2);
    expect(v.to - v.from).toBeGreaterThanOrEqual(5); // 最小 5 根
    for (let i = 0; i < 50; i++) v.zoomAt(450, 0.5);
    expect(v.to - v.from).toBeLessThanOrEqual(1000); // 不超总量
  });

  it('autoY 留 padding 且空区间不 NaN', () => {
    const v = new Viewport(1000, { from: 0, to: 100, plotW: 900, plotH: 400 });
    const r = v.autoY(10, 20);
    expect(r.min).toBeLessThan(10);
    expect(r.max).toBeGreaterThan(20);
    const flat = v.autoY(5, 5);
    expect(Number.isFinite(flat.min) && Number.isFinite(flat.max)).toBe(true);
    expect(flat.max).toBeGreaterThan(flat.min);
  });

  it('yOf 在 plot 高度内单调递减', () => {
    const v = new Viewport(1000, { from: 0, to: 100, plotW: 900, plotH: 400 });
    v.setY(10, 20);
    expect(v.yOf(20)).toBeCloseTo(0, 6);
    expect(v.yOf(10)).toBeCloseTo(400, 6);
    expect(v.yOf(15)).toBeCloseTo(200, 6);
  });
});
