import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ChartController,initialState} from '../src/lib/chart/controller';
import {ColumnStore} from '../src/lib/core/datastore';
import {Pyramid} from '../src/lib/core/pyramid';
import {Viewport} from '../src/lib/core/viewport';
import {PaneLayout} from '../src/lib/core/pane-layout';
import {LiveBarMotion} from '../src/lib/interaction/live-bar-motion';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {DrawingEngine} from '../src/lib/drawing/engine';
import {ToolRegistry} from '../src/lib/drawing/registry';
import {registerDrawingBuiltins} from '../src/lib/drawing/builtins';
import {emptyScene,layerOf} from '../src/lib/scene/types';
import {normalizeOrderFlowSettings,type ChartOrderFlowState} from '../src/lib/flow/chart-order-flow';
import {closedPricePrefix} from '../src/lib/flow/price-replay';
import {prepareDepthOverlay,drawDepthHeatmap,drawDepthProfile} from '../src/lib/render/orderbook-overlay';
import {publicMarketRequest} from '../src/lib/market/public-transport';
import type {SharedBookSnapshot} from '../src/lib/flow/orderbook-hub';
import type {DatasetInfo} from '../src/lib/flow/persistence-client';
import type {DatasetSnapshot} from '../src/lib/history/types';

const {paintOrder}=vi.hoisted(()=>({paintOrder:[] as string[]}));
vi.mock('../src/lib/render/axes',async original=>({...await original<typeof import('../src/lib/render/axes')>(),drawAxesBase:vi.fn()}));
vi.mock('../src/lib/market/public-transport',async original=>({...await original<typeof import('../src/lib/market/public-transport')>(),publicMarketRequest:vi.fn()}));
vi.mock('../src/lib/render/price-series',async original=>{const actual=await original<typeof import('../src/lib/render/price-series')>();return {...actual,paintPriceBar:vi.fn((...args:Parameters<typeof actual.paintPriceBar>)=>{paintOrder.push('candle');actual.paintPriceBar(...args);})};});
vi.mock('../src/lib/render/orderbook-overlay',async original=>{const actual=await original<typeof import('../src/lib/render/orderbook-overlay')>();return {...actual,
  prepareDepthOverlay:vi.fn(actual.prepareDepthOverlay),
  drawDepthHeatmap:vi.fn((...args:Parameters<typeof actual.drawDepthHeatmap>)=>{paintOrder.push('heatmap');actual.drawDepthHeatmap(...args);}),
  drawDepthProfile:vi.fn((...args:Parameters<typeof actual.drawDepthProfile>)=>{paintOrder.push('profile');actual.drawDepthProfile(...args);})};});

