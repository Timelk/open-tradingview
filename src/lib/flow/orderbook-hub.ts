import {marketIdentity} from '../market/identity';
import {normalizePerpetualSymbol} from '../watchlist/symbols';
import {OrderBookSession,type BookAppliedUpdate,type BookLevel,type BookSnapshot,type OrderBookSessionOptions} from './orderbook';

export interface OrderBookIdentity {source:string;marketType?:string;symbol:string}
export interface BookHistorySample {
  /** Actual local observation time, never an interpolated historical timestamp. */
  time:number;eventTime:number;receivedAt:number;availableAt:number;revision:number;segmentId:number;
  bids:BookLevel[];asks:BookLevel[];
}
export type BookChangeBatch=Omit<BookAppliedUpdate,'baseline'>;
export interface SharedBookSnapshot extends BookSnapshot {
  identity:OrderBookIdentity;key:string;supported:boolean;capturedAt:number;
  history:BookHistorySample[];changes:BookChangeBatch[];
  historyCoverage:{fromTime:number|null;throughTime:number|null;samples:number;intervalMs:number;maxSamples:number;levelsPerSide:number};
  coverage:{fromTime:number|null;throughTime:number|null;receivedFromTime:number|null;receivedThroughTime:number|null;segmentId:number;depthPerSide:number};
  changeCoverage:{fromTime:number|null;throughTime:number|null;truncated:boolean};
}
export interface OrderBookHubOptions extends Omit<OrderBookSessionOptions,'symbol'|'limit'|'onUpdate'|'onApplied'|'horizonRatio'> {
  historySamples?:number;historyIntervalMs?:number;historyLevels?:number;
  /** Levels per side exposed by the shared book (REST seeds 1,000; the rest is learned from diffs). */
  bookLevels?:number;
  /** Keep only levels within ±this fraction of the mid, live and in history (0 = unbounded). */
  depthRangeRatio?:number;
  /** Keep a released book (and its sampled history) this long so a quick
   * re-acquire of the same market — e.g. switching chart interval — resumes it. */
  retainMs?:number;
  /** Store heatmap history pooled into fine price bins of this fraction of the
   * price decade (e.g. 1e-4 → BTC $1, ETH $0.1) over the full maintained depth,
   * instead of the nearest raw levels only. Heatmap buckets are integer
   * multiples of these bins, so re-bucketing never splits a bin. */
  historyBinRatio?:number;
  changeWindowMs?:number;maxChangeLevels?:number;
}
export interface AcquireOrderBookOptions extends OrderBookHubOptions {subscriber?:(snapshot:SharedBookSnapshot)=>void;active?:boolean}
export interface SharedOrderBookLease {
  readonly key:string;
  snapshot():SharedBookSnapshot;
  subscribe(listener:(snapshot:SharedBookSnapshot)=>void):()=>void;
  setActive(active:boolean):void;
  reconnect():Promise<void>;
  release():void;
}
const bounded=(n:number|undefined,fallback:number,min:number,max:number)=>Number.isFinite(n)?Math.max(min,Math.min(max,Math.round(n!))):fallback;
/** Sum raw levels into fixed price bins (bids floor, asks ceil), nearest first. */
export function poolLevels(levels:readonly BookLevel[],bin:number,side:'bid'|'ask'):BookLevel[] {
  const pooled=new Map<number,number>();
  for(const {price,quantity} of levels){
    if(!(price>0)||!(quantity>0))continue;
    const ratio=price/bin,epsilon=Number.EPSILON*Math.max(1,Math.abs(ratio))*8,index=side==='bid'?Math.floor(ratio+epsilon):Math.ceil(ratio-epsilon);
    pooled.set(index,(pooled.get(index)??0)+quantity);
  }
  return [...pooled].sort((a,b)=>side==='bid'?b[0]-a[0]:a[0]-b[0]).map(([index,quantity])=>({price:index*bin,quantity}));
}
const frozenLevels=(levels:readonly BookLevel[],limit=1000)=>Object.freeze(levels.slice(0,limit).map(level=>Object.freeze({...level}))) as unknown as BookLevel[];
const normalize=(identity:OrderBookIdentity):OrderBookIdentity=>({source:identity.source.toLowerCase(),marketType:identity.marketType,
  symbol:normalizePerpetualSymbol(identity.symbol)??identity.symbol.trim().toUpperCase()});

