// Keep the existing database name/version so saved market datasets remain
// readable after the editor and backtest modules are removed.
const DB_NAME='tvchart-script-workspace',DB_VERSION=2;
type DatasetStore='datasets';
export interface DatasetPersistence {
  get<T>(store:DatasetStore,id:string):Promise<T|undefined>;
  put(store:DatasetStore,id:string,value:unknown):Promise<void>;
  remove(store:DatasetStore,id:string):Promise<void>;
  close():void;
}
export class IndexedDatasetPersistence implements DatasetPersistence {
  private opening:Promise<IDBDatabase>|null=null;
  private db:IDBDatabase|null=null;
  private stopped=false;
  private invalidated:Error|null=null;
  constructor(private readonly databaseName=DB_NAME){}
  private open():Promise<IDBDatabase>{
    if(this.stopped)return Promise.reject(Error('历史行情缓存已关闭'));
    if(this.invalidated)return Promise.reject(this.invalidated);
    if(this.db)return Promise.resolve(this.db);
    if(this.opening)return this.opening;
    const opening=new Promise<IDBDatabase>((resolve,reject)=>{
      if(typeof indexedDB==='undefined'){reject(Error('浏览器不支持本地行情缓存'));return;}
      let failed=false;
      const fail=(error:unknown)=>{failed=true;reject(error);};
      const request=indexedDB.open(this.databaseName,DB_VERSION);
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('datasets'))request.result.createObjectStore('datasets');};
      request.onerror=()=>fail(request.error??Error('历史行情缓存无法打开'));
      request.onblocked=()=>fail(Error('请关闭旧版本页面后重试行情缓存'));
      request.onsuccess=()=>{
        const db=request.result;
        if(this.stopped||failed){db.close();fail(Error('历史行情缓存已关闭或需要重试'));return;}
        this.db=db;
        db.onversionchange=()=>{this.invalidated=Error('历史行情缓存已在其他页面升级或重置，请刷新页面。');db.close();this.db=null;this.opening=null;};
        resolve(db);
      };
    });
    this.opening=opening;
    void opening.catch(()=>{if(this.opening===opening)this.opening=null;});
    return opening;
  }
  async get<T>(store:DatasetStore,id:string):Promise<T|undefined>{
    const db=await this.open();
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction(store,'readonly'),request=transaction.objectStore(store).get(id);
      transaction.oncomplete=()=>resolve(request.result as T|undefined);
      transaction.onerror=()=>reject(transaction.error??request.error??Error('行情缓存读取失败'));
      transaction.onabort=()=>reject(transaction.error??Error('行情缓存读取中断'));
    });
  }
  async put(store:DatasetStore,id:string,value:unknown):Promise<void>{
    const snapshot=structuredClone(value),db=await this.open();
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction(store,'readwrite');
      transaction.oncomplete=()=>resolve();
      transaction.onerror=()=>reject(transaction.error??Error('行情缓存写入失败'));
      transaction.onabort=()=>reject(transaction.error??Error('行情缓存写入中断'));
      try{transaction.objectStore(store).put(snapshot,id);}catch(error){transaction.abort();reject(error);}
    });
  }
  async remove(store:DatasetStore,id:string):Promise<void>{
    const db=await this.open();
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction(store,'readwrite');
      transaction.oncomplete=()=>resolve();
      transaction.onerror=()=>reject(transaction.error??Error('行情缓存删除失败'));
      transaction.onabort=()=>reject(transaction.error??Error('行情缓存删除中断'));
      transaction.objectStore(store).delete(id);
    });
  }
  close():void{this.stopped=true;this.db?.close();this.db=null;}
}
export class MemoryDatasetPersistence implements DatasetPersistence {
  private values=new Map<string,unknown>();
  async get<T>(store:DatasetStore,id:string):Promise<T|undefined>{const value=this.values.get(`${store}:${id}`);return value===undefined?undefined:structuredClone(value) as T;}
  async put(store:DatasetStore,id:string,value:unknown){this.values.set(`${store}:${id}`,structuredClone(value));}
  async remove(store:DatasetStore,id:string){this.values.delete(`${store}:${id}`);}
  close(){}
}
