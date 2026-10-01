/**
 * Canvas2D 覆盖层：网格、坐标轴、十字光标、最新价线——所有文字都在这里画，
 * WebGL 只管图元。这是 GPU 图表避开 shader 文字坑的标准分层。
 * 本文件用 CSS px 为单位，调用前 ctx 已做 dpr transform。
 */

import {getLocale,type Locale} from '../i18n';
import {contrastText,DEFAULT_APPEARANCE,type ChartAppearance} from '../chart/appearance';
import {MONO_STACK} from './fonts';

export interface PaneTicks {
  top: number;
  height: number;
  ticks: { value: number; y: number; digits?: number }[];
}

export interface AxesInput {
  ctx: CanvasRenderingContext2D;
  plotW: number;
  plotH: number;
  axisW: number;
  axisH: number;
  paneTicks: PaneTicks[];
  xTicks: { x: number; label: string }[];
  crosshair: { x: number; y: number; price: string; time: string } | null;
  lastPrice: { y: number; label: string; up: boolean } | null;
  hoverDot: { x: number; y: number } | null;
  /** Disable only plot-area guides when they are painted behind the scene. */
  plotGuides?: boolean;
  appearance?: ChartAppearance;
}

export interface PlotGuideSegment { x0:number;y0:number;x1:number;y1:number;color:string;alpha?:number }

const FONT_FAMILY = MONO_STACK;
const priceFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<Locale,Intl.DateTimeFormat>();
const timeFormats = new Map<string,Intl.DateTimeFormat>();
let lastDateTime: { time: number; locale:Locale; label: string } | undefined;

export function fmtPrice(v: number, digits = 2): string {
  const language=getLocale(),key=`${language}:${digits}`;
  let format = priceFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(language, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    priceFormats.set(key, format);
  }
  return format.format(v);
}

