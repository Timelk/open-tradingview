import {createHash} from 'node:crypto';
import {createWriteStream,createReadStream} from 'node:fs';
import {mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {StringDecoder} from 'node:string_decoder';
import {openPromise} from 'yauzl';
import type {AggregateTrade} from '../src/lib/flow/types';
import type {ArchivePeriod,ArchiveRequest,ArchiveType,UploadArchiveRequest} from '../src/lib/flow/persistence-client';

export const ARCHIVE_HOST='https://data.binance.vision';
export function validateSymbol(raw:unknown):string {
  if(typeof raw!=='string'||!/^\p{L}[\p{L}\p{N}]{0,31}USDT$|^\d[\p{L}\p{N}]{0,31}USDT$/u.test(raw))throw Error('无效 USDT 品种');return raw;
}
export function archiveDates(request:ArchiveRequest):string[]{
  validateSymbol(request.symbol);if(!['aggTrades','trades'].includes(request.type)||!['daily','monthly'].includes(request.period))throw Error('无效档案类型');
  const parse=(value:string)=>{
    if(typeof value!=='string'||!(request.period==='daily'?/^\d{4}-\d{2}-\d{2}$/:/^\d{4}-\d{2}$/).test(value))throw Error('无效 UTC 档案日期');
    const text=request.period==='monthly'?`${value}-01`:value,time=Date.parse(`${text}T00:00:00Z`);
    if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==text||time<Date.UTC(2019,0,1)||time>Date.now())throw Error('无效 UTC 档案日期');return time;
  };
  const from=parse(request.from),to=parse(request.to??request.from);if(to<from)throw Error('结束日期早于开始日期');
  const dates:string[]=[];for(let time=from;time<=to;){
    if(dates.length>=3660)throw Error('单个任务最多 3660 个档案');const d=new Date(time);dates.push(d.toISOString().slice(0,request.period==='daily'?10:7));
    time=request.period==='daily'?time+86400000:Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);
  }return dates;
}
export function archiveFile(spec:{symbol:string;type:ArchiveType;period:ArchivePeriod;date:string}){
  archiveDates({...spec,from:spec.date});const name=`${spec.symbol}-${spec.type}-${spec.date}`;
  return {name,url:`${ARCHIVE_HOST}/data/futures/um/${spec.period}/${spec.type}/${encodeURIComponent(spec.symbol)}/${encodeURIComponent(name)}.zip`};
}
export function checksumValue(text:string,name?:string):string {
  const parts=text.trim().split(/\s+/);if(!/^[0-9a-f]{64}$/i.test(parts[0]??'')||name&&parts[1]?.replace(/^\*/,'')!==`${name}.zip`)throw Error('官方 CHECKSUM 格式或文件名不匹配');return parts[0].toLowerCase();
}
export async function saveArchive(source:AsyncIterable<Uint8Array>,file:string,checksum:string,signal:AbortSignal,maxBytes:number,onBytes:(count:number)=>void=()=>{}):Promise<void>{
  const hash=createHash('sha256');let bytes=0;
  const counter=new Transform({transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;if(bytes>maxBytes){callback(Error('档案超过允许的磁盘下载大小'));return;}hash.update(chunk);onBytes(bytes);callback(null,chunk);}});
  await mkdir(join(file,'..'),{recursive:true});
  try{await pipeline(Readable.from(source),counter,createWriteStream(file,{flags:'wx',mode:0o600}),{signal});if(hash.digest('hex')!==checksum)throw Error('档案 SHA-256 校验失败，未导入');}
  catch(error){await rm(file,{force:true});throw error;}
}
export async function downloadArchive(spec:{symbol:string;type:ArchiveType;period:ArchivePeriod;date:string},file:string,request:typeof fetch,signal:AbortSignal,maxBytes:number,onBytes?:(count:number)=>void){
  const {url,name}=archiveFile(spec),options={signal,redirect:'error' as const,credentials:'omit' as const};
  const checked=await request(`${url}.CHECKSUM`,options);if(!checked.ok)throw Error(`公开档案 CHECKSUM HTTP ${checked.status}`);
  const text=await checked.text();if(text.length>1024)throw Error('CHECKSUM 文件过长');const checksum=checksumValue(text,name);
  const response=await request(url,options);if(!response.ok||!response.body)throw Error(`公开档案 HTTP ${response.status}`);
  if(Number(response.headers.get('content-length')??0)>maxBytes)throw Error('档案超过允许的磁盘下载大小');
  await saveArchive(response.body as unknown as AsyncIterable<Uint8Array>,file,checksum,signal,maxBytes,onBytes);return checksum;
}
const integer=(value:string)=>/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):NaN;
function parseTrade(line:string,type:ArchiveType,symbol:string,range:[number,number]):AggregateTrade {
  const cols=line.split(',').map(v=>v.trim().replace(/^"|"$/g,''));
  if(cols.length<(type==='aggTrades'?7:6)||!/^\d{1,25}$/.test(cols[0]))throw Error('成交 CSV 行或 ID 无效');
  const price=Number(cols[1]),qty=Number(cols[2]),time=integer(cols[type==='aggTrades'?5:4]),maker=cols[type==='aggTrades'?6:5].toLowerCase();
  const quote=type==='trades'?Number(cols[3]):price*qty;
  if(!Number.isFinite(price)||price<=0||!Number.isFinite(qty)||qty<=0||!Number.isFinite(quote)||quote<=0||!Number.isSafeInteger(time)||time<range[0]||time>=range[1]||!['true','false'].includes(maker))throw Error('成交 CSV 数值、方向或 UTC 日期不匹配');
  return {symbol,id:BigInt(cols[0]).toString(),time,price,baseQuantity:qty,quoteQuantity:quote,aggressor:maker==='true'?'sell':'buy'};
}
/** ZIP64-capable random-access ZIP directory plus streaming inflation/CSV.
 * No archive or whole CSV is materialized in RAM, and no entry is extracted to a path. */
