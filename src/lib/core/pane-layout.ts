export interface PaneGeometry {
  id: string;
  top: number;
  height: number;
}

/** Layout preferences are proportions, independent of market data and pixels. */
export class PaneLayout {
  private weights = new Map<string, number>();

  minimum(total: number, count: number): number {
    return Math.min(64, Math.max(0, total) / Math.max(1, count));
  }

  resolve(ids: string[], total: number): PaneGeometry[] {
    if (!ids.length) return [];
    total = Math.max(0, total);
    const subCount = ids.filter(id => id !== 'main' && id !== 'volume').length;
    const volume = ids.includes('volume') ? Math.min(105, total * .18) : 0;
    const sub = subCount ? Math.min(125, total * .43 / subCount) : 0;
    const defaults = ids.map(id => id === 'main' ? total - volume - sub * subCount : id === 'volume' ? volume : sub);
    const weights = ids.map((id, i) => this.weights.get(id) ?? defaults[i] / (total || 1));
    const min = this.minimum(total, ids.length);
    const heights = new Array<number>(ids.length).fill(0);
    let remaining = total;
    let free = ids.map((_, i) => i);
    // Clamp short panes, then redistribute the remainder without moving neighbors
    // unnecessarily or allowing any pane to become negative.
    while (free.length) {
      const sum = free.reduce((n, i) => n + weights[i], 0) || 1;
      const short = free.filter(i => remaining * weights[i] / sum < min);
      if (!short.length) {
        for (const i of free) heights[i] = remaining * weights[i] / sum;
        break;
      }
      for (const i of short) { heights[i] = min; remaining -= min; }
      free = free.filter(i => !short.includes(i));
    }
    let top = 0;
    return ids.map((id, i) => {
      const height = i === ids.length - 1 ? Math.max(0, total - top) : heights[i];
      const pane = { id, top, height };
      top += height;
      return pane;
    });
  }

  resizePair(panes: PaneGeometry[], boundary: number, delta: number): void {
    const first = panes[boundary], second = panes[boundary + 1];
    if (!first || !second || !Number.isFinite(delta)) return;
    const total = panes.reduce((sum, p) => sum + p.height, 0);
    if (!total) return;
    const min = this.minimum(total, panes.length);
    const movement = Math.max(min - first.height, Math.min(delta, second.height - min));
    panes.forEach((pane, index) => {
      const height = pane.height + (index === boundary ? movement : index === boundary + 1 ? -movement : 0);
      this.weights.set(pane.id, height / total);
    });
  }

  reset(): void { this.weights.clear(); }
}
