export interface PriceRange { min: number; max: number }

/** Zoom around an anchor measured downwards from the top of a pane. */
export function zoomPriceRange(range: PriceRange, factor: number, anchorRatio = .5): PriceRange {
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max <= range.min) return { ...range };
  const anchor = Math.max(0, Math.min(1, anchorRatio));
  const price = range.max - (range.max - range.min) * anchor;
  const span = Math.max(Math.max(1, Math.abs(price)) * 1e-9, Math.min(1e14, (range.max - range.min) / factor));
  return { min: price - span * (1 - anchor), max: price + span * anchor };
}
