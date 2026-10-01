import {locale,translate as tr,translateCanonical as tc} from '../i18n';
import {drawOverlayDrawings,type OverlayDrawingHit} from '../render/overlay-drawings';
import {layoutOverlayShapes,drawOverlayShapes,OVERLAY_SHAPE_FONT,type OverlayShapeLayout} from '../render/overlay-shapes';
import type {OverlayShape,OverlayDrawing} from '../core/types';
import { ColumnStore } from '../core/datastore';
import { Pyramid } from '../core/pyramid';
import { LiveBarMotion } from '../interaction/live-bar-motion';
import { RangeMotion } from '../interaction/range-motion';
import { ViewportPhysics } from '../interaction/viewport-physics';
import {computeStudyPreview,type StudyPreviewData} from '../studies/preview';
import { Viewport } from '../core/viewport';
import { PaneLayout, type PaneGeometry } from '../core/pane-layout';
import { zoomPriceRange, type PriceRange } from '../core/price-scale';
import type { BarEvent, BarInput, ColumnName, ColumnView, DerivedSeries, FeedStatus, OverlayPlot, OverlayMarker, ParamValues } from '../core/types';
import type { BulkFeed } from '../feed/feed';
import type {BinanceContractMetadata} from '../market/binance-contracts';
import {marketConnectors,type MarketSourceId,type MarketTypeId} from '../market/connectors';
import {marketIdentity} from '../market/identity';
import { loadMarketSelection,saveMarketSelection } from './market-selection';
import { formatSeriesValue } from '../core/market-format';
import { IndicatorRegistry, registerBuiltins } from '../indicators/registry';
import { IndicatorEngine } from '../indicators/engine';
import type { IndicatorReq } from '../indicators/runtime';
import { RenderBackend } from '../render/backend';
import { sceneComposition } from '../render/composition-plan';
import {motionReduced} from '../ui/motion-preferences';
import {drawTradeMarkers,layoutTradeMarkers,type MarkerBounds,type MarkerCandidate,type TradeMarkerLayout} from '../render/trade-markers';
import { plotGuideSegments, drawAxesBase, drawCrosshair, fmtDateTime, fmtPrice, fmtTime, niceTicks, priceDigits, type AxesInput } from '../render/axes';
import { UP, DOWN } from '../render/gl';
import {DEFAULT_APPEARANCE,loadAppearance,normalizeAppearance,saveAppearance,contrastText,deriveOverlaySurface,readableSurfaceColor,type ChartAppearance} from './appearance';
import {paintPriceBar,priceBarUp,drawChartWatermark} from '../render/price-series';
import {applyUiTheme,canvasInkFor,DEFAULT_CANVAS_INK,type CanvasInk} from '../ui/theme';
import { DrawingEngine } from '../drawing/engine';
import { DRAWING_TOOL_MIME } from '../drawing/tool-transfer';
import { ToolRegistry } from '../drawing/registry';
import { registerDrawingBuiltins } from '../drawing/builtins';
import { indexForTime, timeForIndex } from '../drawing/coordinates';
import { emptyScene, layerOf, TIMEFRAMES, type DataReading, type IndicatorInstance, type SceneDocument, type SceneLayer } from '../scene/types';
import type { Anchor, Drawing, Pixel, Projection, MagnetStrength } from '../drawing/types';
import type {DatasetSnapshot} from '../history/types';
import {studySignalProvenance} from './signal-provenance';
import {drawPatterns,hitPattern,type PatternHit} from '../render/patterns';
import {drawIndicatorDivergences,divergenceLabel,type IndicatorDivergenceHit} from '../render/indicator-divergences';
import {IndicatorDivergenceProjectionCache} from '../indicators/divergence-projection';
import {ChartOrderFlow} from '../flow/chart-order-flow';
import {prepareDepthOverlay,drawDepthHeatmap,drawDepthProfile,drawDepthCrossSection,drawDepthCrossTable,depthHeatmapIntensity,type DepthCell,type DepthCrossSection,type DepthOverlay,type DepthProjection} from '../render/orderbook-overlay';
import {publicMarketRequest} from '../market/public-transport';
import {closedPricePrefix,closedPriceCount} from '../flow/price-replay';
import {deduplicatePatternDisplay} from '../patterns/display-dedup';
import {computeResonance,type ResonanceLayer,type ResonanceTag} from '../patterns/resonance';
import type {PatternCandidate,PatternCandidateRow,PatternMatch,PatternRow,PatternStudy} from '../patterns/types';
import {drawPatternCandidates,type CandidateHit} from '../render/pattern-candidates';
import {drawAnalysis,hitAnalysis,type AnalysisHit} from '../render/analysis';
import {analysisGuide,analysisStatus} from '../analysis/presentation';
import type {AnalysisObservation,AnalysisRow} from '../analysis/types';
import {AnalysisReviewStore,type ReviewDecision,type ReviewTarget} from '../analysis/reviews';
import {DEFAULT_STYLE} from '../drawing/types';
import {selectPatterns,patternHistoryMode,patternIntersectsWindow,type PatternTimeWindow} from '../patterns/selection';
import {neededPatternBars,prependPatternHistory,MAX_PATTERN_HISTORY_BARS} from '../patterns/history';
import {patternStageLabel,patternEventLabel} from '../patterns/presentation';

export interface DrawingSelection { id:string; x:number; y:number; bounds?:{left:number;right:number;top:number;bottom:number} }
export interface ChartContextTarget { paneId:string;drawingId:string|null;anchor:Anchor|null;region:'plot'|'price'|'time'|'separator';maximized:boolean }
interface MagnetPoint { field:'open'|'high'|'low'|'close';anchor:Anchor;pixel:Pixel }
export interface MagnetFeedback { index:number;strength:MagnetStrength;points:MagnetPoint[];target:MagnetPoint|null }

export interface StudyPaneLayout { id:string; top:number; height:number; width:number }

export interface ChartState {
  loading: boolean; error: string; warning: string; status: FeedStatus;
  source: MarketSourceId; symbol: string; interval: string;
  marketType?:MarketTypeId;contract?:BinanceContractMetadata;
  total: number; visible: number; rendered: number; factor: number;
  fps: number; renderMs: number; tickMs: number; backend: string; engine: string;
  following: boolean; paused: boolean; indicatorsPending: boolean;
  quote: BarInput | null; hover: boolean;
  latestQuote?:BarInput|null;
  /** Changes only when market data changes, never on paint/hover/overlay output. */
  marketRevision?:number;
  confirmedBarTime?:number|null;
  readings: DataReading[];
  smoothMotion: boolean;
  historicalSnapshot?:boolean;
  analysisReplay?:boolean;
  patternHistoryLoading?:boolean;
  patternHistoryError?:string;
}
export const initialState: ChartState = {
  loading: true, error: '', warning: '', status: 'reconnecting', source: 'mock', symbol: 'BTCUSDT', interval: '1m',
  total: 0, visible: 0, rendered: 0, factor: 1, fps: 0, renderMs: 0, tickMs: 0, backend: '—', engine: '—',
  following: true, paused: false, indicatorsPending: true, quote: null, hover: false, readings: [], smoothMotion: true,
};
export const intervals = TIMEFRAMES;
interface Pane { id: string; top: number; height: number; min: number; max: number; series: DerivedSeries[] }
interface ChartShapeCandidate extends OverlayShape {x:number;y:number;opacity:number;paneId:string;title:string;paintOrder:number}
interface ChartMarkerCandidate extends MarkerCandidate {paintOrder?:number;paneId:string;time:number;value:number;sourceLayerId:string;sourceName?:string;trigger?:string;signalKind?:'crossover'|'crossunder'}
type DragState =
  | { kind: 'drawing'; id: number }
  | { kind: 'pan'; id: number; x: number; y: number; paneId: string }
  | { kind: 'price'; id: number; y: number; paneId: string; range: PriceRange }
  | { kind: 'time'; id: number; x: number; from: number; to: number; anchor: number }
  | { kind: 'separator'; id: number; y: number; boundary: number; panes: PaneGeometry[] };
const AXIS_W = 88, AXIS_H = 26;
/** Live heatmap geometry rebuild cadence (the profile itself stays real-time). */
const LIVE_HEATMAP_REBUILD_MS = 250;
/** Compact depth quantity for the heatmap hover table (4–6 significant chars). */
function formatDepthQuantity(value:number):string {
  const abs=Math.abs(value);
  if(abs>=1e9)return `${(value/1e9).toFixed(2)}B`;if(abs>=1e6)return `${(value/1e6).toFixed(2)}M`;if(abs>=1e4)return `${(value/1e3).toFixed(1)}K`;
  return abs>=100?value.toFixed(1):value.toFixed(2);
}
const MAGNET_RADIUS=14;
const clamp = (v:number, min:number, max:number) => Math.min(max,Math.max(min,v));

export class ChartController {
  readonly orderFlow=new ChartOrderFlow(()=>{this.dirty=true;this.overlayDirty=true;this.queueOrderFlowPriceSync();this.syncProfileLead();});
  private orderFlowPrices:{id:string;dataset:DatasetSnapshot;cursor:number;returnInterval:string;store?:ColumnStore}|undefined;
  private orderFlowReturnInterval:string|undefined;
  private orderFlowPriceRequest:AbortController|undefined;
  private orderFlowPriceLoadingId:string|undefined;
  private orderFlowSyncQueued=false;
  private divergenceProjection=new IndicatorDivergenceProjectionCache();
  private divergenceRendering:{mode:'full'|'pixel-density';archive:number;projected:number;budgetPerSeries:number|null}={mode:'full',archive:0,projected:0,budgetPerSeries:null};
  /** Heatmap cells for hover hit-testing. Holding the overlay (not its cells)
   * keeps screen-cell projection lazy: pan frames never materialize them. */
  private depthCellSource:DepthOverlay|DepthCell[]=[];
  private get depthCells():DepthCell[]{const source=this.depthCellSource;return Array.isArray(source)?source:source.cells;}
  private set depthCells(cells:DepthCell[]){this.depthCellSource=cells;}
  private depthRepaintTimer?:ReturnType<typeof setTimeout>;
  private depthTable?:{table:DepthCrossSection;pointer:{x:number;y:number}};
  private depthOverlay?:DepthOverlay;
  private depthProjection?:DepthProjection;
  private viewportPhysics=new ViewportPhysics();
  getDepthOverlay():DepthOverlay|undefined {return this.depthOverlay;}
  /** Library preview: a study computed on this chart's most recent candles. */
  studyPreview(id:string,bars=120):StudyPreviewData|undefined {return computeStudyPreview(this.registry,this.store,id,bars);}
  private appearance:ChartAppearance=loadAppearance();
  getAppearance():ChartAppearance {return {...(this.appearance??DEFAULT_APPEARANCE)};}
  previewAppearance(value:ChartAppearance):void {
    this.appearance=normalizeAppearance(value);this.syncAppearanceSurface();
    this.dirty=true;this.overlayDirty=true;
  }
  restoreAppearance(value:ChartAppearance):void {this.previewAppearance(value);}
  commitAppearance(value:ChartAppearance):boolean {this.previewAppearance(value);return saveAppearance(this.appearance);}
  private canvasInk:CanvasInk=DEFAULT_CANVAS_INK;
  private syncAppearanceSurface():void {
    applyUiTheme(this.appearance);this.canvasInk=canvasInkFor(this.appearance);
    const a=this.appearance,root=this.host.closest<HTMLElement>('.chart-column')??this.host.closest<HTMLElement>('.chart-area')??this.host;
    const area=this.host.closest<HTMLElement>('.chart-area');
    const ink=contrastText(a.background),hover=ink==='#ffffff'?'#ffffff14':'#1218200d',surface=deriveOverlaySurface(a);
    const vars:Record<string,string>={
      '--chart-background':a.background,'--chart-text':a.textColor,'--bg':a.background,'--bg-panel':a.background,'--bg-hover':hover,'--text':ink,'--text-dim':a.textColor,'--line':a.separatorColor,'--accent':readableSurfaceColor(a.lineColor,a.background,3.8),'--up':a.upColor,'--down':a.downColor,
      '--chart-glass-bg':surface.glassBg,'--chart-glass-bg-hover':surface.glassBgHover,'--chart-glass-menu-bg':surface.glassMenuBg,'--chart-glass-border':surface.glassBorder,'--chart-glass-border-strong':surface.glassBorderStrong,
      '--chart-glass-text':surface.glassText,'--chart-glass-text-muted':surface.glassTextMuted,'--chart-glass-badge-bg':surface.glassBadgeBg,'--chart-glass-shadow':surface.glassShadow,'--chart-glass-surface-solid':surface.surfaceSolid,'--chart-glass-blur':'blur(10px) saturate(135%)',
    };
    for(const target of area&&area!==root?[root,area]:[root]){
      for(const [key,value] of Object.entries(vars))target.style.setProperty(key,value);
      target.dataset.chartTheme=a.preset;
      target.dataset.chartTone=surface.isLight?'light':'dark';
    }
  }
  private replaySource?:DatasetSnapshot;
  private replayCursor=0;
  private analysisReplay=false;
  onPatternSelection:()=>void=()=>{};
  selectedPatternKey:string|null=null;
  selectedCandidateKey:string|null=null;
  selectedAnalysisKey:string|null=null;
  private analysisHits:AnalysisHit[]=[];
  private reviews?:AnalysisReviewStore;
  private reviewStore(){return this.reviews??=new AnalysisReviewStore();}
  private reviewMarket(){return `${marketIdentity(this.state)}:${this.state.interval}`;}
  reviewTarget(kind:'pattern'|'analysis',instanceId:string,sourceId:string):ReviewTarget {
    const series=this.engine.derived.filter(s=>s.indicatorId===instanceId);
    const entry=kind==='pattern'?series.flatMap(s=>s.patterns??[]).find(o=>o.id===sourceId):series.flatMap(s=>s.observations??[]).find(o=>o.id===sourceId);
    return {kind,instanceId,sourceId,market:this.reviewMarket(),name:entry?.name??sourceId,ruleVersion:entry&&'ruleVersion'in entry?String(entry.ruleVersion):'pattern-v1'};
  }
  getObservationReview(kind:'pattern'|'analysis',instanceId:string,sourceId:string){return this.reviewStore().get({kind,instanceId,sourceId,market:this.reviewMarket(),name:sourceId});}
  setObservationReview(kind:'pattern'|'analysis',instanceId:string,sourceId:string,decision:ReviewDecision,note=''){
    if(this.layerStatus(instanceId).locked)throw Error('请先解锁该分析图层');
    this.reviewStore().set(this.reviewTarget(kind,instanceId,sourceId),decision,note);this.dataRevision++;this.dirty=true;this.publish();return this.reviewStore().error;
  }
  restoreObservation(kind:'pattern'|'analysis',instanceId:string,sourceId:string){if(this.layerStatus(instanceId).locked)throw Error('请先解锁该分析图层');this.reviewStore().remove(this.reviewTarget(kind,instanceId,sourceId));this.dataRevision++;this.dirty=true;this.publish();return this.reviewStore().error;}
  analysisPersistenceWarning(){return [this.drawing.state.error,this.reviewStore().error].filter(Boolean).join('；');}
  listAnalysisReviews(){return this.reviewStore().list(this.reviewMarket());}
  exportAnalysisReviews(){return this.reviewStore().export();}
  importAnalysisReviews(raw:string){this.reviewStore().import(raw);this.dataRevision++;this.dirty=true;this.publish();return this.reviewStore().error;}
  private manuallyHidden(kind:'pattern'|'analysis',instanceId:string,sourceId:string){const value=this.getObservationReview(kind,instanceId,sourceId);return value?.decision==='rejected'||value?.decision==='manual'&&!!value.drawingIds?.some(id=>this.drawing.document.drawings.some(drawing=>drawing.id===id));}
  copyObservationToDrawing(kind:'pattern'|'analysis',instanceId:string,sourceId:string):string[] {
    if(this.layerStatus(instanceId).locked||this.drawing.allLocked)throw Error('请先解锁绘图和该分析图层');
    const record=kind==='pattern'?this.getPatternRows().find(r=>r.instanceId===instanceId&&r.pattern.id===sourceId)?.pattern:this.getAnalysisRows().find(r=>r.instanceId===instanceId&&r.observation.id===sourceId)?.observation;
    if(!record)throw Error('此结构已不在当前数据范围');
    const groupId=crypto.randomUUID(),drawings:Drawing[]=[],color=record.direction==='bullish'?'#5fbca7':record.direction==='bearish'?'#db8995':'#89aed1';
    const add=(toolId:string,points:{time:number;value:number}[],labels='')=>{drawings.push({id:crypto.randomUUID(),toolId,paneId:'main',points:points.map(p=>({...p})),style:{...DEFAULT_STYLE,color,width:1.5,fillOpacity:.035},props:{labels,text:record.name,sourceId:sourceId.slice(0,1800),sourceName:record.name,manual:true},locked:false,hidden:false});};
    if(record.points.length>1)add('analysis-path',record.points,record.points.map(p=>p.label).join(','));
    if(kind==='analysis'){
      const o=record as AnalysisObservation;if(o.zone)add('rectangle',[{time:o.zone.fromTime,value:o.zone.high},{time:o.zone.toTime,value:o.zone.low}]);
      for(const line of o.lines??[])if(line.points.length>=2)add(line.points.length===2?'trend-line':'analysis-path',line.points);
    }else for(const guide of (record as PatternMatch).guides??[])guide.path&&guide.path.length>2?add('analysis-path',guide.path):add('trend-line',guide.points);
    if(!drawings.length)add('text',[record.points[0]??{time:'time'in record?record.time:record.confirmedAt,value:0}]);
    this.drawing.transact(doc=>({...doc,drawings:[...doc.drawings,...drawings],layers:[...doc.layers,layerOf(groupId,'group',`人工校正 · ${record.name}`,'main'),...drawings.map(d=>layerOf(d.id,'drawing',`人工 · ${record.name}`,'main',{parentId:groupId}))]}));
    if(!this.drawing.document.layers.some(layer=>layer.id===groupId))throw Error(this.drawing.state.error||'手绘副本保存失败，原标注仍保留');
    const ids=[groupId,...drawings.map(d=>d.id)];this.reviewStore().set(this.reviewTarget(kind,instanceId,sourceId),'manual','已复制为可独立编辑的手绘；自动原始证据不变。',ids);
    this.drawing.selectLayers([drawings[0].id]);this.dataRevision++;this.dirty=true;this.publish();return ids;
  }
  private patternHits:PatternHit[]=[];
  private divergenceHits:IndicatorDivergenceHit[]=[];
  private selectedDivergenceKey:string|null=null;
  private candidateHits:CandidateHit[]=[];
  private patternSelections=new Map<string,{arrays:(PatternMatch[]|undefined)[];key:string;config:string;window?:PatternTimeWindow;ids:Set<string>}>();
  private patternHistoryExhausted='';
  private patternWindow:PatternTimeWindow|undefined;
  private patternWindowTimer:ReturnType<typeof setTimeout>|undefined;
  private patternWindowQueued='';
  private patternWindowPending=false;
  onDrawingSelection:(selection:DrawingSelection|null)=>void=()=>{};
  onOpenProperties:(ids:string[])=>void=()=>{};
  onPaneLayout:(panes:StudyPaneLayout[])=>void=()=>{};
  interactiveStudyLabels=false;
  readonly registry = new IndicatorRegistry();
  readonly drawing: DrawingEngine;
  readonly viewport = new Viewport(1,{from:0,to:160,plotW:1,plotH:1});
  private store = new ColumnStore();
  private pyramid = new Pyramid(this.store);
  private engine: IndicatorEngine;
  private renderer: RenderBackend;
  private ctx: CanvasRenderingContext2D;
  private feed: BulkFeed | null = null;
  private state: ChartState = {...initialState};
  private reqs: IndicatorReq[] = [];
  private sceneLookupDocument:SceneDocument|null=null;
  private layerLookup=new Map<string,SceneDocument['layers'][number]>();
  private instanceLookup=new Map<string,IndicatorInstance>();
  private calculationSignature='';
  private unsubscribeScene:()=>void=()=>{};
  private overlays: OverlayPlot[] = [];
  private externalOverlays:OverlayPlot[]=[];
  private overlayGroups=new Map<string,OverlayPlot[]>();
  private historicalSnapshot=false;
  private marketRevision=0;
  private lastBarConfirmed=false;
  private markerIndices = new Map<OverlayPlot, number[]>();
  private studyMarkers=new Map<string,{values:Float64Array;length:number;indices:number[]}>();
  private emptyPaneRanges=new Map<string,PriceRange>();
  private fitEmptyPanes=new Set<string>();
  private width = 1; private height = 1; private dpr = 1;
  private panes: Pane[] = [];
  private axes: AxesInput | null = null;
  private pointer: {x:number;y:number} | null = null;
  private magnetPointer:Pixel|null=null;
  private magnetGuide:MagnetFeedback|null=null;
  private drag: DragState | null = null;
  private paneLayout = new PaneLayout();
  private manualScales = new Map<string, PriceRange>();
  private maximizedPane: string | null = null;
  private paneControls: HTMLDivElement;
  private markerLayouts:TradeMarkerLayout<ChartMarkerCandidate>[]=[];
  private shapeLayouts:OverlayShapeLayout<ChartShapeCandidate>[]=[];
  private nextHitOrder=0;
  private objectHits:Array<OverlayDrawingHit&{title:string;paintOrder:number}>=[];
  private markerTooltip?:HTMLDivElement;
  private markerTooltipKey='';
  private markerTooltipSize={width:260,height:80};
  private controlsKey = '';
  private controlsLayoutKey='';
  private dirty = true; private overlayDirty = true;
  private resizePending = true;
  private raf = 0; private dead = false; private generation = 0;
  private observer: ResizeObserver;
  private events = new AbortController();
  private lastPublish = 0; private fpsStart = 0; private fpsFrames = 0;
  private frameTimes: number[] = []; private tickTimes: number[] = [];
  private fullFrameTimes:number[]=[];private inputLatencies:number[]=[];private presentedFrames=0;
  private pendingPointer:(()=>void)|null=null;
  private inputStarted:number|null=null;
  private axisCanvas:HTMLCanvasElement;
  private axisContext:CanvasRenderingContext2D;
  private liveBarMotion=new LiveBarMotion();
  private liveFollowing=false;
  private viewportMotion=new RangeMotion({min:0,max:160});
  private autoRanges=new Map<string,RangeMotion>();
  private rangeMoving=false;
  private motionQuery=window.matchMedia('(prefers-reduced-motion: reduce)');
  private motionPreference=true;
  private readingKey='';private dataRevision=0;
  private unsubscribeLocale:()=>void=()=>{};
  private requestsCache:IndicatorReq[]=[];
  private requestsKey='';
  private syncedDocument:SceneDocument|null=null;
  private syncedInterval='';