const minute=60000,cleanup:Array<()=>void>=[];
const market={source:'binance',marketType:'usdm-perpetual',symbol:'BTCUSDT',tickSize:.1};
const candle=(time:number,close=100)=>({time,open:close,high:close+10,low:close-10,close,volume:10});
const archiveDataset:DatasetInfo={id:'native-depth',symbol:'BTCUSDT',source:'binance',kind:'recording',tradeType:'aggTrades',state:'stopped',createdAt:0,fromTime:3*minute,throughTime:8*minute,tradeCount:0,depthCount:10,gapCount:0};
function flowState(mode:'live'|'history'='live'):ChartOrderFlowState {
  const history=[20*minute+1000,20*minute+2000].map((time,index)=>({time,eventTime:time-10,receivedAt:time,availableAt:time,revision:index+1,segmentId:1,bids:[{price:100,quantity:2}],asks:[{price:101,quantity:3}]}));
  const book:SharedBookSnapshot={identity:market,key:'shared-book',symbol:'BTCUSDT',supported:true,status:'live',bids:[{price:100,quantity:2},{price:10000,quantity:1e8}],asks:[{price:101,quantity:3}],updatedAt:history.at(-1)!.eventTime,lastReceivedAt:history.at(-1)!.time,lastUpdateId:2,revision:2,segmentId:1,capturedAt:history.at(-1)!.time,history,changes:[],
    coverage:{fromTime:history[0].eventTime,throughTime:history.at(-1)!.eventTime,receivedFromTime:history[0].time,receivedThroughTime:history.at(-1)!.time,segmentId:1,depthPerSide:1000},changeCoverage:{fromTime:history[0].time,throughTime:history.at(-1)!.time,truncated:false},historyCoverage:{fromTime:history[0].time,throughTime:history.at(-1)!.time,samples:2,intervalMs:1000,maxSamples:150,levelsPerSide:80}};
  return {market,settings:normalizeOrderFlowSettings({heatmap:true,profile:true,priceStepTicks:10}),mode,running:true,book,error:'',revision:2,
    ...(mode==='history'?{archive:{dataset:archiveDataset,from:3*minute,to:8*minute,cursor:5.5*minute,gaps:[],pending:false,heatmap:{datasetId:archiveDataset.id,fromTime:3*minute,toTime:8*minute,samples:[{time:4*minute,book:{status:'available' as const,time:4*minute-10,lastUpdateId:1,bids:[{price:100,quantity:2}],asks:[{price:101,quantity:3}]}}],note:'actual record'}}}:{})};
}
const wireRows=()=>Array.from({length:9},(_,i)=>[i*minute,'100','110','90','100','10',(i+1)*minute-1]);
const response=(rows:unknown)=>({ok:true,status:200,json:async()=>rows}) as Response;
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};}
async function flush(){for(let i=0;i<8;i++)await Promise.resolve();}
beforeEach(()=>{
  const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)});
  vi.mocked(publicMarketRequest).mockReset().mockResolvedValue(response(wireRows()));
});
afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());vi.unstubAllGlobals();vi.restoreAllMocks();});
function harness(order?:ChartOrderFlowState,interval='1m'){
  const store=new ColumnStore();for(let i=0;i<100;i++)store.appendBar(candle(i*minute));
  const registry=new IndicatorRegistry();registerBuiltins(registry);const tools=new ToolRegistry();registerDrawingBuiltins(tools);
  const doc=emptyScene();doc.layers=[layerOf('series:candles','series','Price'),layerOf('macd','indicator','MACD','macd')];doc.indicators=[{id:'macd',instanceId:'macd',params:{fast:12,slow:26,signal:9},timeframe:'chart',hiddenPlots:[]}];
  const renderer={begin:vi.fn(),setOpacity:vi.fn(),canvasLayer:vi.fn(),clip:vi.fn(),rect:vi.fn(),seg:vi.fn(),marker:vi.fn(),flush:vi.fn()};
  const engine={derived:[{name:'DIF',indicatorId:'macd',plotIndex:0,pane:'sub',plot:'line',color:'#aabbcc',values:Float64Array.from({length:100},(_,i)=>i/100)}],setReqs:vi.fn(),pending:false,destroy:vi.fn(),init:vi.fn()};
  let controller:any;
  const ref={value:order},flow={snapshot:()=>ref.value!,configure:vi.fn(),live:vi.fn(()=>{ref.value={...ref.value!,mode:'live',archive:undefined,book:undefined};controller.queueOrderFlowPriceSync();})};
  controller=Object.assign(Object.create(ChartController.prototype),{
    registry,engine,store,pyramid:new Pyramid(store),viewport:new Viewport(100,{from:0,to:100,plotW:1000,plotH:600}),paneLayout:new PaneLayout(),renderer,
    state:{...initialState,source:'binance',symbol:'BTCUSDT',marketType:'usdm-perpetual',interval,loading:false,smoothMotion:false},width:1088,height:626,
    panes:[],manualScales:new Map(),emptyPaneRanges:new Map(),fitEmptyPanes:new Set(),autoRanges:new Map(),projectionCache:new Map(),studyMarkers:new Map(),
    maximizedPane:null,drag:null,liveBarMotion:new LiveBarMotion(),generation:0,overlays:[],markerIndices:new Map(),
    externalOverlays:[],dataRevision:0,
    ctx:{},axisContext:{clearRect:vi.fn()},syncPaneControls:vi.fn(),publish:vi.fn(),loadPatternHistory:vi.fn(async()=>{}),
    reqs:[],syncedDocument:null,syncedInterval:'',calculationSignature:'',drawingRevision:0,sceneLookupDocument:null,layerLookup:new Map(),instanceLookup:new Map(),
    cancelDrag:vi.fn(),cancelViewportMotion:vi.fn(),refreshOverlays:vi.fn(),historicalSnapshot:false,dead:false,
    ...(order?{orderFlow:flow}:{}),
  });
  const drawing=new DrawingEngine(tools,{paneAt:p=>controller.panes.find((pane:{top:number;height:number})=>p.y>=pane.top&&p.y<pane.top+pane.height)?.id??null,
    projection:id=>controller.drawingProjection(id),anchorAt:(p,id,snap)=>controller.drawingAnchor(p,id,snap),zoomTo:()=>{}},()=>{controller.dirty=true;},()=>doc);
  controller.drawing=drawing;drawing.setMarket('binance:usdm-perpetual:BTCUSDT');const off=drawing.subscribe(()=>controller.syncScene());
  const draw=()=>{paintOrder.length=0;vi.mocked(prepareDepthOverlay).mockClear();vi.mocked(drawDepthHeatmap).mockClear();vi.mocked(drawDepthProfile).mockClear();controller.draw();};
  cleanup.push(()=>{off();drawing.destroy();});return {controller,draw,renderer,engine,ref,flow};
}

