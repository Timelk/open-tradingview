import { afterEach, describe, expect, it, vi } from 'vitest';
import { WatchlistStore, WATCHLIST_STORAGE_KEY } from '../src/lib/watchlist/store';
import type { WatchlistDocument } from '../src/lib/watchlist/types';

class MemoryStorage {
  values = new Map<string, string>();
  getItem = vi.fn((key: string) => this.values.get(key) ?? null);
  setItem = vi.fn((key: string, value: string) => { this.values.set(key, value); });
}
const stores: WatchlistStore[] = [];
const createStore = (storage: MemoryStorage | null = null) => {
  const store = new WatchlistStore(storage); stores.push(store); return store;
};
const activeSymbols = (store: WatchlistStore) => {
  const document = store.snapshot;
  return document.lists.find(list => list.id === document.activeId)!.symbols;
};
const documentOf = (symbols = ['BTCUSDT']): WatchlistDocument => ({
  version: 1, activeId: 'remote', lists: [{ id: 'remote', name: '远端列表', symbols }],
});
function storageEvent(target: EventTarget, value: string | null, storage: MemoryStorage, key = WATCHLIST_STORAGE_KEY): void {
  const event = new Event('storage');
  Object.defineProperties(event, {
    key: { value: key }, newValue: { value }, storageArea: { value: storage },
  });
  target.dispatchEvent(event);
}
afterEach(() => {
  stores.splice(0).forEach(store => store.destroy());
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('watchlist editing and history', () => {
  it('starts with three USDT perpetual symbols and normalizes, deduplicates, removes and reorders the active group', () => {
    const storage = new MemoryStorage(), store = createStore(storage);
    expect(store.snapshot).toEqual({ version: 1, activeId: 'default', lists: [
      { id: 'default', name: '自选列表', symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] },
    ] });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(store.add('  btc/usdt  ')).toBe(false);
    expect(store.add(' ada-usdt ')).toBe(true);
    expect(store.add('ADAUSDT')).toBe(false);
    expect(store.move('ada/usdt', 'ethusdt')).toBe(true);
    expect(activeSymbols(store)).toEqual(['BTCUSDT', 'ADAUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(store.move('BTCUSDT', null)).toBe(true);
    expect(activeSymbols(store)).toEqual(['ADAUSDT', 'ETHUSDT', 'SOLUSDT', 'BTCUSDT']);
    expect(store.remove('eth-usdt')).toBe(true);
    expect(activeSymbols(store)).toEqual(['ADAUSDT', 'SOLUSDT', 'BTCUSDT']);
    expect(JSON.parse(storage.values.get(WATCHLIST_STORAGE_KEY)!)).toEqual(store.snapshot);
  });

  it('supports independent groups, automatically selects newly created groups and protects the final group', () => {
    const store = createStore();
    const id = store.create('  重点观察  ')!;
    expect(id).toBeTruthy(); expect(store.snapshot.activeId).toBe(id);
    expect(activeSymbols(store)).toEqual([]);
    expect(store.add('ADAUSDT')).toBe(true);
    expect(store.rename(id, '  近期机会  ')).toBe(true);
    expect(store.snapshot.lists.find(list => list.id === id)?.name).toBe('近期机会');
    expect(store.selectList('default')).toBe(true);
    expect(activeSymbols(store)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(store.deleteList('default')).toBe(true);
    expect(store.snapshot.activeId).toBe(id); expect(activeSymbols(store)).toEqual(['ADAUSDT']);
    expect(store.deleteList(id)).toBe(false);
    expect(store.snapshot.lists).toHaveLength(1);
  });

  it('selection is saved without taking an undo step and undo preserves valid current navigation', () => {
    const storage = new MemoryStorage(), store = createStore(storage);
    const id = store.create('第二组')!;
    store.add('ADAUSDT'); store.selectList('default');
    expect(JSON.parse(storage.values.get(WATCHLIST_STORAGE_KEY)!).activeId).toBe('default');
    expect(store.undo()).toBe(true);
    expect(store.snapshot.activeId).toBe('default');
    expect(store.snapshot.lists.find(list => list.id === id)?.symbols).toEqual([]);
    expect(store.undo()).toBe(true);
    expect(store.snapshot.lists).toHaveLength(1); expect(store.canUndo).toBe(false);
    expect(store.undo()).toBe(false);
  });

  it('undo restores sorting, deletion and names as complete atomic edits', () => {
    const store = createStore();
    const initial = store.snapshot;
    store.move('SOLUSDT', 'BTCUSDT'); store.undo(); expect(store.snapshot).toEqual(initial);
    store.remove('ETHUSDT'); store.undo(); expect(store.snapshot).toEqual(initial);
    store.rename('default', '新名称'); store.undo(); expect(store.snapshot).toEqual(initial);
    const id = store.create('独立组')!; store.add('ADAUSDT'); store.selectList('default');
    const beforeDelete = store.snapshot;
    store.deleteList(id); store.undo(); expect(store.snapshot).toEqual(beforeDelete);
  });

  it('limits history to the latest 50 successful edits', () => {
    const store = createStore();
    for (let i = 0; i < 60; i++) expect(store.add(`TOKEN${i}USDT`)).toBe(true);
    for (let i = 0; i < 50; i++) expect(store.undo()).toBe(true);
    expect(store.canUndo).toBe(false); expect(store.undo()).toBe(false);
    expect(activeSymbols(store)).toHaveLength(13);
    expect(activeSymbols(store).at(-1)).toBe('TOKEN9USDT');
  });

  it('rejects invalid operations without modifying history and emits their errors to subscribers', () => {
    const store = createStore(), listener = vi.fn(() => store.error);
    store.subscribe(listener);
    const before = store.snapshot;
    const invalid = [
      () => store.add('BTCUSDT.P'), () => store.add('BINANCE:BTCUSDT'),
      () => store.remove('MISSINGUSDT'), () => store.move('BTCUSDT', 'MISSINGUSDT'),
      () => store.move('MISSINGUSDT', null), () => store.rename('missing', '名称'),
      () => store.rename('default', ' '), () => store.rename('default', '字'.repeat(41)),
      () => store.deleteList('missing'), () => store.selectList('missing'),
    ];
    for (const action of invalid) {
      const count = listener.mock.calls.length;
      expect(action()).toBe(false); expect(store.error).toBeTruthy();
      expect(listener).toHaveBeenCalledTimes(count + 1);
      expect(store.snapshot).toEqual(before); expect(store.canUndo).toBe(false);
    }
    expect(store.create('')).toBeNull(); expect(store.create('a'.repeat(41))).toBeNull();
    expect(store.move('BTCUSDT', 'BTCUSDT')).toBe(false);
    expect(store.move('SOLUSDT', null)).toBe(false);
    expect(store.rename('default', '自选列表')).toBe(false);
    expect(store.selectList('default')).toBe(false);
    expect(store.canUndo).toBe(false);
  });

  it('enforces 12 groups and 100 unique symbols per group without affecting other groups', () => {
    const store = createStore();
    for (let i = 0; i < 11; i++) expect(store.create(`分组 ${i}`)).toBeTruthy();
    expect(store.snapshot.lists).toHaveLength(12); expect(store.create('超出限额')).toBeNull();
    for (let i = 0; i < 100; i++) expect(store.add(`ASSET${i}USDT`)).toBe(true);
    const before = store.snapshot;
    expect(store.add('OVERUSDT')).toBe(false); expect(store.snapshot).toEqual(before);
    expect(activeSymbols(store)).toHaveLength(100);
    expect(store.snapshot.lists[0].symbols).toHaveLength(3);
  });

  it('snapshots and every subscriber receive independent nested copies, with immediate subscription and cleanup', () => {
    const store = createStore();
    const snapshot = store.snapshot;
    snapshot.lists[0].symbols.length = 0; snapshot.lists[0].name = '外部改写'; snapshot.lists.length = 0;
    const mutator = vi.fn((doc: WatchlistDocument) => { doc.lists[0].symbols.length = 0; });
    const unsubscribe = store.subscribe(mutator), observer = vi.fn(); store.subscribe(observer);
    expect(mutator).toHaveBeenCalledOnce(); expect(observer).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0][0].lists[0].symbols).toHaveLength(3);
    store.add('ADAUSDT'); expect(activeSymbols(store)).toHaveLength(4);
    expect(observer.mock.calls.at(-1)![0].lists[0].symbols).toHaveLength(4);
    unsubscribe(); store.add('XRPUSDT'); expect(mutator).toHaveBeenCalledTimes(2);
    store.destroy(); const count = observer.mock.calls.length;
    expect(store.add('LTCUSDT')).toBe(false); expect(store.create('已销毁')).toBeNull();
    expect(observer).toHaveBeenCalledTimes(count);
  });
});

describe('watchlist persistence and cross-tab synchronization', () => {
  it('keeps legacy spot lists separate and stores perpetual aliases as canonical contract symbols',()=>{
    const storage=new MemoryStorage(),legacy=JSON.stringify(documentOf(['ETHBTC','BTCUSDC']));storage.values.set('tvchart.watchlists.v1',legacy);
    const store=createStore(storage);expect(activeSymbols(store)).toEqual(['BTCUSDT','ETHUSDT','SOLUSDT']);expect(store.add('BINANCE:XRPUSDT.P')).toBe(true);expect(activeSymbols(store)).toContain('XRPUSDT');expect(store.add('ETHBTC')).toBe(false);expect(storage.values.get('tvchart.watchlists.v1')).toBe(legacy);expect(storage.values.has(WATCHLIST_STORAGE_KEY)).toBe(true);
  });
  it('restores and canonicalizes valid saved documents without writing them during initialization', () => {
    const storage = new MemoryStorage();
    storage.values.set(WATCHLIST_STORAGE_KEY, JSON.stringify(documentOf([' btc/usdt ', 'BTCUSDT', 'eth-usdt'])));
    const store = createStore(storage);
    expect(store.snapshot).toEqual(documentOf(['BTCUSDT', 'ETHUSDT']));
    expect(store.canUndo).toBe(false); expect(store.error).toBe('');
    expect(storage.setItem).not.toHaveBeenCalled();
    store.add('ADAUSDT');
    const reloaded = createStore(storage); expect(reloaded.snapshot).toEqual(store.snapshot);
    expect(reloaded.canUndo).toBe(false);
  });

  it('rejects malformed documents atomically and preserves the original stored bytes until a user edit', () => {
    const valid = documentOf();
    const corrupt = [
      '{broken', 'null', '[]', JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, activeId: 'missing' }), JSON.stringify({ ...valid, lists: [] }),
      JSON.stringify({ ...valid, lists: [valid.lists[0], valid.lists[0]] }),
      JSON.stringify({ ...valid, lists: [{ ...valid.lists[0], name: ' ' }] }),
      JSON.stringify({ ...valid, lists: [{ ...valid.lists[0], name: '字'.repeat(41) }] }),
      JSON.stringify(documentOf(['ETHBTC'])), JSON.stringify(documentOf([null as unknown as string])),
      JSON.stringify(documentOf(Array.from({ length: 101 }, (_, i) => `ASSET${i}USDT`))),
      JSON.stringify({ ...valid, lists: Array.from({ length: 13 }, (_, i) => ({ ...valid.lists[0], id: `group${i}` })) }),
    ];
    for (const raw of corrupt) {
      const storage = new MemoryStorage(); storage.values.set(WATCHLIST_STORAGE_KEY, raw);
      const store = createStore(storage);
      expect(store.snapshot.activeId).toBe('default'); expect(activeSymbols(store)).toHaveLength(3);
      expect(store.error).toBeTruthy(); expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.values.get(WATCHLIST_STORAGE_KEY)).toBe(raw);
      store.add('ADAUSDT'); expect(JSON.parse(storage.values.get(WATCHLIST_STORAGE_KEY)!)).toEqual(store.snapshot);
    }
  });

  it('keeps edits and undo in memory when saving fails and reports errors on the same emitted update', () => {
    const storage = new MemoryStorage(); storage.setItem.mockImplementation(() => { throw new Error('quota exceeded'); });
    const store = createStore(storage), errors: string[] = [];
    store.subscribe(() => errors.push(store.error));
    expect(store.add('ADAUSDT')).toBe(true); expect(activeSymbols(store)).toContain('ADAUSDT');
    expect(store.canUndo).toBe(true); expect(errors.at(-1)).toContain('保存失败');
    expect(store.undo()).toBe(true); expect(activeSymbols(store)).not.toContain('ADAUSDT');
    storage.setItem.mockImplementation((key, value) => { storage.values.set(key, value); });
    expect(store.add('LTCUSDT')).toBe(true); expect(store.error).toBe('');
    expect(JSON.parse(storage.values.get(WATCHLIST_STORAGE_KEY)!)).toEqual(store.snapshot);
  });

  it('survives storage read failures and denied access to the global localStorage property', () => {
    const storage = new MemoryStorage(); storage.getItem.mockImplementation(() => { throw new Error('denied'); });
    const store = createStore(storage); expect(store.error).toContain('无法读取');
    expect(activeSymbols(store)).toHaveLength(3); expect(store.add('ADAUSDT')).toBe(true);
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
      const unavailable = new WatchlistStore(); stores.push(unavailable);
      expect(unavailable.error).toContain('存储不可用');
      expect(unavailable.add('ADAUSDT')).toBe(true); expect(unavailable.error).toContain('当前页面');
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('applies validated remote changes without echo writes, clears undo and unregisters its storage listener', () => {
    const target = new EventTarget(), remove = vi.spyOn(target, 'removeEventListener'); vi.stubGlobal('window', target);
    const storage = new MemoryStorage(), store = createStore(storage), listener = vi.fn(); store.subscribe(listener);
    store.add('ADAUSDT'); expect(store.canUndo).toBe(true);
    const writes = storage.setItem.mock.calls.length;
    const remote = documentOf([' eth/usdt ', 'ETHUSDT', 'XRPUSDT']);
    storageEvent(target, JSON.stringify(remote), storage);
    expect(store.snapshot).toEqual(documentOf(['ETHUSDT', 'XRPUSDT']));
    expect(store.canUndo).toBe(false); expect(storage.setItem).toHaveBeenCalledTimes(writes);
    expect(listener.mock.calls.at(-1)![0]).toEqual(store.snapshot);
    const before = store.snapshot, calls = listener.mock.calls.length;
    store.destroy(); expect(remove).toHaveBeenCalledWith('storage', expect.any(Function));
    storageEvent(target, JSON.stringify(documentOf(['LTCUSDT'])), storage);
    expect(store.snapshot).toEqual(before); expect(listener).toHaveBeenCalledTimes(calls);
  });

  it('ignores unrelated storage areas, keys and invalid remote documents without losing local state or history', () => {
    const target = new EventTarget(); vi.stubGlobal('window', target);
    const storage = new MemoryStorage(), store = createStore(storage); store.add('ADAUSDT');
    const before = store.snapshot, writes = storage.setItem.mock.calls.length;
    storageEvent(target, JSON.stringify(documentOf()), new MemoryStorage());
    storageEvent(target, JSON.stringify(documentOf()), storage, 'unrelated-key');
    storageEvent(target, null, storage);
    storageEvent(target, JSON.stringify(documentOf(['ETHBTC'])), storage);
    expect(store.snapshot).toEqual(before); expect(store.canUndo).toBe(true);
    expect(store.error).toContain('格式无效'); expect(storage.setItem).toHaveBeenCalledTimes(writes);
    store.undo(); expect(activeSymbols(store)).not.toContain('ADAUSDT');
  });
});
