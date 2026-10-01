import type {CallProgress,ChartEvent,ChartSessionInfo} from './protocol';
import {isWriteMethod} from './protocol';
import type {IndicatorDef,ParamValues} from '../core/types';
import type {Drawing,DrawingStyle,DrawingTool} from '../drawing/types';
import {DEFAULT_STYLE,MIN_DRAWING_FONT_SIZE,MAX_DRAWING_FONT_SIZE} from '../drawing/types';
import {parseDrawingDocument} from '../drawing/store';
import {indexForTime,timeForIndex} from '../drawing/coordinates';
import {layerOf,TIMEFRAMES,type IndicatorPlotStyle,type SceneDocument,type SceneLayer} from '../scene/types';
import {descendants,normalizeDocument,validatePlotStyles,validateStructure} from '../scene/model';
import {deleteLayers,moveToGroup,reorderLayers,updateLayers} from '../scene/commands';
import {marketConnectors} from '../market/connectors';
import {marketIdentity} from '../market/identity';
import {AgentInputError,finite,formatTime,isRecord,num,resolveAnchor,resolveRange,timeFormatOf,type BarSpace,type RangeContext,type TimeFormat} from './anchors';
import {aggregateBars,bucketSize,bucketTimes,sampleSeries,BAR_FIELDS,MAX_POINTS,type BarField} from './sampling';
import {AgentBridgeError} from './errors';
import {AGENT_AUTHOR,STATE_SECTIONS,buildSnapshot,describeDrawing,isAgentDrawing,selectionSpan,type StateSection} from './snapshot';
import {OVERLAY_KINDS,describeOverlay,materializeOverlay,parseOverlay,type AgentOverlay} from './overlays';
import {computeStructure} from './structure';
import {asciiChart,describeObject,layoutIssues,measureLayout} from './layout';
import type {AgentUiHooks,ChartAgentTarget} from './target';

type Params=Record<string,unknown>;
type Progress=(progress:CallProgress)=>void;
/** Default state read: everything except the verbose layer tree (layers duplicates drawings/indicators). */
const DEFAULT_SECTIONS=STATE_SECTIONS.filter(section=>section!=='layers');
export interface ChartAgentAdapterOptions {chartId:string;host?:()=>Element|null|undefined;ui?:AgentUiHooks}
const OVERLAY_OWNER='agent';
const MAX_BATCH=200;

function int(value:unknown,label:string,fallback:number,min:number,max:number):number {
  if(value===undefined)return fallback;
  const n=Math.round(finite(value,label));if(n<min||n>max)throw new AgentInputError(`${label} must be between ${min} and ${max}`);
  return n;
}
function string(value:unknown,label:string,max=200):string {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new AgentInputError(`${label} must be a non-empty string (max ${max} characters)`);
  return value.trim();
}
function strings(value:unknown,label:string,max=MAX_BATCH):string[] {
  if(!Array.isArray(value)||value.length>max||value.some(item=>typeof item!=='string'))throw new AgentInputError(`${label} must be an array of at most ${max} strings`);
  return value as string[];
}
function records(value:unknown,label:string,max=MAX_BATCH):Params[] {
  if(!Array.isArray(value)||!value.length||value.length>max||value.some(item=>!isRecord(item)))throw new AgentInputError(`${label} must be a non-empty array of at most ${max} objects`);
  return value as Params[];
}
function oneOf<T extends string>(value:unknown,options:readonly T[],label:string,fallback:T):T {
  if(value===undefined)return fallback;
  if(!options.includes(value as T))throw new AgentInputError(`${label} must be one of ${options.join(', ')}`);
  return value as T;
}
const bool=(value:unknown,label:string):boolean=>{if(typeof value!=='boolean')throw new AgentInputError(`${label} must be true or false`);return value;};
function hexColor(value:unknown,label:string):string {
  const text=typeof value==='string'?value.trim():'',short=/^#([\da-f])([\da-f])([\da-f])$/i.exec(text);
  if(short)return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  if(/^#[\da-f]{6}$/i.test(text))return text.toLowerCase();
  throw new AgentInputError(`${label} must be a hex color like #26a69a (drawings do not take alpha; use style.fillOpacity)`);
}
function drawingStyle(raw:unknown,label:string):Partial<DrawingStyle> {
  if(raw===undefined)return {};
  if(!isRecord(raw))throw new AgentInputError(`${label} must be an object`);
  const out:Partial<DrawingStyle>={};
  for(const [key,value] of Object.entries(raw)){
    if(key==='color')out.color=hexColor(value,`${label}.color`);
    else if(key==='width'){const width=finite(value,`${label}.width`);if(width<1||width>8)throw new AgentInputError(`${label}.width must be between 1 and 8`);out.width=width;}
    else if(key==='dash')out.dash=oneOf(value,['solid','dashed','dotted'] as const,`${label}.dash`,'solid');
    else if(key==='fillOpacity'){const opacity=finite(value,`${label}.fillOpacity`);if(opacity<0||opacity>1)throw new AgentInputError(`${label}.fillOpacity must be between 0 and 1`);out.fillOpacity=opacity;}
    else if(key==='fontSize'){const size=finite(value,`${label}.fontSize`);if(size<MIN_DRAWING_FONT_SIZE||size>MAX_DRAWING_FONT_SIZE)throw new AgentInputError(`${label}.fontSize must be between ${MIN_DRAWING_FONT_SIZE} and ${MAX_DRAWING_FONT_SIZE}`);out.fontSize=size;}
    else throw new AgentInputError(`${label}.${key} is not a style field (color, width, dash, fillOpacity, fontSize)`);
  }
  return out;
}
function drawingProps(raw:unknown,label:string):Drawing['props'] {
  if(raw===undefined)return {};
  if(!isRecord(raw))throw new AgentInputError(`${label} must be an object`);
  for(const [key,value] of Object.entries(raw))if(!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value)||typeof value==='string'&&value.length>2000)
    throw new AgentInputError(`${label}.${key} must be a string (max 2000), finite number or boolean`);
  return {...raw} as Drawing['props'];
}
function intervals(value:unknown,label:string):string[]|null {
  if(value===null)return null;
  const list=strings(value,label,Object.keys(TIMEFRAMES).length);
  for(const interval of list)if(!Object.hasOwn(TIMEFRAMES,interval))throw new AgentInputError(`${label} contains unknown interval "${interval}"`);
  return list;
}
function normalizeParams(def:IndicatorDef,raw:unknown):ParamValues {
  if(!isRecord(raw))throw new AgentInputError('params must be an object');
  const out:ParamValues={};
  for(const [key,value] of Object.entries(raw)){
    const schema=def.inputs.find(input=>input.key===key);
    if(!schema)throw new AgentInputError(`unknown param "${key}" for ${def.id}; valid: ${def.inputs.map(input=>input.key).join(', ')||'none'}`);
    if(schema.type==='int'||schema.type==='float'){
      let n=Math.min(schema.max??Infinity,Math.max(schema.min??-Infinity,finite(value,`params.${key}`)));if(schema.type==='int')n=Math.round(n);out[key]=n;
    }else if(schema.type==='bool')out[key]=bool(value,`params.${key}`);
    else if(schema.type==='color')out[key]=hexColor(value,`params.${key}`);
    else{
      if(!schema.options?.map(String).includes(String(value)))throw new AgentInputError(`params.${key} must be one of ${schema.options?.join(', ')}`);
      out[key]=typeof schema.def==='number'?Number(value):String(value);
    }
  }
  return out;
}
const textField=(tool:DrawingTool)=>tool.fields?.find(field=>field.type==='text')?.key;

