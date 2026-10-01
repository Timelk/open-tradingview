import {SANS_STACK} from './fonts';
import type {OverlayDrawingSpec} from '../core/types';
export interface DrawingBounds {left:number;top:number;right:number;bottom:number}
export interface ProjectedOverlayDrawing {drawing:OverlayDrawingSpec;opacity?:number;x1:number;y1:number;x2:number;y2:number}
export interface OverlayDrawingHit extends ProjectedOverlayDrawing {bounds:DrawingBounds}
const intersects=(a:DrawingBounds,b:DrawingBounds)=>a.right>=b.left&&a.left<=b.right&&a.bottom>=b.top&&a.top<=b.bottom;
/** Render native object fields verbatim; never infer a trade side or choose a trading palette. */
export function drawOverlayDrawings(ctx:CanvasRenderingContext2D,objects:readonly ProjectedOverlayDrawing[],clip:DrawingBounds):OverlayDrawingHit[]{
 const hits:OverlayDrawingHit[]=[];const alpha=ctx.globalAlpha;ctx.save();ctx.beginPath();ctx.rect(clip.left,clip.top,clip.right-clip.left,clip.bottom-clip.top);ctx.clip();ctx.shadowBlur=0;ctx.textBaseline='middle';
 for(const item of objects){
  ctx.globalAlpha=alpha*Math.max(0,Math.min(1,item.opacity??1));
  const {drawing:d,x1,y1,x2,y2}=item;if(![x1,y1,x2,y2].every(Number.isFinite))continue;
  ctx.font=`${d.fontWeight==='bold'?600:400} ${d.fontSize}px ${SANS_STACK}`;ctx.setLineDash(d.lineStyle==='dashed'?[6,4]:d.lineStyle==='dotted'?[2,3]:[]);ctx.lineWidth=d.width;ctx.strokeStyle=d.stroke;ctx.fillStyle=d.fill;
  let bounds:DrawingBounds;
  if(d.kind==='line'){
   bounds={left:Math.min(x1,x2)-3,right:Math.max(x1,x2)+3,top:Math.min(y1,y2)-3,bottom:Math.max(y1,y2)+3};if(!intersects(bounds,clip))continue;
   if(d.width>0){ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();}
  }else if(d.kind==='box'){
   bounds={left:Math.min(x1,x2),right:Math.max(x1,x2),top:Math.min(y1,y2),bottom:Math.max(y1,y2)};if(!intersects(bounds,clip))continue;
   const width=bounds.right-bounds.left,height=bounds.bottom-bounds.top;ctx.fillRect(bounds.left,bounds.top,width,height);if(d.width>0)ctx.strokeRect(bounds.left,bounds.top,width,height);
   if(d.text){ctx.save();ctx.beginPath();ctx.rect(bounds.left,bounds.top,width,height);ctx.clip();ctx.fillStyle=d.textColor;ctx.textAlign=d.textAlign;
    const lines=d.text.split('\n'),lineHeight=d.fontSize*1.25,total=lines.length*lineHeight;
    const x=d.textAlign==='left'?bounds.left+4:d.textAlign==='right'?bounds.right-4:(bounds.left+bounds.right)/2;
    const top=d.textValign==='top'?bounds.top+2:d.textValign==='bottom'?bounds.bottom-total-2:(bounds.top+bounds.bottom-total)/2;
    lines.forEach((line,i)=>ctx.fillText(line,x,top+(i+.5)*lineHeight));ctx.restore();}
  }else{
   const lines=d.text.split('\n'),textWidth=Math.max(0,...lines.map(line=>ctx.measureText(line).width)),empty=!d.text;
   let width=d.style==='circle'&&empty?d.fontSize:Math.max(d.fontSize,textWidth+(d.style==='none'?0:8));
   let height=empty?d.fontSize:lines.length*d.fontSize*1.25+(d.style==='none'?0:6);
   if(d.style==='circle'||d.style==='square'){width=Math.max(width,height);height=width;}
   const direction=d.yloc==='abovebar'?-1:d.yloc==='belowbar'?1:d.style==='label_down'?-1:d.style==='label_up'?1:0;
   const top=direction<0?y1-6-height:direction>0?y1+6:y1-height/2;
   const left=d.style==='label_left'?x1+5:d.style==='label_right'?x1-5-width:x1-width/2;
   bounds={left,right:left+width,top,bottom:top+height};if(!intersects(bounds,clip))continue;
   const cx=(bounds.left+bounds.right)/2,cy=(bounds.top+bounds.bottom)/2;
   ctx.beginPath();
   if(d.style==='circle')ctx.arc(cx,cy,Math.max(width,height)/2,0,Math.PI*2);
   else if(d.style==='diamond'){ctx.moveTo(cx,top);ctx.lineTo(bounds.right,cy);ctx.lineTo(cx,bounds.bottom);ctx.lineTo(left,cy);ctx.closePath();}
   else if(d.style==='triangleup'||d.style==='triangledown'||d.style==='arrowup'||d.style==='arrowdown'){const up=d.style.endsWith('up');ctx.moveTo(cx,up?top:bounds.bottom);ctx.lineTo(bounds.right,up?bounds.bottom:top);ctx.lineTo(left,up?bounds.bottom:top);ctx.closePath();}
   else if(d.style!=='none')ctx.rect(left,top,width,height);
   if(d.style!=='none')ctx.fill();
   if(d.text){ctx.fillStyle=d.textColor;ctx.textAlign=d.textAlign;const tx=d.textAlign==='left'?left+4:d.textAlign==='right'?bounds.right-4:cx;lines.forEach((line,i)=>ctx.fillText(line,tx,cy+(i-(lines.length-1)/2)*d.fontSize*1.25));}
  }
  hits.push({...item,bounds:{left:Math.max(clip.left,bounds.left),right:Math.min(clip.right,bounds.right),top:Math.max(clip.top,bounds.top),bottom:Math.min(clip.bottom,bounds.bottom)}});
 }
 ctx.restore();return hits;
}
