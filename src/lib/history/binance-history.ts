import {TIMEFRAMES} from '../scene/types';
import {nextOpenTime,toBinanceInterval} from '../feed/binance-feed';
import type {DatasetSnapshot,MarketBar} from './types';
import type {DatasetPersistence} from './persistence';
import {datasetFingerprint,validateDatasetBars,MAX_HISTORY_BARS,type HistoryProgress} from './datasets';
import {BINANCE_FUTURES_REST,fetchBinancePerpetualSymbols,type BinanceContractMetadata} from '../market/binance-contracts';
import {normalizePerpetualSymbol} from '../watchlist/symbols';

export interface HistoryRequest {symbol:string;interval:string;from:number;to:number;warmupBars?:number;signal?:AbortSignal;onProgress?:(progress:HistoryProgress)=>void}
export class BinanceHistoryService {
  private metadata=new Map<string,BinanceContractMetadata>();
  private metadataAt=0;
  constructor(private persistence?:DatasetPersistence,private request:typeof fetch=(input,init)=>globalThis.fetch(input,init)){}
  private async json(path:string,signal?:AbortSignal):Promise<unknown>{
    const response=await this.request(`${BINANCE_FUTURES_REST}${path}`,{signal:AbortSignal.any([AbortSignal.timeout(12000),...(signal?[signal]:[])])});
    if(!response.ok)throw Error(response.status===429?'Binance 请求过于频繁，请稍后重试':`Binance 合约历史行情请求失败（${response.status}）`);
    return response.json();
  }
  async describe(input:string,signal?:AbortSignal):Promise<BinanceContractMetadata>{
    const symbol=normalizePerpetualSymbol(input);if(!symbol)throw Error('请选择 USDT 本位永续合约');
    signal?.throwIfAborted();
    if(Date.now()-this.metadataAt>300000||!this.metadata.size){
      const directory=await fetchBinancePerpetualSymbols(signal,this.request);signal?.throwIfAborted();
      this.metadata=new Map(directory.map(item=>[item.symbol,item.contract]));this.metadataAt=Date.now();
    }
    const saved=this.metadata.get(symbol);if(!saved)throw Error(`${symbol} 不是当前可交易的 USDT 永续合约`);
    return {...saved};
  }
  /** Public mark-price observations aligned with a frozen candle range. */
  async loadMarkPrices(dataset:Pick<DatasetSnapshot,'symbol'|'interval'|'bars'>,signal?:AbortSignal):Promise<{time:number;close:number}[]>{
    const symbol=normalizePerpetualSymbol(dataset.symbol),step=TIMEFRAMES[dataset.interval],wireInterval=toBinanceInterval(dataset.interval);
    if(!symbol||!step)throw Error('标记价格的合约或周期无效');
    if(!dataset.bars.length)return [];
    if(dataset.bars.length>MAX_HISTORY_BARS)throw Error('标记价格数据超过单次历史读取上限');
    const end=nextOpenTime(dataset.bars.at(-1)!.time,dataset.interval),prices=new Map<number,number>();let cursor=dataset.bars[0].time;
    while(cursor<end){
      signal?.throwIfAborted();
      const raw=await this.json(`/fapi/v1/markPriceKlines?${new URLSearchParams({symbol,interval:wireInterval,startTime:String(cursor),endTime:String(end-1),limit:'1000'})}`,signal);
      if(!Array.isArray(raw))throw Error('Binance 返回了无效的标记价格数据');
      if(!raw.length)break;
      let last=cursor-1;
      for(const row of raw){
        if(!Array.isArray(row)||row.length<5)throw Error('标记价格 K 线格式无效');
        const time=Number(row[0]),close=Number(row[4]);
        if(!Number.isFinite(time)||!Number.isFinite(close)||close<=0||time<=last)throw Error('标记价格数据无效或存在重复');
        last=time;if(time>=cursor&&time<end)prices.set(time,close);
      }
      const next=nextOpenTime(last,dataset.interval);if(next<=cursor)throw Error('标记价格分页未能前进');cursor=next;
    }
    signal?.throwIfAborted();
    return dataset.bars.map(bar=>{const close=prices.get(bar.time);if(close===undefined)throw Error(`标记价格在 ${new Date(bar.time).toISOString()} 缺失，不能校验合约成交规则`);return {time:bar.time,close};});
  }
  async load({symbol:input,interval,from,to,warmupBars=0,signal,onProgress}:HistoryRequest):Promise<DatasetSnapshot>{
    const step=TIMEFRAMES[interval],wireInterval=toBinanceInterval(interval);if(!step)throw Error('暂不支持此历史周期');
    const symbol=normalizePerpetualSymbol(input);
    if(!symbol||!Number.isFinite(from)||!Number.isFinite(to)||from<0||from>=to)throw Error('请输入有效的 USDT 永续合约和日期范围');
    if(Math.ceil((to-from)/step)+warmupBars>MAX_HISTORY_BARS)throw Error(`当前区间超过 ${MAX_HISTORY_BARS.toLocaleString()} 根，请缩短日期范围或提高周期`);
    const start=Math.max(0,Math.floor(from/step)*step-Math.min(5000,Math.max(0,warmupBars))*step);
    const key=`binance:usdm-perpetual:v1:${symbol}:${interval}:${start}:${to}`;
    let cached:DatasetSnapshot|undefined;
    try{cached=await this.persistence?.get<DatasetSnapshot>('datasets',key);}catch{/* Cache availability does not replace a real history request. */}
    if(cached?.marketType==='usdm-perpetual'&&cached.contract?.symbol===symbol&&cached.markPrices?.length===cached.bars.length){signal?.throwIfAborted();validateDatasetBars(cached.bars,step);onProgress?.({completed:cached.bars.length,total:cached.bars.length,stage:'已读取合约历史缓存'});return cached;}
    const metadata=await this.describe(symbol,signal);
    const clock=await this.json('/fapi/v1/time',signal) as {serverTime?:number};
    if(!Number.isFinite(clock.serverTime))throw Error('无法确认交易所时间');
    const end=Math.min(to,Math.floor(clock.serverTime!/step)*step);
    if(end<=from)throw Error('所选范围没有已收盘 K 线');
    const bars:MarketBar[]=[];let cursor=start;
    const total=Math.ceil((end-start)/step);
    onProgress?.({completed:0,total,stage:'加载 Binance 永续合约历史行情'});
    while(cursor<end){
      signal?.throwIfAborted();
      const raw=await this.json(`/fapi/v1/klines?${new URLSearchParams({symbol,interval:wireInterval,startTime:String(cursor),endTime:String(end-1),limit:'1000'})}`,signal);
      if(!Array.isArray(raw))throw Error('Binance 返回了无效合约历史数据');
      if(!raw.length)break;
      const batch=raw.map(row=>{if(!Array.isArray(row)||row.length<7)throw Error('历史 K 线格式无效');return {time:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5])};});
      for(const bar of batch)if(bar.time>=cursor&&bar.time<end)bars.push(bar);
      const next=nextOpenTime(batch.at(-1)!.time,interval);if(next<=cursor)throw Error('历史行情分页未能前进');cursor=next;
      if(bars.length>MAX_HISTORY_BARS)throw Error('历史数据超过单次读取上限');
      onProgress?.({completed:bars.length,total,stage:'加载 Binance 永续合约历史行情'});
    }
    signal?.throwIfAborted();validateDatasetBars(bars,step);
    if(bars[0].time>Math.floor(from/step)*step||nextOpenTime(bars.at(-1)!.time,interval)<end)throw Error('所选日期的行情覆盖不完整，请调整范围后重试');
    onProgress?.({completed:bars.length,total:bars.length,stage:'校验合约标记价格'});
    const markPrices=await this.loadMarkPrices({symbol,interval,bars},signal);
    const dataset:DatasetSnapshot={source:'binance',marketType:'usdm-perpetual',symbol,interval,bars,markPrices,contract:metadata,tickSize:metadata.tickSize,quoteCurrency:metadata.quoteCurrency,timezone:'UTC'};
    dataset.id=await datasetFingerprint(dataset);
    // The namespace and explicit market identity keep legacy spot snapshots separate.
    if(to<=end)try{await this.persistence?.put('datasets',key,dataset);}catch{/* A real market snapshot remains available without a writable cache. */}
    return dataset;
  }
}
