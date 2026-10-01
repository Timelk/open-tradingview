import type {MarketSymbol} from '../watchlist/types';
import {marketConnectors,tagConnectorSymbol,type MarketSourceId} from './connectors';

export interface SqliteSymbolSourceStat {
  source:string;
  count:number;
  updatedAt:number;
}

export interface SqliteSymbolCatalogResponse {
  symbols:MarketSymbol[];
  sources:SqliteSymbolSourceStat[];
}

export function symbolCatalogKey(item:Pick<MarketSymbol,'symbol'|'source'>):string {
  return `${(item.source??'binance').toLowerCase()}:${item.symbol.toUpperCase()}`;
}

export function mergeSymbolCatalogs(...groups:readonly (readonly MarketSymbol[])[]):MarketSymbol[] {
  const byKey=new Map<string,MarketSymbol>();
  for(const group of groups){
    for(const raw of group){
      if(!raw?.symbol)continue;
      const source=(raw.source??'binance').toLowerCase();
      const connector=marketConnectors.get(source);
      const item=connector?tagConnectorSymbol(connector,{...raw,source}):{...raw,source};
      const key=symbolCatalogKey(item);
      const prev=byKey.get(key);
      if(!prev){
        byKey.set(key,item);
      } else {
        byKey.set(key,{
          ...prev,
          ...item,
          name:(item.name?.trim()&&item.name!==item.baseAsset?item.name:prev.name||item.name)??'',
          exchangeLabel:item.exchangeLabel||prev.exchangeLabel,
          marketBadge:item.marketBadge||prev.marketBadge,
          ...(item.contract||prev.contract?{contract:item.contract??prev.contract}:{}),
        });
      }
    }
  }
  return [...byKey.values()];
}

export function defaultMultiSourceCatalog():MarketSymbol[] {
  const lists:MarketSymbol[][]=[];
  for(const connector of marketConnectors.list()){
    if(connector.id==='mock')continue;
    lists.push(connector.defaultSymbols.map(item=>tagConnectorSymbol(connector,item)));
  }
  return mergeSymbolCatalogs(...lists);
}

export async function fetchSqliteSymbolCatalog(
  options:{source?:string;query?:string;quoteAsset?:string;limit?:number;signal?:AbortSignal;request?:typeof fetch}={}
):Promise<SqliteSymbolCatalogResponse|null> {
  const fetcher=options.request??(typeof fetch==='function'?fetch:undefined);
  if(!fetcher)return null;
  try {
    const params=new URLSearchParams();
    if(options.source)params.set('source',options.source);
    if(options.query)params.set('q',options.query);
    if(options.quoteAsset)params.set('quote',options.quoteAsset);
    if(options.limit)params.set('limit',String(options.limit));
    const qs=params.toString();
    const res=await fetcher(`/api/market-data/symbols${qs?`?${qs}`:''}`,{signal:options.signal});
    if(!res.ok)return null;
    const body=await res.json() as Partial<SqliteSymbolCatalogResponse>;
    if(!Array.isArray(body?.symbols))return null;
    return {
      symbols:body.symbols,
      sources:Array.isArray(body.sources)?body.sources:[],
    };
  } catch {
    return null;
  }
}

export async function persistSymbolsToSqlite(
  symbols:readonly MarketSymbol[],
  request?:typeof fetch
):Promise<SqliteSymbolSourceStat[]|null> {
  const fetcher=request??(typeof fetch==='function'?fetch:undefined);
  if(!fetcher||!symbols.length)return null;
  try {
    let latestSources:SqliteSymbolSourceStat[]|null=null;
    const batchSize=2000;
    for(let i=0;i<symbols.length;i+=batchSize){
      const chunk=symbols.slice(i,i+batchSize);
      const res=await fetcher('/api/market-data/symbols',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({symbols:chunk}),
      });
      if(!res.ok)return latestSources;
      const body=await res.json() as {sources?:SqliteSymbolSourceStat[]};
      if(Array.isArray(body?.sources))latestSources=body.sources;
    }
    return latestSources;
  } catch {
    return null;
  }
}

export async function syncMultiSourceCatalog(options:{
  sources?:readonly MarketSourceId[];
  signal?:AbortSignal;
  onPartial?:(catalog:MarketSymbol[],sources:SqliteSymbolSourceStat[])=>void;
}={}):Promise<{catalog:MarketSymbol[];sources:SqliteSymbolSourceStat[]}> {
  let current=defaultMultiSourceCatalog();
  let sources:SqliteSymbolSourceStat[]=[];

  const sqliteInitial=await fetchSqliteSymbolCatalog({limit:5000,signal:options.signal});
  if(sqliteInitial){
    current=mergeSymbolCatalogs(current,sqliteInitial.symbols);
    sources=sqliteInitial.sources;
    options.onPartial?.(current,sources);
  }

  const targetConnectors=options.sources?.length
    ?options.sources.map(id=>marketConnectors.get(id)).filter((c):c is NonNullable<typeof c>=>!!c&&c.id!=='mock')
    :marketConnectors.list().filter(c=>c.id!=='mock'&&typeof c.fetchCatalog==='function');

  const fetchedLists=await Promise.allSettled(
    targetConnectors.map(async connector=>{
      if(!connector.fetchCatalog)return connector.defaultSymbols.map(item=>tagConnectorSymbol(connector,item));
      const list=await connector.fetchCatalog(options.signal);
      return list.map(item=>tagConnectorSymbol(connector,item));
    })
  );

  const newlyFetched:MarketSymbol[]=[];
  for(const res of fetchedLists){
    if(res.status==='fulfilled'&&res.value.length)newlyFetched.push(...res.value);
  }

  if(newlyFetched.length){
    current=mergeSymbolCatalogs(current,newlyFetched);
    const updatedSources=await persistSymbolsToSqlite(current);
    if(updatedSources)sources=updatedSources;
  }

  return {catalog:current,sources};
}

export async function searchRemoteCnAShareSymbols(
  query:string,
  options:{limit?:number;signal?:AbortSignal;request?:typeof fetch}={}
):Promise<SqliteSymbolCatalogResponse|null> {
  const q=query.trim();
  if(!q)return null;
  const fetcher=options.request??(typeof fetch==='function'?fetch:undefined);
  if(!fetcher)return null;
  try{
    const params=new URLSearchParams({q,limit:String(options.limit??30)});
    const res=await fetcher(`/api/market-data/cn-a/search?${params}`,{signal:options.signal});
    if(!res.ok)return null;
    const body=await res.json() as Partial<SqliteSymbolCatalogResponse>;
    if(!Array.isArray(body?.symbols))return null;
    const cnConnector=marketConnectors.get('cn-a');
    const symbols=body.symbols.map(item=>cnConnector?tagConnectorSymbol(cnConnector,{...item,source:'cn-a'}):{...item,source:'cn-a'});
    return {
      symbols,
      sources:Array.isArray(body.sources)?body.sources:[],
    };
  }catch{
    return null;
  }
}
