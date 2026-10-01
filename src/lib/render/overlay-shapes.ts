import {SANS_STACK} from './fonts';
/** Overlay graphics use CSS pixels. The canvas owner applies devicePixelRatio. */
export type OverlayShapeStyle='circle'|'square'|'diamond'|'triangleup'|'triangledown'|'arrowup'|'arrowdown'|'cross'|'xcross'|'labelup'|'labeldown'|'flag';
export type OverlayShapeLocation='abovebar'|'belowbar'|'top'|'bottom'|'absolute';
export type OverlayShapeSize='auto'|'tiny'|'small'|'normal'|'large'|'huge';
export interface OverlayShapeCandidate {
  x:number;y:number;shape:OverlayShapeStyle;location:OverlayShapeLocation;
  color:string;textColor?:string;text?:string;size?:OverlayShapeSize;opacity?:number;
}
export interface OverlayShapeBounds {left:number;top:number;right:number;bottom:number}
export interface OverlayShapeLayout<T extends OverlayShapeCandidate=OverlayShapeCandidate> {
  candidate:T;index:number;shapeBounds:OverlayShapeBounds;textBounds:OverlayShapeBounds|null;
  /** Intersection with the pane, so clipped graphics cannot capture unrelated panes. */
  hitBounds:OverlayShapeBounds;lines:string[];fontSize:number;lineHeight:number;pointerSize:number;
}
export interface OverlayShapeLayoutOptions {
  /** Optional Canvas measureText width, with OVERLAY_SHAPE_FONT set before measuring. */
  measureText?:(text:string)=>number;
}
export interface OverlayShapePaintOptions {clipBounds?:OverlayShapeBounds;fontFamily?:string}
export const OVERLAY_SHAPE_METRICS=Object.freeze({fontSize:11,lineHeight:14,barGap:6,textGap:3,paddingX:5,paddingY:3,pointerSize:4});
export const OVERLAY_SHAPE_FONT_FAMILY=SANS_STACK;
export const OVERLAY_SHAPE_FONT=`500 ${OVERLAY_SHAPE_METRICS.fontSize}px ${OVERLAY_SHAPE_FONT_FAMILY}`;
const sizes:Readonly<Record<OverlayShapeSize,number>>=Object.freeze({auto:12,tiny:6,small:9,normal:12,large:18,huge:24});
const styles=new Set<string>(['circle','square','diamond','triangleup','triangledown','arrowup','arrowdown','cross','xcross','labelup','labeldown','flag']);
const locations=new Set<string>(['abovebar','belowbar','top','bottom','absolute']);
const rect=(left:number,top:number,width:number,height:number):OverlayShapeBounds=>({left,top,right:left+width,bottom:top+height});
const validBounds=(b:OverlayShapeBounds)=>[b.left,b.top,b.right,b.bottom].every(Number.isFinite)&&b.right>b.left&&b.bottom>b.top;
const union=(a:OverlayShapeBounds,b:OverlayShapeBounds):OverlayShapeBounds=>({left:Math.min(a.left,b.left),top:Math.min(a.top,b.top),right:Math.max(a.right,b.right),bottom:Math.max(a.bottom,b.bottom)});
const intersect=(a:OverlayShapeBounds,b:OverlayShapeBounds):OverlayShapeBounds=>({left:Math.max(a.left,b.left),top:Math.max(a.top,b.top),right:Math.min(a.right,b.right),bottom:Math.min(a.bottom,b.bottom)});
// Used only when no canvas is supplied, e.g. geometry tests. CJK is approximately
// an em, Latin half an em. Actual painting callers can supply canvas measurements.
const approximateWidth=(line:string)=>Array.from(line).reduce((width,char)=>width+OVERLAY_SHAPE_METRICS.fontSize*(char.codePointAt(0)!>255?1:.6),0);

/**
 * Position every overlay graphic faithfully: no buy/sell inference, collision
 * suppression, cross-point relocation or trading-label substitution. Above/below
 * uses the caller's projected high/low; top/bottom uses the caller's pane edge.
 * Absolute keeps the graphic centered on its supplied price coordinate.
 */
