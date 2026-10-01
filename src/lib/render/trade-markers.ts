import {getLocale,translate} from '../i18n';
import {SANS_STACK} from './fonts';
/** All geometry is in CSS pixels. The owning canvas applies devicePixelRatio once. */
export interface MarkerCandidate {
  id?:string;x:number;y:number;side:'buy'|'sell';kind?:'signal'|'fill';
  /** Descriptive text is retained for a tooltip; the compact tag always says 买入 / 卖出. */
  label?:string;opacity?:number;
  /** Visible provenance for system-generated signals; custom overlay labels have
   * their own renderer and retain the exact text supplied by their producer. */
  sourceTag?:string;
  /** Explicit user color override. Omit for the standard buy/sell palette. */
  color?:string;
}
export interface MarkerBounds {left:number;top:number;right:number;bottom:number}
export interface MarkerPoint {x:number;y:number}
export interface TradeMarkerLayout<T extends MarkerCandidate=MarkerCandidate> {
  candidate:T;index:number;mode:'label'|'compact'|'anchor';
  anchor:MarkerPoint;anchorBounds:MarkerBounds;
  labelBounds:MarkerBounds|null;
  leader:{from:MarkerPoint;to:MarkerPoint}|null;
  arrow:{x:number;y:number;direction:'up'|'down'}|null;
  hitBounds:MarkerBounds;
}
export interface TradeMarkerLayoutOptions {
  /** Input order is the stable label priority. Larger inputs are sampled evenly. */
  maxMarkers?:number;maxLabels?:number;collisionPadding?:number;
  /** Earlier canvas layers' CSS-pixel boxes; callers retain control of frame lifetime. */
  occupiedRects?:readonly MarkerBounds[];
}
export interface TradeMarkerPaintOptions {clipBounds?:MarkerBounds;fontFamily?:string;
  /** Chart tone: light charts get tinted-paper labels instead of dark chips. */
  tone?:'dark'|'light'}
export const TRADE_MARKER_METRICS=Object.freeze({labelWidth:50,labelHeight:23,fontSize:11.5,anchorRadius:3.25,leaderLength:8,anchorGap:1.5,compactWidth:12,compactHeight:12,compactLeaderLength:3});
export const TRADE_MARKER_COLORS=Object.freeze({
  buy:Object.freeze({accent:'#45D6B0',border:'#2DAA89',background:'#103F34',text:'#E0FFF5'}),
  sell:Object.freeze({accent:'#FF8985',border:'#DB696C',background:'#4B252D',text:'#FFF0ED'}),
});
export const TRADE_MARKER_LIGHT_COLORS=Object.freeze({
  buy:Object.freeze({accent:'#0E9F7E',border:'#23A686',background:'#E4F6EF',text:'#0A5A47'}),
  sell:Object.freeze({accent:'#D9434E',border:'#DC5A62',background:'#FBE8E9',text:'#8F1F29'}),
});
export function markerCaption(candidate:MarkerCandidate):string {
  const side=translate(candidate.side==='buy'?'买入':'卖出'),raw=candidate.sourceTag?.replace(/\s+/g,' ').trim();
  // Source tags are a finite platform vocabulary. Arbitrary provenance and
  // candidate.label remain opaque; custom overlay text has separate renderers.
  const tag=raw&&getLocale()==='en-US'&&['成交','信号','均线','指标'].includes(raw)?translate(`${raw}标记`):raw;
  return tag?`${[...tag].slice(0,6).join('')} · ${side}`:side;
}
function labelWidth(candidate:MarkerCandidate):number {
  if(!candidate.sourceTag?.trim())return TRADE_MARKER_METRICS.labelWidth;
  // Conservative character widths keep the geometry deterministic in workers
  // and tests; 28px reserves the arrow and outer padding.
  return Math.max(TRADE_MARKER_METRICS.labelWidth,28+[...markerCaption(candidate)].reduce((width,char)=>width+(char===' '?3:char==='·'?4:/[\u0000-\u007f]/.test(char)?7:12),0));
}
const validBounds=(bounds:MarkerBounds)=>[bounds.left,bounds.top,bounds.right,bounds.bottom].every(Number.isFinite)&&bounds.right>bounds.left&&bounds.bottom>bounds.top&&Number.isFinite((bounds.right-bounds.left)*(bounds.bottom-bounds.top));
const rect=(left:number,top:number,width:number,height:number):MarkerBounds=>({left,top,right:left+width,bottom:top+height});
const inside=(a:MarkerBounds,b:MarkerBounds)=>a.left>=b.left&&a.right<=b.right&&a.top>=b.top&&a.bottom<=b.bottom;
const union=(a:MarkerBounds,b:MarkerBounds):MarkerBounds=>({left:Math.min(a.left,b.left),top:Math.min(a.top,b.top),right:Math.max(a.right,b.right),bottom:Math.max(a.bottom,b.bottom)});
const count=(value:number|undefined,fallback:number,max:number)=>Number.isFinite(value)?Math.max(0,Math.min(max,Math.floor(value!))):fallback;

