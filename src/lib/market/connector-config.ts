import type {SqliteSymbolSourceStat} from './symbol-catalog';

export type ConnectorRunMode='auto'|'live'|'simulation';

export interface ConnectorUserConfig {
  source:string;
  enabled:boolean;
  mode:ConnectorRunMode;
  restBase:string;
  wsUrl:string;
  defaultSymbol:string;
  notes?:string;
  updatedAt?:number;
}

const STORAGE_KEY='chart.connector.configs.v1';

export const DEFAULT_CONNECTOR_CONFIGS:Readonly<Record<string,ConnectorUserConfig>>={
  binance:{
    source:'binance',
    enabled:true,
    mode:'live',
    restBase:'https://fapi.binance.com',
    wsUrl:'wss://fstream.binance.com/ws',
    defaultSymbol:'BTCUSDT',
    notes:'Binance USDⓈ-M 永续合约公开 REST + WebSocket 行情接口',
  },
  okx:{
    source:'okx',
    enabled:true,
    mode:'live',
    restBase:'https://www.okx.com',
    wsUrl:'wss://ws.okx.com:8443/ws/v5/business',
    defaultSymbol:'BTCUSDT',
    notes:'OKX v5 Public Instruments & Candle WebSocket 接口',
  },
  coinbase:{
    source:'coinbase',
    enabled:true,
    mode:'live',
    restBase:'https://api.exchange.coinbase.com',
    wsUrl:'wss://ws-feed.exchange.coinbase.com',
    defaultSymbol:'BTC-USD',
    notes:'Coinbase Exchange 现货公开 Products & Ticker WebSocket 接口',
  },
  'cn-a':{
    source:'cn-a',
    enabled:true,
    mode:'auto',
    restBase:'/api/market-data/cn-a',
    wsUrl:'',
    defaultSymbol:'600519.SH',
    notes:'沪深京 A 股本地服务端双源代理（东方财富 push2his + 腾讯财经 ifzq 实时日/分时 K 线，离线自动回退仿真）',
  },
  mock:{
    source:'mock',
    enabled:true,
    mode:'simulation',
    restBase:'',
    wsUrl:'',
    defaultSymbol:'BTCUSDT',
    notes:'本地确定性随机数生成 100 万根压测与教学 K 线',
  },
};

function normalizeConfig(source:string,raw?:Partial<ConnectorUserConfig>):ConnectorUserConfig {
  const base=DEFAULT_CONNECTOR_CONFIGS[source]??{
    source,
    enabled:true,
    mode:'auto' as ConnectorRunMode,
    restBase:'',
    wsUrl:'',
    defaultSymbol:'BTCUSDT',
  };
  const mode=raw?.mode==='live'||raw?.mode==='simulation'||raw?.mode==='auto'?raw.mode:base.mode;
  return {
    source,
    enabled:typeof raw?.enabled==='boolean'?raw.enabled:base.enabled,
    mode,
    restBase:typeof raw?.restBase==='string'&&raw.restBase.trim()?raw.restBase.trim():base.restBase,
    wsUrl:typeof raw?.wsUrl==='string'?raw.wsUrl.trim():base.wsUrl,
    defaultSymbol:typeof raw?.defaultSymbol==='string'&&raw.defaultSymbol.trim()?raw.defaultSymbol.trim().toUpperCase():base.defaultSymbol,
    notes:typeof raw?.notes==='string'?raw.notes:base.notes,
    ...(typeof raw?.updatedAt==='number'?{updatedAt:raw.updatedAt}:{}),
  };
}

function readLocalConfigs():Map<string,ConnectorUserConfig> {
  const map=new Map<string,ConnectorUserConfig>();
  for(const [k,v] of Object.entries(DEFAULT_CONNECTOR_CONFIGS)){
    map.set(k,{...v});
  }
  if(typeof localStorage==='undefined')return map;
  try{
    const raw=localStorage.getItem(STORAGE_KEY);
    if(!raw)return map;
    const parsed=JSON.parse(raw) as Record<string,Partial<ConnectorUserConfig>>;
    if(parsed&&typeof parsed==='object'){
      for(const [source,cfg] of Object.entries(parsed)){
        map.set(source,normalizeConfig(source,cfg));
      }
    }
  }catch{}
  return map;
}

function writeLocalConfigs(map:Map<string,ConnectorUserConfig>):boolean {
  if(typeof localStorage==='undefined')return false;
  try{
    const obj:Record<string,ConnectorUserConfig>={};
    for(const [k,v] of map.entries())obj[k]=v;
    localStorage.setItem(STORAGE_KEY,JSON.stringify(obj));
    return true;
  }catch{return false;}
}

