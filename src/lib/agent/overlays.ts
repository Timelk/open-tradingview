import type {OverlayDrawing,OverlayDrawingSpec,OverlayMarker,OverlayPlot,OverlayShape,OverlayShapeSpec} from '../core/types';
import {indexForTime} from '../drawing/coordinates';
import {AgentInputError,anchorIndex,finite,isRecord,priceAt,resolveAnchor,type AnchorInput,type BarSpace} from './anchors';

/** Agent overlays are declarative, session-only chart outputs (not user
 * drawings). They are stored in time space and re-materialized into the
 * controller's index-aligned plots whenever bars reload or history is
 * prepended, so an index never goes stale. */
export const OVERLAY_KINDS=['line','hist','band','markers','shapes','objects'] as const;
export const AGENT_PANE_PREFIX='agent-pane:';
export type AgentOverlayKind=typeof OVERLAY_KINDS[number];
export const SHAPES:readonly OverlayShapeSpec['shape'][]=['circle','square','diamond','triangleup','triangledown','arrowup','arrowdown','cross','xcross','labelup','labeldown','flag'];
const LOCATIONS:readonly OverlayShapeSpec['location'][]=['abovebar','belowbar','top','bottom','absolute'];
const SIZES:readonly OverlayShapeSpec['size'][]=['auto','tiny','small','normal','large','huge'];
const LABEL_STYLES:readonly string[]=['label_down','label_up','label_left','label_right','label_center','none','circle','square','diamond','triangleup','triangledown','arrowup','arrowdown'];
const MAX_ITEMS=2000,MAX_POINTS=50000,MAX_TEXT=500;
interface TimeValue {time:number;value:number}
type AgentObject=Omit<OverlayDrawingSpec,'x1'|'x2'>&{t1:number;t2:number};
export interface AgentOverlay {
  id:string;name:string;kind:AgentOverlayKind;paneId:string;color:string;width:number;market:string;
  fill:'none'|'linear'|'step';points:TimeValue[];upper:TimeValue[];
  markers:(TimeValue&{side:'buy'|'sell';text:string})[];
  shapes:(Omit<OverlayShapeSpec,'barIndex'|'offset'>)[];
  objects:AgentObject[];
}
const CSS_COLOR=/^(#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|[a-z]{3,20})$/i;
/** Line/hist/band colors go through the WebGL path, which only parses #rgb/#rrggbb. */
function seriesColor(value:unknown,label:string):string {
  if(value===undefined)return '#f0b429';
  const text=typeof value==='string'?value.trim():'',short=/^#([\da-f])([\da-f])([\da-f])$/i.exec(text);
  if(short)return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  if(/^#[\da-f]{6}$/i.test(text))return text.toLowerCase();
  throw new AgentInputError(`${label} must be #rrggbb for line/hist/band overlays (alpha only for markers, shapes and objects)`);
}
export function overlayColor(value:unknown,label:string,fallback:string):string {
  if(value===undefined)return fallback;
  if(typeof value!=='string'||!CSS_COLOR.test(value.trim()))throw new AgentInputError(`${label} must be a CSS color such as #f0b429 or rgba(240,180,41,0.4)`);
  return value.trim();
}
function text(value:unknown,label:string):string {
  if(value===undefined)return '';
  if(typeof value!=='string'||value.length>MAX_TEXT)throw new AgentInputError(`${label} must be a string of at most ${MAX_TEXT} characters`);
  return value;
}
function oneOf<T extends string>(value:unknown,options:readonly T[],label:string,fallback:T):T {
  if(value===undefined)return fallback;
  if(!options.includes(value as T))throw new AgentInputError(`${label} must be one of ${options.join(', ')}`);
  return value as T;
}
function list(value:unknown,label:string,max:number):unknown[] {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>max)throw new AgentInputError(`${label} must be an array with at most ${max} items`);
  return value;
}
/** A bar reference without a value (markers/shapes/labels anchored to a candle). */
function barTime(space:BarSpace,raw:unknown,label:string):{time:number;index:number} {
  if(!isRecord(raw))throw new AgentInputError(`${label} must be an object with time, bar or barsAgo`);
  const index=anchorIndex(space,raw as AnchorInput,label),at=Math.round(index);
  if(at<0||at>=space.cols.length)throw new AgentInputError(`${label} is outside the loaded bars`);
  return {time:space.cols.col('time')[at],index:at};
}

export function parseOverlay(space:BarSpace,raw:unknown,context:{market:string;panes:ReadonlySet<string>}):AgentOverlay {
  if(!isRecord(raw))throw new AgentInputError('overlay must be an object');
  const id=raw.id;
  if(typeof id!=='string'||!/^[\w.-]{1,64}$/.test(id))throw new AgentInputError('overlay.id must be 1-64 letters, digits, "_", "-" or "."');
  const kind=oneOf(raw.kind,OVERLAY_KINDS,'overlay.kind','line'),requested=raw.paneId===undefined?'main':String(raw.paneId);
  // "new" gives the overlay its own pane; others may join it by id.
  const paneId=requested==='new'?`${AGENT_PANE_PREFIX}${id}`:requested;
  if(!context.panes.has(paneId)&&!(paneId.startsWith(AGENT_PANE_PREFIX)&&/^[\w:.-]{1,80}$/.test(paneId)))
    throw new AgentInputError(`overlay.paneId "${requested}" is not a pane on this chart (${[...context.panes].join(', ')}); use "new" for a separate pane`);
  const width=raw.width===undefined?2:finite(raw.width,'overlay.width');
  if(width<1||width>8)throw new AgentInputError('overlay.width must be between 1 and 8');
  const overlay:AgentOverlay={id,name:raw.name===undefined?`AI · ${id}`:text(raw.name,'overlay.name')||`AI · ${id}`,kind,paneId,width,market:context.market,
    color:kind==='line'||kind==='hist'||kind==='band'?seriesColor(raw.color,'overlay.color'):overlayColor(raw.color,'overlay.color','#f0b429'),fill:oneOf(raw.fill,['none','linear','step'] as const,'overlay.fill',kind==='hist'?'none':'linear'),
    points:[],upper:[],markers:[],shapes:[],objects:[]};
  const series=(value:unknown,label:string)=>list(value,label,MAX_POINTS).map((point,i)=>resolveAnchor(space,point,`${label}[${i}]`));
  if(kind==='line'||kind==='hist'||kind==='band'){
    overlay.points=series(raw.points,'overlay.points');
    if(!overlay.points.length)throw new AgentInputError(`a ${kind} overlay needs points`);
    if(kind==='band'){overlay.upper=series(raw.upper,'overlay.upper');if(!overlay.upper.length)throw new AgentInputError('a band overlay needs upper points (points are the lower edge)');}
  }else if(kind==='markers'){
    overlay.markers=list(raw.markers,'overlay.markers',MAX_ITEMS).map((item,i)=>{
      const label=`overlay.markers[${i}]`;if(!isRecord(item))throw new AgentInputError(`${label} must be an object`);
      const side=oneOf(item.side,['buy','sell'] as const,`${label}.side`,'buy'),at=barTime(space,item,label);
      const value=item.value!==undefined||item.price!==undefined?resolveAnchor(space,{...item,time:at.time,bar:undefined,barsAgo:undefined,offset:undefined},label).value:priceAt(space.cols,at.index,side==='buy'?'low':'high');
      return {time:at.time,value,side,text:text(item.text,`${label}.text`)};
    });
    if(!overlay.markers.length)throw new AgentInputError('a markers overlay needs markers');
  }else if(kind==='shapes'){
    overlay.shapes=list(raw.shapes,'overlay.shapes',MAX_ITEMS).map((item,i)=>{
      const label=`overlay.shapes[${i}]`;if(!isRecord(item))throw new AgentInputError(`${label} must be an object`);
      const location=oneOf(item.location,LOCATIONS,`${label}.location`,'abovebar'),at=barTime(space,item,label);
      const value=location==='absolute'?resolveAnchor(space,{...item,time:at.time,bar:undefined,barsAgo:undefined,offset:undefined},label).value:null;
      return {time:at.time,value,shape:oneOf(item.shape,SHAPES,`${label}.shape`,location==='belowbar'?'triangleup':'triangledown'),location,
        color:overlayColor(item.color,`${label}.color`,overlay.color),text:text(item.text,`${label}.text`),textColor:overlayColor(item.textColor,`${label}.textColor`,overlay.color),size:oneOf(item.size,SIZES,`${label}.size`,'small')};
    });
    if(!overlay.shapes.length)throw new AgentInputError('a shapes overlay needs shapes');
  }else{
    overlay.objects=list(raw.objects,'overlay.objects',MAX_ITEMS).map((item,i)=>parseObject(space,item,`overlay.objects[${i}]`,overlay));
    if(!overlay.objects.length)throw new AgentInputError('an objects overlay needs objects');
  }
  return overlay;
}
function parseObject(space:BarSpace,item:unknown,label:string,overlay:AgentOverlay):AgentObject {
  if(!isRecord(item))throw new AgentInputError(`${label} must be an object`);
  const kind=oneOf(item.kind,['line','box','label'] as const,`${label}.kind`,'label');
  const lineStyle=oneOf(item.lineStyle,['solid','dashed','dotted'] as const,`${label}.lineStyle`,'solid');
  const width=item.width===undefined?(kind==='label'?0:overlay.width):finite(item.width,`${label}.width`);
  if(width<0||width>8)throw new AgentInputError(`${label}.width must be between 0 and 8`);
  const style=kind==='label'?oneOf(item.style,LABEL_STYLES,`${label}.style`,'label_down'):'';
  const fontSize=item.fontSize===undefined?12:finite(item.fontSize,`${label}.fontSize`);
  if(fontSize<8||fontSize>32)throw new AgentInputError(`${label}.fontSize must be between 8 and 32`);
  const common={id:`${overlay.id}:${label}`,kind,xloc:'bar_time' as const,style,stroke:overlayColor(item.color,`${label}.color`,overlay.color),
    fill:overlayColor(item.fill,`${label}.fill`,kind==='box'?'rgba(240,180,41,0.12)':kind==='label'?overlay.color:'transparent'),width,lineStyle,
    text:text(item.text,`${label}.text`),textColor:overlayColor(item.textColor,`${label}.textColor`,kind==='label'&&style!=='none'?'#ffffff':overlay.color),fontSize,
    fontWeight:oneOf(item.fontWeight,['normal','bold'] as const,`${label}.fontWeight`,'normal'),
    textAlign:oneOf(item.textAlign,['left','center','right'] as const,`${label}.textAlign`,kind==='box'?'left':'center'),
    textValign:oneOf(item.textValign,['top','center','bottom'] as const,`${label}.textValign`,kind==='box'?'top':'center'),tooltip:text(item.tooltip,`${label}.tooltip`)};
  if(kind==='label'){
    const yloc=oneOf(item.yloc,['price','abovebar','belowbar'] as const,`${label}.yloc`,'price');
    const at=yloc==='price'?resolveAnchor(space,item.at,`${label}.at`):{...resolveAnchor(space,{...(isRecord(item.at)?item.at:{}),price:'close'},`${label}.at`)};
    return {...common,yloc,t1:at.time,y1:at.value,t2:at.time,y2:at.value};
  }
  const from=resolveAnchor(space,item.from,`${label}.from`),to=resolveAnchor(space,item.to,`${label}.to`);
  return {...common,yloc:'price',t1:from.time,y1:from.value,t2:to.time,y2:to.value};
}

/** Build the controller plot for the currently loaded bars. Points outside
 * the loaded data are dropped for series kinds; objects may extend into the
 * future because the chart projects any bar index. */
export function materializeOverlay(space:BarSpace,overlay:AgentOverlay):OverlayPlot {
  const n=space.cols.length,indexOf=(time:number)=>indexForTime(space.cols,time,space.intervalMs);
  const pane=overlay.paneId==='main'?'main':overlay.paneId==='volume'?'volume':'sub';
  const base={id:`agent:${overlay.id}`,name:overlay.name,paneId:overlay.paneId,pane,color:overlay.color,width:overlay.width} as const;
  if(overlay.kind==='markers'){
    const markers:OverlayMarker[]=overlay.markers.map(m=>({index:indexOf(m.time),value:m.value,side:m.side,time:m.time,...(m.text?{label:m.text}:{})})).sort((a,b)=>a.index-b.index);
    return {...base,kind:'markers',values:new Float64Array(0),side:new Int8Array(0),markers};
  }
  if(overlay.kind==='shapes'){
    const shapes:OverlayShape[]=overlay.shapes.map(s=>{const index=Math.round(indexOf(s.time));return {...s,barIndex:index,offset:0,index,sourceIndex:index};}).sort((a,b)=>a.index-b.index);
    return {...base,kind:'shapes',values:new Float64Array(0),shapes};
  }
  if(overlay.kind==='objects'){
    const drawings:OverlayDrawing[]=overlay.objects.map(({t1,t2,...o})=>{const index1=indexOf(t1),index2=indexOf(t2);return {...o,x1:index1,x2:index2,index1,index2};});
    return {...base,kind:'drawings',values:new Float64Array(0),drawings};
  }
  const place=(points:TimeValue[])=>{
    const map=new Map<number,number>();
    for(const p of points){const at=Math.round(indexOf(p.time));if(at>=0&&at<n)map.set(at,p.value);}
    return map;
  };
  const lower=place(overlay.points),upper=place(overlay.upper),keys=[...lower.keys(),...upper.keys()];
  if(!keys.length)return {...base,kind:overlay.kind,values:new Float64Array(0)};
  const offset=Math.min(...keys),length=Math.max(...keys)-offset+1;
  const fill=(map:Map<number,number>)=>{
    const values=new Float64Array(length).fill(NaN),known=[...map].sort((a,b)=>a[0]-b[0]);
    known.forEach(([index,value],k)=>{
      values[index-offset]=value;const next=known[k+1];if(!next||overlay.fill==='none')return;
      for(let i=index+1;i<next[0];i++)values[i-offset]=overlay.fill==='step'?value:value+(next[1]-value)*(i-index)/(next[0]-index);
    });
    return values;
  };
  return {...base,kind:overlay.kind,offset,values:fill(lower),...(overlay.kind==='band'?{upper:fill(upper)}:{})};
}
/** Compact description for state output. */
export function describeOverlay(overlay:AgentOverlay){
  const items=overlay.kind==='markers'?overlay.markers.length:overlay.kind==='shapes'?overlay.shapes.length:overlay.kind==='objects'?overlay.objects.length:overlay.points.length;
  return {id:`agent:${overlay.id}`,name:overlay.name,kind:overlay.kind,paneId:overlay.paneId,color:overlay.color,items};
}