describe('controller main-pane order-flow composition',()=>{
  it('draws existing Object.create harnesses without an initialized order-flow dependency',()=>{
    const h=harness();expect(()=>h.draw()).not.toThrow();expect(paintOrder).toContain('candle');expect(prepareDepthOverlay).not.toHaveBeenCalled();expect(h.controller.depthCells).toEqual([]);
  });
  it('confines heatmap and profile to main price coordinates and does not stretch price or oscillator ranges',()=>{
    const h=harness(flowState());h.draw();const ranges=h.controller.panes.map((p:{id:string;min:number;max:number})=>({id:p.id,min:p.min,max:p.max}));
    const main=h.controller.panes.find((p:{id:string})=>p.id==='main'),projection=vi.mocked(prepareDepthOverlay).mock.calls[0][1];
    expect(projection).toMatchObject({top:main.top,bottom:main.top+main.height,min:main.min,max:main.max});expect(main.max).toBeLessThan(1000);
    expect(projection.timeX(20*minute)).toBe(h.controller.viewport.xOf(20));expect(projection.priceY(100)).toBeCloseTo(main.top+main.height/2);
    expect(h.controller.depthCells.every((cell:{top:number;bottom:number})=>cell.top>=main.top&&cell.bottom<=main.top+main.height)).toBe(true);
    expect(paintOrder[0]).toBe('heatmap');expect(paintOrder.at(-1)).toBe('profile');expect(paintOrder.indexOf('candle')).toBeGreaterThan(paintOrder.indexOf('heatmap'));
    h.ref.value={...h.ref.value!,settings:{...h.ref.value!.settings,heatmap:false,profile:false}};h.draw();
    expect(h.controller.panes.map((p:{id:string;min:number;max:number})=>({id:p.id,min:p.min,max:p.max}))).toEqual(ranges);
    h.controller.maximizedPane='macd';h.ref.value=flowState();h.draw();expect(prepareDepthOverlay).not.toHaveBeenCalled();expect(h.controller.depthCells).toEqual([]);
  });
  it('draws recorded overlays only when the active price store is the matching loaded archive prefix',async()=>{
    const h=harness(flowState('history'));h.draw();expect(prepareDepthOverlay).not.toHaveBeenCalled();
    await h.controller.loadOrderFlowArchivePrices();h.draw();expect(prepareDepthOverlay).toHaveBeenCalledOnce();
    const other:DatasetSnapshot={source:'binance',marketType:'usdm-perpetual',symbol:'BTCUSDT',interval:'1m',bars:Array.from({length:9},(_,i)=>candle(i*minute,150))};
    h.controller.showHistoricalDataset(other,'analysis');h.draw();expect(prepareDepthOverlay).not.toHaveBeenCalled();
  });
  it('shows the heatmap cross-section table for hovered depth columns instead of a text tooltip',()=>{
    const h=harness(flowState());h.draw();
    const tooltip={style:{} as Record<string,string>,replaceChildren:vi.fn(),offsetWidth:240,offsetHeight:80};
    const main=h.controller.panes.find((p:{id:string})=>p.id==='main'),y=main.top+main.height/2;
    const table={times:[null,1000,2000],centerColumn:1,centerRow:3,step:1,rows:Array.from({length:7},(_,i)=>({priceLow:103-i,priceHigh:104-i,cells:[null,{quantity:i,side:'bid'},{quantity:i+1,side:'bid'}]}))};
    const crossSection=vi.fn(()=>table);
    h.controller.markerTooltip=tooltip;h.controller.depthCells=[{left:100,right:110,top:y-5,bottom:y+5,time:1000,through:1000,priceLow:1,priceHigh:2,quantity:1,side:'bid'}];
    h.controller.depthOverlay={cells:[],profile:[],maximum:1,profileMaximum:0,priceStep:1,crossSection};h.controller.pointer={x:105,y};
    h.controller.syncMarkerTooltip();
    expect(tooltip.style.display).toBe('none');expect(crossSection).toHaveBeenCalledWith(105,y);
    expect(h.controller.depthTable).toEqual({table,pointer:{x:105,y}});
    h.controller.pointer={x:105,y:main.top+main.height+40};h.controller.syncMarkerTooltip();expect(h.controller.depthTable).toBeUndefined();
  });
});

