import {writable,type Readable} from 'svelte/store';
import {AGENT_BRIDGE_PREFIX,AGENT_BRIDGE_PROTOCOL,AGENT_BRIDGE_SOCKET,type AgentPresence,type BrowserMessage,type ChartEvent,type ChartSessionInfo,type HubMessage} from './protocol';
import {AgentBridgeError,toBridgeError} from './errors';
import type {ChartAgentAdapter} from './chart-adapter';

export type BridgeConnection='off'|'connecting'|'connected'|'unavailable';
export interface AgentBridgeStatus {
  /** Page ⇄ local hub link. It says nothing about AI clients; `agents` does. */
  connection:BridgeConnection;
  /** AI clients the hub knows are connected right now (live MCP processes / HTTP sessions). */
  agents:AgentPresence[];
  writable:boolean;busy:boolean;calls:number;
  lastCall:{method:string;agent:string;at:number;ok:boolean}|null;
}
const SETTINGS_KEY='tvchart.agent-bridge.v1';
const INFO_INTERVAL=1000,ACTIVITY_THROTTLE=1500,MAX_RETRY=30_000;
function readWritable():boolean {
  try{const raw=localStorage.getItem(SETTINGS_KEY);return raw?JSON.parse(raw).writable!==false:true;}catch{return true;}
}
/** Per page load: a duplicated tab copies sessionStorage, so ids are never persisted. */
export const newChartId=():string=>`chart-${crypto.randomUUID().slice(0,8)}`;
interface Registration {adapter:ChartAgentAdapter;lastActiveAt:number;sent:string;off:()=>void}

/** Browser end of the local agent bridge. It only talks to the page's own
 * origin (the Vite dev/preview server hosting the hub) and stays idle when
 * that server has no hub, e.g. a static deployment. */
export class AgentBridgeClient {
  private socket:WebSocket|null=null;
  private charts=new Map<string,Registration>();
  private state=writable<AgentBridgeStatus>({connection:'off',agents:[],writable:readWritable(),busy:false,calls:0,lastCall:null});
  private snapshot:AgentBridgeStatus={connection:'off',agents:[],writable:readWritable(),busy:false,calls:0,lastCall:null};
  readonly status:Readable<AgentBridgeStatus>={subscribe:this.state.subscribe};
  private retry=0;
  private retryTimer:ReturnType<typeof setTimeout>|undefined;
  private infoTimer:ReturnType<typeof setInterval>|undefined;
  private events:AbortController|null=null;
  private running=0;

  start():void {
    if(this.events)return;
    this.events=new AbortController();const signal=this.events.signal;
    const touch=(event:Event)=>this.touch(event.target);
    for(const type of ['pointerdown','keydown','focusin'])window.addEventListener(type,touch,{capture:true,signal,passive:true});
    window.addEventListener('wheel',touch,{capture:true,signal,passive:true});
    window.addEventListener('focus',()=>this.touch(null),{signal});
    window.addEventListener('blur',()=>this.publishInfo(),{signal});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')this.touch(null);else this.publishInfo();},{signal});
    this.infoTimer=setInterval(()=>{
      for(const entry of this.charts.values())try{entry.adapter.sync();}catch(error){console.warn('[agent-bridge] overlay sync failed',error);}
      this.publishInfo();
    },INFO_INTERVAL);
    void this.connect();
  }
  stop():void {
    this.events?.abort();this.events=null;clearInterval(this.infoTimer);clearTimeout(this.retryTimer);
    const socket=this.socket;this.socket=null;socket?.close();this.update({connection:'off',agents:[],busy:false});
  }
  register(adapter:ChartAgentAdapter):()=>void {
    this.charts.get(adapter.chartId)?.off();
    const entry:Registration={adapter,lastActiveAt:Date.now(),sent:'',off:()=>{}};
    const unsubscribe=adapter.subscribe(event=>this.forward(adapter.chartId,event));
    entry.off=()=>{unsubscribe();if(this.charts.get(adapter.chartId)===entry){this.charts.delete(adapter.chartId);this.send({type:'chart-closed',chartId:adapter.chartId});}};
    this.charts.set(adapter.chartId,entry);this.publishInfo();
    return entry.off;
  }
  setWritable(value:boolean):void {
    try{localStorage.setItem(SETTINGS_KEY,JSON.stringify({writable:value}));}catch{/* The switch still applies to this page. */}
    this.update({writable:value});this.publishInfo(true);
  }