/** One chart's agent surface: validated reads and writes over the real
 * controller, scene store and indicator engine. Each write call is one scene
 * transaction, i.e. one undo step, and never bypasses locks or validation. */
export class ChartAgentAdapter {
  readonly chartId:string;
  private overlays=new Map<string,AgentOverlay>();
  private supplied:{data:unknown;first:number;market:string;ids:ReadonlySet<string>}={data:null,first:NaN,market:'',ids:new Set()};
  private handlers:Record<string,(params:Params,progress:Progress)=>unknown>;
  private calling=0;
  constructor(readonly target:ChartAgentTarget,private options:ChartAgentAdapterOptions){
    this.chartId=options.chartId;
    this.handlers={
      state:p=>this.state(p),bars:p=>this.bars(p),series:p=>this.series(p),analysis:p=>this.analysis(p),structure:p=>this.structure(p),layout:p=>this.layout(p),
      catalog:p=>this.catalog(p),capture:p=>this.capture(p),locate:p=>this.locate(p),
      draw:p=>this.draw(p),update:p=>this.update(p),delete:p=>this.remove(p),'overlay.set':p=>this.overlaySet(p),'overlay.remove':p=>this.overlayRemove(p),
      'indicator.add':p=>this.indicatorAdd(p),'indicator.update':p=>this.indicatorUpdate(p),view:(p,progress)=>this.view(p,progress),select:p=>this.select(p),history:p=>this.history(p),
    };
  }
  /** Whether a DOM node belongs to this chart (activity tracking with several charts). */
  contains(node:Node):boolean {const host=this.options.host?.();return !!host&&host.contains(node);}
  /** Market identity shared with the scene store (drawings are per source+symbol). */
  get market():string {const s=this.target.chartState;return marketIdentity({source:s.source,symbol:s.symbol,marketType:s.marketType});}
  info():Pick<ChartSessionInfo,'title'|'source'|'symbol'|'interval'|'loading'> {
    const s=this.target.chartState;return {title:`${s.symbol} · ${s.interval} · ${s.source}`,source:s.source,symbol:s.symbol,interval:s.interval,loading:s.loading};
  }
  async handle(method:string,params:unknown,writable:boolean,progress:Progress=()=>{}):Promise<unknown> {
    const handler=this.handlers[method];
    if(!handler)throw new AgentBridgeError('UNKNOWN_METHOD',`unknown chart method "${method}"`);
    if(isWriteMethod(method)&&!writable)throw new AgentBridgeError('WRITE_DISABLED','the user switched off "Allow AI to edit the chart" in the status bar; only read methods are available');
    if(params!==undefined&&params!==null&&!isRecord(params))throw new AgentInputError('params must be an object');
    this.sync();this.target.settle?.();this.calling++;
    try{return await handler((params??{}) as Params,progress);}finally{this.calling--;}
  }
  /** Re-supply agent overlays after bars reload (new market, reconnect) or
   * after older history is prepended and bar indices shift. */
  sync():void {
    const cols=this.target.data,first=cols.length?cols.col('time')[0]:NaN,market=this.market,previous=this.supplied;
    if(previous.data===cols&&previous.market===market&&previous.ids.size){
      // The user deleted (or undid) an overlay layer: it stays gone instead of coming back on the next reload.
      const layers=new Set(this.target.drawing.document.layers.map(layer=>layer.id)),gone=[...previous.ids].filter(id=>!layers.has(id));
      if(gone.length){for(const id of gone)this.overlays.delete(this.overlayKey(id.slice('agent:'.length)));this.pushOverlays(previous.ids);return;}
    }
    if(previous.data===cols&&Object.is(previous.first,first)&&previous.market===market)return;
    // A new column store means the controller already dropped every external plot.
    this.pushOverlays(previous.data===cols?previous.ids:new Set());
  }
  /** Selection, market and scene changes for the hub's event stream. */
  subscribe(listener:(event:ChartEvent)=>void):()=>void {
    let first=true,selection='',revision=0,market='',layerIds=new Set<string>();
    return this.target.drawing.subscribe(state=>{
      const s=this.target.chartState,key=`${s.source}:${s.symbol}:${s.interval}`,doc=state.scene.document,ids=state.scene.selectedIds,at=Date.now(),by=this.calling?'agent':'user';
      const nextIds=new Set(doc.layers.map(layer=>layer.id));
      if(first){first=false;selection=ids.join(',');revision=state.scene.revision;market=key;layerIds=nextIds;return;}
      if(key!==market){market=key;revision=state.scene.revision;layerIds=nextIds;listener({type:'market',at,data:{source:s.source,symbol:s.symbol,interval:s.interval,by}});}
      if(ids.join(',')!==selection){
        selection=ids.join(',');
        listener({type:'selection',at,data:{ids,objects:ids.flatMap(id=>{const layer=doc.layers.find(l=>l.id===id);return layer?[{id,kind:layer.kind,name:layer.name,paneId:layer.paneId}]:[];}),by}});
      }
      if(state.scene.revision!==revision){
        revision=state.scene.revision;
        const added=[...nextIds].filter(id=>!layerIds.has(id)),removed=[...layerIds].filter(id=>!nextIds.has(id));layerIds=nextIds;
        listener({type:'scene',at,data:{revision,added,removed,drawings:doc.drawings.length,indicators:doc.indicators.length,by}});
      }
    });
  }

