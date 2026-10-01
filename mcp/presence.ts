import WebSocket from 'ws';
import {AGENT_BRIDGE_AGENT_SOCKET,type AgentSocketMessage} from '../src/lib/agent/protocol.ts';
import type {HubClient} from './hub-client.ts';

/** While this MCP process lives it keeps one presence socket per running
 * TVCHART server, so the chart shows "AI 已连接" exactly as long as an AI
 * client really has the tools loaded. The same socket streams chart events
 * back (resource subscriptions). Dropped sockets are re-dialled. */
export class AgentPresenceLink {
  private sockets=new Map<string,WebSocket>();
  private timer:ReturnType<typeof setInterval>|undefined;
  private options:{hub:HubClient;id:string;name:()=>string;intervalMs?:number};
  constructor(options:{hub:HubClient;id:string;name:()=>string;intervalMs?:number}){this.options=options;}
  start():void {if(this.timer)return;this.refresh();this.timer=setInterval(()=>this.refresh(),this.options.intervalMs??5000);}
  stop():void {clearInterval(this.timer);this.timer=undefined;for(const socket of this.sockets.values())socket.terminate();this.sockets.clear();}
  private refresh():void {
    const wanted=new Set(this.options.hub.endpoints().map(endpoint=>endpoint.url));
    for(const [url,socket] of this.sockets)if(!wanted.has(url)){socket.terminate();this.sockets.delete(url);}
    for(const url of wanted){
      if(this.sockets.has(url))continue;
      const socket=new WebSocket(url.replace(/^http/,'ws')+AGENT_BRIDGE_AGENT_SOCKET,{headers:{'x-tvchart-agent':this.options.name(),'x-tvchart-agent-id':this.options.id}});
      socket.on('error',()=>{/* The next refresh re-dials. */});
      socket.on('message',data=>{
        let message:AgentSocketMessage;try{message=JSON.parse(String(data));}catch{return;}
        if(message.type==='event'&&message.event)this.options.hub.emit(message.event);
      });
      socket.on('close',()=>{if(this.sockets.get(url)===socket)this.sockets.delete(url);});
      this.sockets.set(url,socket);
    }
  }
}
