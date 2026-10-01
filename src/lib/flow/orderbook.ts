import {normalizePerpetualSymbol} from '../watchlist/symbols';
import {publicMarketRequest,publicMarketSocketUrl} from '../market/public-transport';

export interface BookLevel {price:number;quantity:number}
export type BookStatus='idle'|'connecting'|'live'|'resyncing'|'stale'|'paused'|'error'|'unsupported';
export interface BookSnapshot {
  symbol:string;status:BookStatus;bids:BookLevel[];asks:BookLevel[];
  updatedAt:number;lastUpdateId:number|null;warning?:string;
  /** Monotone accepted-source revision; status changes do not invent updates. */
  revision:number;segmentId:number;lastReceivedAt:number;
}
export interface BookDepthSnapshot {lastUpdateId:number;bids:BookLevel[];asks:BookLevel[]}
export interface BookDepthEvent {firstUpdateId:number;lastUpdateId:number;previousUpdateId:number;time:number;bids:BookLevel[];asks:BookLevel[];receivedAt?:number}
export interface OrderBookSocket {
  onopen:((event:Event)=>void)|null;onmessage:((event:MessageEvent)=>void)|null;
  onclose:((event:CloseEvent)=>void)|null;onerror:((event:Event)=>void)|null;close():void;
}
export interface OrderBookSessionOptions {
  symbol:string;
  /** Number of sorted levels exposed on each side. The REST bootstrap seeds 1,000; levels beyond it
   * are learned from the diff stream, so a larger limit widens the book as it warms up. */
  limit?:number;
  /** Learn only levels within ±this fraction of the mid (see {@link Level2Book.horizon}); 0 = off. */
  horizonRatio?:number;
  onUpdate?:(snapshot:BookSnapshot)=>void;
  fetch?:typeof fetch;
  WebSocket?:new(url:string)=>OrderBookSocket;
  restBase?:string;wsBase?:string;
  now?:()=>number;staleAfterMs?:number;
  /** Accepted source updates only; the first bridge establishes a baseline. */
  onApplied?:(update:BookAppliedUpdate)=>void;
  /** Optional durable recorder; receives actual source events, never UI rows. */
  onRecord?:(event:BookRecordingEvent)=>void;
}
export interface BookLevelChange {side:'bid'|'ask';price:number;addedBase:number;removedBase:number;addedQuote:number;removedQuote:number}
export interface BookAppliedUpdate {revision:number;segmentId:number;eventTime:number;receivedAt:number;baseline:boolean;levels:BookLevelChange[]}
export type BookRecordingEvent=
  |{kind:'depth-snapshot';receivedAt:number;time:number;lastUpdateId:number;bids:BookLevel[];asks:BookLevel[];origin:'rest'}
  |{kind:'depth-diff';receivedAt:number;time:number;U:number;u:number;pu:number;bids:BookLevel[];asks:BookLevel[]}
  |{kind:'gap';receivedAt:number;time:number;reason:string;channel:'depth'};
