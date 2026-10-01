import { normalizePerpetualSymbol as normalizeSymbol } from './symbols';
import {BINANCE_FUTURES_REST,BINANCE_FUTURES_STREAM} from '../market/binance-contracts';
import type { TickerQuote, WatchlistQuoteSnapshot } from './types';
export type { WatchlistQuoteSnapshot } from './types';

export const WATCHLIST_QUOTE_STALE_MS = 45000;
const REST = `${BINANCE_FUTURES_REST}/fapi/v1/ticker/24hr`;
const STREAM = `${BINANCE_FUTURES_STREAM}/stream?streams=`;
const number = (value: unknown) => typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
function ticker(row: Record<string, unknown>, stream: boolean): TickerQuote | null {
  const symbol = typeof row[stream ? 's' : 'symbol'] === 'string' ? normalizeSymbol(row[stream ? 's' : 'symbol'] as string) : null;
  if (!symbol) return null;
  const quote: TickerQuote = {
    symbol, last: number(row[stream ? 'c' : 'lastPrice']), change: number(row[stream ? 'p' : 'priceChange']),
    changePercent: number(row[stream ? 'P' : 'priceChangePercent']), high: number(row[stream ? 'h' : 'highPrice']),
    low: number(row[stream ? 'l' : 'lowPrice']), volume: number(row[stream ? 'v' : 'volume']),
    quoteVolume: number(row[stream ? 'q' : 'quoteVolume']), updatedAt: number(row[stream ? 'E' : 'closeTime']),
  };
  if (!Object.values(quote).every(value => typeof value === 'string' || Number.isFinite(value))) return null;
  if (quote.last <= 0 || quote.low < 0 || quote.high < quote.low || quote.volume < 0 || quote.quoteVolume < 0 || quote.updatedAt < 0) return null;
  return quote;
}

/** USDⓈ-M rolling 24h statistics plus the routed combined ticker stream.
 * Futures REST accepts one symbol or all symbols, not the SPOT symbols array. */
export class WatchlistQuotes {
  private symbols: string[] = [];
  private quotes: Record<string, TickerQuote> = {};
  private listeners = new Set<(snapshot: WatchlistQuoteSnapshot) => void>();
  private epoch = 0;
  private dead = false;
  private configured = false;
  private pending = false;
  private requesting = false;
  private problem = '';
  private disconnected = false;
  private retryCount = 0;
  private requestFailures = 0;
  private lastMessage = 0;
  private streamStarted = 0;
  private ws: WebSocket | null = null;
  private aborter = new AbortController();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  get snapshot(): WatchlistQuoteSnapshot {
    const now = Date.now(), available = this.symbols.filter(symbol => this.quotes[symbol]);
    const incomplete = available.length !== this.symbols.length;
    const expired = available.some(symbol => now - this.quotes[symbol].updatedAt > WATCHLIST_QUOTE_STALE_MS);
    let status: WatchlistQuoteSnapshot['status'] = this.configured ? 'live' : 'loading';
    if (this.symbols.length && !available.length) status = this.pending ? 'loading' : 'error';
    else if (incomplete || expired || this.disconnected) status = 'stale';
    return {
      quotes: Object.fromEntries(available.map(symbol => [symbol, {...this.quotes[symbol]}])), status,
      error: status === 'live' || status === 'loading' ? '' : this.problem || (incomplete ? '部分品种暂无报价，请检查是否仍为可交易的 USDT 永续合约。' : '报价暂未更新，正在重新连接。'),
    };
  }
  subscribe(listener: (snapshot: WatchlistQuoteSnapshot) => void): () => void {
    if (this.dead) return () => {};
    this.listeners.add(listener); listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }
  setSymbols(symbols: string[]): void {
    if (this.dead) return;
    const normalized = [...new Set(symbols.map(normalizeSymbol).filter((symbol): symbol is string => !!symbol))].slice(0, 100);
    if (this.configured && [...normalized].sort().join('|') === [...this.symbols].sort().join('|')) return;
    this.configured = true;
    this.symbols = normalized;
    this.quotes = Object.fromEntries(normalized.filter(symbol => this.quotes[symbol]).map(symbol => [symbol, this.quotes[symbol]]));
    this.start();
  }
  retry(): void { if (!this.dead) this.start(); }
  destroy(): void { this.dead = true; this.stop(); this.listeners.clear(); }