  private update(patch:Partial<AgentBridgeStatus>):void {this.snapshot={...this.snapshot,...patch};this.state.set(this.snapshot);}
  private info(entry:Registration):ChartSessionInfo {
    return {chartId:entry.adapter.chartId,...entry.adapter.info(),url:location.href,focused:document.hasFocus(),visible:document.visibilityState==='visible',lastActiveAt:entry.lastActiveAt,writable:this.snapshot.writable};
  }
  private publishInfo(force=false):void {
    for(const entry of this.charts.values()){
      const info=this.info(entry),key=JSON.stringify(info);
      if(!force&&key===entry.sent)continue;
      if(this.send({type:'chart',chart:info}))entry.sent=key;
    }
  }
  /** Any interaction marks the chart under it (or the page's only chart) as the one the user is on. */
  private touch(target:EventTarget|null):void {
    const now=Date.now(),node=target instanceof Node?target:null;
    const hit=[...this.charts.values()].find(entry=>node&&entry.adapter.contains(node))??(this.charts.size===1?[...this.charts.values()][0]:undefined);
    if(hit&&now-hit.lastActiveAt>ACTIVITY_THROTTLE)hit.lastActiveAt=now;
    this.publishInfo();
  }
  private forward(chartId:string,event:ChartEvent):void {this.send({type:'event',chartId,event});}
  private send(message:BrowserMessage):boolean {
    const socket=this.socket;if(!socket||socket.readyState!==WebSocket.OPEN)return false;
    try{socket.send(JSON.stringify(message));return true;}catch{return false;}
  }
  private schedule():void {
    if(!this.events)return;
    clearTimeout(this.retryTimer);const delay=Math.min(MAX_RETRY,1000*2**this.retry++);
    this.retryTimer=setTimeout(()=>void this.connect(),delay);
  }
  private async connect():Promise<void> {
    if(!this.events||this.socket)return;
    this.update({connection:'connecting'});
    try{
      const response=await fetch(`${AGENT_BRIDGE_PREFIX}/health`,{cache:'no-store',credentials:'same-origin'});
      if(response.status===404){this.update({connection:'unavailable'});return;}
      if(!response.ok)throw Error(String(response.status));
    }catch{this.schedule();return;}
    if(!this.events||this.socket)return;
    const url=new URL(AGENT_BRIDGE_SOCKET,location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const socket=new WebSocket(url);this.socket=socket;
    socket.onopen=()=>{
      this.retry=0;this.update({connection:'connected'});
      for(const entry of this.charts.values())entry.sent='';
      this.send({type:'hello',protocol:AGENT_BRIDGE_PROTOCOL,charts:[...this.charts.values()].map(entry=>this.info(entry))});
      for(const entry of this.charts.values())entry.sent=JSON.stringify(this.info(entry));
    };
    socket.onmessage=event=>{if(typeof event.data==='string')void this.receive(event.data);};
    socket.onclose=()=>{if(this.socket!==socket)return;this.socket=null;this.update({connection:'connecting',agents:[]});this.schedule();};
    socket.onerror=()=>socket.close();
  }
  private async receive(raw:string):Promise<void> {
    let message:HubMessage;try{message=JSON.parse(raw);}catch{return;}
    if(message.type==='agents'){this.update({agents:Array.isArray(message.agents)?message.agents:[]});return;}
    if(message.type!=='call')return;
    const entry=this.charts.get(message.chartId),started=Date.now();
    this.running++;this.update({busy:true});
    let reply:BrowserMessage;
    try{
      if(!entry)throw new AgentBridgeError('CHART_NOT_FOUND',`chart ${message.chartId} is no longer on this page`);
      // Long calls stream their phases back through the hub to the MCP client.
      const progress=(value:{message:string;progress?:number;total?:number})=>{this.send({type:'progress',id:message.id,progress:value});};
      reply={type:'result',id:message.id,ok:true,result:await entry.adapter.handle(message.method,message.params,this.snapshot.writable,progress)};
    }catch(error){reply={type:'result',id:message.id,ok:false,error:toBridgeError(error)};}
    this.running--;
    this.update({busy:this.running>0,calls:this.snapshot.calls+1,lastCall:{method:message.method,agent:message.agent,at:started,ok:reply.ok}});
    if(!this.send(reply)){/* The hub times the call out; nothing else to do. */}
  }
}
/** One bridge per page; charts register and unregister with their lifecycle. */
export const agentBridge=new AgentBridgeClient();
if(import.meta.hot)import.meta.hot.dispose(()=>agentBridge.stop());