  private space():BarSpace {return {cols:this.target.data,intervalMs:TIMEFRAMES[this.target.chartState.interval]??60_000};}
  private rangeContext():RangeContext {
    const engine=this.target.drawing;
    return {...this.space(),visible:{from:this.target.viewport.from,to:this.target.viewport.to},selection:selectionSpan(engine.document,engine.state.scene.selectedIds)};
  }
  private ready():void {
    const s=this.target.chartState;
    if(s.loading||!this.target.data.length)throw new AgentBridgeError('NOT_READY',s.error||'the chart is still loading market data; retry in a moment');
  }
  /** Writes wait for the user's own gesture or property dialog to finish. */
  private writableScene():void {
    const engine=this.target.drawing;
    if(engine.hasGesture)throw new AgentBridgeError('BUSY','the user is drawing or dragging on the chart right now; retry shortly');
    if(engine.previewing)throw new AgentBridgeError('BUSY','the user has an object properties dialog open; retry after it is closed');
  }
  /** Validate before the engine sees the document: transact() reports its own
   * failures in the UI, which must not happen for a rejected agent request. */
  private commit(next:SceneDocument):boolean {
    try{validateStructure(normalizeDocument(structuredClone(next)));}catch(error){throw new AgentInputError(error instanceof Error?error.message:String(error));}
    const engine=this.target.drawing,before=engine.document;
    if(JSON.stringify(before)===JSON.stringify(next))return false;
    engine.transact(()=>next);
    if(engine.document===before)throw new AgentBridgeError('FAILED',engine.state.error||'the scene update did not apply');
    return true;
  }
  private pushOverlays(previous:ReadonlySet<string>):void {
    const market=this.market,space=this.space(),plots=[...this.overlays.values()].filter(o=>o.market===market).map(o=>materializeOverlay(space,o));
    const ids=new Set(plots.map(plot=>plot.id!));
    this.supplied={data:space.cols,first:space.cols.length?space.cols.col('time')[0]:NaN,market,ids};
    if(!plots.length&&!previous.size)return;
    this.target.setOverlayGroup(OVERLAY_OWNER,plots);
  }
  private state(p:Params) {
    let include:Set<StateSection>=new Set(DEFAULT_SECTIONS);
    if(p.include!==undefined){
      const list=strings(p.include,'include',STATE_SECTIONS.length);
      for(const section of list)if(!(STATE_SECTIONS as readonly string[]).includes(section))throw new AgentInputError(`include: unknown section "${section}"; valid: ${STATE_SECTIONS.join(', ')}`);
      include=new Set(list as StateSection[]);
    }
    return {chartId:this.chartId,...buildSnapshot(this.target,{include,format:timeFormatOf(p.timeFormat),recentBars:int(p.recentBars,'recentBars',5,0,500),
      maxDrawings:int(p.maxDrawings,'maxDrawings',200,1,2000),fullPoints:p.points==='full',overlays:[...this.overlays.values()].filter(o=>o.market===this.market)})};
  }
  private rangeSummary(range:{start:number;end:number},format:TimeFormat) {
    const time=this.target.data.col('time'),empty=range.end<=range.start;
    return {from:empty?null:formatTime(time[range.start],format),to:empty?null:formatTime(time[range.end-1],format),fromBar:range.start,toBar:range.end-1,bars:range.end-range.start};
  }
  private bars(p:Params) {
    this.ready();
    const cols=this.target.data,s=this.target.chartState,format=timeFormatOf(p.timeFormat),range=resolveRange(this.rangeContext(),p.range);
    const size=bucketSize(range,int(p.maxPoints,'maxPoints',300,1,MAX_POINTS));
    let fields:BarField[]=['time','open','high','low','close','volume'];
    if(p.fields!==undefined){
      const list=strings(p.fields,'fields',BAR_FIELDS.length);
      for(const field of list)if(!(BAR_FIELDS as readonly string[]).includes(field))throw new AgentInputError(`fields: unknown field "${field}"; valid: ${BAR_FIELDS.join(', ')}`);
      fields=['time',...(list as BarField[]).filter(field=>field!=='time')];
    }
    const n=cols.length;
    return {symbol:s.symbol,interval:s.interval,range:this.rangeSummary(range,format),
      aggregation:size>1?{barsPerRow:size,rule:'time=first open=first high=max low=min close=last volume=sum'}:null,
      lastBarForming:range.end===n&&s.confirmedBarTime!==cols.col('time')[n-1],columns:fields,rows:aggregateBars(cols,range,size,fields,format)};
  }
  private series(p:Params) {
    this.ready();
    const cols=this.target.data,doc=this.target.drawing.document,format=timeFormatOf(p.timeFormat),range=resolveRange(this.rangeContext(),p.range);
    const size=bucketSize(range,int(p.maxPoints,'maxPoints',300,1,MAX_POINTS)),includeHidden=p.includeHidden===true,time=cols.col('time');
    const ids=p.ids===undefined?undefined:strings(p.ids,'ids',100);
    for(const id of ids??[])if(!doc.indicators.some(i=>i.instanceId===id)&&!doc.layers.some(l=>l.id===id&&l.kind==='overlay'))
      throw new AgentInputError(`"${id}" is not an indicator instance or overlay on this chart (see get_chart_state indicators/overlays)`);
    const wanted=(id:string)=>ids?ids.includes(id):includeHidden||this.target.layerStatus(id).visible;
    const t=(ms:number)=>formatTime(ms,format),inRange=(index:number)=>index>=range.start&&index<range.end;
    const series:Params[]=[],markers:Params[]=[],objects:Params[]=[];
    for(const derived of this.target.derivedSeries){
      const id=derived.indicatorId;if(!id||!wanted(id))continue;
      const instance=doc.indicators.find(i=>i.instanceId===id),layer=doc.layers.find(l=>l.id===id);if(!instance||!layer)continue;
      const index=derived.plotIndex??0;if(instance.hiddenPlots.includes(index)&&!includeHidden)continue;
      const meta={id,name:this.target.layerName(layer),output:derived.name,plotIndex:index,paneId:layer.paneId,color:instance.plotStyles?.[index]?.color??derived.color,timeframe:instance.timeframe};
      if(derived.plot==='line'||derived.plot==='hist')series.push({...meta,plot:derived.plot,values:sampleSeries(derived.values,0,range,size)});
      else if(derived.plot==='markers'){
        const items:Params[]=[];for(let i=range.start;i<range.end&&items.length<500;i++)if(Number.isFinite(derived.values[i]))items.push({time:t(time[i]),value:num(derived.values[i])});
        markers.push({...meta,side:derived.markerSide??null,items});
      }
    }
    for(const plot of this.target.overlayPlots){
      const id=plot.id,layer=id?doc.layers.find(l=>l.id===id):undefined;if(!id||!layer||!wanted(id))continue;
      const meta={id,name:this.target.layerName(layer),output:plot.name??plot.kind,paneId:layer.paneId,color:plot.color},offset=plot.offset??0;
      if(plot.kind==='line'||plot.kind==='hist'||plot.kind==='band')
        series.push({...meta,plot:plot.kind,values:sampleSeries(plot.values,offset,range,size),...(plot.upper?{upper:sampleSeries(plot.upper,offset,range,size)}:{})});
      else if(plot.kind==='markers'){
        const items=plot.markers?plot.markers.filter(m=>inRange(Math.round(m.index))).map(m=>({time:t(m.time),value:num(m.value),side:m.side,...(m.label?{text:m.label}:{})}))
          :[...plot.values.keys()].filter(i=>plot.side?.[i]&&Number.isFinite(plot.values[i])&&inRange(i+offset)).map(i=>({time:t(time[i+offset]),value:num(plot.values[i]),side:plot.side![i]>0?'buy':'sell'}));
        markers.push({...meta,items:items.slice(0,500)});
      }else if(plot.kind==='shapes')
        objects.push({...meta,items:(plot.shapes??[]).filter(s=>inRange(s.index)).slice(0,300).map(s=>({time:t(s.time),shape:s.shape,location:s.location,...(s.text?{text:s.text}:{}),...(s.value!==null?{value:num(s.value)}:{})}))});
      else if(plot.kind==='drawings')
        objects.push({...meta,items:(plot.drawings??[]).filter(d=>Math.max(d.index1,d.index2)>=range.start&&Math.min(d.index1,d.index2)<range.end).slice(0,300)
          .map(d=>({kind:d.kind,...(d.text?{text:d.text}:{}),from:{time:t(timeForIndex(cols,d.index1,this.space().intervalMs)),value:num(d.y1)},to:{time:t(timeForIndex(cols,d.index2,this.space().intervalMs)),value:num(d.y2)}}))});
    }
    return {range:this.rangeSummary(range,format),barsPerPoint:size,time:bucketTimes(cols,range,size,format),series,markers,objects};
  }
  private analysis(p:Params) {
    this.ready();
    const kind=oneOf(p.kind,['all','patterns','observations','candidates'] as const,'kind','all'),limit=int(p.limit,'limit',30,1,300),format=timeFormatOf(p.timeFormat);
    const instanceId=p.instanceId===undefined?undefined:string(p.instanceId,'instanceId'),visibleOnly=p.visibleOnly===true;
    const t=(ms:number|undefined)=>ms===undefined?null:formatTime(ms,format),point=(x:{label:string;time:number;value:number})=>({label:x.label,time:t(x.time),value:num(x.value)});
    const keep=(row:{instanceId:string;visible:boolean})=>(!instanceId||row.instanceId===instanceId)&&(!visibleOnly||row.visible);
    const out:Params={};
    if(kind==='all'||kind==='patterns'){
      const rows=this.target.getPatternRows().filter(keep);
      out.patterns={total:rows.length,items:rows.slice(0,limit).map(({pattern:x,...row})=>({instanceId:row.instanceId,layer:row.layerName,timeframe:row.timeframe,visible:row.visible,
        id:x.id,family:x.family,name:x.name,direction:x.direction,status:x.status,stage:x.stage??null,formation:x.formation??null,confirmedAt:t(x.confirmedAt),
        points:x.points.map(point),zone:{low:num(x.zone.low),high:num(x.zone.high)},invalidation:num(x.invalidation),targets:x.targets.map(num),
        guides:(x.guides??[]).map(g=>({role:g.role,points:g.points.map(point)})),events:(x.events??[]).map(e=>({kind:e.kind,time:t(e.time),value:num(e.value)})),
        ratios:x.ratios.map(r=>({label:r.label,value:num(r.value),expected:r.expected})),description:x.description,...(x.dataWarning?{dataWarning:x.dataWarning}:{})}))};
    }
    if(kind==='all'||kind==='observations'){
      const rows=this.target.getAnalysisRows().filter(keep);
      out.observations={total:rows.length,items:rows.slice(0,limit).map(({observation:x,...row})=>({instanceId:row.instanceId,layer:row.layerName,timeframe:row.timeframe,visible:row.visible,
        id:x.id,family:x.family,name:x.name,direction:x.direction,state:x.state,phase:x.phase??null,time:t(x.time),availableAt:t(x.availableAt),points:x.points.map(point),
        lines:(x.lines??[]).map(line=>({role:line.role,label:line.label??null,points:line.points.map(point)})),
        zone:x.zone?{low:num(x.zone.low),high:num(x.zone.high),from:t(x.zone.fromTime),to:t(x.zone.toTime)}:null,
        events:x.events.slice(-8).map(e=>({kind:e.kind,label:e.label,time:t(e.time),price:num(e.price),explanation:e.explanation})),
        evidence:x.evidence,counterEvidence:x.counterEvidence,waitingFor:x.waitingFor}))};
    }
    if(kind==='all'||kind==='candidates'){
      const rows=this.target.getPatternCandidates().filter(keep);
      out.candidates={total:rows.length,items:rows.slice(0,limit).map(({candidate:x,...row})=>({instanceId:row.instanceId,layer:row.layerName,timeframe:row.timeframe,visible:row.visible,
        id:x.id,family:x.family,name:x.name,direction:x.direction,observedAt:t(x.observedAt),points:x.points.map(point),guides:(x.guides??[]).map(g=>({role:g.role,points:g.points.map(point)})),
        zone:x.zone?{low:num(x.zone.low),high:num(x.zone.high)}:null,ratios:x.ratios.map(r=>({label:r.label,value:num(r.value),expected:r.expected})),description:x.description}))};
    }
    return out;
  }
  private structure(p:Params) {
    this.ready();
    const tolerance=p.tolerance===undefined?.25:finite(p.tolerance,'tolerance');
    if(tolerance<.02||tolerance>3)throw new AgentInputError('tolerance must be between 0.02 and 3 (× ATR)');
    return computeStructure(this.target.data,resolveRange(this.rangeContext(),p.range),this.space().intervalMs,{strength:int(p.strength,'strength',3,1,30),
      maxPivots:int(p.maxPivots,'maxPivots',20,1,300),maxLevels:int(p.maxLevels,'maxLevels',8,1,40),tolerance,format:timeFormatOf(p.timeFormat)});
  }
  /** Text rendition of what is on screen, for models that cannot read images. */
  private layout(p:Params) {
    this.ready();
    const format=timeFormatOf(p.timeFormat),ids=p.ids===undefined?undefined:new Set(strings(p.ids,'ids',500)),objects=measureLayout(this.target);
    const shown=objects.filter(object=>!ids||ids.has(object.id)),v=this.target.viewport,cols=this.target.data,time=cols.col('time');
    const first=Math.max(0,Math.min(cols.length-1,Math.ceil(v.from))),last=Math.max(0,Math.min(cols.length-1,Math.floor(v.to)));
    return {
      viewport:{from:formatTime(time[first],format),to:formatTime(time[last],format),bars:last-first+1,size:this.target.chartSize,
        panes:this.target.paneGeometry().map(pane=>({id:pane.id,name:pane.name,top:num(pane.top),height:num(pane.height),min:num(pane.min),max:num(pane.max)}))},
      objects:shown.map(describeObject),issues:layoutIssues(this.target,objects,ids),
      ...(p.ascii===false?{}:{ascii:asciiChart(this.target,objects,int(p.columns,'columns',96,40,200),int(p.rows,'rows',22,8,60),format)}),
    };
  }
  /** Placement feedback for just-written objects, computed on the settled layout. */
  private checkLayout(ids:string[]) {
    this.target.settle?.();
    const objects=measureLayout(this.target),focus=new Set(ids);
    return {onScreen:Object.fromEntries(objects.filter(object=>focus.has(object.id)).map(object=>[object.id,object.onScreen])),issues:layoutIssues(this.target,objects,focus)};
  }
  private catalog(p:Params) {
    const kind=oneOf(p.kind,['all','tools','indicators'] as const,'kind','all'),detail=p.ids===undefined?undefined:new Set(strings(p.ids,'ids',50));
    const registry=this.target.drawing.registry,groups=new Map(registry.listGroups().map(group=>[group.id,group.name]));
    const out:Params={};
    if(kind!=='indicators')out.tools=registry.list().filter(tool=>(!tool.mode||tool.mode==='draw')&&!tool.onComplete).map(tool=>({
      id:tool.id,name:tool.name,group:groups.get(tool.group)??tool.group,points:tool.freehand?'2-2048 (freehand path)':tool.points??2,
      ...(tool.fields?.length?{fields:tool.fields.map(field=>({key:field.key,label:field.label,type:field.type,default:field.default,...(field.options?{options:field.options}:{}),...(field.min!==undefined?{min:field.min}:{}),...(field.max!==undefined?{max:field.max}:{})}))}:{}),
      ...(textField(tool)?{textProp:textField(tool)}:{}),fill:!!tool.supportsFill,labels:!!tool.supportsLabels,...(tool.defaultStyle?{defaultStyle:tool.defaultStyle}:{})}));
    if(kind!=='tools')out.indicators=this.target.registry.list().filter(def=>!detail||detail.has(def.id)).map(def=>detail?{
      id:def.id,name:def.name,title:def.title??null,kind:def.kind??'indicator',category:def.category??null,family:def.analysisFamily??null,target:def.target,description:def.description??null,tags:def.tags??[],
      inputs:def.inputs.map(input=>({key:input.key,label:input.label,type:input.type,default:input.def,...(input.min!==undefined?{min:input.min}:{}),...(input.max!==undefined?{max:input.max}:{}),...(input.options?{options:input.options}:{})}))}
      :{id:def.id,name:def.name,title:def.title??null,kind:def.kind??'indicator',...(def.category?{category:def.category}:{}),target:def.target,inputs:def.inputs.map(input=>`${input.key}:${input.type}=${input.def}`).join(', ')});
    if(kind==='all'){
      out.panes=this.target.paneGeometry().map(pane=>({id:pane.id,name:pane.name}));
      out.timeframes=Object.keys(TIMEFRAMES);
      out.drawingStyle={color:'#rrggbb or #rgb',width:'1-8',dash:['solid','dashed','dotted'],fillOpacity:'0-1 (shapes with fill)',fontSize:`${MIN_DRAWING_FONT_SIZE}-${MAX_DRAWING_FONT_SIZE} (tools with labels)`};
      out.overlayKinds=OVERLAY_KINDS;
      out.markets=marketConnectors.list().map(connector=>({source:connector.id,label:connector.label,defaultSymbol:connector.defaultSymbol}));
    }
    return out;
  }
  private capture(p:Params) {
    const maxWidth=int(p.maxWidth,'maxWidth',1280,200,4096),format=oneOf(p.format,['png','jpeg'] as const,'format','png');
    const quality=p.quality===undefined?.85:Math.min(1,Math.max(.3,finite(p.quality,'quality')));
    let canvas=this.target.captureImage(maxWidth);
    if(p.paneId!==undefined){
      const pane=this.target.paneGeometry().find(item=>item.id===p.paneId);
      if(!pane)throw new AgentInputError(`paneId "${String(p.paneId)}" is not a pane on this chart`);
      const ratio=canvas.width/this.target.chartSize.width,crop=document.createElement('canvas');
      crop.width=canvas.width;crop.height=Math.max(1,Math.round(pane.height*ratio));
      crop.getContext('2d')!.drawImage(canvas,0,Math.round(pane.top*ratio),canvas.width,crop.height,0,0,crop.width,crop.height);canvas=crop;
    }
    const mimeType=format==='png'?'image/png':'image/jpeg',url=canvas.toDataURL(mimeType,quality);
    return {mimeType,data:url.slice(url.indexOf(',')+1),width:canvas.width,height:canvas.height,pixelsPerCssPx:num(canvas.width/this.target.chartSize.width)};
  }
  private locate(p:Params) {
    this.ready();
    const format=timeFormatOf(p.timeFormat),space=this.space(),panes=this.target.paneGeometry(),width=this.target.chartSize.plotWidth;
    const pixels=p.pixels===undefined?[]:records(p.pixels,'pixels',100),points=p.points===undefined?[]:records(p.points,'points',100);
    return {
      pixels:pixels.map((raw,i)=>{
        const x=finite(raw.x,`pixels[${i}].x`),y=finite(raw.y,`pixels[${i}].y`),hit=this.target.pixelToAnchor({x,y});
        return hit?{x,y,paneId:hit.paneId,time:formatTime(hit.anchor.time,format),value:num(hit.anchor.value),bar:num(indexForTime(space.cols,hit.anchor.time,space.intervalMs))}:{x,y,paneId:null};
      }),
      points:points.map((raw,i)=>{
        const paneId=raw.paneId===undefined?'main':string(raw.paneId,`points[${i}].paneId`),anchor=resolveAnchor(space,raw,`points[${i}]`),pixel=this.target.anchorToPixel(paneId,anchor),pane=panes.find(item=>item.id===paneId);
        return {paneId,time:formatTime(anchor.time,format),value:num(anchor.value),x:pixel?num(pixel.x):null,y:pixel?num(pixel.y):null,
          onScreen:!!pixel&&!!pane&&pixel.x>=0&&pixel.x<=width&&pixel.y>=pane.top&&pixel.y<=pane.top+pane.height};
      }),
    };
  }