describe('native archived price cursor synchronization',()=>{
  it('caches future prices but sends only complete candles to the native chart and reuses the cache on seeks',async()=>{
    const h=harness(flowState('history'),'15m');await h.controller.loadOrderFlowArchivePrices();
    expect(publicMarketRequest).toHaveBeenCalledOnce();expect(h.controller.orderFlowPrices.dataset.bars).toHaveLength(9);
    expect(h.controller.store.length).toBe(5);expect(h.controller.store.timeAt(4)).toBe(4*minute);expect(h.controller.state.interval).toBe('1m');
    const from=h.controller.viewport.from,to=h.controller.viewport.to;
    h.ref.value={...h.ref.value!,archive:{...h.ref.value!.archive!,cursor:7.5*minute}};h.controller.queueOrderFlowPriceSync();await flush();
    expect(h.controller.store.length).toBe(7);expect(h.controller.store.timeAt(6)).toBe(6*minute);expect(publicMarketRequest).toHaveBeenCalledOnce();
    expect([h.controller.viewport.from,h.controller.viewport.to]).toEqual([from,to]);
    h.ref.value={...h.ref.value!,archive:{...h.ref.value!.archive!,cursor:2.5*minute}};h.controller.queueOrderFlowPriceSync();await flush();expect(h.controller.store.length).toBe(2);
  });
  it('does not leave later price candles visible when the cursor precedes the first closed candle',async()=>{
    const h=harness(flowState('history'));await h.controller.loadOrderFlowArchivePrices();expect(h.controller.store.length).toBe(5);
    h.ref.value={...h.ref.value!,archive:{...h.ref.value!.archive!,cursor:30_000}};h.controller.queueOrderFlowPriceSync();await flush();
    expect(h.controller.store.length).toBe(0);
  });
  it('reuses the existing native price store and indicators while a depth seek stays inside the same unfinished candle',async()=>{
    const h=harness(flowState('history'));await h.controller.loadOrderFlowArchivePrices();const store=h.controller.store,initializations=h.engine.init.mock.calls.length;
    h.ref.value={...h.ref.value!,archive:{...h.ref.value!.archive!,cursor:5.75*minute}};h.controller.queueOrderFlowPriceSync();await flush();
    expect(h.controller.orderFlowPrices.cursor).toBe(5.75*minute);expect(h.controller.store).toBe(store);expect(h.engine.init).toHaveBeenCalledTimes(initializations);
  });
  it('restores the original live interval on the order-flow live action and the main-chart latest action',async()=>{
    const h=harness(flowState('history'),'15m');await h.controller.loadOrderFlowArchivePrices();h.controller.setMarket=vi.fn(async()=>{});
    h.flow.live();h.controller.queueOrderFlowPriceSync();await flush();expect(h.controller.setMarket).toHaveBeenCalledWith('binance','BTCUSDT','15m');
    const second=harness(flowState('history'),'15m');await second.controller.loadOrderFlowArchivePrices();second.controller.setMarket=vi.fn(async()=>{});
    second.controller.followLatest();await flush();
    expect(second.flow.live).toHaveBeenCalledOnce();expect(second.controller.setMarket).toHaveBeenCalledWith('binance','BTCUSDT','15m');
  });
  it('retains the original live interval while switching between two depth archives for the same market',async()=>{
    const h=harness(flowState('history'),'15m');await h.controller.loadOrderFlowArchivePrices();
    h.ref.value={...h.ref.value!,archive:{...h.ref.value!.archive!,dataset:{...archiveDataset,id:'second-archive'}}};h.controller.queueOrderFlowPriceSync();await flush();
    await h.controller.loadOrderFlowArchivePrices();h.controller.setMarket=vi.fn(async()=>{});h.flow.live();await flush();
    expect(h.controller.setMarket).toHaveBeenCalledWith('binance','BTCUSDT','15m');
  });
  it('rejects late prices after a symbol or selected archive changes',async()=>{
    const h=harness(flowState('history')),pending=deferred<Response>();vi.mocked(publicMarketRequest).mockReturnValueOnce(pending.promise);
    const original=h.controller.store,loading=h.controller.loadOrderFlowArchivePrices();
    h.controller.generation++;h.controller.state={...h.controller.state,symbol:'ETHUSDT'};h.ref.value={...h.ref.value!,market:{...market,symbol:'ETHUSDT'},archive:undefined};
    pending.resolve(response(wireRows()));await expect(loading).rejects.toThrow();expect(h.controller.store).toBe(original);expect(h.controller.orderFlowPrices).toBeUndefined();
  });
  it('aborts an older price request and never lets its late completion replace a newer cache',async()=>{
    const h=harness(flowState('history')),pending=deferred<Response>();vi.mocked(publicMarketRequest).mockReturnValueOnce(pending.promise);
    const first=h.controller.loadOrderFlowArchivePrices();const abort=h.controller.orderFlowPriceRequest;
    await h.controller.loadOrderFlowArchivePrices();expect(abort.signal.aborted).toBe(true);const store=h.controller.store;
    pending.resolve(response(wireRows()));await expect(first).rejects.toThrow();expect(h.controller.store).toBe(store);expect(h.controller.orderFlowPrices.id).toBe('native-depth');
  });
});

