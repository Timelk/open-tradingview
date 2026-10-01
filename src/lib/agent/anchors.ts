import type {ColumnView} from '../core/types';
import type {Anchor} from '../drawing/types';
import {indexForTime,timeForIndex} from '../drawing/coordinates';

/** Agent-facing coordinates. Everything resolves to the drawing engine's
 * `{time,value}` anchors against the loaded bars; nothing is stored in pixels. */
export type TimeInput=number|string;
export type TimeFormat='iso'|'ms';
export type PriceField='open'|'high'|'low'|'close'|'hl2'|'hlc3'|'ohlc4';
export const PRICE_FIELDS:readonly PriceField[]=['open','high','low','close','hl2','hlc3','ohlc4'];
export interface AnchorInput {time?:TimeInput;bar?:number;barsAgo?:number;offset?:number;value?:number;price?:PriceField}
export interface RangeInput {preset?:'visible'|'all'|'selection';last?:number;from?:TimeInput;to?:TimeInput;fromBar?:number;toBar?:number}
export interface BarSpace {cols:ColumnView;intervalMs:number}
export interface RangeContext extends BarSpace {visible:{from:number;to:number};selection?:{from:number;to:number}}
/** Inclusive start, exclusive end, integer bar indices inside the loaded data. */
export interface BarRange {start:number;end:number}

/** Rejected agent input; the bridge reports it as BAD_REQUEST. */
export class AgentInputError extends Error {}
export const isRecord=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function finite(value:unknown,label:string):number {
  if(typeof value!=='number'||!Number.isFinite(value))throw new AgentInputError(`${label} must be a finite number`);
  return value;
}

const LOCAL=/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;
/** Epoch milliseconds, epoch seconds (< 1e11) or ISO-8601. Strings without an
 * offset are local time, like the chart's time axis. */