/** Bounded occupancy grid: no growing per-cell rectangle lists or quadratic collision scans. */
class MarkerOccupancy {
  private cell:number;private columns:number;private rows:number;private occupied:Uint8Array;
  constructor(private bounds:MarkerBounds){
    const width=bounds.right-bounds.left,height=bounds.bottom-bounds.top;
    this.cell=Math.max(4,Math.sqrt(width*height/500000),width/500000,height/500000);
    this.columns=Math.ceil(width/this.cell);this.rows=Math.ceil(height/this.cell);
    while(this.columns*this.rows>500000){this.cell*=2;this.columns=Math.ceil(width/this.cell);this.rows=Math.ceil(height/this.cell);}
    this.occupied=new Uint8Array(this.columns*this.rows);
  }
  private cells(bounds:MarkerBounds){
    return {left:Math.max(0,Math.floor((bounds.left-this.bounds.left)/this.cell)),top:Math.max(0,Math.floor((bounds.top-this.bounds.top)/this.cell)),right:Math.min(this.columns-1,Math.ceil((bounds.right-this.bounds.left)/this.cell)-1),bottom:Math.min(this.rows-1,Math.ceil((bounds.bottom-this.bounds.top)/this.cell)-1)};
  }
  blocked(bounds:MarkerBounds):boolean {
    const cells=this.cells(bounds);
    for(let y=cells.top;y<=cells.bottom;y++)for(let x=cells.left;x<=cells.right;x++)if(this.occupied[y*this.columns+x])return true;
    return false;
  }
  reserve(bounds:MarkerBounds,padding=0):void {
    const cells=this.cells({left:bounds.left-padding,top:bounds.top-padding,right:bounds.right+padding,bottom:bounds.bottom+padding});
    for(let y=cells.top;y<=cells.bottom;y++)this.occupied.fill(1,y*this.columns+cells.left,y*this.columns+cells.right+1);
  }
}

