import type {AggregateTrade,TradeFlowSnapshot} from './types';
import type {BookLevel} from './orderbook';

export type ArchiveType='aggTrades'|'trades';
export type ArchivePeriod='daily'|'monthly';
export interface ArchiveRequest {symbol:string;type:ArchiveType;period:ArchivePeriod;from:string;to?:string}
export interface DatasetInfo {
  id:string;symbol:string;kind:'archive'|'recording';tradeType:ArchiveType;
  state:'importing'|'recording'|'complete'|'stopped'|'failed'|'cancelled';
  source:string;createdAt:number;fromTime?:number;throughTime?:number;tradeCount:number;depthCount:number;gapCount:number;
  checksum?:string;archiveDate?:string;period?:ArchivePeriod;warning?:string;
  recordedThrough?:number;stoppedAt?:number;
  recordingPauses?:Array<{fromTime:number;toTime?:number;notedAt:number;reason:string}>;
}
export interface ImportJob {id:string;status:'queued'|'running'|'complete'|'failed'|'cancelled';request:ArchiveRequest;files:number;completedFiles:number;bytes:number;rows:number;datasetIds:string[];message:string;createdAt:number}
export interface RecordedGap {channel:'trades'|'depth';afterTime:number;beforeTime:number;fromId?:string;toId?:string;reason:string}
export interface DatasetCoverage {dataset:DatasetInfo;gaps:RecordedGap[];gapsTruncated:boolean;note:string}
export interface StoredTradePage {datasetId:string;rows:AggregateTrade[];nextCursor?:string;fromTime:number;toTime:number;coverage:DatasetCoverage}
export type RecordedMarketEvent=
  |{kind:'aggTrade';receivedAt:number;trade:AggregateTrade}
  |{kind:'depth-snapshot';receivedAt:number;time:number;lastUpdateId:number;bids:BookLevel[];asks:BookLevel[];origin?:'rest'|'checkpoint'}
  |{kind:'depth-diff';receivedAt:number;time:number;U:number;u:number;pu:number;bids:BookLevel[];asks:BookLevel[]}
  |{kind:'gap';receivedAt:number;time:number;reason:string;channel?:'depth'|'trades'};
export interface ReplayBook {status:'available'|'gap'|'unavailable'|'truncated';bids:BookLevel[];asks:BookLevel[];time?:number;lastUpdateId?:number;warning?:string}
export interface ReplaySnapshot {datasetId:string;at:number;book:ReplayBook;trades:AggregateTrade[];coverage:DatasetCoverage}
export interface DepthHeatmap {datasetId:string;fromTime:number;toTime:number;samples:Array<{time:number;book:ReplayBook}>;note:string}
export interface UploadArchiveRequest {symbol:string;type:ArchiveType;period:ArchivePeriod;date:string;checksum:string}
export interface HistoricalAggregateOptions {from:number;to:number;tickSize:number;priceStepTicks?:number;timeframeMs:number;maxBars?:number;tpoBlockMs?:number;sessionOffsetMs?:number}
export interface HistoricalFlowAggregate {
  datasetId:string;fromTime:number;toTime:number;snapshot:TradeFlowSnapshot;coverage:DatasetCoverage;
  totalBars:number;returnedBars:number;footprintTruncated:boolean;
  tpo:{blockMs:number;rows:Array<{tick:number;price:number;priceEnd:number;blocks:number}>;totalBlocks:number};
  priceRange?:{low:number;high:number};
  tradeCoverage?:{fromTime:number;toTime:number;complete:boolean;basis:'verified-archive'|'continuous-trade-ids'|'unproven';availableAt?:number;firstTradeTime?:number;lastTradeTime?:number;reason:string};
}

/** Local-only API: public market data and local files, never account credentials. */
export function createMarketDataClient(request:typeof fetch=(input,init)=>fetch(input,init)){
  const base='/api/market-data';
  async function json<T>(path:string,init?:RequestInit):Promise<T>{
    const response=await request(base+path,{credentials:'same-origin',...init});const data=await response.json();
    if(!response.ok)throw Error(data.message??`本地行情服务 HTTP ${response.status}`);return data as T;
  }
  const post=<T>(path:string,body:unknown)=>json<T>(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const query=(values:Record<string,string|number|undefined>)=>new URLSearchParams(Object.entries(values).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)])).toString();
  return {
    datasets:(symbol?:string)=>json<DatasetInfo[]>(`/datasets?${query({symbol})}`),
    coverage:(id:string)=>json<DatasetCoverage>(`/datasets/${encodeURIComponent(id)}`),
    importArchives:(value:ArchiveRequest)=>post<ImportJob>('/imports',value),
    job:(id:string)=>json<ImportJob>(`/jobs/${encodeURIComponent(id)}`),
    jobs:(options:{limit?:number;offset?:number}={})=>json<ImportJob[]>(`/jobs?${query(options)}`),
    cancelJob:(id:string)=>json<ImportJob>(`/jobs/${encodeURIComponent(id)}`,{method:'DELETE'}),
    startRecording:(symbol:string)=>post<DatasetInfo>('/recordings',{symbol}),
    stopRecording:(id:string)=>post<DatasetInfo>(`/recordings/${encodeURIComponent(id)}/stop`,{}),
    resumeRecording:(id:string)=>post<DatasetInfo>(`/recordings/${encodeURIComponent(id)}/resume`,{}),
    append:(id:string,events:RecordedMarketEvent[])=>post<DatasetInfo>(`/recordings/${encodeURIComponent(id)}/events`,{events}),
    trades:(id:string,options:{from?:number;to?:number;limit?:number;cursor?:string}={})=>json<StoredTradePage>(`/datasets/${encodeURIComponent(id)}/trades?${query(options)}`),
    replay:(id:string,at:number,limit=200,signal?:AbortSignal)=>json<ReplaySnapshot>(`/datasets/${encodeURIComponent(id)}/replay?${query({at,limit})}`,{signal}),
    heatmap:(id:string,options:{from:number;to:number;samples?:number;levels?:number},signal?:AbortSignal)=>json<DepthHeatmap>(`/datasets/${encodeURIComponent(id)}/heatmap?${query(options)}`,{signal}),
    aggregate:async(id:string,options:HistoricalAggregateOptions,signal?:AbortSignal)=>{
      const result=await json<HistoricalFlowAggregate>(`/datasets/${encodeURIComponent(id)}/aggregate?${query({...options})}`,{signal});
      // JSON encodes unavailable NaN CVD as null; restore the chart's existing
      // explicit unknown convention instead of accidentally plotting zero.
      for(const bar of result.snapshot.footprint){if(bar.cvdBase===null)bar.cvdBase=NaN;if(bar.cvdQuote===null)bar.cvdQuote=NaN;}return result;
    },
    uploadArchive:(file:Blob,value:UploadArchiveRequest,signal?:AbortSignal)=>json<DatasetInfo>(`/uploads?${query({...value})}`,{method:'POST',headers:{'Content-Type':'application/zip'},body:file,signal}),
  };
}