export interface ConnectorSaveResult {config:ConnectorUserConfig;browserSaved:boolean;serverSaved:boolean;sources:SqliteSymbolSourceStat[]}
export class ConnectorConfigStore {
  private configs=readLocalConfigs();
  private listeners=new Set<(configs:ConnectorUserConfig[])=>void>();

  get(source:string):ConnectorUserConfig {
    return this.configs.get(source)??normalizeConfig(source);
  }

  list():ConnectorUserConfig[] {
    return [...this.configs.values()];
  }

  setAll(items:readonly Partial<ConnectorUserConfig>[],persistServer=true):ConnectorUserConfig[] {
    for(const item of items){
      if(!item?.source)continue;
      this.configs.set(item.source,normalizeConfig(item.source,{...this.get(item.source),...item,updatedAt:Date.now()}));
    }
    writeLocalConfigs(this.configs);
    this.notify();
    if(persistServer){
      void this.pushToServer(this.list());
    }
    return this.list();
  }

  update(source:string,patch:Partial<ConnectorUserConfig>,persistServer=true):ConnectorUserConfig {
    const next=normalizeConfig(source,{...this.get(source),...patch,source,updatedAt:Date.now()});
    this.configs.set(source,next);
    writeLocalConfigs(this.configs);
    this.notify();
    if(persistServer){
      void this.pushToServer([next]);
    }
    return next;
  }

  /** Explicit settings apply: report each persistence result, never equate an
   * in-memory update with successful browser or server storage. */
  async save(source:string,patch:Partial<ConnectorUserConfig>,request?:typeof fetch):Promise<ConnectorSaveResult> {
    const config=normalizeConfig(source,{...this.get(source),...patch,source,updatedAt:Date.now()});
    this.configs.set(source,config);
    const browserSaved=writeLocalConfigs(this.configs);this.notify();
    const sources=await this.pushToServer([config],request);
    return {config,browserSaved,serverSaved:sources!==null,sources:sources??[]};
  }

  reset(source?:string):ConnectorUserConfig[] {
    if(source){
      const def=DEFAULT_CONNECTOR_CONFIGS[source];
      if(def)this.configs.set(source,{...def,updatedAt:Date.now()});
    } else {
      this.configs.clear();
      for(const [k,v] of Object.entries(DEFAULT_CONNECTOR_CONFIGS)){
        this.configs.set(k,{...v,updatedAt:Date.now()});
      }
    }
    writeLocalConfigs(this.configs);
    this.notify();
    void this.pushToServer(this.list());
    return this.list();
  }

  subscribe(listener:(configs:ConnectorUserConfig[])=>void):()=>void {
    this.listeners.add(listener);
    listener(this.list());
    return ()=>this.listeners.delete(listener);
  }

  async syncFromServer(request?:typeof fetch):Promise<{configs:ConnectorUserConfig[];sources:SqliteSymbolSourceStat[]}|null> {
    const fetcher=request??(typeof fetch==='function'?fetch:undefined);
    if(!fetcher)return null;
    try{
      const res=await fetcher('/api/market-data/connectors');
      if(!res.ok)return null;
      const body=await res.json() as {configs?:Partial<ConnectorUserConfig>[];sources?:SqliteSymbolSourceStat[]};
      if(Array.isArray(body.configs)&&body.configs.length){
        this.setAll(body.configs,false);
      }
      return {
        configs:this.list(),
        sources:Array.isArray(body.sources)?body.sources:[],
      };
    }catch{
      return null;
    }
  }

  async pushToServer(configs:readonly ConnectorUserConfig[],request?:typeof fetch):Promise<SqliteSymbolSourceStat[]|null> {
    const fetcher=request??(typeof fetch==='function'?fetch:undefined);
    if(!fetcher)return null;
    try{
      const res=await fetcher('/api/market-data/connectors',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({configs}),
        signal:AbortSignal.timeout(10_000),
      });
      if(!res.ok)return null;
      const body=await res.json() as {sources?:SqliteSymbolSourceStat[]};
      return Array.isArray(body.sources)?body.sources:null;
    }catch{
      return null;
    }
  }

  private notify():void {
    const snapshot=this.list();
    for(const listener of this.listeners)listener(snapshot);
  }
}

export const connectorConfigStore=new ConnectorConfigStore();