  private start(): void {
    this.stop(); const epoch = this.epoch;
    this.aborter = new AbortController(); this.problem = ''; this.disconnected = !!this.symbols.length; this.retryCount = 0; this.requestFailures = 0; this.lastMessage = 0;
    this.pending = !!this.symbols.length; this.emit();
    if (!this.symbols.length) return;
    void this.refresh(epoch); this.openStream(epoch);
    this.staleTimer = setInterval(() => {
      if (epoch !== this.epoch || this.dead) return;
      if (this.ws && Date.now() - (this.lastMessage || this.streamStarted) > WATCHLIST_QUOTE_STALE_MS) this.loseStream(this.ws, epoch);
      this.emit();
    }, 5000);
  }
  private stop(): void {
    this.epoch++; this.aborter.abort(); this.pending = false; this.requesting = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.pollTimer = this.retryTimer = this.connectionTimer = this.staleTimer = this.emitTimer = null;
    this.closeSocket();
  }
  private closeSocket(): void {
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); }
  }
  private emit(): void {
    if (this.dead) return;
    if (this.emitTimer) clearTimeout(this.emitTimer); this.emitTimer = null;
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
  private queueEmit(): void { if (!this.emitTimer) this.emitTimer = setTimeout(() => this.emit(), 100); }
  private accept(quote: TickerQuote): void {
    if (!this.symbols.includes(quote.symbol) || quote.updatedAt < (this.quotes[quote.symbol]?.updatedAt ?? -1)) return;
    this.quotes[quote.symbol] = quote;
  }
  private schedulePoll(epoch: number, delay: number): void {
    if (this.dead || epoch !== this.epoch) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => { this.pollTimer = null; void this.refresh(epoch); }, delay);
  }
  private async requestBatch(symbols: string[], signal: AbortSignal): Promise<TickerQuote[]> {
    const url=symbols.length===1?`${REST}?${new URLSearchParams({symbol:symbols[0]})}`:REST;
    const response = await fetch(url, {signal});
    if (!response.ok) throw new Error(`Binance 永续合约 24 小时报价暂不可用（HTTP ${response.status}）`);
    const data: unknown = await response.json();
    const rows=Array.isArray(data)?data:data&&typeof data==='object'&&'symbol' in data?[data]:null;
    if (!rows) throw new Error('Binance 永续合约报价格式无效');
    return rows.flatMap(row => {
      if (!row || typeof row !== 'object') return [];
      const quote = ticker(row, false);
      return quote && symbols.includes(quote.symbol) ? [quote] : [];
    });
  }
  private async refresh(epoch: number): Promise<void> {
    if (this.dead || epoch !== this.epoch || !this.symbols.length) return;
    if (this.requesting) { this.schedulePoll(epoch, 1000); return; }
    this.pending = true; this.requesting = true;
    const symbols = [...this.symbols], timeout = AbortSignal.timeout(12000), signal = AbortSignal.any([this.aborter.signal, timeout]);
    const batches: string[][] = [];
    // Single-symbol requests cost 1 each; one all-symbol request costs 40.
    // Keep small lists scoped, and use one exchange snapshot for larger lists.
    if(symbols.length<=20)for(const symbol of symbols)batches.push([symbol]);else batches.push(symbols);
    const results = await Promise.allSettled(batches.map(batch => this.requestBatch(batch, signal)));
    if (this.dead || epoch !== this.epoch) return;
    this.pending = false; this.requesting = false;
    let accepted = 0, failure = '';
    for (const result of results) {
      if (result.status === 'fulfilled') { for (const quote of result.value) this.accept(quote); accepted += result.value.length; }
      else failure = result.reason instanceof Error ? result.reason.message : 'Binance 报价连接失败';
    }
    if (accepted) {
      this.requestFailures = 0; this.disconnected = false;
      this.problem = accepted < symbols.length ? failure || '部分品种未返回有效的永续合约报价。' : '';
    } else {
      this.requestFailures++; this.problem = failure || 'Binance 未返回有效的永续合约报价。';
      this.disconnected = !this.lastMessage || Date.now() - this.lastMessage > 10000;
    }
    this.emit();
    this.schedulePoll(epoch, accepted ? 30000 : Math.min(5000 * 2 ** Math.min(this.requestFailures - 1, 4), 60000));
  }
  private openStream(epoch: number): void {
    if (this.dead || epoch !== this.epoch || !this.symbols.length || this.ws) return;
    let ws: WebSocket;
    try { ws = new WebSocket(STREAM + this.symbols.map(symbol => `${symbol.toLowerCase()}@ticker`).join('/')); }
    catch { this.reconnect(epoch); return; }
    this.ws = ws; this.streamStarted = Date.now();
    this.connectionTimer = setTimeout(() => this.loseStream(ws, epoch), 12000);
    ws.onopen = () => {
      if (epoch !== this.epoch || this.ws !== ws) return;
      if (this.connectionTimer) clearTimeout(this.connectionTimer); this.connectionTimer = null;
    };
    ws.onmessage = event => {
      if (epoch !== this.epoch || this.ws !== ws || this.dead) return;
      try {
        const message: unknown = JSON.parse(String(event.data));
        if (!message || typeof message !== 'object') return;
        const row = 'data' in message ? message.data : message;
        if (!row || typeof row !== 'object' || !('e' in row) || row.e !== '24hrTicker') return;
        const quote = ticker(row as Record<string, unknown>, true);
        if (!quote || !this.symbols.includes(quote.symbol)) return;
        this.accept(quote); this.lastMessage = Date.now(); this.retryCount = 0; this.disconnected = false; this.problem = ''; this.queueEmit();
      } catch { /* An invalid stream packet does not erase the latest verified quote. */ }
    };
    ws.onerror = ws.onclose = () => this.loseStream(ws, epoch);
  }
  private loseStream(ws: WebSocket, epoch: number): void {
    if (this.dead || epoch !== this.epoch || this.ws !== ws) return;
    if (this.connectionTimer) clearTimeout(this.connectionTimer); this.connectionTimer = null;
    this.closeSocket(); this.disconnected = true; this.problem = '实时报价连接中断，正在重连并通过公开接口刷新。'; this.emit();
    this.schedulePoll(epoch, 1000); this.reconnect(epoch);
  }
  private reconnect(epoch: number): void {
    if (this.dead || epoch !== this.epoch || this.retryTimer) return;
    const delay = Math.min(1000 * 2 ** Math.min(this.retryCount++, 5), 30000);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.openStream(epoch); }, delay);
  }
}
