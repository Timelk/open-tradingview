import type {Drawing,Primitive,Projection} from '../drawing/types';
import type {OverlayPlot} from '../core/types';
import {drawingFontSize,estimateLabelWidth,labelHeight} from '../drawing/labels';
import {indexForTime,timeForIndex} from '../drawing/coordinates';
import {TIMEFRAMES} from '../scene/types';
import {formatTime,num,type TimeFormat} from './anchors';
import type {ChartAgentTarget} from './target';

/** "Seeing" the chart as text: the exact primitives each tool renders
 * (tool.build with the live projection), reduced to screen boxes, visibility
 * and collisions. Works for models without vision and costs one round trip. */
interface Box {x0:number;y0:number;x1:number;y1:number}
interface Label extends Box {text:string;ownerId:string;ownerName:string;paneId:string;clipped:boolean}
export interface ObjectLayout {
  id:string;name:string;kind:'drawing'|'overlay';tool:string;paneId:string;author:'agent'|'user'|'external';
  onScreen:'full'|'partial'|'off';offscreen?:string;bbox:Box|null;labels:Label[];primitives:Primitive[];
}
export interface LayoutIssue {id:string;name:string;kind:'offscreen'|'clipped-label'|'label-overlap'|'label-covers-candles';detail:string}
const round=(box:Box):Box=>({x0:num(box.x0)!,y0:num(box.y0)!,x1:num(box.x1)!,y1:num(box.y1)!});
const intersect=(a:Box,b:Box)=>Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))*Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));
const area=(box:Box)=>Math.max(0,box.x1-box.x0)*Math.max(0,box.y1-box.y0);