class Entry {
  readonly leases=new Set<Lease>();readonly key:string;readonly identity:OrderBookIdentity;
  private session?:OrderBookSession;private now:()=>number;private timer:ReturnType<typeof setTimeout>|undefined;
  private raw:BookSnapshot;private current!:SharedBookSnapshot;
  private history:BookHistorySample[]=[];private changes:BookChangeBatch[]=[];private retainedChanges=0;
  private historyLimit:number;private historyInterval:number;private historyLevels:number;private windowMs:number;private changeLimit:number;
  private baselineTime:number|null=null;private baselineEventTime:number|null=null;private through:number|null=null;
  private changeFromTime:number|null=null;
  private continuity=0;private waitingBaseline=true;private truncated=false;private lastSampleRevision=-1;
  private retainMs:number;private retireTimer:ReturnType<typeof setTimeout>|undefined;private historyBinRatio:number;
  private bookLevels:number;private rangeRatio:number;
  readonly supported:boolean;
  constructor(identity:OrderBookIdentity,options:OrderBookHubOptions,private retire:()=>void){
    this.identity=identity;this.key=marketIdentity(identity);this.now=options.now??(()=>Date.now());
    this.supported=identity.source==='binance'&&identity.marketType==='usdm-perpetual'&&!!normalizePerpetualSymbol(identity.symbol);
    this.historyLimit=bounded(options.historySamples,150,1,1000);this.historyInterval=bounded(options.historyIntervalMs,1000,100,60_000);
    this.historyLevels=bounded(options.historyLevels,80,1,1000);this.windowMs=bounded(options.changeWindowMs,30_000,30_000,300_000);
    this.changeLimit=bounded(options.maxChangeLevels,100_000,100,500_000);
    this.retainMs=Math.max(0,Math.min(600_000,Number(options.retainMs)||0));
    this.historyBinRatio=Math.max(0,Math.min(.01,Number(options.historyBinRatio)||0));
    this.bookLevels=bounded(options.bookLevels,1000,1,10_000);this.rangeRatio=Math.max(0,Math.min(.5,Number(options.depthRangeRatio)||0));
    this.raw={symbol:identity.symbol,status:this.supported?'idle':'unsupported',bids:[],asks:[],updatedAt:0,lastUpdateId:null,revision:0,segmentId:0,lastReceivedAt:0,
      ...(!this.supported?{warning:'当前盘口仅支持 Binance USDⓈ-M 永续公开深度。'}:{})};
    this.refresh();
    if(this.supported)this.session=new OrderBookSession({...options,symbol:identity.symbol,limit:this.bookLevels,horizonRatio:this.rangeRatio,
      onApplied:update=>this.accept(update),onUpdate:snapshot=>this.receive(snapshot)});
  }
  snapshot(){this.prune();if(this.current.capturedAt!==this.now())this.refresh();return this.current;}
  add(lease:Lease){clearTimeout(this.retireTimer);this.retireTimer=undefined;this.leases.add(lease);this.sync();}
  remove(lease:Lease){
    this.leases.delete(lease);if(this.leases.size){this.sync();return;}
    clearTimeout(this.timer);this.timer=undefined;this.session?.disconnect();
    // Disconnected during the grace period: the next connect starts a new
    // continuity segment, so the gap is never drawn as continuous depth.
    if(this.retainMs>0){clearTimeout(this.retireTimer);this.retireTimer=setTimeout(()=>{this.retireTimer=undefined;if(!this.leases.size)this.retire();},this.retainMs);}
    else this.retire();
  }
  sync(){
    if(!this.session)return;
    if([...this.leases].some(lease=>lease.active)){
      void this.session.connect();if(!this.timer)this.tick();
    }else{clearTimeout(this.timer);this.timer=undefined;this.session.disconnect();}
  }
  reconnect(){return this.session&&[...this.leases].some(lease=>lease.active)?this.session.reconnect():Promise.resolve();}
  private historyLevelsOf(snapshot:BookSnapshot):{bids:BookLevel[];asks:BookLevel[]} {
    if(!this.historyBinRatio)return {bids:frozenLevels(snapshot.bids,this.historyLevels),asks:frozenLevels(snapshot.asks,this.historyLevels)};
    const best=snapshot.bids[0]?.price??snapshot.asks[0]?.price;
    if(!(best&&best>0))return {bids:frozenLevels([],0),asks:frozenLevels([],0)};
    const bin=10**Math.floor(Math.log10(best))*this.historyBinRatio;
    return {bids:frozenLevels(poolLevels(snapshot.bids,bin,'bid'),this.historyLevels),asks:frozenLevels(poolLevels(snapshot.asks,bin,'ask'),this.historyLevels)};
  }
  private tick(){
    this.timer=setTimeout(()=>{this.timer=undefined;if(![...this.leases].some(lease=>lease.active))return;this.prune();this.refresh();this.publish();this.tick();},1000);
  }
  private interrupt(){
    this.waitingBaseline=true;this.changes=[];this.retainedChanges=0;this.baselineTime=null;this.baselineEventTime=null;this.through=null;this.changeFromTime=null;this.truncated=false;
  }
  private accept(update:BookAppliedUpdate){
    if(update.baseline||this.waitingBaseline){
      this.interrupt();this.waitingBaseline=false;this.continuity++;
      this.baselineTime=update.receivedAt;this.baselineEventTime=update.eventTime;this.changeFromTime=update.receivedAt;
    }else if(update.levels.length){
      const levels=Object.freeze(update.levels.map(level=>Object.freeze({...level}))) as unknown as BookAppliedUpdate['levels'];
      this.changes.push(Object.freeze({...update,segmentId:this.continuity,levels}));this.retainedChanges+=levels.length;
    }
    this.through=update.receivedAt;this.prune();
  }
  private prune(){
    const cutoff=this.now()-this.windowMs;
    while(this.changes.length&&(this.changes[0].receivedAt<cutoff||this.retainedChanges>this.changeLimit)){
      const first=this.changes.shift()!;this.retainedChanges-=first.levels.length;
      if(first.receivedAt>=cutoff){this.truncated=true;this.changeFromTime=Math.max(this.changeFromTime??first.receivedAt,first.receivedAt+1);}
    }
  }
  /** Nearest-first rows cut at ±range of the mid; a book with no two-sided mid is left as is. */
  private withinRange(snapshot:BookSnapshot):BookSnapshot {
    if(!this.rangeRatio||!snapshot.bids.length||!snapshot.asks.length)return snapshot;
    const mid=(snapshot.bids[0].price+snapshot.asks[0].price)/2,low=mid*(1-this.rangeRatio),high=mid*(1+this.rangeRatio);
    const bids=snapshot.bids.filter(level=>level.price>=low),asks=snapshot.asks.filter(level=>level.price<=high);
    return bids.length===snapshot.bids.length&&asks.length===snapshot.asks.length?snapshot:{...snapshot,bids,asks};
  }
  private receive(incoming:BookSnapshot){
    const snapshot=this.withinRange(incoming);
    const wasLive=this.raw.status==='live';this.raw=snapshot;
    if(snapshot.status!=='live'&&(wasLive||!this.waitingBaseline))this.interrupt();
    if(snapshot.status==='live'&&snapshot.revision!==this.lastSampleRevision){
      this.lastSampleRevision=snapshot.revision;
      const sample:BookHistorySample=Object.freeze({time:snapshot.lastReceivedAt,eventTime:snapshot.updatedAt,receivedAt:snapshot.lastReceivedAt,availableAt:snapshot.lastReceivedAt,
        revision:snapshot.revision,segmentId:this.continuity,...this.historyLevelsOf(snapshot)});
      const last=this.history.at(-1);
      // Coalesce only real updates within one local-time sampling bucket. A new
      // continuity segment always starts a distinct sample, even in that bucket.
      if(last&&last.segmentId===sample.segmentId&&Math.floor(last.time/this.historyInterval)===Math.floor(sample.time/this.historyInterval))this.history[this.history.length-1]=sample;
      else this.history.push(sample);
      if(this.history.length>this.historyLimit)this.history.splice(0,this.history.length-this.historyLimit);
    }
    this.refresh();this.publish();
  }
  private refresh(){
    this.current=Object.freeze({...this.raw,segmentId:this.continuity,bids:frozenLevels(this.raw.bids,this.bookLevels),asks:frozenLevels(this.raw.asks,this.bookLevels),identity:Object.freeze({...this.identity}),key:this.key,supported:this.supported,capturedAt:this.now(),
      history:Object.freeze([...this.history]) as unknown as BookHistorySample[],changes:Object.freeze([...this.changes]) as unknown as BookChangeBatch[],
      historyCoverage:Object.freeze({fromTime:this.history[0]?.time??null,throughTime:this.history.at(-1)?.time??null,samples:this.history.length,intervalMs:this.historyInterval,maxSamples:this.historyLimit,levelsPerSide:this.historyLevels}),
      coverage:Object.freeze({fromTime:this.baselineEventTime,throughTime:this.raw.status==='live'?this.raw.updatedAt:null,receivedFromTime:this.baselineTime,receivedThroughTime:this.through,segmentId:this.continuity,depthPerSide:this.bookLevels}),
      changeCoverage:Object.freeze({fromTime:this.changeFromTime,throughTime:this.through,truncated:this.truncated})});
  }
  private publish(){for(const lease of this.leases)lease.publish();}
}
class Lease implements SharedOrderBookLease {
  readonly key:string;active:boolean;private closed=false;private listeners=new Set<(snapshot:SharedBookSnapshot)=>void>();
  constructor(private entry:Entry,active:boolean){this.key=entry.key;this.active=active;}
  snapshot():SharedBookSnapshot {
    const snapshot=this.entry.snapshot();
    return this.active&&!this.closed?snapshot:Object.freeze({...snapshot,status:'paused',bids:[],asks:[],warning:'当前视图已暂停盘口订阅。'});
  }
  subscribe(listener:(snapshot:SharedBookSnapshot)=>void){if(this.closed)return ()=>{};this.listeners.add(listener);this.deliver(listener);return()=>this.listeners.delete(listener);}
  setActive(active:boolean){if(this.closed||this.active===active)return;this.active=active;this.entry.sync();this.publish();}
  reconnect(){return this.closed?Promise.resolve():this.entry.reconnect();}
  release(){if(this.closed)return;this.closed=true;this.listeners.clear();this.entry.remove(this);}
  publish(){for(const listener of this.listeners)this.deliver(listener);}
  private deliver(listener:(snapshot:SharedBookSnapshot)=>void){try{listener(this.snapshot());}catch{/* One view cannot break another subscriber. */}}
}
export class OrderBookHub {
  private entries=new Map<string,Entry>();
  constructor(private defaults:OrderBookHubOptions={}){}
  get size(){return this.entries.size;}
  acquire(identity:OrderBookIdentity,options:AcquireOrderBookOptions={}):SharedOrderBookLease {
    const normalized=normalize(identity),key=marketIdentity(normalized);let entry=this.entries.get(key);
    if(!entry){entry=new Entry(normalized,{...this.defaults,...options},()=>this.entries.delete(key));this.entries.set(key,entry);}
    const lease=new Lease(entry,options.active!==false);entry.add(lease);if(options.subscriber)lease.subscribe(options.subscriber);return lease;
  }
}
export function createOrderBookHub(options:OrderBookHubOptions={}):OrderBookHub{return new OrderBookHub(options);}
const sharedOrderBooks=new OrderBookHub({retainMs:60_000});
/** Source identity excludes chart interval: every view sees the same live book. */
export function acquireOrderBook(identity:OrderBookIdentity,options:AcquireOrderBookOptions={}):SharedOrderBookLease{return sharedOrderBooks.acquire(identity,options);}
