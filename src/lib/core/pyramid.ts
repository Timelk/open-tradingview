import { ColumnStore } from './datastore';

export interface AggLevel {
  factor: number;
  length: number;
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
}

/**
 * 多分辨率金字塔：L0=原始列存（不拷贝，渲染直读 Store），
 * 之上按 factor 聚合。百万级下渲染按像素密度选层，每帧只取 1-2k 图元。
 */
export class Pyramid {
  readonly factors: number[];
  private store: ColumnStore;
  private aggs = new Map<number, AggLevel>();

  constructor(store: ColumnStore, factors = [1, 8, 64, 512, 4096]) {
    this.store = store;
    this.factors = [...factors].sort((a, b) => a - b);
    this.rebuild();
  }

  /** 取聚合层；factor=1 返回 null，表示直读原始 Store。 */
  aggLevel(factor: number): AggLevel | null {
    if (factor === 1) return null;
    return this.aggs.get(factor) ?? null;
  }

  rebuild(): void {
    this.aggs.clear();
    for (const f of this.factors) {
      if (f === 1) continue;
      const len = Math.ceil(this.store.length / f);
      const lv: AggLevel = {
        factor: f,
        length: len,
        time: new Float64Array(Math.max(1, len)),
        open: new Float64Array(Math.max(1, len)),
        high: new Float64Array(Math.max(1, len)),
        low: new Float64Array(Math.max(1, len)),
        close: new Float64Array(Math.max(1, len)),
        volume: new Float64Array(Math.max(1, len)),
      };
      this.aggs.set(f, lv);
      this.computeGroups(lv, 0, len);
    }
  }

  /** 增量：重算与 [from, to) 相交的聚合段；store 变长时自动扩展。 */
  updateRange(from: number, to: number): void {
    for (const f of this.factors) {
      if (f === 1) continue;
      let lv = this.aggs.get(f)!;
      const need = Math.ceil(this.store.length / f);
      if (need > lv.time.length) {
        const capacity = Math.max(need, lv.time.length * 2);
        const grown: AggLevel = {
          factor: f,
          length: need,
          time: new Float64Array(capacity),
          open: new Float64Array(capacity),
          high: new Float64Array(capacity),
          low: new Float64Array(capacity),
          close: new Float64Array(capacity),
          volume: new Float64Array(capacity),
        };
        grown.time.set(lv.time.subarray(0, lv.length));
        grown.open.set(lv.open.subarray(0, lv.length));
        grown.high.set(lv.high.subarray(0, lv.length));
        grown.low.set(lv.low.subarray(0, lv.length));
        grown.close.set(lv.close.subarray(0, lv.length));
        grown.volume.set(lv.volume.subarray(0, lv.length));
        this.aggs.set(f, grown);
        lv = grown;
      }
      lv.length = need;
      const g0 = Math.max(0, Math.floor(from / f));
      const g1 = Math.min(Math.ceil(to / f), lv.length);
      this.computeGroups(lv, g0, g1);
    }
  }

  /** 按每像素根数选最粗可用层；factor=1 时 level=null（直读 Store）。 */
  pickLevel(barsPerPixel: number): { factor: number; level: AggLevel | null } {
    let factor = 1;
    for (const f of this.factors) {
      if (f <= Math.max(1, barsPerPixel)) factor = f;
      else break;
    }
    return { factor, level: this.aggLevel(factor) };
  }

  private computeGroups(lv: AggLevel, g0: number, g1: number): void {
    const f = lv.factor;
    const n = this.store.length;
    const t = this.store.col('time');
    const o = this.store.col('open');
    const h = this.store.col('high');
    const l = this.store.col('low');
    const c = this.store.col('close');
    const v = this.store.col('volume');
    for (let g = g0; g < g1; g++) {
      const s = g * f;
      const e = Math.min(s + f, n);
      if (s >= e) break;
      lv.time[g] = t[s];
      lv.open[g] = o[s];
      lv.close[g] = c[e - 1];
      let hi = -Infinity;
      let lo = Infinity;
      let vol = 0;
      for (let i = s; i < e; i++) {
        if (h[i] > hi) hi = h[i];
        if (l[i] < lo) lo = l[i];
        vol += v[i];
      }
      lv.high[g] = hi;
      lv.low[g] = lo;
      lv.volume[g] = vol;
    }
  }
}
