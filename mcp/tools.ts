/** open-tradingview MCP tools, shared by the stdio server (mcp/server.ts), the
 * Streamable HTTP endpoint inside the dev server (server/agent-bridge.ts) and
 * the generated /llms.txt. Erasable TypeScript only (Node type stripping). */
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {SubscribeRequestSchema,UnsubscribeRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import type {BridgeError,CallProgress,HubCallResponse,HubChart,HubEvent,HubEventsResponse} from '../src/lib/agent/protocol.ts';

export const SERVER_INFO={name:'open-tradingview',title:'open-tradingview chart bridge',version:'1.1.0'};
export const INSTRUCTIONS=`Drives open-tradingview, the user's own charting app open in their browser (K-line/candles, indicators, drawings, pattern analysis).
- Start with get_chart_state: it targets the chart the user is looking at (or pass chartId from list_charts). Heavy data is paged: get_bars, get_indicator_data, get_analysis.
- Times are ISO-8601 with the browser's UTC offset (what the user sees on the axis); inputs accept ISO or epoch ms. Anchors: {time,value} | {barsAgo,price:"high"} | {bar,value}.
- Editable, saved annotations: draw (any drawing tool; get_catalog lists tools, point counts and text props). Computed series/labels: set_overlay (session only). Studies: add_indicator. Use the chart's registered studies and overlays for custom analysis.
- Each write is one undo step; agent drawings carry author=agent and can be removed with delete_objects {author:"agent"}. Never delete or edit user objects unless asked. Respect LOCKED/BUSY/WRITE_DISABLED errors: tell the user instead of forcing.
- Precision: use get_structure for pivots/ATR/levels/trend instead of reading raw bars; write results already report placement problems.
- Verify with describe_chart (text layout + character chart, works without vision) or capture_chart (image, vision models only).
- Full guide: resource tvchart://guide, prompt tvchart_guide, or GET /llms.txt on the app's dev server.`;

export interface ListedChart extends HubChart {hub:string}
export interface ChartListing {charts:ListedChart[];activeChartId:string|null;hubs:{url:string;ok:boolean;error?:string}[]}
export type RoutedResponse=(HubCallResponse&{chart?:ListedChart})|{ok:false;error:BridgeError};
export type EventsResult=(HubEventsResponse&{hub:string;chartId:string})|{error:BridgeError};
/** Where tool calls go: HTTP to discovered hubs (stdio server) or in-process (dev server endpoint). */
export interface ToolBackend {
  unavailable():string|null;
  charts():Promise<ChartListing>;
  call(method:string,params:Record<string,unknown>,chartId?:string,timeoutMs?:number,progress?:(value:CallProgress)=>void):Promise<RoutedResponse>;
  events(options:{chartId?:string;since?:number;waitMs?:number;types?:string[]}):Promise<EventsResult>;
  /** Live chart events (streamed from the hub) for resource subscriptions. */
  subscribe?(listener:(event:HubEvent)=>void):()=>void;
}
/** Per-call context: MCP progress notifications (streamed to the client) and cancellation. */
export interface ToolContext {progress:(value:CallProgress)=>void;signal?:AbortSignal}
export type ToolResult={content:({type:'text';text:string}|{type:'image';data:string;mimeType:string})[];isError?:boolean};
export interface ToolSpec {
  name:string;title:string;description:string;readOnly:boolean;destructive?:boolean;
  input:Record<string,z.ZodType>;
  run(args:Record<string,unknown>,backend:ToolBackend,context:ToolContext):Promise<ToolResult>;
}

const text=(value:unknown):ToolResult=>({content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}]});
const failure=(code:string,message:string):ToolResult=>({content:[{type:'text',text:`${code}: ${message}`}],isError:true});
const compact=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined));
/** Tool args → chart method params; chartId routes, everything else is relayed verbatim. */
function relay(method:string,shape?:(result:unknown,response:RoutedResponse)=>ToolResult,timeoutMs?:number){
  return async(args:Record<string,unknown>,backend:ToolBackend,context:ToolContext):Promise<ToolResult>=>{
    const {chartId,...params}=args;
    const response=await backend.call(method,compact(params),typeof chartId==='string'?chartId:undefined,timeoutMs,context.progress);
    if(!response.ok)return failure(response.error.code,response.error.message);
    return shape?shape(response.result,response):text(response.result);
  };
}

