export type HeatmapThemeId =
  | 'classic'
  | 'cold'
  | 'fire'
  | 'mono'
  | 'thermal'
  | 'emerald'
  | 'orchid'
  | 'arctic'
  | 'reef'
  | 'circuit'
  | 'stark';

export type HeatmapSensitivityPreset = 'high' | 'med' | 'low' | 'custom';
export type HeatmapResolution = 'hd' | '4k';
export type HeatmapDisplayMode = 'heatmap' | 'profile' | 'both';

export interface HeatmapThemeDefinition {
  id: HeatmapThemeId;
  label: string;
  mode: 'single' | 'two-tone';
  /** Display name (an i18n key) and representative colors [low, high]. */
  swatches: [string, string];
  /** For single-tone: [lowIntensityHex, midIntensityHex, highIntensityHex] */
  singleStops?: [string, string, string];
  /** For two-tone: bid [lowHex, highHex], ask [lowHex, highHex] */
  bidStops?: [string, string];
  askStops?: [string, string];
  /** Profile bar colors for [bid, ask] */
  profileColors: { bid: string; ask: string };
}

export const HEATMAP_THEMES: readonly HeatmapThemeDefinition[] = [
  // SINGLE TONE
  {
    id: 'classic',
    label: '青柠',
    mode: 'single',
    swatches: ['#1fd16c', '#9be836'],
    singleStops: ['#0d3b2e', '#1fd16c', '#c6ff4d'],
    profileColors: { bid: '#2dd4bf', ask: '#f43f5e' },
  },
  {
    id: 'cold',
    label: '冰川',
    mode: 'single',
    swatches: ['#2176ae', '#36b5eb'],
    singleStops: ['#0d2847', '#2176ae', '#7ce8ff'],
    profileColors: { bid: '#38bdf8', ask: '#fb7185' },
  },
  {
    id: 'fire',
    label: '熔岩',
    mode: 'single',
    swatches: ['#e8833a', '#f7e354'],
    singleStops: ['#4a1c0d', '#e8833a', '#fff570'],
    profileColors: { bid: '#fbbf24', ask: '#ef4444' },
  },
  {
    id: 'mono',
    label: '金绿',
    mode: 'single',
    swatches: ['#10b981', '#eab308'],
    singleStops: ['#0b3b2d', '#10b981', '#fde047'],
    profileColors: { bid: '#10b981', ask: '#eab308' },
  },
  // TWO TONE
  {
    id: 'thermal',
    label: '冷暖',
    mode: 'two-tone',
    swatches: ['#38bdf8', '#f97316'],
    bidStops: ['#0e3a5c', '#38bdf8'],
    askStops: ['#5c240e', '#ff7b2b'],
    profileColors: { bid: '#38bdf8', ask: '#f97316' },
  },
  {
    id: 'emerald',
    label: '红绿',
    mode: 'two-tone',
    swatches: ['#10b981', '#ef4444'],
    bidStops: ['#0b3d2e', '#10b981'],
    askStops: ['#4c141b', '#ef4444'],
    profileColors: { bid: '#10b981', ask: '#ef4444' },
  },
  {
    id: 'orchid',
    label: '兰紫',
    mode: 'two-tone',
    swatches: ['#a855f7', '#ec4899'],
    bidStops: ['#341657', '#a855f7'],
    askStops: ['#571435', '#ec4899'],
    profileColors: { bid: '#a855f7', ask: '#ec4899' },
  },
  {
    id: 'arctic',
    label: '蓝金',
    mode: 'two-tone',
    swatches: ['#3b82f6', '#eab308'],
    bidStops: ['#152c5c', '#3b82f6'],
    askStops: ['#54400b', '#facc15'],
    profileColors: { bid: '#3b82f6', ask: '#eab308' },
  },
  {
    id: 'reef',
    label: '珊瑚',
    mode: 'two-tone',
    swatches: ['#14b8a6', '#e879f9'],
    bidStops: ['#0c3d38', '#14b8a6'],
    askStops: ['#4d1957', '#e879f9'],
    profileColors: { bid: '#14b8a6', ask: '#e879f9' },
  },
  {
    id: 'circuit',
    label: '靛柠',
    mode: 'two-tone',
    swatches: ['#6366f1', '#a3e635'],
    bidStops: ['#1e1f5c', '#6366f1'],
    askStops: ['#2f470e', '#a3e635'],
    profileColors: { bid: '#6366f1', ask: '#a3e635' },
  },
  {
    id: 'stark',
    label: '霓虹',
    mode: 'two-tone',
    swatches: ['#00e676', '#ff00ff'],
    bidStops: ['#053d22', '#00e676'],
    askStops: ['#4a054a', '#ff00ff'],
    profileColors: { bid: '#00e676', ask: '#ff00ff' },
  },
];

