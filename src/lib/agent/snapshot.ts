import type {Drawing} from '../drawing/types';
import type {DrawingState} from '../drawing/types';
import type {SceneDocument,SceneLayer} from '../scene/types';
import {TIMEFRAMES} from '../scene/types';
import {indexForTime} from '../drawing/coordinates';
import {orderedLayers,descendants} from '../scene/model';
import {formatTime,num,type TimeFormat} from './anchors';
import {aggregateBars} from './sampling';
import {visibleSceneLayers} from '../chart/scene-visibility';
import type {ChartAgentTarget} from './target';
import {describeOverlay,type AgentOverlay} from './overlays';

/** Global state of one chart as the agent sees it. Every section is plain
 * JSON; heavy data (bar history, indicator arrays, analysis geometry) has its
 * own paged methods so a state read stays small. */
export const STATE_SECTIONS=['market','cursor','viewport','selection','tools','layers','drawings','indicators','overlays','analysis','appearance','recentBars'] as const;
export type StateSection=typeof STATE_SECTIONS[number];
export interface SnapshotOptions {
  include:ReadonlySet<StateSection>;format:TimeFormat;recentBars:number;maxDrawings:number;fullPoints:boolean;
  overlays:readonly AgentOverlay[];
}
export const AGENT_AUTHOR='agent';
export const isAgentDrawing=(drawing:Drawing)=>drawing.props.author===AGENT_AUTHOR;
/** Time span covered by the selected objects (drawings, and groups through their drawings). */
export function selectionSpan(doc:SceneDocument,ids:readonly string[]):{from:number;to:number}|undefined {
  const wanted=new Set(ids.flatMap(id=>[id,...descendants(doc,id)]));
  const times=doc.drawings.filter(d=>wanted.has(d.id)).flatMap(d=>d.points.map(p=>p.time));
  return times.length?{from:Math.min(...times),to:Math.max(...times)}:undefined;
}
function tone(color:string):'light'|'dark' {
  const hex=/^#([\da-f]{6})/i.exec(color)?.[1];if(!hex)return 'dark';
  const [r,g,b]=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255);
  return .2126*r+.7152*g+.0722*b>.5?'light':'dark';
}
export function describeDrawing(target:ChartAgentTarget,drawing:Drawing,layer:SceneLayer|undefined,format:TimeFormat,fullPoints:boolean){
  const points=drawing.points.map(p=>({time:formatTime(p.time,format),value:num(p.value)}));
  const sampled=fullPoints||points.length<=12?points:points.filter((_,i)=>i%Math.ceil(points.length/11)===0||i===points.length-1);
  const status=target.layerStatus(drawing.id),{author,...props}=drawing.props;
  return {id:drawing.id,tool:drawing.toolId,toolName:target.drawing.registry.get(drawing.toolId)?.name??null,name:layer?.name??null,paneId:drawing.paneId,parentId:layer?.parentId??null,
    points:sampled,...(sampled.length!==points.length?{pointCount:points.length}:{}),style:drawing.style,props,author:author===AGENT_AUTHOR?'agent':'user',
    locked:status.locked,visible:status.visible,...(status.reason?{reason:status.reason}:{})};
}
export function describeLayer(target:ChartAgentTarget,doc:SceneDocument,layer:SceneLayer){
  const status=target.layerStatus(layer.id);
  return {id:layer.id,kind:layer.kind,name:target.layerName(layer),paneId:layer.paneId,parentId:layer.parentId,visible:layer.visible,locked:layer.locked,opacity:layer.opacity,
    intervals:layer.intervals,effective:{visible:status.visible,locked:status.locked,opacity:num(status.opacity),reason:status.reason||status.dataReason||null},
    ...(layer.kind==='group'?{children:doc.layers.filter(child=>child.parentId===layer.id).map(child=>child.id)}:{})};
}
export function buildSnapshot(target:ChartAgentTarget,options:SnapshotOptions):Record<string,unknown> {
  const state=target.chartState,cols=target.data,n=cols.length,time=cols.col('time'),format=options.format,has=(section:StateSection)=>options.include.has(section);
  const engine:DrawingState=target.drawing.state,stored=engine.scene.document,doc={...stored,layers:visibleSceneLayers(stored.layers)},layers=new Map(doc.layers.map(layer=>[layer.id,layer]));
  const bar=(i:number)=>({time:formatTime(time[i],format),open:num(cols.col('open')[i]),high:num(cols.col('high')[i]),low:num(cols.col('low')[i]),close:num(cols.col('close')[i]),volume:num(cols.col('volume')[i])});
  const out:Record<string,unknown>={};
  if(has('market'))out.market={source:state.source,symbol:state.symbol,interval:state.interval,intervalMs:TIMEFRAMES[state.interval]??null,marketType:state.marketType??null,
    tickSize:state.contract?.tickSize??null,status:state.status,loading:state.loading,error:state.error||null,warning:state.warning||null,following:state.following,paused:state.paused,
    historicalSnapshot:!!state.historicalSnapshot,analysisReplay:!!state.analysisReplay,indicatorsPending:state.indicatorsPending,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
    bars:{total:n,first:n?formatTime(time[0],format):null,last:n?formatTime(time[n-1],format):null,
      confirmedThrough:state.confirmedBarTime!=null?formatTime(state.confirmedBarTime,format):null,lastBarForming:!!n&&state.confirmedBarTime!==time[n-1]},
    latest:n?bar(n-1):null};
  if(has('cursor')){
    const hovered=state.hover&&state.quote&&n?Math.max(0,Math.min(n-1,Math.round(indexForTime(cols,state.quote.time,TIMEFRAMES[state.interval]??60_000)))):-1;
    out.cursor={hovering:hovered>=0,bar:hovered>=0?{...bar(hovered),barIndex:hovered,barsAgo:n-1-hovered}:null};
  }
  if(has('viewport')){
    const v=target.viewport,size=target.chartSize,first=Math.max(0,Math.min(n-1,Math.floor(v.from))),last=Math.max(0,Math.min(n-1,Math.ceil(v.to)));
    out.viewport={fromBar:num(v.from),toBar:num(v.to),visibleBars:state.visible,from:n?formatTime(time[first],format):null,to:n?formatTime(time[last],format):null,
      barSpacingPx:num(v.barWidth),size:{width:size.width,height:size.height,plotWidth:size.plotWidth,priceAxisWidth:size.axisWidth,timeAxisHeight:size.axisHeight},
      maximizedPane:target.maximizedPaneId,panes:target.paneGeometry().map(p=>({id:p.id,name:p.name,top:num(p.top),height:num(p.height),min:num(p.min),max:num(p.max),manualScale:p.manual}))};
  }
  if(has('selection')){
    const span=selectionSpan(doc,engine.scene.selectedIds);
    out.selection={ids:engine.scene.selectedIds.filter(id=>layers.has(id)),activeGroupId:engine.scene.activeGroupId,
      objects:engine.scene.selectedIds.flatMap(id=>{const layer=layers.get(id);if(!layer)return [];const drawing=doc.drawings.find(d=>d.id===id);
        return [drawing?describeDrawing(target,drawing,layer,format,options.fullPoints):describeLayer(target,doc,layer)];}),
      timeSpan:span?{from:formatTime(span.from,format),to:formatTime(span.to,format)}:null};
  }
  if(has('tools'))out.tools={activeTool:engine.activeTool,placing:engine.placing,magnet:engine.magnet?engine.magnetStrength:'off',stayDrawing:engine.stayDrawing,
    allLocked:engine.locked,allHidden:engine.hidden,canUndo:engine.canUndo,canRedo:engine.canRedo,error:engine.error||null};
  if(has('layers')){
    const paint=new Map(orderedLayers(doc).map((layer,i)=>[layer.id,i]));
    out.layers={order:'paintIndex is back-to-front; groups own contiguous blocks',items:doc.layers.map(layer=>({...describeLayer(target,doc,layer),...(paint.has(layer.id)?{paintIndex:paint.get(layer.id)}:{})}))};
  }
  if(has('drawings')){
    const drawings=doc.drawings.slice(-options.maxDrawings);
    out.drawings={total:doc.drawings.length,agent:doc.drawings.filter(isAgentDrawing).length,...(drawings.length<doc.drawings.length?{truncated:`newest ${drawings.length} shown`}:{}),
      items:drawings.map(d=>describeDrawing(target,d,layers.get(d.id),format,options.fullPoints))};
  }
  if(has('indicators')){
    out.indicators={valuesAt:state.quote?formatTime(state.quote.time,format):null,items:doc.indicators.map(instance=>{
      const layer=layers.get(instance.instanceId),definition=target.registry.list().find(def=>def.id===instance.id),reading=state.readings.find(r=>r.id===instance.instanceId),status=target.layerStatus(instance.instanceId);
      return {id:instance.instanceId,type:instance.id,name:layer?target.layerName(layer):instance.id,title:definition?.title??definition?.name??null,kind:definition?.kind??'indicator',
        ...(definition?.category?{category:definition.category}:{}),paneId:layer?.paneId??null,timeframe:instance.timeframe,params:instance.params,
        visible:status.visible,locked:status.locked,status:reading?.status||status.reason||null,hiddenPlots:instance.hiddenPlots,...(instance.plotStyles?{plotStyles:instance.plotStyles}:{}),
        outputs:reading?.values.map(value=>({index:value.plotIndex??0,name:value.name,plot:value.plot??'line',value:num(value.value),color:value.color??null,hidden:!!value.hidden}))??[]};
    })};
  }
  if(has('overlays')){
    const agent=new Map(options.overlays.map(overlay=>[`agent:${overlay.id}`,overlay]));
    out.overlays=doc.layers.filter(layer=>layer.kind==='overlay').map(layer=>{
      const status=target.layerStatus(layer.id),plot=target.overlayPlots.find(p=>p.id===layer.id),own=agent.get(layer.id);
      return {...(own?describeOverlay(own):{id:layer.id,kind:plot?.kind??null,paneId:layer.paneId}),name:target.layerName(layer),
        owner:own?'agent':'external',visible:status.visible,status:status.reason||status.dataReason||null};
    });
  }
  if(has('analysis')){
    const patterns=target.getPatternRows(),observations=target.getAnalysisRows(),candidates=target.getPatternCandidates();
    const latest=[...patterns.map(r=>({kind:'pattern',name:r.pattern.name,direction:r.pattern.direction,time:r.pattern.confirmedAt,layer:r.layerName})),
      ...observations.map(r=>({kind:'observation',name:r.observation.name,direction:r.observation.direction,time:r.observation.availableAt,layer:r.layerName}))]
      .sort((a,b)=>b.time-a.time).slice(0,8).map(item=>({...item,time:formatTime(item.time,format)}));
    out.analysis={patterns:patterns.length,observations:observations.length,candidates:candidates.length,latest};
  }
  if(has('appearance')){const a=target.getAppearance();out.appearance={preset:a.preset,tone:tone(a.background),background:a.background,text:a.textColor,up:a.upColor,down:a.downColor};}
  if(has('recentBars')&&options.recentBars>0&&n){
    const start=Math.max(0,n-options.recentBars);
    out.recentBars={columns:['time','open','high','low','close','volume'],rows:aggregateBars(cols,{start,end:n},1,['time','open','high','low','close','volume'],format)};
  }
  return out;
}
