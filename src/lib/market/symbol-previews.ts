import type {MarketSymbol} from '../watchlist/types';
import {BINANCE_FUTURES_REST} from './binance-contracts';
import {publicMarketRequest} from './public-transport';
import {connectorConfigStore} from './connector-config';

/** 24h snapshot shown next to a search result. */
export interface SymbolPreviewQuote {last:number;changePercent:number;high?:number;low?:number;volume?:number;quoteVolume?:number}
/** Recent closes for a sparkline: 96 × 15m ≈ the last 24 hours. */
export interface SymbolSpark {closes:number[];from:number;to:number}
export interface SymbolPreview {quote?:SymbolPreviewQuote;spark?:SymbolSpark;
  /** What the spark and change cover: a rolling 24h window, or recent sessions. */
  span:'24h'|'30d'}

export const SPARK_BARS=96;
const QUOTE_TTL=20_000,SPARK_TTL=120_000,MAX_PARALLEL=4;
type Fetcher=(input:string,init?:RequestInit)=>Promise<Response>;

const finite=(value:unknown)=>{const n=typeof value==='number'?value:typeof value==='string'&&value.trim()?Number(value):NaN;return Number.isFinite(n)?n:undefined;};

/** Binance USDⓈ-M `/fapi/v1/ticker/24hr` (all symbols) → quotes by symbol. */
export function parseBinanceTickers(rows:unknown):Map<string,SymbolPreviewQuote> {
  const out=new Map<string,SymbolPreviewQuote>();if(!Array.isArray(rows))return out;
  for(const row of rows as Record<string,unknown>[]){
    const symbol=typeof row?.symbol==='string'?row.symbol:undefined,last=finite(row?.lastPrice),changePercent=finite(row?.priceChangePercent);
    if(!symbol||last===undefined||!(last>0)||changePercent===undefined)continue;
    out.set(symbol,{last,changePercent,high:finite(row.highPrice),low:finite(row.lowPrice),volume:finite(row.volume),quoteVolume:finite(row.quoteVolume)});
  }
  return out;
}
/** OKX `/api/v5/market/tickers?instType=SWAP` → quotes by our symbol (BTCUSDT). */
export function parseOkxTickers(payload:unknown):Map<string,SymbolPreviewQuote> {
  const out=new Map<string,SymbolPreviewQuote>(),rows=(payload as {data?:unknown})?.data;if(!Array.isArray(rows))return out;
  for(const row of rows as Record<string,unknown>[]){
    const inst=typeof row?.instId==='string'?row.instId:'',match=/^([A-Z0-9]+)-([A-Z0-9]+)-SWAP$/.exec(inst);
    const last=finite(row?.last),open=finite(row?.open24h);if(!match||last===undefined||!(last>0)||!(open&&open>0))continue;
    out.set(`${match[1]}${match[2]}`,{last,changePercent:(last/open-1)*100,high:finite(row.high24h),low:finite(row.low24h),volume:finite(row.vol24h),quoteVolume:finite(row.volCcy24h)});
  }
  return out;
}
/** Time-ascending closes from [time, …, close at index `closeAt`, …] rows. */
export function sparkFromRows(rows:unknown,timeAt:number,closeAt:number,timeScale=1):SymbolSpark|undefined {
  if(!Array.isArray(rows))return undefined;
  const points=rows.map(row=>Array.isArray(row)?[finite(row[timeAt]),finite(row[closeAt])]:[undefined,undefined])
    .filter((p):p is [number,number]=>p[0]!==undefined&&p[1]!==undefined&&p[1]>0).map(([t,c])=>[t*timeScale,c] as [number,number]).sort((a,b)=>a[0]-b[0]).slice(-SPARK_BARS);
  if(points.length<2)return undefined;
  return {closes:points.map(p=>p[1]),from:points[0][0],to:points.at(-1)![0]};
}
/** A-share gateway `{bars:[{time,open,high,low,close,volume}]}` (daily): the
 * spark covers recent sessions and the change is last close vs previous close. */