export function layoutTradeMarkers<T extends MarkerCandidate>(candidates:readonly T[],bounds:MarkerBounds,options:TradeMarkerLayoutOptions={}):TradeMarkerLayout<T>[] {
  if(!validBounds(bounds))return [];
  const maximum=count(options.maxMarkers,2000,10000),labelsMaximum=count(options.maxLabels,300,10000);
  if(!maximum||!candidates.length)return [];
  const metrics=TRADE_MARKER_METRICS,padding=Number.isFinite(options.collisionPadding)?Math.max(0,Math.min(8,options.collisionPadding!)):2;
  const occupancy=new MarkerOccupancy(bounds),selected:{candidate:T;index:number;anchorBounds:MarkerBounds}[]=[];
  for(const occupied of options.occupiedRects??[])if(validBounds(occupied)&&occupied.right>bounds.left&&occupied.left<bounds.right&&occupied.bottom>bounds.top&&occupied.top<bounds.bottom)occupancy.reserve(occupied,padding);
  const sampleCount=Math.min(maximum,candidates.length);
  for(let sample=0;sample<sampleCount;sample++){
    const index=sampleCount===1?candidates.length-1:Math.floor(sample*(candidates.length-1)/(sampleCount-1)),candidate=candidates[index];
    if(!candidate||!Number.isFinite(candidate.x)||!Number.isFinite(candidate.y)||candidate.side!=='buy'&&candidate.side!=='sell'||candidate.opacity!==undefined&&(!Number.isFinite(candidate.opacity)||candidate.opacity<=0)||candidate.x<bounds.left||candidate.x>bounds.right||candidate.y<bounds.top||candidate.y>bounds.bottom)continue;
    const anchorBounds=rect(candidate.x-metrics.anchorRadius,candidate.y-metrics.anchorRadius,metrics.anchorRadius*2,metrics.anchorRadius*2);
    selected.push({candidate,index,anchorBounds});occupancy.reserve(anchorBounds);
  }
  let labels=0;
  return selected.map(({candidate,index,anchorBounds})=>{
    const anchor={x:candidate.x,y:candidate.y},sign=candidate.side==='buy'?1:-1,direction=candidate.side==='buy'?'up' as const:'down' as const;
    const from={x:anchor.x,y:anchor.y+sign*(metrics.anchorRadius+metrics.anchorGap)};
    for(const mode of ['label','compact'] as const){
      if(mode==='label'&&labels>=labelsMaximum)continue;
      const width=mode==='label'?labelWidth(candidate):metrics.compactWidth,height=mode==='label'?metrics.labelHeight:metrics.compactHeight;
      const to={x:anchor.x,y:from.y+sign*(mode==='label'?metrics.leaderLength:metrics.compactLeaderLength)};
      const labelBounds=rect(anchor.x-width/2,sign>0?to.y:to.y-height,width,height);
      if(!inside(labelBounds,bounds)||occupancy.blocked(labelBounds))continue;
      occupancy.reserve(labelBounds,padding);if(mode==='label')labels++;
      return {candidate,index,mode,anchor,anchorBounds,labelBounds,leader:{from,to},arrow:{x:mode==='label'?labelBounds.left+10:anchor.x,y:(labelBounds.top+labelBounds.bottom)/2,direction},hitBounds:union(anchorBounds,labelBounds)};
    }
    return {candidate,index,mode:'anchor' as const,anchor,anchorBounds,labelBounds:null,leader:null,arrow:null,hitBounds:anchorBounds};
  });
}

function roundedBox(ctx:CanvasRenderingContext2D,bounds:MarkerBounds,radius:number){
  ctx.beginPath();ctx.roundRect(bounds.left,bounds.top,bounds.right-bounds.left,bounds.bottom-bounds.top,radius);
}
function drawArrow(ctx:CanvasRenderingContext2D,arrow:NonNullable<TradeMarkerLayout['arrow']>,color:string){
  const sign=arrow.direction==='up'?-1:1,tip=arrow.y+sign*3.5;
  ctx.strokeStyle=color;ctx.lineWidth=1.4;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();
  ctx.moveTo(arrow.x,arrow.y-sign*3.5);ctx.lineTo(arrow.x,tip);
  ctx.moveTo(arrow.x-2.8,arrow.y+sign*.5);ctx.lineTo(arrow.x,tip);ctx.lineTo(arrow.x+2.8,arrow.y+sign*.5);ctx.stroke();
}
function markerPalette(candidate:MarkerCandidate,tone:'dark'|'light'){
  const palette=(tone==='light'?TRADE_MARKER_LIGHT_COLORS:TRADE_MARKER_COLORS)[candidate.side],color=candidate.color;
  // The chart's editable colors are CSS hex values. Invalid external strings
  // must not leave the canvas accidentally using a previous marker's color.
  if(!color||!/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color))return palette;
  const hex=color.length<=5?color.slice(1).split('').map(value=>value+value).join(''):color.slice(1);
  const rgb=[0,2,4].map(offset=>parseInt(hex.slice(offset,offset+2),16));
  // Dark: a deep tint of the color; light: a pale wash with darkened text.
  const background=tone==='light'?rgb.map(c=>Math.round(c*.14+255*.86)):rgb.map((c,index)=>Math.round(c*.2+[13,20,26][index]*.8));
  const text=tone==='light'?`rgb(${rgb.map(c=>Math.round(c*.55)).join(',')})`:palette.text;
  return {...palette,accent:color,border:color,background:`rgb(${background.join(',')})`,text};
}