const chartId=z.string().optional().describe('Chart id from list_charts. Omit to target the chart the user is currently looking at.');
const time=z.union([z.number(),z.string()]).describe('Epoch ms or ISO-8601; without an offset it is browser-local time');
const priceField=z.enum(['open','high','low','close','hl2','hlc3','ohlc4']);
const anchor=z.looseObject({time:time.optional(),bar:z.number().optional().describe('Loaded-bar index; negative counts from the end (-1 = newest)'),
  barsAgo:z.number().optional().describe('0 = newest bar'),offset:z.number().optional().describe('Extra bars after the resolved bar (projections into the future)'),
  value:z.number().optional().describe('Price on the main pane, indicator value on sub panes'),price:priceField.optional().describe('Snap to this bar field instead of value')})
  .describe('Exactly one of time/bar/barsAgo, plus value or price');
const range=z.union([z.enum(['visible','all','selection']),z.object({last:z.number().int().positive().optional(),from:time.optional(),to:time.optional(),fromBar:z.number().int().optional(),toBar:z.number().int().optional()})])
  .optional().describe('Bars to cover. Default "visible". "selection" = time span of the selected drawings.');
const timeFormat=z.enum(['iso','ms']).optional().describe('Output time format (default iso)');
const style=z.object({color:z.string().optional().describe('#rrggbb'),width:z.number().min(1).max(8).optional(),dash:z.enum(['solid','dashed','dotted']).optional(),
  fillOpacity:z.number().min(0).max(1).optional(),fontSize:z.number().min(12).max(32).optional()});
const scalars=z.record(z.string(),z.union([z.string(),z.number(),z.boolean()]));
const plotStyles=z.record(z.string(),z.object({color:z.string().optional(),width:z.number().optional()}));