export function parseGatewayBars(payload:unknown):{spark?:SymbolSpark;quote?:SymbolPreviewQuote} {
  const bars=(payload as {bars?:unknown})?.bars;if(!Array.isArray(bars))return {};
  const rows=bars.map(bar=>{const b=bar as Record<string,unknown>;return [finite(b?.time),finite(b?.open),finite(b?.high),finite(b?.low),finite(b?.close),finite(b?.volume)];});
  const spark=sparkFromRows(rows,0,4);if(!spark)return {};
  const valid=rows.filter(r=>r[0]!==undefined&&r[4]!==undefined&&r[4]>0).sort((a,b)=>a[0]!-b[0]!),last=valid.at(-1)!,previous=valid.at(-2)!;
  return {spark,quote:{last:last[4]!,changePercent:(last[4]!/previous[4]!-1)*100,high:last[2],low:last[3],volume:last[5]}};
}
/** 24h quote derived from a spark when a source has no bulk ticker. */
export function quoteFromSpark(spark:SymbolSpark):SymbolPreviewQuote {
  const first=spark.closes[0],last=spark.closes.at(-1)!;
  return {last,changePercent:(last/first-1)*100,high:Math.max(...spark.closes),low:Math.min(...spark.closes)};
}

/** Honor a user-configured endpoint (e.g. a regional proxy) for the source. */
function restBase(source:'okx'|'coinbase'|'cn-a',fallback:string):string {
  try{return (connectorConfigStore.get(source)?.restBase||fallback).replace(/\/+$/,'');}catch{return fallback;}
}
const okxInst=(item:MarketSymbol)=>`${item.baseAsset}-${item.quoteAsset}-SWAP`;
const coinbaseProduct=(item:MarketSymbol)=>item.symbol.includes('-')?item.symbol:`${item.baseAsset}-${item.quoteAsset}`;
export const previewKey=(item:Pick<MarketSymbol,'symbol'|'source'>)=>`${item.source??'binance'}:${item.symbol}`;

/**
 * Lazily loaded, cached market previews for the symbol search. Each source's
 * bulk ticker is requested at most once per TTL; sparklines are fetched per
 * symbol with bounded parallelism and de-duplicated in-flight requests, and
 * only for rows the caller asks about (visible rows and the highlighted item).
 */
export class SymbolPreviewStore {
  private quotes=new Map<string,{at:number;value:Map<string,SymbolPreviewQuote>}>();
  private quoteLoads=new Map<string,Promise<void>>();
  private sparks=new Map<string,{at:number;value?:SymbolSpark;quote?:SymbolPreviewQuote}>();
  private sparkLoads=new Map<string,Promise<void>>();
  private queue:Array<()=>void>=[];private running=0;
  private listeners=new Set<()=>void>();private revision=0;
  constructor(private fetcher:Fetcher=(input,init)=>publicMarketRequest(input,init),private now:()=>number=Date.now){}

