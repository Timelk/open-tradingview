import type { BarEvent, BarInput, FeedStatus } from '../core/types';
import { ColumnStore } from '../core/datastore';
import type { BulkFeed } from './feed';

export function mockSeedForSymbol(symbol:string):number {
  const known:Record<string,number>={BTCUSDT:20260904,ETHUSDT:20260905,SOLUSDT:20260906};
  if(known[symbol]!==undefined)return known[symbol];
  let seed=2166136261;
  for(const char of symbol)seed=Math.imul(seed^char.charCodeAt(0),16777619);
  return seed>>>0;
}

/** 可复现随机数，保证 demo 每次打开走势一致。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MockFeedOpts {
  symbol?: string;
  count?: number;
  intervalMs?: number;
  start?: number;
  seed?: number;
  tickMs?: number;
}

/**
 * Mock 行情：首屏批量生成 count 根（默认百万），connect 后按 tickMs 推送实时 tick。
 * 同一 Feed 接口，Controller 侧与 Binance 无差别对待。
 */
export class MockFeed implements BulkFeed {
  readonly name = 'mock';
  readonly symbol: string;
  private count: number;
  private intervalMs: number;
  private start: number;
  private seed: number;
  private tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private barCbs: ((e: BarEvent) => void)[] = [];
  private statusCbs: ((s: FeedStatus) => void)[] = [];
  private last: BarInput | null = null;
  private rand: () => number;

  constructor(opts: MockFeedOpts = {}) {
    this.symbol = opts.symbol ?? 'MOCK/USDT';
    this.count = Math.max(1, Math.floor(opts.count ?? 1_000_000));
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.start = opts.start ?? Math.floor(Date.now() / this.intervalMs) * this.intervalMs - (this.count - 1) * this.intervalMs;
    this.seed = opts.seed ?? 20260904;
    this.tickMs = opts.tickMs ?? 100;
    this.rand = mulberry32(this.seed);
  }

  onBar(cb: (e: BarEvent) => void): void {
    this.barCbs.push(cb);
  }

  onStatus(cb: (s: FeedStatus) => void): void {
    this.statusCbs.push(cb);
  }

  private emitStatus(s: FeedStatus): void {
    this.statusCbs.forEach((cb) => cb(s));
  }

  /** Generate straight into typed columns; avoid a million temporary objects. */
  loadStore(): ColumnStore {
    const store = new ColumnStore(this.count + 65536);
    this.generate(bar => store.appendBar(bar));
    return store;
  }

  loadBulk(): BarInput[] {
    const out: BarInput[] = [];
    this.generate(bar => out.push(bar));
    return out;
  }

  private generate(emit: (bar: BarInput) => void): void {
    this.rand = mulberry32(this.seed);

    let price = 50000;
    for (let i = 0; i < this.count; i++) {
      const drift = (this.rand() - 0.5) * 0.004;
      const open = price;
      const close = open * (1 + drift);
      const high = Math.max(open, close) * (1 + this.rand() * 0.001);
      const low = Math.min(open, close) * (1 - this.rand() * 0.001);
      const volume = 50 + this.rand() * 950;
      const bar = { time: this.start + i * this.intervalMs, open, high, low, close, volume };
      emit(bar);
      if (i === this.count - 1) this.last = { ...bar };
      price = close;
    }

  }

  async connect(): Promise<void> {
    this.emitStatus('ok');
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  disconnect(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Simulated ticks update the open candle; new candles follow wall-clock intervals. */
  private tick(): void {
    if (!this.last) return;
    const r = this.rand;
    const bucket=Math.floor(Date.now()/this.intervalMs)*this.intervalMs;
    if (bucket > this.last.time) {
      const open = this.last.close;
      const close = open * (1 + (r() - 0.5) * 0.002);
      this.last = {
        time: bucket,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: r() * 200,
      };
      this.barCbs.forEach((cb) => cb({ ...this.last!, isNew: true }));
    } else {
      const close = this.last.close * (1 + (r() - 0.5) * 0.001);
      this.last.close = close;
      if (close > this.last.high) this.last.high = close;
      if (close < this.last.low) this.last.low = close;
      this.last.volume += r() * 20;
      this.barCbs.forEach((cb) => cb({ ...this.last!, isNew: false }));
    }
  }
}
