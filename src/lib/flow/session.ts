import {publicMarketRequest,publicMarketSocketUrl,publicMarketStreamEndpoint} from '../market/public-transport';
import {BINANCE_FUTURES_REST,BINANCE_FUTURES_STREAM} from '../market/binance-contracts';
import {TradeFlowStore} from './store';
import {parseAggregateTrade,type AggregateTrade,type FlowAggregation,type FlowStoreOptions,type TradeFlowSessionSnapshot,type TradeFlowStatus} from './types';
const bounded=(value:number|undefined,fallback:number,min:number,max:number)=>Math.max(min,Math.min(max,Math.floor(Number.isFinite(value)?value!:fallback)));

export interface FlowSocket {
  onopen:((event:Event)=>void)|null;onmessage:((event:MessageEvent)=>void)|null;
  onclose:((event:CloseEvent)=>void)|null;onerror:((event:Event)=>void)|null;close():void;
}
export interface TradeFlowSessionOptions extends FlowStoreOptions {
  onUpdate?:(snapshot:TradeFlowSessionSnapshot)=>void;
  request?:typeof fetch;socketFactory?:(url:string)=>FlowSocket;
  restBase?:string;wsBase?:string;publishMs?:number;maxBuffer?:number;maxRecoveryPages?:number;maxReconnectAttempts?:number;
}

/** Explicitly opt-in public stream. Constructing the session performs no I/O.
 * WS is buffered before the recent REST bootstrap, then ID-merged. Recovery is
 * bounded and never converts a missing period into a zero-volume period. */
