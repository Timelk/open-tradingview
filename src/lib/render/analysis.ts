import {placeOverlayLabel} from './overlay-label';
import type {AnalysisObservation} from '../analysis/types';
import {analysisChartName,analysisEventMarker,analysisKind,analysisStatus,ANALYSIS_PALETTE as palette} from '../analysis/presentation';
import {readableSurfaceColor} from '../chart/appearance';
import {hitPattern,type PatternPaintOptions} from './patterns';
import {translateCanonical as text} from '../i18n';

type Pixel={x:number;y:number};
type Bounds={left:number;right:number;top:number;bottom:number};
export interface AnalysisPaintOptions extends PatternPaintOptions {
  /** An explicit saved override, distinct from the default output swatch. */
  colorOverride?:string;
  labelMode?:string;
}
export interface AnalysisHit {instanceId:string;observation:AnalysisObservation;bounds:Bounds;clipBounds:Bounds;segments:[Pixel,Pixel][];labelBounds:Bounds[]}
const finite=(point:Pixel)=>Number.isFinite(point.x)&&Number.isFinite(point.y);
const font='500 11px ui-monospace,"PingFang SC",sans-serif';
function insetText(ctx:CanvasRenderingContext2D,value:string,width:number):string {
  if(ctx.measureText(value).width<=width)return value;
  const chars=Array.from(value);while(chars.length&&ctx.measureText(chars.join('')+'…').width>width)chars.pop();
  return chars.length?chars.join('')+'…':'';
}
function colorFor(item:AnalysisObservation,options:AnalysisPaintOptions):string {
  let raw:string;
  if(options.colorOverride)raw=options.colorOverride;
  else if(item.state==='invalidated')raw=palette.invalid;
  else {
    const kind=analysisKind(item);
    if(kind==='fvg')raw=item.direction==='bullish'?palette.fvgBull:palette.fvgBear;
    else if(kind==='vsa')raw=palette.volume;
    else if(kind==='wave')raw=palette.wave;
    else raw=item.direction==='bullish'?palette.bull:item.direction==='bearish'?palette.bear:options.color||palette.neutral;
  }
  return options.surface?readableSurfaceColor(raw,options.surface.surfaceSolid,4.5):raw;
}

/** Sparse geometry stays anchored to source candles. Labels carry state in
 * words; shape/texture carry event type independently of direction and color. */
