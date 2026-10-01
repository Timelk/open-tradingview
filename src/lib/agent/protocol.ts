/** Wire contract between the chart page, the local hub (inside the Vite
 * server) and the MCP server. Types, constants and pure helpers only:
 * mcp/*.ts imports this file directly under Node's type stripping, so it
 * must stay dependency-free and use erasable TypeScript syntax. */
export const AGENT_BRIDGE_PROTOCOL=1;
export const AGENT_BRIDGE_PREFIX='/api/agent-bridge';
export const AGENT_BRIDGE_SOCKET=`${AGENT_BRIDGE_PREFIX}/browser`;
/** Presence socket of a running MCP server process (stdio transport). */
export const AGENT_BRIDGE_AGENT_SOCKET=`${AGENT_BRIDGE_PREFIX}/agent`;
/** Streamable HTTP MCP endpoint served by the dev server itself. */
export const AGENT_BRIDGE_MCP_PATH='/mcp';
/** One discovery record per listening dev/preview server, relative to the project root. */
export const AGENT_BRIDGE_DISCOVERY_DIR='.data/agent-bridge/hubs';
/** Agent onboarding documents served by the dev server (llms.txt convention, plus the /llm.txt alias). */
export const AGENT_DOC_PATHS=['/llms.txt','/llm.txt','/llms-full.txt'] as const;

export interface ChartSessionInfo {
  chartId:string;title:string;url:string;
  source:string;symbol:string;interval:string;loading:boolean;
  /** Page focus, page visibility and the last user interaction with this chart. */
  focused:boolean;visible:boolean;lastActiveAt:number;
  /** Status-bar switch. Read methods keep working when writes are off. */
  writable:boolean;
}
/** An AI client that is actually connected: a live MCP stdio process or an HTTP MCP session. */
export interface AgentPresence {id:string;name:string;transport:'stdio'|'http';since:number;lastSeen:number}
/** Streaming progress of a long call (market load…), relayed to MCP notifications/progress. */
export interface CallProgress {message:string;progress?:number;total?:number}
export type ChartEventType='selection'|'market'|'scene';
export interface ChartEvent {type:ChartEventType;at:number;data:Record<string,unknown>}
export interface HubEvent extends ChartEvent {seq:number;chartId:string}

export type BridgeErrorCode='NO_HUB'|'NO_CHART'|'CHART_NOT_FOUND'|'CHART_DISCONNECTED'|'TIMEOUT'|'BAD_REQUEST'|'UNKNOWN_METHOD'|'NOT_READY'|'WRITE_DISABLED'|'LOCKED'|'FAILED'|'BUSY';
export interface BridgeError {code:BridgeErrorCode;message:string}

export type BrowserMessage=
  |{type:'hello';protocol:number;charts:ChartSessionInfo[]}
  |{type:'chart';chart:ChartSessionInfo}
  |{type:'chart-closed';chartId:string}
  |{type:'result';id:string;ok:true;result:unknown}
  |{type:'result';id:string;ok:false;error:BridgeError}
  |{type:'progress';id:string;progress:CallProgress}
  |{type:'event';chartId:string;event:ChartEvent};
export type HubMessage=
  |{type:'welcome';protocol:number}
  |{type:'agents';agents:AgentPresence[]}
  |{type:'call';id:string;chartId:string;method:string;params:unknown;agent:string}
  |{type:'cancel';id:string};
/** Pushed to MCP processes on their presence socket, so chart events stream to the AI side. */
export type AgentSocketMessage={type:'event';event:HubEvent};
/** Streaming /call answer (Accept: application/x-ndjson): progress lines, then one result line. */
export type HubCallStreamLine={type:'progress';progress:CallProgress}|({type:'result'}&HubCallResponse);

export interface HubCallRequest {chartId?:string;method:string;params?:unknown;timeoutMs?:number}
export type HubCallResponse={ok:true;chartId:string;result:unknown}|{ok:false;error:BridgeError};
export interface HubChart extends ChartSessionInfo {active:boolean}
export interface HubChartsResponse {charts:HubChart[];activeChartId:string|null;agents?:AgentPresence[]}
export interface HubEventsResponse {events:HubEvent[];next:number}
export interface HubDiscovery {version:1;url:string;pid:number;startedAt:number;root:string;instance:string}

/** Browser methods. Everything outside READ_METHODS changes the chart or the
 * user's view and is refused while the user has switched agent writes off. */
export const READ_METHODS=['state','bars','series','analysis','structure','layout','catalog','capture','locate'] as const;
export const WRITE_METHODS=['draw','update','delete','overlay.set','overlay.remove','indicator.add','indicator.update','view','select','history'] as const;
export type BridgeMethod=typeof READ_METHODS[number]|typeof WRITE_METHODS[number];
export const isWriteMethod=(method:string):boolean=>(WRITE_METHODS as readonly string[]).includes(method);
/** Long operations get a larger default budget; the hub caps every call at 180 s. */
export function defaultCallTimeout(method:string):number {
  return method==='view'?45_000:method==='capture'?30_000:20_000;
}

/** "The chart the user is looking at": a visible page first, the focused
 * window next, then the most recent pointer/keyboard/focus interaction. */
export function pickActiveChart<T extends ChartSessionInfo>(charts:readonly T[]):T|undefined {
  const rank=(chart:T)=>(chart.visible?2:0)+(chart.focused?1:0);
  return [...charts].sort((a,b)=>rank(b)-rank(a)||b.lastActiveAt-a.lastActiveAt)[0];
}