/** Paints in the supplied order without resizing/scaling the canvas or moving any anchor. */
export function drawTradeMarkers(ctx:CanvasRenderingContext2D,layouts:readonly TradeMarkerLayout[],options:TradeMarkerPaintOptions={}):void {
  const metrics=TRADE_MARKER_METRICS,inheritedAlpha=ctx.globalAlpha;
  ctx.save();
  if(options.clipBounds&&validBounds(options.clipBounds)){
    const b=options.clipBounds;ctx.beginPath();ctx.rect(b.left,b.top,b.right-b.left,b.bottom-b.top);ctx.clip();
  }
  ctx.setLineDash([]);ctx.shadowBlur=0;ctx.shadowOffsetX=0;ctx.shadowOffsetY=0;ctx.shadowColor='transparent';
  ctx.font=`600 ${metrics.fontSize}px ${options.fontFamily??SANS_STACK}`;
  ctx.textAlign='left';ctx.textBaseline='middle';
  const tone=options.tone??'dark',halo=tone==='light'?'#FFFFFF':'#131B22',drop=tone==='light'?'rgba(16, 24, 40, 0.1)':'rgba(0, 0, 0, 0.3)';
  for(const item of layouts){
    const palette=markerPalette(item.candidate,tone);
    ctx.globalAlpha=inheritedAlpha*Math.max(0,Math.min(1,item.candidate.opacity??1));
    if(item.leader){
      ctx.lineWidth=1;ctx.strokeStyle=palette.border;ctx.beginPath();ctx.moveTo(item.leader.from.x,item.leader.from.y);ctx.lineTo(item.leader.to.x,item.leader.to.y);ctx.stroke();
    }
    if(item.labelBounds){
      const b=item.labelBounds,radius=3;
      roundedBox(ctx,{...b,top:b.top+1,bottom:b.bottom+1},radius);ctx.fillStyle=drop;ctx.fill();
      roundedBox(ctx,b,radius);ctx.fillStyle=palette.background;ctx.fill();ctx.lineWidth=1;ctx.strokeStyle=palette.border;ctx.stroke();
      if(item.arrow)drawArrow(ctx,item.arrow,palette.accent);
      if(item.mode==='label'){ctx.fillStyle=palette.text;ctx.fillText(markerCaption(item.candidate),b.left+20,(b.top+b.bottom)/2+.5);}
    }
    // A background-tone halo keeps the small cross-point ring readable over any candle.
    ctx.beginPath();ctx.arc(item.anchor.x,item.anchor.y,metrics.anchorRadius,0,Math.PI*2);ctx.lineWidth=3.5;ctx.strokeStyle=halo;ctx.stroke();
    ctx.fillStyle=halo;ctx.fill();ctx.lineWidth=1.5;ctx.strokeStyle=palette.accent;ctx.stroke();
    if(item.candidate.kind==='fill'){ctx.beginPath();ctx.arc(item.anchor.x,item.anchor.y,1,0,Math.PI*2);ctx.fillStyle=palette.accent;ctx.fill();}
  }
  ctx.restore();
}
