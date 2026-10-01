import type { Drawing, Pixel, Primitive } from './types';
import { drawingFontSize, estimateLabelWidth, labelHeight, LABEL_BACKGROUND, readableLabelColor } from './labels';
import {MONO_STACK} from '../render/fonts';
type TextPrimitive=Extract<Primitive,{kind:'text'}>;
interface TextBounds { x:number;y:number;width:number;height:number }
// Rendered metrics belong to the projected primitive, not persisted drawing
// data. Weak keys naturally expire when geometry or its style is rebuilt.
const textBounds=new WeakMap<TextPrimitive,TextBounds>();
export function segmentDistance(p:Pixel,a:Pixel,b:Pixel):number {
  const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}
/** Match Canvas' default nonzero fill rule, including concave/self-crossing paths. */
function insidePath(pixel:Pixel,points:Pixel[]):boolean {
  let winding=0;
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length];
    const side=(b.x-a.x)*(pixel.y-a.y)-(pixel.x-a.x)*(b.y-a.y);
    if(a.y<=pixel.y&&b.y>pixel.y&&side>0)winding++;
    else if(a.y>pixel.y&&b.y<=pixel.y&&side<0)winding--;
  }
  return winding!==0;
}
export function primitiveHit(pixel:Pixel,primitive:Primitive,tolerance=7,fillOpacity=0):boolean {
  if(primitive.kind==='text'){
    const size=primitive.size??13,padding=primitive.background?Math.max(5,Math.ceil(size*.3)):0;
    const width=Math.min(estimateLabelWidth(primitive.text,size)+padding*2,primitive.maxWidth??Infinity),height=labelHeight(size);
    const bounds=textBounds.get(primitive)??{x:primitive.at.x-(primitive.align==='center'?width/2:primitive.align==='right'?width-padding:padding),y:primitive.at.y-height/2,width,height};
    return pixel.x>=bounds.x-tolerance&&pixel.x<=bounds.x+bounds.width+tolerance&&pixel.y>=bounds.y-tolerance&&pixel.y<=bounds.y+bounds.height+tolerance;
  }
  if(primitive.kind==='path'){
    for(let i=1;i<primitive.points.length;i++)if(segmentDistance(pixel,primitive.points[i-1],primitive.points[i])<=tolerance)return true;
    return !!primitive.closed&&primitive.points.length>2&&(segmentDistance(pixel,primitive.points.at(-1)!,primitive.points[0])<=tolerance||!!primitive.fill&&fillOpacity>0&&insidePath(pixel,primitive.points));
  }
  const {a,b}=primitive,left=Math.min(a.x,b.x),right=Math.max(a.x,b.x),top=Math.min(a.y,b.y),bottom=Math.max(a.y,b.y);
  const filled=!!primitive.fill&&fillOpacity>0;
  if(primitive.kind==='ellipse'){
    const rx=(right-left)/2||1,ry=(bottom-top)/2||1;
    const distance=Math.hypot((pixel.x-(left+right)/2)/rx,(pixel.y-(top+bottom)/2)/ry);
    return filled&&distance<=1||Math.abs(distance-1)*Math.min(rx,ry)<=tolerance;
  }
  if(filled&&pixel.x>=left&&pixel.x<=right&&pixel.y>=top&&pixel.y<=bottom)return true;
  return pixel.x>=left-tolerance&&pixel.x<=right+tolerance&&pixel.y>=top-tolerance&&pixel.y<=bottom+tolerance&&Math.min(Math.abs(pixel.x-left),Math.abs(pixel.x-right),Math.abs(pixel.y-top),Math.abs(pixel.y-bottom))<=tolerance;
}
export function renderPrimitives(ctx:CanvasRenderingContext2D,primitives:Primitive[],drawing:Drawing):void {
  const s=drawing.style;
  for(const p of primitives){
    if(p.kind==='text')continue;
    ctx.save();ctx.strokeStyle=p.color??s.color;ctx.lineWidth=s.width;ctx.lineJoin='round';ctx.lineCap='round';
    const dash=p.kind==='path'?(p.dash??s.dash):s.dash;ctx.setLineDash(dash==='dashed'?[7,5]:dash==='dotted'?[2,4]:[]);
    ctx.beginPath();
    if(p.kind==='path'){p.points.forEach((v,i)=>i?ctx.lineTo(v.x,v.y):ctx.moveTo(v.x,v.y));if(p.closed)ctx.closePath();}
    else if(p.kind==='rect')ctx.rect(p.a.x,p.a.y,p.b.x-p.a.x,p.b.y-p.a.y);
    else ctx.ellipse((p.a.x+p.b.x)/2,(p.a.y+p.b.y)/2,Math.abs(p.b.x-p.a.x)/2,Math.abs(p.b.y-p.a.y)/2,0,0,2*Math.PI);
    if(p.fill){ctx.save();ctx.globalAlpha*=s.fillOpacity;ctx.fillStyle=p.fill;ctx.fill();ctx.restore();}
    ctx.stroke();
    ctx.restore();
  }
  // Paint all labels last within this object. Later Fibonacci levels cannot
  // cut through earlier labels; scene ordering between objects is unchanged.
  for(const primitive of primitives)if(primitive.kind==='text')renderLabel(ctx,primitive,drawing);
}

function renderLabel(ctx:CanvasRenderingContext2D,p:TextPrimitive,drawing:Drawing):void {
  const size=drawingFontSize(drawing,p.size),padding=p.background?Math.max(5,Math.ceil(size*.3)):0;
  ctx.save();ctx.font=`${size}px ${MONO_STACK}`;ctx.textAlign='left';ctx.textBaseline='alphabetic';
  let text=p.text,metrics=ctx.measureText(text);
  if(p.maxWidth!==undefined&&Number.isFinite(p.maxWidth)&&metrics.width>Math.max(0,p.maxWidth-padding*2)){
    const available=Math.max(0,p.maxWidth-padding*2),characters=[...text];let lo=0,hi=characters.length;
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(ctx.measureText(characters.slice(0,mid).join('')+'…').width<=available)lo=mid;else hi=mid-1;}
    text=lo?characters.slice(0,lo).join('')+'…':ctx.measureText('…').width<=available?'…':'';metrics=ctx.measureText(text);
  }
  const ascent=Number.isFinite(metrics.actualBoundingBoxAscent)?metrics.actualBoundingBoxAscent:size*.8;
  const descent=Number.isFinite(metrics.actualBoundingBoxDescent)?metrics.actualBoundingBoxDescent:size*.2;
  const width=Math.ceil(metrics.width)+padding*2,height=Math.max(labelHeight(size),Math.ceil(ascent+descent)+8);
  const x=Math.round(p.at.x-(p.align==='center'?width/2:p.align==='right'?width-padding:padding)),y=Math.round(p.at.y-height/2);
  textBounds.set(p,{x,y,width,height});
  if(p.background){ctx.fillStyle=LABEL_BACKGROUND;ctx.fillRect(x,y,width,height);}
  ctx.fillStyle=p.background?readableLabelColor(p.color??drawing.style.color):p.color??drawing.style.color;
  // CSS-pixel text at native canvas resolution: the chart already applies DPR.
  // Never scale the font again or raster-scale a cached text image.
  ctx.fillText(text,x+padding,Math.round(y+height/2+(ascent-descent)/2));ctx.restore();
}
