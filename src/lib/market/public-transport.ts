/** Loopback development/preview bridges fixed public Binance data through the
 * local server. No connector configuration or account credentials are changed. */
const loopback=(host:string)=>host==='localhost'||host==='[::1]'||host==='::1'||/^127(?:\.\d{1,3}){3}$/.test(host)&&host.split('.').slice(1).every(part=>Number(part)<=255);
const origin=()=>typeof location!=='undefined'&&/^https?:$/.test(location.protocol)&&loopback(location.hostname)?location.origin:undefined;
const REST_PATHS=new Set(['/fapi/v1/depth','/fapi/v1/aggTrades','/fapi/v1/klines','/fapi/v1/exchangeInfo','/fapi/v1/ticker/24hr']);
export async function publicMarketRequest(input:RequestInfo|URL,init?:RequestInit):Promise<Response>{
  const local=origin(),original=typeof Request!=='undefined'&&input instanceof Request?input:undefined;
  const method=(init?.method??original?.method??'GET').toUpperCase();
  if(local&&method==='GET'){
    try{
      const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
      if(url.origin==='https://fapi.binance.com'&&!url.username&&!url.password&&!url.hash&&REST_PATHS.has(url.pathname)){
        // Request-object cancellation must survive URL rewriting. Public bridge
        // requests carry no cookies, Authorization, API keys, or signed headers.
        const reqInit:RequestInit={
          ...init,method:'GET',credentials:'omit',headers:{Accept:'application/json'},
          signal:init?.signal??original?.signal,cache:init?.cache??original?.cache,redirect:'error',
        };
        const bridged=await fetch(`${local}/api/market-public/binance/rest${url.pathname}${url.search}`,reqInit);
        if(bridged.status!==502&&bridged.status!==503&&bridged.status!==504)return bridged;
        try{
          const direct=await fetch(url.href,reqInit);
          if(direct.ok)return direct;
        }catch{/* Preserve local bridge response if direct browser fallback also fails. */}
        return bridged;
      }
    }catch{/* Custom endpoints remain under their connector's own policy. */}
  }
  return fetch(input,init);
}
export function publicMarketSocketUrl(upstream:string):string {
  const local=origin();if(!local)return upstream;
  try{
    const url=new URL(upstream);
    if(url.origin!=='wss://fstream.binance.com'||url.username||url.password||url.search||url.hash)return upstream;
    // Legacy /ws URLs are accepted only for these same fixed public streams.
    const match=/^\/(?:public\/|market\/)?ws\/([a-z0-9]{2,30}usdt@(?:depth@100ms|aggTrade|kline_(?:1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1M)))$/.exec(url.pathname);
    if(!match)return upstream;
    return `${local.replace(/^http/,'ws')}/api/market-public/binance/stream?stream=${encodeURIComponent(match[1])}`;
  }catch{return upstream;}
}

/** Saved connectors may provide either a category base or the full /ws prefix.
 * Join once without rewriting custom proxy hosts or their parent path. */
export function publicMarketStreamEndpoint(base:string,stream:string):string {
  let prefix=base;while(prefix.endsWith('/'))prefix=prefix.slice(0,-1);
  return `${prefix}${prefix.endsWith('/ws')?'':'/ws'}/${stream}`;
}