export const TOOL_SPECS:ToolSpec[]=[
  {name:'list_charts',title:'List connected charts',readOnly:true,input:{},
    description:'Charts open in browser tabs connected to the local open-tradingview dev server(s), with the active one (the chart the user is looking at: visible page, focused window, most recent interaction).',
    async run(_args,backend){const missing=backend.unavailable();return missing?failure('NO_HUB',missing):text(await backend.charts());}},
  {name:'get_chart_state',title:'Get chart global state',readOnly:true,
    description:'Global state of one chart: market & latest bar, crosshair bar, viewport & panes (price ranges), selection, drawing tool state, every drawing (points/style/props/author), indicator instances with params and current output values, overlays, detected analysis counts, theme, recent bars. The layer tree is only included on request (include:["layers"]). Use include to trim.',
    input:{chartId,include:z.array(z.enum(['market','cursor','viewport','selection','tools','layers','drawings','indicators','overlays','analysis','appearance','recentBars'])).optional(),
      recentBars:z.number().int().min(0).max(500).optional().describe('Newest bars to inline (default 5)'),maxDrawings:z.number().int().min(1).max(2000).optional(),
      points:z.enum(['summary','full']).optional().describe('Freehand paths are sampled unless "full"'),timeFormat},
    run:relay('state',(result,response)=>text({chart:response.ok&&'chart' in response?response.chart:undefined,...(result as object)}))},
  {name:'get_bars',title:'Get OHLCV bars',readOnly:true,
    description:'Loaded OHLCV bars (plus quoteVolume/tradeCount/takerBuy* when the feed has them) as compact rows. Longer ranges are aggregated into buckets to stay under maxPoints (aggregation says how).',
    input:{chartId,range,maxPoints:z.number().int().min(1).max(5000).optional().describe('Default 300'),
      fields:z.array(z.enum(['time','open','high','low','close','volume','quoteVolume','tradeCount','takerBuyBase','takerBuyQuote'])).optional(),timeFormat},
    run:relay('bars')},
  {name:'get_indicator_data',title:'Get indicator/overlay values',readOnly:true,
    description:'Values of indicator outputs and overlays aligned to bar times (shared time array, bucketed like get_bars), native indicator signal markers, and overlay labels/shapes. ids = indicator instance ids or overlay ids from get_chart_state; default all visible.',
    input:{chartId,ids:z.array(z.string()).optional(),range,maxPoints:z.number().int().min(1).max(5000).optional(),includeHidden:z.boolean().optional(),timeFormat},
    run:relay('series')},
  {name:'get_analysis',title:'Get detected patterns and analysis',readOnly:true,
    description:'Structures found by the chart\'s pattern/analysis layers: confirmed patterns (points, guides, zone, targets, invalidation, events), analysis observations (Wyckoff/SMC/waves/…: lines, zones, evidence, what it is waiting for) and live pattern candidates. Needs a pattern/analysis indicator on the chart.',
    input:{chartId,kind:z.enum(['all','patterns','observations','candidates']).optional(),instanceId:z.string().optional(),limit:z.number().int().min(1).max(300).optional(),visibleOnly:z.boolean().optional(),timeFormat},
    run:relay('analysis')},
  {name:'get_structure',title:'Compute market structure',readOnly:true,
    description:'Exact, deterministic structure from the loaded bars: range high/low, ATR(14), least-squares trend channel (slope, r², ±σ), confirmed swing pivots labelled HH/HL/LH/LL with leg size in ATR, and support/resistance levels clustered from pivots (touches, first/last touch, distance from price). Use it instead of reading raw bars to place lines precisely.',
    input:{chartId,range,strength:z.number().int().min(1).max(30).optional().describe('Bars on each side that confirm a pivot (default 3)'),
      maxPivots:z.number().int().min(1).max(300).optional().describe('Newest pivots to list (default 20)'),maxLevels:z.number().int().min(1).max(40).optional().describe('Default 8'),
      tolerance:z.number().min(.02).max(3).optional().describe('Level clustering band in ATR (default 0.25)'),timeFormat},
    run:relay('structure')},
  {name:'describe_chart',title:'Describe the chart as text',readOnly:true,
    description:'What is on screen, as text (no vision needed): visible range, panes and price ranges, every visible drawing/overlay with its screen box and label boxes computed from the exact rendered geometry, placement issues (off-screen, clipped or overlapping labels, labels covering candles) and a character rendering of the main pane. Filter with ids; set ascii:false to skip the character chart.',
    input:{chartId,ids:z.array(z.string()).optional(),ascii:z.boolean().optional(),columns:z.number().int().min(40).max(200).optional(),rows:z.number().int().min(8).max(60).optional(),timeFormat},
    run:relay('layout')},
  {name:'get_catalog',title:'Get tools and indicators catalog',readOnly:true,
    description:'Drawing tools (id, points required, fields/textProp, fill/label support), indicator definitions (pass ids for full input schemas), panes, timeframes, style limits, overlay kinds and market sources.',
    input:{chartId,kind:z.enum(['all','tools','indicators']).optional(),ids:z.array(z.string()).optional().describe('Indicator ids to describe in full')},
    run:relay('catalog')},
  {name:'capture_chart',title:'Screenshot the chart',readOnly:true,
    description:'PNG/JPEG of the chart canvases exactly as rendered (candles, indicators, drawings, overlays, axes, crosshair). Only useful to models that can see images; everyone else uses describe_chart. DOM legends are not included.',
    input:{chartId,maxWidth:z.number().int().min(200).max(4096).optional().describe('Default 1280'),format:z.enum(['png','jpeg']).optional(),quality:z.number().min(.3).max(1).optional(),paneId:z.string().optional().describe('Crop to one pane')},
    run:relay('capture',result=>{
      const {data,mimeType,...meta}=result as {data:string;mimeType:string};
      return {content:[{type:'image',data,mimeType},{type:'text',text:JSON.stringify(meta)}]};
    })},
  {name:'locate',title:'Convert pixels and chart coordinates',readOnly:true,
    description:'Map chart CSS pixels (as in capture_chart divided by pixelsPerCssPx) to pane/time/value, or anchors to pixels with an onScreen flag.',
    input:{chartId,pixels:z.array(z.object({x:z.number(),y:z.number()})).optional(),points:z.array(anchor.extend({paneId:z.string().optional()})).optional(),timeFormat},
    run:relay('locate')},
  {name:'draw',title:'Draw with any drawing tool',readOnly:false,
    description:'Create editable, saved drawings with any registered tool (trend-line, ray, extended-line, horizontal-line, vertical-line, parallel-channel, fib-retracement, abcd-pattern, analysis-path, triangle-pattern, long-position, short-position, date-price-range, brush, rectangle, ellipse, arrow, text, buy-marker, sell-marker, price-zone, plus plugins). Points must match the tool (get_catalog). All drawings of one call are one undo step; group puts them in a named object-tree group (reused by name). The result reports each object\'s onScreen state and layout issues.',
    input:{chartId,drawings:z.array(z.object({tool:z.string(),points:z.array(anchor),paneId:z.string().optional().describe('Default "main"'),style:style.optional(),
        props:scalars.optional().describe('Tool fields, e.g. fib levels "0,0.5,1", price-zone label/intent'),text:z.string().optional().describe('Sets the tool text field (text, price-zone label, analysis-path labels)'),
        name:z.string().optional().describe('Object tree name'),locked:z.boolean().optional(),hidden:z.boolean().optional(),intervals:z.array(z.string()).optional().describe('Only show on these chart intervals')})).min(1).max(200),
      group:z.string().optional().describe('Object tree group name, e.g. "AI · 支撑阻力"'),select:z.boolean().optional(),timeFormat},
    run:relay('draw')},
  {name:'update_objects',title:'Update drawings and layers',readOnly:false,
    description:'Edit drawings (points, style, props, text) and any layer (name, visible, locked, opacity, intervals, parentId group, order front/back/forward/backward) in one undo step. Locked objects only accept {locked:false}.',
    input:{chartId,updates:z.array(z.object({id:z.string(),points:z.array(anchor).optional(),style:style.optional(),props:scalars.optional(),text:z.string().optional(),name:z.string().optional(),
      visible:z.boolean().optional(),locked:z.boolean().optional(),opacity:z.number().min(0).max(1).optional(),intervals:z.array(z.string()).nullable().optional(),
      parentId:z.string().nullable().optional(),order:z.enum(['front','back','forward','backward']).optional()})).min(1).max(200),timeFormat},
    run:relay('update')},
  {name:'delete_objects',title:'Delete drawings, groups or indicators',readOnly:false,destructive:true,
    description:'Delete layers by id, every agent-authored drawing (author:"agent"), or a whole group. Locked objects are skipped. One undo step; undo_redo restores.',
    input:{chartId,ids:z.array(z.string()).optional(),author:z.literal('agent').optional(),groupId:z.string().optional()},
    run:relay('delete')},
  {name:'set_overlay',title:'Set a computed overlay',readOnly:false,
    description:'Create/replace (by id) a session-only overlay: line/hist/band series from time-value points (sparse points are joined per fill), buy/sell markers, chart shapes (circle, arrowup, labeldown, flag…) at bars, or objects (label/box/line with free text and colors). Re-aligned automatically when bars reload. Use draw for annotations the user should keep.',
    input:{chartId,id:z.string().regex(/^[\w.-]{1,64}$/),name:z.string().optional(),kind:z.enum(['line','hist','band','markers','shapes','objects']),
      paneId:z.string().optional().describe('"main" (default), an existing pane id, or "new" for a separate pane agent-pane:<id>'),
      color:z.string().optional().describe('#rrggbb for line/hist/band; any CSS color (alpha ok) for markers/shapes/objects'),width:z.number().min(1).max(8).optional(),
      fill:z.enum(['none','linear','step']).optional().describe('Gap filling between points (line/band default linear)'),
      points:z.array(anchor).optional().describe('line/hist values; band lower edge'),upper:z.array(anchor).optional().describe('band upper edge'),
      markers:z.array(z.looseObject({time:time.optional(),bar:z.number().optional(),barsAgo:z.number().optional(),side:z.enum(['buy','sell']),value:z.number().optional(),price:priceField.optional(),text:z.string().optional()})).optional(),
      shapes:z.array(z.looseObject({time:time.optional(),bar:z.number().optional(),barsAgo:z.number().optional(),shape:z.string().optional(),location:z.enum(['abovebar','belowbar','top','bottom','absolute']).optional(),
        value:z.number().optional(),text:z.string().optional(),color:z.string().optional(),textColor:z.string().optional(),size:z.enum(['auto','tiny','small','normal','large','huge']).optional()})).optional(),
      objects:z.array(z.looseObject({kind:z.enum(['label','box','line']),at:anchor.optional().describe('label position'),from:anchor.optional(),to:anchor.optional(),text:z.string().optional(),
        color:z.string().optional(),fill:z.string().optional(),textColor:z.string().optional(),width:z.number().optional(),lineStyle:z.enum(['solid','dashed','dotted']).optional(),
        style:z.string().optional().describe('label: label_down|label_up|label_left|label_right|none|circle|…'),yloc:z.enum(['price','abovebar','belowbar']).optional(),fontSize:z.number().optional(),
        textAlign:z.enum(['left','center','right']).optional(),textValign:z.enum(['top','center','bottom']).optional()})).optional()},
    run:relay('overlay.set')},
  {name:'remove_overlays',title:'Remove agent overlays',readOnly:false,
    description:'Remove agent overlays on this market by id (with or without the "agent:" prefix) or all of them.',
    input:{chartId,ids:z.array(z.string()).optional(),all:z.boolean().optional()},
    run:relay('overlay.remove')},
  {name:'add_indicator',title:'Add an indicator or study',readOnly:false,
    description:'Add an indicator/pattern/analysis instance (type from get_catalog) with params, calculation timeframe ("chart" or e.g. "1h" closed-bar values), pane and output styles.',
    input:{chartId,type:z.string(),params:scalars.optional(),timeframe:z.string().optional(),paneId:z.string().optional().describe('Existing or new pane id; default by indicator target'),
      name:z.string().optional(),plotStyles:plotStyles.optional().describe('By output index: {"0":{"color":"#ff9800"}}')},
    run:relay('indicator.add')},
  {name:'update_indicator',title:'Update an indicator instance',readOnly:false,
    description:'Change params (clamped to the schema), timeframe, output styles, hidden outputs, visibility or name of an indicator instance. Remove one with delete_objects.',
    input:{chartId,id:z.string(),params:scalars.optional(),timeframe:z.string().optional(),plotStyles:plotStyles.optional(),hiddenPlots:z.array(z.number().int()).optional(),visible:z.boolean().optional(),name:z.string().optional()},
    run:relay('indicator.update')},
  {name:'set_view',title:'Change market or viewport',readOnly:false,
    description:'Switch source/symbol/interval (waits for data), focus a range, follow latest, show all history, zoom (>1 in), maximize a pane (null restores) or reset price scales ("all" or pane id). Applied in that order.',
    input:{chartId,market:z.object({source:z.string().optional(),symbol:z.string().optional(),interval:z.string().optional()}).optional(),range,follow:z.boolean().optional(),
      showAll:z.boolean().optional(),zoom:z.number().optional(),maximizePane:z.string().nullable().optional(),resetScale:z.string().optional(),timeFormat},
    run:relay('view')},
  {name:'select_objects',title:'Select objects on the chart',readOnly:false,
    description:'Select layers (shows handles), optionally reveal them in the object tree or open their properties dialog for the user. Empty ids clears the selection.',
    input:{chartId,ids:z.array(z.string()),reveal:z.boolean().optional(),properties:z.boolean().optional()},
    run:relay('select')},
  {name:'undo_redo',title:'Undo or redo',readOnly:false,
    description:'Undo/redo chart edits. History is shared with the user: only undo right after your own change.',
    input:{chartId,action:z.enum(['undo','redo']),steps:z.number().int().min(1).max(50).optional()},
    run:relay('history')},
  {name:'wait_for_event',title:'Wait for user activity on the chart',readOnly:true,
    description:'Selection, market and scene (objects added/removed; by user or agent) events of a chart. Pass since=next from the previous result; waitMs up to 25000 long-polls, e.g. after asking the user to select something.',
    input:{chartId,since:z.number().int().min(0).optional(),waitMs:z.number().int().min(0).max(25000).optional(),types:z.array(z.enum(['selection','market','scene'])).optional()},
    async run(args,backend,context){
      // Long polls stream a heartbeat so clients with short request timeouts keep waiting.
      const waitMs=args.waitMs as number|undefined,started=Date.now(),beat=waitMs?setInterval(()=>context.progress({message:`waiting for chart events (${Math.round((Date.now()-started)/1000)} s)`}),5000):undefined;
      try{
        const result=await backend.events({chartId:args.chartId as string|undefined,since:args.since as number|undefined,waitMs,types:args.types as string[]|undefined});
        return 'error' in result?failure(result.error.code,result.error.message):text(result);
      }finally{clearInterval(beat);}
    }},
];

