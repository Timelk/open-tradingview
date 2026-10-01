import {createOrderBookSession,type OrderBookSession} from '../src/lib/flow/orderbook';
import {parseAggregateTrade} from '../src/lib/flow/types';
import type {RecordedMarketEvent} from '../src/lib/flow/persistence-client';
import type {MarketStore} from './market-store';
import NodeWebSocket from 'ws';
import {HttpsProxyAgent} from 'https-proxy-agent';

function recordingSocket(proxy?:string){return class extends NodeWebSocket {
  constructor(url:string){super(url,{handshakeTimeout:10_000,perMessageDeflate:false,...(proxy?{agent:new HttpsProxyAgent(proxy)}:{})});
    // The session removes property handlers before closing. Keep an EventEmitter
    // error sink so cancelling a CONNECTING Node socket cannot crash Vite.
    this.on('error',()=>{});
  }
};}

export interface RecorderOptions {fetch?:typeof fetch;WebSocket?:typeof WebSocket;flushMs?:number;proxy?:string;resumeFromId?:string}
/** The local service owns these public connections. Sidebar visibility and
 * browser lifetime do not control a recording; stop() or service shutdown does. */
export class MarketRecorder {
  private running=true;private epoch=0;private retries=0;private socket:WebSocket|undefined;
  private retryTimer:ReturnType<typeof setTimeout>|undefined;private openTimer:ReturnType<typeof setTimeout>|undefined;
  private stableTimer:ReturnType<typeof setTimeout>|undefined;
  private flushTimer:ReturnType<typeof setInterval>;private aborter=new AbortController();
  private queue:RecordedMarketEvent[]=[];private lastId:string|undefined;private checkpoint=0;private book:OrderBookSession;
  private request:typeof fetch;private Socket:typeof WebSocket;
  constructor(private store:MarketStore,readonly id:string,readonly symbol:string,options:RecorderOptions={}){
    this.request=options.fetch??fetch;this.Socket=options.WebSocket??recordingSocket(options.proxy) as unknown as typeof WebSocket;
    if(options.resumeFromId!==undefined){if(!/^\d{1,25}$/.test(options.resumeFromId))throw Error('无效录制恢复成交游标');this.lastId=BigInt(options.resumeFromId).toString();}
    this.book=createOrderBookSession({symbol,limit:1000,fetch:this.request,WebSocket:this.Socket,onRecord:event=>this.enqueue(event),onUpdate:snapshot=>{
      if(snapshot.status==='live'&&Date.now()-this.checkpoint>=30_000){this.checkpoint=Date.now();this.enqueue({kind:'depth-snapshot',origin:'checkpoint',receivedAt:this.checkpoint,time:snapshot.updatedAt,lastUpdateId:snapshot.lastUpdateId!,bids:snapshot.bids,asks:snapshot.asks});}
      else if(snapshot.status==='error')this.warning(snapshot.warning??'L2 连接暂停，请停止并重新开始录制');
    }});
    const flushMs=Number.isFinite(options.flushMs)?Math.max(50,Math.min(5000,options.flushMs!)):100;
    this.flushTimer=setInterval(()=>this.flush(),flushMs);this.flushTimer.unref?.();
    this.open();void this.book.connect();
  }
  private enqueue(event:RecordedMarketEvent){
    if(!this.running)return;
    if(this.queue.length>=2000){this.flush();if(this.queue.length>=2000){this.queue=[];this.warning('录制写入积压；此处存在未保存事件');}}
    this.queue.push(event);
  }
  flush(){
    if(!this.queue.length)return;
    try{while(this.queue.length){this.store.append(this.id,this.queue.slice(0,1000));this.queue.splice(0,1000);}}
    catch(error){this.warning(`录制写入失败：${error instanceof Error?error.message:'本地存储不可用'}`);}
  }
  private warning(message:string){try{this.store.update({...this.store.get(this.id),warning:message});}catch{/* Closed storage. */}}
  private gap(reason:string){this.enqueue({kind:'gap',channel:'trades',time:Date.now(),receivedAt:Date.now(),reason});this.warning(reason);}
  private closeSocket(){clearTimeout(this.openTimer);clearTimeout(this.stableTimer);if(this.socket){this.socket.onopen=this.socket.onmessage=this.socket.onerror=this.socket.onclose=null;this.socket.close();this.socket=undefined;}}
  private open(){
    if(!this.running)return;this.closeSocket();const epoch=++this.epoch;
    let socket:WebSocket;try{socket=new this.Socket(`wss://fstream.binance.com/market/ws/${this.symbol.toLowerCase()}@aggTrade`);this.socket=socket;}catch{this.failed(epoch);return;}
    this.openTimer=setTimeout(()=>this.failed(epoch),12000);
    socket.onopen=()=>{if(!this.running||epoch!==this.epoch)return;clearTimeout(this.openTimer);this.stableTimer=setTimeout(()=>{if(this.running&&epoch===this.epoch)this.retries=0;},60_000);void this.recover(epoch,this.lastId);};
    socket.onmessage=event=>{
      if(!this.running||epoch!==this.epoch)return;
      try{const raw=JSON.parse(String(event.data));if(raw.st!==undefined&&raw.st!==1)return;const trade=parseAggregateTrade(raw,this.symbol);if(!trade)return;
        this.enqueue({kind:'aggTrade',receivedAt:Date.now(),trade});if(!this.lastId||BigInt(trade.id)>BigInt(this.lastId))this.lastId=trade.id;
      }catch{this.gap('成交流消息解析失败；记录覆盖可能不完整');}
    };
    socket.onclose=socket.onerror=()=>this.failed(epoch);
  }
  private async recover(epoch:number,lastId?:string){
    let cursor=lastId?String(BigInt(lastId)+1n):undefined;
    try{for(let page=0;page<(lastId?5:1);page++){
      const query=new URLSearchParams({symbol:this.symbol,limit:'1000'});if(cursor)query.set('fromId',cursor);
      const response=await this.request(`https://fapi.binance.com/fapi/v1/aggTrades?${query}`,{signal:AbortSignal.any([this.aborter.signal,AbortSignal.timeout(10_000)]),credentials:'omit',redirect:'error'});
      if(!response.ok)throw Error(`公开成交补取 HTTP ${response.status}`);const raw=await response.json();if(!this.running||epoch!==this.epoch)return;
      if(!Array.isArray(raw)||raw.length>1000)throw Error('公开成交补取格式无效');let last:string|undefined;
      for(const row of raw){const trade=parseAggregateTrade(row,this.symbol);if(!trade)throw Error('公开成交补取包含无效行');this.enqueue({kind:'aggTrade',receivedAt:Date.now(),trade});last=trade.id;if(!this.lastId||BigInt(last)>BigInt(this.lastId))this.lastId=last;}
      this.flush();if(raw.length<1000||!last)break;cursor=String(BigInt(last)+1n);
      if(lastId&&page===4)this.gap('成交恢复达到本次5000条上限；未补齐的ID缺口保留，不继续无限补取');
    }}catch(error){if(this.running&&epoch===this.epoch)this.gap(`${error instanceof Error?error.message:'成交补取失败'}；后续实时录制继续，缺口不隐藏`);}
  }
  private failed(epoch:number){
    if(!this.running||epoch!==this.epoch)return;this.epoch++;this.closeSocket();this.gap('公开成交流断开；正在有限重连');
    if(++this.retries>6){this.warning('成交流多次重连失败；L2 仍独立工作，请停止后重启录制');return;}
    this.retryTimer=setTimeout(()=>{this.retryTimer=undefined;this.open();},Math.min(30000,500*2**(this.retries-1)));
  }
  stop(){
    if(!this.running)return;this.running=false;this.epoch++;this.aborter.abort();clearTimeout(this.retryTimer);clearInterval(this.flushTimer);this.closeSocket();this.book.disconnect();this.flush();
  }
}
