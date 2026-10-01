import type { ColumnView, DerivedSeries, IncrementalCalculator, ParamValues } from '../core/types';

/** Keeps the state immediately before the open candle. Replacing that candle
 * restores the checkpoint, so recursive indicators never count a tick twice. */
export class BuiltinCalculator implements IncrementalCalculator {
  private series: DerivedSeries[] = [];
  private length = 0;
  private state: number[] = [];
  private checkpoint: number[] = [];
  constructor(private id: string, private params: ParamValues) {}

  update(cols: ColumnView, from: number): DerivedSeries[] {
    const n = cols.length;
    if (!this.series.length || from < this.length - 1 || n < this.length) {
      this.series = this.describe();
      this.length = 0;
      this.state = this.initialState();
      this.checkpoint = [...this.state];
      from = 0;
    }
    for (const s of this.series) {
      if (s.values.length < n) {
        const next = new Float64Array(Math.max(n + 1024, s.values.length * 2)).fill(NaN);
        next.set(s.values);
        s.values = next;
      }
    }
    const start = Math.min(from, this.length);
    if (start === this.length - 1) this.state = [...this.checkpoint];
    for (let i = start; i < n; i++) {
      if (i === n - 1) this.checkpoint = [...this.state];
      const values = this.step(cols, i);
      for (let j = 0; j < values.length; j++) this.series[j].values[i] = values[j];
    }
    this.length = n;
    return this.series;
  }

  private initialState(): number[] {
    if (this.id === 'kdj') return [50, 50];
    if (this.id === 'ema' || this.id === 'macd') return [NaN, NaN, NaN];
    return [0, 0];
  }

  private step(cols: ColumnView, i: number): number[] {
    const p = this.params;
    const period = Number(p.period ?? p.n);
    const a = cols.col(this.id === 'vol' ? 'volume' : 'close');
    const v = a[i];
    const s = this.state;
    const smooth = (v: number, prev: number, n: number) => Number.isNaN(prev) ? v : v * (2 / (n + 1)) + prev * (1 - 2 / (n + 1));
    switch (this.id) {
      case 'ma': case 'vol': case 'boll': {
        s[0] += v;
        s[1] += v * v;
        if (i >= period) { s[0] -= a[i - period]; s[1] -= a[i - period] ** 2; }
        const mid = i >= period - 1 ? s[0] / period : NaN;
        if (this.id !== 'boll') return [mid];
        const sd = Math.sqrt(Math.max(0, s[1] / period - mid * mid)) * Number(p.mult);
        return [mid, mid + sd, mid - sd];
      }
      case 'ema': s[0] = smooth(v, s[0], period); return [s[0]];
      case 'macd': {
        s[0] = smooth(v, s[0], Number(p.fast));
        s[1] = smooth(v, s[1], Number(p.slow));
        const dif = s[0] - s[1];
        s[2] = smooth(dif, s[2], Number(p.signal));
        return [dif, s[2], (dif - s[2]) * 2];
      }
      case 'rsi': {
        if (!i) return [NaN];
        const delta = v - a[i - 1];
        const gain = Math.max(delta, 0), loss = Math.max(-delta, 0);
        if (i <= period) { s[0] += gain / period; s[1] += loss / period; }
        else { s[0] = (s[0] * (period - 1) + gain) / period; s[1] = (s[1] * (period - 1) + loss) / period; }
        return [i < period ? NaN : s[1] === 0 ? (s[0] === 0 ? 50 : 100) : 100 - 100 / (1 + s[0] / s[1])];
      }
      case 'kdj': {
        if (i < period - 1) return [NaN, NaN, NaN];
        let hi = -Infinity, lo = Infinity;
        const high = cols.col('high'), low = cols.col('low');
        for (let j = i - period + 1; j <= i; j++) { hi = Math.max(hi, high[j]); lo = Math.min(lo, low[j]); }
        const rsv = hi === lo ? 50 : (v - lo) / (hi - lo) * 100;
        s[0] = (s[0] * (Number(p.m1) - 1) + rsv) / Number(p.m1);
        s[1] = (s[1] * (Number(p.m2) - 1) + s[0]) / Number(p.m2);
        return [s[0], s[1], 3 * s[0] - 2 * s[1]];
      }
      default: return [];
    }
  }

  private describe(): DerivedSeries[] {
    const p = this.params;
    const defs: Record<string, [string, string, 'line' | 'hist'][]> = {
      ma: [[`MA(${p.period})`, '#f5c518', 'line']],
      ema: [[`EMA(${p.period})`, '#ff9a45', 'line']],
      boll: [['MID', '#26a69a', 'line'], ['UPPER', '#8597aa', 'line'], ['LOWER', '#8597aa', 'line']],
      vol: [[`VOL-MA(${p.period})`, '#e8b10c', 'line']],
      macd: [['DIF', '#36bdb0', 'line'], ['DEA', '#ff897d', 'line'], ['MACD', '#787b86', 'hist']],
      kdj: [['K', '#638dff', 'line'], ['D', '#ff9a45', 'line'], ['J', '#d579ae', 'line']],
      rsi: [[`RSI(${p.period})`, '#ba91e2', 'line']],
    };
    return defs[this.id].map(([name, color, plot]) => ({ name, color, plot, indicatorId: this.id,
      pane: this.id === 'vol' ? 'volume' : ['ma', 'ema', 'boll'].includes(this.id) ? 'main' : 'sub',
      values: new Float64Array(0) }));
  }
}
