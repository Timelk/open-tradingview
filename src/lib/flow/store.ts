import type {AggregateTrade,FlowAggregation,FlowAmounts,FlowCoverage,FlowGap,FlowPriceLevel,FlowStoreOptions,TradeFlowSnapshot} from './types';

const amounts=():FlowAmounts=>({buyBase:0,sellBase:0,deltaBase:0,volumeBase:0,buyQuote:0,sellQuote:0,deltaQuote:0,volumeQuote:0,aggregateCount:0});
const bounded=(value:number|undefined,fallback:number,min:number,max:number)=>Math.max(min,Math.min(max,Math.floor(Number.isFinite(value)?value!:fallback)));
function accumulate(target:FlowAmounts,trade:AggregateTrade,sign=1){
  const base=trade.baseQuantity*sign,quote=trade.quoteQuantity*sign;
  if(trade.aggressor==='buy'){target.buyBase+=base;target.buyQuote+=quote;}else{target.sellBase+=base;target.sellQuote+=quote;}
  target.volumeBase=target.buyBase+target.sellBase;target.volumeQuote=target.buyQuote+target.sellQuote;
  target.deltaBase=target.buyBase-target.sellBase;target.deltaQuote=target.buyQuote-target.sellQuote;target.aggregateCount+=sign;
}
export function validateFlowAggregation(input:FlowAggregation):FlowAggregation {
  if(!Number.isFinite(input.tickSize)||input.tickSize<=0||!Number.isSafeInteger(input.timeframeMs)||input.timeframeMs<1000)throw Error('成交聚合需要有效最小价格跳动与至少 1 秒的固定周期');
  return {tickSize:input.tickSize,timeframeMs:input.timeframeMs,priceStepTicks:bounded(input.priceStepTicks,1,1,1_000_000),sessionOffsetMs:Number.isFinite(input.sessionOffsetMs)?Math.trunc(input.sessionOffsetMs!):0};
}
interface StoredTrade extends AggregateTrade {sortId:bigint}
interface PriceNode {id:bigint;tick:number}
interface PriceDeque {nodes:PriceNode[];head:number}
interface TimeBucket {levels:Map<number,FlowPriceLevel>;totals:FlowAmounts}
/** One symbol, public aggregated fills only. Ordered appends and evictions
 * update just two cells, one time bucket and adjacent ID edges. A head cursor
 * avoids shifting the retained tape; occasional compaction is amortized O(1).
 * Raw retention permits bounded repair/regrouping. Coarsening conserves volume. */
