import type { WatchlistDocument } from './types';
import { DEFAULT_SYMBOLS, normalizePerpetualSymbol } from './symbols';
import { normalizeCnAShareSymbol } from '../market/connectors';

function normalizeSymbol(input: string): string | null {
  const perp = normalizePerpetualSymbol(input);
  if (perp) return perp;
  const cn = normalizeCnAShareSymbol(input);
  if (cn) return cn;
  if (typeof input === 'string') {
    const raw = input.trim().toUpperCase().replace(/^COINBASE:/, '');
    const m = /^([A-Z0-9]{2,12})-(USD|USDC)$/.exec(raw);
    if (m) return `${m[1]}-${m[2]}`;
  }
  return null;
}

export const WATCHLIST_STORAGE_KEY = 'tvchart.watchlists.usdm-perpetual.v1';
const MAX_LISTS = 12, MAX_SYMBOLS = 100, MAX_HISTORY = 50;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type Subscriber = (document: WatchlistDocument) => void;
const copy = (doc: WatchlistDocument): WatchlistDocument => ({
  version: 1, activeId: doc.activeId,
  lists: doc.lists.map(list => ({ id: list.id, name: list.name, symbols: [...list.symbols] })),
});
const defaults = (): WatchlistDocument => ({
  version: 1, activeId: 'default',
  lists: [{ id: 'default', name: '自选列表', symbols: DEFAULT_SYMBOLS.map(item => item.symbol) }],
});
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function listName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && Array.from(name).length <= 40 ? name : null;
}

/** Validate atomically before accepting saved or remote state. Return a plain,
 * canonical document, without retaining references to the untrusted input. */
function parse(raw: string): WatchlistDocument | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!record(value) || value.version !== 1 || typeof value.activeId !== 'string'
    || !Array.isArray(value.lists) || !value.lists.length || value.lists.length > MAX_LISTS) return null;
  const ids = new Set<string>(), lists: WatchlistDocument['lists'] = [];
  for (const item of value.lists) {
    if (!record(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 128
      || ids.has(item.id) || !Array.isArray(item.symbols) || item.symbols.length > MAX_SYMBOLS) return null;
    const name = listName(item.name);
    if (!name) return null;
    const symbols = new Set<string>();
    for (const input of item.symbols) {
      if (typeof input !== 'string') return null;
      const symbol = normalizeSymbol(input);
      if (!symbol) return null;
      symbols.add(symbol);
    }
    ids.add(item.id); lists.push({ id: item.id, name, symbols: [...symbols] });
  }
  return ids.has(value.activeId) ? { version: 1, activeId: value.activeId, lists } : null;
}

/** Watchlist changes are committed as whole documents. Market quotes have a
 * separate lifecycle and never enter this persistent, undoable state. */
export class WatchlistStore {
  private document = defaults();
  private history: WatchlistDocument[] = [];
  private subscribers = new Set<Subscriber>();
  private storage: StoragePort | null = null;
  private eventTarget: Window | null = null;
  private unavailable = false;
  private destroyed = false;
  private serial = 0;
  private message = '';

  constructor(storage?: StoragePort | null) {
    try {
      this.storage = storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : storage;
    } catch {
      this.unavailable = true;
      this.message = '浏览器存储不可用，自选列表暂时只保存在当前页面。';
    }
    if (this.storage) {
      try {
        const raw = this.storage.getItem(WATCHLIST_STORAGE_KEY);
        if (raw !== null) {
          const saved = parse(raw);
          if (saved) this.document = saved;
          else this.message = '已保存的自选列表格式无效，已使用默认列表，原记录尚未覆盖。';
        }
      } catch {
        this.message = '无法读取已保存的自选列表，当前使用默认列表。';
      }
      if (typeof window !== 'undefined') {
        this.eventTarget = window;
        window.addEventListener('storage', this.onStorage);
      }
    }
  }

  get snapshot(): WatchlistDocument { return copy(this.document); }
  get canUndo(): boolean { return this.history.length > 0; }
  get error(): string { return this.message; }

  subscribe(fn: Subscriber): () => void {
    if (this.destroyed) return () => {};
    this.subscribers.add(fn); fn(this.snapshot);
    return () => { this.subscribers.delete(fn); };
  }

  add(input: string): boolean {
    if (this.destroyed) return false;
    const symbol = normalizeSymbol(input);
    if (!symbol) return this.reject('请输入有效的 USDT 本位永续合约。');
    const next = this.snapshot, list = next.lists.find(item => item.id === next.activeId)!;
    if (list.symbols.includes(symbol)) return this.reject('该品种已在当前自选列表中。');
    if (list.symbols.length >= MAX_SYMBOLS) return this.reject('每个自选列表最多添加 100 个品种。');
    list.symbols.push(symbol); return this.commit(next);
  }

