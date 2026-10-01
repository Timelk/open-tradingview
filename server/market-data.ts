import type {IncomingMessage,ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {mkdir,rm} from 'node:fs/promises';
import {MarketStore} from './market-store';
import {HeatmapBusyError} from './market-heatmap';
import {MarketRecorder,type RecorderOptions} from './market-recorder';
import {archiveDates,archiveFile,checksumValue,downloadArchive,readArchive,saveArchive,validateSymbol} from './market-archive';
import {fetchCnAShareKlines,searchCnAShareSymbols,makeCnSymbol} from './cn-ashare';
import type {ArchiveRequest,ImportJob,RecordedMarketEvent,UploadArchiveRequest,DatasetInfo} from '../src/lib/flow/persistence-client';

export interface MarketDataOptions extends RecorderOptions {directory?:string;maxArchiveBytes?:number;maxInflatedBytes?:number;recordLive?:boolean}
const PREFIX='/api/market-data';
const loopback=(host:string)=>host==='localhost'||host==='[::1]'||host==='::1'||/^127(?:\.\d{1,3}){3}$/.test(host)||/^::ffff:127(?:\.\d{1,3}){3}$/i.test(host);
function localRequest(request:IncomingMessage){
  if(!request.socket.remoteAddress||!loopback(request.socket.remoteAddress)||typeof request.headers.host!=='string')return false;
  try{const host=new URL(`http://${request.headers.host}`);if(!loopback(host.hostname)||host.username||host.password)return false;
    if(request.headers['sec-fetch-site']==='cross-site'||request.headers['sec-fetch-site']==='same-site')return false;
    for(const header of ['origin','referer'] as const){const value=request.headers[header];if(value!==undefined&&(typeof value!=='string'||new URL(value).origin!==host.origin))return false;}return true;
  }catch{return false;}
}
async function readJson(request:IncomingMessage){let text='',bytes=0;for await(const chunk of request){bytes+=chunk.length;if(bytes>8*1024**2)throw Error('请求正文超过 8 MB');text+=chunk.toString();}try{return JSON.parse(text||'{}');}catch{throw Error('无效 JSON 请求');}}
const number=(query:URLSearchParams,key:string)=>query.has(key)?Number(query.get(key)):undefined;

export class MarketDataService {
  readonly store:MarketStore;readonly directory:string;
  private closed=false;private queue:string[]=[];private active:Promise<void>|undefined;
  private jobs=new Map<string,AbortController>();private recorders=new Map<string,MarketRecorder>();private uploads=new Set<AbortController>();private uploadDone=new Set<Promise<void>>();
  private request:typeof fetch;private maxBytes:number;private maxInflated:number;
  constructor(private options:MarketDataOptions={}){
    this.directory=resolve(options.directory??'.data/market');this.store=new MarketStore(this.directory);
    this.request=options.fetch??fetch;this.maxBytes=options.maxArchiveBytes??8*1024**3;this.maxInflated=options.maxInflatedBytes??40*1024**3;
  }
  startImport(request:ArchiveRequest):ImportJob {
    if(this.closed)throw Error('本地服务已关闭');const dates=archiveDates(request);if(this.jobs.size>=10)throw Error('导入队列已满，请等待或取消现有任务');
    const job:ImportJob={id:randomUUID(),status:'queued',request:{symbol:request.symbol,type:request.type,period:request.period,from:request.from,...(request.to?{to:request.to}:{})},files:dates.length,completedFiles:0,bytes:0,rows:0,datasetIds:[],message:'等待校验并导入官方公开档案',createdAt:Date.now()};
    this.store.putJob(job);this.jobs.set(job.id,new AbortController());this.queue.push(job.id);this.pump();return job;
  }
  cancelImport(id:string):ImportJob {
    const job=this.store.getJob(id);if(['complete','failed','cancelled'].includes(job.status))return job;
    this.jobs.get(id)?.abort();this.store.putJob({...job,status:'cancelled',message:'已请求取消；完成的档案保留，未完成档案不会作为完整数据读取。'});return this.store.getJob(id);
  }
  private pump(){
    if(this.active||this.closed)return;const id=this.queue.shift();if(!id)return;
    this.active=this.runImport(id).catch(()=>{}).finally(()=>{this.jobs.delete(id);this.active=undefined;this.pump();});
  }
  private async runImport(id:string){
    const controller=this.jobs.get(id)!,job=this.store.getJob(id);if(controller.signal.aborted)return;
    job.status='running';job.message='正在下载并验证 SHA-256';this.store.putJob(job);let failures=0;
    try{for(const date of archiveDates(job.request)){
      controller.signal.throwIfAborted();const file=join(this.directory,'tmp',`${randomUUID()}.zip`);let dataset:DatasetInfo|undefined;
      try{
        const spec={symbol:job.request.symbol,type:job.request.type,period:job.request.period,date};job.message=`下载 ${spec.symbol} ${date}`;this.store.putJob(job);
        const baseline=job.bytes;let persisted=0;
        const checksum=await downloadArchive(spec,file,this.request,AbortSignal.any([controller.signal,AbortSignal.timeout(30*60_000)]),this.maxBytes,bytes=>{job.bytes=baseline+bytes;if(bytes-persisted>1024**2){persisted=bytes;this.store.putJob(job);}});
        const existing=this.store.findChecksum(checksum,spec.symbol);
        if(existing&&existing.archiveDate===date&&existing.period===spec.period&&existing.tradeType===spec.type){job.datasetIds.push(existing.id);job.completedFiles++;job.message=`已复用校验一致档案 ${date}`;this.store.putJob(job);continue;}
        dataset=this.store.create({symbol:spec.symbol,kind:'archive',tradeType:spec.type,state:'importing',source:archiveFile(spec).url,checksum,archiveDate:date,period:spec.period});
        job.datasetIds.push(dataset.id);this.store.putJob(job);
        for await(const batch of readArchive(file,{...spec,checksum},controller.signal,this.maxInflated)){
          job.rows+=this.store.writeTrades(dataset.id,batch);job.message=`导入 ${date} · ${this.store.get(dataset.id).tradeCount.toLocaleString()} 条`;this.store.putJob(job);await new Promise<void>(r=>setImmediate(r));
        }
        this.store.update({...this.store.get(dataset.id),state:'complete'});job.completedFiles++;
      }catch(error){
        if(dataset)this.store.update({...this.store.get(dataset.id),state:controller.signal.aborted?'cancelled':'failed',warning:error instanceof Error?error.message:'导入失败'});
        if(controller.signal.aborted||error instanceof Error&&/disk is full|SQLITE_FULL|ENOSPC|EACCES/i.test(error.message))throw error;
        failures++;job.message=`${date} 失败：${error instanceof Error?error.message:'档案不可用'}；其他日期继续`;
      }finally{await rm(file,{force:true});this.store.putJob(job);}
    }
    job.status=failures?'failed':'complete';job.message=failures?`${job.completedFiles}/${job.files} 个档案完成，${failures} 个失败；可重试相同范围，完成项将复用。`:`${job.completedFiles} 个档案完成，SHA-256 与 CSV 均已验证。`;
    }catch(error){job.status=controller.signal.aborted?'cancelled':'failed';job.message=controller.signal.aborted?'已取消；保留完成档案，未完成数据不会作为完整档案读取。':error instanceof Error?error.message:'导入失败';}
    this.store.putJob(job);
  }
  async upload(source:AsyncIterable<Uint8Array>,spec:UploadArchiveRequest,signal:AbortSignal):Promise<DatasetInfo>{
    if(this.closed||this.uploads.size>=1)throw Error('已有上传正在处理或服务已关闭');archiveFile(spec);const checksum=checksumValue(spec.checksum);
    const aborter=new AbortController(),cancel=()=>aborter.abort();signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)aborter.abort();this.uploads.add(aborter);
    let finished!:()=>void;const done=new Promise<void>(resolve=>finished=resolve);this.uploadDone.add(done);
    const file=join(this.directory,'tmp',`${randomUUID()}.zip`);let dataset:DatasetInfo|undefined;
    try{await saveArchive(source,file,checksum,aborter.signal,this.maxBytes);
      const existing=this.store.findChecksum(checksum,spec.symbol);if(existing&&existing.archiveDate===spec.date&&existing.period===spec.period&&existing.tradeType===spec.type)return existing;
      dataset=this.store.create({symbol:spec.symbol,kind:'archive',tradeType:spec.type,state:'importing',source:'用户上传公开档案；SHA-256 按用户提供的 CHECKSUM 校验',checksum,archiveDate:spec.date,period:spec.period});
      for await(const batch of readArchive(file,spec,aborter.signal,this.maxInflated)){this.store.writeTrades(dataset.id,batch);await new Promise<void>(r=>setImmediate(r));}
      return this.store.update({...this.store.get(dataset.id),state:'complete'});
    }catch(error){if(dataset)this.store.update({...this.store.get(dataset.id),state:aborter.signal.aborted?'cancelled':'failed',warning:error instanceof Error?error.message:'上传导入失败'});throw error;}
    finally{this.uploads.delete(aborter);signal.removeEventListener('abort',cancel);try{await rm(file,{force:true});}finally{this.uploadDone.delete(done);finished();}}
  }
  startRecording(symbol:string):DatasetInfo {
    if(this.closed)throw Error('本地服务已关闭');validateSymbol(symbol);
    const existing=this.store.list(symbol).find(d=>d.state==='recording');if(existing)return existing;
    if(this.recorders.size>=4)throw Error('最多同时录制 4 个品种');
    const info=this.store.create({symbol,kind:'recording',tradeType:'aggTrades',state:'recording',source:'Binance USDⓈ-M 公开成交与 L2；本机服务端持续录制'});
    if(this.options.recordLive!==false)this.recorders.set(info.id,new MarketRecorder(this.store,info.id,symbol,this.options));return info;
  }
  stopRecording(id:string):DatasetInfo {
    const info=this.store.get(id);if(info.kind!=='recording')throw Error('该数据不是录制');if(info.state==='stopped')return info;
    this.recorders.get(id)?.stop();this.recorders.delete(id);const now=Date.now();
    this.store.append(id,[{kind:'gap',channel:'depth',time:now,receivedAt:now,reason:'用户或服务关闭停止录制；等待明确人工恢复。'}]);
    const current=this.store.get(id),pauses=[...(current.recordingPauses??[])];
    if(!pauses.length||pauses.at(-1)!.toTime!==undefined)pauses.push({fromTime:now,notedAt:now,reason:'录制已明确停止；此后的历史L2不在录制覆盖内。'});
    return this.store.update({...current,state:'stopped',stoppedAt:now,recordingPauses:pauses});
  }
  resumeRecording(id:string):DatasetInfo {
    if(this.closed)throw Error('本地服务已关闭');const info=this.store.get(id);
    if(info.kind!=='recording')throw Error('只有已停止的录制数据集可以恢复');
    if(info.state==='recording'){if(this.recorders.has(id)||this.options.recordLive===false)return info;throw Error('录制状态不一致，请先停止后重试');}
    if(info.state!=='stopped')throw Error('请先停止该录制再恢复');
    if(this.store.list(info.symbol).some(d=>d.id!==id&&d.state==='recording'))throw Error('该品种已有另一录制正在进行；请先停止另一录制');
    if(this.recorders.size>=4)throw Error('最多同时录制 4 个品种');
    if((info.recordingPauses?.length??0)>=1000)throw Error('此数据集暂停记录已达上限，请新建录制，已有数据仍可回放');
    const now=Date.now(),pauses=(info.recordingPauses??[]).map(p=>({...p}));
    if(!pauses.length||pauses.at(-1)!.toTime!==undefined)pauses.push({fromTime:info.stoppedAt??info.recordedThrough??info.throughTime??info.createdAt,notedAt:now,reason:'按持久化停机边界记录的暂停；历史L2不可补造。'});
    const open=pauses.at(-1)!;if(now<open.fromTime)throw Error('当前时钟早于停机边界，暂不能安全恢复');open.toTime=now;
    this.store.update({...info,state:'recording',stoppedAt:undefined,recordingPauses:pauses,warning:'已人工恢复同一数据集；暂停的L2区间保留缺口，新数据仅在真实快照接续后可用。'});
    try{
      // A new event gets its real receipt time. The offline interval is metadata,
      // never a backdated exchange packet or a reconstructed historical book.
      this.store.append(id,[{kind:'gap',channel:'depth',time:now,receivedAt:now,reason:'人工恢复；新快照与连续差分到位之前，L2仍不可用。'}]);
      if(this.options.recordLive!==false)this.recorders.set(id,new MarketRecorder(this.store,id,info.symbol,{...this.options,resumeFromId:this.store.latestTradeId(id)}));
      return this.store.get(id);
    }catch(error){
      this.recorders.get(id)?.stop();this.recorders.delete(id);
      this.store.update({...this.store.get(id),state:'stopped',stoppedAt:info.stoppedAt??now,recordingPauses:info.recordingPauses,warning:`恢复失败：${error instanceof Error?error.message:'本地录制不可用'}`});throw error;
    }
  }
  async close(){
    if(this.closed)return;this.closed=true;for(const controller of this.jobs.values())controller.abort();for(const controller of this.uploads)controller.abort();
    for(const info of this.store.list(undefined,10000))if(info.kind==='recording'&&info.state==='recording')this.stopRecording(info.id);await this.active;await Promise.allSettled([...this.uploadDone]);this.store.close();
  }
  async handle(request:IncomingMessage,response:ServerResponse,next:()=>void){
    const raw=request.url??'';if(raw.split('?')[0]!==PREFIX&&!raw.startsWith(`${PREFIX}/`)){next();return;}
    const reply=(status:number,value:unknown)=>{if(response.destroyed)return;response.statusCode=status;response.setHeader('Content-Type','application/json; charset=utf-8');response.setHeader('Cache-Control','no-store');response.setHeader('Cross-Origin-Resource-Policy','same-origin');response.setHeader('X-Content-Type-Options','nosniff');response.end(JSON.stringify(value));};
    if(!localRequest(request)){reply(403,{message:'仅允许 localhost 同源页面访问本地行情数据'});return;}
    if(this.closed){reply(503,{message:'本地行情服务已关闭'});return;}
    try{
      const url=new URL(raw,'http://localhost'),parts=url.pathname.slice(PREFIX.length).split('/').filter(Boolean),query=url.searchParams,method=request.method;
      if(method==='GET'&&parts[0]==='datasets'&&parts.length===1){const symbol=query.get('symbol')??undefined;if(symbol)validateSymbol(symbol);reply(200,this.store.list(symbol,Math.max(1,Math.min(1000,number(query,'limit')??500)),Math.max(0,number(query,'offset')??0)));return;}
      if(method==='GET'&&parts[0]==='datasets'&&parts.length>=2){
        const id=parts[1];if(parts.length===2){reply(200,this.store.coverage(id));return;}
        if(parts[2]==='trades'){reply(200,this.store.trades(id,{from:number(query,'from'),to:number(query,'to'),limit:number(query,'limit'),cursor:query.get('cursor')??undefined}));return;}
        if(parts[2]==='replay'){reply(200,this.store.replay(id,Number(query.get('at')),number(query,'limit')));return;}
        if(parts[2]==='heatmap'){
          const aborter=new AbortController(),abort=()=>{if(!response.writableEnded)aborter.abort();};request.once('aborted',abort);response.once('close',abort);
          try{reply(200,await this.store.heatmap(id,Number(query.get('from')),Number(query.get('to')),number(query,'samples'),number(query,'levels'),aborter.signal));}
          catch(error){if(aborter.signal.aborted||response.destroyed)return;if(error instanceof HeatmapBusyError){response.setHeader('Retry-After','1');reply(429,{message:error.message});return;}throw error;}
          finally{request.removeListener('aborted',abort);response.removeListener('close',abort);}return;
        }
        if(parts[2]==='aggregate'){
          const aborter=new AbortController(),abort=()=>{if(!response.writableEnded)aborter.abort();};response.once('close',abort);
          try{reply(200,await this.store.aggregate(id,{from:Number(query.get('from')),to:Number(query.get('to')),tickSize:Number(query.get('tickSize')),timeframeMs:Number(query.get('timeframeMs')),priceStepTicks:number(query,'priceStepTicks'),maxBars:number(query,'maxBars'),tpoBlockMs:number(query,'tpoBlockMs'),sessionOffsetMs:number(query,'sessionOffsetMs')},aborter.signal));}
          finally{response.removeListener('close',abort);}return;
        }
      }
      if(parts[0]==='jobs'&&parts.length===2&&(method==='GET'||method==='DELETE')){reply(200,method==='GET'?this.store.getJob(parts[1]):this.cancelImport(parts[1]));return;}
      if(method==='GET'&&parts[0]==='jobs'&&parts.length===1){reply(200,this.store.listJobs(number(query,'limit'),number(query,'offset')));return;}
      if(method==='POST'&&parts.length===1&&parts[0]==='imports'){reply(202,this.startImport(await readJson(request)));return;}
      if(method==='POST'&&parts[0]==='recordings'){
        if(parts.length===1){reply(201,this.startRecording((await readJson(request)).symbol));return;}
        if(parts.length===3&&parts[2]==='stop'){reply(200,this.stopRecording(parts[1]));return;}
        if(parts.length===3&&parts[2]==='resume'){await readJson(request);if(request.aborted||response.destroyed)throw Error('恢复请求已取消');reply(200,this.resumeRecording(parts[1]));return;}
        if(parts.length===3&&parts[2]==='events'){const events=(await readJson(request)).events;if(!Array.isArray(events))throw Error('events 必须为数组');reply(200,this.store.append(parts[1],events as RecordedMarketEvent[]));return;}
      }
      if(parts[0]==='symbols'&&parts.length===1){
        if(method==='GET'){
          const symbols=this.store.listSymbols({
            source:query.get('source')??undefined,
            query:query.get('q')??undefined,
            quoteAsset:query.get('quote')??undefined,
            limit:number(query,'limit'),
          });
          reply(200,{symbols,sources:this.store.symbolSources()});
          return;
        }
        if(method==='POST'){
          const body=await readJson(request);
          const count=this.store.upsertSymbols(body.symbols);
          reply(200,{count,sources:this.store.symbolSources()});
          return;
        }
      }
      if(parts[0]==='connectors'&&parts.length===1){
        if(method==='GET'){
          reply(200,{configs:this.store.listConnectorConfigs(),sources:this.store.symbolSources()});
          return;
        }
        if(method==='POST'){
          const body=await readJson(request);
          const configs=this.store.saveConnectorConfigs(Array.isArray(body.configs)?body.configs:[body]);
          reply(200,{configs,sources:this.store.symbolSources()});
          return;
        }
      }
      if(parts[0]==='cn-a'&&method==='GET'){
        if(parts[1]==='klines'&&parts.length===2){
          const rawSymbol=query.get('symbol')??'600519.SH';
          const interval=query.get('interval')??'1d';
          const limit=number(query,'limit')??500;
          const result=await fetchCnAShareKlines(rawSymbol,interval,limit,this.request);
          if(result.name){
            this.store.upsertSymbols([makeCnSymbol(result.symbol,result.name)]);
          }
          reply(200,{symbol:result.symbol,interval,bars:result.bars,name:result.name,provider:result.provider});
          return;
        }
        if(parts[1]==='search'&&parts.length===2){
          const q=query.get('q')??'';
          const limit=number(query,'limit')??30;
          const symbols=await searchCnAShareSymbols(q,limit,this.request);
          if(symbols.length){
            this.store.upsertSymbols(symbols);
          }
          reply(200,{symbols,sources:this.store.symbolSources()});
          return;
        }
      }
      if(method==='POST'&&parts.length===1&&parts[0]==='uploads'){
        const aborter=new AbortController(),cancel=()=>aborter.abort(),cancelClosed=()=>{if(!response.writableEnded)aborter.abort();};request.once('aborted',cancel);response.once('close',cancelClosed);
        try{const spec=Object.fromEntries(['symbol','type','period','date','checksum'].map(key=>[key,query.get(key)])) as unknown as UploadArchiveRequest;reply(201,await this.upload(request,spec,aborter.signal));}
        finally{request.removeListener('aborted',cancel);response.removeListener('close',cancelClosed);}return;
      }
      reply(404,{message:'本地行情 API 路由不存在'});
    }catch(error){reply(400,{message:error instanceof Error?error.message:'本地行情数据处理失败'});}
  }
}

export function createMarketDataHandler(options:MarketDataOptions={}){
  // Creating a Vite config/build plugin must not open SQLite or acquire a writer
  // lock. The first authorized local API request starts the data service.
  let service:MarketDataService|undefined;
  const ensure=()=>service??=new MarketDataService(options);
  const handler=(request:IncomingMessage,response:ServerResponse,next:()=>void)=>{
    if(request.url?.split('?')[0]!==PREFIX&&!request.url?.startsWith(`${PREFIX}/`)){next();return;}
    if(!localRequest(request)){response.statusCode=403;response.setHeader('Content-Type','application/json');response.end(JSON.stringify({message:'仅允许 localhost 同源页面访问本地行情数据'}));return;}
    try{void ensure().handle(request,response,next);}catch(error){response.statusCode=503;response.setHeader('Content-Type','application/json');response.end(JSON.stringify({message:error instanceof Error?error.message:'本地行情存储不可用'}));}
  };
  return Object.defineProperties(handler,{close:{value:()=>service?.close()??Promise.resolve()},service:{get:ensure}}) as typeof handler&{close():Promise<void>;readonly service:MarketDataService};
}
