import {createRequire} from 'node:module';
import type {DatabaseSync as Database} from 'node:sqlite';
import {mkdirSync,openSync,closeSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Level2Book,type BookLevel} from '../src/lib/flow/orderbook';
import type {AggregateTrade} from '../src/lib/flow/types';
import type {DatasetInfo,DatasetCoverage,ImportJob,RecordedMarketEvent,RecordedGap,StoredTradePage,ReplayBook,ReplaySnapshot,DepthHeatmap} from '../src/lib/flow/persistence-client';
import type {HistoricalAggregateOptions} from '../src/lib/flow/persistence-client';
import type {MarketSymbol} from '../src/lib/watchlist/types';
import {BINANCE_DEFAULT_SYMBOLS,OKX_DEFAULT_SYMBOLS,COINBASE_DEFAULT_SYMBOLS,CN_A_SHARE_SYMBOLS} from '../src/lib/market/connectors';
import {CURATED_CN_A_SYMBOLS} from './cn-ashare';
import {aggregateStoredTrades} from './market-aggregate';
import {HeatmapScheduler,yieldHeatmap} from './market-heatmap';

export interface StoredConnectorConfig {
  source:string;
  id?:string;
  enabled:boolean;
  mode?:'auto'|'live'|'simulation';
  restBase?:string;
  wsUrl?:string;
  defaultSymbol?:string;
  updatedAt?:number;
}

