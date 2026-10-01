import type {DepthHeatmap,HistoricalAggregateOptions,HistoricalFlowAggregate,ReplaySnapshot} from './persistence-client';

export type HistoryViewMode='footprint'|'profile'|'tpo'|'heatmap'|'book';
export type AppliedHistoryQuery=Readonly<HistoricalAggregateOptions&{datasetId:string}>;
export function applyHistoryQuery(value:HistoricalAggregateOptions&{datasetId:string}):AppliedHistoryQuery {
  if(!value.datasetId||![value.from,value.to].every(n=>Number.isSafeInteger(n)&&n>=0)||value.to<=value.from||!Number.isFinite(value.tickSize)||value.tickSize<=0||
    !Number.isSafeInteger(value.timeframeMs)||value.timeframeMs<1000||!Number.isSafeInteger(value.tpoBlockMs??1800000)||(value.tpoBlockMs??1800000)<1000||
    !Number.isSafeInteger(value.priceStepTicks??1)||(value.priceStepTicks??1)<1)throw Error('请输入有效 UTC 区间、正价格跳动、整数价格档与时间块');
  return Object.freeze({...value});
}
export function historyCursor(query:AppliedHistoryQuery,value:number):number {return Math.max(query.from,Math.min(query.to,Number.isFinite(value)?Math.round(value):query.from));}
export function aggregateAtCursor(query:AppliedHistoryQuery,value:number):HistoricalAggregateOptions {
  const {datasetId:_,...options}=query;return {...options,to:historyCursor(query,value)};
}
export function advanceHistoryCursor(cursor:number,elapsedMs:number,speed:number,to:number):number {
  if(![cursor,elapsedMs,speed,to].every(Number.isFinite)||elapsedMs<0||speed<=0)return cursor;
  return Math.min(to,Math.round(cursor+elapsedMs*speed));
}
/** Full aggregate totals cannot be cropped by slicing its bars. A result from
 * after the cursor is entirely unavailable until a prefix query replaces it. */
export function visibleHistory(query:AppliedHistoryQuery|undefined,cursor:number,payload:{data?:HistoricalFlowAggregate;balance?:HistoricalFlowAggregate;frame?:ReplaySnapshot;heatmap?:DepthHeatmap}){
  if(!query||!Number.isFinite(cursor))return {data:undefined,balance:undefined,frame:undefined,heatmap:undefined};
  const at=historyCursor(query,cursor),same=(id:string)=>id===query.datasetId;
  const data=payload.data&&same(payload.data.datasetId)&&payload.data.fromTime===query.from&&payload.data.toTime<=at?payload.data:undefined;
  const balance=payload.balance&&same(payload.balance.datasetId)&&payload.balance.fromTime===query.from&&payload.balance.toTime<=at?payload.balance:undefined;
  const frame=payload.frame&&same(payload.frame.datasetId)&&payload.frame.at>=query.from&&payload.frame.at<=at?{...payload.frame,trades:payload.frame.trades.filter(trade=>trade.time<=at)}:undefined;
  const source=payload.heatmap;
  const heatmap=source&&same(source.datasetId)&&source.fromTime===query.from?{...source,toTime:Math.min(source.toTime,at),samples:source.samples.filter(sample=>sample.time>=query.from&&sample.time<=at).map(sample=>sample.book.time!==undefined&&sample.book.time>sample.time?{...sample,book:{status:'unavailable' as const,bids:[],asks:[],warning:'该样本的订单簿时间晚于回放时点。'}}:sample)}:undefined;
  return {data,balance,frame,heatmap};
}
export function footprintPage(length:number,offset:number,columns:number){
  const size=Math.max(0,Math.floor(length)),count=Math.max(1,Math.floor(columns));
  const safeOffset=Math.max(0,Math.min(Math.max(0,size-1),Number.isFinite(offset)?Math.floor(offset):0)),end=Math.max(0,size-safeOffset);
  return {offset:safeOffset,start:Math.max(0,end-count),end};
}

export type HistoryChannel='data'|'heatmap'|'frame'|'balance';
export interface HistoryTicket {channel:HistoryChannel;key:string;signal:AbortSignal}
/** Independent channels let a tab switch reuse an in-flight heatmap rather
 * than cancelling the very request required by the newly selected tab. */
export class HistoryQueryGate {
  private slots=new Map<HistoryChannel,{ticket:HistoryTicket;aborter:AbortController}>();
  begin(channel:HistoryChannel,key:string):HistoryTicket|undefined {
    const current=this.slots.get(channel);if(current?.ticket.key===key&&!current.ticket.signal.aborted)return;
    current?.aborter.abort();const aborter=new AbortController(),ticket={channel,key,signal:aborter.signal};this.slots.set(channel,{ticket,aborter});return ticket;
  }
  current(ticket:HistoryTicket){return this.slots.get(ticket.channel)?.ticket===ticket&&!ticket.signal.aborted;}
  finish(ticket:HistoryTicket){if(this.slots.get(ticket.channel)?.ticket===ticket)this.slots.delete(ticket.channel);}
  cancel(...channels:HistoryChannel[]){for(const channel of channels.length?channels:[...this.slots.keys()]){this.slots.get(channel)?.aborter.abort();this.slots.delete(channel);}}
}
