import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {IndexedDatasetPersistence,MemoryDatasetPersistence} from '../src/lib/history/persistence';

beforeEach(()=>vi.stubGlobal('indexedDB',new IDBFactory()));
afterEach(()=>vi.unstubAllGlobals());

it('reads an existing dataset cache without deleting old browser records',async()=>{
  const legacy=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('tvchart-script-workspace',2);
    request.onupgradeneeded=()=>{for(const store of ['workspace','runs','datasets','revisions'])request.result.createObjectStore(store);};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  await new Promise<void>((resolve,reject)=>{
    const transaction=legacy.transaction(['datasets','workspace'],'readwrite');
    transaction.objectStore('datasets').put({symbol:'BTCUSDT',bars:[{time:60000,close:100}]},'existing');
    transaction.objectStore('workspace').put({legacy:true},'main');
    transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);
  });
  legacy.close();
  const cache=new IndexedDatasetPersistence();
  expect(await cache.get('datasets','existing')).toEqual({symbol:'BTCUSDT',bars:[{time:60000,close:100}]});
  cache.close();
  const reopened=await new Promise<IDBDatabase>(resolve=>{const request=indexedDB.open('tvchart-script-workspace',2);request.onsuccess=()=>resolve(request.result);});
  expect(reopened.objectStoreNames.contains('workspace')).toBe(true);
  const retained=await new Promise<unknown>(resolve=>{const request=reopened.transaction('workspace','readonly').objectStore('workspace').get('main');request.onsuccess=()=>resolve(request.result);});
  expect(retained).toEqual({legacy:true});reopened.close();
});

it('persists detached dataset snapshots and honours deletion and close',async()=>{
  const cache=new IndexedDatasetPersistence('market-cache-test'),snapshot={bars:[{close:100}]};
  const saving=cache.put('datasets','btc',snapshot);snapshot.bars[0].close=999;
  await saving;
  const result=await cache.get<typeof snapshot>('datasets','btc');expect(result?.bars[0].close).toBe(100);
  result!.bars[0].close=777;expect((await cache.get<typeof snapshot>('datasets','btc'))?.bars[0].close).toBe(100);
  await cache.remove('datasets','btc');expect(await cache.get('datasets','btc')).toBeUndefined();
  cache.close();await expect(cache.get('datasets','btc')).rejects.toThrow('关闭');
});

it('keeps the memory fallback independent of caller mutations',async()=>{
  const cache=new MemoryDatasetPersistence(),snapshot={bars:[{close:10}]};
  await cache.put('datasets','btc',snapshot);snapshot.bars[0].close=11;
  const result=await cache.get<typeof snapshot>('datasets','btc');expect(result?.bars[0].close).toBe(10);
  result!.bars[0].close=12;expect((await cache.get<typeof snapshot>('datasets','btc'))?.bars[0].close).toBe(10);
  await cache.remove('datasets','btc');expect(await cache.get('datasets','btc')).toBeUndefined();
});