describe('closed price prefixes',()=>{
  const dataset:DatasetSnapshot={source:'binance',marketType:'usdm-perpetual',symbol:'BTCUSDT',interval:'1m',bars:[candle(0),candle(minute),candle(2*minute)],markPrices:[{time:0,close:100},{time:minute,close:101},{time:2*minute,close:102},{time:100*minute,close:999}]};
  it('hides an unfinished candle and all of its later OHLC and mark prices',()=>{
    const result=closedPricePrefix(dataset,1.5*minute);expect(result.bars.map(bar=>bar.time)).toEqual([0]);expect(result.markPrices).toEqual([{time:0,close:100}]);expect(dataset.bars).toHaveLength(3);
  });
  it('keeps future mark prices hidden even when every available candle is already closed',()=>{
    expect(closedPricePrefix(dataset,3*minute).markPrices?.map(price=>price.time)).toEqual([0,minute,2*minute]);
    expect(closedPricePrefix(dataset,30_000)).toMatchObject({bars:[],markPrices:[]});
  });
  it('uses real calendar-month closing boundaries rather than a fixed thirty-day approximation',()=>{
    const monthly:DatasetSnapshot={...dataset,interval:'30d',bars:[candle(Date.UTC(2026,0,1)),candle(Date.UTC(2026,1,1)),candle(Date.UTC(2026,2,1))],markPrices:undefined};
    expect(closedPricePrefix(monthly,Date.UTC(2026,0,31)).bars).toEqual([]);
    expect(closedPricePrefix(monthly,Date.UTC(2026,1,15)).bars.map(bar=>bar.time)).toEqual([Date.UTC(2026,0,1)]);
    expect(closedPricePrefix(monthly,Date.UTC(2026,2,1)).bars.map(bar=>bar.time)).toEqual([Date.UTC(2026,0,1),Date.UTC(2026,1,1)]);
  });
});
