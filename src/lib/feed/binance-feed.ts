import {publicMarketRequest,publicMarketSocketUrl,publicMarketStreamEndpoint} from '../market/public-transport';
import type { BarEvent, BarInput, FeedStatus } from '../core/types';
import type { BulkFeed } from './feed';
import {BINANCE_FUTURES_REST,BINANCE_FUTURES_STREAM,fetchBinancePerpetualSymbols,type BinanceContractMetadata} from '../market/binance-contracts';
import {normalizePerpetualSymbol} from '../watchlist/symbols';

export interface BinanceFeedOpts {
  symbol?: string; interval?: string; restBase?: string; wsBase?: string; limit?: number;
  /** Valid candle silence budget; default 90s, bounded to 10–300s. */
  staleAfterMs?:number;
  /** Reserved for a future server-side account adapter. Public market data never
   * sends this value; do not embed private API secrets in a browser bundle. */
  apiKey?: string;
}
interface KlineMsg { k?: {t:number;o:string;h:string;l:string;c:string;v:string;x?:boolean;q?:string;n?:number;V?:string;Q?:string}; }

/** Public exchange totals. Missing or inconsistent extension fields do not
 * fabricate flow data and do not discard an otherwise valid price candle. */
export function klineFlow(volume:number,q:unknown,n:unknown,buy:unknown,buyQuote:unknown):Partial<BarInput>{
  const out:Partial<BarInput>={};
  const numeric=(v:unknown)=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v):undefined;
  const quote=numeric(q),count=numeric(n),base=numeric(buy),takerQuote=numeric(buyQuote);
  if(quote!==undefined)out.quoteVolume=quote;
  if(count!==undefined&&Number.isSafeInteger(count))out.tradeCount=count;
  if(base!==undefined&&base<=volume+Math.max(1,volume)*1e-10)out.takerBuyBase=Math.min(base,volume);
  if(takerQuote!==undefined&&quote!==undefined&&takerQuote<=quote+Math.max(1,quote)*1e-10)out.takerBuyQuote=Math.min(takerQuote,quote);
  return out;
}

export function toBinanceInterval(interval:string):string {
  return interval==='7d'?'1w':interval==='30d'?'1M':interval;
}
export function nextOpenTime(time:number, interval:string):number {
  const wire=toBinanceInterval(interval);
  if(wire==='1M'){const d=new Date(time);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);}
  const match=/^(\d+)([smhdw])$/.exec(wire);
  if(!match)throw new Error(`Unsupported interval: ${interval}`);
  return time+Number(match[1])*({s:1000,m:60000,h:3600000,d:86400000,w:604800000}[match[2] as 'm']);
}
export function validBar(b:BarInput):boolean {
  return [b.time,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)&&b.time>=0&&b.volume>=0&&b.high>=Math.max(b.open,b.close)&&b.low<=Math.min(b.open,b.close)&&b.high>=b.low;
}

/** Public snapshot + ordered stream. REST backfills every missing candle after
 * reconnect or a time gap; live updates buffer while recovery is in progress. */
