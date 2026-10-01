import {OverlayLabelOccupancy,placeOverlayLabel} from './overlay-label';
import {readableSurfaceColor,type ChartOverlaySurface} from '../chart/appearance';
import {translate} from '../i18n';
import type {OscillatorDivergence} from '../indicators/divergence';
import type {IndicatorDivergenceMark} from '../indicators/divergence-projection';

type Pixel={x:number;y:number};
type Bounds={left:number;right:number;top:number;bottom:number};
export interface IndicatorDivergenceHit {
  instanceId:string;divergence:OscillatorDivergence;bounds:Bounds;clipBounds:Bounds;segments:[Pixel,Pixel][];
}
export interface IndicatorDivergencePaintOptions {
  instanceId:string;bullishColor:string;bearishColor:string;width:number;opacity?:number;selectedId?:string;
  labels:boolean;project:(time:number,value:number)=>Pixel;bounds:Bounds;occupied:Bounds[];surface?:ChartOverlaySurface;
}
export const divergenceLabel=(d:OscillatorDivergence)=>`${d.seriesName} ${translate(d.direction==='bullish'?'底背离':'顶背离')}`;

/** Independent oscillator evidence. No PatternMatch or pattern-selection state. */
export function drawIndicatorDivergences(ctx:CanvasRenderingContext2D,marks:readonly IndicatorDivergenceMark[],o:IndicatorDivergencePaintOptions):IndicatorDivergenceHit[]{
  const hits:IndicatorDivergenceHit[]=[],box=o.bounds;
  if(!marks.length||!Object.values(box).every(Number.isFinite)||box.right<=box.left||box.bottom<=box.top)return hits;
  const alpha=ctx.globalAlpha*Math.max(0,Math.min(1,o.opacity??1));if(!(alpha>0))return hits;
  const surface=o.surface,inside=(p:Pixel)=>p.x>=box.left&&p.x<=box.right&&p.y>=box.top&&p.y<=box.bottom;
  const colors={bullish:surface?readableSurfaceColor(o.bullishColor,surface.surfaceSolid,4.5):o.bullishColor,
    bearish:surface?readableSurfaceColor(o.bearishColor,surface.surfaceSolid,4.5):o.bearishColor};
  const captions=new Map<string,string>(),widths=new Map<string,number>();
  const labels:Array<{hit:IndicatorDivergenceHit;anchor:Pixel;text:string;color:string;selected:boolean}>=[],unique=new Map<string,IndicatorDivergenceMark>();
  for(const mark of marks){
    const d=mark.divergence,key=`${d.plotIndex}:${d.direction}:${mark.points.map(p=>p.time).join(':')}`;
    const existing=unique.get(key);
    if(!existing||d.id===o.selectedId&&existing.divergence.id!==o.selectedId)unique.set(key,mark);
  }
  ctx.save();ctx.beginPath();ctx.rect(box.left,box.top,box.right-box.left,box.bottom-box.top);ctx.clip();
  ctx.font='500 11px ui-monospace,"PingFang SC",sans-serif';ctx.textBaseline='middle';ctx.globalAlpha=alpha;
  for(const selectedPass of [false,true])for(const mark of unique.values()){
    const d=mark.divergence,selected=d.id===o.selectedId;if(selected!==selectedPass)continue;
    const points=mark.points.map(p=>o.project(p.time,p.value)) as [Pixel,Pixel], [a,b]=points;
    if(points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y))||Math.max(a.x,b.x)<box.left||Math.min(a.x,b.x)>box.right||Math.max(a.y,b.y)<box.top||Math.min(a.y,b.y)>box.bottom)continue;
    const color=colors[d.direction];
    ctx.strokeStyle=color;ctx.lineWidth=selected?Math.max(2,o.width):o.width;ctx.setLineDash([]);
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    for(const point of points)if(inside(point)){ctx.beginPath();ctx.arc(point.x,point.y,selected?3.5:2.5,0,Math.PI*2);ctx.fillStyle=surface?.surfaceSolid??'#151718';ctx.fill();ctx.stroke();}
    const anchor=inside(b)?b:inside(a)?a:undefined;
    const hit:IndicatorDivergenceHit={instanceId:o.instanceId,divergence:d,clipBounds:box,segments:[[a,b]],bounds:anchor?{left:anchor.x-5,right:anchor.x+5,top:anchor.y-5,bottom:anchor.y+5}:{left:box.right+1,right:box.right+1,top:box.bottom+1,bottom:box.bottom+1}};
    hits.push(hit);if(o.labels&&anchor){const key=`${d.seriesName}:${d.direction}`;let text=captions.get(key);if(text===undefined){text=divergenceLabel(d);captions.set(key,text);}labels.push({hit,anchor,color,selected,text});}
  }
  labels.sort((a,b)=>Number(b.selected)-Number(a.selected)||b.hit.divergence.confirmedAt-a.hit.divergence.confirmedAt);
  const occupancy=new OverlayLabelOccupancy(o.occupied),collides=(rect:Bounds)=>occupancy.collides(rect);
  for(const label of labels){
    let width=widths.get(label.text);if(width===undefined){width=ctx.measureText(label.text).width+10;widths.set(label.text,width);}
    const height=18,rect=placeOverlayLabel(label.anchor,width,height,box,o.occupied,label.hit.divergence.direction==='bullish'?1:-1,collides);
    if(!rect)continue;
    ctx.fillStyle=surface?.canvasLabelBg??'#172027';ctx.fillRect(rect.left,rect.top,width,height);ctx.strokeStyle=label.color;ctx.lineWidth=label.selected?1.5:1;ctx.strokeRect(rect.left+.5,rect.top+.5,width-1,height-1);
    ctx.fillStyle=label.color;ctx.textAlign='left';ctx.fillText(label.text,rect.left+5,rect.top+height/2);o.occupied.push(rect);occupancy.add(rect);label.hit.bounds=rect;
  }
  ctx.restore();return hits;
}