/** The crosshair often changes price while staying on the same candle. */
export function fmtDateTime(ms: number): string {
  const language=getLocale();
  if (lastDateTime?.time === ms&&lastDateTime.locale===language) return lastDateTime.label;
  let format=dateTimeFormats.get(language);
  if(!format){format=new Intl.DateTimeFormat(language,{year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric',hour12:false});dateTimeFormats.set(language,format);}
  const label = Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? format.format(ms) : 'Invalid Date';
  lastDateTime = { time: ms, locale:language, label };
  return label;
}

export function priceDigits(yMin: number, yMax: number): number {
  const span = Math.abs(yMax - yMin) || 1;
  if (span >= 1000) return 0;
  if (span >= 10) return 2;
  if (span >= 1) return 3;
  return Math.min(12,Math.max(5,Math.ceil(-Math.log10(span))+2));
}

export function fmtTime(ms: number, intraday: boolean): string {
  if(!Number.isFinite(ms)||Math.abs(ms)>8.64e15)return 'Invalid Date';
  const language=getLocale(),key=`${language}:${intraday}`;
  let format=timeFormats.get(key);
  // Omit timeZone deliberately: this changes presentation language, retaining
  // the same local axis timezone and 24-hour clock used before localization.
  if(!format){format=new Intl.DateTimeFormat(language,{...(intraday?{}:{month:'2-digit',day:'2-digit'}),hour:'2-digit',minute:'2-digit',hourCycle:'h23'});timeFormats.set(key,format);}
  return format.format(ms);
}

/** nice-number 刻度：count 为期望数量级，返回 [min,max] 内均分刻度。 */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) return [];
  const rawStep = (max - min) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  if(!Number.isFinite(step)||step<=0)return [];
  const first=Math.ceil(min/step),last=Math.floor(max/step+1e-9);
  const length=Math.min(1000,Math.max(0,last-first+1)),out:number[]=[];
  // Iterate tick indices: an absolute epsilon would produce thousands of
  // extra ticks on tiny prices, and fixed decimals would round them to zero.
  for(let i=0;i<length;i++)out.push(Number(((first+i)*step).toPrecision(15)));
  return out;
}

export function drawAxes(a: AxesInput): void {
  drawAxesBase(a);
  drawCrosshair(a);
}

/** Scene-background geometry in CSS pixels. Independent of plotGuides so the
 * same axis input can render guides below data and text above the scene. */
export function plotGuideSegments(a: AxesInput): PlotGuideSegment[] {
  return guideLines(a).flat();
}

/** Clear and paint the axis surface when viewport geometry or market data changes. */
export function drawAxesBase(a: AxesInput): void {
  const { ctx, plotW, plotH, axisW, axisH, paneTicks, xTicks, lastPrice } = a;
  const appearance=a.appearance??DEFAULT_APPEARANCE;
  ctx.clearRect(0, 0, plotW + axisW, plotH + axisH);
  if(!validPlot(a))return;
  ctx.font = `${appearance.scaleFontSize}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.setLineDash([]);
  // Axis surfaces share the chart palette rather than inheriting a dark UI.
  ctx.fillStyle=appearance.background;
  if(axisW>0)ctx.fillRect(plotW,0,axisW,plotH+Math.max(0,axisH));
  if(axisH>0)ctx.fillRect(0,plotH,plotW,axisH);

  ctx.lineWidth = 1;
  if(a.plotGuides!==false)for(const line of guideLines(a))strokeSegments(ctx,line);

  // Y 轴文字与 pane 分隔线始终位于覆盖层。
  const suppressLastPriceY = appearance.lastPriceLabel && lastPrice && Number.isFinite(lastPrice.y) ? lastPrice.y : null;
  for (const pane of paneTicks) {
    for (const t of pane.ticks) {
      ctx.fillStyle = appearance.textColor;
      if (suppressLastPriceY !== null && Math.abs(t.y - suppressLastPriceY) < Math.ceil(appearance.scaleFontSize * 0.85) + 4) continue;
      if (axisW>5&&Number.isFinite(t.y)&&t.y>=0&&t.y<=plotH&&t.y >= pane.top + appearance.scaleFontSize+1 && t.y <= pane.top + pane.height - appearance.scaleFontSize+2) {
        ctx.fillText(fmtPrice(t.value, t.digits ?? 2), plotW + 6, t.y,Math.max(0,axisW-10));
      }
    }
    if(!Number.isFinite(pane.top)||pane.top<0||pane.top>plotH)continue;
    ctx.strokeStyle = appearance.separatorColor;
    ctx.beginPath();
    const y=Math.min(plotH,Math.round(pane.top)+.5);
    ctx.moveTo(0,y);
    ctx.lineTo(plotW,y);
    ctx.stroke();
  }

  // X 轴
  for (const t of xTicks) {
    if(axisH<appearance.scaleFontSize+2||!Number.isFinite(t.x)||t.x<0||t.x>plotW)continue;
    ctx.fillStyle = appearance.textColor;
    ctx.fillText(t.label, Math.max(0,t.x - 22), plotH + axisH / 2,plotW);
  }

  // 最新价标签可以独立于价格线开关。
  if (appearance.lastPriceLabel&&lastPrice && Number.isFinite(lastPrice.y)&&lastPrice.y >= 0 && lastPrice.y <= plotH) {
    const c = lastPrice.up ? appearance.upColor : appearance.downColor;
    tag(a,lastPrice.y,lastPrice.label,c,contrastText(c));
  }
}

/** Paint pointer feedback over an existing surface; never erase cached axes. */
export function drawCrosshair(a: AxesInput): void {
  const { ctx, plotW, plotH, axisH, crosshair, hoverDot } = a;
  const appearance=a.appearance??DEFAULT_APPEARANCE;
  if(!validPlot(a))return;
  ctx.font = `${appearance.scaleFontSize}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);

  // hover 点
  if (hoverDot&&Number.isFinite(hoverDot.x)&&Number.isFinite(hoverDot.y)&&hoverDot.x>=0&&hoverDot.x<=plotW&&hoverDot.y>=0&&hoverDot.y<=plotH) {
    ctx.fillStyle = appearance.lineColor;
    ctx.beginPath();
    ctx.arc(hoverDot.x, hoverDot.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // 十字光标
  if (appearance.crosshairVisible&&crosshair&&Number.isFinite(crosshair.x)&&Number.isFinite(crosshair.y)&&crosshair.x>=0&&crosshair.x<=plotW&&crosshair.y>=0&&crosshair.y<=plotH) {
    const cx = Math.min(plotW,Math.round(crosshair.x) + 0.5);
    const cy = Math.min(plotH,Math.round(crosshair.y) + 0.5);
    const color=appearance.crosshairColor,foreground=contrastText(color);
    strokeSegments(ctx,[
      ...lineSegments(cx,0,cx,plotH,color,appearance.crosshairStyle),
      ...lineSegments(0,cy,plotW,cy,color,appearance.crosshairStyle),
    ]);
    tag(a,cy,crosshair.price,color,foreground);
    // 时间标签（底部轴）
    if(axisH<=0)return;
    ctx.fillStyle = color;
    const tw = Math.min(plotW,ctx.measureText(crosshair.time).width + 12);
    const tx = Math.min(Math.max(cx - tw / 2, 0),Math.max(0,plotW - tw));
    ctx.fillRect(tx, plotH, tw, axisH);
    ctx.fillStyle = foreground;
    const padding=Math.min(6,tw/4);
    if(axisH>=appearance.scaleFontSize+2)ctx.fillText(crosshair.time, tx + padding, plotH + axisH / 2,Math.max(0,tw-padding*2));
  }
}

function tag(
  a:AxesInput,
  y: number,
  label: string,
  bg: string,
  fg: string,
): void {
  const {ctx,plotW,plotH,axisW}=a;
  if(axisW<=0)return;
  const h = Math.min(plotH,(a.appearance??DEFAULT_APPEARANCE).scaleFontSize+5);
  const yy = Math.min(Math.max(y - h / 2, 0),plotH-h);
  ctx.fillStyle = bg;
  ctx.fillRect(plotW, yy, axisW, h);
  ctx.fillStyle = fg;
  const padding=Math.min(5,axisW/4);
  if(h>=(a.appearance??DEFAULT_APPEARANCE).scaleFontSize&&axisW>padding*2)ctx.fillText(label, plotW + padding, yy + h / 2,Math.max(0,axisW-padding*2));
}

function validPlot(a:AxesInput):boolean {
  return Number.isFinite(a.plotW)&&Number.isFinite(a.plotH)&&a.plotW>0&&a.plotH>0;
}

/** Explicit dash geometry keeps Canvas2D and WebGL guides identical. */
function lineSegments(x0:number,y0:number,x1:number,y1:number,color:string,style:ChartAppearance['gridStyle'],alpha=1,gapOverride?:number):PlotGuideSegment[] {
  const length=Math.hypot(x1-x0,y1-y0);
  if(!Number.isFinite(length)||length<=0||alpha<=0)return [];
  const extra=alpha===1?{}:{alpha};
  if(style==='solid')return [{x0,y0,x1,y1,color,...extra}];
  const dash=style==='dotted'?1:4,gap=gapOverride??(style==='dotted'?3:4);
  const segments:PlotGuideSegment[]=[];
  for(let start=0;start<length;start+=dash+gap){
    const end=Math.min(length,start+dash);
    segments.push({x0:x0+(x1-x0)*start/length,y0:y0+(y1-y0)*start/length,x1:x0+(x1-x0)*end/length,y1:y0+(y1-y0)*end/length,color,...extra});
  }
  return segments;
}

/** Each entry represents one logical line, preserving Canvas stroke batching. */
function guideLines(a:AxesInput):PlotGuideSegment[][] {
  const {plotW,plotH}=a,appearance=a.appearance??DEFAULT_APPEARANCE,lines:PlotGuideSegment[][]=[];
  if(!validPlot(a))return lines;
  if(appearance.grid==='both'||appearance.grid==='horizontal')for(const pane of a.paneTicks)for(const tick of pane.ticks){
    if(!Number.isFinite(tick.y)||tick.y<pane.top||tick.y>pane.top+pane.height||tick.y<0||tick.y>plotH)continue;
    const y=Math.min(plotH,Math.round(tick.y)+.5);
    lines.push(lineSegments(0,y,plotW,y,appearance.gridColor,appearance.gridStyle,appearance.gridOpacity));
  }
  if(appearance.grid==='both'||appearance.grid==='vertical')for(const tick of a.xTicks){
    if(!Number.isFinite(tick.x)||tick.x<0||tick.x>plotW)continue;
    const x=Math.min(plotW,Math.round(tick.x)+.5);
    lines.push(lineSegments(x,0,x,plotH,appearance.gridColor,appearance.gridStyle,appearance.gridOpacity));
  }
  const price=a.lastPrice;
  if(appearance.lastPriceLine&&price&&Number.isFinite(price.y)&&price.y>=0&&price.y<=plotH){
    const y=Math.min(plotH,Math.round(price.y)+.5),color=price.up?appearance.upColor:appearance.downColor;
    lines.push(lineSegments(0,y,plotW,y,color,'dashed',1,3));
  }
  return lines;
}

function strokeSegments(ctx:CanvasRenderingContext2D,segments:PlotGuideSegment[]):void {
  if(!segments.length)return;
  const previousAlpha=Number.isFinite(ctx.globalAlpha)?ctx.globalAlpha:1;
  ctx.globalAlpha=segments[0].alpha??1;
  ctx.strokeStyle=segments[0].color;
  ctx.beginPath();
  for(const segment of segments){ctx.moveTo(segment.x0,segment.y0);ctx.lineTo(segment.x1,segment.y1);}
  ctx.stroke();
  ctx.globalAlpha=previousAlpha;
}
