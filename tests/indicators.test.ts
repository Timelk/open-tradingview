import { describe, expect, it } from 'vitest';
import { boll, ema, kdj, macd, rsi, sma } from '../src/lib/indicators/calc';
import { IndicatorRegistry, registerBuiltins } from '../src/lib/indicators/registry';
import { ColumnStore } from '../src/lib/core/datastore';

const arr = (xs: number[]) => Float64Array.from(xs);

describe('indicator calcs', () => {
  it('SMA(3) 手算值与 NaN 填充', () => {
    const out = sma(arr([10, 11, 12, 13, 14]), 3);
    expect(Number.isNaN(out[0]) && Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBeCloseTo(11, 9);
    expect(out[4]).toBeCloseTo(13, 9);
  });

  it('EMA(3) 种子与递推', () => {
    const out = ema(arr([10, 11, 12, 13]), 3); // k=0.5
    expect(out[0]).toBeCloseTo(10, 9);
    expect(out[1]).toBeCloseTo(10.5, 9);
    expect(out[2]).toBeCloseTo(11.25, 9);
  });

  it('单调上涨 RSI(14) 趋 100', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 10 + i);
    const out = rsi(arr(closes), 14);
    expect(Number.isNaN(out[13])).toBe(true);
    expect(out[14]).toBeCloseTo(100, 6);
    expect(out[29]).toBeCloseTo(100, 6);
  });

  it('MACD 各线等长且 dif=fast-slow', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 10 + Math.sin(i / 3) * 5 + i * 0.2);
    const m = macd(arr(closes), 12, 26, 9);
    expect(m.dif.length).toBe(60);
    expect(m.dea.length).toBe(60);
    expect(m.hist.length).toBe(60);
    const f = ema(arr(closes), 12);
    const s = ema(arr(closes), 26);
    expect(m.dif[59]).toBeCloseTo(f[59] - s[59], 9);
    expect(m.hist[59]).toBeCloseTo((m.dif[59] - m.dea[59]) * 2, 9);
  });

  it('BOLL 上下轨对称于中轨', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 20 + Math.sin(i) * 3);
    const b = boll(arr(closes), 20, 2);
    expect(Number.isNaN(b.mid[18])).toBe(true);
    expect(Number.isFinite(b.mid[19])).toBe(true);
    expect(b.upper[30] - b.mid[30]).toBeCloseTo(b.mid[30] - b.lower[30], 9);
  });

  it('KDJ 落在 0-100 且预热后无 NaN', () => {
    const n = 40;
    const h = arr(Array.from({ length: n }, (_, i) => 10 + Math.abs(Math.sin(i)) * 5));
    const l = arr(Array.from({ length: n }, (_, i) => 10 - Math.abs(Math.cos(i)) * 3));
    const c = arr(Array.from({ length: n }, (_, i) => 10 + Math.sin(i) * 2));
    const k = kdj(h, l, c, 9, 3, 3);
    for (let i = 8; i < n; i++) {
      for (const v of [k.k[i], k.d[i], k.j[i]]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('registry', () => {
  it('保留基础指标并注册证据分析与成交指标，MA仍可端到端计算', () => {
    const reg = new IndicatorRegistry();
    registerBuiltins(reg);
    expect(reg.list().filter(d=>d.kind==='indicator').map((d) => d.id).sort()).toEqual(
      ['analysis-candles','analysis-elliott','analysis-gann','analysis-hurst','analysis-ict','analysis-order-blocks','analysis-point-figure','analysis-structure','analysis-vsa','analysis-wolfe','analysis-wyckoff','analysis-zones','boll','ema','flow-cvd','flow-delta','kdj','ma','macd','rsi','vol'],
    );
    const store = new ColumnStore(64);
    for (let i = 0; i < 40; i++) {
      store.appendBar({ time: i, open: 10, high: 12, low: 9, close: 10 + (i % 5), volume: 100 });
    }
    const def = reg.get('ma');
    const series = def.calc({ cols: store, from: 0, to: 40 }, { period: 5 });
    expect(series).toHaveLength(1);
    expect(series[0].values.length).toBe(40);
    expect(series[0].pane).toBe('main');
    expect(series[0].values[4]).toBeCloseTo((10 + 11 + 12 + 13 + 14) / 5, 9);
  });
});
