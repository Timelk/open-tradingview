import type {IncomingMessage,ServerResponse,Server} from 'node:http';
import type {Duplex} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {chmodSync,mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import WebSocket,{WebSocketServer,type RawData} from 'ws';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js';
import {localPublicRequest} from './public-market';
import {renderAgentDoc,renderGuide,renderReference} from './agent-docs';
import {INSTRUCTIONS,SERVER_INFO,registerTvchartTools,type ToolBackend} from '../mcp/tools';
import {AGENT_BRIDGE_AGENT_SOCKET,AGENT_BRIDGE_DISCOVERY_DIR,AGENT_BRIDGE_MCP_PATH,AGENT_BRIDGE_PREFIX,AGENT_BRIDGE_PROTOCOL,AGENT_BRIDGE_SOCKET,AGENT_DOC_PATHS,defaultCallTimeout,pickActiveChart,
  type AgentPresence,type AgentSocketMessage,type BridgeError,type BrowserMessage,type CallProgress,type ChartSessionInfo,type HubCallRequest,type HubCallResponse,type HubCallStreamLine,
  type HubChartsResponse,type HubDiscovery,type HubEvent,type HubEventsResponse,type HubMessage} from '../src/lib/agent/protocol';

export interface AgentBridgeHubOptions {
  /** Project root: discovery records and the skill files served as /llms.txt live below it. */
  root:string;
  writeDiscovery?:boolean;
  maxPayloadBytes?:number;heartbeatMs?:number;maxEvents?:number;maxBodyBytes?:number;
  /** An HTTP MCP session without an open stream ends after this much silence. */
  mcpIdleMs?:number;
}
interface Session {info:ChartSessionInfo;socket:WebSocket}
interface Pending {socket:WebSocket;chartId:string;finish:(value:HubCallResponse)=>void;progress?:(value:CallProgress)=>void}
interface AgentEntry extends AgentPresence {socket?:WebSocket}
/** HTTP clients are alive while their standalone SSE stream is open (SDK clients open one after
 * initialize and re-open it if it drops); clients without a stream count while they keep calling. */
interface McpSession {transport:StreamableHTTPServerTransport;server:McpServer;agentId:string;name:string;since:number;lastSeen:number;streams:number;usesStream:boolean}
const STREAM_GRACE_MS=5_000,CALL_PRESENCE_MS=90_000;
interface EventQuery {since:number;chartId?:string|null;types?:string[]}
const fail=(code:BridgeError['code'],message:string):HubCallResponse=>({ok:false,error:{code,message}});
const clean=(value:unknown)=>typeof value==='string'?value.replace(/[^\w .:@/-]/g,'').slice(0,60):'';
const NO_CHART='No chart page is connected to this dev server. Open the app in a browser tab (the URL printed by `pnpm dev`).';

/** Local relay between chart pages (same-origin WebSocket) and AI clients:
 * MCP over stdio (mcp/server.ts, via loopback HTTP + a presence socket) or
 * MCP over Streamable HTTP served right here at /mcp. It holds no chart data
 * itself — every call is answered by the page — and it is the authority on
 * which AI clients are actually connected. Local-only by design: loopback
 * and same-origin checks, no authentication. */
export function createAgentBridgeHub(options:AgentBridgeHubOptions){
  const maxBody=options.maxBodyBytes??8*1024*1024,maxEvents=options.maxEvents??500,heartbeatMs=options.heartbeatMs??20_000,mcpIdle=options.mcpIdleMs??15*60_000;
  const wss=new WebSocketServer({noServer:true,maxPayload:options.maxPayloadBytes??48*1024*1024,perMessageDeflate:false});
  const agentWss=new WebSocketServer({noServer:true,maxPayload:64*1024,perMessageDeflate:false});
  const sessions=new Map<string,Session>(),pending=new Map<string,Pending>(),alive=new WeakSet<WebSocket>();
  const agents=new Map<string,AgentEntry>(),mcpSessions=new Map<string,McpSession>();
  const events:HubEvent[]=[],waiters=new Set<{check:()=>void;done:()=>void}>(),eventListeners=new Set<(event:HubEvent)=>void>();
  const instance=randomUUID();
  let seq=0,closed=false,discoveryFile:string|undefined,selfUrl='',agentsKey='';

  const send=(socket:WebSocket,message:HubMessage)=>{if(socket.readyState!==WebSocket.OPEN)return false;socket.send(JSON.stringify(message));return true;};
  const charts=():HubChartsResponse=>{
    const list=[...sessions.values()].map(session=>session.info),active=pickActiveChart(list);
    return {charts:list.map(info=>({...info,active:info.chartId===active?.chartId})),activeChartId:active?.chartId??null};
  };
  const agentList=():AgentPresence[]=>[...agents.values()].map(({socket:_socket,...info})=>info).sort((a,b)=>a.since-b.since);
  /** Pages show "AI 已连接" from this list; it changes only when a client connects or leaves. */
  const broadcastAgents=(force=false)=>{
    const list=agentList(),key=JSON.stringify(list.map(agent=>[agent.id,agent.name,agent.transport]));
    if(!force&&key===agentsKey)return;agentsKey=key;
    for(const socket of wss.clients)send(socket,{type:'agents',agents:list});
  };
  const touchAgent=(id:string|undefined)=>{const agent=id?agents.get(id):undefined;if(agent)agent.lastSeen=Date.now();};
  const httpPresent=(session:McpSession,now:number)=>session.streams>0||now-session.lastSeen<(session.usesStream?STREAM_GRACE_MS:CALL_PRESENCE_MS);
  /** Re-derive HTTP presence from session liveness; pages hear about it only when it changes. */
  const syncHttpPresence=()=>{
    const now=Date.now();let changed=false;
    for(const session of mcpSessions.values()){
      const present=httpPresent(session,now),entry=agents.get(session.agentId);
      if(present&&!entry){agents.set(session.agentId,{id:session.agentId,name:session.name,transport:'http',since:session.since,lastSeen:session.lastSeen});changed=true;}
      else if(!present&&entry){agents.delete(session.agentId);changed=true;}
      else if(entry)entry.lastSeen=session.lastSeen;
    }
    if(changed)broadcastAgents();
  };
  const touchSession=(session:McpSession|undefined)=>{if(session){session.lastSeen=Date.now();syncHttpPresence();}};
  /** Chart events feed the long-poll buffer, in-process MCP sessions and every connected MCP process (streaming). */
  const pushEvent=(chartId:string,event:Omit<HubEvent,'seq'|'chartId'>)=>{
    const entry:HubEvent={...event,seq:++seq,chartId};
    events.push(entry);if(events.length>maxEvents)events.splice(0,events.length-maxEvents);
    for(const waiter of [...waiters])waiter.check();
    for(const listener of [...eventListeners])try{listener(entry);}catch{/* A listener cannot break the relay. */}
    const pushed=JSON.stringify({type:'event',event:entry} satisfies AgentSocketMessage);
    for(const socket of agentWss.clients)if(socket.readyState===WebSocket.OPEN)socket.send(pushed);
  };
  const dropSocket=(socket:WebSocket)=>{
    for(const [id,session] of sessions)if(session.socket===socket)sessions.delete(id);
    for(const [id,call] of pending)if(call.socket===socket){pending.delete(id);call.finish(fail('CHART_DISCONNECTED','the chart page closed or reloaded during the call'));}
  };
  const register=(socket:WebSocket,info:unknown)=>{
    if(!info||typeof info!=='object')return;
    const chart=info as ChartSessionInfo;if(typeof chart.chartId!=='string'||!/^[\w:.-]{1,80}$/.test(chart.chartId))return;
    const owner=sessions.get(chart.chartId);if(owner&&owner.socket!==socket&&owner.socket.readyState===WebSocket.OPEN)return;
    sessions.set(chart.chartId,{socket,info:{...chart,lastActiveAt:Number(chart.lastActiveAt)||Date.now()}});
  };
  const pageConnection=(socket:WebSocket)=>{
    alive.add(socket);socket.on('pong',()=>alive.add(socket));
    send(socket,{type:'welcome',protocol:AGENT_BRIDGE_PROTOCOL});send(socket,{type:'agents',agents:agentList()});
    socket.on('message',(data:RawData,binary:boolean)=>{
      if(binary)return;let message:BrowserMessage;
      try{message=JSON.parse(String(data));}catch{return;}
      if(message.type==='hello'){if(message.protocol!==AGENT_BRIDGE_PROTOCOL){socket.close(1008,'Unsupported agent bridge protocol');return;}for(const chart of message.charts??[])register(socket,chart);}
      else if(message.type==='chart')register(socket,message.chart);
      else if(message.type==='chart-closed'){const owner=sessions.get(message.chartId);if(owner?.socket===socket)sessions.delete(message.chartId);}
      else if(message.type==='result'){
        const call=pending.get(message.id);if(!call||call.socket!==socket)return;pending.delete(message.id);
        call.finish(message.ok?{ok:true,chartId:call.chartId,result:message.result}:{ok:false,error:message.error});
      }else if(message.type==='progress'){
        const call=pending.get(message.id);if(call?.socket===socket&&message.progress&&typeof message.progress.message==='string')call.progress?.(message.progress);
      }else if(message.type==='event'){
        const owner=sessions.get(message.chartId);
        if(owner?.socket===socket&&message.event&&typeof message.event.type==='string')pushEvent(message.chartId,{type:message.event.type,at:Number(message.event.at)||Date.now(),data:message.event.data??{}});
      }
    });
    socket.on('close',()=>dropSocket(socket));socket.on('error',()=>dropSocket(socket));
  };
  /** An MCP stdio process stays connected here for as long as it runs. */
  const agentConnection=(socket:WebSocket,req:IncomingMessage)=>{
    const id=clean(req.headers['x-tvchart-agent-id'])||`agent-${randomUUID().slice(0,8)}`,name=clean(req.headers['x-tvchart-agent'])||'mcp',now=Date.now();
    const previous=agents.get(id);if(previous?.socket&&previous.socket!==socket)previous.socket.terminate();
    agents.set(id,{id,name,transport:'stdio',since:previous?.since??now,lastSeen:now,socket});broadcastAgents();
    alive.add(socket);socket.on('pong',()=>{alive.add(socket);touchAgent(id);});
    const leave=()=>{if(agents.get(id)?.socket===socket){agents.delete(id);broadcastAgents();}};
    socket.on('close',leave);socket.on('error',leave);
  };
  const heartbeat=setInterval(()=>{
    for(const socket of [...wss.clients,...agentWss.clients]){if(!alive.has(socket)){socket.terminate();continue;}alive.delete(socket);socket.ping();}
    const now=Date.now();
    for(const [sessionId,session] of mcpSessions)if(!session.streams&&now-session.lastSeen>mcpIdle)closeMcp(sessionId);
  },heartbeatMs);heartbeat.unref();
  const presenceSweep=setInterval(syncHttpPresence,2000);presenceSweep.unref();

  function call(request:HubCallRequest,agent:string,progress?:(value:CallProgress)=>void):Promise<HubCallResponse> {
    if(!request||typeof request.method!=='string'||!/^[\w.]{1,40}$/.test(request.method))return Promise.resolve(fail('BAD_REQUEST','method is required'));
    if(!sessions.size)return Promise.resolve(fail('NO_CHART',NO_CHART));
    const target=request.chartId?sessions.get(request.chartId):sessions.get(charts().activeChartId!);
    if(!target)return Promise.resolve(fail('CHART_NOT_FOUND',`chart "${request.chartId}" is not connected; call list_charts`));
    const id=randomUUID(),timeout=Math.min(180_000,Math.max(1000,Number(request.timeoutMs)||defaultCallTimeout(request.method)));
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{if(pending.delete(id)){send(target.socket,{type:'cancel',id});resolve(fail('TIMEOUT',`the chart did not answer "${request.method}" within ${timeout} ms`));}},timeout);
      pending.set(id,{socket:target.socket,chartId:target.info.chartId,progress,finish:value=>{clearTimeout(timer);resolve(value);}});
      if(!send(target.socket,{type:'call',id,chartId:target.info.chartId,method:request.method,params:request.params??{},agent}))pending.get(id)?.finish(fail('CHART_DISCONNECTED','the chart connection is closing'));
    });
  }
  function readEvents(query:EventQuery):HubEventsResponse {
    return {events:events.filter(e=>e.seq>query.since&&(!query.chartId||e.chartId===query.chartId)&&(!query.types?.length||query.types.includes(e.type))).slice(-200),next:seq};
  }
  function waitEvents(query:EventQuery,waitMs:number,cancel?:ServerResponse):Promise<HubEventsResponse> {
    const now=readEvents(query);if(now.events.length||waitMs<=0)return Promise.resolve(now);
    return new Promise(resolve=>{
      let finished=false;
      const done=()=>{if(finished)return;finished=true;clearTimeout(timer);waiters.delete(waiter);cancel?.off('close',done);resolve(readEvents(query));};
      const waiter={check:()=>{if(readEvents(query).events.length)done();},done};
      const timer=setTimeout(done,waitMs);waiters.add(waiter);cancel?.once('close',done);
    });
  }
  /** Tools of an HTTP MCP session run in-process against this hub. */
  const backendFor=(who:()=>{name:string;touch:()=>void}):ToolBackend=>({
    unavailable:()=>null,
    charts:async()=>{const listing=charts();return {charts:listing.charts.map(chart=>({...chart,hub:selfUrl})),activeChartId:listing.activeChartId,hubs:[{url:selfUrl,ok:true}]};},
    subscribe:listener=>{eventListeners.add(listener);return ()=>{eventListeners.delete(listener);};},
    call:async(method,params,chartId,timeoutMs,progress)=>{
      const agent=who();agent.touch();
      const response=await call({method,params,chartId,timeoutMs},agent.name,progress);if(!response.ok)return response;
      const chart=charts().charts.find(item=>item.chartId===response.chartId);
      return {...response,...(chart?{chart:{...chart,hub:selfUrl}}:{})};
    },
    events:async request=>{
      const chartId=request.chartId??charts().activeChartId;
      if(!chartId)return {error:{code:'NO_CHART',message:NO_CHART}};
      if(!sessions.has(chartId))return {error:{code:'CHART_NOT_FOUND',message:`chart "${chartId}" is not connected; call list_charts`}};
      who().touch();
      return {...await waitEvents({since:request.since??0,chartId,types:request.types},Math.min(25_000,Math.max(0,request.waitMs??0))),hub:selfUrl,chartId};
    },
  });
  function closeMcp(sessionId:string){
    const session=mcpSessions.get(sessionId);if(!session)return;
    mcpSessions.delete(sessionId);if(agents.delete(session.agentId))broadcastAgents();
    void session.server.close().catch(()=>{});
  }
  async function handleMcp(req:IncomingMessage,res:ServerResponse,body:unknown){
    const header=req.headers['mcp-session-id'],sessionId=typeof header==='string'?header:undefined,existing=sessionId?mcpSessions.get(sessionId):undefined;
    if(existing){
      if(req.method==='GET'){
        existing.streams++;existing.usesStream=true;
        res.once('close',()=>{existing.streams=Math.max(0,existing.streams-1);existing.lastSeen=Date.now();setTimeout(syncHttpPresence,STREAM_GRACE_MS+50).unref();});
      }
      touchSession(existing);
      await existing.transport.handleRequest(req,res,body);return;
    }
    if(sessionId||req.method!=='POST'||!isInitializeRequest(body)){
      res.statusCode=sessionId?404:400;res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({jsonrpc:'2.0',error:{code:-32000,message:sessionId?'Unknown or expired MCP session; initialize a new one':'Send an initialize request to start a session'},id:null}));return;
    }
    const clientName=clean((body as {params?:{clientInfo?:{name?:unknown}}}).params?.clientInfo?.name)||'mcp',server=new McpServer(SERVER_INFO,{instructions:INSTRUCTIONS});
    let session:McpSession|undefined;
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),
      onsessioninitialized:id=>{
        const now=Date.now();session={transport,server,agentId:`http-${id.slice(0,8)}`,name:clientName,since:now,lastSeen:now,streams:0,usesStream:false};
        mcpSessions.set(id,session);syncHttpPresence();
      },
      onsessionclosed:id=>closeMcp(id)});
    transport.onclose=()=>{if(transport.sessionId)closeMcp(transport.sessionId);};
    const release=registerTvchartTools(server,backendFor(()=>({name:clientName,touch:()=>touchSession(session)})),{guide:()=>renderGuide(options.root)});
    server.server.onclose=()=>release();
    await server.connect(transport);
    await transport.handleRequest(req,res,body);
  }
  const readBody=(req:IncomingMessage)=>new Promise<unknown>((resolve,reject)=>{
    const chunks:Buffer[]=[];let size=0;
    req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBody){reject(Error('Request body too large'));req.destroy();return;}chunks.push(chunk);});
    req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{reject(Error('Invalid JSON'));}});
    req.on('error',reject);
  });
  const originOf=(req:IncomingMessage)=>`${(req.socket as IncomingMessage['socket']&{encrypted?:boolean}).encrypted?'https':'http'}://${req.headers.host??'localhost'}`;
  const middleware=async(req:IncomingMessage,res:ServerResponse,next:()=>void)=>{
    const url=new URL(req.url??'/','http://localhost'),path=url.pathname;
    const doc=(AGENT_DOC_PATHS as readonly string[]).includes(path),mcp=path===AGENT_BRIDGE_MCP_PATH;
    const api=path.startsWith(AGENT_BRIDGE_PREFIX+'/')&&path!==AGENT_BRIDGE_SOCKET&&path!==AGENT_BRIDGE_AGENT_SOCKET;
    if(!doc&&!mcp&&!api){next();return;}
    const reply=(code:number,body:unknown,type='application/json')=>{
      if(res.writableEnded)return;res.statusCode=code;res.setHeader('Content-Type',type);res.setHeader('Cache-Control','no-store');
      res.end(typeof body==='string'?body:JSON.stringify(body));
    };
    if(closed){reply(503,{message:'agent bridge closed'});return;}
    if(!localPublicRequest(req)){reply(403,{message:'loopback same-origin requests only'});return;}
    try{
      if(doc&&req.method==='GET'){reply(200,renderAgentDoc({root:options.root,origin:originOf(req),charts:charts(),agents:agentList(),full:path==='/llms-full.txt'}),'text/plain; charset=utf-8');return;}
      if(mcp){await handleMcp(req,res,req.method==='POST'?await readBody(req):undefined);return;}
      const route=path.slice(AGENT_BRIDGE_PREFIX.length),agentId=clean(req.headers['x-tvchart-agent-id'])||undefined;
      if(route==='/health'&&req.method==='GET'){reply(200,{ok:true,protocol:AGENT_BRIDGE_PROTOCOL,charts:sessions.size,agents:agents.size});return;}
      if(route==='/charts'&&req.method==='GET'){reply(200,{...charts(),agents:agentList()});return;}
      if(route==='/call'&&req.method==='POST'){
        touchAgent(agentId);const request=await readBody(req) as HubCallRequest,agent=clean(req.headers['x-tvchart-agent'])||'http';
        if(!String(req.headers.accept??'').includes('application/x-ndjson')){reply(200,await call(request,agent));return;}
        // Streaming answer: one JSON line per progress update, then the result line.
        res.statusCode=200;res.setHeader('Content-Type','application/x-ndjson');res.setHeader('Cache-Control','no-store');res.flushHeaders();
        const line=(value:HubCallStreamLine)=>{if(!res.writableEnded)res.write(JSON.stringify(value)+'\n');};
        const result=await call(request,agent,progress=>line({type:'progress',progress}));line({type:'result',...result});res.end();return;
      }
      if(route==='/events'&&req.method==='GET'){
        touchAgent(agentId);
        const query={since:Number(url.searchParams.get('since')??0),chartId:url.searchParams.get('chartId'),types:url.searchParams.get('types')?.split(',').filter(Boolean)};
        reply(200,await waitEvents(query,Math.min(25_000,Math.max(0,Number(url.searchParams.get('waitMs'))||0)),res));return;
      }
      const reference=/^\/docs\/([\w-]+)\.md$/.exec(route);
      if(reference&&req.method==='GET'){const text=renderReference(options.root,reference[1]);if(text)reply(200,text,'text/markdown; charset=utf-8');else reply(404,{message:'unknown document'});return;}
      reply(404,{message:'unknown agent bridge endpoint'});
    }catch(error){reply(400,{message:error instanceof Error?error.message:String(error)});}
  };
  const upgrade=(req:IncomingMessage,socket:Duplex,head:Buffer)=>{
    const path=req.url?.split('?')[0];if(path!==AGENT_BRIDGE_SOCKET&&path!==AGENT_BRIDGE_AGENT_SOCKET)return;
    const page=path===AGENT_BRIDGE_SOCKET;
    // Chart pages are browsers (they always send Origin); agents are local processes.
    if(closed||req.method!=='GET'||!localPublicRequest(req)||(page?typeof req.headers.origin!=='string'||wss.clients.size>=16:agentWss.clients.size>=32)){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    if(page)wss.handleUpgrade(req,socket,head,pageConnection);else agentWss.handleUpgrade(req,socket,head,client=>agentConnection(client,req));
  };
  function publish(server:Server){
    const address=server.address();if(!address||typeof address==='string'||closed)return;
    selfUrl=`${'setSecureContext' in server?'https':'http'}://localhost:${address.port}`;
    if(options.writeDiscovery===false)return;
    const record:HubDiscovery={version:1,url:selfUrl,pid:process.pid,startedAt:Date.now(),root:options.root,instance};
    const directory=join(options.root,AGENT_BRIDGE_DISCOVERY_DIR),file=join(directory,`${address.port}.json`),temp=`${file}.${process.pid}.tmp`;
    try{
      mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
      writeFileSync(temp,JSON.stringify(record,null,2),{mode:0o600});renameSync(temp,file);discoveryFile=file;
    }catch(error){console.warn(`[agent-bridge] discovery file not written: ${error instanceof Error?error.message:error}`);}
  }
  function unpublish(){
    const file=discoveryFile;discoveryFile=undefined;if(!file)return;
    // A restarted server on the same port may already have replaced the record.
    try{if((JSON.parse(readFileSync(file,'utf8')) as HubDiscovery).instance===instance)rmSync(file,{force:true});}catch{/* Already replaced or removed. */}
  }
  return {
    middleware,call,charts,agents:agentList,
    attach(server:Server){
      const listening=()=>publish(server);
      server.on('upgrade',upgrade);if(server.listening)publish(server);else server.on('listening',listening);
      return ()=>{server.off('upgrade',upgrade);server.off('listening',listening);};
    },
    close(){
      if(closed)return;closed=true;clearInterval(heartbeat);clearInterval(presenceSweep);unpublish();
      for(const waiter of [...waiters])waiter.done();
      for(const [id,call] of pending){pending.delete(id);call.finish(fail('CHART_DISCONNECTED','the dev server is shutting down'));}
      for(const sessionId of [...mcpSessions.keys()])closeMcp(sessionId);eventListeners.clear();
      for(const socket of [...wss.clients,...agentWss.clients])socket.terminate();
      sessions.clear();agents.clear();wss.close();agentWss.close();
    },
  };
}
export type AgentBridgeHub=ReturnType<typeof createAgentBridgeHub>;
