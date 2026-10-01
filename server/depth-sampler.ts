import type {IncomingMessage,ServerResponse} from 'node:http';
import type {DatabaseSync as Database} from 'node:sqlite';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {deflateSync,inflateSync} from 'node:zlib';
import NodeWebSocket from 'ws';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {createOrderBookSession,type BookSnapshot,type OrderBookSession,type OrderBookSessionOptions} from '../src/lib/flow/orderbook';
import {localPublicRequest} from './public-market';

// Vite/Vitest versions predating node:sqlite do not recognize it as a builtin.
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** One persisted, fine-binned depth sample (prices are bin index × bin). */
export interface StoredDepthSample {time:number;bin:number;bids:Array<[number,number]>;asks:Array<[number,number]>}
/** Heatmap history returned to the chart: samples re-bucketed to `step`. */
export interface DepthHistoryPayload {symbol:string;from:number;to:number;step:number;intervalMs:number;strideMs:number;samples:Array<{time:number;bids:Array<[number,number]>;asks:Array<[number,number]>}>}
export interface DepthSamplerOptions {
  directory?:string;proxy?:string;fetch?:typeof fetch;WebSocket?:OrderBookSessionOptions['WebSocket'];
  /** Sampling cadence; also the slot size of the primary key. */
  intervalMs?:number;retainMs?:number;maxSymbols?:number;now?:()=>number;
  createSession?:(options:OrderBookSessionOptions)=>Pick<OrderBookSession,'connect'|'disconnect'>;
}
/** Stored bins are 5e-4 of the price decade (BTC $5, ETH $0.5): every heatmap step is a whole number of them.
 * The window is ±4% of the mid; deeper levels are dust or too far to read on a chart. */
const SYMBOL=/^[A-Z0-9]{2,30}USDT$/,BIN_RATIO=5e-4,RANGE_RATIO=.04,BOOK_LEVELS=6000,FRESH_MS=5_000;

function proxiedSocket(proxy?:string){return class extends NodeWebSocket {
  constructor(url:string){super(url,{handshakeTimeout:10_000,perMessageDeflate:false,...(proxy?{agent:new HttpsProxyAgent(proxy)}:{})});this.on('error',()=>{});}
};}
/** Pool raw levels into decade-relative bins: [binIndex, quantity], nearest first. */
export function binLevels(levels:readonly {price:number;quantity:number}[],bin:number,side:'bid'|'ask'):Array<[number,number]> {
  const pooled=new Map<number,number>();
  for(const {price,quantity} of levels){
    if(!(price>0)||!(quantity>0))continue;
    const ratio=price/bin,epsilon=Number.EPSILON*Math.max(1,Math.abs(ratio))*8,index=side==='bid'?Math.floor(ratio+epsilon):Math.ceil(ratio-epsilon);
    pooled.set(index,(pooled.get(index)??0)+quantity);
  }
  return [...pooled].sort((a,b)=>side==='bid'?b[0]-a[0]:a[0]-b[0]);
}
/** [index:int32, quantity:float32]… deflated. ~8 bytes per bin before compression. */
export function packLevels(levels:ReadonlyArray<readonly [number,number]>):Buffer {
  const view=new DataView(new ArrayBuffer(levels.length*8));
  levels.forEach(([index,quantity],i)=>{view.setInt32(i*8,index,true);view.setFloat32(i*8+4,quantity,true);});
  return deflateSync(Buffer.from(view.buffer),{level:6});
}
export function unpackLevels(blob:Uint8Array):Array<[number,number]> {
  const raw=inflateSync(blob),view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength),out:Array<[number,number]>=[];
  for(let o=0;o+8<=raw.byteLength;o+=8)out.push([view.getInt32(o,true),view.getFloat32(o+4,true)]);
  return out;
}
/** Re-bucket fine bins to the heatmap step (bids floor, asks ceil). */
export function rebucket(levels:ReadonlyArray<readonly [number,number]>,bin:number,step:number,side:'bid'|'ask'):Array<[number,number]> {
  const out=new Map<number,number>();
  for(const [index,quantity] of levels){
    const ratio=index*bin/step,epsilon=Number.EPSILON*Math.max(1,Math.abs(ratio))*8,bucket=side==='bid'?Math.floor(ratio+epsilon):Math.ceil(ratio-epsilon);
    out.set(bucket,(out.get(bucket)??0)+quantity);
  }
  return [...out].sort((a,b)=>side==='bid'?b[0]-a[0]:a[0]-b[0]).map(([bucket,quantity])=>[Number((bucket*step).toPrecision(12)),quantity]);
}