export function projectionFor(target:ChartAgentTarget,paneId:string):Projection|null {
  const pane=target.paneGeometry().find(item=>item.id===paneId);if(!pane)return null;
  const cols=target.data,intervalMs=TIMEFRAMES[target.chartState.interval]??60_000;
  return {pane:{id:paneId,top:pane.top,height:pane.height,width:target.chartSize.plotWidth},
    project:anchor=>target.anchorToPixel(paneId,anchor)??{x:Number.NaN,y:Number.NaN},indexAt:time=>indexForTime(cols,time,intervalMs)};
}
/** Same box as the canvas label renderer and its hit test. */
function labelBox(primitive:Extract<Primitive,{kind:'text'}>,drawing:Drawing):Box {
  const size=drawingFontSize(drawing,primitive.size),padding=primitive.background?Math.max(5,Math.ceil(size*.3)):0;
  const width=Math.min(estimateLabelWidth(primitive.text,size)+padding*2,primitive.maxWidth??Infinity),height=labelHeight(size);
  const x=primitive.at.x-(primitive.align==='center'?width/2:primitive.align==='right'?width-padding:padding);
  return {x0:x,y0:primitive.at.y-height/2,x1:x+width,y1:primitive.at.y+height/2};
}
function extend(box:Box|null,x:number,y:number,limit:Box):Box|null {
  if(!Number.isFinite(x)||!Number.isFinite(y))return box;
  // Rays and full-width lines are generated with ±1e5 px ends; clamp them to the pane.
  x=Math.max(limit.x0-limit.x1,Math.min(limit.x1*2,x));y=Math.max(limit.y0-(limit.y1-limit.y0),Math.min(limit.y1+(limit.y1-limit.y0),y));
  return box?{x0:Math.min(box.x0,x),y0:Math.min(box.y0,y),x1:Math.max(box.x1,x),y1:Math.max(box.y1,y)}:{x0:x,y0:y,x1:x,y1:y};
}
function visibility(box:Box|null,pane:Box):Pick<ObjectLayout,'onScreen'|'offscreen'> {
  if(!box)return {onScreen:'off',offscreen:'not projected'};
  if(box.x0>=pane.x0&&box.x1<=pane.x1&&box.y0>=pane.y0&&box.y1<=pane.y1)return {onScreen:'full'};
  if(box.x1>=pane.x0&&box.x0<=pane.x1&&box.y1>=pane.y0&&box.y0<=pane.y1)return {onScreen:'partial'};
  return {onScreen:'off',offscreen:box.x1<pane.x0?'left of the visible range':box.x0>pane.x1?'right of the visible range':box.y1<pane.y0?'above the price range':'below the price range'};
}
/** Overlay labels follow the producer-neutral object renderer's geometry. */
function overlayObjects(target:ChartAgentTarget,plot:OverlayPlot,paneBox:Box):{labels:{text:string;box:Box}[];bbox:Box|null} {
  const cols=target.data,intervalMs=TIMEFRAMES[target.chartState.interval]??60_000,paneId=plot.paneId??'main',labels:{text:string;box:Box}[]=[];let bbox:Box|null=null;
  const at=(index:number,value:number)=>target.anchorToPixel(paneId,{time:timeForIndex(cols,index,intervalMs),value});
  for(const drawing of plot.drawings??[]){
    const first=at(drawing.index1,drawing.yloc==='abovebar'?cols.col('high')[Math.round(drawing.index1)]:drawing.yloc==='belowbar'?cols.col('low')[Math.round(drawing.index1)]:drawing.y1),second=at(drawing.index2,drawing.y2);
    if(!first||!second)continue;
    if(drawing.kind!=='label'){bbox=extend(extend(bbox,first.x,first.y,paneBox),second.x,second.y,paneBox);continue;}
    const lines=drawing.text.split('\n'),empty=!drawing.text,none=drawing.style==='none';
    let width=drawing.style==='circle'&&empty?drawing.fontSize:Math.max(drawing.fontSize,Math.max(0,...lines.map(line=>estimateLabelWidth(line,drawing.fontSize)))+(none?0:8));
    let height=empty?drawing.fontSize:lines.length*drawing.fontSize*1.25+(none?0:6);
    if(drawing.style==='circle'||drawing.style==='square'){width=Math.max(width,height);height=width;}
    const direction=drawing.yloc==='abovebar'?-1:drawing.yloc==='belowbar'?1:drawing.style==='label_down'?-1:drawing.style==='label_up'?1:0;
    const top=direction<0?first.y-6-height:direction>0?first.y+6:first.y-height/2,left=drawing.style==='label_left'?first.x+5:drawing.style==='label_right'?first.x-5-width:first.x-width/2;
    const box={x0:left,y0:top,x1:left+width,y1:top+height};labels.push({text:drawing.text,box});
    bbox=extend(extend(bbox,box.x0,box.y0,paneBox),box.x1,box.y1,paneBox);
  }
  return {labels,bbox};
}
export function measureLayout(target:ChartAgentTarget):ObjectLayout[] {
  const engine=target.drawing,doc=engine.document,out:ObjectLayout[]=[],projections=new Map<string,Projection|null>();
  const projection=(paneId:string)=>{if(!projections.has(paneId))projections.set(paneId,projectionFor(target,paneId));return projections.get(paneId)!;};
  const paneBoxOf=(p:Projection):Box=>({x0:0,y0:p.pane.top,x1:p.pane.width,y1:p.pane.top+p.pane.height});
  for(const drawing of doc.drawings){
    if(!target.layerStatus(drawing.id).visible)continue;
    const tool=engine.registry.get(drawing.toolId),p=projection(drawing.paneId),layer=doc.layers.find(l=>l.id===drawing.id);if(!tool||!p)continue;
    let primitives:Primitive[]=[];try{primitives=tool.build(drawing,p);}catch{continue;}
    const paneBox=paneBoxOf(p),labels:Label[]=[];let bbox:Box|null=null;
    for(const primitive of primitives){
      if(primitive.kind==='path')for(const point of primitive.points)bbox=extend(bbox,point.x,point.y,paneBox);
      else if(primitive.kind!=='text'){bbox=extend(bbox,primitive.a.x,primitive.a.y,paneBox);bbox=extend(bbox,primitive.b.x,primitive.b.y,paneBox);}
      else{
        const box=labelBox(primitive,drawing);bbox=extend(extend(bbox,box.x0,box.y0,paneBox),box.x1,box.y1,paneBox);
        labels.push({...box,text:primitive.text,ownerId:drawing.id,ownerName:layer?.name??tool.name,paneId:drawing.paneId,clipped:box.x0<paneBox.x0||box.x1>paneBox.x1||box.y0<paneBox.y0||box.y1>paneBox.y1});
      }
    }
    out.push({id:drawing.id,name:layer?.name??tool.name,kind:'drawing',tool:drawing.toolId,paneId:drawing.paneId,author:drawing.props.author==='agent'?'agent':'user',...visibility(bbox,paneBox),bbox,labels,primitives});
  }
  for(const plot of target.overlayPlots){
    if(!plot.id||!target.layerStatus(plot.id).visible||(plot.kind!=='drawings'))continue;
    const paneId=plot.paneId??'main',p=projection(paneId);if(!p)continue;
    const paneBox=paneBoxOf(p),{labels,bbox}=overlayObjects(target,plot,paneBox),layer=doc.layers.find(l=>l.id===plot.id),name=layer?target.layerName(layer):plot.name??plot.id;
    out.push({id:plot.id,name,kind:'overlay',tool:'objects',paneId,author:plot.id.startsWith('agent:')?'agent':'external',...visibility(bbox,paneBox),bbox,primitives:[],
      labels:labels.map(label=>({...label.box,text:label.text,ownerId:plot.id!,ownerName:name,paneId,clipped:label.box.x0<paneBox.x0||label.box.x1>paneBox.x1||label.box.y0<paneBox.y0||label.box.y1>paneBox.y1}))});
  }
  return out;
}
/** Bars whose wick/body runs through a label box on the main pane. */
function coveredCandles(target:ChartAgentTarget,label:Label):number {
  if(label.paneId!=='main')return 0;
  const v=target.viewport,cols=target.data,from=Math.max(0,Math.floor(v.indexAt(label.x0))),to=Math.min(cols.length-1,Math.ceil(v.indexAt(label.x1)));let count=0;
  for(let i=from;i<=to;i++){
    const time=cols.col('time')[i],top=target.anchorToPixel('main',{time,value:cols.col('high')[i]}),bottom=target.anchorToPixel('main',{time,value:cols.col('low')[i]});
    if(top&&bottom&&top.x>=label.x0&&top.x<=label.x1&&top.y<=label.y1&&bottom.y>=label.y0)count++;
  }
  return count;
}
export function layoutIssues(target:ChartAgentTarget,objects:readonly ObjectLayout[],focus?:ReadonlySet<string>):LayoutIssue[] {
  const issues:LayoutIssue[]=[],labels=objects.flatMap(object=>object.labels),wanted=(id:string)=>!focus||focus.has(id);
  for(const object of objects){
    if(!wanted(object.id))continue;
    if(object.onScreen==='off')issues.push({id:object.id,name:object.name,kind:'offscreen',detail:`not visible: ${object.offscreen}`});
    for(const label of object.labels){
      if(label.clipped)issues.push({id:object.id,name:object.name,kind:'clipped-label',detail:`label "${label.text.slice(0,40)}" is cut off by the pane edge`});
      const candles=coveredCandles(target,label);
      if(candles>=2)issues.push({id:object.id,name:object.name,kind:'label-covers-candles',detail:`label "${label.text.slice(0,40)}" covers ${candles} candles`});
      for(const other of labels){
        if(other.ownerId===object.id||other.paneId!==label.paneId)continue;
        const shared=intersect(label,other);
        if(shared>.15*Math.min(area(label),area(other)))issues.push({id:object.id,name:object.name,kind:'label-overlap',detail:`label "${label.text.slice(0,40)}" overlaps "${other.text.slice(0,40)}" of ${other.ownerName}`});
      }
    }
  }
  // An overlap between two focused objects is reported once.
  return issues.filter((issue,index)=>issues.findIndex(other=>other.kind===issue.kind&&other.detail===issue.detail)===index);
}
export function describeObject(object:ObjectLayout){
  return {id:object.id,name:object.name,kind:object.kind,tool:object.tool,paneId:object.paneId,author:object.author,onScreen:object.onScreen,
    ...(object.offscreen?{offscreen:object.offscreen}:{}),bbox:object.bbox?round(object.bbox):null,
    labels:object.labels.map(label=>({text:label.text,...round(label),...(label.clipped?{clipped:true}:{})}))};
}
/** Coarse character rendering of the main pane (candles, drawings, labels) for text-only models. */
export function asciiChart(target:ChartAgentTarget,objects:readonly ObjectLayout[],columns=96,rows=22,format:TimeFormat='iso'):string {
  const pane=target.paneGeometry().find(item=>item.id==='main'),cols=target.data,v=target.viewport,width=target.chartSize.plotWidth;
  if(!pane||!cols.length)return '';
  const grid=Array.from({length:rows},()=>Array<string>(columns).fill(' '));
  const rowOf=(price:number)=>Math.max(0,Math.min(rows-1,Math.floor((pane.max-price)/(pane.max-pane.min||1)*rows)));
  const rowOfY=(y:number)=>Math.floor((y-pane.top)/pane.height*rows),colOfX=(x:number)=>Math.floor(x/width*columns);
  const put=(row:number,col:number,char:string)=>{if(row>=0&&row<rows&&col>=0&&col<columns)grid[row][col]=char;};
  const open=cols.col('open'),high=cols.col('high'),low=cols.col('low'),close=cols.col('close');
  for(let col=0;col<columns;col++){
    const from=Math.max(0,Math.ceil(v.indexAt(col*width/columns))),to=Math.min(cols.length-1,Math.floor(v.indexAt((col+1)*width/columns)-1e-9));
    if(to<from)continue;
    let hi=-Infinity,lo=Infinity;for(let i=from;i<=to;i++){hi=Math.max(hi,high[i]);lo=Math.min(lo,low[i]);}
    const up=close[to]>=open[from],bodyTop=rowOf(Math.max(open[from],close[to])),bodyBottom=rowOf(Math.min(open[from],close[to]));
    for(let row=rowOf(hi);row<=rowOf(lo);row++)put(row,col,row>=bodyTop&&row<=bodyBottom?(up?'█':'░'):'│');
  }
  for(const object of objects){
    if(object.paneId!=='main')continue;
    for(const primitive of object.primitives){
      const segments:[number,number,number,number][]=primitive.kind==='path'?primitive.points.slice(1).map((point,i)=>[primitive.points[i].x,primitive.points[i].y,point.x,point.y])
        :primitive.kind==='text'?[]:[[primitive.a.x,primitive.a.y,primitive.b.x,primitive.a.y],[primitive.b.x,primitive.a.y,primitive.b.x,primitive.b.y],[primitive.b.x,primitive.b.y,primitive.a.x,primitive.b.y],[primitive.a.x,primitive.b.y,primitive.a.x,primitive.a.y]];
      for(let [x0,y0,x1,y1] of segments){
        if(![x0,y0,x1,y1].every(Number.isFinite))continue;
        x0=Math.max(-width,Math.min(2*width,x0));x1=Math.max(-width,Math.min(2*width,x1));
        const dx=(x1-x0)/width*columns,dy=(y1-y0)/pane.height*rows,steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))*2));
        const char=Math.abs(dy)<Math.abs(dx)*.4?'─':Math.abs(dx)<Math.abs(dy)*.4?'┆':dx*dy<0?'/':'\\';
        for(let k=0;k<=steps;k++)put(rowOfY(y0+(y1-y0)*k/steps),colOfX(x0+(x1-x0)*k/steps),char);
      }
    }
    for(const label of object.labels){const row=rowOfY((label.y0+label.y1)/2),col=colOfX(label.x0);[...label.text.replace(/\s+/g,' ').slice(0,28)].forEach((char,k)=>put(row,col+k,char));}
  }
  const lastRow=rowOf(close[cols.length-1]),axis=(row:number)=>row===0?pane.max:row===rows-1?pane.min:row===lastRow?close[cols.length-1]:NaN;
  const lines=grid.map((row,index)=>{const price=axis(index);return row.join('')+'┤'+(Number.isFinite(price)?` ${num(price)}${index===lastRow?' ◀ last':''}`:'');});
  const first=Math.max(0,Math.ceil(v.from)),last=Math.min(cols.length-1,Math.floor(v.to));
  lines.push(`${formatTime(cols.col('time')[first],format)} … ${formatTime(cols.col('time')[last],format)}  (${columns} cols ≈ ${num((last-first+1)/columns)} bars/col; █ up ░ down │ wick; ─ / \\ ┆ drawings)`);
  return lines.join('\n');
}
