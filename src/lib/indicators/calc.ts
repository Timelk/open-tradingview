/**
 * 指标纯函数：输入 Float64Array，输出等长 Float64Array，NaN=无值。
 * 刻意保持无状态、可序列化——Worker 与远期 DSL 解释器都能直接调用。
 */

export function sma(values: Float64Array, period: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  if (period <= 0 || n < period) return out;
  let sum = 0;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isNaN(v)) bad++;
    else sum += v;
    if (i >= period) {
      const o = values[i - period];
      if (Number.isNaN(o)) bad--;
      else sum -= o;
    }
    if (i >= period - 1 && bad === 0) out[i] = sum / period;
  }
  return out;
}

export function ema(values: Float64Array, period: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  if (period <= 0 || n === 0) return out;
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isNaN(v)) {
      out[i] = NaN;
      continue;
    }
    prev = Number.isNaN(prev) ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export interface BollResult {
  mid: Float64Array;
  upper: Float64Array;
  lower: Float64Array;
}

export function boll(values: Float64Array, period: number, mult: number): BollResult {
  const n = values.length;
  const mid = new Float64Array(n).fill(NaN);
  const upper = new Float64Array(n).fill(NaN);
  const lower = new Float64Array(n).fill(NaN);
  if (period <= 0 || n < period) return { mid, upper, lower };
  let sum = 0;
  let sumSq = 0;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isNaN(v)) bad++;
    else {
      sum += v;
      sumSq += v * v;
    }
    if (i >= period) {
      const o = values[i - period];
      if (Number.isNaN(o)) bad--;
      else {
        sum -= o;
        sumSq -= o * o;
      }
    }
    if (i >= period - 1 && bad === 0) {
      const m = sum / period;
      const variance = Math.max(0, sumSq / period - m * m);
      const sd = Math.sqrt(variance);
      mid[i] = m;
      upper[i] = m + mult * sd;
      lower[i] = m - mult * sd;
    }
  }
  return { mid, upper, lower };
}

/** Wilder RSI：全涨→100，全跌→0，全平→50。 */
export function rsi(values: Float64Array, period: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  if (period <= 0 || n <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiFrom(avgGain, avgLoss);
  for (let i = period + 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  dif: Float64Array;
  dea: Float64Array;
  hist: Float64Array;
}

export function macd(
  values: Float64Array,
  fast: number,
  slow: number,
  signal: number,
): MacdResult {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const n = values.length;
  const dif = new Float64Array(n);
  for (let i = 0; i < n; i++) dif[i] = f[i] - s[i];
  const dea = ema(dif, signal);
  const hist = new Float64Array(n);
  for (let i = 0; i < n; i++) hist[i] = (dif[i] - dea[i]) * 2;
  return { dif, dea, hist };
}

export interface KdjResult {
  k: Float64Array;
  d: Float64Array;
  j: Float64Array;
}

/** KDJ：K/D 递归平滑初值 50，平盘（HHV=LLV）时 RSV 取中性 50。 */
export function kdj(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period: number,
  m1: number,
  m2: number,
): KdjResult {
  const n = close.length;
  const k = new Float64Array(n).fill(NaN);
  const d = new Float64Array(n).fill(NaN);
  const j = new Float64Array(n).fill(NaN);
  if (period <= 0 || n < period) return { k, d, j };
  let pk = 50;
  let pd = 50;
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let q = i - period + 1; q <= i; q++) {
      if (high[q] > hh) hh = high[q];
      if (low[q] < ll) ll = low[q];
    }
    const rsv = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
    pk = (pk * (m1 - 1) + rsv) / m1;
    pd = (pd * (m2 - 1) + pk) / m2;
    k[i] = pk;
    d[i] = pd;
    j[i] = 3 * pk - 2 * pd;
  }
  return { k, d, j };
}