export function drawAnalysis(ctx:CanvasRenderingContext2D,observations:readonly AnalysisObservation[],o:AnalysisPaintOptions):AnalysisHit[]{
  const hits:AnalysisHit[]=[],box=o.bounds,s=o.surface,labelBg=s?.canvasLabelBg??palette.background,markerBg=s?.surfaceSolid??palette.markerBackground;
  if(!Object.values(box).every(Number.isFinite)||box.right<=box.left||box.bottom<=box.top)return hits;
  ctx.save();ctx.beginPath();ctx.rect(box.left,box.top,box.right-box.left,box.bottom-box.top);ctx.clip();
  const alpha=ctx.globalAlpha*(o.opacity??1),width=Number.isFinite(o.width)?Math.max(.5,Math.min(8,o.width)):1;
  const labels:Array<{hit:AnalysisHit;anchor:Pixel;color:string;selected:boolean;eventLabels:Array<{point:Pixel;label:string}>}>=[];
  ctx.font=font;ctx.textBaseline='middle';
  for(const item of observations){
    const selected=item.id===o.selectedId,color=colorFor(item,o),kind=analysisKind(item),status=analysisStatus(item);
    const points=item.points.map(p=>o.project(p.time,p.value));if(points.some(p=>!finite(p)))continue;
    const lines=(item.lines??[]).map(line=>({...line,points:line.points.map(p=>o.project(p.time,p.value))})).filter(line=>line.points.length>=2&&line.points.every(finite));
    const events=item.events.length?item.events.map(event=>({point:o.project(event.time,event.price),label:event.label,kind:event.kind})).filter(event=>finite(event.point)):
      points.map((point,i)=>({point,label:item.points[i].label,kind:'anchor'}));
    const zone=item.zone&&(o.zones||selected)&&item.zone.high>=item.zone.low?{a:o.project(item.zone.fromTime,item.zone.high),b:o.project(item.zone.toTime,item.zone.low)}:undefined;
    const validZone=zone&&finite(zone.a)&&finite(zone.b)?zone:undefined;
    const extent=[...points,...lines.flatMap(line=>line.points),...events.map(event=>event.point),...(validZone?[validZone.a,validZone.b]:[])];
    if(!extent.length||Math.max(...extent.map(p=>p.x))<box.left||Math.min(...extent.map(p=>p.x))>box.right)continue;
    const segments:[Pixel,Pixel][]=[],inside=(p:Pixel)=>p.x>=box.left&&p.x<=box.right&&p.y>=box.top&&p.y<=box.bottom;
    const historical=['invalidated','limited','ended'].includes(status.key);
    const lineAlpha=alpha*(selected?1:historical?.48:.8),lineWidth=selected?Math.max(1.8,width):width;
    const stateDash=item.state==='invalidated'?[2,4]:item.state==='observing'?[5,4]:historical?[7,3]:[];
    ctx.strokeStyle=color;ctx.lineWidth=lineWidth;ctx.globalAlpha=lineAlpha;ctx.setLineDash(stateDash);
    let anchor=[...events.map(event=>event.point),...points].filter(inside).sort((a,b)=>a.x-b.x).at(-1);
    if(validZone){
      const {a,b}=validZone,left=Math.max(box.left,Math.min(a.x,b.x)),right=Math.min(box.right,Math.max(a.x,b.x));
      const top=Math.min(a.y,b.y),bottom=Math.max(a.y,b.y);
      if(right>left&&bottom>=box.top&&top<=box.bottom){
        const fillAlpha=kind==='order-block'?.105:kind==='fvg'?.035:.055;
        const activation=kind==='order-block'?item.events.find(event=>event.kind==='activation'):undefined;
        const at=activation?o.project(activation.time,activation.price).x:NaN;
        const baseEnd=Number.isFinite(at)?Math.max(left,Math.min(right,at)):left;
        const fill=(from:number,to:number,opacity:number,dash:number[])=>{
          if(to<=from)return;
          ctx.fillStyle=color;ctx.globalAlpha=alpha*opacity*(selected?1.7:1)*(historical?.45:1);ctx.fillRect(from,top,to-from,bottom-top);
          ctx.globalAlpha=lineAlpha;ctx.strokeStyle=color;ctx.lineWidth=lineWidth;ctx.setLineDash(dash);ctx.strokeRect(from,top,to-from,bottom-top);
        };
        fill(left,baseEnd,.025,[3,3]);
        fill(baseEnd,right,fillAlpha,kind==='fvg'?[2,3]:stateDash);
        segments.push([{x:left,y:top},{x:right,y:top}],[{x:left,y:bottom},{x:right,y:bottom}],
          [{x:left,y:top},{x:left,y:bottom}],[{x:right,y:top},{x:right,y:bottom}]);
        if(kind==='fvg'){
          // Texture work is bounded by the visible area, not historical span.
          const yt=Math.max(box.top,top),yb=Math.min(box.bottom,bottom);
          ctx.save();ctx.beginPath();ctx.rect(left,yt,right-left,yb-yt);ctx.clip();ctx.globalAlpha=alpha*.15;ctx.lineWidth=.7;ctx.setLineDash([]);
          for(let x=left-(yb-yt);x<right;x+=12){ctx.beginPath();ctx.moveTo(x,yb);ctx.lineTo(x+yb-yt,yt);ctx.stroke();}
          ctx.restore();
        }
        if(kind==='order-block'){
          if(Number.isFinite(at)&&at>left&&at<right){
            // The historical base precedes knowledge of the OB. The divider
            // uses the actual activation candle, never an invented date.
            ctx.globalAlpha=lineAlpha;ctx.strokeStyle=color;ctx.lineWidth=lineWidth;
            ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(at,top);ctx.lineTo(at,bottom);ctx.stroke();segments.push([{x:at,y:top},{x:at,y:bottom}]);
          }
          const near=item.direction==='bullish'?top:bottom;
          if(right>baseEnd){ctx.globalAlpha=lineAlpha;ctx.lineWidth=lineWidth+1;ctx.setLineDash(stateDash);ctx.beginPath();ctx.moveTo(baseEnd,near);ctx.lineTo(right,near);ctx.stroke();}
        }
        const y=item.direction==='bullish'?bottom:item.direction==='bearish'?top:(top+bottom)/2;
        anchor={x:right,y:Math.max(box.top,Math.min(box.bottom,y))};
      }
    }
    ctx.strokeStyle=color;ctx.lineWidth=lineWidth;ctx.globalAlpha=lineAlpha;
    for(const line of lines){
      ctx.setLineDash(line.role==='projection'?[5,4]:stateDash);
      for(let i=1;i<line.points.length;i++){const a=line.points[i-1],b=line.points[i];ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();segments.push([a,b]);}
    }
    ctx.setLineDash([]);
    const eventLabels:Array<{point:Pixel;label:string}>=[];
    for(const event of events){
      const p=event.point;if(!inside(p))continue;
      ctx.globalAlpha=lineAlpha;ctx.lineWidth=lineWidth;ctx.fillStyle=markerBg;ctx.strokeStyle=color;
      const size=selected?4:3.25,shape=analysisEventMarker(event);ctx.beginPath();
      if(shape==='cross'){ctx.moveTo(p.x-size,p.y-size);ctx.lineTo(p.x+size,p.y+size);ctx.moveTo(p.x+size,p.y-size);ctx.lineTo(p.x-size,p.y+size);}
      else if(shape==='diamond'){ctx.moveTo(p.x,p.y-size-1);ctx.lineTo(p.x+size+1,p.y);ctx.lineTo(p.x,p.y+size+1);ctx.lineTo(p.x-size-1,p.y);ctx.closePath();}
      else if(shape==='square'){ctx.fillStyle=color;ctx.rect(p.x-size,p.y-size,size*2,size*2);}
      else if(kind==='vsa'){for(let i=0;i<3;i++)ctx.rect(p.x-5+i*4,p.y+4-(i+1)*3,2,(i+1)*3);}
      else ctx.arc(p.x,p.y,size,0,Math.PI*2);
      if(shape!=='cross')ctx.fill();ctx.stroke();segments.push([{x:p.x-5,y:p.y},{x:p.x+5,y:p.y}]);
      if(selected&&o.labels&&(events.length>1||item.events.length))eventLabels.push(event);
    }
    // A later lifecycle event must not remove the original wave numbering.
    if(selected&&kind==='wave'&&item.events.length)for(let i=0;i<points.length;i++)if(inside(points[i])){
      ctx.globalAlpha=lineAlpha;ctx.beginPath();ctx.arc(points[i].x,points[i].y,3,0,Math.PI*2);ctx.fill();ctx.stroke();
      segments.push([{x:points[i].x-4,y:points[i].y},{x:points[i].x+4,y:points[i].y}]);
      if(o.labels)eventLabels.push({point:points[i],label:item.points[i].label});
    }
    const bounds=anchor?{left:anchor.x-5,right:anchor.x+5,top:anchor.y-5,bottom:anchor.y+5}:{left:box.right+1,right:box.right+1,top:box.bottom+1,bottom:box.bottom+1};
    const hit:AnalysisHit={instanceId:o.instanceId,observation:item,bounds,clipBounds:box,segments,labelBounds:[]};hits.push(hit);
    if(anchor)labels.push({hit,anchor,color,selected,eventLabels});
  }
  // Selection gets first claim on label space, then the most recent records.
  // Geometry and picking survive when compact mode suppresses a title.
  labels.sort((a,b)=>Number(b.selected)-Number(a.selected)||b.hit.observation.availableAt-a.hit.observation.availableAt);
  const budget=o.labelMode==='all'?Infinity:Math.max(3,Math.min(12,Math.floor((box.right-box.left)/125)));let labelled=0;
  if(o.labels)for(const {hit,anchor,color,selected,eventLabels} of labels){
    if(!selected&&(o.labelMode==='selected'||labelled>=budget))continue;
    ctx.font=font;const item=hit.observation,status=analysisStatus(item),badge=status.key==='confirmed'?'':text(status.label),name=text(analysisChartName(item));
    const badgeWidth=badge?Math.min(ctx.measureText(badge).width+12,Math.max(0,(box.right-box.left-8)*.6)):0;
    const labelWidth=Math.min(box.right-box.left-8,ctx.measureText(name).width+badgeWidth+18),height=23;
    const rect=placeOverlayLabel(anchor,labelWidth,height,box,o.occupied,item.direction==='bullish'?1:-1);if(!rect)continue;
    ctx.globalAlpha=alpha;ctx.setLineDash([]);ctx.fillStyle=labelBg;ctx.fillRect(rect.left,rect.top,labelWidth,height);
    ctx.strokeStyle=color;ctx.lineWidth=selected?1.5:.65;ctx.strokeRect(rect.left+.5,rect.top+.5,labelWidth-1,height-1);
    ctx.fillStyle=color;ctx.fillRect(rect.left,rect.top,3,height);ctx.textAlign='left';
    ctx.fillText(insetText(ctx,name,Math.max(0,labelWidth-badgeWidth-18)),rect.left+8,rect.top+height/2);
    if(badge){
      const rawBadgeColor=['limited','observing'].includes(status.key)?palette.warning:['invalidated','ended'].includes(status.key)?palette.ended:palette.text;
      const x=rect.right-badgeWidth;ctx.fillStyle=s?readableSurfaceColor(rawBadgeColor,s.surfaceSolid,4.5):rawBadgeColor;
      ctx.fillText(insetText(ctx,badge,badgeWidth-10),x+4,rect.top+height/2);
      ctx.strokeStyle=color;ctx.globalAlpha=alpha*.35;ctx.beginPath();ctx.moveTo(x,rect.top+5);ctx.lineTo(x,rect.bottom-5);ctx.stroke();
    }
    ctx.globalAlpha=alpha*.5;ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(anchor.x,anchor.y);
    ctx.lineTo(Math.max(rect.left,Math.min(anchor.x,rect.right)),Math.max(rect.top,Math.min(anchor.y,rect.bottom)));ctx.stroke();
    o.occupied.push(rect);hit.bounds=rect;hit.labelBounds.push(rect);labelled++;
    if(selected)for(const event of eventLabels){
      const label=text(event.label),eventWidth=Math.min(box.right-box.left-8,ctx.measureText(label).width+10),eventRect=placeOverlayLabel(event.point,eventWidth,18,box,o.occupied,-1);
      if(!eventRect)continue;
      ctx.globalAlpha=alpha;ctx.fillStyle=labelBg;ctx.fillRect(eventRect.left,eventRect.top,eventWidth,18);
      ctx.fillStyle=color;ctx.fillText(insetText(ctx,label,eventWidth-8),eventRect.left+4,eventRect.top+9);o.occupied.push(eventRect);hit.labelBounds.push(eventRect);
    }
  }
  ctx.restore();return hits;
}

/** Labels are painted after all geometry, so even an older line beneath a
 * recent label must not steal that label's click. Event captions share ownership. */
export function hitAnalysis(hits:readonly AnalysisHit[],point:Pixel):AnalysisHit|undefined {
  const contains=(b:Bounds)=>point.x>=b.left&&point.x<=b.right&&point.y>=b.top&&point.y<=b.bottom;
  return [...hits].reverse().find(hit=>contains(hit.clipBounds)&&hit.labelBounds?.some(contains))??hitPattern(hits,point);
}
