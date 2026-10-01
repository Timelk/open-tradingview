import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {createAgentBridgeHub} from '../../server/agent-bridge';
import type {AgentPresence,ChartSessionInfo,HubMessage} from '../../src/lib/agent/protocol';

/** Real hub on an ephemeral port plus stand-in chart pages for bridge tests. */
export const cleanups:(()=>void)[]=[];
export async function startHub(){
  const root=mkdtempSync(join(tmpdir(),'tvchart-bridge-'));
  // A minimal skill so /llms.txt and the guide resource have content to serve.
  mkdirSync(join(root,'.claude/skills/tvchart-agent/reference'),{recursive:true});
  writeFileSync(join(root,'.claude/skills/tvchart-agent/SKILL.md'),'---\nname: tvchart-agent\ndescription: test\n---\n\n# Skill body\n\n## 1. The loop\n\nOrient with get_chart_state. See `reference/drawing-tools.md`.\n');
  writeFileSync(join(root,'.claude/skills/tvchart-agent/reference/drawing-tools.md'),'# Drawing tools\n\n| id | points |\n|---|---|\n| `trend-line` | A, B |\n');
  const hub=createAgentBridgeHub({root,heartbeatMs:60_000});
  const server=createServer((req,res)=>{void hub.middleware(req,res,()=>{res.statusCode=404;res.end();});});
  const detach=hub.attach(server);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(()=>{detach();hub.close();server.close();});
  return {root,hub,base};
}
export const chart=(chartId:string,patch:Partial<ChartSessionInfo>={}):ChartSessionInfo=>({chartId,title:chartId,url:'http://localhost/',source:'mock',symbol:'BTCUSDT',interval:'1m',loading:false,focused:false,visible:true,lastActiveAt:1,writable:true,...patch});
type Call=Extract<HubMessage,{type:'call'}>;
/** A stand-in chart page speaking the browser side of the protocol. `answer`
 * may stream progress through the second argument before returning. */
export async function page(base:string,charts:ChartSessionInfo[],answer:(call:Call,progress:(message:string)=>void)=>unknown=call=>({echo:call.method,params:call.params,chartId:call.chartId}),origin=base){
  const socket=new WebSocket(`${base.replace('http','ws')}/api/agent-bridge/browser`,{headers:{origin}});
  cleanups.push(()=>socket.terminate());
  const calls:Call[]=[],agents:AgentPresence[][]=[];
  socket.on('message',async raw=>{
    const message=JSON.parse(String(raw)) as HubMessage;
    if(message.type==='agents'){agents.push(message.agents);return;}
    if(message.type!=='call')return;calls.push(message);
    const result=await answer(message,text=>socket.send(JSON.stringify({type:'progress',id:message.id,progress:{message:text}})));if(result===undefined)return;
    socket.send(JSON.stringify(result instanceof Error?{type:'result',id:message.id,ok:false,error:{code:'FAILED',message:result.message}}:{type:'result',id:message.id,ok:true,result}));
  });
  await new Promise<void>((resolve,reject)=>{socket.once('open',()=>{socket.send(JSON.stringify({type:'hello',protocol:1,charts}));resolve();});socket.once('error',reject);});
  await new Promise(resolve=>setTimeout(resolve,30));
  return {socket,calls,agents,event:(chartId:string,type:'selection'|'market'|'scene',data:Record<string,unknown>={})=>socket.send(JSON.stringify({type:'event',chartId,event:{type,at:Date.now(),data}}))};
}
export const api=(base:string,path:string,init:{method?:string;body?:unknown;headers?:Record<string,string>}={})=>fetch(`${base}/api/agent-bridge${path}`,{method:init.method??(init.body?'POST':'GET'),
  headers:{'content-type':'application/json','x-tvchart-agent':'vitest',...init.headers},...(init.body?{body:JSON.stringify(init.body)}:{})});
export const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until<T>(read:()=>T|undefined|false,timeoutMs=3000):Promise<T>{
  const end=Date.now()+timeoutMs;for(;;){const value=read();if(value)return value;if(Date.now()>end)throw Error('condition not met in time');await wait(20);}
}