  constructor(private host: HTMLElement, gpu: HTMLCanvasElement, cpu: HTMLCanvasElement,
    private overlay: HTMLCanvasElement, private onState: (state:ChartState)=>void, tools?: ToolRegistry) {
    this.syncAppearanceSurface();
    // Canvas text is measured and drawn with the loaded UI faces once available.
    void document.fonts?.ready.then(()=>{if(!this.dead){this.dirty=true;this.overlayDirty=true;}});
    this.paneControls = document.createElement('div');
    this.paneControls.className = 'pane-controls';
    this.host.append(this.paneControls);
    this.markerTooltip=document.createElement('div');this.markerTooltip.className='trade-marker-tooltip';this.markerTooltip.setAttribute('role','tooltip');
    this.markerTooltip.style.cssText='position:absolute;left:0;top:0;display:none;pointer-events:none;z-index:7;max-width:290px;padding:9px 12px;border:1px solid var(--chart-glass-border-strong, #456078);border-radius:4px;background:var(--chart-glass-menu-bg, #17212ff5);color:var(--chart-glass-text, #d9e6f5);box-shadow:var(--chart-glass-shadow, 0 5px 16px #0006);backdrop-filter:var(--chart-glass-blur, blur(10px));-webkit-backdrop-filter:var(--chart-glass-blur, blur(10px));font:11px/1.7 ui-monospace,"PingFang SC",sans-serif;white-space:normal';
    this.host.append(this.markerTooltip);
    registerBuiltins(this.registry);
    this.reqs = ['ma','vol','macd'].map(id=>({id,params:this.registry.defaults(id)}));
    this.ctx = overlay.getContext('2d')!;
    this.axisCanvas=document.createElement('canvas');this.axisCanvas.setAttribute('aria-hidden','true');this.axisCanvas.className='chart-axes';
    this.host.insertBefore(this.axisCanvas,overlay);this.axisContext=this.axisCanvas.getContext('2d')!;
    const motionChange=()=>{this.state.smoothMotion=this.motionPreference&&!motionReduced();if(!this.state.smoothMotion)this.finishMotion();this.publish();};
    this.state.smoothMotion=!motionReduced();
    window.addEventListener('ui-motion-change',motionChange,{signal:this.events.signal});
    this.motionQuery.addEventListener('change',motionChange,{signal:this.events.signal});
    this.renderer = new RenderBackend(gpu,cpu,()=>{
      this.state.warning = '图形上下文中断，已切换 Canvas2D。可点击重建。'; this.dirty=true; this.publish();
    },()=>{ this.state.warning='';this.dirty=true;this.publish(); });
    const toolRegistry=tools??new ToolRegistry();
    if(!tools)registerDrawingBuiltins(toolRegistry);
    this.drawing=new DrawingEngine(toolRegistry,{
      paneAt:pixel=>this.panes.find(p=>pixel.x>=0&&pixel.x<this.viewport.plotW&&pixel.y>=p.top&&pixel.y<p.top+p.height)?.id??null,
      projection:id=>this.drawingProjection(id),
      anchorAt:(pixel,id,snap,strength)=>this.drawingAnchor(pixel,id,snap,strength),
      zoomTo:drawing=>this.zoomToDrawing(drawing),
    },kind=>{if(kind!=='overlay')this.dirty=true;this.overlayDirty=true;},()=>this.defaultScene());
    this.engine = new IndicatorEngine(this.registry);
    this.engine.onUpdate = range=>this.onIndicatorUpdate(range);
    this.engine.onFallback = ()=>{this.state.warning='指标 Worker 不可用，已切换主线程增量计算。'; this.publish();};
    this.unsubscribeScene=this.drawing.subscribe(()=>{this.syncScene();this.refreshMagnetFeedback();});
    this.observer = new ResizeObserver(()=>this.scheduleResize()); this.observer.observe(host);
    this.bindEvents(); this.resize();
    this.unsubscribeLocale=locale.subscribe(()=>this.refreshLocale());
    this.raf=requestAnimationFrame(t=>this.frame(t));
    const saved=loadMarketSelection();void this.setMarket(saved.source,saved.symbol,saved.interval);
  }

  /** Redraw presentation without touching data, indicators, drawings or viewport. */
  private refreshLocale():void {
    this.markerTooltipKey='';this.controlsLayoutKey='';this.readingKey='';
    this.projectionCache.clear();
    this.dirty=true;this.overlayDirty=true;this.publish();
  }

  get requests():IndicatorReq[] {
    const requests=this.reqs.filter(r=>this.layerStatus(r.instanceId??r.id).visible),key=JSON.stringify(requests);
    if(key!==this.requestsKey){this.requestsKey=key;this.requestsCache=requests.map(r=>({...r,params:{...r.params}}));}
    return this.requestsCache;
  }