  subscribe(listener:()=>void):()=>void {this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  get version(){return this.revision;}
  private changed(){this.revision++;for(const listener of this.listeners)listener();}

  /** Current preview (possibly partial); never triggers a request. */
  get(item:MarketSymbol):SymbolPreview {
    const source=item.source??'binance',entry=this.sparks.get(previewKey(item)),spark=entry?.value;
    const bulk=this.quotes.get(source)?.value.get(item.symbol);
    return {quote:bulk??entry?.quote??(spark?quoteFromSpark(spark):undefined),spark,span:source==='cn-a'?'30d':'24h'};
  }
  /** Ensure data for these items is loaded or loading. */
  request(items:readonly MarketSymbol[]):void {
    for(const source of new Set(items.map(item=>item.source??'binance')))this.loadQuotes(source);
    for(const item of items)this.loadSpark(item);
  }
  private loadQuotes(source:string){
    const cached=this.quotes.get(source);if(cached&&this.now()-cached.at<QUOTE_TTL||this.quoteLoads.has(source))return;
    const url=source==='binance'?`${BINANCE_FUTURES_REST}/fapi/v1/ticker/24hr`:source==='okx'?`${restBase('okx','https://www.okx.com')}/api/v5/market/tickers?instType=SWAP`:undefined;
    if(!url)return;
    const load=this.json(url).then(body=>{this.quotes.set(source,{at:this.now(),value:source==='binance'?parseBinanceTickers(body):parseOkxTickers(body)});this.changed();})
      .catch(()=>{this.quotes.set(source,{at:this.now()-QUOTE_TTL/2,value:cached?.value??new Map()});})
      .finally(()=>this.quoteLoads.delete(source));
    this.quoteLoads.set(source,load);
  }
  private loadSpark(item:MarketSymbol){
    const key=previewKey(item),cached=this.sparks.get(key);
    if(cached&&this.now()-cached.at<SPARK_TTL||this.sparkLoads.has(key))return;
    const url=this.sparkUrl(item);if(!url)return;
    const source=item.source??'binance';
    const load=new Promise<void>(resolve=>{this.queue.push(()=>{
      this.json(url).then(body=>{
        if(source==='cn-a'){const parsed=parseGatewayBars(body);this.sparks.set(key,{at:this.now(),value:parsed.spark,quote:parsed.quote});this.changed();return;}
        const rows=source==='okx'?(body as {data?:unknown})?.data:body;
        const spark=source==='coinbase'?sparkFromRows(rows,0,4,1000):sparkFromRows(rows,0,4);
        this.sparks.set(key,{at:this.now(),value:spark});this.changed();
      }).catch(()=>{this.sparks.set(key,{at:this.now()-SPARK_TTL/2,value:cached?.value,quote:cached?.quote});})
        .finally(()=>{this.running--;this.sparkLoads.delete(key);this.pump();resolve();});
    });this.pump();});
    this.sparkLoads.set(key,load);
  }
  private sparkUrl(item:MarketSymbol):string|undefined {
    const source=item.source??'binance';
    if(source==='binance')return `${BINANCE_FUTURES_REST}/fapi/v1/klines?symbol=${encodeURIComponent(item.symbol)}&interval=15m&limit=${SPARK_BARS}`;
    if(source==='okx')return `${restBase('okx','https://www.okx.com')}/api/v5/market/candles?instId=${encodeURIComponent(okxInst(item))}&bar=15m&limit=${SPARK_BARS}`;
    if(source==='coinbase')return `${restBase('coinbase','https://api.exchange.coinbase.com')}/products/${encodeURIComponent(coinbaseProduct(item))}/candles?granularity=900`;
    if(source==='cn-a')return `${restBase('cn-a','/api/market-data/cn-a')}/klines?symbol=${encodeURIComponent(item.symbol)}&interval=1d&limit=30`;
    return undefined;
  }
  private pump(){while(this.running<MAX_PARALLEL&&this.queue.length){this.running++;this.queue.shift()!();}}
  private async json(url:string):Promise<unknown>{
    const response=await this.fetcher(url,{signal:AbortSignal.timeout(8000),credentials:'omit'});
    if(!response.ok)throw Error(`HTTP ${response.status}`);
    return response.json();
  }
}

/** App-wide cache shared by every symbol search instance. */
export const symbolPreviews=new SymbolPreviewStore();

/** Compact price with precision that scales with magnitude. */
export function formatPreviewPrice(value:number|undefined,locale?:string):string {
  if(value===undefined||!Number.isFinite(value))return '—';
  const abs=Math.abs(value),digits=abs>=1000?2:abs>=1?Math.min(4,Math.max(2,4-Math.floor(Math.log10(abs)))):Math.min(8,Math.max(4,2-Math.floor(Math.log10(abs))+3));
  return value.toLocaleString(locale,{minimumFractionDigits:abs>=1000?2:Math.min(digits,2),maximumFractionDigits:digits});
}
/** Compact volume (K / M / B). */
export function formatPreviewVolume(value:number|undefined):string {
  if(value===undefined||!Number.isFinite(value))return '—';
  const abs=Math.abs(value);
  return abs>=1e9?`${(value/1e9).toFixed(2)}B`:abs>=1e6?`${(value/1e6).toFixed(2)}M`:abs>=1e3?`${(value/1e3).toFixed(1)}K`:value.toFixed(abs>=100?0:2);
}