export function layoutOverlayShapes<T extends OverlayShapeCandidate>(candidates:readonly T[],clipBounds:OverlayShapeBounds,options:OverlayShapeLayoutOptions={}):OverlayShapeLayout<T>[] {
  if(!validBounds(clipBounds))return [];
  const metrics=OVERLAY_SHAPE_METRICS,layouts:OverlayShapeLayout<T>[]=[];
  candidates.forEach((candidate,index)=>{
    if(!Number.isFinite(candidate.x)||!Number.isFinite(candidate.y)||!styles.has(candidate.shape)||!locations.has(candidate.location)||candidate.opacity!==undefined&&(!Number.isFinite(candidate.opacity)||candidate.opacity<=0))return;
    const diameter=sizes[candidate.size??'auto']??sizes.auto;
    const lines=candidate.text?candidate.text.replace(/\r\n?/g,'\n').split('\n'):[];
    const textHeight=lines.length*metrics.lineHeight;
    const textWidth=lines.reduce((max,line)=>{const measured=options.measureText?.(line);return Math.max(max,Number.isFinite(measured)&&measured!>=0?measured!:approximateWidth(line));},0);
    const label=candidate.shape==='labelup'||candidate.shape==='labeldown';
    const pointerSize=label?Math.max(metrics.pointerSize,diameter*.25):0;
    const width=label?Math.max(diameter,textWidth+metrics.paddingX*2):candidate.shape==='flag'?diameter*1.4:diameter;
    const bodyHeight=label?Math.max(diameter,textHeight+metrics.paddingY*2):diameter;
    const height=bodyHeight+pointerSize;
    // Top/bottom point into the pane; above/below point away from the candle.
    const sign=candidate.location==='abovebar'||candidate.location==='bottom'?-1:candidate.location==='belowbar'||candidate.location==='top'?1:0;
    const top=sign<0?candidate.y-metrics.barGap-height:sign>0?candidate.y+metrics.barGap:candidate.y-height/2;
    const shapeBounds=rect(candidate.x-width/2,top,width,height);
    let textBounds:OverlayShapeBounds|null=null;
    if(lines.length){
      const textTop=label?top+(candidate.shape==='labelup'?pointerSize:0)+(bodyHeight-textHeight)/2:sign>0?shapeBounds.bottom+metrics.textGap:shapeBounds.top-metrics.textGap-textHeight;
      // Empty lines intentionally retain their vertical space.
      textBounds=rect(candidate.x-textWidth/2,textTop,textWidth,textHeight);
    }
    const hitBounds=intersect(textBounds?union(shapeBounds,textBounds):shapeBounds,clipBounds);
    if(!validBounds(hitBounds))return;
    layouts.push({candidate,index,shapeBounds,textBounds,hitBounds,lines,fontSize:metrics.fontSize,lineHeight:metrics.lineHeight,pointerSize});
  });
  return layouts;
}