export const ORDER_BOOK_LIMITATIONS='仅当前公开 L2 聚合价位；不含普通深度流未公开的 RPI 挂单，不是逐订单 MBO 或历史流动性热图。';
export const MAX_BOOK_BUFFER_EVENTS=2000;
const MAX_BUFFER_LEVELS=50_000,MAX_BOOK_LEVELS=10_000,MAX_RETRIES=6;
/** With a price horizon the book prunes far levels above this many per side instead of resetting. */
const HORIZON_PRUNE_AT=MAX_BOOK_LEVELS*.8;
const REST='https://fapi.binance.com';
const STREAM='wss://fstream.binance.com/public/ws';
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const finite=(value:unknown)=>typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;
const id=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function levels(raw:unknown):BookLevel[] {
  if(!Array.isArray(raw)||raw.length>MAX_BOOK_LEVELS)throw Error('深度价位格式无效');
  return raw.map(row=>{
    if(!Array.isArray(row)||row.length!==2)throw Error('深度价位格式无效');
    const price=finite(row[0]),quantity=finite(row[1]);
    if(!Number.isFinite(price)||price<=0||!Number.isFinite(quantity)||quantity<0||!Number.isFinite(price*quantity))throw Error('深度价格或数量无效');
    return {price,quantity};
  });
}
function parseSnapshot(raw:unknown):BookDepthSnapshot {
  if(!object(raw)||!id(raw.lastUpdateId))throw Error('深度快照序号无效');
  return {lastUpdateId:raw.lastUpdateId as number,bids:levels(raw.bids),asks:levels(raw.asks)};
}
function parseEvent(raw:unknown):BookDepthEvent {
  if(!object(raw)||!id(raw.U)||!id(raw.u)||!id(raw.pu)||Number(raw.U)>Number(raw.u))throw Error('深度增量序号无效');
  const time=finite(raw.T??raw.E);
  if(!Number.isFinite(time)||time<0)throw Error('深度事件时间无效');
  return {firstUpdateId:raw.U as number,lastUpdateId:raw.u as number,previousUpdateId:raw.pu as number,time,bids:levels(raw.b),asks:levels(raw.a)};
}

/** Pure price-level book. The first accepted update bridges the REST watermark;
 * subsequent updates must continue its pu/u chain. No intrabar order identities
 * or historical queue positions are inferred from these aggregated quantities. */
