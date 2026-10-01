import { describe, expect, it, vi } from 'vitest';
import {
  HEATMAP_THEMES,
  computeDepthHistogram,
  getHeatmapTheme,
  heatmapRampHex,
  isHeatmapThemeId,
  resolveHeatmapCellColor,
  resolveHeatmapIntensity,
} from '../src/lib/flow/heatmap-themes';
import { normalizeOrderFlowSettings, type ChartOrderFlowState } from '../src/lib/flow/chart-order-flow';
import {
  drawDepthCrossSection,
  drawDepthHeatmap,
  drawDepthProfile,
  prepareDepthOverlay,
  type DepthProjection,
} from '../src/lib/render/orderbook-overlay';
import { ViewportPhysics } from '../src/lib/interaction/viewport-physics';
import type { SharedBookSnapshot } from '../src/lib/flow/orderbook-hub';

describe('OpenMarket Heatmap Themes & Intensity Engine', () => {
  it('defines all 11 Single-Tone and Two-Tone OpenMarket palettes', () => {
    expect(HEATMAP_THEMES.map(t => t.id)).toEqual([
      'classic',
      'cold',
      'fire',
      'mono',
      'thermal',
      'emerald',
      'orchid',
      'arctic',
      'reef',
      'circuit',
      'stark',
    ]);
    expect(HEATMAP_THEMES.filter(t => t.mode === 'single')).toHaveLength(4);
    expect(HEATMAP_THEMES.filter(t => t.mode === 'two-tone')).toHaveLength(7);
    expect(isHeatmapThemeId('stark')).toBe(true);
    expect(isHeatmapThemeId('invalid-theme')).toBe(false);
    expect(getHeatmapTheme('circuit').label).toBe('靛柠');
  });

  it('resolves sensitivity presets (high / med / low) and custom intensity bounds', () => {
    const sample = [10, 25, 50, 120, 240, 400, 600];
    const high = resolveHeatmapIntensity(sample, 600, { sensitivity: 'high' });
    const med = resolveHeatmapIntensity(sample, 600, { sensitivity: 'med' });
    const low = resolveHeatmapIntensity(sample, 600, { sensitivity: 'low' });

    expect(high.threshold).toBeLessThan(med.threshold);
    expect(med.threshold).toBeLessThan(low.threshold);
    expect(high.ceiling).toBeLessThan(med.ceiling);
    expect(med.ceiling).toBeLessThan(low.ceiling);

    const custom = resolveHeatmapIntensity(sample, 600, {
      sensitivity: 'custom',
      threshold: 45,
      ceiling: 320,
      minBounds: 20,
      maxBounds: 500,
    });
    expect(custom.threshold).toBe(45);
    expect(custom.ceiling).toBe(320);
    expect(custom.minBounds).toBe(20);
    expect(custom.maxBounds).toBe(500);
  });

  it('interpolates quadratic intensity ramp colors for single-tone and two-tone themes', () => {
    const range = { threshold: 50, ceiling: 450 };
    const fallback = { bid: '#26a69a', ask: '#ef5350' };

    const starkBidLow = resolveHeatmapCellColor(60, 'bid', 0.8, 'stark', range, fallback);
    const starkBidHigh = resolveHeatmapCellColor(450, 'bid', 0.8, 'stark', range, fallback);
    const starkAskHigh = resolveHeatmapCellColor(450, 'ask', 0.8, 'stark', range, fallback);

    // Saturated walls bloom from the theme color toward white.
    expect(starkBidHigh.color).toBe(heatmapRampHex('stark', 'bid', 1));
    expect(starkAskHigh.color).toBe(heatmapRampHex('stark', 'ask', 1));
    expect(heatmapRampHex('stark', 'bid', 0.8)).toBe(resolveHeatmapCellColor(370, 'bid', 0.8, 'stark', range, fallback).color);
    const lum = (hex: string) => [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0);
    expect(lum(starkBidHigh.color)).toBeGreaterThan(lum('#00e676'));
    expect(lum(starkAskHigh.color)).toBeGreaterThan(lum('#ff00ff'));
    expect(starkBidHigh.alpha).toBeGreaterThan(starkBidLow.alpha);

    const fireLow = resolveHeatmapCellColor(60, 'bid', 0.8, 'fire', range, fallback);
    const fireHigh = resolveHeatmapCellColor(450, 'ask', 0.8, 'fire', range, fallback);
    expect(fireLow.color).not.toBe(fireHigh.color);
    expect(fireHigh.color).toBe(heatmapRampHex('fire', 'ask', 1));
  });

  it('computes 36-bin log-damped volume distribution histogram', () => {
    const quantities = Array.from({ length: 100 }, (_, i) => (i + 1) * 5);
    const bins = computeDepthHistogram(quantities, 0, 500, 36);
    expect(bins).toHaveLength(36);
    expect(bins.every(b => b.normHeight >= 0.06 && b.normHeight <= 1)).toBe(true);
    expect(bins.some(b => b.count > 0 && b.normHeight === 1)).toBe(true);
  });

  it('normalizes extended OrderFlowSettings fields cleanly', () => {
    const norm = normalizeOrderFlowSettings({
      heatmap: true,
      profile: false,
      theme: 'arctic',
      resolution: '4k',
      sensitivity: 'high',
      ceiling: 250,
      minBounds: 10,
      maxBounds: 800,
      crossSection: true,
    });
    expect(norm.theme).toBe('arctic');
    expect(norm.resolution).toBe('4k');
    expect(norm.sensitivity).toBe('high');
    expect(norm.ceiling).toBe(250);
    expect(norm.minBounds).toBe(10);
    expect(norm.maxBounds).toBe(800);
    expect(norm.crossSection).toBe(true);
    expect(norm.lastDisplay).toBe('heatmap');
  });
});

