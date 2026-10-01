import type {ChartAppearance} from '../chart/appearance';
import {SANS_STACK} from './fonts';

export interface PricePainter {
  rect(x0:number,y0:number,x1:number,y1:number,color:string,alpha?:number):void;
  seg(x0:number,y0:number,x1:number,y1:number,color:string,alpha?:number,width?:number):void;
  /** Rounded bodies; painters without them draw square candles. */
  roundRect?(x0:number,y0:number,x1:number,y1:number,radius:number,color:string,alpha?:number):void;
  roundRing?(x0:number,y0:number,x1:number,y1:number,radius:number,width:number,color:string,alpha?:number):void;
}
/** Effective corner radius: at most ~35% of the body width, never more than half its height. */
export function candleCornerRadius(style:Pick<ChartAppearance,'candleRadius'>,width:number,height:number):number {
  const radius=Math.min(style.candleRadius,width*.35,height/2);
  return radius>=.5?radius:0;
}
export interface PriceBar {open:number;high:number;low:number;close:number}
/** Hollow fill represents close/open, while its color represents close/previous close. */
export function priceBarUp(bar:PriceBar,previousClose:number|undefined,style:ChartAppearance):boolean {
  const reference=(style.chartType==='hollow'||style.colorBy==='previous-close')&&Number.isFinite(previousClose)?previousClose!:bar.open;
  return bar.close>=reference;
}
export function paintPriceBar(r:PricePainter,bar:PriceBar,previousClose:number|undefined,x:number,half:number,y:(value:number)=>number,style:ChartAppearance):void {
  if(![bar.open,bar.high,bar.low,bar.close,x,half].every(Number.isFinite))return;
  const up=priceBarUp(bar,previousClose,style),color=up?style.upColor:style.downColor;
  const yo=y(bar.open),yc=y(bar.close),yh=y(bar.high),yl=y(bar.low);
  if(![yo,yc,yh,yl].every(Number.isFinite))return;
  if(style.chartType==='bars'){
    r.seg(x,yh,x,yl,color);r.seg(x-half,yo,x,yo,color);r.seg(x,yc,x+half,yc,color);return;
  }
  if(style.chartType==='line')return;
  const top=Math.min(yo,yc),bottom=Math.max(yo,yc,top+1),left=x-half,right=x+half;
  const wick=up?style.wickUpColor:style.wickDownColor,border=up?style.borderUpColor:style.borderDownColor;
  if(style.showWicks){r.seg(x,yh,x,top,wick);r.seg(x,bottom,x,yl,wick);}
  const filled=style.showBodies&&(style.chartType!=='hollow'||bar.close<bar.open);
  const radius=r.roundRect&&r.roundRing?candleCornerRadius(style,right-left,bottom-top):0;
  if(radius>0){
    // One rounded silhouette: a border in the body color adds nothing but seams.
    const edge=Math.min(1,Math.max(.25,half)),bordered=style.showBorders&&(!filled||border!==color);
    if(filled)r.roundRect!(left,top,right,bottom,radius,bordered?border:color);
    if(filled&&bordered&&right-left>edge*2&&bottom-top>edge*2)r.roundRect!(left+edge,top+edge,right-edge,bottom-edge,Math.max(0,radius-edge),color);
    else if(!filled&&style.showBorders)r.roundRing!(left,top,right,bottom,radius,edge,border);
    return;
  }
  if(filled)r.rect(left,top,right,bottom,color);
  if(style.showBorders){
    const edge=Math.min(1,Math.max(.25,half));
    r.rect(left,top,right,Math.min(bottom,top+edge),border);
    if(bottom-top>edge)r.rect(left,bottom-edge,right,bottom,border);
    if(bottom-top>edge*2){r.rect(left,top+edge,Math.min(right,left+edge),bottom-edge,border);r.rect(Math.max(left,right-edge),top+edge,right,bottom-edge,border);}
  }
}

/** Drawn behind scene geometry, confined to the price pane and clipped at narrow widths. */
export function drawChartWatermark(ctx:CanvasRenderingContext2D,style:ChartAppearance,pane:{top:number;height:number;width:number},symbol:string,interval:string):void {
  if(!style.watermark||style.watermarkOpacity<=0||pane.width<30||pane.height<40)return;
  ctx.save();ctx.beginPath();ctx.rect(0,pane.top,pane.width,pane.height);ctx.clip();
  ctx.fillStyle=style.watermarkColor;ctx.globalAlpha=style.watermarkOpacity;ctx.textAlign='center';ctx.textBaseline='middle';
  const text=style.watermarkText.trim()||`${symbol} · ${interval}`;
  let size=Math.min(style.watermarkFontSize,pane.height*.24);ctx.font=`600 ${size}px ${SANS_STACK}`;
  const measured=ctx.measureText(text).width;
  if(measured>pane.width-32){size*=Math.max(1,pane.width-32)/measured;ctx.font=`600 ${size}px ${SANS_STACK}`;}
  ctx.fillText(text,pane.width/2,pane.top+pane.height/2);ctx.restore();
}