export class Level2Book {
  /**
   * Optional learning horizon as a fraction of the mid price (0 = off). REST seeds the nearest
   * 1,000 levels; deeper levels are learned from the diff stream. A horizon ignores updates
   * beyond ±horizon of the mid (dust orders at $1 or 10× price) so the book stays bounded and
   * never trips the level cap. Levels that drift outside after a large move are pruned, farthest
   * first, only when the book grows large.
   */
  horizon=0;
  private bids=new Map<number,number>();private asks=new Map<number,number>();
  private knownBids=new Set<number>();private knownAsks=new Set<number>();private bidFloor=Infinity;private askCeiling=-Infinity;
  private cursor:number|null=null;private bridged=false;private time=0;
  get lastUpdateId(){return this.cursor;}get ready(){return this.bridged;}get updatedAt(){return this.time;}
  clear():void {this.bids.clear();this.asks.clear();this.knownBids.clear();this.knownAsks.clear();this.bidFloor=Infinity;this.askCeiling=-Infinity;this.cursor=null;this.bridged=false;this.time=0;}
  load(snapshot:BookDepthSnapshot):void {
    this.clear();this.cursor=snapshot.lastUpdateId;
    this.bidFloor=Math.min(Infinity,...snapshot.bids.filter(level=>level.quantity>0).map(level=>level.price));
    this.askCeiling=Math.max(-Infinity,...snapshot.asks.filter(level=>level.quantity>0).map(level=>level.price));
    this.replace(this.bids,snapshot.bids,this.knownBids);this.replace(this.asks,snapshot.asks,this.knownAsks);
  }
  apply(event:BookDepthEvent):'applied'|'stale'|'gap' {
    if(this.cursor===null)return 'gap';
    if(this.bridged?event.lastUpdateId<=this.cursor:event.lastUpdateId<this.cursor)return 'stale';
    if(this.bridged?event.previousUpdateId!==this.cursor:event.firstUpdateId>this.cursor)return 'gap';
    const bounds=this.horizonBounds();
    this.replace(this.bids,event.bids,this.knownBids,bounds);this.replace(this.asks,event.asks,this.knownAsks,bounds);
    this.cursor=event.lastUpdateId;this.time=event.time;this.bridged=true;
    if(bounds&&(this.bids.size>HORIZON_PRUNE_AT||this.asks.size>HORIZON_PRUNE_AT))this.prune();
    // Never silently truncate a supposedly complete retained price level. A new
    // exchange snapshot is safer than carrying an unbounded or pruned book.
    if(this.bids.size>MAX_BOOK_LEVELS||this.asks.size>MAX_BOOK_LEVELS||this.knownBids.size>MAX_BOOK_LEVELS*2||this.knownAsks.size>MAX_BOOK_LEVELS*2){this.clear();return 'gap';}
    return 'applied';
  }
  levels(limit=50):{bids:BookLevel[];asks:BookLevel[]} {
    const rows=(book:Map<number,number>,direction:number)=>[...book].sort(([a],[b])=>direction*(a-b)).slice(0,limit).map(([price,quantity])=>({price,quantity}));
    return {bids:rows(this.bids,-1),asks:rows(this.asks,1)};
  }
  changes(event:BookDepthEvent):BookLevelChange[] {
    const output:BookLevelChange[]=[];
    for(const [side,book,updates] of [['bid',this.bids,event.bids],['ask',this.asks,event.asks]] as const){
      // Diff quantities are absolute. Repeated prices in one event retain the
      // final source quantity rather than counting synthetic intermediate steps.
      for(const [price,quantity] of new Map(updates.map(level=>[level.price,level.quantity]))){
        // A depth-limited REST snapshot cannot establish old size beyond its
        // outermost known level. First observation there establishes that
        // price's baseline; it must not appear as a newly added order.
        const known=side==='bid'?this.knownBids.has(price)||price>=this.bidFloor:this.knownAsks.has(price)||price<=this.askCeiling;
        if(!known)continue;
        const delta=quantity-(book.get(price)??0);if(!delta)continue;
        const addedBase=Math.max(0,delta),removedBase=Math.max(0,-delta);
        output.push({side,price,addedBase,removedBase,addedQuote:price*addedBase,removedQuote:price*removedBase});
      }
    }
    return output;
  }
  private replace(book:Map<number,number>,updates:readonly BookLevel[],known:Set<number>,bounds?:{low:number;high:number}){
    for(const {price,quantity} of updates){
      if(quantity===0){known.add(price);book.delete(price);continue;}
      // Outside the horizon a level is simply not learned; it is never claimed as known.
      if(bounds&&(price<bounds.low||price>bounds.high))continue;
      known.add(price);book.set(price,quantity);
    }
  }
  /** ±horizon around the current mid, or undefined when the horizon is off or there is no mid yet. */
  private horizonBounds():{low:number;high:number}|undefined {
    if(!(this.horizon>0)||!this.bids.size||!this.asks.size)return;
    let bid=-Infinity,ask=Infinity;for(const price of this.bids.keys())if(price>bid)bid=price;for(const price of this.asks.keys())if(price<ask)ask=price;
    const mid=(bid+ask)/2;return {low:mid*(1-this.horizon),high:mid*(1+this.horizon)};
  }
  private prune(){
    const bounds=this.horizonBounds();if(!bounds)return;
    for(const [book,known] of [[this.bids,this.knownBids],[this.asks,this.knownAsks]] as const){
      for(const price of [...book.keys()])if(price<bounds.low||price>bounds.high){book.delete(price);known.delete(price);}
    }
  }
}

/** Public, opt-in current L2 session. Snapshots and every diff are validated
 * before publication; a disconnected or gapped book is never marked live. */