describe('4K Depth Overlay, Cumulative Staircase Profile & Cross-Section HUD', () => {
  const projection: DepthProjection = {
    left: 0,
    right: 800,
    top: 0,
    bottom: 400,
    min: 99_800,
    max: 100_200,
    fromTime: 1_000,
    toTime: 5_000,
    timeX: (t: number) => ((t - 1_000) / 4_000) * 800,
    priceY: (p: number) => 400 - ((p - 99_800) / 400) * 400,
  };

  const makeState = (resolution: 'hd' | '4k'): ChartOrderFlowState => ({
    mode: 'live',
    running: true,
    error: '',
    revision: 1,
    market: {
      source: 'binance',
      symbol: 'BTCUSDT',
      marketType: 'usdm-perpetual',
      tickSize: 1,
    },
    settings: normalizeOrderFlowSettings({
      heatmap: true,
      profile: true,
      priceStepTicks: 10,
      resolution,
      theme: 'stark',
      crossSection: true,
    }),
    book: {
      symbol: 'BTCUSDT',
      source: 'binance',
      marketType: 'usdm-perpetual',
      status: 'live',
      error: '',
      revision: 2,
      sequence: 10,
      eventTime: 4_000,
      receivedAt: 4_000,
      capturedAt: 4_000,
      lastReceivedAt: 4_000,
      tickSize: 1,
      mid: 100_000,
      spread: 20,
      bids: [
        { price: 99_990, quantity: 12 },
        { price: 99_970, quantity: 28 },
        { price: 99_940, quantity: 45 },
      ],
      asks: [
        { price: 100_010, quantity: 15 },
        { price: 100_030, quantity: 32 },
        { price: 100_060, quantity: 50 },
      ],
      changes: [],
      history: [
        {
          time: 2_000,
          eventTime: 2_000,
          receivedAt: 2_000,
          availableAt: 2_000,
          revision: 1,
          segmentId: 1,
          bids: [
            { price: 99_990, quantity: 10 },
            { price: 99_950, quantity: 25 },
          ],
          asks: [
            { price: 100_010, quantity: 14 },
            { price: 100_050, quantity: 30 },
          ],
        },
        {
          time: 4_000,
          eventTime: 4_000,
          receivedAt: 4_000,
          availableAt: 4_000,
          revision: 2,
          segmentId: 1,
          bids: [
            { price: 99_990, quantity: 12 },
            { price: 99_970, quantity: 28 },
            { price: 99_940, quantity: 45 },
          ],
          asks: [
            { price: 100_010, quantity: 15 },
            { price: 100_030, quantity: 32 },
            { price: 100_060, quantity: 50 },
          ],
        },
      ],
      historyCoverage: { samples: 2, fromTime: 2_000, throughTime: 4_000, intervalMs: 2_000, maxSamples: 300, levelsPerSide: 100 },
    } as unknown as SharedBookSnapshot,
  });

  it('halves price step in 4K resolution when priceStepTicks > 1 and renders staircase + cross-section', () => {
    const hdOverlay = prepareDepthOverlay(makeState('hd'), projection)!;
    const uhdOverlay = prepareDepthOverlay(makeState('4k'), projection)!;
    expect(uhdOverlay.priceStep).toBeLessThan(hdOverlay.priceStep);

    const rects: Array<{ color: string; alpha?: number }> = [];
    const segs: Array<{ color: string; alpha?: number }> = [];
    const sink = {
      rect: (_x0: number, _y0: number, _x1: number, _y1: number, color: string, alpha?: number) => {
        rects.push({ color, alpha });
      },
      seg: (_x0: number, _y0: number, _x1: number, _y1: number, color: string, alpha?: number) => {
        segs.push({ color, alpha });
      },
    };

    const state4k = makeState('4k');
    drawDepthHeatmap(sink, uhdOverlay, 0.75, { bid: '#26a69a', ask: '#ef5350' }, state4k.settings);
    expect(rects.length).toBeGreaterThan(0);

    drawDepthProfile(sink, uhdOverlay, projection, 0.75, { bid: '#26a69a', ask: '#ef5350' }, state4k.settings);
    // Cumulative staircase draws segments on top of horizontal profile bars
    expect(segs.length).toBeGreaterThan(0);

    // Cross-section HUD on Canvas2D context
    const fillText = vi.fn();
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      setLineDash: vi.fn(),
      roundRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText,
      font: '',
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      textBaseline: 'middle' as CanvasTextBaseline,
    } as unknown as CanvasRenderingContext2D;

    drawDepthCrossSection(ctx, uhdOverlay, projection, { x: 400, y: 200 }, 'BTC', 'stark');
    expect(fillText).toHaveBeenCalled();
  });
});

