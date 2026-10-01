import type {BarInput} from '../core/types';
import type {BulkFeed} from '../feed/feed';
import {BinanceFeed,validBar} from '../feed/binance-feed';
import {CnAShareFeed,CoinbaseFeed,OkxFeed,getMarketConnector} from './connectors';
import type {ConnectorUserConfig} from './connector-config';

export type ConnectorProbeFeed=BulkFeed&{fetchHistory?:(limit:number)=>Promise<BarInput[]>};
export interface ConnectorProbeResult {kind:'history'|'simulation';bars:number;elapsedMs:number;lastClose?:number}
/** Own a throwaway REST reader. Never save draft settings, open a WebSocket,
 * mutate the current chart, or allow auto-mode simulation to pass a live test. */
export async function probeConnectorDraft(config:ConnectorUserConfig,options:{signal?:AbortSignal;createFeed?:(draft:ConnectorUserConfig)=>ConnectorProbeFeed}={}):Promise<ConnectorProbeResult>{
  options.signal?.throwIfAborted();
  if(config.source==='mock'||config.mode==='simulation')return {kind:'simulation',bars:0,elapsedMs:0};
  const connector=getMarketConnector(config.source),symbol=connector?.normalizeSymbol(config.defaultSymbol);
  if(!symbol)throw Error('品种代码无效');
  const draft={...config,defaultSymbol:symbol,mode:'live' as const};
  const create=(value:ConnectorUserConfig):ConnectorProbeFeed=>{
    const args={symbol:value.defaultSymbol,interval:'1d',restBase:value.restBase||undefined,wsUrl:value.wsUrl||undefined};
    if(value.source==='binance')return new BinanceFeed({...args,limit:60,wsBase:value.wsUrl||undefined});
    if(value.source==='okx')return new OkxFeed(args);
    if(value.source==='coinbase')return new CoinbaseFeed(args);
    if(value.source==='cn-a')return new CnAShareFeed({...args,mode:'live'});
    throw Error('此数据源暂不支持独立连接测试');
  };
  const feed=(options.createFeed??create)(draft),began=performance.now(),abort=()=>feed.disconnect();
  options.signal?.addEventListener('abort',abort,{once:true});
  try{
    const bars=await (feed.fetchHistory?feed.fetchHistory(60):feed.loadBulk());
    options.signal?.throwIfAborted();
    if(!bars.length||!bars.every(validBar))throw Error('未返回有效 K 线数据');
    return {kind:'history',bars:bars.length,elapsedMs:Math.round(performance.now()-began),lastClose:bars.at(-1)!.close};
  }finally{options.signal?.removeEventListener('abort',abort);feed.disconnect();}
}