const key=(id:string)=>{if(!/^\d{1,25}$/.test(id))throw Error('无效成交 ID');return BigInt(id).toString().padStart(25,'0');};
const validId=(id:string)=>{if(!/^[\da-f-]{36}$/.test(id))throw Error('无效本地数据 ID');return id;};
const validSource=(source:string)=>{if(typeof source!=='string'||!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(source.trim()))throw Error('无效行情来源标识');return source.trim().toLowerCase();};
const timestamp=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
// Vite/Vitest versions predating node:sqlite do not recognize it as a builtin
// during static import resolution. Resolve through Node only on the server.
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
function validateTrade(trade:AggregateTrade,symbol:string){
  if(!trade||trade.symbol!==symbol||!timestamp(trade.time)||![trade.price,trade.baseQuantity,trade.quoteQuantity].every(v=>Number.isFinite(v)&&v>0)||!['buy','sell'].includes(trade.aggressor))throw Error('无效录制成交');key(trade.id);
  if(trade.normalBaseQuantity!==undefined&&(!Number.isFinite(trade.normalBaseQuantity)||trade.normalBaseQuantity<0||trade.normalBaseQuantity>trade.baseQuantity))throw Error('无效普通成交数量');
}
function validLevels(levels:BookLevel[]){return Array.isArray(levels)&&levels.length<=10000&&levels.every(p=>p&&Number.isFinite(p.price)&&p.price>0&&Number.isFinite(p.quantity)&&p.quantity>=0);}
export class MarketStore {
  private db!:Database;private lockPath:string;private lockToken=randomUUID();private closed=false;
  private readonly heatmaps=new HeatmapScheduler();
  constructor(readonly directory:string){
    mkdirSync(directory,{recursive:true,mode:0o700});this.lockPath=resolve(directory,'writer.lock');this.acquire();
    try{this.db=new DatabaseSync(resolve(directory,'market.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY,symbol TEXT NOT NULL,created INTEGER NOT NULL,meta TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,meta TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trades(dataset TEXT NOT NULL,k TEXT NOT NULL,t INTEGER NOT NULL,p REAL NOT NULL,q REAL NOT NULL,quote REAL NOT NULL,side TEXT NOT NULL,received INTEGER NOT NULL,normal REAL,PRIMARY KEY(dataset,k)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS trades_time ON trades(dataset,t,k);
      CREATE TABLE IF NOT EXISTS gaps(dataset TEXT NOT NULL,lo TEXT NOT NULL,hi TEXT NOT NULL,meta TEXT NOT NULL,PRIMARY KEY(dataset,lo,hi)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS depth_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,dataset TEXT NOT NULL,t INTEGER NOT NULL,received INTEGER NOT NULL,kind TEXT NOT NULL,eventkey TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(dataset,eventkey));
      CREATE INDEX IF NOT EXISTS depth_time ON depth_events(dataset,t,seq);
      CREATE INDEX IF NOT EXISTS depth_snapshot ON depth_events(dataset,kind,t,seq);
      CREATE TABLE IF NOT EXISTS symbols(
        source TEXT NOT NULL,
        symbol TEXT NOT NULL,
        base_asset TEXT NOT NULL,
        quote_asset TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        market_type TEXT NOT NULL DEFAULT '',
        exchange_label TEXT NOT NULL DEFAULT '',
        market_badge TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        meta TEXT NOT NULL,
        PRIMARY KEY(source,symbol)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS symbols_source_quote ON symbols(source,quote_asset,symbol);
      CREATE INDEX IF NOT EXISTS symbols_lookup ON symbols(symbol,source);
      CREATE TABLE IF NOT EXISTS connector_configs(
        source TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        config TEXT NOT NULL
      ) WITHOUT ROWID;
      PRAGMA user_version=3;`);
    this.seedDefaultSymbols();
    for(const dataset of this.list(undefined,10000))if(['recording','importing'].includes(dataset.state)){
      const stoppedAt=dataset.recordedThrough??dataset.throughTime??dataset.createdAt,pauses=[...(dataset.recordingPauses??[])];
      if(dataset.kind==='recording'&&(!pauses.length||pauses.at(-1)!.toTime!==undefined))pauses.push({fromTime:stoppedAt+1,notedAt:Date.now(),reason:'服务重启发现录制中断；最后已持久化接收时刻之后的L2覆盖未知。'});
      this.update({...dataset,state:dataset.kind==='recording'?'stopped':'failed',stoppedAt,...(dataset.kind==='recording'?{recordingPauses:pauses}:{}),warning:'本地服务重启；上次任务中断，已保存数据可读，未自动恢复订阅。'});
    }
    for(const row of this.db.prepare('SELECT meta FROM jobs').all()){const job=JSON.parse(String(row.meta)) as ImportJob;if(['running','queued'].includes(job.status))this.putJob({...job,status:'failed',message:'服务重启中断；可重新提交日期范围，已完成档案会复用。'});}
    }catch(error){this.db?.close();this.release();throw error;}
  }
  private acquire(){
    for(let attempt=0;attempt<2;attempt++)try{const fd=openSync(this.lockPath,'wx',0o600);try{writeFileSync(fd,JSON.stringify({pid:process.pid,token:this.lockToken}));}finally{closeSync(fd);}return;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      let owner:{pid:number};try{owner=JSON.parse(readFileSync(this.lockPath,'utf8'));if(!Number.isInteger(owner.pid)||owner.pid<=0)throw Error();}catch{throw Error('行情写入锁格式无效，请检查该目录是否已有服务。');}
      try{process.kill(owner.pid,0);throw Error('已有本地行情服务占用此目录，请停止另一端口的服务后重试。');}
      catch(reason){if((reason as NodeJS.ErrnoException).code!=='ESRCH')throw reason;unlinkSync(this.lockPath);}
    }
    throw Error('无法取得本地行情写入锁');
  }
  private release(){try{const lock=JSON.parse(readFileSync(this.lockPath,'utf8'));if(lock.token===this.lockToken)unlinkSync(this.lockPath);}catch{/* A stale lock may be cleaned after its owner exits. */}}
  close(){if(this.closed)return;this.closed=true;this.heatmaps.close();try{this.db.close();}finally{this.release();}}
  create(input:Pick<DatasetInfo,'symbol'|'kind'|'tradeType'|'state'|'source'>&Partial<DatasetInfo>):DatasetInfo {
    const value:DatasetInfo={...input,id:randomUUID(),createdAt:Date.now(),tradeCount:0,depthCount:0,gapCount:0};
    this.db.prepare('INSERT INTO datasets VALUES(?,?,?,?)').run(value.id,value.symbol,value.createdAt,JSON.stringify(value));return value;
  }
  get(id:string):DatasetInfo {const row=this.db.prepare('SELECT meta FROM datasets WHERE id=?').get(validId(id));if(!row)throw Error('本地数据不存在');return JSON.parse(String(row.meta));}
  latestTradeId(id:string):string|undefined {this.get(id);const row=this.db.prepare('SELECT k FROM trades WHERE dataset=? ORDER BY k DESC LIMIT 1').get(id);return row?BigInt(String(row.k)).toString():undefined;}
  update(info:DatasetInfo){this.db.prepare('UPDATE datasets SET meta=? WHERE id=?').run(JSON.stringify(info),validId(info.id));return info;}
  list(symbol?:string,limit=500,offset=0):DatasetInfo[]{
    const rows=symbol?this.db.prepare('SELECT meta FROM datasets WHERE symbol=? ORDER BY created DESC LIMIT ? OFFSET ?').all(symbol,limit,offset):this.db.prepare('SELECT meta FROM datasets ORDER BY created DESC LIMIT ? OFFSET ?').all(limit,offset);
    return rows.map(row=>JSON.parse(String(row.meta)));
  }
  findChecksum(checksum:string,symbol:string):DatasetInfo|undefined{return this.list(symbol,10000).find(d=>d.state==='complete'&&d.checksum===checksum);}
  putJob(job:ImportJob){this.db.prepare('INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta').run(job.id,JSON.stringify(job));return job;}
  listJobs(limit=100,offset=0):ImportJob[]{
    limit=Math.max(1,Math.min(500,Math.floor(limit)));offset=Math.max(0,Math.floor(offset));if(!Number.isFinite(limit)||!Number.isFinite(offset))throw Error('无效任务分页');
    return this.db.prepare("SELECT meta FROM jobs ORDER BY CASE WHEN json_extract(meta,'$.status') IN ('running','queued') THEN 0 ELSE 1 END,json_extract(meta,'$.createdAt') DESC LIMIT ? OFFSET ?").all(limit,offset).map(row=>JSON.parse(String(row.meta)));
  }
  getJob(id:string):ImportJob {const row=this.db.prepare('SELECT meta FROM jobs WHERE id=?').get(validId(id));if(!row)throw Error('导入任务不存在');return JSON.parse(String(row.meta));}
  private transaction<T>(run:()=>T):T {this.db.exec('BEGIN');try{const result=run();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  writeTrades(id:string,rows:readonly (AggregateTrade&{receivedAt?:number})[],receivedAt=Date.now()):number {
    const info=this.get(id);if(rows.length>5000)throw Error('单批成交最多 5000 条');rows.forEach(row=>validateTrade(row,info.symbol));
    const insert=this.db.prepare('INSERT OR IGNORE INTO trades VALUES(?,?,?,?,?,?,?,?,?)');
    const bounds=this.db.prepare('SELECT k,t FROM trades WHERE dataset=? ORDER BY k DESC LIMIT 1').get(id),first=this.db.prepare('SELECT k,t FROM trades WHERE dataset=? ORDER BY k LIMIT 1').get(id);
    let maximum=bounds?BigInt(String(bounds.k)):undefined,lastTime=bounds?Number(bounds.t):undefined,minimum=first?BigInt(String(first.k)):undefined,firstTime=first?Number(first.t):undefined,count=0;
    return this.transaction(()=>{
      for(const trade of rows){const k=key(trade.id),value=BigInt(trade.id);
        const written=insert.run(id,k,trade.time,trade.price,trade.baseQuantity,trade.quoteQuantity,trade.aggressor,trade.receivedAt??receivedAt,trade.normalBaseQuantity??null);
        if(!written.changes){const old=this.db.prepare('SELECT t,p,q,quote,side FROM trades WHERE dataset=? AND k=?').get(id,k)!;
          if(old.t!==trade.time||old.p!==trade.price||old.q!==trade.baseQuantity||old.quote!==trade.quoteQuantity||old.side!==trade.aggressor)throw Error('同一成交 ID 内容冲突；未覆盖已有数据');continue;}
        count++;info.fromTime=Math.min(info.fromTime??Infinity,trade.time);info.throughTime=Math.max(info.throughTime??0,trade.time);info.recordedThrough=Math.max(info.recordedThrough??0,trade.receivedAt??receivedAt);
        if(maximum!==undefined&&value>maximum+1n){const gap:RecordedGap={channel:'trades',fromId:String(maximum+1n),toId:String(value-1n),afterTime:lastTime!,beforeTime:trade.time,reason:'记录的成交 ID 不连续；不能视为完整区间'};
          this.db.prepare('INSERT OR IGNORE INTO gaps VALUES(?,?,?,?)').run(id,key(gap.fromId!),key(gap.toId!),JSON.stringify(gap));}
        if(maximum===undefined||value>maximum){maximum=value;lastTime=trade.time;}
        else this.fillGap(id,value,trade.time);
        if(minimum!==undefined&&value<minimum-1n){const gap:RecordedGap={channel:'trades',fromId:String(value+1n),toId:String(minimum-1n),afterTime:trade.time,beforeTime:firstTime!,reason:'记录的成交 ID 不连续；不能视为完整区间'};this.db.prepare('INSERT OR IGNORE INTO gaps VALUES(?,?,?,?)').run(id,key(gap.fromId!),key(gap.toId!),JSON.stringify(gap));}
        if(minimum===undefined||value<minimum){minimum=value;firstTime=trade.time;}
      }
      info.tradeCount+=count;info.gapCount=Number(this.db.prepare('SELECT COUNT(*) AS n FROM gaps WHERE dataset=?').get(id)!.n)+this.depthGapCount(id);this.update(info);return count;
    });
  }
  private fillGap(id:string,value:bigint,time:number){
    const k=key(String(value)),rows=this.db.prepare('SELECT lo,hi,meta FROM gaps WHERE dataset=? AND lo<=? AND hi>=?').all(id,k,k);
    for(const row of rows){const gap=JSON.parse(String(row.meta)) as RecordedGap,lo=BigInt(String(row.lo)),hi=BigInt(String(row.hi));
      this.db.prepare('DELETE FROM gaps WHERE dataset=? AND lo=? AND hi=?').run(id,String(row.lo),String(row.hi));
      for(const next of [value>lo?{...gap,toId:String(value-1n),beforeTime:time}:null,value<hi?{...gap,fromId:String(value+1n),afterTime:time}:null])if(next)this.db.prepare('INSERT INTO gaps VALUES(?,?,?,?)').run(id,key(next.fromId!),key(next.toId!),JSON.stringify(next));
    }
  }
  private depthGapCount(id:string){return Number(this.db.prepare("SELECT COUNT(*) AS n FROM depth_events WHERE dataset=? AND kind='gap'").get(id)!.n);}
  append(id:string,events:readonly RecordedMarketEvent[]):DatasetInfo {
    const info=this.get(id);if(info.kind!=='recording'||info.state!=='recording')throw Error('录制已经停止');if(events.length>1000)throw Error('单批最多 1000 个录制事件');
    for(const event of events){
      if(!event||!timestamp(event.receivedAt))throw Error('无效录制接收时间');
      if(event.kind==='aggTrade')validateTrade(event.trade,info.symbol);
      else if(!timestamp(event.time))throw Error('无效深度时间');
      else if(event.kind==='gap'){if(typeof event.reason!=='string'||event.reason.length>300)throw Error('无效缺口说明');}
      else if(event.kind==='depth-snapshot'){if(!timestamp(event.lastUpdateId)||!validLevels(event.bids)||!validLevels(event.asks)||event.origin!==undefined&&!['rest','checkpoint'].includes(event.origin))throw Error('无效深度快照');}
      else if(event.kind==='depth-diff'){if(![event.U,event.u,event.pu].every(timestamp)||event.U>event.u||!validLevels(event.bids)||!validLevels(event.asks))throw Error('无效深度差分');}
      else throw Error('不支持的录制事件');
    }
    const trades=events.filter((e):e is Extract<RecordedMarketEvent,{kind:'aggTrade'}>=>e.kind==='aggTrade');
    if(trades.length)this.writeTrades(id,trades.map(e=>({...e.trade,receivedAt:e.receivedAt})),trades[0].receivedAt);
    const current=this.get(id),insert=this.db.prepare('INSERT OR IGNORE INTO depth_events(dataset,t,received,kind,eventkey,payload) VALUES(?,?,?,?,?,?)');
    return this.transaction(()=>{
      for(const event of events){if(event.kind==='aggTrade')continue;
        const payload=JSON.stringify(event),hash=createHash('sha256').update(payload).digest('hex');const written=insert.run(id,event.time,event.receivedAt,event.kind,hash,payload);
        if(written.changes){current.depthCount++;current.fromTime=Math.min(current.fromTime??Infinity,event.time);current.throughTime=Math.max(current.throughTime??0,event.time);current.recordedThrough=Math.max(current.recordedThrough??0,event.receivedAt);}}
      current.gapCount=Number(this.db.prepare('SELECT COUNT(*) AS n FROM gaps WHERE dataset=?').get(id)!.n)+this.depthGapCount(id);return this.update(current);
    });
  }
  coverage(id:string):DatasetCoverage {
    const dataset=this.get(id),gaps=this.db.prepare('SELECT meta FROM gaps WHERE dataset=? ORDER BY lo LIMIT 500').all(id).map(row=>JSON.parse(String(row.meta)) as RecordedGap);
    const depth=this.db.prepare("SELECT t,payload FROM depth_events WHERE dataset=? AND kind='gap' ORDER BY seq LIMIT 500").all(id).map(row=>{const e=JSON.parse(String(row.payload));return {channel:e.channel??'depth',afterTime:Number(row.t),beforeTime:Number(row.t),reason:e.reason} as RecordedGap;});
    const pauses=(dataset.recordingPauses??[]).map(pause=>({channel:'depth' as const,afterTime:pause.fromTime,beforeTime:pause.toTime??Math.max(pause.fromTime,Date.now()),reason:pause.reason})),all=[...gaps,...pauses,...depth];
    return {dataset,gaps:all.slice(0,500),gapsTruncated:all.length>500||dataset.gapCount>500,note:'档案只覆盖其文件日期；录制仅覆盖实际收到并落盘的事件。暂停区间的L2不能回补；成交是否补齐单独依照实际ID缺口。ID 连续不是所有历史完整性的保证。'};
  }
  trades(id:string,options:{from?:number;to?:number;limit?:number;cursor?:string}={}):StoredTradePage {
    const coverage=this.coverage(id);if(coverage.dataset.kind==='archive'&&coverage.dataset.state!=='complete')throw Error('档案尚未完成校验导入');
    const from=options.from??0,to=options.to??Number.MAX_SAFE_INTEGER,limit=Math.max(1,Math.min(5000,Math.floor(options.limit??1000)));if(!timestamp(from)||!timestamp(to)||to<from||!Number.isFinite(limit))throw Error('无效查询区间');
    let cursorTime=-1,cursorId='';if(options.cursor){if(options.cursor.length>200)throw Error('无效分页游标');try{const c=JSON.parse(Buffer.from(options.cursor,'base64url').toString());if(!Array.isArray(c)||!timestamp(c[0])||typeof c[1]!=='string'||!/^\d{25}$/.test(c[1]))throw Error();[cursorTime,cursorId]=c;}catch{throw Error('无效分页游标');}}
    const rows=this.db.prepare('SELECT * FROM trades WHERE dataset=? AND t>=? AND t<=? AND (t>? OR (t=? AND k>?)) ORDER BY t,k LIMIT ?').all(id,from,to,cursorTime,cursorTime,cursorId,limit+1);
    const more=rows.length>limit,page=rows.slice(0,limit),last=page.at(-1);
    return {datasetId:id,rows:page.map(row=>({symbol:coverage.dataset.symbol,id:BigInt(String(row.k)).toString(),time:Number(row.t),price:Number(row.p),baseQuantity:Number(row.q),quoteQuantity:Number(row.quote),aggressor:row.side as 'buy'|'sell',...(row.normal!==null?{normalBaseQuantity:Number(row.normal)}:{})})),...(more&&last?{nextCursor:Buffer.from(JSON.stringify([last.t,last.k])).toString('base64url')} :{}),fromTime:from,toTime:to,coverage};
  }
  replayBook(id:string,at:number,limit=50):ReplayBook {
    const info=this.get(id);if(!timestamp(at))throw Error('无效回放时间');limit=Math.max(1,Math.min(1000,Math.floor(limit)));
    if(info.state!=='recording'&&at>(info.stoppedAt??info.recordedThrough??info.throughTime??0))return {status:'unavailable',bids:[],asks:[],warning:'超出已录制时间，不能把最后一帧订单簿延伸成未录制的历史。'};
    const pause=info.recordingPauses?.find(p=>at>=p.fromTime&&(p.toTime===undefined||at<p.toTime));
    if(pause)return {status:'gap',bids:[],asks:[],warning:`录制暂停区间；${pause.reason} 未用恢复后的快照倒填历史。`};
    const snapshot=this.db.prepare("SELECT seq,payload FROM depth_events WHERE dataset=? AND kind='depth-snapshot' AND t<=? AND received<=? ORDER BY seq DESC LIMIT 1").get(id,at,at);
    if(!snapshot)return {status:'unavailable',bids:[],asks:[],warning:'此时没有录制快照，不能从当前订单簿倒推历史。'};
    const saved=JSON.parse(String(snapshot.payload)) as Extract<RecordedMarketEvent,{kind:'depth-snapshot'}>,book=new Level2Book();book.load(saved);
    if(saved.origin==='checkpoint')book.apply({firstUpdateId:saved.lastUpdateId,lastUpdateId:saved.lastUpdateId,previousUpdateId:saved.lastUpdateId,time:saved.time,bids:[],asks:[]});
    const events=this.db.prepare('SELECT kind,payload FROM depth_events WHERE dataset=? AND seq>? AND t<=? AND received<=? ORDER BY seq LIMIT 25001').all(id,snapshot.seq!,at,at);
    if(events.length>25000)return {status:'truncated',bids:[],asks:[],warning:'回放差分过多，需要较近的录制快照；未截取部分簿伪装完整。'};
    for(const row of events){const e=JSON.parse(String(row.payload)) as Exclude<RecordedMarketEvent,{kind:'aggTrade'}>;
      if(e.kind==='gap'&&(e.channel??'depth')==='depth')return {status:'gap',bids:[],asks:[],warning:e.reason};
      if(e.kind==='depth-diff'&&book.apply({firstUpdateId:e.U,lastUpdateId:e.u,previousUpdateId:e.pu,time:e.time,bids:e.bids,asks:e.asks})==='gap')return {status:'gap',bids:[],asks:[],warning:'历史差分序列不连续；此处保持空白。'};
    }
    return book.ready?{status:'available',...book.levels(limit),time:book.updatedAt,lastUpdateId:book.lastUpdateId!}:{status:'unavailable',bids:[],asks:[],warning:'快照尚未接续经过验证的增量。'};
  }
  replay(id:string,at:number,limit=200):ReplaySnapshot {
    const page=this.trades(id,{from:Math.max(0,at-60_000),to:at,limit});return{datasetId:id,at,book:this.replayBook(id,at,Math.min(limit,1000)),trades:page.rows,coverage:page.coverage};
  }
  async heatmap(id:string,from:number,to:number,samples=120,levels=30,signal?:AbortSignal):Promise<DepthHeatmap>{
    if(!timestamp(from)||!timestamp(to)||to<from)throw Error('无效热图区间');samples=Math.max(2,Math.min(256,Math.floor(samples)));levels=Math.max(1,Math.min(100,Math.floor(levels)));if(!Number.isFinite(samples)||!Number.isFinite(levels))throw Error('无效采样参数');
    this.get(id);
    return this.heatmaps.run(async active=>{
      // Preserve replayBook's two clocks and seq ordering. A late low-seq event
      // requires rebuilding; monotonically appended eligible events can advance
      // one verified book. Prepared probes count first so truncation still takes
      // precedence over an earlier gap, exactly as in replayBook.
      const snapshotAt=this.db.prepare("SELECT seq,payload FROM depth_events WHERE dataset=? AND kind='depth-snapshot' AND t<=? AND received<=? ORDER BY seq DESC LIMIT 1");
      const allSequences=this.db.prepare('SELECT seq FROM depth_events WHERE dataset=? AND seq>? AND t<=? AND received<=? ORDER BY seq LIMIT 25001');
      const newSequences=this.db.prepare('SELECT seq FROM depth_events WHERE dataset=? AND seq>? AND t<=? AND received<=? AND (t>? OR received>?) ORDER BY seq LIMIT 25001');
      const page=this.db.prepare('SELECT seq,payload FROM depth_events WHERE dataset=? AND seq>? AND seq<=? AND t<=? AND received<=? ORDER BY seq LIMIT 512');
      type Cursor={snapshot:number;depthCount:number;lastAt:number;lastSeq:number;count:number;book:Level2Book;failure?:ReplayBook};
      let cursor:Cursor|undefined,lastYield=performance.now();
      const checkpoint=async()=>{await yieldHeatmap(active);lastYield=performance.now();};
      const atTime=async(at:number):Promise<ReplayBook>=>{
        active.throwIfAborted();const info=this.get(id);
        if(info.state!=='recording'&&at>(info.stoppedAt??info.recordedThrough??info.throughTime??0))return {status:'unavailable',bids:[],asks:[],warning:'超出已录制时间，不能把最后一帧订单簿延伸成未录制的历史。'};
        const pause=info.recordingPauses?.find(p=>at>=p.fromTime&&(p.toTime===undefined||at<p.toTime));
        if(pause)return {status:'gap',bids:[],asks:[],warning:`录制暂停区间；${pause.reason} 未用恢复后的快照倒填历史。`};
        const snapshot=snapshotAt.get(id,at,at);
        if(!snapshot)return {status:'unavailable',bids:[],asks:[],warning:'此时没有录制快照，不能从当前订单簿倒推历史。'};
        const seq=Number(snapshot.seq),rebuild=()=>{
          const saved=JSON.parse(String(snapshot.payload)) as Extract<RecordedMarketEvent,{kind:'depth-snapshot'}>,book=new Level2Book();book.load(saved);
          if(saved.origin==='checkpoint')book.apply({firstUpdateId:saved.lastUpdateId,lastUpdateId:saved.lastUpdateId,previousUpdateId:saved.lastUpdateId,time:saved.time,bids:[],asks:[]});
          cursor={snapshot:seq,depthCount:info.depthCount,lastAt:at,lastSeq:seq,count:0,book};
        };
        let full=!cursor||cursor.snapshot!==seq||cursor.depthCount!==info.depthCount;
        let sequences=full?allSequences.all(id,seq,at,at):newSequences.all(id,seq,at,at,cursor!.lastAt,cursor!.lastAt);
        if(!full&&sequences.length&&Number(sequences[0].seq)<=cursor!.lastSeq){full=true;sequences=allSequences.all(id,seq,at,at);}
        if(full)rebuild();
        const current=cursor!,through=sequences.length?Number(sequences.at(-1)!.seq):current.lastSeq;
        current.count+=sequences.length;current.depthCount=info.depthCount;current.lastAt=at;
        if(current.count>25000)current.failure={status:'truncated',bids:[],asks:[],warning:'回放差分过多，需要较近的录制快照；未截取部分簿伪装完整。'};
        while(!current.failure&&current.lastSeq<through){
          active.throwIfAborted();const rows=page.all(id,current.lastSeq,through,at,at);if(!rows.length)break;
          for(let i=0;i<rows.length;i++){
            const row=rows[i],e=JSON.parse(String(row.payload)) as Exclude<RecordedMarketEvent,{kind:'aggTrade'}>;current.lastSeq=Number(row.seq);
            if(e.kind==='gap'&&(e.channel??'depth')==='depth'){current.failure={status:'gap',bids:[],asks:[],warning:e.reason};break;}
            if(e.kind==='depth-diff'&&current.book.apply({firstUpdateId:e.U,lastUpdateId:e.u,previousUpdateId:e.pu,time:e.time,bids:e.bids,asks:e.asks})==='gap'){
              current.failure={status:'gap',bids:[],asks:[],warning:'历史差分序列不连续；此处保持空白。'};break;
            }
            if(i%64===63&&performance.now()-lastYield>=4)await checkpoint();
          }
          if(performance.now()-lastYield>=4)await checkpoint();
        }
        // Failure is sticky only within this exact eligible seq prefix. A late
        // insertion or a newly eligible snapshot rebuilds above before reuse.
        current.lastSeq=through;
        if(current.failure)return {...current.failure,bids:[],asks:[]};
        return current.book.ready?{status:'available',...current.book.levels(levels),time:current.book.updatedAt,lastUpdateId:current.book.lastUpdateId!}:{status:'unavailable',bids:[],asks:[],warning:'快照尚未接续经过验证的增量。'};
      };
      const output:DepthHeatmap['samples']=[];
      for(let i=0;i<samples;i++){
        active.throwIfAborted();const time=Math.round(from+(to-from)*i/(samples-1));output.push({time,book:await atTime(time)});
        if(i%8===7||performance.now()-lastYield>=4)await checkpoint();
      }
      active.throwIfAborted();return {datasetId:id,fromTime:from,toTime:to,samples:output,note:'仅按已录制快照与连续差分采样；没有快照或发生缺口的时间为空白。L2 是聚合档位，不是逐订单 MBO。'};
    },signal);
  }
  aggregate(id:string,options:HistoricalAggregateOptions,signal?:AbortSignal){this.get(id);return aggregateStoredTrades(resolve(this.directory,'market.sqlite'),id,options,signal);}
  private seedDefaultSymbols():void {
    const defaults:readonly MarketSymbol[]=[
      ...BINANCE_DEFAULT_SYMBOLS,
      ...OKX_DEFAULT_SYMBOLS,
      ...COINBASE_DEFAULT_SYMBOLS,
      ...CN_A_SHARE_SYMBOLS,
      ...CURATED_CN_A_SYMBOLS,
    ];
    const insert=this.db.prepare('INSERT OR IGNORE INTO symbols(source,symbol,base_asset,quote_asset,name,market_type,exchange_label,market_badge,updated_at,meta) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const now=Date.now();
    this.transaction(()=>{
      for(const item of defaults){
        const source=validSource(item.source??'binance');
        const symbol=item.symbol.trim().toUpperCase();
        const record:MarketSymbol={...item,source,symbol,updatedAt:item.updatedAt??now};
        insert.run(
          source,
          symbol,
          record.baseAsset,
          record.quoteAsset,
          record.name??'',
          record.marketType??'',
          record.exchangeLabel??source.toUpperCase(),
          record.marketBadge??'',
          record.updatedAt!,
          JSON.stringify(record),
        );
      }
    });
  }
  upsertSymbols(items:readonly MarketSymbol[],now=Date.now()):number {
    if(!Array.isArray(items))throw Error('symbols 必须为数组');
    if(items.length>5000)throw Error('单批最多入库 5000 个交易品种');
    const selectExisting=this.db.prepare('SELECT meta FROM symbols WHERE source=? AND symbol=?');
    const upsert=this.db.prepare(`INSERT INTO symbols(source,symbol,base_asset,quote_asset,name,market_type,exchange_label,market_badge,updated_at,meta)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source,symbol) DO UPDATE SET
        base_asset=excluded.base_asset,
        quote_asset=excluded.quote_asset,
        name=CASE WHEN excluded.name!='' THEN excluded.name ELSE symbols.name END,
        market_type=CASE WHEN excluded.market_type!='' THEN excluded.market_type ELSE symbols.market_type END,
        exchange_label=CASE WHEN excluded.exchange_label!='' THEN excluded.exchange_label ELSE symbols.exchange_label END,
        market_badge=CASE WHEN excluded.market_badge!='' THEN excluded.market_badge ELSE symbols.market_badge END,
        updated_at=excluded.updated_at,
        meta=excluded.meta`);
    let count=0;
    return this.transaction(()=>{
      for(const raw of items){
        if(!raw||typeof raw.symbol!=='string'||typeof raw.baseAsset!=='string'||typeof raw.quoteAsset!=='string')throw Error('无效商品条目');
        const source=validSource(raw.source??'binance');
        const symbol=raw.symbol.trim().toUpperCase();
        const baseAsset=raw.baseAsset.trim().toUpperCase();
        const quoteAsset=raw.quoteAsset.trim().toUpperCase();
        if(!symbol||symbol.length>40||!baseAsset||baseAsset.length>24||!quoteAsset||quoteAsset.length>16)throw Error('商品代码长度或格式无效');
        const prevRow=selectExisting.get(source,symbol) as {meta?:string}|undefined;
        const prev=prevRow?.meta?(JSON.parse(String(prevRow.meta)) as MarketSymbol):undefined;
        const merged:MarketSymbol={
          ...prev,
          ...raw,
          source,
          symbol,
          baseAsset,
          quoteAsset,
          name:(raw.name?.trim()||prev?.name?.trim())??'',
          marketType:raw.marketType||prev?.marketType||'',
          exchangeLabel:raw.exchangeLabel||prev?.exchangeLabel||source.toUpperCase(),
          marketBadge:raw.marketBadge||prev?.marketBadge||'',
          updatedAt:now,
          ...(raw.contract||prev?.contract?{contract:raw.contract??prev?.contract}:{}),
        };
        upsert.run(
          source,
          symbol,
          baseAsset,
          quoteAsset,
          merged.name??'',
          merged.marketType??'',
          merged.exchangeLabel??'',
          merged.marketBadge??'',
          now,
          JSON.stringify(merged),
        );
        count++;
      }
      return count;
    });
  }
  listSymbols(options:{source?:string;query?:string;quoteAsset?:string;limit?:number}={}):MarketSymbol[] {
    const limit=Math.max(1,Math.min(5000,Math.floor(options.limit??2000)));
    const sourceFilter=options.source&&options.source!=='all'?validSource(options.source):undefined;
    const quoteFilter=options.quoteAsset&&options.quoteAsset!=='all'?options.quoteAsset.trim().toUpperCase():undefined;
    const rows=sourceFilter&&quoteFilter
      ?this.db.prepare('SELECT meta FROM symbols WHERE source=? AND quote_asset=? ORDER BY symbol LIMIT ?').all(sourceFilter,quoteFilter,limit)
      :sourceFilter
      ?this.db.prepare('SELECT meta FROM symbols WHERE source=? ORDER BY symbol LIMIT ?').all(sourceFilter,limit)
      :quoteFilter
      ?this.db.prepare('SELECT meta FROM symbols WHERE quote_asset=? ORDER BY source,symbol LIMIT ?').all(quoteFilter,limit)
      :this.db.prepare('SELECT meta FROM symbols ORDER BY source,symbol LIMIT ?').all(limit);
    const items=rows.map(row=>JSON.parse(String(row.meta)) as MarketSymbol);
    const q=options.query?.trim().toUpperCase();
    if(!q)return items;
    const needle=q.replace(/^(?:BINANCE|OKX|COINBASE|SSE|SZSE|BSE|CN):/,'').replace(/\.P$/,'').replace(/[\s/]/g,'');
    return items.filter(item=>
      item.symbol.toUpperCase().includes(needle)
      ||item.baseAsset.toUpperCase().includes(needle)
      ||item.quoteAsset.toUpperCase().includes(needle)
      ||(item.name?.toUpperCase().includes(q)??false)
      ||(item.exchangeLabel?.toUpperCase().includes(q)??false)
      ||(item.source?.toUpperCase().includes(q)??false)
    );
  }
  symbolSources():{source:string;count:number;updatedAt:number}[] {
    const rows=this.db.prepare('SELECT source,COUNT(*) AS count,MAX(updated_at) AS updatedAt FROM symbols GROUP BY source ORDER BY source').all();
    return rows.map(row=>({source:String(row.source),count:Number(row.count),updatedAt:Number(row.updatedAt)}));
  }
  listConnectorConfigs():StoredConnectorConfig[] {
    const rows=this.db.prepare('SELECT config FROM connector_configs ORDER BY source').all();
    return rows.map(row=>JSON.parse(String(row.config)) as StoredConnectorConfig);
  }
  saveConnectorConfigs(configs:readonly Partial<StoredConnectorConfig>[],now=Date.now()):StoredConnectorConfig[] {
    if(!Array.isArray(configs))throw Error('configs 必须为数组');
    const upsert=this.db.prepare('INSERT INTO connector_configs(source,updated_at,config) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET updated_at=excluded.updated_at,config=excluded.config');
    return this.transaction(()=>{
      for(const raw of configs){
        const rawSource=raw?.source??raw?.id;
        if(!raw||typeof rawSource!=='string')throw Error('无效数据源配置项');
        const source=validSource(rawSource);
        const mode=raw.mode==='live'||raw.mode==='simulation'||raw.mode==='auto'?raw.mode:'auto';
        const record:StoredConnectorConfig={
          source,
          id:source,
          enabled:raw.enabled!==false,
          mode,
          ...(raw.restBase?.trim()?{restBase:raw.restBase.trim()}:{}),
          ...(raw.wsUrl?.trim()?{wsUrl:raw.wsUrl.trim()}:{}),
          ...(raw.defaultSymbol?.trim()?{defaultSymbol:raw.defaultSymbol.trim().toUpperCase()}:{}),
          updatedAt:now,
        };
        upsert.run(source,now,JSON.stringify(record));
      }
      return this.listConnectorConfigs();
    });
  }
}