/**
 * Local, always-on depth sampler: while the dev/preview server runs it keeps a
 * public Binance USDⓈ-M L2 book per watched symbol and stores one fine-binned
 * sample per slot. The chart heatmap then covers everything sampled since the
 * symbol was first watched — across reloads, intervals and restarts — instead
 * of only what one page observed. Past depth that was never sampled stays blank.
 */
export class DepthSampler {
  private db:Database;private sessions=new Map<string,{session:Pick<OrderBookSession,'connect'|'disconnect'>;latest?:BookSnapshot;timer:ReturnType<typeof setInterval>}>();
  private insert;private pruneTimer:ReturnType<typeof setInterval>;private closed=false;
  readonly intervalMs:number;private retainMs:number;private maxSymbols:number;private now:()=>number;
  constructor(private options:DepthSamplerOptions={}){
    this.intervalMs=Math.max(1000,Math.min(60_000,options.intervalMs??15_000));
    this.retainMs=Math.max(3_600_000,options.retainMs??2*86_400_000);
    this.maxSymbols=Math.max(1,Math.min(20,options.maxSymbols??3));this.now=options.now??Date.now;
    const directory=resolve(options.directory??'.data/depth');mkdirSync(directory,{recursive:true});
    this.db=new DatabaseSync(resolve(directory,'depth-samples.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS samples(symbol TEXT NOT NULL,slot INTEGER NOT NULL,t INTEGER NOT NULL,bin REAL NOT NULL,bids BLOB NOT NULL,asks BLOB NOT NULL,PRIMARY KEY(symbol,slot)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS watch(symbol TEXT PRIMARY KEY,added INTEGER NOT NULL,used INTEGER NOT NULL);`);
    this.insert=this.db.prepare('INSERT OR IGNORE INTO samples(symbol,slot,t,bin,bids,asks) VALUES(?,?,?,?,?,?)');
    for(const row of this.db.prepare('SELECT symbol FROM watch ORDER BY used DESC LIMIT ?').all(this.maxSymbols) as {symbol:string}[])this.start(row.symbol);
    this.pruneTimer=setInterval(()=>this.prune(),3_600_000);this.pruneTimer.unref?.();
  }
  /** Start (or keep) sampling a symbol; least-recently watched beyond the cap stop. */
  watch(symbol:string):{symbol:string;since:number;intervalMs:number} {
    if(this.closed)throw Error('深度采样服务已关闭');
    if(!SYMBOL.test(symbol))throw Error('仅支持 Binance USDⓈ-M 永续品种');
    const now=this.now();
    this.db.prepare('INSERT INTO watch(symbol,added,used) VALUES(?,?,?) ON CONFLICT(symbol) DO UPDATE SET used=excluded.used').run(symbol,now,now);
    this.start(symbol);
    const keep=new Set((this.db.prepare('SELECT symbol FROM watch ORDER BY used DESC LIMIT ?').all(this.maxSymbols) as {symbol:string}[]).map(row=>row.symbol));
    for(const running of [...this.sessions.keys()])if(!keep.has(running))this.stop(running);
    const since=(this.db.prepare('SELECT MIN(t) AS t FROM samples WHERE symbol=?').get(symbol) as {t:number|null}).t;
    return {symbol,since:since??now,intervalMs:this.intervalMs};
  }
  /** Store the current book as one sample (no-op unless live and fresh). */
  sample(symbol:string):boolean {
    const entry=this.sessions.get(symbol),book=entry?.latest,now=this.now();
    if(!book||book.status!=='live'||!book.lastReceivedAt||now-book.lastReceivedAt>FRESH_MS)return false;
    const best=book.bids[0]?.price??book.asks[0]?.price;if(!(best&&best>0))return false;
    const mid=book.bids[0]&&book.asks[0]?(book.bids[0].price+book.asks[0].price)/2:best,low=mid*(1-RANGE_RATIO),high=mid*(1+RANGE_RATIO);
    const bin=10**Math.floor(Math.log10(best))*BIN_RATIO;
    this.insert.run(symbol,Math.floor(now/this.intervalMs),now,bin,
      packLevels(binLevels(book.bids.filter(level=>level.price>=low),bin,'bid')),packLevels(binLevels(book.asks.filter(level=>level.price<=high),bin,'ask')));
    return true;
  }
  /** Samples in [from, to], decimated to at most `columns` and re-bucketed to `step`. */
  history(symbol:string,from:number,to:number,step:number,columns=480):DepthHistoryPayload {
    if(!SYMBOL.test(symbol))throw Error('无效品种');
    if(![from,to,step].every(Number.isFinite)||to<from||!(step>0))throw Error('无效时间范围或价格粒度');
    const limit=Math.max(16,Math.min(2000,Math.round(columns))),slots=Math.max(1,Math.ceil((to-from)/this.intervalMs)),stride=Math.max(1,Math.ceil(slots/limit));
    const rows=this.db.prepare('SELECT t,bin,bids,asks FROM samples WHERE symbol=? AND t BETWEEN ? AND ? AND slot % ? = 0 ORDER BY t').all(symbol,from,to,stride) as {t:number;bin:number;bids:Uint8Array;asks:Uint8Array}[];
    return {symbol,from,to,step,intervalMs:this.intervalMs,strideMs:stride*this.intervalMs,
      samples:rows.map(row=>({time:row.t,bids:rebucket(unpackLevels(row.bids),row.bin,step,'bid'),asks:rebucket(unpackLevels(row.asks),row.bin,step,'ask')}))};
  }
  prune():number {return Number(this.db.prepare('DELETE FROM samples WHERE t < ?').run(this.now()-this.retainMs).changes);}
  close(){if(this.closed)return;this.closed=true;clearInterval(this.pruneTimer);for(const symbol of [...this.sessions.keys()])this.stop(symbol);this.db.close();}
  private start(symbol:string){
    if(this.sessions.has(symbol)||this.closed)return;
    const entry:{session:Pick<OrderBookSession,'connect'|'disconnect'>;latest?:BookSnapshot;timer:ReturnType<typeof setInterval>}={} as never;
    const make=this.options.createSession??createOrderBookSession;
    entry.session=make({symbol,limit:BOOK_LEVELS,horizonRatio:RANGE_RATIO,fetch:this.options.fetch??fetch,WebSocket:this.options.WebSocket??proxiedSocket(this.options.proxy) as unknown as OrderBookSessionOptions['WebSocket'],onUpdate:snapshot=>{entry.latest=snapshot;}});
    entry.timer=setInterval(()=>{try{this.sample(symbol);}catch{/* A locked or full disk never stops the chart. */}},this.intervalMs);entry.timer.unref?.();
    this.sessions.set(symbol,entry);void entry.session.connect();
  }
  private stop(symbol:string){const entry=this.sessions.get(symbol);if(!entry)return;clearInterval(entry.timer);entry.session.disconnect();this.sessions.delete(symbol);}
}

const PREFIX='/api/depth-samples';
/** Loopback-only HTTP routes: POST /watch {symbol}; GET ?symbol&from&to&step&columns. */
export function createDepthSamplerHandler(options:DepthSamplerOptions={}){
  let sampler:DepthSampler|undefined,failure='';
  try{sampler=new DepthSampler(options);}catch(error){failure=error instanceof Error?error.message:String(error);}
  const handler=async(request:IncomingMessage,response:ServerResponse,next:()=>void)=>{
    const url=new URL(request.url??'/','http://localhost');
    if(url.pathname!==PREFIX&&!url.pathname.startsWith(PREFIX+'/'))return next();
    const reply=(status:number,body:unknown)=>{response.statusCode=status;response.setHeader('Content-Type','application/json; charset=utf-8');response.setHeader('Cache-Control','no-store');response.end(JSON.stringify(body));};
    try{
      if(!localPublicRequest(request))return reply(403,{message:'仅允许本机页面访问'});
      if(!sampler)return reply(503,{message:failure||'深度采样服务不可用'});
      if(request.method==='POST'&&url.pathname===PREFIX+'/watch'){
        let text='';for await(const chunk of request){text+=chunk;if(text.length>4096)throw Error('请求过大');}
        return reply(200,sampler.watch(String((JSON.parse(text||'{}') as {symbol?:unknown}).symbol??'')));
      }
      if(request.method==='GET'&&url.pathname===PREFIX){
        const q=url.searchParams;
        return reply(200,sampler.history(q.get('symbol')??'',Number(q.get('from')),Number(q.get('to')),Number(q.get('step')),Number(q.get('columns')??480)));
      }
      return reply(404,{message:'未知接口'});
    }catch(error){reply(400,{message:error instanceof Error?error.message:'请求失败'});}
  };
  return Object.assign(handler,{close:()=>sampler?.close(),sampler:()=>sampler});
}