export async function* readArchive(file:string,spec:UploadArchiveRequest,signal:AbortSignal,maxInflatedBytes=40*1024**3):AsyncGenerator<AggregateTrade[]> {
  const {name}=archiveFile(spec),start=Date.parse(`${spec.date}${spec.period==='monthly'?'-01':''}T00:00:00Z`),date=new Date(start);
  const range:[number,number]=[start,spec.period==='daily'?start+86400000:Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)];
  const zip=await openPromise(file,{lazyEntries:true,autoClose:false,validateEntrySizes:true,strictFileNames:true});
  const close=()=>zip.close();signal.addEventListener('abort',close,{once:true});let files=0,bytes=0;
  try{for await(const entry of zip.eachEntry()){
    signal.throwIfAborted();if(entry.fileName.endsWith('/'))continue;
    if(++files>1||entry.fileName!==`${name}.csv`||entry.uncompressedSize>maxInflatedBytes)throw Error('ZIP 必须仅含同名 CSV，且解压体积有界');
    const stream=await zip.openReadStreamPromise(entry),decoder=new StringDecoder('utf8');let remainder='',lineNumber=0,batch:AggregateTrade[]=[];
    const abort=()=>stream.destroy(Error('导入已取消'));signal.addEventListener('abort',abort,{once:true});
    const parse=(line:string)=>{lineNumber++;if(lineNumber===1)line=line.replace(/^\uFEFF/,'');if(!line.trim())return;
      if(lineNumber===1&&/^(agg_trade_id|aggregate_trade_id|trade_id|id),/i.test(line))return;
      batch.push(parseTrade(line,spec.type,spec.symbol,range));};
    try{for await(const chunk of stream){
      signal.throwIfAborted();bytes+=(chunk as Buffer).length;if(bytes>maxInflatedBytes)throw Error('CSV 解压体积超过上限');
      remainder+=decoder.write(chunk as Buffer);let newline:number;
      while((newline=remainder.indexOf('\n'))>=0){const line=remainder.slice(0,newline);remainder=remainder.slice(newline+1);if(line.length>16384)throw Error('CSV 行过长');parse(line);if(batch.length>=1000){yield batch;batch=[];}}
      if(remainder.length>16384)throw Error('CSV 行过长');
    }
    remainder+=decoder.end();if(remainder)parse(remainder);if(batch.length)yield batch;
    }finally{signal.removeEventListener('abort',abort);stream.destroy();}
  }if(files!==1)throw Error('ZIP 中没有成交 CSV');}
  finally{signal.removeEventListener('abort',close);zip.close();}
}