type Extra={_meta?:{progressToken?:string|number};signal?:AbortSignal;sendNotification:(notification:{method:'notifications/progress';params:{progressToken:string|number;progress:number;total?:number;message?:string}})=>Promise<void>};
/** MCP progress must increase monotonically: a counter, with the page's own numbers in the message. */
function progressFor(extra:Extra):(value:CallProgress)=>void {
  const token=extra._meta?.progressToken;let count=0;
  return value=>{
    if(token===undefined)return;
    const detail=value.progress!==undefined?` (${value.progress}${value.total!==undefined?`/${value.total}`:''})`:'';
    void extra.sendNotification({method:'notifications/progress',params:{progressToken:token,progress:++count,message:value.message+detail}}).catch(()=>{});
  };
}
export const RESOURCES={guide:'tvchart://guide',charts:'tvchart://charts',active:'tvchart://chart/active'} as const;
/** Tools, plus the guide (skill) as a resource and prompts, plus subscribable live chart resources. */
export function registerTvchartTools(server:McpServer,backend:ToolBackend,options:{guide?:()=>string}={}):()=>void {
  for(const spec of TOOL_SPECS)server.registerTool(spec.name,{title:spec.title,description:spec.description,inputSchema:spec.input,
    annotations:{readOnlyHint:spec.readOnly,destructiveHint:!!spec.destructive,openWorldHint:false}},
  (args:Record<string,unknown>,extra:unknown)=>spec.run(args,backend,{progress:progressFor(extra as Extra),signal:(extra as Extra).signal}));
  const guide=options.guide;
  if(guide){
    server.registerResource('guide',RESOURCES.guide,{title:'open-tradingview agent guide',description:'How to read and annotate the chart well: workflow, coordinates, output forms, house rules, tool point semantics, recipes, and analysis limits.',mimeType:'text/markdown'},
      async uri=>({contents:[{uri:uri.href,mimeType:'text/markdown',text:guide()}]}));
    server.registerPrompt('tvchart_guide',{title:'open-tradingview agent guide',description:'Load the full usage guide (the project skill) into the conversation.'},
      ()=>({messages:[{role:'user',content:{type:'text',text:guide()}}]}));
    server.registerPrompt('analyze_chart',{title:'Analyze the current chart',description:'Read the chart the user is looking at and explain its structure, optionally annotating it.',
      argsSchema:{focus:z.string().optional().describe('What to focus on, e.g. "support and resistance"'),annotate:z.string().optional().describe('"yes" to draw the result on the chart')}},
      ({focus,annotate})=>({messages:[{role:'user',content:{type:'text',text:[
        `Use the open-tradingview tools to analyze the chart I am looking at${focus?`, focusing on ${focus}`:''}.`,
        'Start with get_chart_state and get_structure; cite exact prices and times from tool results.',
        annotate==='yes'?'Then annotate the result with draw (one group, one undo step) and verify with describe_chart.':'Do not draw anything unless I ask.',
        '','Guide:','',guide()].join('\n')}}]}));
  }
  server.registerResource('charts',RESOURCES.charts,{title:'Connected charts',description:'Charts open in the browser and which one is active.',mimeType:'application/json'},
    async uri=>({contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify(await backend.charts())}]}));
  server.registerResource('active-chart',RESOURCES.active,{title:'Active chart state',description:'Compact live state of the chart the user is looking at. Subscribe to be notified when its selection, market or objects change.',mimeType:'application/json'},
    async uri=>{
      const response=await backend.call('state',{include:['market','cursor','viewport','selection','tools','drawings','indicators','overlays','analysis'],maxDrawings:50});
      return {contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify(response.ok?{chart:'chart' in response?response.chart:undefined,...(response.result as object)}:{error:response.error})}]};
    });
  // Streaming updates: chart events pushed from the hub become resources/updated notifications.
  const subscribed=new Set<string>(),pendingUpdates=new Set<string>();let flush:ReturnType<typeof setTimeout>|undefined;
  server.server.registerCapabilities({resources:{subscribe:true}});
  server.server.setRequestHandler(SubscribeRequestSchema,async request=>{subscribed.add(request.params.uri);return {};});
  server.server.setRequestHandler(UnsubscribeRequestSchema,async request=>{subscribed.delete(request.params.uri);return {};});
  const unsubscribe=backend.subscribe?.(event=>{
    if(subscribed.has(RESOURCES.active))pendingUpdates.add(RESOURCES.active);
    if(event.type==='market'&&subscribed.has(RESOURCES.charts))pendingUpdates.add(RESOURCES.charts);
    if(!pendingUpdates.size||flush)return;
    flush=setTimeout(()=>{flush=undefined;for(const uri of pendingUpdates)void server.server.sendResourceUpdated({uri}).catch(()=>{});pendingUpdates.clear();},250);
  });
  return ()=>{unsubscribe?.();clearTimeout(flush);};
}
/** One compact line per parameter, for /llms.txt. */
export function toolParameters(spec:ToolSpec):string[] {
  const schema=z.toJSONSchema(z.object(spec.input),{unrepresentable:'any'}) as {properties?:Record<string,{type?:unknown;enum?:unknown[];description?:string;anyOf?:unknown[]}>;required?:string[]};
  return Object.entries(schema.properties??{}).map(([key,value])=>{
    const kind=value.enum?value.enum.map(item=>JSON.stringify(item)).join('|'):Array.isArray(value.type)?value.type.join('|'):typeof value.type==='string'?value.type:value.anyOf?'union':'any';
    return `${key}${schema.required?.includes(key)?'':'?'}: ${kind}${value.description?` — ${value.description}`:''}`;
  });
}