export class TradeFlowStore {
  readonly symbol:string;
  private config:FlowAggregation;private records:StoredTrade[]=[];private head=0;private byId=new Map<string,StoredTrade>();
  private profile=new Map<number,FlowPriceLevel>();private bars=new Map<number,TimeBucket>();private barTimes:number[]=[];private barHead=0;private total=amounts();
  private low:PriceDeque={nodes:[],head:0};private high:PriceDeque={nodes:[],head:0};
  private missing=new Map<string,FlowGap>();private gapCache:FlowGap[]|undefined;
  private normalCount=0;private normalBase=0;private activeConflicts=new Map<string,number>();
  private stepTicks=1;private revision=0;private evicted=0;private rejected=0;private conflicting=0;private discardedThrough:bigint|undefined;
  readonly maxTrades:number;readonly maxAgeMs:number;readonly maxPriceLevels:number;readonly maxFootprintBars:number;
  constructor(options:FlowStoreOptions){
    this.symbol=options.symbol;if(!/^[\p{L}\p{N}]+USDT$/u.test(this.symbol))throw Error('成交分析仅支持 USDT 本位合约');
    this.config=validateFlowAggregation(options);this.stepTicks=this.config.priceStepTicks!;
    this.maxTrades=bounded(options.maxTrades,20_000,100,100_000);this.maxAgeMs=bounded(options.maxAgeMs,3_600_000,60_000,172_800_000);
    this.maxPriceLevels=bounded(options.maxPriceLevels,512,8,2048);this.maxFootprintBars=bounded(options.maxFootprintBars,120,1,500);
  }
  get lastId(){return this.size?this.records.at(-1)?.id:undefined;}
  get size(){return this.records.length-this.head;}
  private tick(price:number){const tick=Math.round(price/this.config.tickSize);return Number.isSafeInteger(tick)?tick:NaN;}
  private level(tick:number):FlowPriceLevel {const price=tick*this.config.tickSize;return {...amounts(),tick,price,priceEnd:(tick+this.stepTicks)*this.config.tickSize};}
  private barIndex(time:number){let lo=this.barHead,hi=this.barTimes.length;while(lo<hi){const mid=(lo+hi)>>>1;if(this.barTimes[mid]<time)lo=mid+1;else hi=mid;}return lo;}
  private apply(trade:AggregateTrade,sign=1){
    const tick=Math.floor(this.tick(trade.price)/this.stepTicks)*this.stepTicks;
    const offset=this.config.sessionOffsetMs!,time=Math.floor((trade.time-offset)/this.config.timeframeMs)*this.config.timeframeMs+offset;
    let profile=this.profile.get(tick);if(!profile){profile=this.level(tick);this.profile.set(tick,profile);}accumulate(profile,trade,sign);if(!profile.aggregateCount)this.profile.delete(tick);
    let bucket=this.bars.get(time);
    if(!bucket){
      bucket={levels:new Map(),totals:amounts()};this.bars.set(time,bucket);
      if(this.barHead===this.barTimes.length||time>this.barTimes.at(-1)!)this.barTimes.push(time);else this.barTimes.splice(this.barIndex(time),0,time);
    }
    let cell=bucket.levels.get(tick);if(!cell){cell=this.level(tick);bucket.levels.set(tick,cell);}accumulate(cell,trade,sign);if(!cell.aggregateCount)bucket.levels.delete(tick);
    accumulate(bucket.totals,trade,sign);
    if(!bucket.totals.aggregateCount){this.bars.delete(time);if(this.barTimes[this.barHead]===time)this.barHead++;else this.barTimes.splice(this.barIndex(time),1);}
    accumulate(this.total,trade,sign);
  }
  private trackPrice(trade:StoredTrade){
    const node={id:trade.sortId,tick:this.tick(trade.price)};
    for(const [queue,isLow] of [[this.low,true],[this.high,false]] as const){
      while(queue.nodes.length>queue.head&&(isLow?queue.nodes.at(-1)!.tick>=node.tick:queue.nodes.at(-1)!.tick<=node.tick))queue.nodes.pop();
      queue.nodes.push(node);
    }
  }
  private removePrice(trade:StoredTrade){
    for(const queue of [this.low,this.high]){
      if(queue.nodes[queue.head]?.id===trade.sortId)queue.head++;
      if(queue.head>1024&&queue.head*2>=queue.nodes.length){queue.nodes=queue.nodes.slice(queue.head);queue.head=0;}
    }
  }
  private rebuildBounds(){this.low={nodes:[],head:0};this.high={nodes:[],head:0};for(let i=this.head;i<this.records.length;i++)this.trackPrice(this.records[i]);}
  private desiredStep(){
    const desired=this.config.priceStepTicks!,span=(this.high.nodes[this.high.head]?.tick??0)-(this.low.nodes[this.low.head]?.tick??0)+1;
    return desired*Math.max(1,Math.ceil(span/(desired*Math.max(1,this.maxPriceLevels-1))));
  }
  private rebuild(){
    this.profile.clear();this.bars.clear();this.barTimes=[];this.barHead=0;this.total=amounts();this.rebuildBounds();this.stepTicks=this.desiredStep();
    for(let i=this.head;i<this.records.length;i++)this.apply(this.records[i]);
  }
  private addGap(a:StoredTrade|undefined,b:StoredTrade|undefined){
    if(a&&b&&b.sortId>a.sortId+1n){const fromId=(a.sortId+1n).toString();this.missing.set(fromId,{fromId,toId:(b.sortId-1n).toString(),afterTime:a.time,beforeTime:b.time});this.gapCache=undefined;}
  }
  private removeGap(a:StoredTrade|undefined,b:StoredTrade|undefined){
    if(a&&b&&b.sortId>a.sortId+1n&&this.missing.delete((a.sortId+1n).toString()))this.gapCache=undefined;
  }
  setAggregation(patch:Partial<FlowAggregation>){
    const next=validateFlowAggregation({...this.config,...patch});
    for(let i=this.head;i<this.records.length;i++)if(!Number.isSafeInteger(Math.round(this.records[i].price/next.tickSize)))throw Error('价格跳动超出安全整数范围');
    this.config=next;this.rebuild();this.revision++;
  }
  ingest(trades:readonly AggregateTrade[]):number {
    let accepted=0,boundsDirty=false;
    for(const trade of trades){
      if(trade.symbol!==this.symbol||!/^\d{1,25}$/.test(trade.id)||!Number.isFinite(this.tick(trade.price))||trade.price<=0||!Number.isFinite(trade.baseQuantity)||trade.baseQuantity<=0||!Number.isFinite(trade.quoteQuantity)||trade.quoteQuantity<=0||!Number.isSafeInteger(trade.time)||trade.time<0||trade.aggressor!=='buy'&&trade.aggressor!=='sell'){this.rejected++;continue;}
      const id=BigInt(trade.id),key=id.toString();if(this.discardedThrough!==undefined&&id<=this.discardedThrough)continue;
      const prior=this.byId.get(key);
      if(prior){
        if(prior.time!==trade.time||prior.price!==trade.price||prior.baseQuantity!==trade.baseQuantity||prior.aggressor!==trade.aggressor){this.conflicting++;this.activeConflicts.set(key,prior.time);this.revision++;}
        else if(prior.normalBaseQuantity===undefined&&trade.normalBaseQuantity!==undefined){prior.normalBaseQuantity=trade.normalBaseQuantity;this.normalCount++;this.normalBase+=trade.normalBaseQuantity;this.revision++;}
        continue;
      }
      // Repairs may insert between neighbors; the usual live append is O(1).
      let at=this.records.length;
      if(this.size&&this.records[at-1].sortId>id){let lo=this.head,hi=at;while(lo<hi){const mid=(lo+hi)>>>1;if(this.records[mid].sortId<id)lo=mid+1;else hi=mid;}at=lo;}
      const previous=at>this.head?this.records[at-1]:undefined,next=this.records[at];
      if(previous&&previous.time>trade.time||next&&next.time<trade.time){this.rejected++;continue;}
      const copy:StoredTrade={...trade,id:key,sortId:id};this.removeGap(previous,next);this.addGap(previous,copy);this.addGap(copy,next);
      if(at===this.records.length)this.records.push(copy);else{this.records.splice(at,0,copy);boundsDirty=true;}
      this.byId.set(key,copy);accepted++;
      if(copy.normalBaseQuantity!==undefined){this.normalCount++;this.normalBase+=copy.normalBaseQuantity;}
      if(!boundsDirty)this.trackPrice(copy);
      this.apply(copy);
    }
    const cutoff=(this.records.at(-1)?.time??0)-this.maxAgeMs;
    while(this.size&&(this.size>this.maxTrades||this.records[this.head].time<cutoff)){
      const trade=this.records[this.head],next=this.records[this.head+1];this.removeGap(trade,next);this.apply(trade,-1);
      if(trade.normalBaseQuantity!==undefined){this.normalCount--;this.normalBase-=trade.normalBaseQuantity;}
      if(!boundsDirty)this.removePrice(trade);
      this.byId.delete(trade.id);this.activeConflicts.delete(trade.id);this.discardedThrough=trade.sortId;this.head++;this.evicted++;
    }
    // Reclaim stale prefixes occasionally instead of Array.shift per trade.
    if(this.head>=this.maxTrades){this.records=this.records.slice(this.head);this.head=0;}
    if(this.barHead>1024&&this.barHead*2>=this.barTimes.length){this.barTimes=this.barTimes.slice(this.barHead);this.barHead=0;}
    if(boundsDirty)this.rebuildBounds();
    // Do not oscillate bin widths during small rolling-window movements. Wider
    // required coverage or an explicit regrouping is the only full rebuild.
    if(this.desiredStep()>this.stepTicks)this.rebuild();
    if(accepted)this.revision++;
    return accepted;
  }
  gaps():FlowGap[]{
    // No retained-tape scan or per-record BigInt conversion on UI snapshots.
    this.gapCache??=[...this.missing.values()].sort((a,b)=>BigInt(a.fromId)<BigInt(b.fromId)?-1:1);
    return this.gapCache.map(gap=>({...gap}));
  }
  snapshot():TradeFlowSnapshot {
    const first=this.records[this.head],last=this.size?this.records.at(-1):undefined,gaps=this.gaps();
    const coverage:FlowCoverage={fromTime:first?.time,throughTime:last?.time,fromId:first?.id,throughId:last?.id,retainedTrades:this.size,evictedTrades:this.evicted,rejectedTrades:this.rejected,conflictingDuplicates:this.conflicting,gaps:gaps.slice(0,64),gapCount:gaps.length,continuous:!!first&&!gaps.length&&!this.activeConflicts.size,completeHistory:false,source:'Binance USDⓈ-M aggTrade',scope:'retained-public-aggregates',normalQuantityTrades:this.normalCount,cvdAnchorTime:first?.time,
      ...(this.normalCount===this.size&&this.normalCount?{normalQuantityBase:this.normalBase}:{}),
      note:'仅覆盖内存保留的公开聚合成交；不含保险基金/ADL成交，不代表整个市场或完整历史。q 含 RPI；nq 缺失时不推算普通成交量。CVD 从当前保留起点重置；遇到序列缺口或冲突后标记未知。'};
    const times=this.barTimes.slice(Math.max(this.barHead,this.barTimes.length-this.maxFootprintBars));
    // Hidden older bars still contribute to the retained-origin CVD. Their
    // totals are already in the accumulator; do not materialize every old cell.
    let cvdBase=this.total.deltaBase,cvdQuote=this.total.deltaQuote;
    for(const time of times){const totals=this.bars.get(time)!.totals;cvdBase-=totals.deltaBase;cvdQuote-=totals.deltaQuote;}
    let uncertainFrom=gaps[0]?.afterTime??Infinity;for(const time of this.activeConflicts.values())uncertainFrom=Math.min(uncertainFrom,time);
    const footprint=times.map(time=>{
      const bucket=this.bars.get(time)!,totals=bucket.totals,levels=[...bucket.levels.values()].sort((a,b)=>b.price-a.price).map(v=>({...v}));
      cvdBase+=totals.deltaBase;cvdQuote+=totals.deltaQuote;
      const endTime=time+this.config.timeframeMs,unknown=endTime>uncertainFrom;
      return {...totals,time,endTime,levels,cvdBase:unknown?NaN:cvdBase,cvdQuote:unknown?NaN:cvdQuote,partial:!first||time<first.time||endTime>last!.time||gaps.some(g=>g.afterTime<endTime&&g.beforeTime>=time)||[...this.activeConflicts.values()].some(t=>t>=time&&t<endTime)};
    });
    return {symbol:this.symbol,revision:this.revision,aggregation:{...this.config},effectivePriceStepTicks:this.stepTicks,effectivePriceStep:this.stepTicks*this.config.tickSize,profile:[...this.profile.values()].sort((a,b)=>b.price-a.price).map(v=>({...v})),footprint,totals:{...this.total},coverage};
  }
}