describe('ViewportPhysics (Exponential Zoom Glide, Kinetic Pan Fling & Y-Axis Envelope)', () => {
  it('classifies trackpad wheel gestures with cross-axis deadband', () => {
    const physics = new ViewportPhysics();
    expect(physics.classifyWheel(0, -40, false)).toBe('zoom');
    expect(physics.classifyWheel(0.8, -40, false)).toBe('zoom');
    expect(physics.classifyWheel(24, -4, false)).toBe('pan');
    expect(physics.classifyWheel(0, -40, true)).toBe('pan');
    expect(physics.classifyWheel(undefined, -100, false)).toBe('zoom');
  });

  it('glides multiplicative zoom smoothly across animation frames', () => {
    const physics = new ViewportPhysics();
    physics.queueZoom(0.5, 320, 1000);
    expect(physics.zooming).toBe(true);

    const factors: number[] = [];
    let t = 1000;
    for (let i = 0; i < 40 && physics.active; i++) {
      t += 16;
      physics.step(t, {
        onZoom: (_anchor, factor) => factors.push(factor),
        onPan: () => {},
      });
    }
    expect(factors.length).toBeGreaterThan(3);
    const totalProduct = factors.reduce((acc, f) => acc * f, 1);
    expect(totalProduct).toBeCloseTo(0.5, 2);
    expect(physics.active).toBe(false);
  });

  it('tracks drag velocity and decays kinetic fling with exponential friction', () => {
    const physics = new ViewportPhysics();
    physics.beginDrag(100, 1000);
    physics.recordDrag(130, 1016);
    physics.recordDrag(165, 1032);
    const projected = physics.endDrag(1036, true);
    expect(projected).toBeGreaterThan(0);
    expect(physics.flinging).toBe(true);

    let totalMoved = 0;
    let t = 1036;
    for (let i = 0; i < 60 && physics.flinging; i++) {
      t += 16;
      physics.step(t, {
        onZoom: () => {},
        onPan: dx => {
          totalMoved += dx;
        },
      });
    }
    expect(totalMoved).toBeGreaterThan(40);
    expect(physics.flinging).toBe(false);
  });

  it('holds Y-axis gesture envelope during horizontal pan/fling and suppresses <0.5px jitter', () => {
    const physics = new ViewportPhysics();
    const cur = { min: 100, max: 200 };

    // 1. Sub-pixel deadband (<0.5px on a 400px tall pane = <0.125 price units)
    const micro = physics.stabilizeAutoRange('main', { min: 100.05, max: 199.95 }, cur, 400, false);
    expect(micro).toEqual(cur);

    // 2. Envelope hold during horizontal pan when new bars stay within 8% headroom
    const held = physics.stabilizeAutoRange('main', { min: 95, max: 205 }, cur, 400, true);
    expect(held).toEqual(cur);

    // 3. Data escaping the held range re-seats it with headroom around the new range
    const breached = physics.stabilizeAutoRange('main', { min: 80, max: 225 }, cur, 400, true);
    expect(breached.min).toBeCloseTo(80 - 145 * 0.08);
    expect(breached.max).toBeCloseTo(225 + 145 * 0.08);
    // ...and the next small move inside that headroom holds still
    expect(physics.stabilizeAutoRange('main', { min: 82, max: 228 }, breached, 400, true)).toEqual(breached);

    // 4. Never clips: data poking just past the held range (inside the old 8%
    // envelope) must release the hold
    const clipped = new ViewportPhysics();
    clipped.stabilizeAutoRange('main', cur, cur, 400, true);
    const poke = clipped.stabilizeAutoRange('main', { min: 100, max: 208 }, cur, 400, true);
    expect(poke.max).toBeGreaterThan(200);

    // 5. Releasing the gesture returns the raw auto range
    expect(physics.stabilizeAutoRange('main', { min: 82, max: 228 }, breached, 400, false)).toEqual({ min: 82, max: 228 });
  });
});
