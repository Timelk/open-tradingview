import { describe, expect, it, vi } from 'vitest';
import { drawAxes, drawAxesBase, drawCrosshair, fmtDateTime, fmtPrice, type AxesInput } from '../src/lib/render/axes';

function surface() {
  const ctx = {
    canvas: { height: 626 }, getTransform: () => ({ d: 1 }),
    clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(), setLineDash: vi.fn(),
    fillText: vi.fn(), fillRect: vi.fn(), measureText: () => ({ width: 80 }),
  };
  const input: AxesInput = {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    plotW: 800, plotH: 600, axisW: 88, axisH: 26,
    paneTicks: [{ top: 0, height: 600, ticks: [{ value: 98765.5, y: 120, digits: 2 }] }],
    xTicks: [{ x: 150, label: '10:30' }],
    lastPrice: { y: 100, label: '98,800.00', up: true },
    crosshair: { x: 240, y: 180, price: '98,650.00', time: '2026/9/6 10:31:00' },
    hoverDot: { x: 240, y: 170 },
  };
  return { ctx, input };
}

describe('axis surfaces', () => {
  it('keeps pointer feedback out of the reusable base surface', () => {
    const { ctx, input } = surface();
    drawAxesBase(input);
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(ctx.fillText.mock.calls.map(call => call[0])).toEqual(['98,765.50', '10:30', '98,800.00']);
    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it('overlays the crosshair without clearing the base or repainting its labels', () => {
    const { ctx, input } = surface();
    drawCrosshair(input);
    expect(ctx.clearRect).not.toHaveBeenCalled();
    expect(ctx.fillText.mock.calls.map(call => call[0])).toEqual(['98,650.00', '2026/9/6 10:31:00']);
    expect(ctx.arc).toHaveBeenCalledWith(240, 170, 3, 0, Math.PI * 2);
  });

  it('retains the complete legacy drawing entry point', () => {
    const { ctx, input } = surface();
    drawAxes(input);
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(ctx.fillText.mock.calls.map(call => call[0])).toEqual(['98,765.50', '10:30', '98,800.00', '98,650.00', '2026/9/6 10:31:00']);
  });
});

describe('cached axis formatting', () => {
  it('retains grouping, rounding and requested precision across alternating formats', () => {
    for (const digits of [2, 0, 5, 3, 2]) for (const value of [0, -0, 98765.54321, -12.345, NaN, Infinity]) {
      expect(fmtPrice(value, digits)).toBe(value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
    }
  });

  it('matches local crosshair timestamps when moving between candles', () => {
    const a = new Date(2026, 8, 6, 0, 0, 0).getTime();
    for (const time of [a, a, a + 60000, a, NaN, Infinity, 9e15]) {
      expect(fmtDateTime(time)).toBe(new Date(time).toLocaleString('zh-CN', { hour12: false }));
    }
  });
});
