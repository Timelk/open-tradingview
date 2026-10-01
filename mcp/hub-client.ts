import {readdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {AGENT_BRIDGE_DISCOVERY_DIR,AGENT_BRIDGE_PREFIX,pickActiveChart,type BridgeError,type CallProgress,type HubCallResponse,type HubCallStreamLine,type HubChartsResponse,type HubDiscovery,type HubEvent,type HubEventsResponse} from '../src/lib/agent/protocol.ts';
import type {ChartListing,EventsResult,ListedChart,RoutedResponse,ToolBackend} from './tools.ts';

export interface HubEndpoint {url:string;origin:'env'|'discovery'}
export interface HubClientOptions {root:string;agent:()=>string;agentId:string;env?:Record<string,string|undefined>;request?:typeof fetch}

const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}};

/** Finds every running TVCHART dev/preview server of this project, merges
 * their connected charts, and routes each call to the hub that owns the
 * target chart (the user's active chart unless a chartId is given). */
export class HubClient implements ToolBackend {
  private options:HubClientOptions;
  private listeners=new Set<(event:HubEvent)=>void>();
  constructor(options:HubClientOptions){this.options=options;}
  /** Chart events arrive on the presence sockets (see presence.ts) and fan out here. */
  subscribe(listener:(event:HubEvent)=>void):()=>void{this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};}
  emit(event:HubEvent):void{for(const listener of [...this.listeners])try{listener(event);}catch{/* Listener errors stay local. */}}
  private get env(){return this.options.env??process.env;}
  endpoints():HubEndpoint[] {
    const url=this.env.TVCHART_BRIDGE_URL;
    if(url)return [{url:url.replace(/\/+$/,''),origin:'env'}];
    const directory=join(this.options.root,AGENT_BRIDGE_DISCOVERY_DIR),found:HubEndpoint[]=[];
    let files:string[]=[];try{files=readdirSync(directory).filter(file=>file.endsWith('.json'));}catch{return [];}
    for(const file of files){
      try{
        const record=JSON.parse(readFileSync(join(directory,file),'utf8')) as HubDiscovery;
        if(record.version!==1||typeof record.url!=='string')continue;
        if(!alive(record.pid)){rmSync(join(directory,file),{force:true});continue;}
        found.push({url:record.url,origin:'discovery'});
      }catch{/* A file being replaced right now is picked up on the next call. */}
    }
    return found;
  }
  unavailable():string|null {
    return this.endpoints().length?null:`The open-tradingview dev server is not running (no hub record in ${join(this.options.root,AGENT_BRIDGE_DISCOVERY_DIR)}). Start it with \`pnpm dev\` in ${this.options.root}, then open the app in a browser tab.`;
  }
  private async request<T>(endpoint:HubEndpoint,path:string,init:{method?:string;body?:unknown;timeoutMs?:number}={}):Promise<T> {
    const response=await (this.options.request??fetch)(`${endpoint.url}${AGENT_BRIDGE_PREFIX}${path}`,{method:init.method??'GET',
      headers:{'X-TVChart-Agent':this.options.agent(),'X-TVChart-Agent-Id':this.options.agentId,...(init.body!==undefined?{'Content-Type':'application/json'}:{})},
      ...(init.body!==undefined?{body:JSON.stringify(init.body)}:{}),signal:AbortSignal.timeout(init.timeoutMs??10_000)});
    const text=await response.text();
    if(!response.ok)throw Error(`${response.status} ${(()=>{try{return JSON.parse(text).message;}catch{return text.slice(0,200);}})()}`);
    return JSON.parse(text) as T;
  }
  async charts():Promise<ChartListing> {
    const endpoints=this.endpoints(),hubs:ChartListing['hubs']=[],charts:ListedChart[]=[];
    await Promise.all(endpoints.map(async endpoint=>{
      try{const listing=await this.request<HubChartsResponse>(endpoint,'/charts');hubs.push({url:endpoint.url,ok:true});charts.push(...listing.charts.map(chart=>({...chart,hub:endpoint.url})));}
      catch(error){hubs.push({url:endpoint.url,ok:false,error:error instanceof Error?error.message:String(error)});}
    }));
    const active=pickActiveChart(charts);
    return {charts:charts.map(chart=>({...chart,active:chart.chartId===active?.chartId})),activeChartId:active?.chartId??null,hubs};
  }
  private async route(chartId?:string):Promise<{endpoint:HubEndpoint;chart:ListedChart}|BridgeError> {
    const missing=this.unavailable();if(missing)return {code:'NO_HUB',message:missing};
    const endpoints=this.endpoints(),listing=await this.charts();
    const chart=chartId?listing.charts.find(item=>item.chartId===chartId):listing.charts.find(item=>item.active);
    if(!chart){
      if(listing.hubs.every(hub=>!hub.ok))return {code:'NO_HUB',message:`No open-tradingview dev server answered: ${listing.hubs.map(hub=>`${hub.url} (${hub.error})`).join('; ')}`};
      return chartId?{code:'CHART_NOT_FOUND',message:`chart "${chartId}" is not connected; call list_charts`}
        :{code:'NO_CHART',message:`No chart page is connected. Open ${listing.hubs.find(hub=>hub.ok)?.url??'the app'} in a browser tab.`};
    }
    return {endpoint:endpoints.find(endpoint=>endpoint.url===chart.hub)!,chart};
  }
  async call(method:string,params:Record<string,unknown>,chartId?:string,timeoutMs?:number,progress?:(value:CallProgress)=>void):Promise<RoutedResponse> {
    const routed=await this.route(chartId);if('code' in routed)return {ok:false,error:routed};
    const body={chartId:routed.chart.chartId,method,params,timeoutMs},budget=(timeoutMs??180_000)+5000;
    try{
      if(!progress)return {...await this.request<HubCallResponse>(routed.endpoint,'/call',{method:'POST',body,timeoutMs:budget}),chart:routed.chart};
      // Streaming call: NDJSON progress lines are relayed as they arrive, the last line is the result.
      const response=await (this.options.request??fetch)(`${routed.endpoint.url}${AGENT_BRIDGE_PREFIX}/call`,{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(budget),
        headers:{'Content-Type':'application/json',Accept:'application/x-ndjson','X-TVChart-Agent':this.options.agent(),'X-TVChart-Agent-Id':this.options.agentId}});
      if(!response.ok||!response.body)throw Error(`${response.status} ${await response.text().catch(()=>'')}`.trim());
      const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();let buffer='',result:HubCallResponse|undefined;
      for(;;){
        const chunk=await reader.read();if(chunk.done)break;buffer+=chunk.value;
        for(let at=buffer.indexOf('\n');at>=0;at=buffer.indexOf('\n')){
          const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);if(!line)continue;
          const message=JSON.parse(line) as HubCallStreamLine;
          if(message.type==='progress')progress(message.progress);else{const {type:_type,...rest}=message;result=rest as HubCallResponse;}
        }
      }
      if(!result)throw Error('the hub closed the stream without a result');
      return {...result,chart:routed.chart};
    }catch(error){return {ok:false,error:{code:'NO_HUB',message:`hub request failed: ${error instanceof Error?error.message:String(error)}`}};}
  }
  async events(options:{chartId?:string;since?:number;waitMs?:number;types?:string[]}):Promise<EventsResult> {
    const routed=await this.route(options.chartId);if('code' in routed)return {error:routed};
    const query=new URLSearchParams({since:String(options.since??0),waitMs:String(options.waitMs??0),chartId:routed.chart.chartId,...(options.types?.length?{types:options.types.join(',')}:{})});
    try{return {...await this.request<HubEventsResponse>(routed.endpoint,`/events?${query}`,{timeoutMs:(options.waitMs??0)+10_000}),hub:routed.endpoint.url,chartId:routed.chart.chartId};}
    catch(error){return {error:{code:'NO_HUB',message:`hub request failed: ${error instanceof Error?error.message:String(error)}`}};}
  }
}
