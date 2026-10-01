import {afterEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {publicMarketRequest,publicMarketSocketUrl} from '../src/lib/market/public-transport';
import {createPublicMarketBridge,localPublicRequest,publicRestTarget,publicStreamTarget,type PublicMarketBridgeOptions} from '../server/public-market';
const PREFIX='/api/market-public/binance',cleanups:Array<()=>Promise<void>|void>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();vi.unstubAllGlobals();});
async function listen(server:Server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function bridgeHarness(options:PublicMarketBridgeOptions={}){
  const bridge=createPublicMarketBridge(options),server=createServer((req,res)=>{void bridge.middleware(req,res,()=>{res.statusCode=404;res.end();});});
  const detach=bridge.attach(server),url=await listen(server);
  cleanups.push(async()=>{detach();bridge.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {bridge,server,url};
}
async function socketHarness(options:PublicMarketBridgeOptions={},autoPong=true){
  const upstream=new WebSocketServer({port:0,host:'127.0.0.1',autoPong});await once(upstream,'listening');
  const upstreamUrl=`ws://127.0.0.1:${(upstream.address() as {port:number}).port}`,targets:string[]=[];
  cleanups.push(async()=>{for(const client of upstream.clients)client.terminate();await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  class LocalSocket extends WebSocket {constructor(target:string,init:WebSocket.ClientOptions){targets.push(target);super(upstreamUrl,{...init,agent:undefined});}}
  const h=await bridgeHarness({...options,Socket:LocalSocket as typeof WebSocket});
  const peerPromise=once(upstream,'connection');
  const client=new WebSocket(`${h.url.replace('http:','ws:')}${PREFIX}/stream?stream=btcusdt%40depth%40100ms`,{origin:h.url});
  client.on('error',()=>{});cleanups.push(()=>{client.terminate();});
  await once(client,'open');const [peer]=await peerPromise as [WebSocket];peer.on('error',()=>{});
  return {...h,upstream,peer,client,targets};
}

describe('public market transport boundary',()=>{
  it('routes only the fixed public stream categories and rejects duplicate/extra parameters',()=>{
    expect(publicStreamTarget(`${PREFIX}/stream?stream=btcusdt%40depth%40100ms`)).toBe('wss://fstream.binance.com/public/ws/btcusdt@depth@100ms');
    expect(publicStreamTarget(`${PREFIX}/stream?stream=ethusdt%40kline_1m`)).toBe('wss://fstream.binance.com/market/ws/ethusdt@kline_1m');
    for(const stream of ['btcusdt@order','!userData','http://127.0.0.1','../../private','btcusdt@depth?url=x'])expect(publicStreamTarget(`${PREFIX}/stream?stream=${encodeURIComponent(stream)}`)).toBeUndefined();
    for(const tail of ['&stream=ethusdt%40aggTrade','&url=https://evil.test','#fragment'])expect(publicStreamTarget(`${PREFIX}/stream?stream=btcusdt%40aggTrade${tail}`)).toBeUndefined();
  });
  it('enforces endpoint-specific keys, numeric bounds and non-ambiguous queries',()=>{
    const base=PREFIX+'/rest';
    expect(publicRestTarget(base+'/fapi/v1/depth?symbol=BTCUSDT&limit=1000')).toBe('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000');
    expect(publicRestTarget(base+'/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=1500')).toBeDefined();
    for(const url of ['/fapi/v1/order?symbol=BTCUSDT','/fapi/v1/depth?symbol=BTCUSDT&signature=x','/fapi/v1/depth?symbol=BTCUSDT&limit=1500','/fapi/v1/depth?symbol=../x',
      '/fapi/v1/depth?symbol=BTCUSDT&symbol=ETHUSDT','/fapi/v1/depth?symbol=BTCUSDT&s%79mbol=ETHUSDT','/fapi/v1/depth?symbol=BTCUSDT&interval=1m',
      '/fapi/v1/depth?symbol=BTCUSDT&limit=0','/fapi/v1/depth?symbol=BTCUSDT&limit=11','/fapi/v1/exchangeInfo?symbol=BTCUSDT',
      '/fapi/v1/aggTrades?symbol=BTCUSDT&fromId=9999999999999999','/fapi/v1/klines?symbol=BTCUSDT','/fapi/v1/klines?symbol=BTCUSDT&interval=1m&startTime=20&endTime=10'])expect(publicRestTarget(base+url)).toBeUndefined();
  });
  it('requires a local peer, local Host and exact Origin scheme/port including Referer',()=>{
    const req=(remote='127.0.0.1',headers:Record<string,string|undefined>={host:'127.0.0.1:5173',origin:'http://127.0.0.1:5173'})=>({headers,socket:{remoteAddress:remote}} as Parameters<typeof localPublicRequest>[0]);
    expect(localPublicRequest(req())).toBe(true);expect(localPublicRequest(req('::ffff:127.0.0.1'))).toBe(true);
    for(const remote of ['10.0.0.2','127.999.0.1'])expect(localPublicRequest(req(remote))).toBe(false);
    for(const headers of [
      {host:'127.0.0.1:5173',origin:'https://127.0.0.1:5173'}, {host:'127.0.0.1:5173',origin:'http://127.0.0.1:9999'},
      {host:'external.test',origin:'http://external.test'}, {host:'user@127.0.0.1:5173',origin:'http://127.0.0.1:5173'},
      {host:'127.0.0.1:5173',referer:'https://external.test/'}, {host:'127.0.0.1:5173','sec-fetch-site':'cross-site'},
    ])expect(localPublicRequest(req('127.0.0.1',headers))).toBe(false);
  });
  it('retains Request cancellation while stripping credentials and preserving custom endpoint behavior',async()=>{
    vi.stubGlobal('location',{hostname:'127.0.0.1',origin:'http://127.0.0.1:5173',protocol:'http:'});
    const request=vi.fn().mockResolvedValue(new Response('{}'));vi.stubGlobal('fetch',request);
    const abort=new AbortController(),input=new Request('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT',{signal:abort.signal,headers:{Authorization:'private','X-MBX-APIKEY':'private'}});
    await publicMarketRequest(input);
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:5173/api/market-public/binance/rest/fapi/v1/depth?symbol=BTCUSDT',expect.objectContaining({method:'GET',credentials:'omit',signal:input.signal,headers:{Accept:'application/json'}}));
    abort.abort();expect(request.mock.calls[0][1].signal.aborted).toBe(true);
    const post=new Request('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT',{method:'POST'});
    await publicMarketRequest(post);expect(request).toHaveBeenLastCalledWith(post,undefined);
    await publicMarketRequest('https://custom.test/public');expect(request).toHaveBeenLastCalledWith('https://custom.test/public',undefined);
  });
  it('bridges recognized legacy public sockets without rewriting other ports, credentials or origins',()=>{
    vi.stubGlobal('location',{hostname:'localhost',origin:'https://localhost:5173',protocol:'https:'});
    expect(publicMarketSocketUrl('wss://fstream.binance.com/ws/btcusdt@depth@100ms')).toBe(`wss://localhost:5173${PREFIX}/stream?stream=btcusdt%40depth%40100ms`);
    for(const url of ['wss://fstream.binance.com:444/ws/btcusdt@depth@100ms','wss://u:p@fstream.binance.com/ws/btcusdt@depth@100ms','wss://custom.test/ws/btcusdt@depth@100ms','wss://fstream.binance.com/ws/btcusdt@order'])expect(publicMarketSocketUrl(url)).toBe(url);
    vi.stubGlobal('location',{hostname:'charts.example.com',origin:'https://charts.example.com',protocol:'https:'});
    const upstream='wss://fstream.binance.com/public/ws/btcusdt@depth@100ms';expect(publicMarketSocketUrl(upstream)).toBe(upstream);
  });
});

describe('real loopback REST bridge',()=>{
  it('blocks POST and bad origins before upstream I/O and returns fresh depth JSON without rewriting it',async()=>{
    let update=0;const request=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(`{ "lastUpdateId": ${++update} }\n`));
    const h=await bridgeHarness({request:request as typeof fetch}),url=h.url+PREFIX+'/rest/fapi/v1/depth?symbol=BTCUSDT';
    expect((await fetch(url,{method:'POST'})).status).toBe(405);
    expect((await fetch(url,{headers:{Origin:'https://external.test'}})).status).toBe(403);expect(request).not.toHaveBeenCalled();
    expect(await (await fetch(url)).text()).toBe('{ "lastUpdateId": 1 }\n');expect(await (await fetch(url)).text()).toBe('{ "lastUpdateId": 2 }\n');
    expect(request.mock.calls[0][0]).toBe('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT');
    expect((request.mock.calls[0] as unknown[])[1]).toEqual(expect.objectContaining({credentials:'omit',redirect:'error',headers:{Accept:'application/json'}}));
  });
  it('aborts an in-flight upstream request when the browser disconnects',async()=>{
    let start!:(signal:AbortSignal)=>void;const started=new Promise<AbortSignal>(resolve=>{start=resolve;});
    const request:typeof fetch=async(_url,init)=>new Promise((_resolve,reject)=>{const signal=init!.signal!;start(signal);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
    const h=await bridgeHarness({request}),abort=new AbortController();
    const result=fetch(h.url+PREFIX+'/rest/fapi/v1/depth?symbol=BTCUSDT',{signal:abort.signal}).catch(()=>undefined),signal=await started;
    abort.abort();await result;await vi.waitFor(()=>expect(signal.aborted).toBe(true));
  });
  it('times out cleanly, returns generic errors and aborts remaining REST work on bridge close',async()=>{
    const signals:AbortSignal[]=[];
    const request:typeof fetch=async(_url,init)=>new Promise((_resolve,reject)=>{const signal=init!.signal!;signals.push(signal);signal.addEventListener('abort',()=>reject(new Error('secret-proxy-token')),{once:true});});
    const h=await bridgeHarness({request,restTimeoutMs:30}),url=h.url+PREFIX+'/rest/fapi/v1/depth?symbol=BTCUSDT';
    const response=await fetch(url);expect(response.status).toBe(502);expect(await response.text()).not.toContain('secret-proxy-token');expect(signals[0].aborted).toBe(true);
    const pending=fetch(url);await vi.waitFor(()=>expect(signals.length).toBe(2));h.bridge.close();expect((await pending).status).toBe(502);expect(signals[1].aborted).toBe(true);
    expect((await fetch(url)).status).toBe(503);
  });
  it('clears successful REST deadlines and never caches a depth sequence snapshot',async()=>{
    let signal:AbortSignal|undefined;
    const h=await bridgeHarness({restTimeoutMs:20,request:(async(_url,init)=>{signal=init?.signal??undefined;return new Response('{}');}) as typeof fetch});
    expect((await fetch(h.url+PREFIX+'/rest/fapi/v1/depth?symbol=BTCUSDT')).status).toBe(200);
    await new Promise(resolve=>setTimeout(resolve,35));expect(signal?.aborted).toBe(false);h.bridge.close();expect(signal?.aborted).toBe(false);
  });
  it('bounds concurrent REST requests and drains outstanding work on shutdown',async()=>{
    let active=0;
    const request:typeof fetch=async(_url,init)=>new Promise((_resolve,reject)=>{active++;init!.signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});
    const h=await bridgeHarness({request,restTimeoutMs:1000}),url=h.url+PREFIX+'/rest/fapi/v1/depth?symbol=BTCUSDT';
    const responses=Array.from({length:17},()=>fetch(url));
    const first=await Promise.any(responses);expect(first.status).toBe(429);expect(first.headers.get('retry-after')).toBe('1');expect(active).toBe(16);
    h.bridge.close();const all=await Promise.all(responses);expect(all.filter(response=>response.status===502)).toHaveLength(16);
  });
  it('limits response bytes before parsing and cancels oversized response bodies',async()=>{
    const cancel=vi.fn(),body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(1));},cancel});
    const h=await bridgeHarness({request:(async()=>new Response(body,{headers:{'Content-Length':String(9*1024*1024)}})) as typeof fetch});
    const response=await fetch(h.url+PREFIX+'/rest/fapi/v1/depth?symbol=BTCUSDT');expect(response.status).toBe(502);expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('real loopback WebSocket relay',()=>{
  it('keeps raw text text, rejects client commands, and terminates its upstream',async()=>{
    const h=await socketHarness(),message=once(h.client,'message'),wire=' {"u":123,"p":"0.000000001"}\n';
    h.peer.send(wire,{binary:false});const [data,isBinary]=await message;
    expect(data.toString()).toBe(wire);expect(isBinary).toBe(false);
    expect(h.targets).toEqual(['wss://fstream.binance.com/public/ws/btcusdt@depth@100ms']);
    const forwarded=vi.fn();h.peer.on('message',forwarded);const closed=once(h.client,'close'),upstreamClosed=once(h.peer,'close');h.client.send('subscribe');
    expect((await closed)[0]).toBe(1008);await upstreamClosed;expect(forwarded).not.toHaveBeenCalled();
  });
  it('signals a discontinuity on upstream loss so consumers must resynchronize',async()=>{
    const h=await socketHarness(),closed=once(h.client,'close');h.peer.close(1000,'upstream restarts');
    const [code,reason]=await closed;expect(code).toBe(1012);expect(reason.toString()).toBe('Market stream disconnected');
  });
  it('closes instead of silently dropping a frame that exceeds the outbound buffer budget',async()=>{
    const h=await socketHarness({maxBufferedBytes:64}),received=vi.fn();h.client.on('message',received);
    const closed=once(h.client,'close'),upstreamClosed=once(h.peer,'close');h.peer.send('x'.repeat(65));
    expect((await closed)[0]).toBe(1013);await upstreamClosed;expect(received).not.toHaveBeenCalled();
  });
  it('rejects binary upstream frames without coercing them into market text',async()=>{
    const h=await socketHarness(),closed=once(h.client,'close'),received=vi.fn();h.client.on('message',received);h.peer.send(Buffer.from('{}'),{binary:true});
    expect((await closed)[0]).toBe(1013);expect(received).not.toHaveBeenCalled();
  });
  it('detects an unresponsive upstream heartbeat and clears timers when clients close',async()=>{
    const h=await socketHarness({heartbeatMs:10,idleTimeoutMs:35,closeGraceMs:20},false),closed=once(h.client,'close'),peerClosed=once(h.peer,'close');
    expect((await closed)[0]).toBe(1012);await peerClosed;
    const healthy=await socketHarness({heartbeatMs:10,idleTimeoutMs:80});const pings=vi.fn();healthy.peer.on('ping',pings);
    await vi.waitFor(()=>expect(pings).toHaveBeenCalled());const upstreamClosed=once(healthy.peer,'close');healthy.client.close();await upstreamClosed;
    const count=pings.mock.calls.length;await new Promise(resolve=>setTimeout(resolve,35));expect(pings).toHaveBeenCalledTimes(count);
  });
  it('bounds a stalled upstream handshake and tears down live peers on bridge shutdown',async()=>{
    const stalled=createServer(),sockets=new Set<import('node:net').Socket>();stalled.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    stalled.on('upgrade',()=>{});const upstreamUrl=(await listen(stalled)).replace('http:','ws:');
    cleanups.push(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>stalled.close(()=>resolve()));});
    class StalledSocket extends WebSocket {constructor(_url:string,init:WebSocket.ClientOptions){super(upstreamUrl,{...init,agent:undefined});}}
    const h=await bridgeHarness({Socket:StalledSocket as typeof WebSocket,handshakeTimeoutMs:30});
    const client=new WebSocket(`${h.url.replace('http:','ws:')}${PREFIX}/stream?stream=btcusdt%40aggTrade`,{origin:h.url});client.on('error',()=>{});cleanups.push(()=>client.terminate());
    const closed=once(client,'close');await once(client,'open');expect((await closed)[0]).toBe(1011);
    const live=await socketHarness(),peerClosed=once(live.peer,'close'),clientClosed=once(live.client,'close');live.bridge.close();live.bridge.close();await Promise.all([peerClosed,clientClosed]);
    expect(live.client.readyState).toBe(WebSocket.CLOSED);expect(live.peer.readyState).toBe(WebSocket.CLOSED);
  });
  it('rejects invalid upgrade Origin and duplicate stream selectors before opening an upstream',async()=>{
    let sockets=0;class NeverSocket extends WebSocket{constructor(...args:ConstructorParameters<typeof WebSocket>){sockets++;super(...args);}}
    const h=await bridgeHarness({Socket:NeverSocket as typeof WebSocket});
    for(const [suffix,origin] of [['','https://evil.test'],['&stream=ethusdt%40aggTrade',h.url]]){
      const ws=new WebSocket(`${h.url.replace('http:','ws:')}${PREFIX}/stream?stream=btcusdt%40aggTrade${suffix}`,{origin});
      ws.on('error',()=>{});const [,response]=await once(ws,'unexpected-response');expect(response.statusCode).toBe(403);ws.terminate();
    }
    expect(sockets).toBe(0);
  });
});