export function parseTime(value:unknown,label='time'):number {
  if(typeof value==='number'&&Number.isFinite(value))return Math.abs(value)<1e11?value*1000:value;
  if(typeof value==='string'){
    const text=value.trim(),local=LOCAL.exec(text);
    const time=local?new Date(+local[1],+local[2]-1,+local[3],+(local[4]??0),+(local[5]??0),+(local[6]??0),+(local[7]??'0').padEnd(3,'0')).getTime():Date.parse(text);
    if(Number.isFinite(time))return time;
  }
  throw new AgentInputError(`${label} must be epoch milliseconds or an ISO-8601 time`);
}
const pad=(value:number,width=2)=>String(value).padStart(width,'0');
/** ISO-8601 with the browser's own UTC offset: the same wall clock the user reads on the axis. */
export function formatTime(ms:number,format:TimeFormat='iso'):string|number|null {
  if(!Number.isFinite(ms))return null;
  if(format==='ms')return ms;
  const date=new Date(ms),offset=-date.getTimezoneOffset(),abs=Math.abs(offset),millis=date.getMilliseconds();
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${millis?`.${pad(millis,3)}`:''}${offset>=0?'+':'-'}${pad(Math.floor(abs/60))}:${pad(abs%60)}`;
}
export function timeFormatOf(value:unknown):TimeFormat {
  if(value===undefined||value==='iso')return 'iso';if(value==='ms')return 'ms';
  throw new AgentInputError("timeFormat must be 'iso' or 'ms'");
}
/** Compact numbers for model context: 10 significant digits, NaN as null. */
export const num=(value:number):number|null=>Number.isFinite(value)?Number(value.toPrecision(10)):null;

export function priceAt(cols:ColumnView,index:number,field:PriceField):number {
  const o=cols.col('open')[index],h=cols.col('high')[index],l=cols.col('low')[index],c=cols.col('close')[index];
  return field==='open'?o:field==='high'?h:field==='low'?l:field==='close'?c:field==='hl2'?(h+l)/2:field==='hlc3'?(h+l+c)/3:(o+h+l+c)/4;
}
function normalizeAnchor(raw:unknown,label:string):AnchorInput {
  if(Array.isArray(raw)){
    if(raw.length!==2)throw new AgentInputError(`${label} tuple must be [time, value]`);
    return {time:raw[0] as TimeInput,value:raw[1] as number};
  }
  if(!isRecord(raw))throw new AgentInputError(`${label} must be an object like {time, value} or {barsAgo, price:'high'}`);
  const input=raw as AnchorInput;
  if(input.price!==undefined&&!PRICE_FIELDS.includes(input.price))throw new AgentInputError(`${label}.price must be one of ${PRICE_FIELDS.join(', ')}`);
  return input;
}
/** Fractional bar index for bar/barsAgo/time, plus an optional bar offset. */
export function anchorIndex(space:BarSpace,input:AnchorInput,label:string):number {
  const n=space.cols.length,given=(['time','bar','barsAgo'] as const).filter(key=>input[key]!==undefined);
  if(given.length!==1)throw new AgentInputError(`${label} needs exactly one of time, bar or barsAgo`);
  let index=input.bar!==undefined?(finite(input.bar,`${label}.bar`)<0?n+input.bar:input.bar)
    :input.barsAgo!==undefined?n-1-finite(input.barsAgo,`${label}.barsAgo`)
    :indexForTime(space.cols,parseTime(input.time,`${label}.time`),space.intervalMs);
  if(input.offset!==undefined)index+=finite(input.offset,`${label}.offset`);
  return index;
}
/** Resolve one agent anchor. `price` snaps both value and time to that bar's
 * OHLC field; a plain `time` keeps its exact instant (between bars is valid). */
export function resolveAnchor(space:BarSpace,raw:unknown,label='point'):Anchor {
  const input=normalizeAnchor(raw,label),n=space.cols.length;
  if(!n)throw new AgentInputError('the chart has no loaded bars yet');
  const index=anchorIndex(space,input,label);
  if(input.price!==undefined){
    const at=Math.round(index);
    if(at<0||at>=n)throw new AgentInputError(`${label}.price needs a loaded bar, but ${label} is outside the loaded data`);
    return {time:space.cols.col('time')[at],value:priceAt(space.cols,at,input.price)};
  }
  const time=input.time!==undefined&&input.offset===undefined?parseTime(input.time,`${label}.time`):timeForIndex(space.cols,index,space.intervalMs);
  if(input.value===undefined)throw new AgentInputError(`${label} needs value (a number) or price (${PRICE_FIELDS.join('|')})`);
  return {time,value:finite(input.value,`${label}.value`)};
}
/** Time/bar ranges resolve to whole loaded bars: first bar at or after `from`,
 * last bar at or before `to`; `last:n` ends at the newest bar. */
export function resolveRange(context:RangeContext,raw:unknown,fallback:'visible'|'all'='visible'):BarRange {
  const n=context.cols.length,clamp=(value:number)=>Math.max(0,Math.min(n,value));
  const input:RangeInput=raw===undefined||raw===null?{preset:fallback}:typeof raw==='string'?{preset:raw as RangeInput['preset']}:isRecord(raw)?raw as RangeInput:{};
  if(!isRecord(input)||!Object.keys(input).length)throw new AgentInputError("range must be 'visible', 'all', 'selection' or an object like {last:200} / {from, to}");
  let start:number,end:number;
  if(input.preset!==undefined){
    if(input.preset==='all'){start=0;end=n;}
    else if(input.preset==='visible'){start=Math.floor(context.visible.from);end=Math.ceil(context.visible.to)+1;}
    else if(input.preset==='selection'){
      if(!context.selection)throw new AgentInputError('nothing with a time span is selected on the chart');
      start=Math.ceil(indexForTime(context.cols,context.selection.from,context.intervalMs)-1e-9);end=Math.floor(indexForTime(context.cols,context.selection.to,context.intervalMs)+1e-9)+1;
    }else throw new AgentInputError("range.preset must be 'visible', 'all' or 'selection'");
  }else if(input.last!==undefined){
    const count=finite(input.last,'range.last');if(count<1)throw new AgentInputError('range.last must be at least 1');
    end=n;start=n-Math.floor(count);
  }else{
    const edge=(bar:unknown,time:unknown,label:string,first:boolean)=>{
      if(bar!==undefined){const value=Math.round(finite(bar,`range.${label}Bar`));return value<0?n+value:value;}
      if(time===undefined)return first?0:n-1;
      const index=indexForTime(context.cols,parseTime(time,`range.${label}`),context.intervalMs);
      return first?Math.ceil(index-1e-9):Math.floor(index+1e-9);
    };
    start=edge(input.fromBar,input.from,'from',true);end=edge(input.toBar,input.to,'to',false)+1;
  }
  start=clamp(start);end=clamp(end);
  return {start,end:Math.max(start,end)};
}
