import {acquireOrderBook,type SharedBookSnapshot,type SharedOrderBookLease,type OrderBookIdentity} from './orderbook-hub';
import {aggregateOrderBook,type BookUnit,type AggregatedBook} from './orderbook-models';
import {createMarketDataClient,type DatasetInfo,type DepthHeatmap,type ReplaySnapshot,type RecordedGap} from './persistence-client';
import {createTradeFlowSession,type TradeFlowSession} from './session';
import type {TradeFlowSessionSnapshot} from './types';
import type {BookLevel} from './orderbook';
import {isHeatmapThemeId,type HeatmapDisplayMode,type HeatmapResolution,type HeatmapSensitivityPreset,type HeatmapThemeId} from './heatmap-themes';

export interface OrderFlowSettings {
  heatmap:boolean;profile:boolean;unit:BookUnit;priceStepTicks:number;threshold:number;opacity:number;windowMs:number;view:'book'|'delta'|'dom';
  theme?:HeatmapThemeId;resolution?:HeatmapResolution;sensitivity?:HeatmapSensitivityPreset;
  ceiling?:number;minBounds?:number;maxBounds?:number;crossSection?:boolean;lastDisplay?:HeatmapDisplayMode;
}
export interface OrderFlowMarket extends OrderBookIdentity {tickSize:number;chartHistorical?:boolean;}
export interface OrderFlowArchive {dataset:DatasetInfo;from:number;to:number;cursor:number;heatmap?:DepthHeatmap;frame?:ReplaySnapshot;gaps:RecordedGap[];pending:boolean;}
/** Server-sampled heatmap history for the live market, pre-bucketed to `step`. */
export interface DepthHistory {symbol:string;step:number;from:number;to:number;strideMs:number;fetchedAt:number;revision:number;
  samples:ReadonlyArray<{time:number;bids:BookLevel[];asks:BookLevel[]}>}
export interface ChartOrderFlowState {market?:OrderFlowMarket;settings:OrderFlowSettings;mode:'live'|'history';running:boolean;book?:SharedBookSnapshot;trades?:TradeFlowSessionSnapshot;archive?:OrderFlowArchive;depthHistory?:DepthHistory;error:string;revision:number;}
const KEY='tvchart.order-flow-display.v1';
/** Heatmap depth window: ±4% of the mid (BTC ≈ ±$3,300), in $5-per-$84k pooled bins. */
export const DEPTH_RANGE_RATIO=.04;
const defaults:OrderFlowSettings={heatmap:false,profile:false,unit:'base',priceStepTicks:50,threshold:0,opacity:.65,windowMs:5000,view:'book',theme:'stark',resolution:'hd',sensitivity:'med',ceiling:0,minBounds:0,maxBounds:0,crossSection:false,lastDisplay:'both'};
export function normalizeOrderFlowSettings(raw:Partial<OrderFlowSettings>):OrderFlowSettings {
  const heatmap=raw.heatmap===true,profile=raw.profile===true;
  const derivedDisplay:HeatmapDisplayMode=heatmap&&profile?'both':heatmap?'heatmap':profile?'profile':['heatmap','profile','both'].includes(raw.lastDisplay??'')?raw.lastDisplay!:'both';
  return {heatmap,profile,unit:raw.unit==='quote'?'quote':'base',
    priceStepTicks:typeof raw.priceStepTicks==='number'&&Number.isFinite(raw.priceStepTicks)?Math.max(1,Math.min(100000,Math.round(raw.priceStepTicks))):50,
    threshold:typeof raw.threshold==='number'&&Number.isFinite(raw.threshold)?Math.max(0,raw.threshold):0,
    opacity:typeof raw.opacity==='number'&&Number.isFinite(raw.opacity)?Math.max(.05,Math.min(.95,raw.opacity)):.65,
    windowMs:[1000,5000,30000].includes(raw.windowMs??0)?raw.windowMs!:5000,view:['book','delta','dom'].includes(raw.view??'')?raw.view!:'book',
    theme:isHeatmapThemeId(raw.theme)?raw.theme:'stark',
    resolution:raw.resolution==='4k'?'4k':'hd',
    sensitivity:['high','med','low','custom'].includes(raw.sensitivity??'')?raw.sensitivity!:'med',
    ceiling:typeof raw.ceiling==='number'&&Number.isFinite(raw.ceiling)?Math.max(0,raw.ceiling):0,
    minBounds:typeof raw.minBounds==='number'&&Number.isFinite(raw.minBounds)?Math.max(0,raw.minBounds):0,
    maxBounds:typeof raw.maxBounds==='number'&&Number.isFinite(raw.maxBounds)?Math.max(0,raw.maxBounds):0,
    crossSection:raw.crossSection===true,
    lastDisplay:derivedDisplay};
}
function loadSettings(){try{return normalizeOrderFlowSettings(JSON.parse(localStorage.getItem(KEY)??'{}'));}catch{return {...defaults};}}
export interface ChartOrderFlowOptions {
  acquire?:typeof acquireOrderBook;client?:ReturnType<typeof createMarketDataClient>;
  storage?:Pick<Storage,'getItem'|'setItem'>|null;now?:()=>number;
  createTrades?:typeof createTradeFlowSession;
  /** Local depth-sampler endpoint requests (tests inject a fake). */
  depthRequest?:typeof fetch;
}
/** One chart clock owns both overlays and its terminal. Independent panel and
 * overlay demand share one lease, and another chart's lease remains isolated. */