  private paneIds():Set<string> {return new Set([...this.target.paneGeometry().map(pane=>pane.id),...this.target.drawing.document.layers.map(layer=>layer.paneId)]);}
  private draw(p:Params) {
    this.ready();this.writableScene();
    const engine=this.target.drawing;
    if(engine.allLocked)throw new AgentBridgeError('LOCKED','the user locked all drawings (drawing toolbar lock); ask them to unlock first');
    const specs=records(p.drawings,'drawings'),space=this.space(),panes=this.paneIds(),doc=structuredClone(engine.document),interval=this.target.chartState.interval;
    const groups=new Map<string,{layer:SceneLayer;reused:boolean}>();
    const groupName=p.group===undefined?undefined:typeof p.group==='string'?string(p.group,'group',120):isRecord(p.group)?string(p.group.name,'group.name',120):(()=>{throw new AgentInputError('group must be a name or {name}');})();
    const groupFor=(paneId:string)=>{
      if(!groupName)return null;
      const existing=groups.get(paneId);if(existing)return existing.layer.id;
      const found=doc.layers.find(layer=>layer.kind==='group'&&layer.paneId===paneId&&layer.name===groupName);
      if(found&&this.target.layerStatus(found.id).locked)throw new AgentBridgeError('LOCKED',`group "${groupName}" is locked`);
      const layer=found??layerOf(crypto.randomUUID(),'group',groupName,paneId,{createdInterval:interval});
      groups.set(paneId,{layer,reused:!!found});return layer.id;
    };
    const created=specs.map((spec,i)=>{
      const label=`drawings[${i}]`,toolId=string(spec.tool,`${label}.tool`,80),tool=engine.registry.get(toolId);
      if(!tool)throw new AgentInputError(`${label}.tool "${toolId}" is not a drawing tool; call get_catalog for tool ids`);
      if(tool.mode&&tool.mode!=='draw'||tool.onComplete)throw new AgentInputError(`${label}.tool "${toolId}" is an interaction tool, not a drawing`);
      const paneId=spec.paneId===undefined?'main':string(spec.paneId,`${label}.paneId`,80);
      if(!panes.has(paneId))throw new AgentInputError(`${label}.paneId "${paneId}" is not a pane on this chart (${[...panes].join(', ')})`);
      if(!Array.isArray(spec.points))throw new AgentInputError(`${label}.points must be an array of anchors`);
      const points=spec.points.map((point,j)=>resolveAnchor(space,point,`${label}.points[${j}]`));
      const expected=tool.freehand?undefined:tool.points??2;
      if(expected!==undefined&&points.length!==expected)throw new AgentInputError(`${label}: tool "${toolId}" takes exactly ${expected} point(s), got ${points.length}`);
      if(expected===undefined&&(points.length<2||points.length>2048))throw new AgentInputError(`${label}: freehand tool "${toolId}" takes 2-2048 points`);
      const props={...Object.fromEntries((tool.fields??[]).map(field=>[field.key,field.default])),...drawingProps(spec.props,`${label}.props`)};
      if(spec.text!==undefined){
        const key=textField(tool);if(!key)throw new AgentInputError(`${label}: tool "${toolId}" has no text field; use the "text" tool or props`);
        props[key]=string(spec.text,`${label}.text`,2000);
      }
      const hidden=spec.hidden===undefined?false:bool(spec.hidden,`${label}.hidden`),locked=spec.locked===undefined?false:bool(spec.locked,`${label}.locked`);
      const drawing:Drawing={id:crypto.randomUUID(),toolId,paneId,points,style:{...DEFAULT_STYLE,...tool.defaultStyle,...drawingStyle(spec.style,`${label}.style`)},props:{...props,author:AGENT_AUTHOR},locked,hidden};
      try{parseDrawingDocument(JSON.stringify({version:1,drawings:[drawing]}),engine.registry);}catch(error){throw new AgentInputError(`${label}: ${error instanceof Error?error.message:String(error)}`);}
      const name=spec.name===undefined?`AI · ${tool.name}`:string(spec.name,`${label}.name`,120);
      const layer=layerOf(drawing.id,'drawing',name,paneId,{parentId:groupFor(paneId),createdInterval:interval,visible:!hidden,locked,intervals:spec.intervals===undefined?null:intervals(spec.intervals,`${label}.intervals`)});
      return {drawing,layer};
    });
    const newGroups=[...groups.values()].filter(group=>!group.reused).map(group=>group.layer);
    this.commit({...doc,drawings:[...doc.drawings,...created.map(c=>c.drawing)],layers:[...doc.layers,...newGroups,...created.map(c=>c.layer)]});
    if(p.select===true)engine.selectLayers(created.map(c=>c.drawing.id));
    const format=timeFormatOf(p.timeFormat);
    return {created:created.map(({drawing,layer})=>{const status=this.target.layerStatus(drawing.id);return {id:drawing.id,tool:drawing.toolId,name:layer.name,paneId:drawing.paneId,groupId:layer.parentId,
        points:drawing.points.map(pt=>({time:formatTime(pt.time,format),value:num(pt.value)})),visible:status.visible,...(status.reason?{reason:status.reason}:{})};}),
      groups:[...groups.values()].map(({layer,reused})=>({id:layer.id,name:layer.name,paneId:layer.paneId,reused})),layout:this.checkLayout(created.map(c=>c.drawing.id)),
      undo:'undo_redo {action:"undo"} removes this whole batch in one step'};
  }
  private update(p:Params) {
    this.ready();this.writableScene();
    const engine=this.target.drawing,space=this.space(),updates=records(p.updates,'updates');
    let next=structuredClone(engine.document);
    for(const [i,u] of updates.entries()){
      const label=`updates[${i}]`,id=string(u.id,`${label}.id`),layer=next.layers.find(l=>l.id===id);
      if(!layer)throw new AgentInputError(`${label}: object "${id}" does not exist`);
      const unlockOnly=Object.keys(u).every(key=>key==='id'||key==='locked')&&u.locked===false;
      if(this.target.layerStatus(id).locked&&!unlockOnly)throw new AgentBridgeError('LOCKED',`${label}: "${layer.name}" is locked (or in a locked group); only {locked:false} can be applied`);
      if(layer.kind==='series'&&(u.parentId!==undefined))throw new AgentInputError(`${label}: price series layers cannot be regrouped`);
      if(u.points!==undefined||u.style!==undefined||u.props!==undefined||u.text!==undefined){
        const drawing=next.drawings.find(d=>d.id===id);
        if(!drawing)throw new AgentInputError(`${label}: points/style/props/text apply to drawings only; use update_indicator for indicators`);
        const tool=engine.registry.get(drawing.toolId),changed:Drawing={...drawing,style:{...drawing.style,...drawingStyle(u.style,`${label}.style`)},props:{...drawing.props,...drawingProps(u.props,`${label}.props`)}};
        if(u.points!==undefined){
          if(!Array.isArray(u.points))throw new AgentInputError(`${label}.points must be an array`);
          changed.points=u.points.map((point,j)=>resolveAnchor(space,point,`${label}.points[${j}]`));
          const expected=tool?.freehand?undefined:tool?.points??drawing.points.length;
          if(expected!==undefined&&changed.points.length!==expected)throw new AgentInputError(`${label}: tool "${drawing.toolId}" takes exactly ${expected} point(s)`);
        }
        if(u.text!==undefined){const key=tool&&textField(tool);if(!key)throw new AgentInputError(`${label}: tool "${drawing.toolId}" has no text field`);changed.props[key]=string(u.text,`${label}.text`,2000);}
        try{parseDrawingDocument(JSON.stringify({version:1,drawings:[changed]}),engine.registry);}catch(error){throw new AgentInputError(`${label}: ${error instanceof Error?error.message:String(error)}`);}
        next={...next,drawings:next.drawings.map(d=>d.id===id?changed:d)};
      }
      const patch:Parameters<typeof updateLayers>[2]={};
      if(u.name!==undefined)patch.name=string(u.name,`${label}.name`,120);
      if(u.visible!==undefined)patch.visible=bool(u.visible,`${label}.visible`);
      if(u.locked!==undefined)patch.locked=bool(u.locked,`${label}.locked`);
      if(u.opacity!==undefined){const opacity=finite(u.opacity,`${label}.opacity`);if(opacity<0||opacity>1)throw new AgentInputError(`${label}.opacity must be between 0 and 1`);patch.opacity=opacity;}
      if(u.intervals!==undefined)patch.intervals=intervals(u.intervals,`${label}.intervals`);
      if(Object.keys(patch).length)next=updateLayers(next,[id],patch);
      try{
        if(u.parentId!==undefined)next=moveToGroup(next,[id],u.parentId===null?null:string(u.parentId,`${label}.parentId`));
        if(u.order!==undefined)next=reorderLayers(next,[id],oneOf(u.order,['front','back','forward','backward'] as const,`${label}.order`,'front'));
      }catch(error){throw new AgentInputError(`${label}: ${error instanceof Error?error.message:String(error)}`);}
    }
    const changed=this.commit(next),format=timeFormatOf(p.timeFormat),doc=engine.document;
    return {changed,layout:this.checkLayout(updates.map(u=>String(u.id))),objects:updates.map(u=>{
      const id=String(u.id),drawing=doc.drawings.find(d=>d.id===id),layer=doc.layers.find(l=>l.id===id);
      return drawing?describeDrawing(this.target,drawing,layer,format,false):layer?{id,kind:layer.kind,name:layer.name,visible:layer.visible,locked:layer.locked,opacity:layer.opacity}:{id,deleted:true};
    })};
  }
  private remove(p:Params) {
    this.ready();this.writableScene();
    const engine=this.target.drawing,doc=engine.document,wanted=new Set<string>();
    if(p.ids!==undefined)for(const id of strings(p.ids,'ids',2000)){if(!doc.layers.some(l=>l.id===id))throw new AgentInputError(`object "${id}" does not exist`);wanted.add(id);}
    if(p.author!==undefined){
      if(p.author!=='agent')throw new AgentInputError("author only accepts 'agent' (the agent never bulk-deletes user work)");
      const agent=new Set(doc.drawings.filter(isAgentDrawing).map(d=>d.id));
      for(const id of agent)wanted.add(id);
      // Groups whose drawings are all agent-authored go with them.
      for(const group of doc.layers.filter(l=>l.kind==='group')){const children=descendants(doc,group.id);if(children.length&&children.every(child=>agent.has(child)||doc.layers.find(l=>l.id===child)?.kind==='group'))wanted.add(group.id);}
    }
    if(p.groupId!==undefined){const id=string(p.groupId,'groupId');if(doc.layers.find(l=>l.id===id)?.kind!=='group')throw new AgentInputError(`"${id}" is not a group`);wanted.add(id);}
    if(!wanted.size)throw new AgentInputError('give ids, author:"agent" or groupId');
    const overlays=[...wanted].filter(id=>doc.layers.find(l=>l.id===id)?.kind==='overlay');
    for(const id of overlays)if(!id.startsWith('agent:'))throw new AgentInputError(`"${id}" belongs to another external producer; only agent-owned overlays may be removed here`);
    for(const id of wanted)if(doc.layers.find(l=>l.id===id)?.kind==='series')throw new AgentInputError(`"${id}" is the price/volume series; hide it with update_objects {visible:false} instead of deleting`);
    const own=overlays.filter(id=>this.overlays.has(this.overlayKey(id.slice('agent:'.length))));
    for(const id of own)this.overlays.delete(this.overlayKey(id.slice('agent:'.length)));
    if(own.length)this.pushOverlays(this.supplied.ids);
    const layers=[...wanted].filter(id=>!own.includes(id)),current=engine.document;
    const next=layers.length?deleteLayers(structuredClone(current),layers,this.target.chartState.interval):current;
    const removed=new Set(current.layers.filter(l=>!next.layers.some(n=>n.id===l.id)).map(l=>l.id));
    if(layers.length)this.commit(next);
    const skipped=layers.filter(id=>!removed.has(id));
    return {deleted:[...own,...removed],...(skipped.length?{skippedLocked:skipped}:{}),undo:'undo_redo {action:"undo"} restores what was deleted'};
  }
  private overlayKey(id:string):string {return `${this.market}|${id}`;}
  private overlaySet(p:Params) {
    this.ready();this.writableScene();
    const specs=p.overlays===undefined?[p]:records(p.overlays,'overlays',20),market=this.market,space=this.space();
    const parsed=specs.map(spec=>parseOverlay(space,spec,{market,panes:this.paneIds()}));
    for(const overlay of parsed)this.overlays.set(this.overlayKey(overlay.id),overlay);
    this.pushOverlays(this.supplied.ids);
    return {overlays:parsed.map(overlay=>{
      const plot=materializeOverlay(space,overlay),placed=overlay.kind==='line'||overlay.kind==='hist'||overlay.kind==='band'?plot.values.filter(Number.isFinite).length:undefined;
      return {...describeOverlay(overlay),...(placed!==undefined&&overlay.fill==='none'&&placed<overlay.points.length?{droppedOutsideLoadedBars:overlay.points.length-placed}:{})};
    }),note:'Overlays are session-only chart outputs; use draw for editable, saved annotations.'};
  }
  private overlayRemove(p:Params) {
    this.writableScene();
    const market=this.market,mine=[...this.overlays.values()].filter(o=>o.market===market);
    const ids=p.all===true?mine.map(o=>o.id):strings(p.ids??[],'ids',100).map(id=>id.startsWith('agent:')?id.slice(6):id);
    const removed=ids.filter(id=>this.overlays.delete(this.overlayKey(id)));
    if(removed.length)this.pushOverlays(this.supplied.ids);
    return {removed:removed.map(id=>`agent:${id}`),remaining:mine.length-removed.length};
  }
  private definition(type:string):IndicatorDef {
    const def=this.target.registry.list().find(item=>item.id===type);
    if(!def)throw new AgentInputError(`unknown indicator "${type}"; call get_catalog {kind:"indicators"} for ids`);
    return def;
  }
  private timeframe(value:unknown):string {
    const timeframe=value===undefined?'chart':string(value,'timeframe',8);
    if(timeframe!=='chart'&&!Object.hasOwn(TIMEFRAMES,timeframe))throw new AgentInputError(`timeframe must be "chart" or one of ${Object.keys(TIMEFRAMES).join(', ')}`);
    return timeframe;
  }
  private indicatorSummary(id:string) {
    const doc=this.target.drawing.document,instance=doc.indicators.find(i=>i.instanceId===id),layer=doc.layers.find(l=>l.id===id);
    return instance&&layer?{id,type:instance.id,name:this.target.layerName(layer),paneId:layer.paneId,timeframe:instance.timeframe,params:instance.params,hiddenPlots:instance.hiddenPlots,plotStyles:instance.plotStyles??{},visible:layer.visible}:{id,deleted:true};
  }
  private plotStyles(raw:unknown,current:Record<string,IndicatorPlotStyle>|undefined):Record<string,IndicatorPlotStyle> {
    if(!isRecord(raw))throw new AgentInputError('plotStyles must be an object keyed by output index, e.g. {"0":{"color":"#ff9800","width":2}}');
    const out={...current};
    for(const [index,value] of Object.entries(raw)){
      if(!/^\d{1,2}$/.test(index)||Number(index)>63||!isRecord(value))throw new AgentInputError(`plotStyles.${index} must be {color?, width?} under an output index 0-63`);
      const style:IndicatorPlotStyle={...out[index]};
      if(value.color!==undefined)style.color=hexColor(value.color,`plotStyles.${index}.color`);
      if(value.width!==undefined){const width=finite(value.width,`plotStyles.${index}.width`);if(width<1||width>8)throw new AgentInputError(`plotStyles.${index}.width must be between 1 and 8`);style.width=width;}
      out[index]=style;
    }
    try{validatePlotStyles(out);}catch(error){throw new AgentInputError(error instanceof Error?error.message:String(error));}
    return out;
  }
  private indicatorAdd(p:Params) {
    this.ready();this.writableScene();
    const type=string(p.type,'type',80),def=this.definition(type),timeframe=this.timeframe(p.timeframe);
    const paneId=p.paneId===undefined?undefined:string(p.paneId,'paneId',80);
    if(paneId&&!/^[\w:.-]{1,80}$/.test(paneId))throw new AgentInputError('paneId may contain letters, digits, "_", "-", ":" and "."');
    const params=p.params===undefined?{}:normalizeParams(def,p.params),name=p.name===undefined?undefined:string(p.name,'name',120);
    const id=this.target.addIndicator(type,timeframe,paneId,{params,name});
    if(!id)throw new AgentBridgeError('FAILED',this.target.drawing.state.error||'the indicator could not be added');
    if(p.plotStyles!==undefined){
      const doc=structuredClone(this.target.drawing.document),instance=doc.indicators.find(i=>i.instanceId===id)!;
      instance.plotStyles=this.plotStyles(p.plotStyles,instance.plotStyles);this.commit(doc);
    }
    return this.indicatorSummary(id);
  }
  private indicatorUpdate(p:Params) {
    this.ready();this.writableScene();
    const id=string(p.id,'id',80);let doc=structuredClone(this.target.drawing.document);
    const instance=doc.indicators.find(i=>i.instanceId===id);
    if(!instance)throw new AgentInputError(`"${id}" is not an indicator instance on this chart`);
    if(this.target.layerStatus(id).locked)throw new AgentBridgeError('LOCKED',`indicator "${id}" is locked`);
    if(p.params!==undefined)instance.params={...instance.params,...normalizeParams(this.definition(instance.id),p.params)};
    if(p.timeframe!==undefined)instance.timeframe=this.timeframe(p.timeframe);
    if(p.plotStyles!==undefined)instance.plotStyles=this.plotStyles(p.plotStyles,instance.plotStyles);
    if(p.hiddenPlots!==undefined){
      if(!Array.isArray(p.hiddenPlots)||p.hiddenPlots.some(i=>!Number.isInteger(i)||i<0||i>63))throw new AgentInputError('hiddenPlots must be an array of output indices 0-63');
      instance.hiddenPlots=[...new Set(p.hiddenPlots as number[])];
    }
    const patch:Parameters<typeof updateLayers>[2]={};
    if(p.visible!==undefined)patch.visible=bool(p.visible,'visible');
    if(p.name!==undefined)patch.name=string(p.name,'name',120);
    if(Object.keys(patch).length)doc=updateLayers(doc,[id],patch);
    return {changed:this.commit(doc),indicator:this.indicatorSummary(id)};
  }
  private async view(p:Params,progress:Progress=()=>{}) {
    const applied:string[]=[];
    if(p.market!==undefined){
      this.writableScene();
      if(!isRecord(p.market))throw new AgentInputError('market must be {source?, symbol?, interval?}');
      const s=this.target.chartState,source=p.market.source===undefined?s.source:string(p.market.source,'market.source',40);
      const connector=marketConnectors.get(source);
      if(!connector)throw new AgentInputError(`unknown market source "${source}"; available: ${marketConnectors.list().map(c=>c.id).join(', ')}`);
      const symbol=connector.normalizeSymbol(p.market.symbol===undefined?s.symbol:string(p.market.symbol,'market.symbol',40));
      if(!symbol)throw new AgentInputError(`symbol is not valid for source "${source}" (default: ${connector.defaultSymbol})`);
      const interval=p.market.interval===undefined?s.interval:string(p.market.interval,'market.interval',8);
      if(!Object.hasOwn(TIMEFRAMES,interval))throw new AgentInputError(`market.interval must be one of ${Object.keys(TIMEFRAMES).join(', ')}`);
      progress({message:`loading ${source}:${symbol}:${interval}`,progress:0,total:1});
      await this.target.setMarket(source,symbol,interval);
      progress({message:`loaded ${this.target.data.length} bars`,progress:1,total:1});
      const after=this.target.chartState;if(after.error)throw new AgentBridgeError('FAILED',after.error);
      applied.push(`market ${source}:${symbol}:${interval}`);
    }
    this.ready();
    if(p.showAll===true){this.target.showAll();applied.push('showAll');}
    if(p.range!==undefined){
      const range=resolveRange(this.rangeContext(),p.range),time=this.target.data.col('time');
      if(range.end<=range.start)throw new AgentInputError('range contains no loaded bars');
      this.target.focusTimeRange(time[range.start],time[range.end-1]);applied.push('range');
    }
    if(p.follow===true){this.target.followLatest();applied.push('follow');}
    if(p.zoom!==undefined){const factor=finite(p.zoom,'zoom');if(factor<.05||factor>20)throw new AgentInputError('zoom must be between 0.05 and 20 (>1 zooms in)');this.target.zoom(factor);applied.push('zoom');}
    if(p.maximizePane!==undefined){
      const current=this.target.maximizedPaneId;
      if(p.maximizePane===null){if(current)this.target.toggleMaximize(current);}
      else{const id=string(p.maximizePane,'maximizePane',80);if(!this.target.paneGeometry().some(pane=>pane.id===id))throw new AgentInputError(`"${id}" is not a pane`);if(current!==id)this.target.toggleMaximize(id);}
      applied.push('maximizePane');
    }
    if(p.resetScale!==undefined){
      const id=string(p.resetScale,'resetScale',80);
      for(const pane of this.target.paneGeometry())if(id==='all'||pane.id===id)this.target.resetPaneScale(pane.id);
      applied.push('resetScale');
    }
    this.target.settle?.();
    return {applied,...buildSnapshot(this.target,{include:new Set(['market','viewport']),format:timeFormatOf(p.timeFormat),recentBars:0,maxDrawings:1,fullPoints:false,overlays:[]})};
  }
  private select(p:Params) {
    this.writableScene();
    const ids=strings(p.ids??[],'ids',500),doc=this.target.drawing.document;
    for(const id of ids)if(!doc.layers.some(layer=>layer.id===id))throw new AgentInputError(`object "${id}" does not exist`);
    this.target.drawing.selectLayers(ids);
    if(p.reveal===true)this.options.ui?.revealObjects?.(ids);
    if(p.properties===true&&ids.length)this.options.ui?.openProperties?.(ids);
    return {selected:ids};
  }
  private history(p:Params) {
    this.writableScene();
    const action=oneOf(p.action,['undo','redo'] as const,'action','undo'),steps=int(p.steps,'steps',1,1,50),engine=this.target.drawing;
    let applied=0;
    for(;applied<steps;applied++){const state=engine.state;if(action==='undo'?!state.canUndo:!state.canRedo)break;if(action==='undo')engine.undo();else engine.redo();}
    const state=engine.state;return {action,applied,canUndo:state.canUndo,canRedo:state.canRedo};
  }
}