function polygon(ctx:CanvasRenderingContext2D,points:readonly (readonly [number,number])[]){
  ctx.moveTo(points[0][0],points[0][1]);for(let i=1;i<points.length;i++)ctx.lineTo(points[i][0],points[i][1]);ctx.closePath();
}
function shapePath(ctx:CanvasRenderingContext2D,item:OverlayShapeLayout){
  const b=item.shapeBounds,x=(b.left+b.right)/2,y=(b.top+b.bottom)/2,w=b.right-b.left,h=b.bottom-b.top;
  ctx.beginPath();
  switch(item.candidate.shape){
    case 'circle':ctx.arc(x,y,w/2,0,Math.PI*2);break;
    case 'square':ctx.rect(b.left,b.top,w,h);break;
    case 'diamond':polygon(ctx,[[x,b.top],[b.right,y],[x,b.bottom],[b.left,y]]);break;
    case 'triangleup':polygon(ctx,[[x,b.top],[b.right,b.bottom],[b.left,b.bottom]]);break;
    case 'triangledown':polygon(ctx,[[b.left,b.top],[b.right,b.top],[x,b.bottom]]);break;
    case 'arrowup':polygon(ctx,[[x,b.top],[b.right,b.top+h*.5],[x+w*.16,b.top+h*.5],[x+w*.16,b.bottom],[x-w*.16,b.bottom],[x-w*.16,b.top+h*.5],[b.left,b.top+h*.5]]);break;
    case 'arrowdown':polygon(ctx,[[x,b.bottom],[b.left,b.top+h*.5],[x-w*.16,b.top+h*.5],[x-w*.16,b.top],[x+w*.16,b.top],[x+w*.16,b.top+h*.5],[b.right,b.top+h*.5]]);break;
    case 'cross':{
      const d=w*.16;
      polygon(ctx,[[x-d,b.top],[x+d,b.top],[x+d,y-d],[b.right,y-d],[b.right,y+d],[x+d,y+d],[x+d,b.bottom],[x-d,b.bottom],[x-d,y+d],[b.left,y+d],[b.left,y-d],[x-d,y-d]]);break;
    }
    case 'xcross':{
      const d=w*.2;
      polygon(ctx,[[b.left,b.top+d],[b.left+d,b.top],[x,y-d],[b.right-d,b.top],[b.right,b.top+d],[x+d,y],[b.right,b.bottom-d],[b.right-d,b.bottom],[x,y+d],[b.left+d,b.bottom],[b.left,b.bottom-d],[x-d,y]]);break;
    }
    case 'labelup':{
      const p=item.pointerSize,edge=b.top+p;
      polygon(ctx,[[x,b.top],[x+p,edge],[b.right,edge],[b.right,b.bottom],[b.left,b.bottom],[b.left,edge],[x-p,edge]]);break;
    }
    case 'labeldown':{
      const p=item.pointerSize,edge=b.bottom-p;
      polygon(ctx,[[b.left,b.top],[b.right,b.top],[b.right,edge],[x+p,edge],[x,b.bottom],[x-p,edge],[b.left,edge]]);break;
    }
    case 'flag':{
      const pole=Math.max(1.5,w*.12);
      polygon(ctx,[[b.left,b.top],[b.right,b.top],[b.right-w*.2,b.top+h*.3],[b.right,b.top+h*.6],[b.left+pole,b.top+h*.6],[b.left+pole,b.bottom],[b.left,b.bottom]]);break;
    }
  }
}

/** Does not change canvas size, DPR transform or inherited drawing state. */
export function drawOverlayShapes(ctx:CanvasRenderingContext2D,layouts:readonly OverlayShapeLayout[],options:OverlayShapePaintOptions={}):void {
  const inheritedAlpha=ctx.globalAlpha;
  ctx.save();
  if(options.clipBounds&&validBounds(options.clipBounds)){
    const b=options.clipBounds;ctx.beginPath();ctx.rect(b.left,b.top,b.right-b.left,b.bottom-b.top);ctx.clip();
  }
  ctx.setLineDash([]);ctx.shadowBlur=0;ctx.shadowOffsetX=0;ctx.shadowOffsetY=0;ctx.shadowColor='transparent';
  ctx.font=`500 ${OVERLAY_SHAPE_METRICS.fontSize}px ${options.fontFamily??OVERLAY_SHAPE_FONT_FAMILY}`;
  ctx.textAlign='center';ctx.textBaseline='middle';
  for(const item of layouts){
    ctx.globalAlpha=inheritedAlpha*Math.min(1,Math.max(0,item.candidate.opacity??1));
    // Reset first: Canvas ignores invalid CSS colors, which must not cause a
    // previous graphic's color to bleed into this one. Transparency is supported.
    ctx.fillStyle='transparent';ctx.fillStyle=item.candidate.color;
    shapePath(ctx,item);ctx.fill();
    if(item.textBounds){
      ctx.fillStyle='#ffffff';ctx.fillStyle=item.candidate.textColor??'#ffffff';
      item.lines.forEach((line,index)=>ctx.fillText(line,item.candidate.x,item.textBounds!.top+(index+.5)*item.lineHeight));
    }
  }
  ctx.restore();
}
