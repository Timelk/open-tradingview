import type { ColumnView, DerivedSeries, IndicatorDef, IncrementalCalculator, ParamValues } from '../core/types';
import { ema, rsi, sma } from './calc';
import { BuiltinCalculator } from './incremental';

type Strategy = 'ma-cross' | 'rsi-reversal';
interface Parameters { fast:number;slow:number;period:number;lower:number;upper:number;method:'EMA'|'SMA' }
const bounded = (value: unknown, fallback: number, min: number, max: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
function parameters(values: ParamValues): Parameters {
  return {
    fast: Math.round(bounded(values.fast, 9, 1, 500)),
    slow: Math.round(bounded(values.slow, 21, 2, 1000)),
    period: Math.round(bounded(values.period, 14, 1, 200)),
    lower: bounded(values.lower, 30, 0, 49), upper: bounded(values.upper, 70, 51, 100),
    method: values.method === 'SMA' ? 'SMA' : 'EMA',
  };
}
function signals(length: number, crossing = false): DerivedSeries[] {
  return (['buy', 'sell'] as const).map(side => ({
    name: side === 'buy' ? '买入' : '卖出', markerSide: side,
    color: side === 'buy' ? '#26a69a' : '#ef5350', pane: 'main', plot: 'markers',
    values: new Float64Array(length).fill(NaN),
    ...(crossing?{markerOffsets:new Float64Array(length).fill(NaN),markerValues:new Float64Array(length).fill(NaN)}:{}),
  }));
}

/** A signal is placed on its confirmation bar i, at the previous close price.
 * The current open candle never participates, so replacing it cannot repaint
 * a signal; the worker only needs to send a patch for the new last bar. */
function writeSignals(kind: Strategy, p: Parameters, cols: ColumnView, inputs: Float64Array[], out: DerivedSeries[], start: number): void {
  const close = cols.col('close'), [buy, sell] = out;
  for (let i = start; i < cols.length; i++) {
    buy.values[i] = NaN; sell.values[i] = NaN;
    for(const series of out){if(series.markerOffsets)series.markerOffsets[i]=NaN;if(series.markerValues)series.markerValues[i]=NaN;}
    const at = i - 1;
    if (at < 1) continue;
    let before: number, current: number;
    if (kind === 'ma-cross') {
      if (at < Math.max(p.fast, p.slow)) continue;
      before = inputs[0][at - 1] - inputs[1][at - 1]; current = inputs[0][at] - inputs[1][at];
      if (!Number.isFinite(before) || !Number.isFinite(current)) continue;
      const signal=before<=0&&current>0?buy:before>=0&&current<0?sell:null;
      if(signal){
        signal.values[i]=close[at];
        // The display anchor lies on the two completed MA segments. Keep the
        // confirmation index and its previous-close value untouched.
        const alpha=before/(before-current),value=inputs[0][at-1]*(1-alpha)+inputs[0][at]*alpha;
        if(Number.isFinite(alpha)&&alpha>=0&&alpha<=1&&Number.isFinite(value)){
          signal.markerOffsets![i]=alpha-2;signal.markerValues![i]=value;
        }
      }
    } else {
      before = inputs[0][at - 1]; current = inputs[0][at];
      if (!Number.isFinite(before) || !Number.isFinite(current)) continue;
      if (before <= p.lower && current > p.lower) buy.values[i] = close[at];
      if (before >= p.upper && current < p.upper) sell.values[i] = close[at];
    }
  }
}

class StrategyCalculator implements IncrementalCalculator {
  private readonly p: Parameters;
  private readonly runners: BuiltinCalculator[];
  private output: DerivedSeries[] = [];
  private length = 0;
  constructor(private kind: Strategy, values: ParamValues) {
    this.p = parameters(values);
    const p = this.p;
    this.runners = kind === 'ma-cross'
      ? [p.fast, p.slow].map(period => new BuiltinCalculator(p.method === 'SMA' ? 'ma' : 'ema', {period}))
      : [new BuiltinCalculator('rsi', {period: p.period})];
  }
  update(cols: ColumnView, from: number): DerivedSeries[] {
    const reset = !this.output.length || from < this.length - 1 || cols.length < this.length;
    const start = reset ? 0 : Math.min(from, this.length);
    if (reset) { this.output = signals(0,this.kind==='ma-cross'); this.length = 0; }
    for (const series of this.output) for(const field of ['values','markerOffsets','markerValues'] as const){
      const values=series[field];if(!values||values.length>=cols.length)continue;
      const next = new Float64Array(Math.max(cols.length + 1024, values.length * 2)).fill(NaN);
      next.set(values); series[field] = next;
    }
    const closed: ColumnView = {length: Math.max(0, cols.length - 1), col: name => cols.col(name)};
    const inputs = this.runners.map(runner => runner.update(closed, reset ? 0 : Math.min(from, closed.length))[0].values);
    writeSignals(this.kind, this.p, cols, inputs, this.output, start);
    this.length = cols.length;
    return this.output;
  }
}

function calculate(kind: Strategy, cols: ColumnView, values: ParamValues): DerivedSeries[] {
  const p = parameters(values), close = cols.col('close').subarray(0, Math.max(0, cols.length - 1));
  const method = p.method === 'SMA' ? sma : ema;
  const inputs = kind === 'ma-cross' ? [method(close, p.fast), method(close, p.slow)] : [rsi(close, p.period)];
  const out = signals(cols.length,kind==='ma-cross');
  writeSignals(kind, p, cols, inputs, out, 0);
  return out;
}

export function builtinStrategies(): IndicatorDef[] {
  return [{
    id: 'strategy-ma-cross', name: '均线交叉', kind: 'strategy', source: 'builtin',
    title: '双均线交叉', description: '快均线上穿慢均线提示买入，下穿提示卖出。已收盘后在下一根确认；当前周期提示定位到均线交点，仅生成信号。',
    tags: ['趋势', '均线', '交叉', '已收盘'], target: 'main',
    inputs: [
      {key: 'method', label: '均线类型', type: 'select', def: 'EMA', options: ['EMA', 'SMA']},
      {key: 'fast', label: '快线周期', type: 'int', def: 9, min: 1, max: 500, step: 1},
      {key: 'slow', label: '慢线周期', type: 'int', def: 21, min: 2, max: 1000, step: 1},
    ],
    calc: (ctx, p) => calculate('ma-cross', ctx.cols, p),
    createIncremental: p => new StrategyCalculator('ma-cross', p),
  }, {
    id: 'strategy-rsi-reversal', name: 'RSI 回归', kind: 'strategy', source: 'builtin',
    title: 'RSI 阈值回归', description: 'RSI 从超卖区上穿下阈值提示买入，从超买区下穿上阈值提示卖出。已收盘后在下一根确认，仅生成信号。',
    tags: ['震荡', 'RSI', '超买超卖', '已收盘'], target: 'main',
    inputs: [
      {key: 'period', label: 'RSI 周期', type: 'int', def: 14, min: 1, max: 200, step: 1},
      {key: 'lower', label: '超卖阈值', type: 'float', def: 30, min: 0, max: 49, step: 1},
      {key: 'upper', label: '超买阈值', type: 'float', def: 70, min: 51, max: 100, step: 1},
    ],
    calc: (ctx, p) => calculate('rsi-reversal', ctx.cols, p),
    createIncremental: p => new StrategyCalculator('rsi-reversal', p),
  }];
}