export class ChartOrderFlow {
  private value:ChartOrderFlowState;
  private listeners=new Set<(state:ChartOrderFlowState)=>void>();
  private lease?:SharedOrderBookLease;private offBook?:()=>void;private tradeSession?:TradeFlowSession;
  private panelUsers=0;private dead=false;private generation=0;private query?:AbortController;
  private liveEpoch=0;private tradeEpoch=0;
  private aggregateCache?:{book:SharedBookSnapshot;key:string;result:AggregatedBook};
  private watchedDepth=new Set<string>();private historyKey='';private historyTimer:ReturnType<typeof setTimeout>|undefined;
  private historyAbort?:AbortController;private historyBackoffUntil=0;
  private readonly acquire:typeof acquireOrderBook;private readonly client:ReturnType<typeof createMarketDataClient>;private readonly now:()=>number;
  constructor(private onPaint:()=>void=()=>{},private options:ChartOrderFlowOptions={}){
    this.acquire=options.acquire??acquireOrderBook;this.client=options.client??createMarketDataClient();this.now=options.now??Date.now;
    let settings=loadSettings();if(options.storage!==undefined)try{settings=normalizeOrderFlowSettings(JSON.parse(options.storage?.getItem(KEY)??'{}'));}catch{settings={...defaults};}
    this.value={settings,mode:'live',running:true,error:'',revision:0};
  }
  snapshot(){return this.value;}
  subscribe(listener:(state:ChartOrderFlowState)=>void){if(this.dead)return()=>{};this.listeners.add(listener);try{listener(this.value);}catch{/* Isolate consumers. */}return()=>this.listeners.delete(listener);}
  panel(active=true):()=>void {if(this.dead)return()=>{};if(active)this.panelUsers++;this.reconcile();let done=false;return()=>{if(done)return;done=true;if(active)this.panelUsers=Math.max(0,this.panelUsers-1);this.reconcile();};}
  configure(market:OrderFlowMarket){
    if(this.dead)return;
    const old=this.value.market,key=(v?:OrderFlowMarket)=>v?`${v.source}:${v.marketType}:${v.symbol}:${v.tickSize}:${!!v.chartHistorical}`:'';
    if(key(old)===key(market))return;
    const sameMarket=old&&old.source===market.source&&old.marketType===market.marketType&&old.symbol===market.symbol;
    if(!sameMarket){this.generation++;this.query?.abort();this.stop();this.cancelDepthHistory();this.value={...this.value,market:{...market},mode:'live',book:undefined,trades:undefined,archive:undefined,depthHistory:undefined,error:''};}
    else{if(old?.tickSize!==market.tickSize)this.stopTrades();this.value={...this.value,market:{...market}};}
    this.reconcile();this.emit();
  }
  settings(patch:Partial<OrderFlowSettings>){
    if(this.dead)return;const next=normalizeOrderFlowSettings({...this.value.settings,...patch});if(JSON.stringify(next)===JSON.stringify(this.value.settings))return;
    this.value={...this.value,settings:next};
    try{const storage=this.options.storage===undefined?localStorage:this.options.storage;storage?.setItem(KEY,JSON.stringify(next));}catch{/* View remains usable when persistence is unavailable. */}
    this.reconcile();this.emit();
  }
  pause(paused:boolean){if(this.dead)return;this.value={...this.value,running:!paused};this.reconcile();this.emit();}
  reconnect(){if(this.dead)return;if(this.value.mode==='history'&&this.value.archive){const archive=this.value.archive;void(archive.heatmap?this.seek(archive.cursor):this.loadArchive(archive.dataset));return;}
    const existing=this.lease;this.value={...this.value,error:'',running:true};this.reconcile();if(existing&&existing===this.lease)void existing.reconnect();this.emit();}
  live(){if(this.dead)return;this.generation++;this.query?.abort();this.value={...this.value,mode:'live',archive:undefined,book:this.lease?.snapshot(),error:'',running:true};this.reconcile();this.emit();}
  async datasets(){const market=this.value.market;if(!market||this.dead)return [];const result=await this.client.datasets(market.symbol);
    if(this.dead||this.value.market?.symbol!==market.symbol||this.value.market?.source!==market.source)return [];
    return result.filter(d=>d.symbol===market.symbol&&d.depthCount>0);}
  async loadArchive(dataset:DatasetInfo){
    if(this.dead)return;
    const market=this.value.market,from=dataset.fromTime,to=dataset.throughTime;
    if(!market||dataset.symbol!==market.symbol||market.source!=='binance'||market.marketType!=='usdm-perpetual'||!dataset.depthCount||!Number.isFinite(from)||!Number.isFinite(to)||to!<=from!){this.value={...this.value,error:'该档案没有可用深度区间'};this.emit();return;}
    const generation=++this.generation;this.query?.abort();const query=new AbortController();this.query=query;this.stop();
    this.value={...this.value,mode:'history',book:undefined,trades:undefined,error:'',archive:{dataset,from:from!,to:to!,cursor:to!,gaps:[],pending:true}};this.emit();
    try{
      const [heatmap,frame]=await Promise.all([this.client.heatmap(dataset.id,{from:from!,to:to!,samples:160,levels:100},query.signal),this.client.replay(dataset.id,to!,1000,query.signal)]);
      if(this.dead||query.signal.aborted||generation!==this.generation)return;
      if(heatmap.datasetId!==dataset.id)throw Error('深度档案响应与所选数据集不一致');
      this.value={...this.value,archive:{dataset,from:from!,to:to!,cursor:to!,heatmap,frame,gaps:frame.coverage.gaps,pending:false}};this.publishArchiveBook();
    }catch(error){if(query.signal.aborted||generation!==this.generation)return;this.value={...this.value,book:undefined,error:error instanceof Error?error.message:'深度档案加载失败',archive:this.value.archive?{...this.value.archive,frame:undefined,pending:false}:undefined};}
    this.emit();
  }
  async seek(time:number){
    const archive=this.value.archive;if(this.dead||!archive||this.value.mode!=='history')return;
    const cursor=Math.min(archive.to,Math.max(archive.from,Math.round(time)));if(!Number.isFinite(cursor))return;
    const generation=++this.generation;this.query?.abort();const query=new AbortController();this.query=query;
    this.value={...this.value,book:undefined,error:'',archive:{...archive,cursor,frame:undefined,pending:true}};this.emit();
    try{const [frame,heatmap]=await Promise.all([this.client.replay(archive.dataset.id,cursor,1000,query.signal),archive.heatmap?Promise.resolve(archive.heatmap):this.client.heatmap(archive.dataset.id,{from:archive.from,to:archive.to,samples:160,levels:100},query.signal)]);if(this.dead||query.signal.aborted||generation!==this.generation)return;
      if(heatmap.datasetId!==archive.dataset.id)throw Error('深度档案响应与所选数据集不一致');
      this.value={...this.value,archive:{...archive,cursor,frame,heatmap,gaps:frame.coverage.gaps,pending:false}};this.publishArchiveBook();
    }catch(error){if(query.signal.aborted||generation!==this.generation)return;this.value={...this.value,error:error instanceof Error?error.message:'回放寻址失败',archive:{...archive,cursor,frame:undefined,pending:false}};}
    this.emit();
  }
  aggregate(limit=30){const book=this.value.book,tick=this.value.market?.tickSize??0;if(!book||tick<=0)return;
    const settings=this.value.settings,now=this.value.mode==='history'?this.value.archive?.cursor:Number.isFinite(book.capturedAt)?book.capturedAt:this.now(),
      includeChanges=settings.view==='delta',key=[tick,settings.priceStepTicks,settings.unit,settings.windowMs,limit,now,includeChanges].join(':');
    if(this.aggregateCache?.book===book&&this.aggregateCache.key===key)return this.aggregateCache.result;
    const result=aggregateOrderBook(book,{priceStep:tick*settings.priceStepTicks,limit,unit:settings.unit,windowMs:settings.windowMs,now,includeChanges});
    this.aggregateCache={book,key,result};return result;}
  /**
   * Keep server-sampled heatmap history covering the visible time range. Cheap
   * to call every frame: covered/fresh ranges and in-flight requests return
   * immediately; the fetch is debounced and pads half a screen to the left.
   */
  requestDepthHistory(from:number,to:number,step:number){
    const {market,settings,mode}=this.value,now=this.now();
    if(this.dead||mode!=='live'||!settings.heatmap||!market||market.source!=='binance'||market.marketType!=='usdm-perpetual'||!(step>0)||!(to>from)||now<this.historyBackoffUntil)return;
    const history=this.value.depthHistory;
    if(history&&history.symbol===market.symbol&&history.step===step&&history.from<=from&&history.to>=Math.min(to,now)-history.strideMs&&now-history.fetchedAt<30_000)return;
    const key=`${market.symbol}:${step}:${Math.floor(from/60_000)}:${Math.floor(Math.min(to,now)/60_000)}`;
    if(this.historyKey===key)return;
    this.historyKey=key;clearTimeout(this.historyTimer);
    this.historyTimer=setTimeout(()=>{void this.fetchDepthHistory(market.symbol,from,to,step,key);},250);
  }
  private async fetchDepthHistory(symbol:string,from:number,to:number,step:number,key:string){
    const request=this.options.depthRequest??((input,init)=>fetch(input,init)),now=this.now(),padFrom=Math.floor(from-(to-from)*.5),padTo=Math.ceil(Math.max(Math.min(to,now),from+1));
    this.historyAbort?.abort();const abort=new AbortController();this.historyAbort=abort;
    try{
      if(!this.watchedDepth.has(symbol)){
        const watched=await request('/api/depth-samples/watch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol}),signal:abort.signal});
        if(!watched.ok)throw Error(`HTTP ${watched.status}`);this.watchedDepth.add(symbol);
      }
      const query=new URLSearchParams({symbol,from:String(padFrom),to:String(padTo),step:String(step),columns:'600'});
      const response=await request(`/api/depth-samples?${query}`,{signal:abort.signal});if(!response.ok)throw Error(`HTTP ${response.status}`);
      const body=await response.json() as {strideMs?:number;samples?:Array<{time:number;bids:Array<[number,number]>;asks:Array<[number,number]>}>};
      if(this.dead||abort.signal.aborted||this.value.market?.symbol!==symbol||!Array.isArray(body.samples))return;
      const levels=(rows:Array<[number,number]>)=>Object.freeze(rows.filter(([price,quantity])=>price>0&&quantity>0).map(([price,quantity])=>Object.freeze({price,quantity}))) as unknown as BookLevel[];
      this.value={...this.value,depthHistory:{symbol,step,from:padFrom,to:padTo,strideMs:Math.max(1000,Number(body.strideMs)||10_000),fetchedAt:this.now(),revision:(this.value.depthHistory?.revision??0)+1,
        samples:Object.freeze(body.samples.filter(sample=>Number.isFinite(sample.time)).map(sample=>Object.freeze({time:sample.time,bids:levels(sample.bids),asks:levels(sample.asks)})))}};
      this.emit();
    }catch{
      // History is optional (e.g. a static build without the local service).
      if(!abort.signal.aborted)this.historyBackoffUntil=this.now()+60_000;
    }finally{if(this.historyKey===key)this.historyKey='';}
  }
  private cancelDepthHistory(){clearTimeout(this.historyTimer);this.historyAbort?.abort();this.historyKey='';}
  destroy(){this.dead=true;this.generation++;this.query?.abort();this.cancelDepthHistory();this.stop();this.listeners.clear();}
  private stopTrades(){this.tradeEpoch++;const session=this.tradeSession;this.tradeSession=undefined;session?.disconnect();this.value={...this.value,trades:undefined};}
  private stop(){this.liveEpoch++;this.aggregateCache=undefined;this.offBook?.();this.offBook=undefined;this.lease?.release();this.lease=undefined;this.stopTrades();}
  private reconcile(){
    if(this.dead)return;const {market,settings,running,mode}=this.value;
    const demand=this.panelUsers>0||settings.heatmap||settings.profile;
    if(mode==='history'){this.stop();return;}
    if(!market||!demand||!running||market.chartHistorical||market.tickSize<=0){this.stop();this.value={...this.value,book:undefined,trades:undefined};return;}
    if(!this.lease){
      this.lease=this.acquire(market,{historySamples:900,historyLevels:1000,historyIntervalMs:4000,historyBinRatio:5e-4,bookLevels:6000,depthRangeRatio:DEPTH_RANGE_RATIO});
      const epoch=++this.liveEpoch;
      this.offBook=this.lease.subscribe(book=>{if(this.dead||epoch!==this.liveEpoch)return;this.value={...this.value,book};this.emit();});
    }
    const wantTrades=this.panelUsers>0&&settings.view==='dom'&&market.source==='binance'&&market.marketType==='usdm-perpetual';
    if(wantTrades&&!this.tradeSession){
      const epoch=++this.tradeEpoch;
      this.tradeSession=(this.options.createTrades??createTradeFlowSession)({symbol:market.symbol,tickSize:market.tickSize,timeframeMs:1000,priceStepTicks:1,maxTrades:10000,maxAgeMs:30000,maxPriceLevels:1000,maxFootprintBars:30,
        onUpdate:trades=>{if(this.dead||epoch!==this.tradeEpoch)return;this.value={...this.value,trades};this.emit(false);}});this.tradeSession.connect();
    }else if(!wantTrades&&this.tradeSession)this.stopTrades();
  }
  private publishArchiveBook(){
    const {archive,market}=this.value;if(!archive?.frame||!market)return;const frame=archive.frame;
    if(frame.datasetId!==archive.dataset.id||frame.coverage.dataset.id!==archive.dataset.id||frame.coverage.dataset.symbol!==market.symbol)throw Error('深度回放响应与所选市场或档案不一致');
    if(!Number.isFinite(frame.at)||frame.at>archive.cursor||frame.book.time!==undefined&&(!Number.isFinite(frame.book.time)||frame.book.time>archive.cursor))throw Error('深度回放包含游标之后的数据，已拒绝显示');
    const available=frame.book.status==='available';if(available&&!Number.isFinite(frame.book.time))throw Error('深度回放缺少真实事件时间');
    const stamp=frame.book.time??archive.cursor;
    const book:SharedBookSnapshot={identity:market,key:`archive:${archive.dataset.id}`,symbol:market.symbol,supported:true,status:available?'live':'error',
      bids:available?frame.book.bids:[],asks:available?frame.book.asks:[],updatedAt:stamp,lastReceivedAt:0,lastUpdateId:frame.book.lastUpdateId??null,
      revision:this.value.revision+1,segmentId:0,capturedAt:archive.cursor,history:[],changes:[],warning:frame.book.warning,
      coverage:{fromTime:available?stamp:null,throughTime:available?stamp:null,receivedFromTime:null,receivedThroughTime:null,segmentId:0,depthPerSide:1000},
      historyCoverage:{fromTime:null,throughTime:null,samples:0,intervalMs:1000,maxSamples:0,levelsPerSide:1000},
      changeCoverage:{fromTime:null,throughTime:null,truncated:false}};
    this.value={...this.value,book};
  }
  private emit(paint=true){if(this.dead)return;this.value={...this.value,revision:this.value.revision+1};if(paint)this.onPaint();for(const listener of this.listeners)try{listener(this.value);}catch{/* One UI cannot interrupt the shared data clock. */}}
}
