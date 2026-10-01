import type {IncomingMessage,ServerResponse,Server} from 'node:http';
import type {Duplex} from 'node:stream';
import WebSocket,{WebSocketServer,type RawData} from 'ws';
import {HttpsProxyAgent} from 'https-proxy-agent';

const PREFIX='/api/market-public/binance',REST='https://fapi.binance.com';
const symbols=/^[A-Z0-9]{2,30}USDT$/;
const intervals=/^(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1M)$/;
const schemas:Record<string,readonly string[]>={
  '/fapi/v1/depth':['symbol','limit'],
  '/fapi/v1/aggTrades':['symbol','limit','startTime','endTime','fromId'],
  '/fapi/v1/klines':['symbol','limit','interval','startTime','endTime'],
  '/fapi/v1/exchangeInfo':[],
  '/fapi/v1/ticker/24hr':['symbol'],
};
const loopback=(host:string)=>host==='localhost'||host==='[::1]'||host==='::1'||/^(?:::ffff:)?127(?:\.\d{1,3}){3}$/i.test(host)&&host.split('.').slice(1).every(part=>Number(part)<=255);
export function localPublicRequest(req:Pick<IncomingMessage,'headers'|'socket'>):boolean {
  try{
    if(!loopback(req.socket.remoteAddress??''))return false;
    const host=req.headers.host;if(typeof host!=='string')return false;
    const protocol=(req.socket as IncomingMessage['socket']&{encrypted?:boolean}).encrypted?'https:':'http:';
    const base=new URL(`${protocol}//${host}`);
    if(base.username||base.password||base.pathname!=='/'||base.search||base.hash||!loopback(base.hostname))return false;
    if(['cross-site','same-site'].includes(String(req.headers['sec-fetch-site'])))return false;
    for(const header of [req.headers.origin,req.headers.referer])if(header!==undefined&&(typeof header!=='string'||new URL(header).origin!==base.origin))return false;
    return true;
  }catch{return false;}
}
function relativeUrl(raw:string):URL|undefined {
  if(!raw.startsWith('/')||raw.startsWith('//')||raw.length>2048)return;
  const url=new URL(raw,'http://localhost');if(url.hash||url.username||url.password)return;
  const seen=new Set<string>();for(const key of url.searchParams.keys()){if(seen.has(key))return;seen.add(key);}
  return url;
}
export function publicRestTarget(raw:string):string|undefined {
  try{
    const url=relativeUrl(raw);if(!url||!url.pathname.startsWith(PREFIX+'/rest/'))return;
    const path=url.pathname.slice((PREFIX+'/rest').length),allowed=schemas[path];if(!allowed)return;
    for(const [key,value] of url.searchParams)if(!allowed.includes(key)||value.length>40)return;
    const symbol=url.searchParams.get('symbol');
    if(symbol!==null&&!symbols.test(symbol))return;
    if(!['/fapi/v1/exchangeInfo','/fapi/v1/ticker/24hr'].includes(path)&&symbol===null)return;
    for(const key of ['limit','startTime','endTime','fromId']){
      const value=url.searchParams.get(key);
      if(value!==null&&(!/^\d{1,16}$/.test(value)||!Number.isSafeInteger(Number(value))))return;
    }
    const limit=url.searchParams.get('limit');
    if(limit!==null){const value=Number(limit);if(value<1||value>(path==='/fapi/v1/klines'?1500:1000))return;
      if(path==='/fapi/v1/depth'&&![5,10,20,50,100,500,1000].includes(value))return;}
    const interval=url.searchParams.get('interval');if(path==='/fapi/v1/klines'&&(interval===null||!intervals.test(interval)))return;
    const start=url.searchParams.get('startTime'),end=url.searchParams.get('endTime');if(start!==null&&end!==null&&Number(start)>Number(end))return;
    return REST+path+(url.searchParams.size?'?'+url.searchParams:'');
  }catch{return;}
}
export function publicStreamTarget(raw:string):string|undefined {
  try{
    const url=relativeUrl(raw);if(!url||url.pathname!==PREFIX+'/stream'||url.searchParams.size!==1||!url.searchParams.has('stream'))return;
    const stream=url.searchParams.get('stream')??'';
    if(!/^[a-z0-9]{2,30}usdt@(?:depth@100ms|aggTrade|kline_(?:1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1M))$/.test(stream))return;
    return `wss://fstream.binance.com/${stream.includes('@depth')?'public':'market'}/ws/${stream}`;
  }catch{return;}
}
export interface PublicMarketBridgeOptions {
  proxy?:string;request?:typeof fetch;Socket?:typeof WebSocket;
  /** Server-owned budgets; never accepted from a browser query. */
  restTimeoutMs?:number;handshakeTimeoutMs?:number;closeGraceMs?:number;heartbeatMs?:number;idleTimeoutMs?:number;maxBufferedBytes?:number;
}
const budget=(value:number|undefined,fallback:number,min:number,max:number)=>Number.isFinite(value)?Math.max(min,Math.min(max,Math.round(value!))):fallback;
const byteLength=(data:RawData)=>Array.isArray(data)?data.reduce((size,item)=>size+item.byteLength,0):data.byteLength;
async function readJson(response:Response,signal:AbortSignal,maxBytes:number):Promise<string>{
  const announced=Number(response.headers.get('content-length'));
  if(Number.isFinite(announced)&&announced>maxBytes){await response.body?.cancel();throw Error('Response limit');}
  if(!response.body)throw Error('Empty response');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{
    for(;;){if(signal.aborted)throw Error('Aborted');const chunk=await reader.read();if(signal.aborted)throw Error('Aborted');if(chunk.done)break;
      bytes+=chunk.value.byteLength;if(bytes>maxBytes){await reader.cancel();throw Error('Response limit');}chunks.push(chunk.value);}
    const body=Buffer.concat(chunks).toString('utf8');JSON.parse(body);return body;
  }finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
}

