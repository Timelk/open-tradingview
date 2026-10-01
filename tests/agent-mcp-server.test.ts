import {afterEach,describe,expect,it} from 'vitest';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {resolve} from 'node:path';
import {chart,cleanups,page,startHub,until} from './fixtures/agent-bridge';

afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();});
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The real stdio server process (Node type stripping), driven as an MCP client would. */
function mcp(env:Record<string,string>){
  const child:ChildProcessWithoutNullStreams=spawn(process.execPath,['mcp/server.ts'],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env,...env}});
  cleanups.push(()=>child.kill());
  let buffer='',next=0;const waiting=new Map<number,(message:any)=>void>(),notifications:any[]=[];
  child.stdout.on('data',chunk=>{buffer+=chunk;for(let at=buffer.indexOf('\n');at>=0;at=buffer.indexOf('\n')){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(line.trim()){const message=JSON.parse(line);if(message.id!==undefined)waiting.get(message.id)?.(message);else notifications.push(message);}}});
  const request=(method:string,params:unknown)=>new Promise<any>(done=>{const id=++next;waiting.set(id,done);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  return {
    child,notifications,
    async start(){const init=await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'vitest-client',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');return init.result;},
    tools:async()=>(await request('tools/list',{})).result.tools as {name:string;annotations?:{readOnlyHint?:boolean}}[],
    call:async(name:string,args:Record<string,unknown>={},meta?:Record<string,unknown>)=>(await request('tools/call',{name,arguments:args,...(meta?{_meta:meta}:{})})).result,
    request,
  };
}

describe('open-tradingview MCP server (stdio)',()=>{
  it('relays tools to the active chart, streams progress and stays present while it runs',async()=>{
    const {base,hub}=await startHub();
    const browser=await page(base,[chart('chart-live',{focused:true,lastActiveAt:10})],(call,progress)=>{
      if(call.method==='capture')return {mimeType:'image/png',data:PNG,width:1,height:1,pixelsPerCssPx:1};
      if(call.method==='draw')return {created:[{id:'d1',tool:'trend-line'}]};
      if(call.method==='view'){progress('loading market');progress('market ready');return {status:'success'};}
      return {chartId:call.chartId,market:{symbol:'BTCUSDT'}};
    });
    const client=mcp({TVCHART_BRIDGE_URL:base});
    const init=await client.start();
    expect(init.serverInfo).toMatchObject({name:'open-tradingview'});expect(init.instructions).toMatch(/get_structure/);
    // Presence: the hub (and every chart page) now knows this AI client is connected.
    await until(()=>hub.agents().some(agent=>agent.name==='vitest-client'&&agent.transport==='stdio'));
    await until(()=>browser.agents.at(-1)?.some(agent=>agent.name==='vitest-client'));
    const tools=await client.tools();
    expect(tools.map(tool=>tool.name)).toEqual(expect.arrayContaining(['list_charts','get_chart_state','get_structure','describe_chart','draw','set_overlay','capture_chart','set_view','wait_for_event']));
    expect(tools.find(tool=>tool.name==='get_structure')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.some(tool=>/pine|script/.test(tool.name))).toBe(false);
    expect(JSON.parse((await client.call('list_charts')).content[0].text)).toMatchObject({activeChartId:'chart-live',charts:[{chartId:'chart-live',active:true,hub:base}]});
    expect(JSON.parse((await client.call('get_chart_state',{include:['market']})).content[0].text)).toMatchObject({chart:{chartId:'chart-live',symbol:'BTCUSDT'},market:{symbol:'BTCUSDT'}});
    const drawn=await client.call('draw',{group:'AI',drawings:[{tool:'trend-line',points:[{barsAgo:10,price:'low'},{barsAgo:0,price:'low'}],style:{color:'#26a69a'}}]});
    expect(JSON.parse(drawn.content[0].text)).toEqual({created:[{id:'d1',tool:'trend-line'}]});
    expect(browser.calls.find(call=>call.method==='draw')).toMatchObject({agent:'vitest-client',params:{group:'AI',drawings:[{tool:'trend-line',points:[{barsAgo:10,price:'low'},{barsAgo:0,price:'low'}]}]}});
    // Streaming over stdio: page progress → hub NDJSON → MCP notifications/progress.
    await client.call('set_view',{market:{symbol:'BTCUSDT'}},{progressToken:'run-1'});
    expect(client.notifications.filter(n=>n.method==='notifications/progress').map(n=>[n.params.progressToken,n.params.message])).toEqual([['run-1','loading market'],['run-1','market ready']]);
    const image=await client.call('capture_chart',{maxWidth:640});
    expect(image.content[0]).toEqual({type:'image',data:PNG,mimeType:'image/png'});
    const resources=(await client.request('resources/list',{})).result.resources.map((resource:{uri:string})=>resource.uri);
    expect(resources).toEqual(expect.arrayContaining(['tvchart://guide','tvchart://charts','tvchart://chart/active']));
    expect((await client.request('prompts/list',{})).result.prompts.map((prompt:{name:string})=>prompt.name)).toEqual(expect.arrayContaining(['tvchart_guide','analyze_chart']));
    // Closing the client's pipe ends the process and its presence.
    client.child.stdin.end();
    await until(()=>!hub.agents().some(agent=>agent.name==='vitest-client'));
  },20_000);
  it('explains how to recover when no dev server is running',async()=>{
    const client=mcp({TVCHART_ROOT:'/tmp/tvchart-no-such-root',TVCHART_BRIDGE_URL:''});await client.start();
    const result=await client.call('get_chart_state');
    expect(result.isError).toBe(true);expect(result.content[0].text).toMatch(/^NO_HUB: .*pnpm dev/);
  },20_000);
});
