import {afterEach,describe,expect,it} from 'vitest';
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import WebSocket from 'ws';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ResourceUpdatedNotificationSchema} from '@modelcontextprotocol/sdk/types.js';
import {api,chart,cleanups,page,startHub,until,wait} from './fixtures/agent-bridge';

afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();});

describe('agent bridge hub',()=>{
  it('writes a discovery record per server and removes only its own record on close',async()=>{
    const {base,root,hub}=await startHub();
    expect(await (await api(base,'/health')).json()).toMatchObject({ok:true,protocol:1,charts:0,agents:0});
    const directory=join(root,'.data/agent-bridge/hubs'),[file]=readdirSync(directory),record=JSON.parse(readFileSync(join(directory,file),'utf8'));
    expect(record).toMatchObject({version:1,url:expect.stringMatching(/^http:\/\/localhost:\d+$/),pid:process.pid,instance:expect.any(String)});
    expect(record).not.toHaveProperty('token');
    expect(statSync(join(directory,file)).mode&0o777).toBe(0o600);
    hub.close();expect(existsSync(join(directory,file))).toBe(false);
  });
  it('routes calls to the active chart, or to an explicit chart id',async()=>{
    const {base}=await startHub();
    expect(await (await api(base,'/call',{body:{method:'state'}})).json()).toMatchObject({ok:false,error:{code:'NO_CHART'}});
    const a=await page(base,[chart('chart-a',{lastActiveAt:5})]),b=await page(base,[chart('chart-b',{lastActiveAt:9,focused:true})]);
    const listing=await (await api(base,'/charts')).json();
    expect(listing.activeChartId).toBe('chart-b');expect(listing.charts).toHaveLength(2);
    expect(await (await api(base,'/call',{body:{method:'state',params:{include:['market']}}})).json()).toEqual({ok:true,chartId:'chart-b',result:{echo:'state',params:{include:['market']},chartId:'chart-b'}});
    expect(await (await api(base,'/call',{body:{chartId:'chart-a',method:'bars'}})).json()).toMatchObject({ok:true,chartId:'chart-a'});
    expect(a.calls[0]).toMatchObject({method:'bars',agent:'vitest'});expect(b.calls).toHaveLength(1);
    expect(await (await api(base,'/call',{body:{chartId:'nope',method:'state'}})).json()).toMatchObject({ok:false,error:{code:'CHART_NOT_FOUND'}});
    expect(await (await api(base,'/call',{body:{method:'bad method!'}})).json()).toMatchObject({ok:false,error:{code:'BAD_REQUEST'}});
  });
  it('streams page progress as NDJSON lines before the result',async()=>{
    const {base}=await startHub();
    await page(base,[chart('live')],async(call,progress)=>{progress('loading market');await wait(20);progress('market ready');return {done:call.method};});
    const text=await (await api(base,'/call',{body:{method:'view'},headers:{accept:'application/x-ndjson'}})).text();
    expect(text.trim().split('\n').map(line=>JSON.parse(line))).toEqual([
      {type:'progress',progress:{message:'loading market'}},{type:'progress',progress:{message:'market ready'}},{type:'result',ok:true,chartId:'live',result:{done:'view'}}]);
  });
  it('times out silent pages and fails calls whose page disconnects',async()=>{
    const {base}=await startHub();
    await page(base,[chart('mute')],()=>undefined);
    expect(await (await api(base,'/call',{body:{method:'state',timeoutMs:1000}})).json()).toMatchObject({ok:false,error:{code:'TIMEOUT'}});
    const leaving=await page(base,[chart('leaving',{lastActiveAt:99,focused:true})],()=>{leaving.socket.terminate();return undefined;});
    expect(await (await api(base,'/call',{body:{chartId:'leaving',method:'state'}})).json()).toMatchObject({ok:false,error:{code:'CHART_DISCONNECTED'}});
  });
  it('accepts chart pages only from the same local origin and never lets one page claim another page\'s chart',async()=>{
    const {base}=await startHub();
    await expect(page(base,[chart('evil')],undefined,'http://evil.example')).rejects.toThrow(/403/);
    await page(base,[chart('owned')],()=>({from:'owner'}));
    await page(base,[chart('owned')],()=>({from:'intruder'}));
    expect(await (await api(base,'/call',{body:{chartId:'owned',method:'state'}})).json()).toMatchObject({result:{from:'owner'}});
  });
  it('knows which AI clients are really connected and tells the pages',async()=>{
    const {base,hub}=await startHub(),viewer=await page(base,[chart('watch')]);
    expect(viewer.agents.at(-1)).toEqual([]);
    const agent=new WebSocket(`${base.replace('http','ws')}/api/agent-bridge/agent`,{headers:{'x-tvchart-agent':'claude-code','x-tvchart-agent-id':'stdio-test'}});
    cleanups.push(()=>agent.terminate());
    const pushed:unknown[]=[];agent.on('message',data=>pushed.push(JSON.parse(String(data))));
    await until(()=>viewer.agents.at(-1)?.length);
    expect(viewer.agents.at(-1)).toEqual([expect.objectContaining({id:'stdio-test',name:'claude-code',transport:'stdio'})]);
    expect(hub.agents()).toHaveLength(1);
    // The presence socket also streams chart events to the AI side.
    viewer.event('watch','selection',{ids:['x']});
    await until(()=>pushed.length);
    expect(pushed[0]).toMatchObject({type:'event',event:{type:'selection',chartId:'watch',data:{ids:['x']}}});
    agent.close();
    await until(()=>viewer.agents.at(-1)?.length===0);
    expect(hub.agents()).toEqual([]);
  });
  it('streams chart events with a cursor and long-polls for the next one',async()=>{
    const {base}=await startHub(),viewer=await page(base,[chart('events')]);
    const waiting=api(base,'/events?since=0&waitMs=5000&types=selection');
    await wait(50);viewer.event('events','scene');viewer.event('events','selection',{ids:['x']});
    const result=await (await waiting).json();
    expect(result.events).toEqual([expect.objectContaining({type:'selection',data:{ids:['x']},seq:2,chartId:'events'})]);expect(result.next).toBe(2);
    expect((await (await api(base,'/events?since=2')).json()).events).toEqual([]);
  });
  it('serves the agent guide as /llms.txt, /llm.txt and /llms-full.txt with live status',async()=>{
    const {base}=await startHub();await page(base,[chart('doc-chart',{symbol:'ETHUSDT',interval:'4h'})]);
    const llms=await (await fetch(`${base}/llms.txt`)).text(),alias=await (await fetch(`${base}/llm.txt`)).text(),full=await (await fetch(`${base}/llms-full.txt`)).text();
    expect(llms).toMatch(/^# open-tradingview/);expect(alias.split('\n').slice(0,4)).toEqual(llms.split('\n').slice(0,4));
    expect(llms).toContain('ETHUSDT · 4h · mock (active)');
    expect(llms).toContain(`claude mcp add --transport http open-tradingview ${base}/mcp`);
    expect(llms).toMatch(/`get_structure` \(read\)/);expect(llms).toContain('`describe_chart` (read)');
    expect(llms).toContain('## How to use the chart well');expect(llms).toContain(`[drawing-tools.md](${base}/api/agent-bridge/docs/drawing-tools.md)`);
    expect(full).toContain('### draw — Draw with any drawing tool');expect(full).toMatch(/- drawings: array/);expect(full).toContain('## Reference: drawing-tools.md');
    expect(await (await fetch(`${base}/api/agent-bridge/docs/drawing-tools.md`)).text()).toContain('| `trend-line` | A, B |');
    expect((await fetch(`${base}/api/agent-bridge/docs/secrets.md`)).status).toBe(404);
  });
  it('serves the same tools over Streamable HTTP at /mcp with progress, subscriptions and the guide',async()=>{
    const {base,hub}=await startHub();
    const viewer=await page(base,[chart('mcp-chart',{focused:true})],async(call,progress)=>{
      if(call.method==='view'){progress('loading market');progress('market ready');return {status:'success'};}
      return {chartId:call.chartId,market:{symbol:'BTCUSDT'}};
    });
    const client=new Client({name:'vitest-http',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);cleanups.push(()=>{void client.close();});
    await until(()=>viewer.agents.at(-1)?.some(agent=>agent.name==='vitest-http'&&agent.transport==='http'));
    const tools=(await client.listTools()).tools.map(tool=>tool.name);
    expect(tools).toEqual(expect.arrayContaining(['get_chart_state','get_structure','describe_chart','draw','capture_chart','wait_for_event']));
    const state=await client.callTool({name:'get_chart_state',arguments:{include:['market']}});
    expect(JSON.parse((state.content as {text:string}[])[0].text)).toMatchObject({chart:{chartId:'mcp-chart'},market:{symbol:'BTCUSDT'}});
    expect(viewer.calls.at(-1)).toMatchObject({method:'state',agent:'vitest-http'});
    const progress:string[]=[];
    await client.callTool({name:'set_view',arguments:{market:{symbol:'BTCUSDT'}}},undefined,{onprogress:value=>{progress.push(String(value.message));}});
    expect(progress).toEqual(['loading market','market ready']);
    expect((await client.listResources()).resources.map(resource=>resource.uri)).toEqual(expect.arrayContaining(['tvchart://guide','tvchart://charts','tvchart://chart/active']));
    expect(((await client.readResource({uri:'tvchart://guide'})).contents[0] as {text:string}).text).toContain('# open-tradingview agent guide');
    expect((await client.getPrompt({name:'tvchart_guide'})).messages[0].content).toMatchObject({type:'text'});
    const updates:string[]=[];client.setNotificationHandler(ResourceUpdatedNotificationSchema,notification=>{updates.push(notification.params.uri);});
    await client.subscribeResource({uri:'tvchart://chart/active'});
    viewer.event('mcp-chart','scene',{added:['d1']});
    await until(()=>updates.length);expect(updates).toEqual(['tvchart://chart/active']);
    await transport.terminateSession();
    await until(()=>!hub.agents().some(agent=>agent.name==='vitest-http'));
  });
  it('drops an HTTP client from presence when its stream closes without a DELETE',async()=>{
    const {base,hub}=await startHub(),viewer=await page(base,[chart('quiet')]);
    const client=new Client({name:'vanishing',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    await until(()=>hub.agents().some(agent=>agent.name==='vanishing'));
    await client.close();   // SDK close aborts the SSE stream but sends no DELETE
    await until(()=>viewer.agents.at(-1)?.length===0,9000);
    expect(hub.agents()).toEqual([]);
  },15_000);
});