const THEME_MAP = new Map<HeatmapThemeId, HeatmapThemeDefinition>(
  HEATMAP_THEMES.map((theme) => [theme.id, theme]),
);

export function isHeatmapThemeId(value: unknown): value is HeatmapThemeId {
  return typeof value === 'string' && THEME_MAP.has(value as HeatmapThemeId);
}

export function getHeatmapTheme(id?: HeatmapThemeId): HeatmapThemeDefinition {
  return (id ? THEME_MAP.get(id) : undefined) ?? THEME_MAP.get('stark')!;
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  if (!Number.isFinite(num)) return [38, 166, 154];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clampByte = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${clampByte(r)}${clampByte(g)}${clampByte(b)}`;
}

function lerpColorHex(hexA: string, hexB: string, t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const [r1, g1, b1] = parseHexRgb(hexA);
  const [r2, g2, b2] = parseHexRgb(hexB);
  return rgbToHex(r1 + (r2 - r1) * clamped, g1 + (g2 - g1) * clamped, b1 + (b2 - b1) * clamped);
}

export interface HeatmapIntensityRange {
  threshold: number;
  ceiling: number;
  minBounds: number;
  maxBounds: number;
  upperRef: number;
}

/**
 * Derives effective [threshold, ceiling, minBounds, maxBounds, upperRef] from
 * the observed depth quantities and user settings.
 */
export function resolveHeatmapIntensity(
  quantities: readonly number[],
  maximum: number,
  settings: {
    threshold?: number;
    ceiling?: number;
    minBounds?: number;
    maxBounds?: number;
    sensitivity?: HeatmapSensitivityPreset;
  },
): HeatmapIntensityRange {
  const explicit = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const safeMax = Number.isFinite(maximum) && maximum > 0 ? maximum : 0;
  const sorted = quantities.filter((q) => Number.isFinite(q) && q > 0).sort((a, b) => a - b);
  // Order-book depth is heavy-tailed: one far wall can be 100× the typical
  // level. Auto ranges therefore come from quantiles, not the maximum, so a
  // single outlier cannot push the threshold above almost every level.
  const quantile = sorted.length > 4
    ? (f: number) => {
        const at = f * (sorted.length - 1), i = Math.floor(at), next = sorted[Math.min(sorted.length - 1, i + 1)];
        return sorted[i] + (next - sorted[i]) * (at - i);
      }
    : undefined;
  const minBounds = explicit(settings.minBounds) ? settings.minBounds : 0;
  const maxBounds = explicit(settings.maxBounds) && settings.maxBounds > minBounds
    ? settings.maxBounds
    : Math.max(minBounds + 1e-6, Number(((quantile?.(0.998) ?? safeMax) || 500).toPrecision(3)));
  const span = Math.max(1e-6, maxBounds - minBounds);
  const preset = settings.sensitivity ?? 'med';
  // [threshold, ceiling] as quantiles of observed levels (or span fractions
  // when there are too few levels to rank).
  // Reference-style heatmaps show walls, not the book: by default only the top
  // ~15% of levels paint at all and only the top ~1% saturate.
  const [thresholdQ, ceilingQ] = preset === 'high' ? [0.7, 0.97] : preset === 'low' ? [0.93, 0.997] : [0.85, 0.99];
  const [thresholdF, ceilingF] = preset === 'high' ? [0.08, 0.42] : preset === 'low' ? [0.35, 0.82] : [0.18, 0.58];
  const auto = (q: number, f: number) => {
    const value = quantile ? quantile(q) : safeMax > 0 ? minBounds + span * f : 0;
    return Math.min(maxBounds, Math.max(minBounds, Number(value.toPrecision(3))));
  };
  const threshold = explicit(settings.threshold) ? Math.max(minBounds, settings.threshold) : auto(thresholdQ, thresholdF);
  const autoCeiling = safeMax > 0 || quantile ? auto(ceilingQ, ceilingF) : Math.max(threshold + 1, 350);
  const ceiling = Math.max(threshold + 1e-6, explicit(settings.ceiling) ? settings.ceiling : autoCeiling);
  const upperRef = Math.max(ceiling * 1.25, quantile?.(0.995) ?? maxBounds);
  return { threshold, ceiling, minBounds, maxBounds, upperRef: Number(upperRef.toPrecision(3)) };
}

/** Portion of the ramp (from the top) that blooms toward white. */
const GLOW_START = 0.82;
const GLOW_MIX = 0.8;

/**
 * Theme color at a ramp position. The quadratic-ish blend keeps medium depth
 * dim, and the last stretch blooms toward white so saturated liquidity walls
 * read as bright filaments against the chart (as reference heatmaps do).
 */
export function heatmapRampHex(themeId: HeatmapThemeId, side: 'bid' | 'ask', linear: number): string {
  const theme = getHeatmapTheme(themeId);
  const t = Math.max(0, Math.min(1, linear));
  const blend = 0.35 * t + 0.65 * t * t;
  let color: string;
  if (theme.mode === 'single' && theme.singleStops) {
    const [low, mid, high] = theme.singleStops;
    color = blend < 0.5 ? lerpColorHex(low, mid, blend * 2) : lerpColorHex(mid, high, (blend - 0.5) * 2);
  } else {
    const stops = side === 'bid' ? theme.bidStops! : theme.askStops!;
    color = lerpColorHex(stops[0], stops[1], blend);
  }
  if (t > GLOW_START) color = lerpColorHex(color, '#ffffff', ((t - GLOW_START) / (1 - GLOW_START)) * GLOW_MIX);
  return color;
}

/**
 * Resolves the color and alpha for a single depth cell using the Titan WebGL
 * quadratic intensity ramp:
 *   x = clamp((quantity - threshold) / (ceiling - threshold), 0, 1)
 *   intensity = x * x
 */
export function resolveHeatmapCellColor(
  quantity: number,
  side: 'bid' | 'ask',
  opacity: number,
  themeId: HeatmapThemeId | undefined,
  intensityRange: { threshold: number; ceiling: number },
  fallbackColors: { bid: string; ask: string },
): { color: string; alpha: number } {
  const clampedOpacity = Math.max(0, Math.min(1, opacity));
  if (!themeId) {
    const denom = Math.max(1e-9, intensityRange.ceiling);
    const norm = Math.max(0, Math.min(1, quantity / denom));
    return {
      color: side === 'bid' ? fallbackColors.bid : fallbackColors.ask,
      alpha: Math.max(clampedOpacity * 0.07, Math.sqrt(norm) * clampedOpacity),
    };
  }

  const span = Math.max(1e-9, intensityRange.ceiling - intensityRange.threshold);
  const linear = Math.max(0, Math.min(1, (quantity - intensityRange.threshold) / span));
  const color = heatmapRampHex(themeId, side, linear);

  return { color, alpha: heatmapCellAlpha(heatmapAlphaFactor(linear), clampedOpacity) };
}

export interface DepthHistogramBin {
  index: number;
  low: number;
  high: number;
  count: number;
  normHeight: number;
}

/**
 * Computes a 36-bar volume distribution histogram for the Sensitivity control
 * in the Heatmap popover.
 */
export function computeDepthHistogram(
  quantities: readonly number[],
  minBounds: number,
  maxBounds: number,
  binCount = 36,
): DepthHistogramBin[] {
  const safeBins = Math.max(8, Math.min(64, Math.round(binCount)));
  const lo = Number.isFinite(minBounds) && minBounds >= 0 ? minBounds : 0;
  const maxObserved = quantities.reduce((m, q) => (Number.isFinite(q) && q > m ? q : m), 0);
  const hi = Math.max(lo + 1, Number.isFinite(maxBounds) && maxBounds > lo ? maxBounds : maxObserved || 500);
  const step = (hi - lo) / safeBins;

  const counts = new Array<number>(safeBins).fill(0);
  for (const q of quantities) {
    if (!Number.isFinite(q) || q <= 0 || q < lo) continue;
    const idx = Math.min(safeBins - 1, Math.max(0, Math.floor((q - lo) / step)));
    counts[idx]++;
  }

  // Use log-damped normalization so small tail whale bins remain visible just like OpenMarket
  const maxCount = Math.max(1, ...counts);
  return counts.map((count, index) => ({
    index,
    low: lo + index * step,
    high: lo + (index + 1) * step,
    count,
    normHeight: count > 0 ? Math.max(0.12, Math.log1p(count) / Math.log1p(maxCount)) : 0.06,
  }));
}

/** Number of intensity steps in a palette lookup table. */
export const HEATMAP_LUT_SIZE = 256;

/**
 * Precomputed RGBA ramp for one theme: row 0 is bid, row 1 is ask. RGB is the
 * {@link resolveHeatmapCellColor} color at `linear = i / (size - 1)` and A is
 * the opacity-independent alpha factor `0.18 + 0.82 * sqrt(linear)`. The GPU
 * path uploads it as a 256×2 texture; the CPU path indexes it directly, so
 * neither parses a hex string per cell.
 */
export interface HeatmapPalette {
  readonly theme: HeatmapThemeId;
  readonly rgba: Float32Array;
  readonly bytes: Uint8Array;
}

const palettes = new Map<HeatmapThemeId, HeatmapPalette>();

export function getHeatmapPalette(themeId: HeatmapThemeId): HeatmapPalette {
  const cached = palettes.get(themeId);
  if (cached) return cached;
  const size = HEATMAP_LUT_SIZE;
  const rgba = new Float32Array(size * 2 * 4);
  const bytes = new Uint8Array(size * 2 * 4);
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < size; i++) {
      const linear = i / (size - 1);
      const [r, g, b] = parseHexRgb(heatmapRampHex(themeId, side === 0 ? 'bid' : 'ask', linear));
      const o = (side * size + i) * 4;
      const a = heatmapAlphaFactor(linear);
      rgba[o] = r / 255; rgba[o + 1] = g / 255; rgba[o + 2] = b / 255; rgba[o + 3] = a;
      bytes[o] = r; bytes[o + 1] = g; bytes[o + 2] = b; bytes[o + 3] = Math.round(a * 255);
    }
  }
  const palette = { theme: themeId, rgba, bytes };
  palettes.set(themeId, palette);
  return palette;
}

/** Linear position of a quantity on the threshold→ceiling ramp, or -1 when it
 * is below the threshold and must not paint (noise culling). */
export function heatmapRampPosition(quantity: number, threshold: number, ceiling: number): number {
  if (!(quantity > 0) || (threshold > 0 && quantity < threshold)) return -1;
  const span = Math.max(1e-9, ceiling - threshold);
  return Math.max(0, Math.min(1, (quantity - threshold) / span));
}

/** Opacity-independent alpha factor for a ramp position (LUT alpha channel). */
export function heatmapAlphaFactor(linear: number): number {
  return Math.pow(Math.max(0, Math.min(1, linear)), 0.75);
}

/**
 * Final cell alpha. `opacity` sets how visible the faintest painted level is;
 * alpha then rises with intensity to fully opaque at the ceiling, so walls stay
 * solid however low the base opacity is set. Mirrored in the GPU shader.
 */
export function heatmapCellAlpha(alphaFactor: number, opacity: number): number {
  const base = Math.max(0, Math.min(1, opacity)) * 0.3;
  return Math.min(1, base + (1 - base) * alphaFactor);
}