export class BinanceFeed implements BulkFeed {
  readonly name='binance'; readonly symbol:string; readonly interval:string;
  private restBase:string;private wsBase:string;private limit:number;
  private ws:WebSocket|null=null;
  private retry=0;private timer:ReturnType<typeof setTimeout>|null=null;
  private connectTimer:ReturnType<typeof setTimeout>|null=null;
  private liveTimer:ReturnType<typeof setTimeout>|null=null;private staleAfterMs:number;
  private stopped=false;private lastT=-1;private epoch=0;private syncing=false;
  private pending=new Map<number,BarInput&{confirmed?:boolean}>();
  private aborter=new AbortController();private recoveryAborter=new AbortController();
  private barCbs:((e:BarEvent)=>void)[]=[];private statusCbs:((s:FeedStatus)=>void)[]=[];
  private contractMetadata:BinanceContractMetadata|undefined;
  get contract():BinanceContractMetadata|undefined{return this.contractMetadata?{...this.contractMetadata}:undefined;}
  constructor(opts:BinanceFeedOpts={}) {
    const symbol=normalizePerpetualSymbol(opts.symbol??'BTCUSDT');if(!symbol)throw Error('请选择 USDT 本位永续合约');
    this.symbol=symbol;this.interval=opts.interval??'1m';
    nextOpenTime(0,this.interval);
    this.restBase=(opts.restBase??BINANCE_FUTURES_REST).replace(/\/+$/,'');this.wsBase=(opts.wsBase??BINANCE_FUTURES_STREAM).replace(/\/+$/,'');
    this.limit=Number.isFinite(opts.limit)?Math.max(1,Math.min(Math.floor(opts.limit!),1000)):1000;
    this.staleAfterMs=Number.isFinite(opts.staleAfterMs)?Math.max(10000,Math.min(300000,opts.staleAfterMs!)):90000;
  }
  onBar(cb:(e:BarEvent)=>void):void{this.barCbs.push(cb);}
  onStatus(cb:(s:FeedStatus)=>void):void{this.statusCbs.push(cb);}
  private status(s:FeedStatus):void{if(!this.stopped)this.statusCbs.forEach(cb=>cb(s));}
  private async request(start?:number,end?:number,limit?:number,recoverySignal?:AbortSignal):Promise<BarInput[]> {
    const query=new URLSearchParams({symbol:this.symbol,interval:toBinanceInterval(this.interval),limit:String(limit??(start===undefined?this.limit:1000))});
    if(start!==undefined)query.set('startTime',String(start));if(end!==undefined)query.set('endTime',String(end));
    const timeout=AbortSignal.timeout(10000);
    const signal=AbortSignal.any([timeout,this.aborter.signal,...(recoverySignal?[recoverySignal]:[])]);signal.throwIfAborted();
    const res=await publicMarketRequest(`${this.restBase}/fapi/v1/klines?${query}`,{signal});
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    const rows:unknown=await res.json();signal.throwIfAborted();if(!Array.isArray(rows))throw new Error('Invalid kline response');
    const bars=rows.map((r:unknown)=>{
      if(!Array.isArray(r))throw new Error('Invalid kline row');
      const b={time:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5]),...klineFlow(Number(r[5]),r[7],r[8],r[9],r[10])};
      if(!validBar(b))throw new Error('Invalid OHLCV');return b;
    });
    for(let i=1;i<bars.length;i++)if(bars[i].time<=bars[i-1].time)throw new Error('Unordered klines');
    return bars;
  }
  /** Fetch candles strictly preceding an existing candle's open time. The
   * optional count is bounded at 20,000; each public REST page is at most 1,000.
   * This side channel owns no socket/live cursor state and emits no feed events. */
  async loadBefore(before:number,limit=1000):Promise<BarInput[]> {
    if(!Number.isFinite(before)||before<0)throw new Error('Invalid history boundary');
    if(!Number.isFinite(limit)||limit<0)throw new Error('Invalid history count');
    const count=Math.min(20_000,Math.floor(limit)),signal=this.aborter.signal;
    signal.throwIfAborted();
    if(!before||!count)return [];
    const pages:BarInput[][]=[];let cursor=before,remaining=count;
    while(remaining>0&&cursor>0){
      signal.throwIfAborted();
      const pageSize=Math.min(1000,remaining),bars=await this.request(undefined,cursor-1,pageSize);
      signal.throwIfAborted();
      if(!bars.length)break;
      if(bars.length>pageSize||bars[0].time>=cursor||bars.at(-1)!.time>=cursor)throw new Error('History page overlaps current candles');
      for(let i=1;i<bars.length;i++)if(nextOpenTime(bars[i-1].time,this.interval)!==bars[i].time)throw new Error('History gap remains');
      if(nextOpenTime(bars.at(-1)!.time,this.interval)!==cursor)throw new Error('History gap at page boundary');
      pages.push(bars);remaining-=bars.length;cursor=bars[0].time;
      if(bars.length<pageSize)break;
    }
    return pages.reverse().flat();
  }
  async loadBulk():Promise<BarInput[]> {
    try{
      const directory=await fetchBinancePerpetualSymbols(this.aborter.signal,publicMarketRequest,this.restBase),contract=directory.find(item=>item.symbol===this.symbol)?.contract;
      if(!contract)throw Error(`${this.symbol} 不是当前可交易的 USDT 永续合约`);
      this.aborter.signal.throwIfAborted();this.contractMetadata=contract;
      const bars=await this.request();if(bars.length)this.lastT=bars[bars.length-1].time;return bars;
    }
    catch(e){this.status('error');throw e;}
  }
  async connect():Promise<void> {
    if(this.ws||this.timer)return;
    this.stopped=false;if(this.aborter.signal.aborted)this.aborter=new AbortController();
    this.open();
  }
  disconnect():void {
    this.stopped=true;this.epoch++;this.aborter.abort();this.recoveryAborter.abort();this.pending.clear();this.syncing=false;
    if(this.timer)clearTimeout(this.timer);if(this.connectTimer)clearTimeout(this.connectTimer);
    this.timer=null;this.connectTimer=null;this.clearLiveTimer();
    const ws=this.ws;this.ws=null;
    if(ws){ws.onclose=null;ws.onerror=null;ws.onmessage=null;ws.onopen=null;ws.close();}
  }
  private open():void {
    if(this.stopped)return;
    const epoch=++this.epoch;this.clearLiveTimer();this.recoveryAborter.abort();this.recoveryAborter=new AbortController();this.status('reconnecting');this.syncing=true;
    let ws:WebSocket;
    const upstream=publicMarketStreamEndpoint(this.wsBase,`${this.symbol.toLowerCase()}@kline_${toBinanceInterval(this.interval)}`);
    try{ws=new WebSocket(this.retry%2===1?upstream:publicMarketSocketUrl(upstream));}
    catch{this.retryLater();return;}
    this.ws=ws;
    this.connectTimer=setTimeout(()=>{if(epoch===this.epoch)ws.close();},10000);
    ws.onopen=()=>{
      if(epoch!==this.epoch||this.stopped)return;
      if(this.connectTimer)clearTimeout(this.connectTimer);this.connectTimer=null;this.armLiveTimer(ws,epoch);
      void this.recover(Date.now(),epoch).then(()=>{
        if(epoch!==this.epoch||this.stopped)return;
        this.retry=0;this.syncing=false;void this.drain(epoch);
      }).catch(()=>{if(epoch===this.epoch)ws.close();});
    };
    ws.onmessage=ev=>{
      if(epoch!==this.epoch||this.stopped)return;
      try{
        const {k}=JSON.parse(String(ev.data)) as KlineMsg;if(!k)return;
        const b={time:k.t,open:Number(k.o),high:Number(k.h),low:Number(k.l),close:Number(k.c),volume:Number(k.v),...klineFlow(Number(k.v),k.q,k.n,k.V,k.Q)};
        if(!validBar(b)||b.time<this.lastT)return;
        this.armLiveTimer(ws,epoch);
        this.pending.set(b.time,{...b,confirmed:k.x===true});if(!this.syncing)void this.drain(epoch);
      }catch{/* Malformed messages do not alter candle state. */}
    };
    ws.onerror=()=>ws.close();
    ws.onclose=()=>{
      if(epoch!==this.epoch)return;
      this.recoveryAborter.abort();this.clearLiveTimer();
      if(this.connectTimer)clearTimeout(this.connectTimer);this.connectTimer=null;
      this.ws=null;this.epoch++;this.pending.clear();this.syncing=false;this.retryLater();
    };
  }
  private clearLiveTimer():void {if(this.liveTimer)clearTimeout(this.liveTimer);this.liveTimer=null;}
  /** Opening a socket and receiving REST history do not prove live delivery.
   * Only a valid current kline refreshes this bounded silence watchdog. */
  private armLiveTimer(ws:WebSocket,epoch:number):void {
    if(this.stopped||epoch!==this.epoch)return;this.clearLiveTimer();
    this.liveTimer=setTimeout(()=>{
      if(this.stopped||epoch!==this.epoch||this.ws!==ws)return;
      this.liveTimer=null;this.status('reconnecting');ws.close();
    },this.staleAfterMs);
  }
  private retryLater():void {
    if(this.stopped||this.timer)return;
    this.retry++;this.status(this.retry>=5?'error':'reconnecting');
    const delay=Math.min(1000*2**Math.min(this.retry-1,5),30000);
    this.timer=setTimeout(()=>{this.timer=null;this.open();},delay);
  }
  private emit(b:BarInput&{confirmed?:boolean}):void {
    if(this.stopped||b.time<this.lastT)return;
    const isNew=b.time>this.lastT;this.lastT=b.time;this.barCbs.forEach(cb=>cb({...b,isNew}));
  }
  private async recover(end:number,epoch:number):Promise<void> {
    if(this.lastT<0)return;
    const signal=this.recoveryAborter.signal;let start=this.lastT;
    while(start<=end&&!this.stopped&&epoch===this.epoch){
      const bars=await this.request(start,end,undefined,signal);
      if(this.stopped||epoch!==this.epoch)return;
      if(!bars.length)break;
      for(const b of bars){
        if(b.time>nextOpenTime(this.lastT,this.interval))throw new Error('History gap remains');
        this.emit(b);
      }
      const next=nextOpenTime(bars[bars.length-1].time,this.interval);
      if(next<=start||bars.length<1000)break;start=next;
    }
  }
  private async drain(epoch:number):Promise<void> {
    if(this.syncing)return;this.syncing=true;
    try{
      while(this.pending.size&&!this.stopped&&epoch===this.epoch){
        const first=Math.min(...this.pending.keys()),b=this.pending.get(first)!;this.pending.delete(first);
        if(b.time>nextOpenTime(this.lastT,this.interval)){
          this.status('reconnecting');await this.recover(b.time,epoch);
          if(b.time>nextOpenTime(this.lastT,this.interval))throw new Error('Unable to fill history gap');
        }
        if(epoch!==this.epoch||this.stopped)return;this.emit(b);
      }
      if(epoch===this.epoch&&!this.stopped)this.status('ok');
    }catch{if(epoch===this.epoch)this.ws?.close();}
    finally{if(epoch===this.epoch)this.syncing=false;}
  }
}