export class TradeFlowSession {
  readonly store:TradeFlowStore;
  private state:TradeFlowStatus='idle';private message='尚未连接';private running=false;private epoch=0;private retry=0;
  private ws:FlowSocket|undefined;private aborter=new AbortController();private pending=new Map<string,AggregateTrade>();
  private loading=false;private recovering=false;private dropped=0;private lastRecovery=0;
  private retryTimer:ReturnType<typeof setTimeout>|undefined;private connectTimer:ReturnType<typeof setTimeout>|undefined;private publishTimer:ReturnType<typeof setTimeout>|undefined;private recoveryTimer:ReturnType<typeof setTimeout>|undefined;private stableTimer:ReturnType<typeof setTimeout>|undefined;
  private request:typeof fetch;private socketFactory:(url:string)=>FlowSocket;private listeners=new Set<(value:TradeFlowSessionSnapshot)=>void>();
  private maxBuffer:number;private maxRecoveryPages:number;private maxRetries:number;private publishMs:number;
  constructor(private options:TradeFlowSessionOptions){
    this.store=new TradeFlowStore(options);this.request=options.request??publicMarketRequest;this.socketFactory=options.socketFactory??(url=>new WebSocket(publicMarketSocketUrl(url)));
    this.maxBuffer=bounded(options.maxBuffer,5000,100,20_000);this.maxRecoveryPages=bounded(options.maxRecoveryPages,3,0,5);this.maxRetries=bounded(options.maxReconnectAttempts,6,0,10);this.publishMs=bounded(options.publishMs,100,16,1000);
    if(options.onUpdate)this.listeners.add(options.onUpdate);
  }
  subscribe(listener:(value:TradeFlowSessionSnapshot)=>void){this.listeners.add(listener);listener(this.snapshot());return()=>this.listeners.delete(listener);}
  snapshot():TradeFlowSessionSnapshot{return {...this.store.snapshot(),status:this.state,message:this.message,reconnectAttempts:this.retry,bufferDropped:this.dropped,updatedAt:Date.now()};}
  setAggregation(patch:Partial<FlowAggregation>){this.store.setAggregation(patch);this.publish(true);}
  connect():void {if(this.running)return;this.running=true;this.retry=0;this.open();}
  disconnect():void {
    this.running=false;this.epoch++;this.aborter.abort();this.closeSocket();clearTimeout(this.retryTimer);clearTimeout(this.publishTimer);this.retryTimer=undefined;this.publishTimer=undefined;this.pending.clear();this.loading=false;this.recovering=false;
    this.status('stopped','已停止；保留本次内存数据，关闭模块后不再订阅');
  }
  private status(state:TradeFlowStatus,message:string){this.state=state;this.message=message;this.publish(true);}
  private publish(immediate=false){
    if(immediate){clearTimeout(this.publishTimer);this.publishTimer=undefined;const value=this.snapshot();for(const listener of this.listeners)listener(value);return;}
    if(this.publishTimer)return;this.publishTimer=setTimeout(()=>{this.publishTimer=undefined;const value=this.snapshot();for(const listener of this.listeners)listener(value);},this.publishMs);
  }
  private closeSocket(){clearTimeout(this.connectTimer);clearTimeout(this.recoveryTimer);clearTimeout(this.stableTimer);this.connectTimer=this.recoveryTimer=this.stableTimer=undefined;if(this.ws){this.ws.onopen=this.ws.onmessage=this.ws.onclose=this.ws.onerror=null;this.ws.close();this.ws=undefined;}}
  private open(){
    const epoch=++this.epoch;this.aborter.abort();this.aborter=new AbortController();this.closeSocket();this.pending.clear();this.loading=true;this.recovering=false;
    this.status(this.retry?'reconnecting':'connecting',this.retry?'正在重连并校验成交序列':'正在连接公开成交流');
    const current=()=>this.running&&this.epoch===epoch;
    try{this.ws=this.socketFactory(publicMarketStreamEndpoint(this.options.wsBase??BINANCE_FUTURES_STREAM,`${this.store.symbol.toLowerCase()}@aggTrade`));}catch(error){this.fail(error,epoch);return;}
    this.connectTimer=setTimeout(()=>this.fail(Error('成交流连接超时'),epoch),12_000);
    this.ws.onopen=()=>{if(!current())return;clearTimeout(this.connectTimer);this.connectTimer=undefined;void this.bootstrap(epoch);};
    this.ws.onmessage=event=>{
      if(!current())return;
      let raw:unknown;try{raw=JSON.parse(String(event.data));}catch{this.message='收到无效成交消息；等待后续序列校验';this.publish();return;}
      const trade=parseAggregateTrade(raw,this.store.symbol);if(!trade)return;
      if(this.loading){this.pending.set(trade.id,trade);if(this.pending.size>this.maxBuffer){this.pending.delete(this.pending.keys().next().value!);this.dropped++;}return;}
      const previous=this.store.lastId;this.store.ingest([trade]);this.publish();
      if(previous&&BigInt(trade.id)>BigInt(previous)+1n){this.status('partial','检测到聚合成交 ID 缺口，正在有限补取');void this.recover(epoch);}
    };
    this.ws.onclose=()=>this.fail(Error('公开成交流已断开'),epoch);
    this.ws.onerror=()=>this.fail(Error('公开成交流连接失败'),epoch);
  }
  private async rows(fromId?:string):Promise<AggregateTrade[]>{
    const query=new URLSearchParams({symbol:this.store.symbol,limit:'1000'});if(fromId!==undefined)query.set('fromId',fromId);
    const signal=AbortSignal.any([this.aborter.signal,AbortSignal.timeout(10_000)]),response=await this.request(`${(this.options.restBase??BINANCE_FUTURES_REST).replace(/\/+$/,'')}/fapi/v1/aggTrades?${query}`,{signal});
    if(!response.ok)throw Error(`公开成交查询 HTTP ${response.status}${response.status===429?'（请求限流，稍后重试）':''}`);
    const raw:unknown=await response.json();signal.throwIfAborted();if(!Array.isArray(raw)||raw.length>1000)throw Error('公开成交响应格式无效');
    const result=raw.map(row=>parseAggregateTrade(row,this.store.symbol));if(result.some(row=>!row))throw Error('公开成交响应包含无效记录');
    return (result as AggregateTrade[]).sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0);
  }
  private flush(){const rows=[...this.pending.values()].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);this.pending.clear();this.store.ingest(rows);}
  private async bootstrap(epoch:number){
    this.status('loading','加载最近 1000 条聚合成交并合并实时缓冲；历史覆盖有限');
    try{
      // Recent bootstrap is always bounded. A retained cursor then permits
      // targeted gap repair after reconnect, within Binance's recent window.
      const rows=await this.rows();if(!this.running||epoch!==this.epoch)return;
      this.store.ingest(rows);this.flush();this.loading=false;
      this.status(this.store.gaps().length?'partial':'live',this.store.gaps().length?'连接恢复，保留区间存在待补缺口':'实时成交已连接；仅显示近期保留范围');
      // Retries are bounded per interruption. Only a sustained healthy socket
      // resets the budget, not an instantly repeating open/close handshake.
      this.stableTimer=setTimeout(()=>{if(this.running&&epoch===this.epoch)this.retry=0;},60_000);
      this.lastRecovery=0;await this.recover(epoch);
    }catch(error){if(!this.running||epoch!==this.epoch)return;this.flush();this.loading=false;this.status('partial',`${error instanceof Error?error.message:'公开成交引导失败'}；实时数据已保留，历史覆盖未知`);}
  }
  private async recover(epoch:number){
    if(this.recovering||this.loading||!this.running||epoch!==this.epoch||!this.maxRecoveryPages||!this.store.gaps().length)return;
    const remaining=30_000-(Date.now()-this.lastRecovery);
    if(remaining>0){if(!this.recoveryTimer)this.recoveryTimer=setTimeout(()=>{this.recoveryTimer=undefined;void this.recover(epoch);},remaining);return;}
    this.recovering=true;this.lastRecovery=Date.now();
    try{
      for(let page=0;page<this.maxRecoveryPages;page++){
        const gap=this.store.gaps()[0];if(!gap)break;
        const rows=await this.rows(gap.fromId);if(!this.running||epoch!==this.epoch)return;
        const accepted=this.store.ingest(rows);this.publish();if(!accepted)break;
      }
      if(!this.running||epoch!==this.epoch)return;
      const missing=this.store.gaps().length;
      this.status(missing?'partial':'live',missing?'有限补取后仍有缺口；图表必须按不完整成交范围解读':'实时成交已连接；保留区间聚合 ID 连续，非完整历史');
    }catch(error){if(this.running&&epoch===this.epoch)this.status('partial',`${error instanceof Error?error.message:'成交缺口补取失败'}；保留已收到数据和缺口`);}
    finally{if(epoch===this.epoch)this.recovering=false;}
  }
  private fail(error:unknown,epoch:number){
    if(!this.running||epoch!==this.epoch)return;
    this.epoch++;this.aborter.abort();this.closeSocket();this.flush();this.loading=false;this.recovering=false;
    const message=error instanceof Error?error.message:'公开成交连接中断';
    if(this.retry>=this.maxRetries){this.running=false;this.status('error',`${message}；已停止自动重连，可手动重新连接`);return;}
    const delay=Math.min(30_000,1000*2**this.retry);this.retry++;this.status('reconnecting',`${message}；${delay/1000} 秒后重连，期间覆盖未知`);
    this.retryTimer=setTimeout(()=>{this.retryTimer=undefined;if(this.running)this.open();},delay);
  }
}
export const createTradeFlowSession=(options:TradeFlowSessionOptions)=>new TradeFlowSession(options);