export class OrderBookSession {
  readonly symbol:string;
  private limit:number;private request:typeof fetch;private Socket:new(url:string)=>OrderBookSocket;
  private listeners=new Set<(snapshot:BookSnapshot)=>void>();private book=new Level2Book();
  private state:BookStatus='idle';private warning:string|undefined;private running=false;
  private epoch=0;private syncEpoch=0;private failures=0;private socket:OrderBookSocket|null=null;
  private buffer:BookDepthEvent[]=[];private bufferedLevels=0;private hasSnapshot=false;
  private snapshotAbort:AbortController|null=null;
  private retryTimer:ReturnType<typeof setTimeout>|undefined;private connectTimer:ReturnType<typeof setTimeout>|undefined;
  private snapshotTimer:ReturnType<typeof setTimeout>|undefined;
  private onRecord:OrderBookSessionOptions['onRecord'];
  private onApplied:OrderBookSessionOptions['onApplied'];
  private now:()=>number;private staleAfterMs:number;private freshnessTimer:ReturnType<typeof setTimeout>|undefined;
  private revision=0;private segmentId=0;private lastReceivedAt=0;
  private restBase:string;private wsBase:string;
  constructor(options:OrderBookSessionOptions){
    const symbol=normalizePerpetualSymbol(options.symbol);if(!symbol)throw Error('请选择有效的 USDT 永续合约');
    if(Number.isFinite(options.horizonRatio))this.book.horizon=Math.max(0,Math.min(.5,options.horizonRatio!));
    this.symbol=symbol;this.limit=Number.isFinite(options.limit)?Math.max(1,Math.min(MAX_BOOK_LEVELS,Math.round(options.limit!))):50;
    this.request=options.fetch??publicMarketRequest;
    this.Socket=options.WebSocket??globalThis.WebSocket;
    this.onRecord=options.onRecord;this.onApplied=options.onApplied;this.now=options.now??(()=>Date.now());
    this.staleAfterMs=Number.isFinite(options.staleAfterMs)?Math.max(250,Math.min(60_000,options.staleAfterMs!)):5000;
    this.restBase=(options.restBase??REST).replace(/\/+$/,'');this.wsBase=(options.wsBase??STREAM).replace(/\/+$/,'');
    if(options.onUpdate)this.listeners.add(options.onUpdate);
  }
  connect():Promise<void> {
    if(!this.running){this.running=true;this.failures=0;this.open();this.watchFreshness();}
    return Promise.resolve();
  }
  reconnect():Promise<void> {this.running=true;this.failures=0;this.open();this.watchFreshness();return Promise.resolve();}
  disconnect():void {
    this.running=false;this.epoch++;this.cancelRecovery();this.closeSocket();
    clearTimeout(this.freshnessTimer);this.freshnessTimer=undefined;
    this.clearBook();this.status('idle');
  }
  subscribe(listener:(snapshot:BookSnapshot)=>void):()=>void {
    this.listeners.add(listener);this.deliver(listener);return()=>this.listeners.delete(listener);
  }
  snapshot():BookSnapshot {
    const live=this.state==='live'&&this.book.ready;
    return {symbol:this.symbol,status:this.state,...(live?this.book.levels(this.limit):{bids:[],asks:[]}),
      updatedAt:live?this.book.updatedAt:0,lastUpdateId:live?this.book.lastUpdateId:null,revision:this.revision,segmentId:this.segmentId,lastReceivedAt:this.lastReceivedAt,...(this.warning?{warning:this.warning}:{})};
  }
  private watchFreshness(){
    clearTimeout(this.freshnessTimer);
    if(!this.running)return;
    this.freshnessTimer=setTimeout(()=>{
      this.freshnessTimer=undefined;
      if(this.running&&this.book.ready&&this.state==='live'&&this.now()-this.lastReceivedAt>=this.staleAfterMs)
        this.status('stale','公开深度长时间未更新，当前盘口已过期。可手动重连。');
      this.watchFreshness();
    },Math.min(1000,this.staleAfterMs));
  }
  private status(state:BookStatus,warning?:string){this.state=state;this.warning=warning;this.publish();}
  private publish(){for(const listener of this.listeners)this.deliver(listener);}
  private deliver(listener:(snapshot:BookSnapshot)=>void){try{listener(this.snapshot());}catch{/* A consumer cannot interrupt sequence validation. */}}
  private clearBook(){this.book.clear();this.segmentId++;this.hasSnapshot=false;this.buffer=[];this.bufferedLevels=0;}
  private cancelSnapshot(){this.syncEpoch++;this.snapshotAbort?.abort();this.snapshotAbort=null;clearTimeout(this.snapshotTimer);this.snapshotTimer=undefined;}
  private cancelRecovery(){this.cancelSnapshot();clearTimeout(this.retryTimer);this.retryTimer=undefined;}
  private closeSocket(){
    clearTimeout(this.connectTimer);this.connectTimer=undefined;
    if(this.socket){const socket=this.socket;this.socket=null;socket.onopen=socket.onmessage=socket.onclose=socket.onerror=null;try{socket.close();}catch{/* Already closed. */}}
  }
  private open(){
    if(!this.running)return;
    const epoch=++this.epoch;this.cancelRecovery();this.closeSocket();this.clearBook();
    this.status(this.failures?'resyncing':'connecting',this.failures?'公开深度重连中，等待重新校验快照与增量。':undefined);
    let socket:OrderBookSocket;
    try{socket=new this.Socket(publicMarketSocketUrl(`${this.wsBase}/${this.symbol.toLowerCase()}@depth@100ms`));this.socket=socket;}
    catch{this.connectionFailed(epoch,'无法建立公开深度连接');return;}
    const current=()=>this.running&&this.epoch===epoch&&this.socket===socket;
    this.connectTimer=setTimeout(()=>this.connectionFailed(epoch,'公开深度连接超时'),10_000);
    socket.onopen=()=>{if(!current())return;clearTimeout(this.connectTimer);this.connectTimer=undefined;void this.bootstrap(epoch);};
    socket.onmessage=message=>{
      if(!current())return;
      let raw:unknown;
      try{raw=JSON.parse(String(message.data));}catch{this.resync(epoch,'深度消息无法解析，重新建立一致快照。');return;}
      // Ignore unrelated combined/control messages; symbol type 2 is COIN-M.
      if(!object(raw)||raw.e!=='depthUpdate'||raw.s!==this.symbol||raw.st!==undefined&&raw.st!==1)return;
      let event:BookDepthEvent;
      try{event=parseEvent(raw);}catch{this.resync(epoch,'深度增量格式无效，重新校验。');return;}
      event.receivedAt=this.now();
      if(this.buffer.length>=MAX_BOOK_BUFFER_EVENTS||this.bufferedLevels+event.bids.length+event.asks.length>MAX_BUFFER_LEVELS){
        this.resync(epoch,'深度缓冲已满，旧快照已丢弃并重新同步。');return;
      }
      this.buffer.push(event);this.bufferedLevels+=event.bids.length+event.asks.length;
      if(this.hasSnapshot)this.drain(epoch);
    };
    socket.onclose=()=>this.connectionFailed(epoch,'公开深度连接中断');
    socket.onerror=()=>this.connectionFailed(epoch,'公开深度连接异常');
  }
  private async bootstrap(epoch:number){
    if(!this.running||epoch!==this.epoch||!this.socket)return;
    this.cancelSnapshot();const syncEpoch=this.syncEpoch,aborter=new AbortController();this.snapshotAbort=aborter;
    this.snapshotTimer=setTimeout(()=>aborter.abort(),10_000);
    try{
      const response=await this.request(`${this.restBase}/fapi/v1/depth?${new URLSearchParams({symbol:this.symbol,limit:'1000'})}`,{signal:aborter.signal,credentials:'omit',redirect:'error',cache:'no-store'});
      if(!response.ok)throw Error(response.status===429||response.status===418?'深度快照请求限流':`深度快照 HTTP ${response.status}`);
      const raw=await response.json(),snapshot=parseSnapshot(raw);
      if(!this.running||epoch!==this.epoch||syncEpoch!==this.syncEpoch||aborter.signal.aborted)return;
      clearTimeout(this.snapshotTimer);this.snapshotTimer=undefined;this.snapshotAbort=null;
      this.record({kind:'depth-snapshot',...snapshot,receivedAt:this.now(),time:object(raw)&&Number.isFinite(Number(raw.T??raw.E))?Number(raw.T??raw.E):this.now(),origin:'rest'});
      this.book.load(snapshot);this.hasSnapshot=true;this.drain(epoch);
      if(!this.book.ready&&this.running&&epoch===this.epoch)
        this.snapshotTimer=setTimeout(()=>this.resync(epoch,'深度快照等待连续增量超时，重新同步。'),10_000);
    }catch(error){
      if(!this.running||epoch!==this.epoch||syncEpoch!==this.syncEpoch)return;
      this.resync(epoch,error instanceof Error?`${error.message}；正在重新同步。`:'公开深度快照不可用；正在重新同步。');
    }
  }
  private drain(epoch:number){
    let applied=false;
    for(const event of this.buffer){
      const baseline=!this.book.ready,changes=baseline?[]:this.book.changes(event);
      const outcome=this.book.apply(event);
      if(outcome==='gap'){this.resync(epoch,'深度序列出现缺口，旧订单簿已清除并重新同步。',event);return;}
      if(outcome==='applied'){
        this.revision++;this.lastReceivedAt=event.receivedAt??this.now();
        clearTimeout(this.snapshotTimer);this.snapshotTimer=undefined;
        this.record({kind:'depth-diff',receivedAt:this.lastReceivedAt,time:event.time,U:event.firstUpdateId,u:event.lastUpdateId,pu:event.previousUpdateId,bids:event.bids,asks:event.asks});
        try{this.onApplied?.({revision:this.revision,segmentId:this.segmentId,eventTime:event.time,receivedAt:this.lastReceivedAt,baseline,levels:changes});}catch{/* Consumers do not control sequence integrity. */}
      }
      applied ||= outcome==='applied';
    }
    this.buffer=[];this.bufferedLevels=0;
    if(applied){this.failures=0;
      const stale=this.now()-this.lastReceivedAt>=this.staleAfterMs;
      this.status(stale?'stale':'live',stale?'公开深度长时间未更新，当前盘口已过期。可手动重连。':undefined);
    }
  }
  private resync(epoch:number,warning:string,event?:BookDepthEvent){
    if(!this.running||epoch!==this.epoch)return;
    this.cancelSnapshot();this.clearBook();
    this.record({kind:'gap',receivedAt:this.now(),time:this.now(),reason:warning,channel:'depth'});
    if(event){this.buffer=[event];this.bufferedLevels=event.bids.length+event.asks.length;}
    this.status('resyncing',warning);
    this.retry(epoch,()=>{void this.bootstrap(epoch);},warning);
  }
  private connectionFailed(epoch:number,warning:string){
    if(!this.running||epoch!==this.epoch)return;
    const next=++this.epoch;this.cancelRecovery();this.closeSocket();this.clearBook();this.status('resyncing',`${warning}，旧订单簿不可用。`);
    this.record({kind:'gap',receivedAt:this.now(),time:this.now(),reason:warning,channel:'depth'});
    this.retry(next,()=>this.open(),warning);
  }
  private retry(epoch:number,action:()=>void,warning:string){
    if(this.retryTimer)return;
    this.failures++;
    if(this.failures>MAX_RETRIES){this.running=false;this.cancelRecovery();this.closeSocket();this.clearBook();this.status('error',`${warning}；多次恢复失败，请手动重连。`);return;}
    const delay=Math.min(30_000,500*2**(this.failures-1));
    this.retryTimer=setTimeout(()=>{this.retryTimer=undefined;if(this.running&&epoch===this.epoch)action();},delay);
  }
  private record(event:BookRecordingEvent){try{this.onRecord?.(event);}catch{/* Recorder failures cannot fabricate an in-sync book. */}}
}

export function createOrderBookSession(options:OrderBookSessionOptions):OrderBookSession{return new OrderBookSession(options);}
