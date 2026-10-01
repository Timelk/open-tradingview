export type PanelDensity = 'compact' | 'comfortable';

/** The virtual layout and rendered rows share these exact border-box sizes. */
export function panelMetrics(density: PanelDensity, coarse = false) {
  if (coarse) return { watchRow: 44, treeRow: 44, paneHeading: 40, plotRow: 40 };
  return density === 'compact'
    ? { watchRow: 32, treeRow: 32, paneHeading: 28, plotRow: 24 }
    : { watchRow: 40, treeRow: 40, paneHeading: 32, plotRow: 28 };
}

export function observeCoarsePointer(onChange: (coarse: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const media = window.matchMedia('(pointer: coarse)');
  const update = () => onChange(media.matches);
  update(); media.addEventListener('change', update);
  return () => media.removeEventListener('change', update);
}

export interface VirtualRowGeometry { key: string; top: number; height: number }

/** Preserve the leading visible object and its fractional offset during density changes. */
export function reanchorVirtualScroll(previous: readonly VirtualRowGeometry[], next: readonly VirtualRowGeometry[], scrollTop: number): number {
  const anchor = previous.find(row => row.top + row.height > scrollTop);
  if (!anchor) return Math.max(0, scrollTop);
  const target = next.find(row => row.key === anchor.key);
  if (!target) return Math.max(0, scrollTop);
  return Math.max(0, target.top + Math.max(0, scrollTop - anchor.top) / anchor.height * target.height);
}