  async setMarket(source: MarketSourceId, symbol: string, interval: string): Promise<void> {
    const connector=marketConnectors.get(source);
    const canonical=connector?.normalizeSymbol(symbol)??null;
    if (!Object.hasOwn(intervals,interval) || !connector || !canonical) return;
    this.replaySource=undefined;this.replayCursor=0;this.analysisReplay=false;
    symbol=canonical;
    clearTimeout(this.patternWindowTimer);this.patternWindowTimer=undefined;this.patternWindow=undefined;this.patternWindowQueued='';this.patternWindowPending=false;
    this.orderFlowPriceRequest?.abort();this.orderFlowPrices=undefined;this.orderFlowReturnInterval=undefined;this.orderFlowPriceLoadingId=undefined;this.orderFlow?.configure({source:connector.id,symbol,marketType:connector.marketType,tickSize:0});this.divergenceProjection?.clear();this.depthCells=[];this.depthOverlay=undefined;this.depthProjection=undefined;
    this.historicalSnapshot=false;this.lastBarConfirmed=false;this.marketRevision++;this.externalOverlays=[];this.overlayGroups?.clear();
    saveMarketSelection({source:connector.id,symbol,interval});
    this.studyMarkers.clear();this.emptyPaneRanges.clear();this.fitEmptyPanes.clear();
    this.liveBarMotion.clear();this.cancelViewportMotion();this.viewportPhysics?.clearEnvelopes();this.autoRanges.clear();this.pendingPointer=null;this.dataRevision++;
    const generation=++this.generation;
    this.selectedPatternKey=null;this.selectedCandidateKey=null;this.selectedAnalysisKey=null;this.selectedDivergenceKey=null;this.divergenceHits=[];this.patternHits=[];this.candidateHits=[];this.analysisHits=[];
    this.feed?.disconnect(); this.engine.destroy(); this.engine.derived=[];
    this.frameTimes=[];this.tickTimes=[];
    this.state={...this.state,tickMs:0,renderMs:0,source:connector.id,symbol,interval,marketType:connector.marketType,contract:undefined,loading:true,error:'',warning:'',paused:false,following:true,status:'reconnecting',quote:null,readings:[],indicatorsPending:true,historicalSnapshot:false,analysisReplay:false,patternHistoryLoading:false,patternHistoryError:''};
    this.patternHistoryExhausted='';
    this.calculationSignature='';this.drawing.setInterval(interval);this.drawing.setMarket(marketIdentity({source:connector.id,symbol,marketType:this.state.marketType}));
    this.store=new ColumnStore(); this.pyramid=new Pyramid(this.store);
    this.cancelDrag(); this.manualScales.clear();
    this.pointer=null;this.magnetPointer=null;this.magnetGuide=null; this.axes=null; this.panes=[]; this.syncPaneControls(); this.overlays=[]; this.markerIndices.clear(); this.dirty=true; this.publish();
    const feed:BulkFeed=connector.createFeed({symbol,interval,intervalMs:intervals[interval]});
    this.feed=feed;
    feed.onStatus(status=>{if(generation===this.generation){this.state.status=status;this.publish();}});
    feed.onBar(bar=>{if(generation===this.generation)this.acceptBar(bar);});
    try {
      // Let loading state paint before the one-time million-row generation.
      await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));
      if(this.dead || generation!==this.generation)return;
      let store:ColumnStore;
      if(feed.loadStore) store=await feed.loadStore();
      else {const bars=await feed.loadBulk();store=new ColumnStore(bars.length+65536);for(const b of bars)store.appendBar(b);}
      if(this.dead || generation!==this.generation){feed.disconnect();return;}
      if(!store.length)throw new Error('没有收到行情数据');
      this.store=store; this.pyramid=new Pyramid(store);this.viewport.setTotal(store.length);this.state.contract=connector.extractContract?.(feed)??undefined;
      this.refreshOverlays();
      this.state.loading=false;this.liveBarMotion.snap(this.barAt(store.length-1));this.followLatest();
      this.engine.init(store,this.workerRequests(),this.lastBarConfirmed);
      await feed.connect();
      if(this.dead || generation!==this.generation){feed.disconnect();return;}
      this.dirty=true;this.publish();
      void this.loadPatternHistory();
    } catch(e) {
      if(this.dead || generation!==this.generation)return;
      feed.disconnect();this.state.loading=false;this.state.status='error';
      this.state.error=`${connector.errorPrefix}：${e instanceof Error?e.message:String(e)}`;
      this.dirty=true;this.publish();
    }
  }

  reconnect(): void { void this.setMarket(this.state.source,this.state.symbol,this.state.interval); }
  togglePause(): void {
    if(this.historicalSnapshot){this.followLatest();return;}
    const connector=marketConnectors.get(this.state.source);
    if(!connector?.capabilities.supportsPause||this.state.loading)return;
    this.state.paused=!this.state.paused;this.orderFlow?.pause(this.state.paused);
    if(this.state.paused)this.feed?.disconnect();else void this.feed?.connect();
    this.publish();
  }
  private defaultScene():SceneDocument {
    const doc=emptyScene();
    doc.layers.push(layerOf('series:candles','series','K 线','main'));
    for(const id of ['ma','vol','macd']){
      const paneId=id==='ma'?'main':id==='vol'?'volume':'macd';
      if(id==='vol')doc.layers.push(layerOf('series:volume','series','成交量柱','volume'));
      doc.indicators.push({id,instanceId:id,params:this.registry.defaults(id),timeframe:'chart',hiddenPlots:[]});
      doc.layers.push(layerOf(id,'indicator',this.registry.get(id).name,paneId));
    }
    return doc;
  }
  getPatternRows():PatternRow[] {
    if(this.engine.pending&&!this.patternWindowPending||this.state.loading)return [];
    const doc=this.drawing.document;
    return this.engine.derived.flatMap(series=>{
      if(!series.patterns||!series.indicatorId)return [];
      const instance=doc.indicators.find(i=>i.instanceId===series.indicatorId),layer=doc.layers.find(l=>l.id===series.indicatorId);
      if(!instance||!layer)return [];
      const visible=this.layerStatus(layer.id).visible&&!instance.hiddenPlots.includes(series.plotIndex??0);
      const ids=this.patternDisplayIds(instance);
      return series.patterns.filter(pattern=>ids.has(pattern.id)).map(pattern=>({instanceId:instance.instanceId,layerName:this.layerDisplayName(layer),timeframe:instance.timeframe==='chart'?this.state.interval:instance.timeframe,visible:visible&&!this.manuallyHidden('pattern',instance.instanceId,pattern.id),color:instance.plotStyles?.[String(series.plotIndex??0)]?.color??series.color,pattern}));
    }).sort((a,b)=>b.pattern.confirmedAt-a.pattern.confirmedAt||a.pattern.id.localeCompare(b.pattern.id));
  }
  private resonanceMemo?:{inputs:readonly (readonly PatternMatch[])[];key:string;value:Map<string,ResonanceTag[]>};
  /** Harmonic resonance (other timeframes, structures at the end of the last leg) over the FULL match pool of every
   * pattern layer of the current symbol, hidden layers included: it is analysis, not drawing. Read-only; the join is
   * memoised on the identity of the pools, so a price tick that leaves them unchanged costs a few comparisons. */
  getPatternResonance():Map<string,ResonanceTag[]> {
    if(this.engine.pending&&!this.patternWindowPending||this.state.loading)return new Map();
    const doc=this.drawing.document,pools=new Map<string,{layer:Omit<ResonanceLayer,'matches'>;parts:PatternMatch[][]}>();
    for(const series of this.engine.derived){
      if(!series.patterns||!series.indicatorId)continue;
      const instance=doc.indicators.find(i=>i.instanceId===series.indicatorId);if(!instance)continue;
      const label=instance.timeframe==='chart'?this.state.interval:instance.timeframe,ms=TIMEFRAMES[label];
      if(!(ms>0))continue;
      // A layer publishes its bullish and bearish matches as two series; they are one pool.
      const entry=pools.get(instance.instanceId)??{layer:{instanceId:instance.instanceId,definitionId:instance.id,timeframeMs:ms,timeframeLabel:label},parts:[]};
      entry.parts.push(series.patterns);pools.set(instance.instanceId,entry);
    }
    const inputs=[...pools.values()].flatMap(entry=>entry.parts),key=[...pools.values()].map(entry=>`${entry.layer.instanceId}:${entry.layer.timeframeMs}:${entry.parts.length}`).join('|');
    const memo=this.resonanceMemo;
    if(memo&&memo.key===key&&memo.inputs.length===inputs.length&&memo.inputs.every((pool,i)=>pool===inputs[i]))return memo.value;
    const value=computeResonance([...pools.values()].map(entry=>({...entry.layer,matches:entry.parts.flat()})));
    this.resonanceMemo={inputs,key,value};
    return value;
  }
  private visibleObservations(instance:IndicatorInstance,observations:readonly AnalysisObservation[]):AnalysisObservation[]{
    const window=this.visiblePatternWindow(),limit=Math.max(5,Math.min(300,Number(instance.params.maxObservations??60)));
    return observations.filter(o=>instance.params.showInvalidated===true||o.state!=='invalidated').filter(o=>{
      if(!window)return true;const from=Math.min(o.time,o.zone?.fromTime??Infinity,...o.points.map(p=>p.time)),to=Math.max(o.availableAt,o.zone?.toTime??-Infinity,...o.events.map(e=>e.time));
      return to>=window.fromTime&&from<=window.toTime;
    }).sort((a,b)=>b.availableAt-a.availableAt).slice(0,limit);
  }
  getAnalysisRows():AnalysisRow[]{
    if(this.engine.pending&&!this.patternWindowPending||this.state.loading)return [];
    return this.engine.derived.flatMap(series=>{
      if(!series.observations||!series.indicatorId)return [];
      const instance=this.drawing.document.indicators.find(i=>i.instanceId===series.indicatorId),layer=this.drawing.document.layers.find(l=>l.id===series.indicatorId);if(!instance||!layer)return [];
      const visible=this.layerStatus(layer.id).visible&&!instance.hiddenPlots.includes(series.plotIndex??0);
      return this.visibleObservations(instance,series.observations).map(observation=>({instanceId:instance.instanceId,layerName:this.layerDisplayName(layer),timeframe:instance.timeframe==='chart'?this.state.interval:instance.timeframe,visible:visible&&!this.manuallyHidden('analysis',instance.instanceId,observation.id),observation}));
    }).sort((a,b)=>b.observation.availableAt-a.observation.availableAt);
  }
  getAnalysisStudies(){
    const rows=this.getAnalysisRows();return this.drawing.document.indicators.filter(i=>this.registry.list().some(d=>d.id===i.id&&(d.category==='analysis'||d.analysisFamily==='flow'))).map(instance=>{
      const lines=this.engine.derived.filter(s=>s.indicatorId===instance.instanceId),status=this.layerStatus(instance.instanceId);
      return {instanceId:instance.instanceId,definitionId:instance.id,name:this.studyDisplayName(instance.instanceId),timeframe:instance.timeframe==='chart'?this.state.interval:instance.timeframe,visible:status.visible,locked:status.locked,pending:this.state.loading||(this.engine.pending&&!this.patternWindowPending),count:rows.filter(r=>r.instanceId===instance.instanceId).length,warning:[...new Set(lines.flatMap(l=>l.dataWarning?[l.dataWarning]:[]))].join(' ')||undefined,scan:lines.find(l=>l.patternScan)?.patternScan};
    });
  }
  selectAnalysis(instanceId:string,id:string,focus=true):void {
    const row=this.getAnalysisRows().find(r=>r.instanceId===instanceId&&r.observation.id===id);if(!row)return;
    this.selectedAnalysisKey=`${instanceId}:${id}`;this.selectedPatternKey=null;this.selectedCandidateKey=null;this.drawing.selectLayers([instanceId]);
    if(focus){
      const o=row.observation,anchors=[...o.points,...(o.lines??[]).filter(line=>line.role!=='projection').flatMap(line=>line.points)].map(point=>point.time).filter(Number.isFinite);
      this.focusTimeRange(Math.min(o.time,o.zone?.fromTime??Infinity,...anchors),Math.max(o.availableAt,o.zone?.toTime??-Infinity,...anchors,...o.events.map(e=>e.availableAt)));
      this.autoRanges.clear();this.rangeMoving=false;
    }
    this.dirty=true;this.overlayDirty=true;this.publish();
  }
  private visiblePatternCandidates(instance:IndicatorInstance,candidates:readonly PatternCandidate[]):PatternCandidate[]{
    if(instance.params.showCandidates===false)return [];
    const window=this.visiblePatternWindow();if(!window)return [...candidates];
    return candidates.filter(c=>{
      const start=c.points[0]?.time??c.observedAt,end=Math.max(c.observedAt,...c.points.map(p=>p.time),...(c.guides??[]).flatMap(g=>g.points.map(p=>p.time)));
      return end>=window.fromTime&&start<=window.toTime;
    });
  }
  getPatternCandidates():PatternCandidateRow[] {
    if(this.engine.pending&&!this.patternWindowPending||this.state.loading)return [];
    return this.engine.derived.flatMap(series=>{
      if(!series.candidates||!series.indicatorId)return [];
      const instance=this.drawing.document.indicators.find(i=>i.instanceId===series.indicatorId),layer=this.drawing.document.layers.find(l=>l.id===series.indicatorId);
      if(!instance||!layer)return [];
      const visible=this.layerStatus(layer.id).visible&&instance.params.showCandidates!==false&&!instance.hiddenPlots.includes(series.plotIndex??0);
      return series.candidates.map(candidate=>({instanceId:instance.instanceId,layerName:this.layerDisplayName(layer),timeframe:instance.timeframe==='chart'?this.state.interval:instance.timeframe,visible,candidate}));
    }).sort((a,b)=>b.candidate.observedAt-a.candidate.observedAt||a.candidate.id.localeCompare(b.candidate.id));
  }
  selectPatternCandidate(instanceId:string,candidateId:string,focus=true):void {
    const row=this.getPatternCandidates().find(r=>r.instanceId===instanceId&&r.candidate.id===candidateId);if(!row)return;
    this.selectedCandidateKey=`${instanceId}:${candidateId}`;this.selectedPatternKey=null;this.selectedAnalysisKey=null;this.drawing.selectLayers([instanceId]);
    if(focus){this.focusTimeRange(row.candidate.points[0].time,row.candidate.observedAt);this.autoRanges.clear();this.rangeMoving=false;}
    this.dirty=true;this.overlayDirty=true;this.publish();
  }
  /** Read-only backfill fulfils the requested scan depth without remounting the
   * chart, changing markets, or pausing websocket updates. */
  async loadPatternHistory():Promise<void> {
    const feed=this.feed,connector=marketConnectors.get(this.state.source);
    if(this.dead||this.state.loading||this.historicalSnapshot||!connector?.capabilities.supportsHistoricalBackfill||this.state.patternHistoryLoading||!feed?.loadBefore||!this.store.length)return;
    const baseline=neededPatternBars(this.drawing.document.indicators,this.registry,this.state.interval);
    const start=this.patternWindow?.fromTime;
    const viewNeeded=baseline&&start!==undefined?Math.ceil((this.store.timeAt(this.store.length-1)-start)/intervals[this.state.interval])+baseline:0;
    const wanted=Math.min(MAX_PATTERN_HISTORY_BARS,Math.max(baseline,viewNeeded));
    const first=this.store.timeAt(0),key=`${this.state.symbol}:${this.state.interval}:${first}`;
    if(wanted<=this.store.length||this.patternHistoryExhausted===key)return;
    const generation=this.generation,store=this.store,requested=wanted-store.length;
    this.state.patternHistoryLoading=true;this.state.patternHistoryError='';this.publish();
    let expanded=false;
    try{
      const older=await feed.loadBefore(first,requested);
      if(this.dead||generation!==this.generation||this.store!==store||this.feed!==feed)return;
      if(older.length<requested)this.patternHistoryExhausted=`${this.state.symbol}:${this.state.interval}:${older[0]?.time??first}`;
      const shift=prependPatternHistory(store,older,this.state.interval);
      if(shift){
        this.cancelDrag();this.cancelViewportMotion();this.viewport.setTotal(store.length);this.viewport.from+=shift;this.viewport.to+=shift;
        this.pyramid=new Pyramid(store);this.projectionCache.clear();this.markerIndices.clear();this.studyMarkers.clear();
        const retained=this.engine.derived.map(series=>{
          const shiftArray=(arr?:Float64Array)=>{if(!arr)return undefined;const next=new Float64Array(store.capacity).fill(NaN);next.set(arr.subarray(0,Math.max(0,Math.min(arr.length,store.length-shift))),shift);return next;};
          return {...series,values:shiftArray(series.values)!,markerOffsets:shiftArray(series.markerOffsets),markerValues:shiftArray(series.markerValues)};
        });
        this.refreshOverlays();this.engine.init(store,this.workerRequests(),this.lastBarConfirmed);
        if(retained.length){this.engine.derived=retained;this.patternWindowPending=true;}
        this.state.indicatorsPending=true;this.marketRevision++;this.dataRevision++;this.dirty=true;this.overlayDirty=true;expanded=true;
      }
    }catch(error){if(!this.dead&&generation===this.generation)this.state.patternHistoryError=`补充历史失败：${error instanceof Error?error.message:String(error)}；当前行情继续更新。`;}
    finally{
      if(!this.dead&&generation===this.generation){this.state.patternHistoryLoading=false;this.publish();if(expanded)queueMicrotask(()=>{void this.loadPatternHistory();});}
    }
  }
  private patternDisplayIds(instance:IndicatorInstance):Set<string> {
    const cache=this.patternSelections??=new Map();if(cache.size>100)cache.clear();
    const arrays=this.engine.derived.filter(d=>d.indicatorId===instance.instanceId).map(d=>d.patterns);
    const window=this.visiblePatternWindow();
    const config=`${this.state.source}:${this.state.symbol}:${this.state.interval}:${patternHistoryMode(instance.params)}:${instance.params.maxPatterns??50}:${instance.params.showTargets===true}`;
    const selectedId=this.selectedPatternKey?.startsWith(`${instance.instanceId}:`)?this.selectedPatternKey.slice(instance.instanceId.length+1):undefined;
    const key=`${config}:${window?.fromTime}:${window?.toTime}:${selectedId??''}`,previous=cache.get(instance.instanceId);
    const sameFacts=previous&&arrays.length===previous.arrays.length&&arrays.every((array,i)=>array===previous.arrays[i]);
    if(previous?.key===key&&sameFacts)return previous.ids;
    const all=deduplicatePatternDisplay(arrays.flatMap(array=>array??[]),selectedId);
    const selected=selectPatterns(all,instance.params,window);
    let ids=new Set(selected.map(p=>p.id));
    // A tighter viewport must not reshuffle the drawing budget and evict a
    // still-visible shape. Retention is priority only: every ID must still be
    // present and eligible in the newly accepted evidence, never old geometry.
    if(previous?.config===config&&window&&previous.window&&window.fromTime>=previous.window.fromTime&&window.toTime<=previous.window.toTime){
      const retained=all.filter(p=>previous.ids.has(p.id)&&(patternHistoryMode(instance.params)==='all'||p.status!=='invalidated')&&patternIntersectsWindow(p,window,instance.params.showTargets===true));
      ids=new Set(retained.map(p=>p.id));
      const remaining=selected.length-ids.size;
      if(remaining>0)for(const p of selectPatterns(all.filter(p=>!ids.has(p.id)),{...instance.params,maxPatterns:remaining},window))ids.add(p.id);
    }
    cache.set(instance.instanceId,{arrays,key,config,window,ids});return ids;
  }
  getPatternStudies():PatternStudy[] {
    const rows=this.getPatternRows();
    return this.drawing.document.indicators.filter(i=>this.registry.list().some(d=>d.id===i.id&&d.category==='pattern')).map(instance=>{
      const scan=this.engine.pending&&!this.patternWindowPending?undefined:this.engine.derived.find(d=>d.indicatorId===instance.instanceId)?.patternScan;
      const raw=this.engine.derived.filter(series=>series.indicatorId===instance.instanceId).flatMap(series=>series.patterns??[]),window=this.visiblePatternWindow();
      const inView=raw.filter(p=>!window||patternIntersectsWindow(p,window,instance.params.showTargets===true));
      const count=rows.filter(row=>row.instanceId===instance.instanceId).length,filteredInvalidated=patternHistoryMode(instance.params)==='active'?inView.filter(p=>p.status==='invalidated').length:0;
      const latest=(times:number[])=>times.length?Math.max(...times):undefined;
      const latestMatchTime=latest(this.engine.derived.filter(series=>series.indicatorId===instance.instanceId).flatMap(series=>(series.patterns??[]).map(p=>p.confirmedAt)));
      const latestDisplayedMatchTime=latest(rows.filter(row=>row.instanceId===instance.instanceId&&row.visible).map(row=>row.pattern.confirmedAt));
      return {
      instanceId:instance.instanceId,name:this.studyDisplayName(instance.instanceId),
      definitionId:instance.id,timeframe:instance.timeframe==='chart'?this.state.interval:instance.timeframe,
      visible:this.layerStatus(instance.instanceId).visible,locked:this.layerStatus(instance.instanceId).locked,pending:this.state.loading||(this.engine.pending&&!this.patternWindowPending),
      scan,count,filteredInvalidated,limited:Math.max(0,inView.length-filteredInvalidated-count),outsideViewport:raw.length-inView.length,latestMatchTime,latestDisplayedMatchTime,
    };});
  }
  private visiblePatternWindow():PatternTimeWindow|undefined {
    if(!this.store.length)return;
    const step=intervals[this.state.interval];
    return {fromTime:timeForIndex(this.store,Math.floor(this.viewport.from),step),toTime:timeForIndex(this.store,Math.ceil(this.viewport.to),step)};
  }
  private desiredPatternWindow():PatternTimeWindow|undefined {
    if(!this.store.length)return;
    const step=intervals[this.state.interval],span=Math.max(30,this.viewport.span),chunk=Math.max(16,Math.min(128,Math.round(span/4)));
    const from=Math.floor((this.viewport.from-span*.35)/chunk)*chunk,to=Math.ceil((this.viewport.to+span*.2)/chunk)*chunk;
    return {fromTime:timeForIndex(this.store,from,step),toTime:timeForIndex(this.store,to,step)};
  }
  private schedulePatternWindow():void {
    if(this.dead||this.state.loading||!this.store.length||!(this.reqs??[]).some(req=>this.registry.list().some(d=>d.id===req.id&&['pattern','analysis'].includes(d.category??''))))return;
    const window=this.desiredPatternWindow();if(!window)return;
    const key=JSON.stringify(window);
    if(key===JSON.stringify(this.patternWindow)){
      // A quick pan away and back cancels the abandoned destination. Otherwise
      // its delayed worker request can replace the still-visible window with
      // unrelated geometry until another frame schedules the correction.
      clearTimeout(this.patternWindowTimer);this.patternWindowTimer=undefined;this.patternWindowQueued='';return;
    }
    if(key===this.patternWindowQueued)return;
    clearTimeout(this.patternWindowTimer);this.patternWindowQueued=key;
    const generation=this.generation;
    this.patternWindowTimer=setTimeout(()=>{
      this.patternWindowTimer=undefined;this.patternWindowQueued='';
      if(this.dead||generation!==this.generation)return;
      const preserve=!this.engine.pending||this.patternWindowPending;
      this.patternWindow=window;this.patternWindowPending=preserve;
      const requests=this.workerRequests();this.calculationSignature=JSON.stringify(requests);this.engine.setReqs(requests);
      this.patternWindowPending=preserve&&this.engine.pending;
      this.state.indicatorsPending=this.engine.pending;this.dirty=true;this.publish();void this.loadPatternHistory();
    },220);
  }
  rescanPatterns():void {
    if(this.state.loading||!this.store.length)return;
    this.engine.init(this.store,this.workerRequests(),this.lastBarConfirmed||this.historicalSnapshot);
    this.state.indicatorsPending=true;this.dirty=true;this.publish();
  }
  selectPattern(instanceId:string,patternId:string,focus=true):void {
    const row=this.getPatternRows().find(row=>row.instanceId===instanceId&&row.pattern.id===patternId);if(!row)return;
    this.selectedPatternKey=`${instanceId}:${patternId}`;
    this.selectedCandidateKey=null;
    this.selectedAnalysisKey=null;
    this.drawing.selectLayers([instanceId]);
    if(focus){
      this.focusTimeRange(row.pattern.points[0].time,Math.max(row.pattern.confirmedAt,row.pattern.points.at(-1)!.time,...(row.pattern.events??[]).map(event=>event.knownAt)));
      // Jumping between distant structures must not interpolate through an
      // unrelated price range and briefly place every candle off screen.
      this.autoRanges.clear();this.rangeMoving=false;
    }
    this.dirty=true;this.overlayDirty=true;this.publish();
  }
  layerStatus(id:string) {
    const state={...this.drawing.effective(id),dataReason:''},doc=this.drawing.document;
    if(this.sceneLookupDocument!==doc){this.sceneLookupDocument=doc;this.layerLookup=new Map(doc.layers.map(l=>[l.id,l]));this.instanceLookup=new Map(doc.indicators.map(i=>[i.instanceId,i]));}
    const instance=this.instanceLookup.get(id);
    if(instance){
      if(!this.registry.list().some(d=>d.id===instance.id)){state.visible=false;state.reason='指标实现尚未加载';}
      else if(instance.timeframe!=='chart'&&TIMEFRAMES[instance.timeframe]<TIMEFRAMES[this.state.interval]){state.visible=false;state.reason='需要更低周期数据';}
    }
    const layer=this.layerLookup.get(id);
    if(layer?.kind==='drawing'){state.locked ||= this.drawing.allLocked;if(this.drawing.allHidden){state.visible=false;state.reason='全部绘图已隐藏';}}
    if(layer?.kind==='overlay'){
      // Saved external layers remain available without inventing output data.
      if(!this.overlays.some(p=>p.id===id)){state.visible=false;state.reason='等待外部数据源';}
    }
    return state;
  }
  private workerRequests():IndicatorReq[] {
    return this.reqs.filter(r=>this.registry.list().some(d=>d.id===r.id)&&(!r.timeframe||r.timeframe==='chart'||TIMEFRAMES[r.timeframe]>=TIMEFRAMES[this.state.interval]))
      .map(r=>({...r,params:['pattern','analysis'].includes(this.registry.get(r.id).category??'')
        ?Object.fromEntries(Object.entries(r.params).filter(([key])=>!['showLabels','showZones','showTargets','showDivergences','showInvalidated','historyDisplay','maxPatterns','showCandidates','patternDisplayVersion'].includes(key)))
        :['rsi','macd','kdj'].includes(r.id)?Object.fromEntries(Object.entries(r.params).filter(([key])=>!['showDivergences','showDivergenceLabels'].includes(key))):r.params,baseIntervalMs:TIMEFRAMES[this.state.interval],...(['pattern','analysis'].includes(this.registry.get(r.id).category??'')?{patternWindow:this.patternWindow??this.desiredPatternWindow()}: {})}));
  }
  private syncScene():void {
    const document=this.drawing.document;
    if(this.syncedDocument===document&&this.syncedInterval===this.state.interval)return;
    this.syncedDocument=document;this.syncedInterval=this.state.interval;this.drawingRevision++;
    this.reqs=this.drawing.document.indicators.map(i=>({id:i.id,instanceId:i.instanceId,params:i.params,timeframe:i.timeframe}));
    const reqs=this.workerRequests(),signature=JSON.stringify(reqs);
    if(signature!==this.calculationSignature){
      this.patternWindowPending=false;
      this.calculationSignature=signature;this.state.indicatorsPending=true;
      if(!this.state.loading)this.engine.setReqs(reqs);
      queueMicrotask(()=>{void this.loadPatternHistory();});
    }
    this.dirty=true;this.overlayDirty=true;
  }
  restoreSeries(kind:'candles'|'volume'):void {
    const id=`series:${kind}`;if(this.drawing.document.layers.some(l=>l.id===id))return;
    this.drawing.transact(doc=>({...doc,layers:[layerOf(id,'series',kind==='candles'?'K 线':'成交量柱',kind==='candles'?'main':'volume'),...doc.layers]}));
  }
  addIndicator(id:string,timeframe='chart',paneId?:string,options:{params?:ParamValues;name?:string}={}):string|null {
    const def=this.registry.list().find(def=>def.id===id);
    if(!def||this.state.loading||(timeframe!=='chart'&&!Object.hasOwn(TIMEFRAMES,timeframe)))return null;
    const instanceId=crypto.randomUUID();
    const pane=paneId??(def.target==='main'?'main':def.target==='volume'?'volume':this.drawing.document.layers.some(l=>l.paneId===id)?`${id}:${instanceId}`:id);
    this.drawing.transact(doc=>{
      const parent=this.drawing.state.scene.activeGroupId,group=doc.layers.find(l=>l.id===parent);
      if(pane==='volume'&&!doc.layers.some(l=>l.id==='series:volume'))doc.layers.push(layerOf('series:volume','series','成交量柱','volume'));
      doc.indicators.push({instanceId,id,params:{...this.registry.defaults(id),...options.params},timeframe,hiddenPlots:[]});
      doc.layers.push(layerOf(instanceId,'indicator',options.name||def.name,pane,{createdInterval:this.state.interval,parentId:group?.paneId===pane?group.id:null}));return doc;
    });
    if(!this.drawing.document.indicators.some(i=>i.instanceId===instanceId))return null;
    this.drawing.selectLayers([instanceId]);return instanceId;
  }
  toggleIndicator(id:string,enabled:boolean):void {
    const instances=this.drawing.document.indicators.filter(i=>i.id===id);
    if(enabled&&!instances.length)this.addIndicator(id);
    else this.drawing.updateLayers(instances.map(i=>i.instanceId),{visible:enabled});
  }
  setParam(id:string,key:string,value:number|string|boolean):void {
    const instance=this.drawing.document.indicators.find(i=>i.instanceId===id)??this.drawing.document.indicators.find(i=>i.id===id);
    if(!instance||this.layerStatus(instance.instanceId).locked)return;
    const schema=this.registry.get(instance.id).inputs.find(p=>p.key===key);if(!schema)return;
    if(schema.type==='int'||schema.type==='float'){
      if(typeof value!=='number'||!Number.isFinite(value))return;
      value=clamp(value,schema.min??-Infinity,schema.max??Infinity);if(schema.type==='int')value=Math.round(value);
    }
    this.drawing.transact(doc=>({...doc,indicators:doc.indicators.map(i=>i.instanceId===instance.instanceId?{...i,params:{...i.params,[key]:value}}:i)}));
  }
  setIndicatorTimeframe(instanceId:string,timeframe:string):void {
    if(timeframe!=='chart'&&!Object.hasOwn(TIMEFRAMES,timeframe))return;
    if(this.layerStatus(instanceId).locked)return;
    this.drawing.transact(doc=>({...doc,indicators:doc.indicators.map(i=>i.instanceId===instanceId?{...i,timeframe}:i)}));
  }
  toggleIndicatorPlot(instanceId:string,plotIndex:number):void {
    if(this.layerStatus(instanceId).locked||!Number.isInteger(plotIndex)||plotIndex<0||plotIndex>63)return;
    this.drawing.transact(doc=>({...doc,indicators:doc.indicators.map(i=>i.instanceId===instanceId?{...i,hiddenPlots:i.hiddenPlots.includes(plotIndex)?i.hiddenPlots.filter(p=>p!==plotIndex):[...i.hiddenPlots,plotIndex]}:i)}));
  }
  setIndicatorPlotStyle(instanceId:string,plotIndex:number,patch:{color?:string;width?:number}):void {
    if(this.layerStatus(instanceId).locked||!Number.isInteger(plotIndex)||plotIndex<0||plotIndex>63)return;
    if(patch.color!==undefined&&!/^#[0-9a-f]{6}$/i.test(patch.color))return;
    if(patch.width!==undefined&&(!Number.isFinite(patch.width)||patch.width<1||patch.width>8))return;
    this.drawing.transact(doc=>({...doc,indicators:doc.indicators.map(i=>i.instanceId===instanceId?{...i,plotStyles:{...i.plotStyles,[plotIndex]:{...i.plotStyles?.[plotIndex],...patch}}}:i)}));
  }
  /** Stable declarative entry for native signals and custom analysis overlays. */
  setOverlays(plots:OverlayPlot[]):void {this.setOverlayGroup('',plots);}
  /** Each owner (e.g. the agent bridge) replaces only its own plots; the
   * layer sync below still sees the union of every owner's stable IDs. */
  setOverlayGroup(owner:string,plots:OverlayPlot[]):void {
    const previous=new Set(this.externalOverlays.map(plot=>plot.id));
    const groups=this.overlayGroups??=new Map();
    if(plots.length)groups.set(owner,plots.map((p,i)=>({...p,id:p.id??(owner?`${owner}:${i}`:`overlay:${i}`)})));else groups.delete(owner);
    this.externalOverlays=[...groups.values()].flat();
    this.refreshOverlays();
    this.drawing.transact(doc=>{
      const ids=new Set(this.externalOverlays.map(p=>p.id));doc.layers=doc.layers.filter(l=>l.kind!=='overlay'||!previous.has(l.id)||ids.has(l.id));
      for(const plot of this.externalOverlays)if(!doc.layers.some(l=>l.id===plot.id))doc.layers.push(layerOf(plot.id!,'overlay',plot.name??`图表叠加 ${plot.kind}`,plot.paneId??(plot.pane==='sub'?'macd':plot.pane),{createdInterval:plot.timeframe??this.state.interval}));
      return doc;
    });this.dirty=true;
  }
  /** Refresh producer-neutral overlays after their coordinates or bars change. */
  private refreshOverlays():void {
    this.overlays=[...this.externalOverlays];
    this.dataRevision++;this.markerIndices.clear();
    for(const plot of this.overlays)if(plot.kind==='markers'){
      const indices:number[]=[];for(let i=0;i<plot.values.length;i++)if(plot.side?.[i]&&Number.isFinite(plot.values[i]))indices.push(i+(plot.offset??0));
      this.markerIndices.set(plot,indices);
    }
    this.dirty=true;
  }
  /** Freeze confirmed historical bars independently from live prices and LOD. */
  snapshotDataset(maxBars=5000,includeForming=false):DatasetSnapshot {
    const end=Math.max(0,this.store.length-(this.historicalSnapshot||includeForming||this.lastBarConfirmed?0:1));
    let start=Math.max(0,end-Math.min(50000,Math.max(1,maxBars)));
    while(start<end&&this.store.timeAt(start)<0)start++;
    const bars=[];for(let i=start;i<end;i++)bars.push(this.barAt(i));
    const connector=marketConnectors.get(this.state.source);
    return {source:this.state.source,symbol:this.state.symbol,interval:this.state.interval,marketType:this.state.marketType,contract:this.state.contract?structuredClone(this.state.contract):undefined,bars,quoteCurrency:connector?.defaultQuoteCurrency??'USDT',timezone:connector?.session.timezone??'UTC'};
  }
  /** Actual visible candle coverage, excluding empty overscroll and future time. */
  getVisibleAnalysisTimeRange():{from:number;to:number}|undefined {
    const n=this.store.length;if(!n||this.viewport.to<0||this.viewport.from>n-1)return;
    const first=Math.max(0,Math.floor(this.viewport.from)),last=Math.min(n-1,Math.ceil(this.viewport.to));
    const from=this.store.timeAt(first),to=Math.min(Date.now(),timeForIndex(this.store,last+1,intervals[this.state.interval])-1);
    return Number.isFinite(from)&&Number.isFinite(to)&&to>=from?{from,to}:undefined;
  }
  hasTimeRange(from:number,to:number):boolean{return this.store.length>0&&from>=this.store.timeAt(0)&&to<=this.store.timeAt(this.store.length-1);}
  focusTimeRange(from:number,to:number):void {
    if(!this.store.length)return;this.cancelDrag();this.cancelViewportMotion();this.maximizedPane=null;
    const step=intervals[this.state.interval],a=indexForTime(this.store,from,step),b=indexForTime(this.store,to,step),span=Math.max(30,b-a+12);
    this.viewport.from=a-span*.2;this.viewport.to=Math.max(b+span*.2,this.viewport.from+span);this.state.following=false;this.manualScales.clear();this.dirty=true;this.publish();
  }
  showHistoricalDataset(dataset:DatasetSnapshot,reason:'history'|'analysis'='history',orderFlowOwner?:string):void {
    if(dataset.source==='import'||dataset.source==='binance'&&dataset.marketType!=='usdm-perpetual'||!dataset.bars.length||!Object.hasOwn(intervals,dataset.interval))return;
    if(!orderFlowOwner){this.orderFlowPrices=undefined;this.orderFlowReturnInterval=undefined;this.orderFlowPriceRequest?.abort();if(this.orderFlow?.snapshot().mode==='history')this.orderFlow.live();}
    this.analysisReplay=reason==='analysis';if(!this.analysisReplay){this.replaySource=undefined;this.replayCursor=0;}
    this.generation++;this.feed?.disconnect();this.engine.destroy();this.engine.derived=[];this.cancelDrag();this.cancelViewportMotion();
    clearTimeout(this.patternWindowTimer);this.patternWindowTimer=undefined;this.patternWindow=undefined;this.patternWindowQueued='';this.patternWindowPending=false;
    this.liveBarMotion.clear();this.viewportPhysics?.clearEnvelopes();this.depthOverlay=undefined;this.depthProjection=undefined;this.autoRanges.clear();this.manualScales.clear();this.studyMarkers.clear();this.emptyPaneRanges.clear();this.fitEmptyPanes.clear();this.pendingPointer=null;
    this.historicalSnapshot=true;this.externalOverlays=[];this.overlayGroups?.clear();this.calculationSignature='';this.maximizedPane=null;
    this.state={...this.state,source:dataset.source,symbol:dataset.symbol,interval:dataset.interval,marketType:dataset.marketType,contract:dataset.contract,loading:false,error:'',warning:this.analysisReplay?'分析回放 · 只计算当前游标之前的闭柱；返回最新可恢复实时行情':'正在查看历史行情快照 · 点击「最新」返回实时行情',paused:true,following:false,status:'ok',quote:null,readings:[],indicatorsPending:true,historicalSnapshot:true,analysisReplay:this.analysisReplay,patternHistoryLoading:false,patternHistoryError:''};
    this.drawing.setInterval(dataset.interval);this.drawing.setMarket(marketIdentity({source:dataset.source,symbol:dataset.symbol,marketType:dataset.marketType}));
    this.store=new ColumnStore(dataset.bars.length);for(const bar of dataset.bars)this.store.appendBar(bar);
    this.pyramid=new Pyramid(this.store);this.viewport.setTotal(this.store.length);this.refreshOverlays();this.engine.init(this.store,this.workerRequests(),true);
    this.pointer=null;this.magnetPointer=null;this.magnetGuide=null;this.axes=null;this.panes=[];this.dataRevision++;this.dirty=true;this.publish();
  }
  private queueOrderFlowPriceSync():void {
    const state=this.orderFlow?.snapshot();if(!state||this.dead)return;
    if(this.orderFlowPriceLoadingId&&state.archive?.dataset.id!==this.orderFlowPriceLoadingId)this.orderFlowPriceRequest?.abort();
    if(this.orderFlowSyncQueued)return;
    const loaded=this.orderFlowPrices;if(!loaded)return;
    if(state.mode==='history'&&state.archive?.dataset.id===loaded.id&&state.archive.cursor===loaded.cursor)return;
    this.orderFlowSyncQueued=true;
    queueMicrotask(()=>{
      this.orderFlowSyncQueued=false;if(this.dead)return;const latest=this.orderFlow.snapshot(),cache=this.orderFlowPrices;if(!cache)return;
      if(latest.mode==='live'){
        this.orderFlowPrices=undefined;if(this.historicalSnapshot)void this.setMarket(this.state.source,this.state.symbol,cache.returnInterval);return;
      }
      if(latest.archive?.dataset.id!==cache.id){this.orderFlowPrices=undefined;return;}
      const cursor=latest.archive.cursor;if(cursor===cache.cursor)return;
      if(cache.store===this.store&&closedPriceCount(cache.dataset,cursor)===this.store.length){cache.cursor=cursor;this.dirty=true;this.overlayDirty=true;return;}
      const prefix=closedPricePrefix(cache.dataset,cursor),from=this.viewport.from,to=this.viewport.to;cache.cursor=cursor;
      if(!prefix.bars.length){
        this.engine.destroy();this.engine.derived=[];this.store=new ColumnStore();this.pyramid=new Pyramid(this.store);this.viewport.setTotal(0);cache.store=this.store;
        this.liveBarMotion.clear();this.depthCells=[];this.depthOverlay=undefined;this.depthProjection=undefined;this.axes=null;this.panes=[];this.state.quote=null;this.state.latestQuote=null;this.state.warning='游标前暂无已闭价格柱';
        this.engine.init(this.store,this.workerRequests(),true);this.dataRevision++;this.dirty=true;this.overlayDirty=true;this.publish();return;
      }
      this.showHistoricalDataset(prefix,'analysis',cache.id);cache.store=this.store;this.viewport.from=from;this.viewport.to=to;this.dirty=true;
    });
  }
  returnToLiveOrderFlow():void {
    const hasPriceContext=!!this.orderFlowPrices,restore=this.orderFlowReturnInterval;this.orderFlow.live();
    if(this.historicalSnapshot&&!hasPriceContext){if(restore)void this.setMarket(this.state.source,this.state.symbol,restore);else this.followLatest();}
  }
  async loadOrderFlowArchivePrices():Promise<void> {
    const selected=this.orderFlow.snapshot(),archive=selected.archive,market=selected.market;
    if(!archive||!market||market.source!=='binance')throw Error('请选择有深度数据的 Binance 档案');
    this.orderFlowPriceRequest?.abort();const abort=new AbortController();this.orderFlowPriceRequest=abort;this.orderFlowPriceLoadingId=archive.dataset.id;
    const generation=this.generation,key=archive.dataset.id,returnInterval=this.orderFlowReturnInterval??this.orderFlowPrices?.returnInterval??this.state.interval;
    try{
      const duration=archive.to-archive.from,interval=duration<=7*86400000?'1m':duration<=30*86400000?'5m':'1h',step=intervals[interval];
      let cursor=Math.max(0,Math.floor(archive.from/step)*step-120*step);const end=Math.min(Date.now(),Math.ceil(archive.to/step)*step+step),bars:BarInput[]=[];
      while(cursor<end&&bars.length<12000){
        abort.signal.throwIfAborted();if(this.dead||generation!==this.generation||this.orderFlow.snapshot().archive?.dataset.id!==key)throw Error('行情上下文已改变');
        const query=new URLSearchParams({symbol:market.symbol,interval,startTime:String(cursor),endTime:String(end-1),limit:'1000'});
        const response=await publicMarketRequest(`https://fapi.binance.com/fapi/v1/klines?${query}`,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(12000)])});
        if(!response.ok)throw Error('档案价格图加载失败');const rows:unknown=await response.json();
        if(!Array.isArray(rows)||!rows.length)break;
        for(const row of rows){if(!Array.isArray(row)||row.length<7)throw Error('历史价格数据无效');const [time,open,high,low,close,volume]=row.map(Number);
          if(![time,open,high,low,close,volume].every(Number.isFinite)||high<Math.max(open,close)||low>Math.min(open,close)||low>high||volume<0)throw Error('历史价格数据无效');
          if(time>=cursor&&time<end&&Number(row[6])<Date.now()){if(bars.length&&time!==bars.at(-1)!.time+step)throw Error('档案价格图存在缺柱');bars.push({time,open,high,low,close,volume});}}
        const last=Number(rows.at(-1)[0]),next=last+step;if(next<=cursor)throw Error('历史价格分页未前进');cursor=next;
      }
      abort.signal.throwIfAborted();if(this.dead||generation!==this.generation||this.orderFlow.snapshot().archive?.dataset.id!==key)throw Error('行情上下文已改变');
      if(!bars.length||bars.length>=12000)throw Error('档案价格区间过大或暂无价格数据');
      const dataset:DatasetSnapshot={source:'binance',symbol:market.symbol,interval,marketType:'usdm-perpetual',contract:this.state.contract,bars},at=this.orderFlow.snapshot().archive!.cursor;
      const prefix=closedPricePrefix(dataset,at);if(!prefix.bars.length)throw Error('该游标尚无已闭价格柱');
      this.orderFlowReturnInterval=returnInterval;this.orderFlowPrices={id:key,dataset,cursor:at,returnInterval};this.orderFlowPriceLoadingId=undefined;
      this.showHistoricalDataset(prefix,'analysis',key);this.orderFlowPrices.store=this.store;this.focusTimeRange(archive.from,archive.to);
    }finally{if(this.orderFlowPriceRequest===abort){this.orderFlowPriceRequest=undefined;this.orderFlowPriceLoadingId=undefined;}}
  }
  /** Right-edge lead (fraction of the visible span) while following. With the
   * depth profile shown it widens past the profile column (15% of the plot) so
   * the latest bars sit beside it instead of underneath. */
  private followLead():number {return this.profileLead?0.17:0.06;}
  private profileLead=false;
  /** Re-seat the lead when the profile is toggled while following. */
  private syncProfileLead():void {
    const want=this.orderFlow?.snapshot().settings.profile===true;
    if(want===this.profileLead)return;
    const before=this.followLead();this.profileLead=want;
    if(!this.state?.following||!this.store?.length||this.historicalSnapshot||!this.viewportMotion)return;
    const span=this.viewport.to-this.viewport.from,shift=span*(this.followLead()-before);
    const target={min:this.viewport.from+shift,max:this.viewport.to+shift};
    if(this.state.smoothMotion){this.viewportMotion.snap({min:this.viewport.from,max:this.viewport.to});this.viewportMotion.set(target,performance.now(),180);this.liveFollowing=true;}
    else {this.viewport.from=target.min;this.viewport.to=target.max;}
    this.dirty=true;
  }
  followLatest(): void {
    if(this.historicalSnapshot){if(this.orderFlowPrices||this.orderFlowReturnInterval||this.orderFlow?.snapshot().mode==='history')this.returnToLiveOrderFlow();else void this.setMarket(this.state.source,this.state.symbol,this.state.interval);return;}
    this.cancelViewportMotion();
    this.manualScales.delete('main');
    const span=Math.min(160,this.store.length || 160);
    this.viewport.to=this.store.length+span*this.followLead();this.viewport.from=this.viewport.to-span;
    this.state.following=true;this.dirty=true;this.publish();
  }
  beginAnalysisReplay(maxBars=10000):DatasetSnapshot {
    const dataset=this.snapshotDataset(maxBars);if(dataset.bars.length<30)throw Error('至少需要30根已收盘K线才能回放');
    this.replaySource=structuredClone(dataset);this.replayCursor=0;this.seekAnalysisReplay(Math.max(30,Math.floor(dataset.bars.length*.6)));return structuredClone(dataset);
  }
  seekAnalysisReplay(cursor:number):void {
    const source=this.replaySource;if(!source)throw Error('请先启动分析回放');
    const next=Math.max(1,Math.min(source.bars.length,Math.round(cursor)));
    if(this.analysisReplay&&this.replayCursor===this.store.length&&next>this.replayCursor&&next-this.replayCursor<=200){
      for(let i=this.replayCursor;i<next;i++)this.acceptBar({...source.bars[i],isNew:true,confirmed:true});
      this.refreshOverlays();
    }else this.showHistoricalDataset({...source,bars:source.bars.slice(0,next)},'analysis');
    this.replayCursor=next;this.focusTimeRange(source.bars[Math.max(0,next-100)].time,source.bars[next-1].time);
    this.dirty=true;this.publish();
  }
  getAnalysisReplayState(){return {active:this.analysisReplay,cursor:this.replayCursor,total:this.replaySource?.bars.length??0,time:this.store.length?this.store.timeAt(this.store.length-1):null};}
  showAll(): void {
    this.cancelViewportMotion();
    this.viewport.from=0;this.viewport.to=Math.max(5,this.store.length);
    this.state.following=false;this.dirty=true;this.publish();
  }
  setSmoothMotion(enabled:boolean):void {
    this.motionPreference=enabled;this.state.smoothMotion=enabled&&!motionReduced();
    if(!this.state.smoothMotion)this.finishMotion();this.publish();
  }
  private finishMotion():void {
    this.liveBarMotion.finish();
    this.viewportPhysics?.cancel();this.viewportPhysics?.clearEnvelopes();
    if(this.viewportMotion.active){this.viewport.from=this.viewportMotion.target.min;this.viewport.to=this.viewportMotion.target.max;this.viewportMotion.snap(this.viewportMotion.target);}
    for(const motion of this.autoRanges.values())motion.snap(motion.target);this.rangeMoving=false;this.dirty=true;
  }
  private cancelViewportMotion():void {this.liveFollowing=false;this.viewportPhysics?.cancel();this.viewportMotion.snap({min:this.viewport.from,max:this.viewport.to});}
  private zoomViewport(x:number,factor:number,duration:number):void {
    const shown={min:this.viewport.from,max:this.viewport.to};
    if(this.viewportMotion.active){this.viewport.from=this.viewportMotion.target.min;this.viewport.to=this.viewportMotion.target.max;}
    this.viewport.zoomAt(x,factor);const target={min:this.viewport.from,max:this.viewport.to};
    if(duration){this.viewport.from=shown.min;this.viewport.to=shown.max;this.viewportMotion.snap(shown);this.viewportMotion.set(target,performance.now(),duration);}
    else this.viewportMotion.snap(target);
    this.dirty=true;
  }
  resetPaneScale(id: string): void {
    this.manualScales.delete(id);this.emptyPaneRanges.delete(id);this.fitEmptyPanes.add(id);
    this.dirty = true;
  }
  resetPaneLayout(): void {
    this.cancelDrag();
    this.paneLayout.reset();
    this.maximizedPane = null;
    this.dirty = true;
  }
  toggleMaximize(id: string): void {
    this.cancelDrag();
    this.host.focus();
    this.maximizedPane = this.maximizedPane === id ? null : id;
    this.pointer = null;
    this.dirty = true;
  }
  zoom(factor:number):void {this.zoomViewport(this.viewport.plotW/2,factor,this.state.smoothMotion?140:0);this.state.following=false;this.dirty=true;}
  rebuildRenderer():void {this.renderer.rebuild();this.state.warning=this.renderer.mode==='WebGL2'?'':'当前环境使用 Canvas2D 渲染。';this.dirty=true;this.publish();}
  getDiagnostics() {
    const p95=(a:number[])=>a.length?[...a].sort((a,b)=>a-b)[Math.min(a.length-1,Math.floor(a.length*.95))]:0;
    return {...this.state,divergenceRendering:{...this.divergenceRendering},fullFrameP95:p95(this.fullFrameTimes),inputLatencyP95:p95(this.inputLatencies),presentedFrames:this.presentedFrames,motionActive:this.viewportMotion.active||!!this.viewportPhysics?.active||this.rangeMoving||this.liveBarMotion.active,liveBar:this.liveBarMotion.peek(performance.now()),magnet:{active:this.drawing.effectiveMagnet,strength:this.drawing.effectiveMagnetStrength,feedback:this.magnetFeedback},panes:this.panes.map(p=>({id:p.id,top:p.top,height:p.height,min:p.min,max:p.max,manual:this.manualScales.has(p.id)})),maximizedPane:this.maximizedPane,from:this.viewport.from,to:this.viewport.to,renderP95:p95(this.frameTimes),tickP95:p95(this.tickTimes),
      series:this.engine.derived.map(s=>({name:s.name,pane:s.pane,id:s.indicatorId,last:s.values[this.store.length-1]}))};
  }
  /** Read-only surface for the local agent bridge (src/lib/agent). Views are
   * live: callers copy what they keep and never mutate columns or series. */
  get data():ColumnView{return this.store;}
  get derivedSeries():readonly DerivedSeries[]{return this.engine.derived;}
  get overlayPlots():readonly OverlayPlot[]{return this.overlays;}
  get chartState():ChartState{return {...this.state};}
  get chartSize(){return {width:this.width,height:this.height,plotWidth:this.viewport.plotW,axisWidth:AXIS_W,axisHeight:AXIS_H,dpr:this.dpr};}
  paneGeometry(){return this.panes.map(p=>({id:p.id,name:this.paneName(p.id),top:p.top,height:p.height,min:p.min,max:p.max,manual:this.manualScales.has(p.id)}));}
  layerName(layer:SceneLayer):string{return this.layerDisplayName(layer);}
  anchorToPixel(paneId:string,anchor:Anchor):Pixel|null{return this.drawingProjection(paneId)?.project(anchor)??null;}
  pixelToAnchor(pixel:Pixel):{paneId:string;anchor:Anchor}|null{
    const paneId=this.panes.find(p=>pixel.x>=0&&pixel.x<this.viewport.plotW&&pixel.y>=p.top&&pixel.y<p.top+p.height)?.id,anchor=paneId?this.drawingAnchor(pixel,paneId,false):null;
    return paneId&&anchor?{paneId,anchor}:null;
  }
  /** Bring layout, pane ranges and readings up to date outside the rAF loop
   * (hidden tabs and throttled automation), so a read right after a write is current. */
  settle():void {
    if(this.dead)return;
    if(this.resizePending){this.resizePending=false;this.resize();}
    if(this.dirty){this.schedulePatternWindow();this.draw();this.dirty=false;this.overlayDirty=true;}
    this.publish();
  }
  /** Repaint synchronously so the WebGL buffer is still valid (hidden tabs get
   * no rAF), then flatten the visible canvases in DOM order. DOM legends and
   * pane buttons are not part of the image. */
  captureImage(maxWidth=1600):HTMLCanvasElement {
    if(this.resizePending){this.resizePending=false;this.resize();}
    this.draw();this.drawOverlay();this.dirty=true;
    const ratio=Math.max(.1,Math.min(this.dpr,maxWidth/this.width)),out=document.createElement('canvas');
    out.width=Math.max(1,Math.round(this.width*ratio));out.height=Math.max(1,Math.round(this.height*ratio));
    const ctx=out.getContext('2d')!;ctx.fillStyle=this.appearance.background;ctx.fillRect(0,0,out.width,out.height);
    for(const canvas of this.host.querySelectorAll<HTMLCanvasElement>(':scope > canvas'))if(canvas.style.visibility!=='hidden'&&canvas.width&&canvas.height)ctx.drawImage(canvas,0,0,out.width,out.height);
    return out;
  }
  destroy():void {clearTimeout(this.depthRepaintTimer);this.orderFlowPriceRequest?.abort();this.orderFlow?.destroy();this.divergenceProjection?.clear();this.unsubscribeLocale();this.dead=true;this.generation++;clearTimeout(this.patternWindowTimer);cancelAnimationFrame(this.raf);this.events.abort();this.observer.disconnect();this.feed?.disconnect();this.engine.destroy();this.renderer.destroy();this.unsubscribeScene();this.drawing.destroy();this.axisCanvas.remove();this.paneControls.remove();this.markerTooltip?.remove();}

  private barAt(i:number):BarInput {
    const s=this.store,flow=Object.fromEntries((['quoteVolume','tradeCount','takerBuyBase','takerBuyQuote'] as const).flatMap(name=>{const value=s.flow(name)?.[i];return Number.isFinite(value)?[[name,value]]:[];}));return {time:s.timeAt(i),open:s.col('open')[i],high:s.col('high')[i],low:s.col('low')[i],close:s.col('close')[i],volume:s.col('volume')[i],...flow};
  }
  private canAnimateLiveBar():boolean {
    const index=this.store.length-1,v=this.viewport;
    if(index<v.from-1||index>v.to+1||v.span>Math.max(2048,v.plotW*1.5))return false;
    return this.panes.some(p=>p.id==='main'&&this.layerStatus('series:candles').visible||p.id==='volume'&&this.layerStatus('series:volume').visible);
  }
  private acceptBar(bar:BarEvent):void {
    if(this.dead||!this.store.length)return;
    const start=performance.now(),last=this.store.timeAt(this.store.length-1);
    if(bar.time<last||!Object.values(bar).every(v=>typeof v==='boolean'||Number.isFinite(v)))return;
    const isNew=bar.time>last;
    if(isNew)this.store.appendBar(bar);else this.store.updateLast(bar);
    this.lastBarConfirmed=isNew?bar.confirmed===true:this.lastBarConfirmed||bar.confirmed===true;
    this.marketRevision++;
    const i=this.store.length-1;this.pyramid.updateRange(i,i+1);this.viewport.setTotal(this.store.length);
    this.liveBarMotion.update(bar,start,this.state.smoothMotion&&this.canAnimateLiveBar()?isNew?120:90:0);
    if(isNew&&this.state.following){
      const from=this.liveFollowing&&this.viewportMotion.active?this.viewportMotion.target.min:this.viewport.from;
      const to=this.liveFollowing&&this.viewportMotion.active?this.viewportMotion.target.max:this.viewport.to;
      if(this.state.smoothMotion){this.viewportMotion.snap({min:this.viewport.from,max:this.viewport.to});this.viewportMotion.set({min:from+1,max:to+1},start,120);this.liveFollowing=true;}
      else {this.viewport.from=from+1;this.viewport.to=to+1;}
    }
    this.dataRevision++;this.engine.pushBar(isNew,this.lastBarConfirmed);this.dirty=true;
    this.state.tickMs=performance.now()-start;this.tickTimes.push(this.state.tickMs);if(this.tickTimes.length>500)this.tickTimes.shift();
  }

  /** ResizeObserver runs after rAF and before paint. Only record its change:
   * resetting canvas dimensions here would expose cleared buffers for a frame. */
  private scheduleResize():void {if(!this.dead)this.resizePending=true;}
  private resize():void {
    const w=Math.max(1,this.host.clientWidth),h=Math.max(1,this.host.clientHeight),dpr=window.devicePixelRatio||1;
    if(w===this.width&&h===this.height&&dpr===this.dpr)return;
    // Resizing the viewport is not a request to discard a drawing edit. Its
    // world-space anchors can continue against the resized projection.
    if(this.drag?.kind!=='drawing')this.cancelDrag();this.cancelViewportMotion();
    this.width=Math.max(1,this.host.clientWidth);this.height=Math.max(1,this.host.clientHeight);this.dpr=window.devicePixelRatio||1;
    this.renderer.resize(this.width,this.height,this.dpr);
    this.overlay.width=Math.round(this.width*this.dpr);this.overlay.height=Math.round(this.height*this.dpr);
    this.ctx.setTransform(this.dpr,0,0,this.dpr,0,0);
    this.axisCanvas.width=this.overlay.width;this.axisCanvas.height=this.overlay.height;
    this.axisContext.setTransform(this.dpr,0,0,this.dpr,0,0);
    this.viewport.resize(Math.max(1,this.width-AXIS_W),Math.max(1,this.height-AXIS_H));this.dirty=true;
  }
  private frame(time:number):void {
    if(this.dead)return;
    const frameStart=performance.now();
    if(this.resizePending||this.dpr!==(window.devicePixelRatio||1)){this.resizePending=false;this.resize();}
    this.flushPointer();
    if(this.viewportPhysics?.active){
      const moved=this.viewportPhysics.step(time,{onZoom:(anchor,factor)=>this.viewport.zoomAt(anchor,factor),onPan:dx=>this.viewport.panBy(dx)});
      if(moved||this.viewportPhysics.active)this.dirty=true;
    }
    if(this.viewportMotion.active){const value=this.viewportMotion.step(time);this.viewport.from=value.min;this.viewport.to=value.max;this.dirty=true;if(!this.viewportMotion.active)this.liveFollowing=false;}
    if(this.liveBarMotion.active&&!this.canAnimateLiveBar())this.liveBarMotion.finish();
    if(this.rangeMoving||this.liveBarMotion.active)this.dirty=true;
    if(!this.fpsStart)this.fpsStart=time;this.fpsFrames++;
    if(time-this.fpsStart>=1000){this.state.fps=Math.round(this.fpsFrames*1000/(time-this.fpsStart));this.fpsFrames=0;this.fpsStart=time;}
    const presented=this.dirty||this.overlayDirty;
    if(this.dirty)this.schedulePatternWindow();
    if(this.dirty){
      const start=performance.now();this.draw();this.state.renderMs=performance.now()-start;
      this.frameTimes.push(this.state.renderMs);if(this.frameTimes.length>300)this.frameTimes.shift();
      this.dirty=false;this.overlayDirty=true;
    }
    if(this.overlayDirty){this.drawOverlay();this.overlayDirty=false;}
    let quoteIndex=this.pointer&&this.store.length?clamp(Math.round(this.viewport.indexAt(this.pointer.x)),0,this.store.length-1):this.store.length-1;
    const readingsChanged=this.readingKey!==this.makeReadingKey(quoteIndex);
    if((readingsChanged&&time-this.lastPublish>=64)||time-this.lastPublish>=500)this.publish(time);
    if(presented){
      this.presentedFrames++;this.fullFrameTimes.push(performance.now()-frameStart);if(this.fullFrameTimes.length>300)this.fullFrameTimes.shift();
      if(this.inputStarted!==null){this.inputLatencies.push(performance.now()-this.inputStarted);if(this.inputLatencies.length>300)this.inputLatencies.shift();this.inputStarted=null;}
    }
    this.raf=requestAnimationFrame(t=>this.frame(t));
  }
  private markInput():void {this.inputStarted??=performance.now();}
  private flushPointer():void {const pending=this.pendingPointer;this.pendingPointer=null;pending?.();}
  private makeReadingKey(index:number):string{return `${index}:${this.dataRevision}:${this.drawing.document===this.syncedDocument?this.drawingRevision:0}:${this.engine.pending&&!this.patternWindowPending}:${!!this.pointer}:${this.drawing.allHidden}:${Math.floor(this.viewport.from)}:${Math.ceil(this.viewport.to)}`;}
  private drawingRevision=0;
  private publish(time=performance.now()):void {
    if(this.dead)return;
    this.orderFlow?.configure({source:this.state.source,symbol:this.state.symbol,marketType:this.state.marketType,tickSize:this.state.contract?.tickSize??0,chartHistorical:this.historicalSnapshot});
    this.lastPublish=time;
    const {store,state}=this;
    state.latestQuote=store.length?this.barAt(store.length-1):null;
    state.marketRevision=this.marketRevision;
    const confirmedIndex=store.length-(this.historicalSnapshot||this.lastBarConfirmed?1:2);
    state.confirmedBarTime=confirmedIndex>=0?store.timeAt(confirmedIndex):null;
    let i=store.length-1;
    if(this.pointer&&store.length){const hover=Math.round(this.viewport.indexAt(this.pointer.x));i=clamp(hover,0,store.length-1);}
    const key=this.makeReadingKey(i),readingsNeedUpdate=key!==this.readingKey;
    if(key!==this.readingKey){
    this.readingKey=key;
    state.quote=i>=0?{time:store.timeAt(i),open:store.col('open')[i],high:store.col('high')[i],low:store.col('low')[i],close:store.col('close')[i],volume:store.col('volume')[i]}:null;
    }
    state.hover=!!this.pointer;state.total=store.length;state.visible=Math.max(0,Math.min(store.length,Math.ceil(this.viewport.to))-Math.max(0,Math.floor(this.viewport.from)));
    const doc=this.drawing.document;
    if(readingsNeedUpdate){
    const pending=this.engine.pending&&!this.patternWindowPending;
    state.readings=doc.indicators.map(instance=>{
      const layer=doc.layers.find(l=>l.id===instance.instanceId)!,status=this.layerStatus(instance.instanceId);
      const dataWarning=this.engine.derived.find(d=>d.indicatorId===instance.instanceId&&d.dataWarning)?.dataWarning;
      const series=this.engine.derived.filter(d=>d.indicatorId===instance.instanceId&&(!['patterns','analysis'].includes(d.plot)||!pending));
      const patternIds=series.some(d=>d.plot==='patterns'&&d.patterns)?this.patternDisplayIds(instance):null;
      const values=series.map(d=>{
        const unit:'price'|'count'=d.plot==='patterns'||d.plot==='analysis'?'count':'price';
        const raw=d.values[i];
        const value=d.plot==='patterns'
          ?(d.candidates!==undefined?this.visiblePatternCandidates(instance,d.candidates).length:(d.patterns??[]).filter(p=>patternIds?.has(p.id)&&!this.manuallyHidden('pattern',instance.instanceId,p.id)).length)
          :d.plot==='analysis'
            ?this.visibleObservations(instance,d.observations??[]).filter(o=>!this.manuallyHidden('analysis',instance.instanceId,o.id)).length
            :!Number.isFinite(raw)&&!this.pointer&&i===store.length-1&&i>0&&(d.plot==='line'||d.plot==='hist')?d.values[i-1]:raw;
        return {name:d.name,value,unit,color:instance.plotStyles?.[d.plotIndex??0]?.color??d.color,plotIndex:d.plotIndex??0,plot:d.plot,hidden:instance.hiddenPlots.includes(d.plotIndex??0)};
      });
      return {id:instance.instanceId,name:layer.name,paneId:layer.paneId,timeframe:instance.timeframe,visible:status.visible,status:status.reason||dataWarning||(pending&&!values.length?'正在计算':values.some(v=>v.plot==='analysis')?'分析证据 · 见分析面板':values.some(v=>v.plot==='patterns')?'已确认形态 · 见分析面板':values.length&&values.every(v=>!Number.isFinite(v.value))?'历史不足 / 指标预热中':this.registry.list().find(def=>def.id===instance.id)?.kind==='strategy'?'按收盘规则确认':instance.timeframe==='chart'?'实时 · 当前周期':TIMEFRAMES[instance.timeframe]===TIMEFRAMES[this.state.interval]?'实时 · 固定周期':'末端实时预览 · 历史已确认'),values};
    });
    const start=clamp(Math.floor(this.viewport.from),0,store.length),end=clamp(Math.ceil(this.viewport.to)+1,0,store.length);
    for(const plot of this.overlays){const layer=doc.layers.find(l=>l.id===plot.id);if(!layer)continue;const status=this.layerStatus(layer.id),idx=i-(plot.offset??0),raw=plot.values[idx];
      const values=plot.kind==='drawings'?[{name:tr('可见图形'),value:this.visibleDrawings(plot,start,end).length,unit:'count' as const,color:plot.color}]
        :plot.kind==='shapes'?[{name:tr('可见标注'),value:this.visibleShapes(plot,start,end).length,unit:'count' as const,color:plot.color}]
        :plot.kind==='markers'?[{name:tr('可见标记'),value:this.visibleOverlayMarkers(plot,start,end,Math.max(1,Math.ceil(this.viewport.plotW/14))).length,unit:'count' as const,color:plot.color}]
        :[{name:tr('数值'),value:!Number.isFinite(raw)&&!this.pointer&&i===store.length-1&&idx>0?plot.values[idx-1]:raw,unit:'price' as const,color:plot.color}];
      state.readings.push({id:layer.id,name:layer.name,paneId:layer.paneId,timeframe:plot.timeframe??'chart',visible:status.visible,status:status.reason||status.dataReason||'外部数据源',values});}
    }
    state.backend=this.renderer.mode;state.engine=this.engine.mode;
    this.onState({...state});
  }

  private draw():void {
    const r=this.renderer,v=this.viewport,s=this.store,w=v.plotW,h=Math.max(1,this.height-AXIS_H);
    this.markerLayouts=[];this.shapeLayouts=[];this.objectHits=[];this.patternHits=[];this.divergenceHits=[];this.depthCells=[];this.candidateHits=[];this.analysisHits=[];this.nextHitOrder=0;
    const activeLayers=this.drawing.paintLayers.filter(l=>this.layerStatus(l.id).visible&&(l.kind!=='drawing'||!this.drawing.allHidden));
    const doc=this.drawing.document,instanceMap=new Map(doc.indicators.map(i=>[i.instanceId,i])),layerMap=new Map(doc.layers.map(l=>[l.id,l]));
    const series=this.engine.derived.filter(d=>(!['patterns','analysis'].includes(d.plot)||!this.engine.pending||this.patternWindowPending)&&this.layerStatus(d.indicatorId!).visible&&!instanceMap.get(d.indicatorId!)?.hiddenPlots.includes(d.plotIndex??0));
    const overlayMap=new Map(this.overlays.map(plot=>[plot.id,plot]));
    // Oscillators own their evidence: no pattern layer or confluence gate is
    // consulted. One visible pane gets one mark for the same indicator pair.
    const divergenceSeen=new Set<string>(),divergenceWindow=this.visiblePatternWindow();
    // Close views retain every pair. Only overview geometry is represented at
    // screen density, with the complete evidence archive and selection intact.
    const physicalWidth=w*Math.max(1,this.dpr??1),densityBudget=v.span>physicalWidth*2?Math.max(32,Math.ceil(physicalWidth/12)*2):undefined;
    this.divergenceRendering={mode:'full',archive:0,projected:0,budgetPerSeries:densityBudget??null};
    const divergenceView={length:s.length,closedLength:Math.max(0,s.length-(this.historicalSnapshot||this.lastBarConfirmed?0:1)),col:(name:ColumnName)=>s.col(name)};
    const divergenceOverlays=series.filter(line=>line.plot==='line'&&line.divergences?.length)
      .sort((a,b)=>Number(this.selectedDivergenceKey?.startsWith(`${b.indicatorId}:`))-Number(this.selectedDivergenceKey?.startsWith(`${a.indicatorId}:`)))
      .flatMap(line=>{
        const instance=instanceMap.get(line.indicatorId!),targetLayer=layerMap.get(line.indicatorId!);
        if(!instance||!targetLayer||instance.params.showDivergences===false||this.engine.pending&&!this.patternWindowPending)return [];
        this.divergenceRendering.archive+=line.divergences!.length;
        if(densityBudget!==undefined&&line.divergences!.length>densityBudget)this.divergenceRendering.mode='pixel-density';
        const selectedPrefix=`${instance.instanceId}:`,selectedId=this.selectedDivergenceKey?.startsWith(selectedPrefix)?this.selectedDivergenceKey.slice(selectedPrefix.length):undefined;
        const marks=(this.divergenceProjection??=new IndicatorDivergenceProjectionCache()).project(line,instance,divergenceView,this.state.interval,divergenceWindow,this.dataRevision,{maxMarks:densityBudget,selectedId}).filter(mark=>{
          const timeframe=instance.timeframe==='chart'?this.state.interval:instance.timeframe;
          const key=`${targetLayer.paneId}:${instance.id}:${line.plotIndex??0}:${timeframe}:${mark.divergence.direction}:${mark.points.map(p=>`${p.time}:${p.value}`).join(':')}`;
          if(divergenceSeen.has(key))return false;divergenceSeen.add(key);return true;
        });
        this.divergenceRendering.projected+=marks.length;
        return marks.length?[{line,instance,targetLayer,marks}]:[];
      });
    const divergenceTargets=new Set(divergenceOverlays.map(overlay=>overlay.targetLayer.id));
    if(this.maximizedPane&&this.maximizedPane!=='main'&&!this.drawing.document.layers.some(l=>l.paneId===this.maximizedPane&&(l.kind==='indicator'||this.layerStatus(l.id).visible)))this.maximizedPane=null;
    const composition=sceneComposition(activeLayers.filter(l=>!this.maximizedPane||l.paneId===this.maximizedPane).flatMap(layer=>{
      if(layer.kind==='indicator')return series.filter(line=>line.indicatorId===layer.id).map(line=>({...layer,canvas:['markers','patterns','analysis'].includes(line.plot)||divergenceTargets.has(layer.id),gpu:!['markers','patterns','analysis'].includes(line.plot)}));
      if(layer.kind==='overlay'&&['markers','shapes','drawings'].includes(overlayMap.get(layer.id)?.kind??''))return [{...layer,canvas:true,gpu:false}];
      return [layer];
    }));
    const appearance=this.appearance??DEFAULT_APPEARANCE;
    if(appearance.backgroundMode==='gradient')r.begin(appearance.background,composition.needsComposition||appearance.watermark,composition.overlayVisible,appearance.backgroundEnd);
    else r.begin(appearance.background,composition.needsComposition||appearance.watermark,composition.overlayVisible);
    if(!s.length){r.flush();this.rangeMoving=false;this.axisContext.clearRect(0,0,this.width,this.height);this.axes=null;this.panes=[];this.syncPaneControls();return;}
    const target=Math.max(2048,w*1.5);
    const f=this.pyramid.factors.find(f=>v.span/f<=target)??this.pyramid.factors[this.pyramid.factors.length-1];
    const level=this.pyramid.aggLevel(f);
    const col=(key:'open'|'close'|'high'|'low'|'volume')=>level?level[key]:s.col(key);
    const count=level?.length??s.length;
    const from=clamp(Math.floor(v.from/f),0,count),to=clamp(Math.ceil(v.to/f)+1,0,count);
    const paneIds=[...new Set(['main',...doc.layers.filter(l=>l.kind==='indicator'||activeLayers.some(a=>a.id===l.id)).map(l=>l.paneId)])];
    if (this.maximizedPane && !paneIds.includes(this.maximizedPane)) this.maximizedPane = null;
    const layout = this.paneLayout.resolve(paneIds, h);
    let lo=Infinity,hi=-Infinity,volMax=1;
    for(let i=from;i<to;i++){lo=Math.min(lo,col('low')[i]);hi=Math.max(hi,col('high')[i]);volMax=Math.max(volMax,col('volume')[i]);}
    const start=clamp(Math.floor(v.from),0,s.length),end=clamp(Math.ceil(v.to)+1,0,s.length);
    const stride=Math.max(1,Math.ceil((end-start)/Math.max(1,w)));
    const indices:number[]=[];
    for(let i=start;i<end;i+=stride)indices.push(i);
    if(end>start&&indices.at(-1)!==end-1)indices.push(end-1);
    // Decimation must retain divergence endpoints in the mounted curve itself,
    // including auto-range, so zoomed-out annotations never float off its line.
    const divergenceSamples=new Map<string,number[]>();
    for(const overlay of divergenceOverlays){
      const key=overlay.targetLayer.id,extra=divergenceSamples.get(key)??[];
      for(const mark of overlay.marks)for(let at=0;at<mark.points.length;at++){
        const point=mark.points[at],index=mark.indices?.[at]??Math.round(indexForTime(s,point.time,intervals[this.state.interval]));
        if(index>=start&&index<end)extra.push(index);
      }
      divergenceSamples.set(key,extra);
    }
    for(const [key,extra] of divergenceSamples)divergenceSamples.set(key,[...new Set([...indices,...extra])].sort((a,b)=>a-b));
    const samplesFor=(line:DerivedSeries)=>(line.plotIndex??0)===0?divergenceSamples.get(line.indicatorId!)??indices:indices;
    for(const d of series.filter(d=>layerMap.get(d.indicatorId!)?.paneId==='main'))for(const i of samplesFor(d)){const p=d.values[i];if(Number.isFinite(p)){lo=Math.min(lo,p);hi=Math.max(hi,p);}}
    const overlayBounds=new Map<string,{min:number;max:number}>();
    for(const plot of this.overlays){
      if(!plot.id||!this.layerStatus(plot.id).visible)continue;const pane=layerMap.get(plot.id)?.paneId;if(!pane)continue;
      const bounds=overlayBounds.get(pane)??{min:Infinity,max:-Infinity};
      if(plot.kind==='drawings'){for(const d of this.visibleDrawings(plot,start,end))if(d.yloc==='price'){bounds.min=Math.min(bounds.min,d.y1,d.y2);bounds.max=Math.max(bounds.max,d.y1,d.y2);}if(Number.isFinite(bounds.min))overlayBounds.set(pane,bounds);continue;}
      if(plot.kind==='shapes'){for(const shape of this.visibleShapes(plot,start,end))if(shape.location==='absolute'&&shape.value!==null){bounds.min=Math.min(bounds.min,shape.value);bounds.max=Math.max(bounds.max,shape.value);}if(Number.isFinite(bounds.min))overlayBounds.set(pane,bounds);continue;}
      if(plot.kind==='markers'){
        for(const marker of this.visibleOverlayMarkers(plot,start,end,Math.ceil(w/14))){bounds.min=Math.min(bounds.min,marker.value);bounds.max=Math.max(bounds.max,marker.value);}
        if(Number.isFinite(bounds.min))overlayBounds.set(pane,bounds);continue;
      }
      if(plot.kind==='hist'){bounds.min=Math.min(bounds.min,0);bounds.max=Math.max(bounds.max,0);}
      const samples=indices;
      for(const i of samples)for(const value of [plot.values[i-(plot.offset??0)],plot.upper?.[i-(plot.offset??0)]])if(value!==undefined&&Number.isFinite(value)){bounds.min=Math.min(bounds.min,value);bounds.max=Math.max(bounds.max,value);}
      if(Number.isFinite(bounds.min))overlayBounds.set(pane,bounds);
    }
    const mainOverlay=overlayBounds.get('main');if(mainOverlay){lo=Math.min(lo,mainOverlay.min);hi=Math.max(hi,mainOverlay.max);}
    // Inspecting a potential harmonic zone should bring its price band into
    // view. Only the explicitly selected, currently visible candidate affects
    // auto-scale; other forecasts cannot stretch the chart behind the user.
    if(this.selectedCandidateKey)for(const line of series)for(const candidate of line.candidates??[]){
      if(`${line.indicatorId}:${candidate.id}`!==this.selectedCandidateKey||!candidate.zone||instanceMap.get(line.indicatorId!)?.params.showCandidates===false)continue;
      const at=indexForTime(s,candidate.observedAt,intervals[this.state.interval]);
      if(at>=start&&at<end){lo=Math.min(lo,candidate.zone.low);hi=Math.max(hi,candidate.zone.high);}
    }
    if(!Number.isFinite(lo)){const last=s.col('close')[s.length-1];lo=last*.99;hi=last*1.01;}
    const yr=v.autoY(lo,hi);
    this.rangeMoving=false;
    const now=performance.now();
    let panes:Pane[]=layout.map(geometry => {
      const id = geometry.id;
      const lines = series.filter(d=>layerMap.get(d.indicatorId!)?.paneId===id);
      let range: PriceRange;
      if (id === 'main') range = yr;
      else if (id === 'volume') {let max=volMax;for(const line of lines)for(const i of samplesFor(line))if(Number.isFinite(line.values[i]))max=Math.max(max,line.values[i]*f);const bounds=overlayBounds.get(id);range={min:Math.min(0,bounds?.min??0),max:Math.max(max,bounds?.max??0)*1.2};}
      else {
        const bounded=doc.indicators.some(i=>layerMap.get(i.instanceId)?.paneId===id&&['rsi','kdj'].includes(i.id));
        let min=bounded?0:Infinity,max=bounded?100:-Infinity;
        for(const line of lines){if(line.plot==='hist'){min=Math.min(min,0);max=Math.max(max,0);}for(const i of samplesFor(line)){const value=line.values[i];if(Number.isFinite(value)){min=Math.min(min,value);max=Math.max(max,value);}}}
        const bounds=overlayBounds.get(id);if(bounds){min=Math.min(min,bounds.min);max=Math.max(max,bounds.max);}
        if(!Number.isFinite(min)){
          const cached=this.emptyPaneRanges.get(id),previous=this.fitEmptyPanes.has(id)?undefined:this.autoRanges.get(id)?.value;
          const anchors=doc.drawings.filter(d=>d.paneId===id).flatMap(d=>d.points.map(p=>p.value));
          range=cached??(previous?{...previous}:v.autoY(anchors.length?Math.min(...anchors):-1,anchors.length?Math.max(...anchors):1));
          this.emptyPaneRanges.set(id,range);this.fitEmptyPanes.delete(id);
        }else{this.emptyPaneRanges.delete(id);this.fitEmptyPanes.delete(id);range=v.autoY(min,max);}
      }
      const manual=this.manualScales.get(id);
      let motion=this.autoRanges.get(id);
      if(!motion){motion=new RangeMotion(range);this.autoRanges.set(id,motion);}
      if(manual){motion.snap(manual);range=manual;}
      else if(this.drawing.hasGesture||this.drag?.kind==='separator'){range={...motion.value};motion.snap(range);}
      else if(!this.state.smoothMotion){motion.snap(range);}
      else {
        const physics=(this.viewportPhysics??=new ViewportPhysics());
        range=physics.stabilizeAutoRange(id,range,motion.target,geometry.height,this.drag?.kind==='pan'||physics.flinging);
        motion.set(range,now,140);range=motion.step(now);this.rangeMoving ||= motion.active;
      }
      return {...geometry,...range,series:lines};
    });
    if (this.maximizedPane) panes = panes.filter(p => p.id === this.maximizedPane).map(p => ({...p, top: 0, height: h}));
    this.panes=panes;
    this.syncPaneControls();
    const y=(p:number,pane:Pane)=>pane.top+pane.height-(p-pane.min)/(pane.max-pane.min)*pane.height;
    const occupied:MarkerBounds[]=[];
    for(const p of panes){
      const paneStudies=activeLayers.filter(l=>l.paneId===p.id&&l.kind==='indicator').length;
      if(paneStudies>0)occupied.push({left:0,top:p.top,right:Math.min(w*.42,290),bottom:p.top+Math.min(p.height*.48,8+paneStudies*26)});
      occupied.push({left:Math.max(0,w-76),top:p.top,right:w,bottom:p.top+30});
    }
    const paintMarkers=(candidates:ChartMarkerCandidate[],pane:Pane)=>{
      if(!candidates.length)return;
      const bounds={left:0,top:pane.top,right:w,bottom:pane.top+pane.height};
      const layouts=layoutTradeMarkers(candidates.map(candidate=>({...candidate,paintOrder:this.nextHitOrder++})),bounds,{maxMarkers:Math.ceil(w/10),maxLabels:Math.ceil(w/45),occupiedRects:occupied});
      this.markerLayouts.push(...layouts);
      for(const layout of layouts){occupied.push(layout.anchorBounds);if(layout.labelBounds)occupied.push(layout.labelBounds);}
      r.canvasLayer(ctx=>drawTradeMarkers(ctx,layouts,{clipBounds:bounds,tone:deriveOverlaySurface(this.appearance).isLight?'light':'dark'}));
      // canvasLayer resets the backend clip; later outputs retain this pane.
      r.clip(0,pane.top,w,pane.height);
    };
    const candleW=Math.max(1,Math.min(50,v.barWidth*f*.72));
    const live=this.liveBarMotion.sample(now),lastIndex=s.length-1;
    const drawn=(key:'open'|'high'|'low'|'close'|'volume',i:number)=>f===1&&i===lastIndex&&live&&live.bar.time===s.timeAt(lastIndex)?live.bar[key]:col(key)[i];
    const xTicks:AxesInput['xTicks']=[];
    for(let x=55;x<w-45;x+=Math.max(110,w/8)){
      const i=Math.round(v.indexAt(x)),t=i>=0&&i<s.length?s.timeAt(i):timeForIndex(s,i,intervals[this.state.interval]);
      if(Number.isFinite(t))xTicks.push({x,label:fmtTime(t,v.span*intervals[this.state.interval]<86400_000)});
    }
    const last=s.col('close')[s.length-1],main=panes.find(p=>p.id==='main'),lastY=main?y(live?.bar.time===s.timeAt(lastIndex)?live.bar.close:last,main):-1;
    this.axes={ctx:this.ctx,plotW:w,plotH:h,axisW:AXIS_W,axisH:AXIS_H,appearance,
      paneTicks:panes.map(p=>({top:p.top,height:p.height,ticks:niceTicks(p.min,p.max,Math.max(2,p.height/65)).map(value=>({value,y:y(value,p),digits:priceDigits(p.min,p.max)}))})),xTicks,crosshair:null,hoverDot:null,
      lastPrice:this.layerStatus('series:candles').visible&&main&&lastY>=main.top&&lastY<=main.top+main.height?{y:lastY,label:fmtPrice(last,Math.max(2,priceDigits(main.min,main.max))),up:priceBarUp(this.barAt(s.length-1),s.length>1?s.col('close')[s.length-2]:undefined,appearance)}:null};
    if(main&&appearance.watermark)r.canvasLayer(ctx=>drawChartWatermark(ctx,appearance,{...main,width:w},this.state.symbol,this.state.interval));
    // Grid and last-price guides are scene background, not foreground axes.
    // Submit through the existing backend so the normal GPU path stays direct.
    r.clip(0,0,w,h);
    for(const guide of plotGuideSegments(this.axes))r.seg(guide.x0,guide.y0,guide.x1,guide.y1,guide.color,guide.alpha??1);
    const orderState=this.orderFlow?.snapshot();
    const depthProjection=main?{left:0,right:w,top:main.top,bottom:main.top+main.height,min:main.min,max:main.max,
      fromTime:timeForIndex(s,v.from,intervals[this.state.interval]),toTime:timeForIndex(s,v.to,intervals[this.state.interval]),
      timeX:(time:number)=>v.xOf(indexForTime(s,time,intervals[this.state.interval])),priceY:(price:number)=>y(price,main)}:undefined;
    const depthLayer=orderState&&depthProjection&&(orderState.mode==='live'&&!this.historicalSnapshot||this.historicalSnapshot&&this.orderFlowPrices?.store===this.store&&this.orderFlowPrices.id===orderState.archive?.dataset.id)&&(orderState.settings.heatmap||orderState.settings.profile)?prepareDepthOverlay(orderState,depthProjection,{minRebuildMs:LIVE_HEATMAP_REBUILD_MS,now:performance.now()}):undefined;
    this.depthOverlay=depthLayer;this.depthProjection=depthLayer?depthProjection:undefined;
    if(depthLayer&&depthProjection&&orderState?.mode==='live'&&orderState.settings.heatmap)this.orderFlow?.requestDepthHistory?.(depthProjection.fromTime,depthProjection.toTime,depthLayer.priceStep);
    if(depthLayer?.staleForMs&&!this.depthRepaintTimer)this.depthRepaintTimer=setTimeout(()=>{this.depthRepaintTimer=undefined;this.dirty=true;},depthLayer.staleForMs+1);
    if(depthLayer&&main&&orderState){
      r.setOpacity(1);r.clip(0,main.top,w,main.height);drawDepthHeatmap(r,depthLayer,orderState.settings.opacity,{bid:appearance.upColor,ask:appearance.downColor},orderState.settings);this.depthCellSource=orderState.settings.heatmap?depthLayer:[];
    }else this.depthCells=[];
    for(const layer of activeLayers){
      const pane=panes.find(p=>p.id===layer.paneId);if(!pane)continue;
      const status=this.layerStatus(layer.id);r.setOpacity(status.opacity);
      if(layer.kind==='drawing'){r.canvasLayer(ctx=>this.drawing.renderObject(ctx,layer.id));continue;}
      r.clip(0,pane.top,w,pane.height);
      if(layer.kind==='series'){
        let previousPoint:{x:number;y:number}|null=null;
        for(let i=layer.id==='series:candles'&&appearance.chartType==='line'?Math.max(0,from-1):from;i<to;i++){
          const base=i*f,right=Math.min(s.length,base+f),x=v.xOf((base+right-1)/2);
          const bar={open:drawn('open',i),high:drawn('high',i),low:drawn('low',i),close:drawn('close',i)},previousClose=i>0?col('close')[i-1]:undefined;
          const color=priceBarUp(bar,previousClose,appearance)?appearance.upColor:appearance.downColor;
          const half=candleW*(f===1&&i===lastIndex?live?.reveal??1:1)/2;
          if(layer.id==='series:candles'){
            if(appearance.chartType==='line'){
              const yy=y(bar.close,pane);
              if(Number.isFinite(yy)){if(previousPoint)r.seg(previousPoint.x,previousPoint.y,x,yy,appearance.lineColor,1,appearance.lineWidth);else r.rect(x-.5,yy-.5,x+.5,yy+.5,appearance.lineColor);previousPoint={x,y:yy};}else previousPoint=null;
            }else paintPriceBar(r,bar,previousClose,x,half,value=>y(value,pane),appearance);
          }else if(layer.id==='series:volume')r.rect(x-half,y(drawn('volume',i),pane),x+half,y(0,pane),color,appearance.volumeOpacity);
        }
      }else if(layer.kind==='indicator'){
        const overlaySurface=deriveOverlaySurface(appearance);
        for(const line of pane.series.filter(d=>d.indicatorId===layer.id)){
          const style=instanceMap.get(layer.id)?.plotStyles?.[line.plotIndex??0],rawColor=style?.color??line.color;
          const color=readableSurfaceColor(rawColor,appearance.background,3.6);
          if(line.plot==='analysis'){
            const instance=instanceMap.get(layer.id)!,observations=this.visibleObservations(instance,line.observations??[]).filter(o=>!this.manuallyHidden('analysis',layer.id,o.id)),bounds={left:0,top:pane.top,right:w,bottom:pane.top+pane.height};
            r.canvasLayer(ctx=>this.analysisHits.push(...drawAnalysis(ctx,observations,{instanceId:layer.id,color,colorOverride:style?.color,width:style?.width??1,labelMode:String(instance.params.labelMode??'compact'),opacity:status.opacity,selectedId:observations.find(o=>`${layer.id}:${o.id}`===this.selectedAnalysisKey)?.id,labels:instance.params.showLabels!==false,zones:instance.params.showZones!==false,targets:false,project:(time,value)=>({x:v.xOf(indexForTime(s,time,intervals[this.state.interval])),y:y(value,pane)}),bounds,barWidth:v.barWidth,occupied,surface:overlaySurface})));
            r.clip(0,pane.top,w,pane.height);continue;
          }
          if(line.plot==='patterns'){
            const instance=instanceMap.get(layer.id)!,bounds={left:0,top:pane.top,right:w,bottom:pane.top+pane.height};
            if(line.candidates&&instance.params.showCandidates!==false){
              r.canvasLayer(ctx=>this.candidateHits.push(...drawPatternCandidates(ctx,line.candidates??[],{
                instanceId:layer.id,color,width:style?.width??1,opacity:status.opacity,
                selectedId:line.candidates?.find(c=>`${layer.id}:${c.id}`===this.selectedCandidateKey)?.id,
                labels:instance.params.showLabels!==false,zones:instance.params.showZones!==false,targets:false,
                project:(time,value)=>({x:v.xOf(indexForTime(s,time,intervals[this.state.interval])),y:y(value,pane)}),bounds,barWidth:v.barWidth,occupied,surface:overlaySurface,
              })));
              r.clip(0,pane.top,w,pane.height);
            }
            const ids=this.patternDisplayIds(instance),patterns=(line.patterns??[]).filter(p=>ids.has(p.id)&&!this.manuallyHidden('pattern',layer.id,p.id));
            r.canvasLayer(ctx=>this.patternHits.push(...drawPatterns(ctx,patterns,{
              instanceId:layer.id,color,width:style?.width??1.5,opacity:status.opacity,
              selectedId:line.patterns?.find(p=>`${layer.id}:${p.id}`===this.selectedPatternKey)?.id,
              labels:instance.params.showLabels!==false,zones:instance.params.showZones!==false,targets:instance.params.showTargets===true,
              project:(time,value)=>({x:v.xOf(indexForTime(s,time,intervals[this.state.interval])),y:y(value,pane)}),
              bounds,barWidth:v.barWidth,occupied,surface:overlaySurface,
            })));
            r.clip(0,pane.top,w,pane.height);continue;
          }
          if(line.plot==='markers'){
            const all=this.studyMarkers.get(`${line.indicatorId}:${line.plotIndex??0}`)?.indices??[];
            const side=line.markerSide??'buy';
            const provenance=studySignalProvenance(instanceMap.get(layer.id),side);
            paintMarkers(this.sliceMarkers(all,Math.max(0,start-2),end+2,Math.ceil(w/14)).map(i=>{
              const anchored=Number.isFinite(line.markerOffsets?.[i])&&Number.isFinite(line.markerValues?.[i]),index=anchored?i+line.markerOffsets![i]:i,value=anchored?line.markerValues![i]:line.values[i];
              return {id:`${layer.id}:${line.plotIndex}:${i}`,paneId:pane.id,sourceLayerId:layer.id,sourceName:this.layerDisplayName(layer),...provenance,x:v.xOf(index),y:y(value,pane),value,time:timeForIndex(s,index,intervals[this.state.interval]),side,kind:'signal' as const,signalKind:anchored?(side==='buy'?'crossover' as const:'crossunder' as const):undefined,color:style?.color,opacity:status.opacity,label:line.name};
            }),pane);
            continue;
          }
          let prev:{x:number;y:number}|null=null;
          for(const i of samplesFor(line)){
            const value=line.values[i]*(pane.id==='volume'?f:1);if(!Number.isFinite(value)){prev=null;continue;}
            const x=v.xOf(i),yy=y(value,pane);
            if(line.plot==='hist')r.rect(x,Math.min(y(0,pane),yy),x+Math.max(1,v.barWidth*stride*.7),Math.max(y(0,pane),yy),style?.color??(value>=0?appearance.upColor:appearance.downColor),.65);
            else if(prev)r.seg(prev.x,prev.y,x,yy,color,1,style?.width??1);
            prev={x,y:yy};
          }
        }
        // Paint after every line in this oscillator layer, including its DIF/
        // DEA/histogram siblings; their visibility and scales remain unchanged.
        for(const overlay of divergenceOverlays.filter(value=>value.targetLayer.id===layer.id)){
          const style=overlay.instance.plotStyles?.[overlay.line.plotIndex??0];
          r.canvasLayer(ctx=>this.divergenceHits.push(...drawIndicatorDivergences(ctx,overlay.marks,{
            instanceId:overlay.instance.instanceId,bullishColor:appearance.upColor,bearishColor:appearance.downColor,width:style?.width??1.5,
            opacity:status.opacity,
            selectedId:overlay.marks.find(mark=>`${overlay.instance.instanceId}:${mark.divergence.id}`===this.selectedDivergenceKey)?.divergence.id,
            labels:overlay.instance.params.showDivergenceLabels!==false,
            project:(time,value)=>({x:v.xOf(indexForTime(s,time,intervals[this.state.interval])),y:y(value,pane)}),
            bounds:{left:0,top:pane.top,right:w,bottom:pane.top+pane.height},occupied,surface:overlaySurface,
          })));
          r.clip(0,pane.top,w,pane.height);
        }
      }else if(layer.kind==='overlay'){
        const plot=overlayMap.get(layer.id);if(!plot)continue;
        if(plot.kind==='drawings'){
          const bounds={left:0,top:pane.top,right:w,bottom:pane.top+pane.height};
          const objects=this.visibleDrawings(plot,start,end).map(d=>{const index=Math.max(0,Math.min(s.length-1,Math.round(d.index1))),value=d.yloc==='abovebar'?s.col('high')[index]:d.yloc==='belowbar'?s.col('low')[index]:d.y1;return {drawing:d,opacity:status.opacity,x1:v.xOf(d.index1),y1:y(value,pane),x2:v.xOf(d.index2),y2:y(d.y2,pane)};});
          r.canvasLayer(ctx=>{const hits=drawOverlayDrawings(ctx,objects,bounds);for(const hit of hits){this.objectHits.push({...hit,title:this.layerDisplayName(layer),paintOrder:this.nextHitOrder++});occupied.push(hit.bounds);}});r.clip(0,pane.top,w,pane.height);continue;
        }
        if(plot.kind==='shapes'){
          const bounds={left:0,top:pane.top,right:w,bottom:pane.top+pane.height};
          const candidates:ChartShapeCandidate[]=this.visibleShapes(plot,start,end).map(shape=>{
            const targetIndex=Math.max(0,Math.min(s.length-1,shape.index));
            const value=shape.location==='absolute'?shape.value!:shape.location==='abovebar'?s.col('high')[targetIndex]:shape.location==='belowbar'?s.col('low')[targetIndex]:shape.location==='top'?pane.max:pane.min;
            return {...shape,value,x:v.xOf(shape.index),y:shape.location==='top'?pane.top:shape.location==='bottom'?pane.top+pane.height:y(value,pane),opacity:status.opacity,paneId:pane.id,title:this.layerDisplayName(layer),paintOrder:this.nextHitOrder++};
          });
          this.ctx.font=OVERLAY_SHAPE_FONT;
          const layouts=layoutOverlayShapes(candidates,bounds,{measureText:text=>this.ctx.measureText(text).width});this.shapeLayouts.push(...layouts);for(const layout of layouts)occupied.push(layout.hitBounds);
          r.canvasLayer(ctx=>drawOverlayShapes(ctx,layouts,{clipBounds:bounds}));r.clip(0,pane.top,w,pane.height);continue;
        }
        if(plot.kind==='markers'){
          paintMarkers(this.visibleOverlayMarkers(plot,start,end,Math.ceil(w/14)).map((marker,index)=>({id:`${layer.id}:${index}:${marker.time}`,paneId:pane.id,sourceLayerId:layer.id,sourceName:this.layerDisplayName(layer),sourceTag:'信号',x:v.xOf(marker.index),y:y(marker.value,pane),side:marker.side,kind:'signal' as const,opacity:status.opacity,time:marker.time,value:marker.value,signalKind:marker.signalKind,label:marker.label})),pane);continue;
        }
        let prev:{x:number;y:number}|null=null;const points=indices;
        for(const i of points){
          const at=i-(plot.offset??0),color=plot.colors?.[at]??plot.color,value=plot.values[at];if(!Number.isFinite(value)){prev=null;continue;}const x=v.xOf(i),yy=y(value,pane);
          if(plot.kind==='hist')r.rect(x,Math.min(yy,y(0,pane)),x+Math.max(1,v.barWidth*stride*.7),Math.max(yy,y(0,pane)),color,.65);
          else if(plot.kind==='band'&&Number.isFinite(plot.upper?.[at]))r.rect(x,Math.min(yy,y(plot.upper![at],pane)),x+v.barWidth*stride,Math.max(yy,y(plot.upper![at],pane)),plot.color,.15);
          else if(plot.kind==='line'&&prev)r.seg(prev.x,prev.y,x,yy,color,1,plot.width??1);prev={x,y:yy};
        }
      }
    }
    if(depthLayer&&depthProjection&&orderState){r.setOpacity(1);r.clip(0,depthProjection.top,w,depthProjection.bottom-depthProjection.top);drawDepthProfile(r,depthLayer,depthProjection,orderState.settings.opacity,{bid:appearance.upColor,ask:appearance.downColor},orderState.settings);}
    r.flush();
    drawAxesBase({...this.axes,ctx:this.axisContext,plotGuides:false});
    this.state.rendered=to-from;this.state.factor=f;
  }

  private visibleDrawings(plot:OverlayPlot,start:number,end:number):readonly OverlayDrawing[]{return (plot.drawings??[]).filter(d=>Math.max(d.index1,d.index2)>=start-3&&Math.min(d.index1,d.index2)<=end+3);}
  private visibleShapes(plot:OverlayPlot,start:number,end:number):readonly OverlayShape[]{
    const shapes=plot.shapes??[],bound=(value:number)=>{let a=0,b=shapes.length;while(a<b){const m=(a+b)>>>1;if(shapes[m].index<value)a=m+1;else b=m;}return a;};
    return shapes.slice(bound(start-2),bound(end+2));
  }
  private visibleMarkers(plot:OverlayPlot,start:number,end:number,width:number):number[] {
    return this.sliceMarkers(this.markerIndices.get(plot)??[],start,end,width);
  }
  private visibleOverlayMarkers(plot:OverlayPlot,start:number,end:number,limit:number):OverlayMarker[] {
    if(!plot.markers)return this.visibleMarkers(plot,start,end,limit).map(index=>({index,value:plot.values[index-(plot.offset??0)],side:plot.side![index-(plot.offset??0)]>0?'buy':'sell',time:timeForIndex(this.store,index,intervals[this.state.interval])}));
    const values=plot.markers,bound=(value:number)=>{let a=0,b=values.length;while(a<b){const middle=(a+b)>>>1;if(values[middle].index<value)a=middle+1;else b=middle;}return a;};
    const a=bound(start),b=bound(end),count=Math.min(b-a,Math.max(1,Math.floor(limit))),out:OverlayMarker[]=[];
    for(let i=0;i<count;i++)out.push(values[count===1?b-1:a+Math.floor(i*(b-a-1)/(count-1))]);
    return out;
  }
  private syncMarkerTooltip():void {
    this.depthTable=undefined;
    const tooltip=this.markerTooltip;if(!tooltip)return;
    const pointer=this.pointer;
    const divergence=pointer&&!this.drag&&!this.drawing.hasGesture&&!this.drawing.drawingMode?hitPattern(this.divergenceHits??[],pointer):undefined;
    if(divergence){
      const d=divergence.divergence,instance=this.drawing.document.indicators.find(i=>i.instanceId===divergence.instanceId),timeframe=instance?.timeframe==='chart'?this.state.interval:instance?.timeframe??this.state.interval;
      const key=`divergence:${divergence.instanceId}:${d.id}:${d.confirmedAt}:${d.points.map(p=>p.value).join(':')}`;
      if(key!==this.markerTooltipKey){
        const title=document.createElement('strong');title.textContent=divergenceLabel(d);
        const lines=[tr('独立指标背离 · {0}',{0:timeframe}),tr('价格：{0} → {1}',{0:formatSeriesValue(d.points[0].price,true),1:formatSeriesValue(d.points[1].price,true)}),tr('指标：{0} → {1}',{0:formatSeriesValue(d.points[0].value,true),1:formatSeriesValue(d.points[1].value,true)}),tr('确认时间：{0}',{0:fmtDateTime(d.confirmedAt)}),tr('单击选中指标 · 双击设置')];
        tooltip.replaceChildren(title,...lines.map(text=>{const line=document.createElement('div');line.textContent=text;return line;}));tooltip.style.display='block';this.markerTooltipSize={width:tooltip.offsetWidth,height:tooltip.offsetHeight};this.markerTooltipKey=key;
      }
      tooltip.style.display='block';tooltip.style.transform=`translate(${clamp(pointer!.x+14,4,Math.max(4,this.viewport.plotW-this.markerTooltipSize.width-4))}px,${clamp(pointer!.y+14,4,Math.max(4,this.height-AXIS_H-this.markerTooltipSize.height-4))}px)`;return;
    }
    const analytical=pointer&&!this.drag&&!this.drawing.hasGesture&&!this.drawing.drawingMode?hitAnalysis(this.analysisHits??[],pointer):undefined;
    if(analytical){
      const o=analytical.observation,status=analysisStatus(o),key=`analysis:${analytical.instanceId}:${o.id}:${status.key}:${o.phase??''}:${o.throughTime}`;
      if(key!==this.markerTooltipKey){const title=document.createElement('strong');title.textContent=`${tc(o.name)} · ${tc(status.label)}`;
        const lines=[status.description,analysisGuide(o).description,...(o.zone?[tr('区域 {0} – {1}',{0:formatSeriesValue(o.zone.low,true),1:formatSeriesValue(o.zone.high,true)})]:[]),`首次可知 ${fmtDateTime(o.availableAt)}`,o.phase??'', '单击查看证据与反证 · 双击设置'];tooltip.replaceChildren(title,...lines.filter(Boolean).map(text=>{const el=document.createElement('div');el.textContent=tc(text);return el;}));tooltip.style.display='block';this.markerTooltipSize={width:tooltip.offsetWidth,height:tooltip.offsetHeight};this.markerTooltipKey=key;}
      tooltip.style.display='block';tooltip.style.transform=`translate(${clamp(pointer!.x+14,4,Math.max(4,this.viewport.plotW-this.markerTooltipSize.width-4))}px,${clamp(pointer!.y+14,4,Math.max(4,this.height-AXIS_H-this.markerTooltipSize.height-4))}px)`;return;
    }
    const candidate=pointer&&!this.drag&&!this.drawing.hasGesture&&!this.drawing.drawingMode?hitPattern(this.candidateHits??[],pointer):undefined;
    if(candidate){
      const c=candidate.candidate,key=`candidate:${candidate.instanceId}:${c.id}:${c.observedAt}:${c.zone?.low}:${c.zone?.high}`;
      if(key!==this.markerTooltipKey){
        const title=document.createElement('strong');title.textContent=`${tr('观察中')} · ${tc(c.name)} · ${tr('尚未确认')}`;
        const lines=[c.description,`行情评估至 ${fmtDateTime(c.observedAt)}`,c.zone?`潜在区域 ${formatSeriesValue(c.zone.low,true)} – ${formatSeriesValue(c.zone.high,true)}`:'边界内整理中，尚未收盘突破','单击查看观察依据 · 不代表买卖信号'];
        tooltip.replaceChildren(title,...lines.map(text=>{const line=document.createElement('div');line.textContent=tc(text);return line;}));
        tooltip.style.display='block';this.markerTooltipSize={width:tooltip.offsetWidth,height:tooltip.offsetHeight};this.markerTooltipKey=key;
      }
      tooltip.style.display='block';tooltip.style.transform=`translate(${clamp(pointer!.x+14,4,Math.max(4,this.viewport.plotW-this.markerTooltipSize.width-4))}px,${clamp(pointer!.y+14,4,Math.max(4,this.height-AXIS_H-this.markerTooltipSize.height-4))}px)`;return;
    }
    const pattern=pointer&&!this.drag&&!this.drawing.hasGesture&&!this.drawing.drawingMode?hitPattern(this.patternHits??[],pointer):undefined;
    if(pattern){
      const p=pattern.pattern,key=`pattern:${pattern.instanceId}:${p.id}:${p.status}:${p.stage??''}:${p.events?.length??0}:${p.dataWarning??''}:${p.resolution?.knownAt??''}`;
      if(key!==this.markerTooltipKey){
        const title=document.createElement('strong');title.textContent=`${tc(p.name)} · ${tc(patternStageLabel(p))}`;
        const lines=[`${p.direction==='bullish'?'历史向上确认':'历史向下确认'} · ${fmtDateTime(p.confirmedAt)}`,...(p.events??[]).map(event=>`${patternEventLabel(p,event)} ${fmtDateTime(event.knownAt)} · ${formatSeriesValue(event.value,true)}`),p.stage==='failed-breakout'&&!p.resolution?'已收回颈线或边界内，原突破不再计入当前成立结构。':'',p.dataWarning??'',`初次结构区间 ${formatSeriesValue(p.zone.low,true)} – ${formatSeriesValue(p.zone.high,true)}`,`失效参考 ${formatSeriesValue(p.invalidation,true)}`,...p.ratios.map(r=>`${r.label} ${r.value.toFixed(3)} (${r.expected})`),'单击查看识别依据 · 双击设置参数'];
        tooltip.replaceChildren(title,...lines.filter(Boolean).map(text=>{const el=document.createElement('div');el.textContent=tc(text);return el;}));
        tooltip.style.display='block';this.markerTooltipSize={width:tooltip.offsetWidth,height:tooltip.offsetHeight};this.markerTooltipKey=key;
      }
      tooltip.style.display='block';tooltip.style.transform=`translate(${clamp(pointer!.x+14,4,Math.max(4,this.viewport.plotW-this.markerTooltipSize.width-4))}px,${clamp(pointer!.y+14,4,Math.max(4,this.height-AXIS_H-this.markerTooltipSize.height-4))}px)`;return;
    }
    const hit=pointer&&!this.drag&&!this.drawing.hasGesture&&!this.drawing.drawingMode?[...this.markerLayouts].reverse().find(item=>pointer.x>=item.hitBounds.left&&pointer.x<=item.hitBounds.right&&pointer.y>=item.hitBounds.top&&pointer.y<=item.hitBounds.bottom):undefined;
    const shape=pointer&&!this.drag&&!this.drawing.hasGesture&&!this.drawing.drawingMode?[...this.shapeLayouts].reverse().find(item=>pointer.x>=item.hitBounds.left&&pointer.x<=item.hitBounds.right&&pointer.y>=item.hitBounds.top&&pointer.y<=item.hitBounds.bottom):undefined;
    const drawing=pointer&&!this.drag&&!this.drawing.hasGesture&&!this.drawing.drawingMode?[...(this.objectHits??[])].reverse().find(item=>pointer.x>=item.bounds.left&&pointer.x<=item.bounds.right&&pointer.y>=item.bounds.top&&pointer.y<=item.bounds.bottom):undefined;
    if(drawing&&drawing.paintOrder>Math.max(shape?.candidate.paintOrder??-1,hit?.candidate.paintOrder??-1)){
      const d=drawing.drawing,key=`drawing:${drawing.title}:${d.id}`;
      if(key!==this.markerTooltipKey){const title=document.createElement('strong'),body=document.createElement('div');title.textContent=drawing.title;body.textContent=d.tooltip||d.text||tr('外部叠加');tooltip.replaceChildren(title,body);tooltip.style.display='block';this.markerTooltipSize={width:tooltip.offsetWidth,height:tooltip.offsetHeight};this.markerTooltipKey=key;}
      tooltip.style.display='block';tooltip.style.transform=`translate(${clamp(pointer!.x+14,4,Math.max(4,this.viewport.plotW-this.markerTooltipSize.width-4))}px,${clamp(pointer!.y+14,4,Math.max(4,this.height-AXIS_H-this.markerTooltipSize.height-4))}px)`;return;
    }
    if(shape&&(!hit||shape.candidate.paintOrder>(hit.candidate.paintOrder??-1))){
      const item=shape.candidate,key=`shape:${item.title}:${item.index}:${item.text}:${item.shape}`;
      if(key!==this.markerTooltipKey){const title=document.createElement('strong'),text=document.createElement('div'),position=document.createElement('div');title.textContent=item.title;text.textContent=`${tr('图形')} · ${item.text||item.shape}`;position.textContent=`${fmtDateTime(item.time)} · ${item.location}${item.offset?' · '+tr('偏移 {0} 根',{0:item.offset}):''}`;tooltip.replaceChildren(title,text,position);tooltip.style.display='block';this.markerTooltipSize={width:tooltip.offsetWidth,height:tooltip.offsetHeight};this.markerTooltipKey=key;}
      tooltip.style.display='block';tooltip.style.transform=`translate(${clamp(pointer!.x+14,4,Math.max(4,this.viewport.plotW-this.markerTooltipSize.width-4))}px,${clamp(pointer!.y+14,4,Math.max(4,this.height-AXIS_H-this.markerTooltipSize.height-4))}px)`;return;
    }
    if(!hit){
      tooltip.style.display='none';this.markerTooltipKey='';
      // Nothing more specific under the pointer: over drawn heatmap columns,
      // show the price × time neighborhood table (drawn on the overlay).
      const main=this.panes.find(p=>p.id==='main');
      if(pointer&&!this.drag&&!this.drawing.hasGesture&&!this.drawing.drawingMode&&main&&this.depthCells.length&&pointer.y>=main.top&&pointer.y<=main.top+main.height){
        const table=this.depthOverlay?.crossSection?.(pointer.x,pointer.y);
        if(table)this.depthTable={table,pointer:{...pointer}};
      }
      return;
    }
    const marker=hit.candidate,key=`${marker.id??`${marker.side}:${marker.time}`}:${marker.sourceName??''}:${marker.trigger??''}`;
    if(key!==this.markerTooltipKey){
      const surface=deriveOverlaySurface(this.appearance??DEFAULT_APPEARANCE);
      const title=document.createElement('strong'),position=document.createElement('div'),time=document.createElement('div');
      title.textContent=`${tr(marker.side==='buy'?'买入':'卖出')} · ${tr(marker.signalKind==='crossover'?'上穿信号':marker.signalKind==='crossunder'?'下穿信号':'确认信号')}`;
      title.style.color=readableSurfaceColor(marker.side==='buy'?(this.appearance?.upColor??'#26a69a'):(this.appearance?.downColor??'#ef5350'),surface.surfaceSolid,4.8);
      position.textContent=`${tr(marker.signalKind?'曲线交点（插值）':'标记位置')} ${formatSeriesValue(marker.value,true)}`;
      time.textContent=fmtDateTime(marker.time);time.style.color=surface.glassTextMuted;
      tooltip.replaceChildren(title,position,time);
      if(marker.trigger){const trigger=document.createElement('div');trigger.textContent=tc(marker.trigger);tooltip.insertBefore(trigger,position);}
      if(marker.sourceName){
        const role=this.drawing.document.layers.find(layer=>layer.id===marker.sourceLayerId)?.kind==='indicator'?'指标':'外部叠加';
        const source=document.createElement('div');source.textContent=tr('来源：{0} · {1}',{0:marker.sourceName,1:tr(role)});tooltip.insertBefore(source,position);
      }
      tooltip.style.display='block';this.markerTooltipSize={width:tooltip.offsetWidth,height:tooltip.offsetHeight};this.markerTooltipKey=key;
    }
    tooltip.style.display='block';tooltip.style.transform=`translate(${clamp(pointer!.x+14,4,Math.max(4,this.viewport.plotW-this.markerTooltipSize.width-4))}px,${clamp(pointer!.y+14,4,Math.max(4,this.height-AXIS_H-this.markerTooltipSize.height-4))}px)`;
  }
  private sliceMarkers(all:number[],start:number,end:number,width:number):number[]{
    const bound=(n:number)=>{let a=0,b=all.length;while(a<b){const m=(a+b)>>>1;if(all[m]<n)a=m+1;else b=m;}return a;};
    const a=bound(start),b=bound(end),step=Math.max(1,Math.ceil((b-a)/Math.max(1,width)));
    const out:number[]=[];for(let i=a;i<b;i+=step)out.push(all[i]);return out;
  }

  private indexStudyMarkers(update:{from:number;length:number}):void {
    const active=new Set<string>();
    for(const series of this.engine.derived){
      if(series.plot!=='markers')continue;
      const key=`${series.indicatorId}:${series.plotIndex??0}`;active.add(key);
      let cache=this.studyMarkers.get(key);
      if(!cache||cache.values!==series.values||update.from===0||update.length<cache.length){cache={values:series.values,length:0,indices:[]};this.studyMarkers.set(key,cache);}
      const start=Math.max(0,Math.min(update.from,cache.length)),length=Math.min(update.length,series.values.length);
      while(cache.indices.length&&cache.indices.at(-1)!>=start)cache.indices.pop();
      for(let i=start;i<length;i++)if(Number.isFinite(series.values[i]))cache.indices.push(i);
      cache.length=length;
    }
    for(const key of this.studyMarkers.keys())if(!active.has(key))this.studyMarkers.delete(key);
  }

  private onIndicatorUpdate(range:{from:number;length:number}):void {
    if(this.dead)return;
    this.indexStudyMarkers(range);this.dataRevision++;this.dirty=true;
    this.state.indicatorsPending=this.engine.pending;
    if(!this.engine.pending)this.patternWindowPending=false;
  }

  private drawOverlay():void {
    const a=this.axes,c=this.ctx,v=this.viewport;
    if(!a){c.clearRect(0,0,this.width,this.height);if(this.markerTooltip)this.markerTooltip.style.display='none';return;}
    this.syncMarkerTooltip();
    this.refreshMagnetFeedback();const point=this.magnetGuide?.target?.pixel??this.pointer;
    a.crosshair=null;a.hoverDot=null;
    let index=this.store.length-1;
    if(point&&this.store.length&&this.drawing.crosshair){
      const i=Math.round(v.indexAt(point.x)),inRange=i>=0&&i<this.store.length;
      const p=this.panes.find(p=>point.y>=p.top&&point.y<p.top+p.height);
      if(p){
        index=clamp(i,0,this.store.length-1);
        const x=clamp(v.xOf(i),0,v.plotW),value=this.magnetGuide?.target?.anchor.value??p.max-(point.y-p.top)/p.height*(p.max-p.min);
        const time=inRange?this.store.timeAt(i):timeForIndex(this.store,i,intervals[this.state.interval]);
        a.crosshair={x,y:point.y,price:fmtPrice(value,p.id==='main'?Math.max(2,priceDigits(p.min,p.max)):priceDigits(p.min,p.max)),time:fmtDateTime(time)};
        const main=this.panes.find(p=>p.id==='main');
        if(inRange&&main&&this.layerStatus('series:candles').visible){const y=main.top+main.height-(this.store.col('close')[i]-main.min)/(main.max-main.min)*main.height;
          if(y>=0&&y<=main.height)a.hoverDot={x,y};}
      }
    }
    c.clearRect(0,0,this.width,this.height);
    const orderState=this.orderFlow?.snapshot();
    if(this.depthOverlay&&this.depthProjection&&orderState?.settings.crossSection){
      const unitLabel=orderState.settings.unit==='quote'?'USD':(this.state.contract?.baseAsset||this.state.symbol.replace(/USDT$|USDC$|USD$/,'')||'COIN');
      drawDepthCrossSection(c,this.depthOverlay,this.depthProjection,this.pointer,unitLabel,orderState.settings.theme,deriveOverlaySurface(this.appearance).isLight?'light':'dark');
    }
    drawCrosshair(a);
    this.drawing.ink=this.canvasInk??DEFAULT_CANVAS_INK;this.drawing.render(c);
    this.drawMagnetFeedback(c);
    if(this.depthTable&&this.depthOverlay&&orderState?.settings.heatmap){
      const main=this.panes.find(p=>p.id==='main'),settings=orderState.settings,intensity=depthHeatmapIntensity(this.depthOverlay,settings);
      const unit=settings.unit==='quote'?(this.state.contract?.quoteCurrency??'USDT'):(this.state.contract?.baseAsset??this.state.symbol.replace(/USDT$/,''));
      const time=this.depthTable.table.times[this.depthTable.table.centerColumn],digits=Math.max(0,Math.min(8,Math.ceil(-Math.log10(this.depthTable.table.step)+1e-9)));
      if(main)drawDepthCrossTable(c,this.depthTable.table,this.depthTable.pointer,{left:0,top:main.top,right:v.plotW,bottom:main.top+main.height},{
        tone:deriveOverlaySurface(this.appearance).isLight?'light':'dark',theme:settings.theme,threshold:intensity.threshold,ceiling:intensity.ceiling,
        formatPrice:price=>price.toFixed(Math.max(2,digits)),formatQuantity:formatDepthQuantity,
        caption:`${time!==null&&time!==undefined?fmtDateTime(time):''} · ${unit}`});
    }
    const appearance=this.appearance??DEFAULT_APPEARANCE,surface=deriveOverlaySurface(appearance);
    c.fillStyle=appearance.separatorColor;c.fillRect(v.plotW,0,1,a.plotH);
    for(const p of this.panes){
      if(this.interactiveStudyLabels&&this.drawing.document.layers.some(l=>l.kind==='indicator'&&l.paneId===p.id))continue;
      c.save();c.beginPath();c.rect(0,p.top,Math.max(0,v.plotW-95),p.height);c.clip();
      c.font='11px ui-monospace, monospace';c.textBaseline='middle';
      let x=10;const title=p.id==='main'?'':this.paneName(p.id);
      if(title){c.fillStyle=surface.canvasLabelText;c.fillText(title,x,p.top+12);x+=c.measureText(title).width+15;}
      for(const d of p.series){const value=d.values[index],suffix=d.timeframe&&d.timeframe!=='chart'?` · ${d.timeframe}`:'',text=`${d.name}${suffix}  ${formatSeriesValue(value,p.id==='main')}`;
        const width=c.measureText(text).width;c.fillStyle=surface.canvasLabelBg;c.fillRect(x-3,p.top+3,width+6,17);c.fillStyle=readableSurfaceColor(d.color,surface.surfaceSolid,4.6);c.fillText(text,x,p.top+12);x+=width+18;}
      c.restore();
    }
    if(this.state.visible===0&&!this.state.loading){c.fillStyle=surface.canvasLabelText;c.textAlign='center';c.fillText(tr('当前区间无数据 · 按 End 返回最新'),v.plotW/2,a.plotH/2);c.textAlign='left';}
  }

  focus():void {this.host.focus();}
  get magnetFeedback():MagnetFeedback|null{return this.magnetGuide?structuredClone(this.magnetGuide):null;}
  get maximizedPaneId():string|null{return this.maximizedPane;}
  contextTargetAt(pixel:Pixel):ChartContextTarget|null {
    const hit=this.hitTest(pixel.x,pixel.y);if(!hit)return null;
    const paneId=hit.kind==='time'?'main':hit.kind==='separator'?this.panes[hit.boundary].id:hit.pane.id;
    const region=hit.kind==='pan'?'plot':hit.kind;
    return {paneId,region,drawingId:region==='plot'?this.drawing.hitDrawing(pixel,paneId)?.id??null:null,
      anchor:region==='plot'||region==='price'?this.drawingAnchor(pixel,paneId,false):null,maximized:this.maximizedPane===paneId};
  }
  cancelInteractionForMenu():void {
    this.flushPointer();this.cancelDrag();this.drawing.cancel();this.pendingPointer=null;this.pointer=null;this.magnetPointer=null;this.magnetGuide=null;
    this.onDrawingSelection(null);this.overlayDirty=true;
  }
  private projectionCache=new Map<string,{key:string;projection:Projection}>();
  private drawingProjection(id:string):Projection|null {
    const pane=this.panes.find(p=>p.id===id);if(!pane||!this.store.length)return null;
    const interval=intervals[this.state.interval];
    const key=`${this.generation}:${this.store.length}:${this.viewport.from}:${this.viewport.to}:${this.viewport.plotW}:${pane.top}:${pane.height}:${pane.min}:${pane.max}`;
    const cached=this.projectionCache.get(id);if(cached?.key===key)return cached.projection;
    const projection:Projection={pane:{id,top:pane.top,height:pane.height,width:this.viewport.plotW},
      project:anchor=>({x:this.viewport.xOf(indexForTime(this.store,anchor.time,interval)),y:pane.top+pane.height-(anchor.value-pane.min)/(pane.max-pane.min)*pane.height}),
      indexAt:time=>indexForTime(this.store,time,interval)};
    this.projectionCache.set(id,{key,projection});return projection;
  }
  private drawingAnchor(pixel:Pixel,id:string,snap:boolean,strength:MagnetStrength='weak'):Anchor|null {
    const pane=this.panes.find(p=>p.id===id);if(!pane||!this.store.length)return null;
    const x=clamp(pixel.x,0,this.viewport.plotW),y=clamp(pixel.y,pane.top,pane.top+pane.height),index=this.viewport.indexAt(x);
    const anchor={time:timeForIndex(this.store,index,intervals[this.state.interval]),value:pane.max-(y-pane.top)/pane.height*(pane.max-pane.min)};
    const target=snap?this.magnetAt(pixel,id,strength)?.target:null;
    if(target)return {...target.anchor};
    return anchor;
  }
  private magnetAt(pixel:Pixel,id:string,strength:MagnetStrength):MagnetFeedback|null {
    const pane=this.panes.find(p=>p.id===id);
    if(id!=='main'||!pane||!this.store?.length||pixel.x<0||pixel.x>=this.viewport.plotW||pixel.y<pane.top||pixel.y>=pane.top+pane.height)return null;
    if(!this.layerStatus('series:candles').visible)return null;
    const index=Math.round(this.viewport.indexAt(pixel.x));if(index<0||index>=this.store.length)return null;
    const x=this.viewport.xOf(index),time=this.store.timeAt(index);
    const points=(['open','high','low','close'] as const).map(field=>{
      const value=this.store.col(field)[index];return {field,anchor:{time,value},pixel:{x,y:pane.top+pane.height-(value-pane.min)/(pane.max-pane.min)*pane.height}};
    }).filter(point=>Number.isFinite(point.pixel.y)&&Number.isFinite(point.anchor.value));
    if(!points.length)return null;
    const nearest=points.reduce((best,point)=>Math.abs(point.pixel.y-pixel.y)<Math.abs(best.pixel.y-pixel.y)?point:best);
    const target=strength==='strong'||Math.abs(nearest.pixel.y-pixel.y)<=MAGNET_RADIUS&&Math.abs(x-pixel.x)<=MAGNET_RADIUS?nearest:null;
    return {index,strength,points,target};
  }
  private refreshMagnetFeedback():void {
    const pixel=this.magnetPointer,paneId=this.drawing.interactionPaneId??(pixel?this.panes.find(p=>pixel.y>=p.top&&pixel.y<p.top+p.height)?.id:null);
    this.magnetGuide=pixel&&paneId&&this.drawing.canSnapPointer?this.magnetAt(pixel,paneId,this.drawing.effectiveMagnetStrength):null;
    this.overlayDirty=true;
  }
  private drawMagnetFeedback(ctx:CanvasRenderingContext2D):void {
    const guide=this.magnetGuide,pane=this.panes.find(p=>p.id==='main');if(!guide||!pane)return;
    ctx.save();ctx.beginPath();ctx.rect(0,pane.top,this.viewport.plotW,pane.height);ctx.clip();ctx.setLineDash([]);
    for(const point of guide.points){
      const selected=point===guide.target;ctx.beginPath();ctx.arc(point.pixel.x,point.pixel.y,selected?6:3,0,Math.PI*2);
      const ink=this.canvasInk??DEFAULT_CANVAS_INK;ctx.fillStyle=selected?ink.handleFill:ink.guide;ctx.strokeStyle=selected?ink.guideStrong:ink.selected;ctx.lineWidth=selected?2:1;ctx.fill();ctx.stroke();
    }
    if(guide.target){
      const point=guide.target;ctx.font='600 11px ui-monospace, monospace';ctx.textBaseline='middle';ctx.textAlign='left';
      const label=`${point.field[0].toUpperCase()} · ${tr(guide.strength==='strong'?'强吸':'磁吸')}`,width=ctx.measureText(label).width+10;
      const x=clamp(point.pixel.x+12,2,Math.max(2,this.viewport.plotW-width-2)),y=clamp(point.pixel.y-18,pane.top+12,pane.top+pane.height-12);
      const ink=this.canvasInk??DEFAULT_CANVAS_INK;ctx.fillStyle=ink.chipBg;ctx.fillRect(x,y-10,width,20);ctx.fillStyle=ink.chipText;ctx.fillText(label,x+5,y);
    }
    ctx.restore();
  }
  private zoomToDrawing(drawing:Drawing):void {
    if(drawing.points.length<2)return;this.cancelViewportMotion();
    const [a,b]=drawing.points,interval=intervals[this.state.interval];
    const from=indexForTime(this.store,Math.min(a.time,b.time),interval),to=indexForTime(this.store,Math.max(a.time,b.time),interval);
    if(to-from<2)return;
    this.viewport.from=from;this.viewport.to=Math.max(to,from+5);
    if(Math.abs(b.value-a.value)>1e-9)this.manualScales.set(drawing.paneId,{min:Math.min(a.value,b.value),max:Math.max(a.value,b.value)});
    this.state.following=false;this.dirty=true;
  }

  private paneName(id:string):string{
    if(id==='main')return tr('主图');if(id==='volume')return tr('成交量');
    const doc=this.drawing.document,layer=doc.layers.find(l=>l.paneId===id&&['indicator','overlay'].includes(l.kind));
    if(!layer)return tr('绘图窗格');
    return this.layerDisplayName(layer);
  }
  private studyDisplayName(instanceId:string):string{const layer=this.drawing.document.layers.find(l=>l.id===instanceId);return layer?this.layerDisplayName(layer):instanceId;}
  private layerDisplayName(layer:SceneLayer):string{
    const instance=layer.kind==='indicator'?this.drawing.document.indicators.find(i=>i.instanceId===layer.id):undefined;
    const definition=instance?this.registry.list().find(d=>d.id===instance.id):undefined;
    if(definition?.source!=='builtin')return layer.name;
    if(layer.name===definition.name)return tr(definition.name);
    const suffix=layer.name.slice(definition.name.length);
    return layer.name.startsWith(definition.name)&&/^( 副本)+$/.test(suffix)?tr(definition.name)+suffix.replace(/ 副本/g,()=>tr(' 副本')):layer.name;
  }

  private syncPaneControls(): void {
    const layoutKey=this.panes.map(p=>`${p.id}:${p.top}:${p.height}:${this.manualScales.has(p.id)}:${this.paneName(p.id)}`).join('|')+this.maximizedPane+this.viewport.plotW;
    if(layoutKey===this.controlsLayoutKey)return;
    this.controlsLayoutKey=layoutKey;
    this.onPaneLayout(this.panes.map(({id,top,height})=>({id,top,height,width:this.viewport.plotW})));
    const key = this.panes.map(p => p.id).join('|');
    if (key !== this.controlsKey) {
      this.controlsKey = key;
      this.paneControls.replaceChildren();
      this.panes.forEach((pane, index) => {
        const toolbar = document.createElement('div');
        toolbar.className = 'pane-toolbar';
        toolbar.dataset.pane = pane.id;
        for (const action of ['scale', 'maximize']) {
          const button = document.createElement('button');
          button.dataset.paneAction = action;
          button.dataset.pane = pane.id;
          toolbar.append(button);
        }
        this.paneControls.append(toolbar);
        if (index < this.panes.length - 1) {
          const separator = document.createElement('div');
          separator.className = 'pane-separator';
          separator.dataset.boundary = String(index);
          separator.tabIndex = 0;
          separator.setAttribute('role', 'separator');
          separator.setAttribute('aria-orientation', 'horizontal');
          separator.setAttribute('aria-label', tr('调整{0}与{1}窗格高度',{0:this.paneName(pane.id),1:this.paneName(this.panes[index + 1].id)}));
          separator.title = tr('上下拖动调整窗格高度；双击恢复默认布局；方向键微调');
          this.paneControls.append(separator);
        }
      });
    }
    this.panes.forEach((pane, index) => {
      const toolbar = this.paneControls.querySelector<HTMLElement>(`.pane-toolbar[data-pane="${CSS.escape(pane.id)}"]`);
      if (!toolbar) return;
      toolbar.style.top = `${pane.top + 4}px`;
      toolbar.style.right = `${AXIS_W + 6}px`;
      const scale = toolbar.querySelector<HTMLButtonElement>('[data-pane-action="scale"]')!;
      const manual = this.manualScales.has(pane.id);
      scale.textContent = tr(manual ? '手动' : '自动');
      scale.classList.toggle('manual', manual);
      scale.setAttribute('aria-pressed', String(!manual));
      scale.title = tr('{0}：{1}；右侧刻度可拖动缩放',{0:this.paneName(pane.id),1:tr(manual ? '点击恢复自动比例' : '自动适应可见数据')});
      scale.setAttribute('aria-label', tr('{0}恢复自动比例',{0:this.paneName(pane.id)}));
      const maximize = toolbar.querySelector<HTMLButtonElement>('[data-pane-action="maximize"]')!;
      const iconState = this.maximizedPane ? 'restore' : 'max';
      if (maximize.dataset.iconState !== iconState) {
        maximize.dataset.iconState = iconState;
        maximize.innerHTML = this.maximizedPane
          ? '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.2 2.2h5.6v5.6M2.2 4.2h5.6v5.6H2.2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
          : '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.35"/></svg>';
      }
      maximize.title = this.maximizedPane ? tr('还原窗格布局（Esc）') : tr('最大化{0}',{0:this.paneName(pane.id)});
      maximize.setAttribute('aria-label', maximize.title);
      const separator = this.paneControls.querySelector<HTMLElement>(`[data-boundary="${index}"]`);
      if (separator) {
        separator.setAttribute('aria-label', tr('调整{0}与{1}窗格高度',{0:this.paneName(pane.id),1:this.paneName(this.panes[index + 1].id)}));
        separator.title = tr('上下拖动调整窗格高度；双击恢复默认布局；方向键微调');
        separator.style.top = `${pane.top + pane.height}px`;
        const pair = pane.height + this.panes[index + 1].height;
        const min = this.paneLayout.minimum(this.height - AXIS_H, this.panes.length);
        separator.setAttribute('aria-valuemin', String(Math.round(min)));
        separator.setAttribute('aria-valuemax', String(Math.round(pair - min)));
        separator.setAttribute('aria-valuenow', String(Math.round(pane.height)));
        separator.setAttribute('aria-valuetext', tr('{0}高度 {1} 像素',{0:this.paneName(pane.id),1:Math.round(pane.height)}));
      }
    });
  }

  private cancelDrag(): void {
    const id = this.drag?.id;
    if(this.drag?.kind==='drawing')this.drawing.cancel();
    this.drag = null;
    if (id !== undefined && this.host.hasPointerCapture(id)) this.host.releasePointerCapture(id);
    this.host.style.cursor = 'crosshair';
    this.host.classList.remove('resizing-pane');
    this.paneControls.querySelector('.dragging')?.classList.remove('dragging');
  }

  private hitTest(x: number, y: number, touch = false): {kind: 'separator'; boundary: number} | {kind: 'price'; pane: Pane} | {kind: 'time'} | {kind: 'pan'; pane: Pane} | null {
    if (!this.panes.length || x < 0 || x > this.width || y < 0 || y > this.height) return null;
    const boundary = this.panes.findIndex((pane, i) => i < this.panes.length - 1 && Math.abs(y - pane.top - pane.height) <= (touch ? 12 : 6));
    if (boundary >= 0) return {kind: 'separator', boundary};
    if (y >= this.height - AXIS_H) return x < this.viewport.plotW ? {kind: 'time'} : null;
    const pane = this.panes.find(p => y >= p.top && y < p.top + p.height);
    return pane ? x >= this.viewport.plotW ? {kind: 'price', pane} : {kind: 'pan', pane} : null;
  }

  private updateCursor(x: number, y: number): void {
    const hit = this.hitTest(x, y);
    this.host.style.cursor = hit?.kind === 'separator' || hit?.kind === 'price' ? 'ns-resize' : hit?.kind === 'time' ? 'ew-resize' : this.drawing.cursor;
    this.host.title = tr(hit?.kind === 'price' ? '上下拖动调整纵向比例；双击恢复自动比例' : hit?.kind === 'time' ? '左右拖动调整时间比例；双击返回最新' : '');
  }

  private selectionAt(drawing:Drawing,pixel:Pixel):DrawingSelection {
    const projection=this.drawingProjection(drawing.paneId);
    const points=projection?drawing.points.map(p=>projection.project(p)).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)):[];
    return {id:drawing.id,...pixel,...(points.length?{bounds:{left:Math.min(...points.map(p=>p.x)),right:Math.max(...points.map(p=>p.x)),top:Math.min(...points.map(p=>p.y)),bottom:Math.max(...points.map(p=>p.y))}}:{})};
  }

  private bindEvents(): void {
    const opts = {signal: this.events.signal};
    const local = (e: MouseEvent) => {const b = this.host.getBoundingClientRect(); return {x: e.clientX - b.left, y: e.clientY - b.top};};
    let lastDragPoint:Pixel|null=null;
    const touches=new Map<number,Pixel>();
    let pinch:{distance:number;center:number;from:number;to:number}|null=null;
    const touchGeometry=()=>{const [a,b]=[...touches.values()];return {distance:Math.max(12,Math.hypot(b.x-a.x,b.y-a.y)),center:(a.x+b.x)/2};};
    const clearTouches=()=>{const ids=[...touches.keys()];touches.clear();pinch=null;for(const id of ids)if(this.host.hasPointerCapture(id))this.host.releasePointerCapture(id);};
    const syncMagnetModifier=(event:{ctrlKey?:boolean;metaKey?:boolean;shiftKey?:boolean;altKey?:boolean},force?:boolean)=>{
      if(force===undefined&&typeof event.ctrlKey!=='boolean'&&typeof event.metaKey!=='boolean')return;
      const held=(force??!!(event.ctrlKey||event.metaKey))&&!event.shiftKey&&!event.altKey;if(held===this.drawing.magnetModifierHeld)return;
      this.flushPointer();this.drawing.setMagnetModifier(held);this.refreshMagnetFeedback();
    };
    window.addEventListener('keydown',event=>syncMagnetModifier(event,event.key==='Control'||event.key==='Meta'?true:undefined),{...opts,capture:true});
    window.addEventListener('keyup',event=>syncMagnetModifier(event),{...opts,capture:true});
    const actionTarget = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('[data-pane-action]') : null;
    const isToolDrag = (e: DragEvent) => e.dataTransfer?.types.includes(DRAWING_TOOL_MIME);
    const clearDropTarget = () => this.host.classList.remove('tool-drop-target');
    const acceptToolDrag = (e:DragEvent) => {
      if (!isToolDrag(e)) return;
      const p = local(e), hit = this.hitTest(p.x, p.y);
      if (hit?.kind !== 'pan' || actionTarget(e.target) || this.drawing.allLocked || this.drawing.allHidden) {clearDropTarget(); return;}
      e.preventDefault();e.dataTransfer!.dropEffect = 'copy';this.host.classList.add('tool-drop-target');
    };
    this.host.addEventListener('dragenter',acceptToolDrag,opts);
    this.host.addEventListener('dragover',acceptToolDrag,opts);
    this.host.addEventListener('dragleave', e => {if (!(e.relatedTarget instanceof Node) || !this.host.contains(e.relatedTarget)) clearDropTarget();}, opts);
    window.addEventListener('dragend', clearDropTarget, opts);
    this.host.addEventListener('drop', e => {
      clearDropTarget();
      if (!isToolDrag(e)) return;
      e.preventDefault();
      const tool = this.drawing.registry.get(e.dataTransfer!.getData(DRAWING_TOOL_MIME));
      const p = local(e), hit = this.hitTest(p.x, p.y);
      if (!tool || (tool.mode && tool.mode !== 'draw') || hit?.kind !== 'pan' || actionTarget(e.target) || this.drawing.allLocked || this.drawing.allHidden) return;
      this.flushPointer();this.cancelDrag();this.cancelViewportMotion();this.markInput();
      this.drawing.selectTool(tool.id);this.host.focus();this.onDrawingSelection(null);
      // Anchor tools start at the drop point; freehand tools wait for a pressed stroke.
      if (!tool.freehand && this.drawing.pointerDown(p, hit.pane.id)) {
        this.state.following = false;this.drawing.pointerUp(p);
        const selected = this.drawing.state.selected;
        this.onDrawingSelection(selected ? this.selectionAt(selected,p) : null);
      }
      this.updateCursor(p.x,p.y);this.dirty=true;this.publish();
    }, opts);
    this.host.addEventListener('click', e => {
      const button = actionTarget(e.target);
      if (!button) return;
      if (button.dataset.paneAction === 'scale') this.resetPaneScale(button.dataset.pane!);
      else this.toggleMaximize(button.dataset.pane!);
    }, opts);
    this.host.addEventListener('pointerdown', e => {
      if(e.pointerType==='touch'&&!actionTarget(e.target)){
        const point=local(e);if(this.hitTest(point.x,point.y,true)?.kind!=='pan')return;
        touches.set(e.pointerId,point);
        if(touches.size===2){this.flushPointer();this.cancelDrag();this.drawing.cancel();this.onDrawingSelection(null);this.cancelViewportMotion();pinch={...touchGeometry(),from:this.viewport.from,to:this.viewport.to};this.host.setPointerCapture(e.pointerId);this.pointer=null;e.preventDefault();return;}
        if(touches.size>1){e.preventDefault();return;}
      }
      if (e.button !== 0 || actionTarget(e.target) || this.drag) return;
      this.flushPointer();syncMagnetModifier(e);this.cancelViewportMotion();this.markInput();
      const p = local(e), hit = this.hitTest(p.x, p.y, e.pointerType === 'touch');
      if (!hit) return;
      e.preventDefault();lastDragPoint=p;this.magnetPointer=p;
      const analytical=hit.kind==='pan'&&!this.drawing.drawingMode&&!this.drawing.hitDrawing(p,hit.pane.id)?hitAnalysis(this.analysisHits??[],p):undefined;
      if(analytical){this.onDrawingSelection(null);this.selectAnalysis(analytical.instanceId,analytical.observation.id,false);this.onPatternSelection();this.host.focus();return;}
      const candidate=hit.kind==='pan'&&!this.drawing.drawingMode&&!this.drawing.hitDrawing(p,hit.pane.id)?hitPattern(this.candidateHits??[],p):undefined;
      if(candidate){this.onDrawingSelection(null);this.selectPatternCandidate(candidate.instanceId,candidate.candidate.id,false);this.onPatternSelection();this.host.focus();return;}
      const divergence=hit.kind==='pan'&&!this.drawing.drawingMode&&!this.drawing.hitDrawing(p,hit.pane.id)?hitPattern(this.divergenceHits??[],p):undefined;
      if(divergence){this.onDrawingSelection(null);this.selectedDivergenceKey=`${divergence.instanceId}:${divergence.divergence.id}`;this.drawing.selectLayers([divergence.instanceId]);this.dirty=true;this.overlayDirty=true;this.host.focus();return;}
      const pattern=hit.kind==='pan'&&!this.drawing.drawingMode&&!this.drawing.hitDrawing(p,hit.pane.id)?hitPattern(this.patternHits??[],p):undefined;
      if(pattern){
        this.onDrawingSelection(null);this.selectPattern(pattern.instanceId,pattern.pattern.id,false);
        this.onPatternSelection();this.host.focus();return;
      }
      if(hit.kind==='pan'&&this.drawing.pointerDown(p,hit.pane.id,e.pointerType==='touch'?18:7)){
        this.state.following=false;this.host.focus();this.drag={kind:'drawing',id:e.pointerId};this.host.setPointerCapture(e.pointerId);
        this.host.style.cursor=this.drawing.cursor;this.overlayDirty=true;return;
      }
      this.onDrawingSelection(null);
      if (hit.kind === 'separator') {
        const separator = this.paneControls.querySelector<HTMLElement>(`[data-boundary="${hit.boundary}"]`);
        separator?.focus(); separator?.classList.add('dragging');
        this.drag = {kind: 'separator', id: e.pointerId, y: p.y, boundary: hit.boundary, panes: this.panes.map(({id, top, height}) => ({id, top, height}))};
        this.host.classList.add('resizing-pane');
      } else {
        this.host.focus();
        if (hit.kind !== 'pan') this.viewportPhysics?.cancel();
        if (hit.kind === 'price') this.drag = {kind: 'price', id: e.pointerId, y: p.y, paneId: hit.pane.id, range: {min: hit.pane.min, max: hit.pane.max}};
        else if (hit.kind === 'time') this.drag = {kind: 'time', id: e.pointerId, x: p.x, from: this.viewport.from, to: this.viewport.to, anchor: p.x};
        else {this.drag = {kind: 'pan', id: e.pointerId, x: p.x, y: p.y, paneId: hit.pane.id};(this.viewportPhysics??=new ViewportPhysics()).beginDrag(p.x,performance.now());}
      }
      this.host.setPointerCapture(e.pointerId);
      this.host.style.cursor = hit.kind === 'pan' ? 'grabbing' : hit.kind === 'time' ? 'ew-resize' : 'ns-resize';
      this.pointer = null; this.overlayDirty = true;
    }, opts);
    const processPointerMove = (e:PointerEvent) => {
      const p = local(e), drag = this.drag;
      this.magnetPointer=p;
      if (drag) {
        if (e.pointerId !== drag.id) return;
        lastDragPoint=p;
        if (drag.kind === 'drawing')this.drawing.pointerMove(p);
        else if (drag.kind === 'separator') this.paneLayout.resizePair(drag.panes, drag.boundary, p.y - drag.y);
        else if (drag.kind === 'price') this.manualScales.set(drag.paneId, zoomPriceRange(drag.range, Math.exp(clamp(drag.y - p.y, -1500, 1500) * .008)));
        else if (drag.kind === 'time') {
          this.viewport.from = drag.from; this.viewport.to = drag.to;
          this.viewport.zoomAt(drag.anchor, Math.exp(clamp(p.x - drag.x, -1500, 1500) * .006));
          this.state.following = false;
        } else {
          const dx = p.x - drag.x;
          this.viewport.panBy(dx);
          if (this.state.smoothMotion && dx !== 0) (this.viewportPhysics ??= new ViewportPhysics()).recordDrag(p.x, performance.now());
          const range = this.manualScales.get(drag.paneId), pane = this.panes.find(p => p.id === drag.paneId);
          if (range && pane) {const offset = (p.y - drag.y) / pane.height * (range.max - range.min); this.manualScales.set(drag.paneId, {min: range.min + offset, max: range.max + offset});}
          drag.x = p.x; drag.y = p.y; this.state.following = false;
        }
        if(drag.kind==='drawing')this.overlayDirty=true;else this.dirty=true;
      } else {this.drawing.pointerMove(p);this.updateCursor(p.x, p.y);}
      const hit = this.hitTest(p.x, p.y);
      this.pointer = (!drag || drag.kind === 'pan') && (hit?.kind === 'pan' || (hit?.kind === 'separator' && p.x >= 0 && p.x < this.viewport.plotW)) && !actionTarget(e.target) ? p : null;
      this.refreshMagnetFeedback();
      this.overlayDirty = true;
    };
    const finish = (pixel:Pixel,commit:boolean) => {
      const drag=this.drag;if(!drag)return;
      // Clear ownership before callbacks or releasing capture: both may re-enter.
      this.drag=null;
      if(drag.kind==='drawing'){
        if(commit){
          this.drawing.pointerUp(pixel);const selected=this.drawing.state.selected;
          this.onDrawingSelection(selected?this.selectionAt(selected,pixel):null);
        }else{this.drawing.cancel();this.onDrawingSelection(null);this.magnetPointer=null;this.magnetGuide=null;}
      }else if(drag.kind==='pan'){
        if(commit&&this.state.smoothMotion){
          if((this.viewportPhysics??=new ViewportPhysics()).endDrag(performance.now(),true)!==0)this.dirty=true;
        }else this.viewportPhysics?.cancel();
      }
      if(this.host.hasPointerCapture(drag.id))this.host.releasePointerCapture(drag.id);
      lastDragPoint=null;this.cancelDrag();this.updateCursor(pixel.x,pixel.y);this.publish();
    };
    // Capture can be transferred/lost while a drag is still pressed. Track the
    // gesture at window scope until release; lostpointercapture is not Cancel.
    window.addEventListener('pointermove',e=>{
      if(touches.has(e.pointerId)){
        touches.set(e.pointerId,local(e));
        if(pinch){e.preventDefault();const gesture=pinch;this.markInput();this.pendingPointer=()=>{if(!pinch||touches.size<2)return;const current=touchGeometry();this.viewport.from=gesture.from;this.viewport.to=gesture.to;this.viewport.zoomAt(gesture.center,current.distance/gesture.distance);this.viewport.panBy(current.center-gesture.center);this.state.following=false;this.dirty=true;};return;}
        if(!this.drag)return;
      }
      if(this.drag){
        if(e.pointerId!==this.drag.id)return;
        if(e.pointerType==='mouse'&&e.buttons===0){
          this.flushPointer();if(lastDragPoint)finish(lastDragPoint,true);syncMagnetModifier(e);return;
        }
        syncMagnetModifier(e);this.markInput();
        if(this.drag.kind==='drawing')processPointerMove(e);else this.pendingPointer=()=>processPointerMove(e);
      }else if(e.target instanceof Node&&this.host.contains(e.target)){
        syncMagnetModifier(e);this.markInput();this.pendingPointer=()=>processPointerMove(e);
      }
    },{...opts,capture:true});
    const end = (e:PointerEvent) => {
      if(touches.has(e.pointerId)){this.flushPointer();touches.delete(e.pointerId);if(pinch){pinch=null;this.cancelDrag();if(this.host.hasPointerCapture(e.pointerId))this.host.releasePointerCapture(e.pointerId);this.publish();return;}}
      if(this.drag?.id!==e.pointerId)return;
      this.flushPointer();syncMagnetModifier(e);
      if(e.type==='pointerup')processPointerMove(e);
      finish(local(e),e.type==='pointerup');
    };
    window.addEventListener('pointerup',end,{...opts,capture:true});
    window.addEventListener('pointercancel',end,{...opts,capture:true});
    const finishOutside=()=>{
      clearTouches();this.flushPointer();if(this.drag&&lastDragPoint)finish(lastDragPoint,true);
      this.drawing.cancel();this.drawing.setMagnetModifier(false);this.magnetPointer=null;this.magnetGuide=null;this.pointer=null;this.overlayDirty=true;
    };
    window.addEventListener('blur',finishOutside,opts);
    if(typeof document!=='undefined')document.addEventListener('visibilitychange',()=>{
      if(document.hidden)finishOutside();else{this.drawing.setMagnetModifier(false);this.magnetPointer=null;this.magnetGuide=null;this.overlayDirty=true;}
    },opts);
    this.host.addEventListener('pointerleave', () => {if (!this.drag) {this.pendingPointer=null;this.drawing.pointerLeave();this.pointer = null;this.magnetPointer=null;this.magnetGuide=null; this.overlayDirty = true; this.host.title = ''; this.publish();}}, opts);
    this.host.addEventListener('wheel', e => {
      if (actionTarget(e.target)) return;
      e.preventDefault();this.markInput();this.flushPointer();
      const p = local(e), hit = this.hitTest(p.x, p.y);
      const delta = clamp(e.deltaY * (e.deltaMode === 1 ? 16 : 1), -300, 300);
      if (hit?.kind === 'price') this.manualScales.set(hit.pane.id, zoomPriceRange(hit.pane, Math.exp(-delta * .002), (p.y - hit.pane.top) / hit.pane.height));
      else {
        const physics = (this.viewportPhysics ??= new ViewportPhysics());
        const kind = physics.classifyWheel(e.deltaX, e.deltaY, e.shiftKey);
        if (kind === 'pan') {
          this.cancelViewportMotion();
          this.viewport.panBy(-(Number(e.deltaX) || Number(e.deltaY) || 0) * (e.deltaMode === 1 ? 16 : 1));
        } else {
          const anchor = clamp(p.x, 0, this.viewport.plotW);
          const factor = Math.exp(-delta * .002);
          if (this.state.smoothMotion) {
            const now = performance.now();
            this.liveFollowing = false;
            this.viewportMotion.snap({min: this.viewport.from, max: this.viewport.to});
            physics.queueZoom(factor, anchor, now);
            physics.step(now + 6, {onZoom: (a, f) => this.viewport.zoomAt(a, f), onPan: dx => this.viewport.panBy(dx)});
          } else {
            this.zoomViewport(anchor, factor, 0);
          }
        }
        this.state.following = false;
      }
      this.dirty = true;
    }, {...opts, passive: false});
    this.host.addEventListener('dblclick', e => {
      if (actionTarget(e.target)||this.drawing.hasGesture||this.drawing.drawingMode) return;
      const p = local(e), hit = this.hitTest(p.x, p.y);
      const analytical=hit?.kind==='pan'&&!this.drawing.hitDrawing(p,hit.pane.id)?hitAnalysis(this.analysisHits??[],p):undefined;
      if(analytical){this.onOpenProperties([analytical.instanceId]);return;}
      const candidate=hit?.kind==='pan'&&!this.drawing.hitDrawing(p,hit.pane.id)?hitPattern(this.candidateHits??[],p):undefined;
      if(candidate){this.onOpenProperties([candidate.instanceId]);return;}
      const divergence=hit?.kind==='pan'&&!this.drawing.hitDrawing(p,hit.pane.id)?hitPattern(this.divergenceHits??[],p):undefined;
      if(divergence){this.onOpenProperties([divergence.instanceId]);return;}
      const pattern=hit?.kind==='pan'&&!this.drawing.hitDrawing(p,hit.pane.id)?hitPattern(this.patternHits??[],p):undefined;
      if(pattern){this.onOpenProperties([pattern.instanceId]);return;}
      if(hit?.kind==='pan'&&this.drawing.state.selected){this.onOpenProperties([this.drawing.state.selected!.id]);return;}
      if (hit?.kind === 'separator') this.resetPaneLayout();
      else if (hit?.kind === 'price') this.resetPaneScale(hit.pane.id);
      else this.followLatest();
    }, opts);
    this.host.addEventListener('keydown', e => {
      if(e.key==='Escape')clearTouches();
      if(!actionTarget(e.target)&&this.drawing.keyDown(e)){e.preventDefault();if(this.drag?.kind==='drawing'&&!this.drawing.hasGesture)this.cancelDrag();this.host.style.cursor=this.drawing.cursor;return;}
      if (e.key === 'Escape') {e.preventDefault(); this.cancelDrag(); this.maximizedPane = null; this.pointer = null; this.host.focus(); this.dirty = true; return;}
      if (actionTarget(e.target)) return;
      const separator = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-boundary]') : null;
      if (separator && ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(e.key)) {
        e.preventDefault();
        if (e.key === 'Enter') this.resetPaneLayout();
        else {
          const delta = e.key === 'Home' ? -this.height : e.key === 'End' ? this.height : (e.key === 'ArrowUp' ? -1 : 1) * (e.shiftKey ? 32 : 8);
          this.paneLayout.resizePair(this.panes, Number(separator.dataset.boundary), delta); this.dirty = true;
        }
        return;
      }
      if (['ArrowLeft', 'ArrowRight', '+', '=', '-', 'Home', 'End', 'Escape'].includes(e.key)) e.preventDefault();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {this.cancelViewportMotion();this.viewport.panBy(this.viewport.plotW * .15 * (e.key === 'ArrowLeft' ? 1 : -1)); this.state.following = false; this.dirty = true;}
      if (e.key === '+' || e.key === '=') this.zoom(1.25);
      if (e.key === '-') this.zoom(.8);
      if (e.key === 'End') this.followLatest();
      if (e.key === 'Home') this.showAll();
    }, opts);
  }
}