/** Fixed public endpoints only. Gaps/backpressure close the stream so the
 * consumer resynchronizes; this transport never drops or rewrites market events. */
export function createPublicMarketBridge(options:PublicMarketBridgeOptions={}) {
  const request=options.request??fetch,Socket=options.Socket??WebSocket,agent=options.proxy?new HttpsProxyAgent(options.proxy):undefined;
  const restTimeout=budget(options.restTimeoutMs,12000,5,60000),handshakeTimeout=budget(options.handshakeTimeoutMs,10000,5,60000);
  const closeGrace=budget(options.closeGraceMs,1000,5,5000),heartbeatMs=budget(options.heartbeatMs,15000,5,30000),idleMs=budget(options.idleTimeoutMs,45000,10,120000);
  const maxBuffered=budget(options.maxBufferedBytes,2*1024*1024,32,2*1024*1024);
  const wss=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
  const upstreams=new Set<WebSocket>(),requests=new Set<AbortController>(),disposeConnections=new Set<()=>void>();let closed=false;
  const middleware=async(req:IncomingMessage,res:ServerResponse,next:()=>void)=>{
    if(!req.url?.startsWith(PREFIX+'/rest/')){next();return;}
    const reply=(code:number,message:string)=>{if(res.destroyed||res.writableEnded)return;res.statusCode=code;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({message}));};
    if(closed){reply(503,'公开行情桥接已关闭');return;}
    if(req.method!=='GET'){res.setHeader('Allow','GET');reply(405,'只允许公开行情读取');return;}
    if(!localPublicRequest(req)){reply(403,'仅允许本机同源访问');return;}
    const target=publicRestTarget(req.url);if(!target){reply(400,'行情请求参数无效');return;}
    if(requests.size>=16){res.setHeader('Retry-After','1');reply(429,'公开行情请求繁忙，请稍后重试');return;}
    const abort=new AbortController(),cancel=()=>abort.abort();requests.add(abort);res.once('close',cancel);
    const timer=setTimeout(cancel,restTimeout);timer.unref();
    try{
      const response=await request(target,{credentials:'omit',redirect:'error',signal:abort.signal,headers:{Accept:'application/json'}});
      if(res.destroyed||abort.signal.aborted){await response.body?.cancel();if(!res.destroyed)reply(502,'公开行情连接失败，请重试');return;}
      if(!response.ok){await response.body?.cancel();if(response.status===429){res.setHeader('Retry-After','1');reply(429,'公开行情请求繁忙，请稍后重试');}else reply(502,'公开行情服务暂不可用');return;}
      const text=await readJson(response,abort.signal,8*1024*1024);
      if(res.destroyed||abort.signal.aborted){if(!res.destroyed)reply(502,'公开行情连接失败，请重试');return;}
      res.statusCode=200;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(text);
    }catch{reply(502,'公开行情连接失败，请重试');}
    finally{clearTimeout(timer);res.off('close',cancel);requests.delete(abort);}
  };
  const upgrade=(req:IncomingMessage,socket:Duplex,head:Buffer)=>{
    if(req.url?.split('?')[0]!==PREFIX+'/stream')return;
    const target=req.url&&publicStreamTarget(req.url);
    if(closed||req.method!=='GET'||!localPublicRequest(req)||!target||upstreams.size>=32||wss.clients.size>=32){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,client=>{
      let upstream:WebSocket;
      try{upstream=new Socket(target,{agent,handshakeTimeout,maxPayload:2*1024*1024,perMessageDeflate:false});}
      catch{client.terminate();return;}
      upstreams.add(upstream);
      let stopped=false,lastActivity=Date.now(),closeTimer:ReturnType<typeof setTimeout>|undefined;
      const dispose=()=>{if(closeTimer)clearTimeout(closeTimer);clearInterval(heartbeat);upstreams.delete(upstream);disposeConnections.delete(dispose);if(upstream.readyState!==WebSocket.CLOSED)upstream.terminate();if(client.readyState!==WebSocket.CLOSED)client.terminate();};
      const stop=(code:number,reason:string)=>{
        if(stopped)return;stopped=true;clearInterval(heartbeat);upstreams.delete(upstream);
        if(upstream.readyState!==WebSocket.CLOSED)upstream.terminate();
        if(client.readyState===WebSocket.OPEN){client.close(code,reason);closeTimer=setTimeout(dispose,closeGrace);closeTimer.unref();}else dispose();
      };
      const heartbeat=setInterval(()=>{
        if(client.bufferedAmount>maxBuffered){stop(1013,'Market stream resync required');return;}
        if(upstream.readyState!==WebSocket.OPEN)return;
        if(Date.now()-lastActivity>idleMs){stop(1012,'Market stream heartbeat lost');return;}
        upstream.ping((error?:Error)=>{if(error)stop(1011,'Market connection unavailable');});
      },heartbeatMs);heartbeat.unref();disposeConnections.add(dispose);
      client.on('close',()=>{stopped=true;dispose();});client.on('error',()=>{stopped=true;dispose();});
      client.on('message',()=>stop(1008,'Read-only market stream'));
      upstream.on('open',()=>{lastActivity=Date.now();});upstream.on('pong',()=>{lastActivity=Date.now();});upstream.on('ping',()=>{lastActivity=Date.now();});
      upstream.on('message',(data,isBinary)=>{
        if(stopped||client.readyState!==WebSocket.OPEN)return;lastActivity=Date.now();
        if(isBinary||client.bufferedAmount+byteLength(data)>maxBuffered){stop(1013,'Market stream resync required');return;}
        client.send(data,{binary:false},error=>{if(error)stop(1011,'Market connection unavailable');});
      });
      upstream.on('error',()=>stop(1011,'Market connection unavailable'));
      upstream.on('close',()=>stop(1012,'Market stream disconnected'));
    });
  };
  return {
    middleware,
    attach(server:Server){server.on('upgrade',upgrade);return()=>server.off('upgrade',upgrade);},
    close(){if(closed)return;closed=true;for(const abort of requests)abort.abort();for(const dispose of [...disposeConnections])dispose();for(const client of wss.clients)client.terminate();upstreams.clear();agent?.destroy();wss.close();},
  };
}