  remove(input: string): boolean {
    if (this.destroyed) return false;
    const symbol = normalizeSymbol(input), next = this.snapshot;
    const list = next.lists.find(item => item.id === next.activeId)!;
    const index = symbol ? list.symbols.indexOf(symbol) : -1;
    if (index < 0) return this.reject('当前自选列表中没有该品种。');
    list.symbols.splice(index, 1); return this.commit(next);
  }

  move(input: string, beforeInput: string | null): boolean {
    if (this.destroyed) return false;
    const symbol = normalizeSymbol(input), before = beforeInput === null ? null : normalizeSymbol(beforeInput);
    const next = this.snapshot, list = next.lists.find(item => item.id === next.activeId)!;
    if (!symbol || !list.symbols.includes(symbol) || (beforeInput !== null && (!before || !list.symbols.includes(before))))
      return this.reject('无法排序：品种已不在当前自选列表中。');
    if (symbol === before) return this.reject('');
    const original = list.symbols.join(',');
    list.symbols.splice(list.symbols.indexOf(symbol), 1);
    list.symbols.splice(before === null ? list.symbols.length : list.symbols.indexOf(before), 0, symbol);
    if (original === list.symbols.join(',')) return this.reject('');
    return this.commit(next);
  }

  create(input: string): string | null {
    if (this.destroyed) return null;
    const name = listName(input);
    if (!name) { this.reject('列表名称不能为空，且最多 40 个字符。'); return null; }
    if (this.document.lists.length >= MAX_LISTS) { this.reject('最多创建 12 个自选列表。'); return null; }
    const next = this.snapshot;
    let id: string;
    do { id = `watchlist-${Date.now().toString(36)}-${++this.serial}-${Math.random().toString(36).slice(2, 9)}`; }
    while (next.lists.some(list => list.id === id));
    next.lists.push({ id, name, symbols: [] }); next.activeId = id;
    this.commit(next); return id;
  }

  rename(id: string, input: string): boolean {
    if (this.destroyed) return false;
    const name = listName(input);
    if (!name) return this.reject('列表名称不能为空，且最多 40 个字符。');
    const next = this.snapshot, list = next.lists.find(item => item.id === id);
    if (!list) return this.reject('自选列表不存在。');
    if (list.name === name) return this.reject('');
    list.name = name; return this.commit(next);
  }

  deleteList(id: string): boolean {
    if (this.destroyed) return false;
    const next = this.snapshot, index = next.lists.findIndex(list => list.id === id);
    if (index < 0) return this.reject('自选列表不存在。');
    if (next.lists.length === 1) return this.reject('至少需要保留一个自选列表。');
    next.lists.splice(index, 1);
    if (next.activeId === id) next.activeId = next.lists[Math.min(index, next.lists.length - 1)].id;
    return this.commit(next);
  }

  selectList(id: string): boolean {
    if (this.destroyed) return false;
    if (!this.document.lists.some(list => list.id === id)) return this.reject('自选列表不存在。');
    if (this.document.activeId === id) return this.reject('');
    const next = this.snapshot; next.activeId = id;
    return this.commit(next, false);
  }

  undo(): boolean {
    if (this.destroyed) return false;
    const previous = this.history.pop();
    if (!previous) return this.reject('没有可以撤销的操作。');
    // Changing tabs is navigation, so retain it if the restored group exists.
    if (previous.lists.some(list => list.id === this.document.activeId)) previous.activeId = this.document.activeId;
    return this.commit(previous, false);
  }

  destroy(): void {
    this.destroyed = true; this.subscribers.clear(); this.history = [];
    this.eventTarget?.removeEventListener('storage', this.onStorage); this.eventTarget = null;
  }

  private commit(next: WatchlistDocument, undoable = true): boolean {
    if (undoable) {
      this.history.push(this.document);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    this.document = next;
    try {
      this.storage?.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next));
      this.message = this.unavailable ? '浏览器存储不可用，自选列表暂时只保存在当前页面。' : '';
    } catch {
      this.message = '自选列表保存失败，更改暂时保留在当前页面。';
    }
    this.emit(); return true;
  }

  private reject(message: string): false { this.message = message; this.emit(); return false; }
  private emit(): void { for (const fn of this.subscribers) fn(this.snapshot); }
  private onStorage = (event: StorageEvent): void => {
    if (this.destroyed || event.key !== WATCHLIST_STORAGE_KEY || event.newValue === null
      || (event.storageArea !== null && event.storageArea !== undefined && event.storageArea !== this.storage)) return;
    const incoming = parse(event.newValue);
    if (!incoming) { this.reject('其他页面的自选列表更新格式无效，已保留当前列表。'); return; }
    this.document = incoming; this.history = []; this.message = ''; this.emit();
  };
}
