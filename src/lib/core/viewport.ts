export interface ViewportInit {
  from: number;
  to: number;
  plotW: number;
  plotH: number;
}

const MIN_SPAN = 5;

/**
 * 视口：X 轴按 K 线下标索引定位（自然跳过停盘空隙），Y 轴为价格区间。
 * 纯数值计算，无 DOM，可单元测试；渲染器与交互都经它换算。
 */
export class Viewport {
  from: number;
  to: number;
  plotW: number;
  plotH: number;
  private total: number;
  private yMin = 0;
  private yMax = 1;

  constructor(totalBars: number, init: ViewportInit) {
    this.total = Math.max(1, totalBars);
    this.from = init.from;
    this.to = init.to;
    this.plotW = init.plotW;
    this.plotH = init.plotH;
  }

  setTotal(n: number): void {
    this.total = Math.max(1, n);
  }

  resize(w: number, h: number): void {
    this.plotW = Math.max(1, w);
    this.plotH = Math.max(1, h);
  }

  get span(): number {
    return this.to - this.from;
  }

  get barWidth(): number {
    return this.plotW / Math.max(1e-9, this.span);
  }

  xOf(index: number): number {
    return (index - this.from) * this.barWidth;
  }

  indexAt(px: number): number {
    return this.from + px / this.barWidth;
  }

  /** 拖拽：内容跟手，窗口反向平移。 */
  panBy(dxPx: number): void {
    const d = dxPx / this.barWidth;
    const span = this.span;
    let from = this.from - d;
    from = Math.min(Math.max(from, -span), this.total);
    this.from = from;
    this.to = from + span;
  }

  /** 滚轮：factor>1 放大；锚点处索引保持不动；span 钳制。 */
  zoomAt(px: number, factor: number): void {
    const span = this.span;
    const idx = this.indexAt(px);
    const next = Math.min(Math.max(span / factor, MIN_SPAN), this.total);
    const k = next / span;
    this.from = idx - (idx - this.from) * k;
    this.to = this.from + next;
  }

  setY(min: number, max: number): void {
    this.yMin = min;
    this.yMax = max;
  }

  yOf(price: number): number {
    const r = this.yMax - this.yMin || 1;
    return this.plotH - ((price - this.yMin) / r) * this.plotH;
  }

  /** 可见区间自动 Y 轴，上下各留 8% padding；平线时给默认带宽。 */
  autoY(lo: number, hi: number): { min: number; max: number } {
    let pad = (hi - lo) * 0.08;
    if (!Number.isFinite(pad) || pad <= 0) pad = Math.abs(lo) * 0.05 || 1;
    return { min: lo - pad, max: hi + pad };
  }
}
