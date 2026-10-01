import type {BarEvent,BarInput,FeedStatus} from '../core/types';
import type {BulkFeed} from '../feed/feed';
import {BinanceFeed,nextOpenTime,validBar} from '../feed/binance-feed';
import {MockFeed,mockSeedForSymbol} from '../feed/mock-feed';
import {BinanceHistoryService,type HistoryRequest} from '../history/binance-history';
import type {DatasetSnapshot} from '../history/types';
import type {DatasetPersistence} from '../history/persistence';
import {TIMEFRAMES} from '../scene/types';
import type {MarketSymbol} from '../watchlist/types';
import {DEFAULT_SYMBOLS,normalizePerpetualSymbol,normalizeSymbol} from '../watchlist/symbols';
import {BINANCE_PERPETUAL_MARKET,fetchBinancePerpetualSymbols,type BinanceContractMetadata} from './binance-contracts';
import {connectorConfigStore,type ConnectorRunMode} from './connector-config';

export type BuiltinMarketSourceId='binance'|'okx'|'coinbase'|'cn-a'|'mock';
export type MarketSourceId=BuiltinMarketSourceId|(string&{});
export type MarketTypeId='spot'|'usdm-perpetual'|'cn-equity'|'simulation'|(string&{});
export type MarketAssetClass='crypto-perpetual'|'crypto-spot'|'cn-equity'|'simulation'|(string&{});

export interface MarketTradingSession {
  timezone:string;
  continuous24x7:boolean;
  sessions?:readonly {open:string;close:string}[];
  settlementRule?:'T+0'|'T+1';
  lotSize?:number;
  priceLimitRatio?:number;
}

export interface MarketConnectorCapabilities {
  supportsPause:boolean;
  supportsHistoricalBackfill:boolean;
  supportsDateRangeHistory:boolean;
  supportsContractRules:boolean;
  supportsMarkPriceValidation:boolean;
  supportsFundingRate:boolean;
  supportsLiveTradeFlow:boolean;
}

export interface MarketHistoryProvider {
  load(request:HistoryRequest):Promise<DatasetSnapshot>;
  describe?(symbol:string,signal?:AbortSignal):Promise<BinanceContractMetadata>;
  loadMarkPrices?(dataset:Pick<DatasetSnapshot,'symbol'|'interval'|'bars'>,signal?:AbortSignal):Promise<{time:number;close:number}[]>;
}

export interface MarketFeedParams {
  symbol:string;
  interval:string;
  intervalMs:number;
}

export interface MarketConnector {
  readonly id:MarketSourceId;
  readonly label:string;
  readonly shortLabel:string;
  readonly badge:string;
  readonly connectedLabel:string;
  readonly errorPrefix:string;
  readonly assetClass:MarketAssetClass;
  readonly marketType?:MarketTypeId;
  readonly defaultSymbol:string;
  readonly defaultQuoteCurrency:string;
  readonly session:MarketTradingSession;
  readonly capabilities:MarketConnectorCapabilities;
  readonly defaultSymbols:readonly MarketSymbol[];
  normalizeSymbol(input:string):string|null;
  toWireSymbol?(symbol:string):string;
  toWireInterval?(interval:string):string;
  fetchCatalog?(signal?:AbortSignal):Promise<MarketSymbol[]>;
  createFeed(params:MarketFeedParams):BulkFeed;
  extractContract?(feed:BulkFeed):BinanceContractMetadata|undefined;
  createHistoryProvider?(persistence?:DatasetPersistence,request?:typeof fetch):MarketHistoryProvider;
}

export const BINANCE_DEFAULT_SYMBOLS:readonly MarketSymbol[]=[
  {symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',name:'Bitcoin',source:'binance',marketType:'usdm-perpetual',exchangeLabel:'BINANCE',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'ETHUSDT',baseAsset:'ETH',quoteAsset:'USDT',name:'Ethereum',source:'binance',marketType:'usdm-perpetual',exchangeLabel:'BINANCE',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'SOLUSDT',baseAsset:'SOL',quoteAsset:'USDT',name:'Solana',source:'binance',marketType:'usdm-perpetual',exchangeLabel:'BINANCE',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'BNBUSDT',baseAsset:'BNB',quoteAsset:'USDT',name:'BNB',source:'binance',marketType:'usdm-perpetual',exchangeLabel:'BINANCE',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'XRPUSDT',baseAsset:'XRP',quoteAsset:'USDT',name:'XRP',source:'binance',marketType:'usdm-perpetual',exchangeLabel:'BINANCE',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'DOGEUSDT',baseAsset:'DOGE',quoteAsset:'USDT',name:'Dogecoin',source:'binance',marketType:'usdm-perpetual',exchangeLabel:'BINANCE',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'ADAUSDT',baseAsset:'ADA',quoteAsset:'USDT',name:'Cardano',source:'binance',marketType:'usdm-perpetual',exchangeLabel:'BINANCE',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'AVAXUSDT',baseAsset:'AVAX',quoteAsset:'USDT',name:'Avalanche',source:'binance',marketType:'usdm-perpetual',exchangeLabel:'BINANCE',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'LINKUSDT',baseAsset:'LINK',quoteAsset:'USDT',name:'Chainlink',source:'binance',marketType:'usdm-perpetual',exchangeLabel:'BINANCE',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'SUIUSDT',baseAsset:'SUI',quoteAsset:'USDT',name:'Sui',source:'binance',marketType:'usdm-perpetual',exchangeLabel:'BINANCE',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
];

export const OKX_DEFAULT_SYMBOLS:readonly MarketSymbol[]=[
  {symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',name:'Bitcoin · BTC-USDT-SWAP',source:'okx',marketType:'usdm-perpetual',exchangeLabel:'OKX',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'ETHUSDT',baseAsset:'ETH',quoteAsset:'USDT',name:'Ethereum · ETH-USDT-SWAP',source:'okx',marketType:'usdm-perpetual',exchangeLabel:'OKX',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'SOLUSDT',baseAsset:'SOL',quoteAsset:'USDT',name:'Solana · SOL-USDT-SWAP',source:'okx',marketType:'usdm-perpetual',exchangeLabel:'OKX',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'XRPUSDT',baseAsset:'XRP',quoteAsset:'USDT',name:'XRP · XRP-USDT-SWAP',source:'okx',marketType:'usdm-perpetual',exchangeLabel:'OKX',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'DOGEUSDT',baseAsset:'DOGE',quoteAsset:'USDT',name:'Dogecoin · DOGE-USDT-SWAP',source:'okx',marketType:'usdm-perpetual',exchangeLabel:'OKX',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'SUIUSDT',baseAsset:'SUI',quoteAsset:'USDT',name:'Sui · SUI-USDT-SWAP',source:'okx',marketType:'usdm-perpetual',exchangeLabel:'OKX',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'OKBUSDT',baseAsset:'OKB',quoteAsset:'USDT',name:'OKB · OKB-USDT-SWAP',source:'okx',marketType:'usdm-perpetual',exchangeLabel:'OKX',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
  {symbol:'TONUSDT',baseAsset:'TON',quoteAsset:'USDT',name:'Toncoin · TON-USDT-SWAP',source:'okx',marketType:'usdm-perpetual',exchangeLabel:'OKX',marketBadge:'USDT 永续',contractType:'PERPETUAL'},
];

export const CN_A_SHARE_SYMBOLS:readonly MarketSymbol[]=[
  {symbol:'600519.SH',baseAsset:'600519',quoteAsset:'CNY',name:'贵州茅台',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市主板'},
  {symbol:'300750.SZ',baseAsset:'300750',quoteAsset:'CNY',name:'宁德时代',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'创业板'},
  {symbol:'002594.SZ',baseAsset:'002594',quoteAsset:'CNY',name:'比亚迪',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'深市主板'},
  {symbol:'601318.SH',baseAsset:'601318',quoteAsset:'CNY',name:'中国平安',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市主板'},
  {symbol:'000001.SZ',baseAsset:'000001',quoteAsset:'CNY',name:'平安银行',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'深市主板'},
  {symbol:'600036.SH',baseAsset:'600036',quoteAsset:'CNY',name:'招商银行',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市主板'},
  {symbol:'688981.SH',baseAsset:'688981',quoteAsset:'CNY',name:'中芯国际',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'科创板'},
  {symbol:'300059.SZ',baseAsset:'300059',quoteAsset:'CNY',name:'东方财富',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'创业板'},
  {symbol:'601899.SH',baseAsset:'601899',quoteAsset:'CNY',name:'紫金矿业',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市主板'},
  {symbol:'000858.SZ',baseAsset:'000858',quoteAsset:'CNY',name:'五粮液',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'深市主板'},
  {symbol:'600900.SH',baseAsset:'600900',quoteAsset:'CNY',name:'长江电力',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市主板'},
  {symbol:'601012.SH',baseAsset:'601012',quoteAsset:'CNY',name:'隆基绿能',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市主板'},
  {symbol:'600276.SH',baseAsset:'600276',quoteAsset:'CNY',name:'恒瑞医药',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市主板'},
  {symbol:'601888.SH',baseAsset:'601888',quoteAsset:'CNY',name:'中国中免',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市主板'},
  {symbol:'600030.SH',baseAsset:'600030',quoteAsset:'CNY',name:'中信证券',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市主板'},
  {symbol:'603259.SH',baseAsset:'603259',quoteAsset:'CNY',name:'药明康德',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市主板'},
  {symbol:'601138.SH',baseAsset:'601138',quoteAsset:'CNY',name:'工业富联',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市主板'},
  {symbol:'601088.SH',baseAsset:'601088',quoteAsset:'CNY',name:'中国神华',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市主板'},
  {symbol:'000333.SZ',baseAsset:'000333',quoteAsset:'CNY',name:'美的集团',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'深市主板'},
  {symbol:'000651.SZ',baseAsset:'000651',quoteAsset:'CNY',name:'格力电器',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'深市主板'},
  {symbol:'002475.SZ',baseAsset:'002475',quoteAsset:'CNY',name:'立讯精密',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'深市主板'},
  {symbol:'002415.SZ',baseAsset:'002415',quoteAsset:'CNY',name:'海康威视',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'深市主板'},
  {symbol:'002230.SZ',baseAsset:'002230',quoteAsset:'CNY',name:'科大讯飞',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'深市主板'},
  {symbol:'300760.SZ',baseAsset:'300760',quoteAsset:'CNY',name:'迈瑞医疗',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'创业板'},
  {symbol:'300274.SZ',baseAsset:'300274',quoteAsset:'CNY',name:'阳光电源',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'创业板'},
  {symbol:'300124.SZ',baseAsset:'300124',quoteAsset:'CNY',name:'汇川技术',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'创业板'},
  {symbol:'300308.SZ',baseAsset:'300308',quoteAsset:'CNY',name:'中际旭创',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'创业板'},
  {symbol:'688041.SH',baseAsset:'688041',quoteAsset:'CNY',name:'海光信息',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'科创板'},
  {symbol:'688256.SH',baseAsset:'688256',quoteAsset:'CNY',name:'寒武纪',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'科创板'},
  {symbol:'688111.SH',baseAsset:'688111',quoteAsset:'CNY',name:'金山办公',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'科创板'},
  {symbol:'830799.BJ',baseAsset:'830799',quoteAsset:'CNY',name:'艾融软件',source:'cn-a',marketType:'cn-equity',exchangeLabel:'北交所',marketBadge:'北证A股'},
  {symbol:'835185.BJ',baseAsset:'835185',quoteAsset:'CNY',name:'贝特瑞',source:'cn-a',marketType:'cn-equity',exchangeLabel:'北交所',marketBadge:'北证A股'},
  {symbol:'510300.SH',baseAsset:'510300',quoteAsset:'CNY',name:'沪深300ETF',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市ETF'},
  {symbol:'588000.SH',baseAsset:'588000',quoteAsset:'CNY',name:'科创50ETF',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市ETF'},
  {symbol:'159915.SZ',baseAsset:'159915',quoteAsset:'CNY',name:'创业板ETF',source:'cn-a',marketType:'cn-equity',exchangeLabel:'深交所',marketBadge:'深市ETF'},
];

export const COINBASE_DEFAULT_SYMBOLS:readonly MarketSymbol[]=[
  {symbol:'BTC-USD',baseAsset:'BTC',quoteAsset:'USD',name:'Bitcoin',source:'coinbase',marketType:'spot',exchangeLabel:'COINBASE',marketBadge:'USD 现货'},
  {symbol:'ETH-USD',baseAsset:'ETH',quoteAsset:'USD',name:'Ethereum',source:'coinbase',marketType:'spot',exchangeLabel:'COINBASE',marketBadge:'USD 现货'},
  {symbol:'SOL-USD',baseAsset:'SOL',quoteAsset:'USD',name:'Solana',source:'coinbase',marketType:'spot',exchangeLabel:'COINBASE',marketBadge:'USD 现货'},
  {symbol:'XRP-USD',baseAsset:'XRP',quoteAsset:'USD',name:'XRP',source:'coinbase',marketType:'spot',exchangeLabel:'COINBASE',marketBadge:'USD 现货'},
  {symbol:'DOGE-USD',baseAsset:'DOGE',quoteAsset:'USD',name:'Dogecoin',source:'coinbase',marketType:'spot',exchangeLabel:'COINBASE',marketBadge:'USD 现货'},
  {symbol:'ADA-USD',baseAsset:'ADA',quoteAsset:'USD',name:'Cardano',source:'coinbase',marketType:'spot',exchangeLabel:'COINBASE',marketBadge:'USD 现货'},
  {symbol:'AVAX-USD',baseAsset:'AVAX',quoteAsset:'USD',name:'Avalanche',source:'coinbase',marketType:'spot',exchangeLabel:'COINBASE',marketBadge:'USD 现货'},
  {symbol:'LINK-USD',baseAsset:'LINK',quoteAsset:'USD',name:'Chainlink',source:'coinbase',marketType:'spot',exchangeLabel:'COINBASE',marketBadge:'USD 现货'},
  {symbol:'SUI-USD',baseAsset:'SUI',quoteAsset:'USD',name:'Sui',source:'coinbase',marketType:'spot',exchangeLabel:'COINBASE',marketBadge:'USD 现货'},
];

export async function fetchOkxSwapSymbols(signal?:AbortSignal):Promise<MarketSymbol[]> {
  try {
    const restBase=(connectorConfigStore.get('okx').restBase||'https://www.okx.com').replace(/\/+$/,'');
    const r=await fetch(`${restBase}/api/v5/public/instruments?instType=SWAP`,{signal});
    if(!r.ok)return [...OKX_DEFAULT_SYMBOLS];
    const body=await r.json() as {data?:Array<{instId?:string;ctValCcy?:string;settleCcy?:string;state?:string}>};
    if(!Array.isArray(body?.data))return [...OKX_DEFAULT_SYMBOLS];
    const items:MarketSymbol[]=[];
    for(const row of body.data){
      if(row.state!=='live'||row.settleCcy!=='USDT'||typeof row.instId!=='string'||!row.instId.endsWith('-USDT-SWAP'))continue;
      const base=row.instId.slice(0,-'-USDT-SWAP'.length);
      const symbol=normalizeOkxSwapSymbol(`${base}USDT`);
      if(!symbol)continue;
      items.push({symbol,baseAsset:base,quoteAsset:'USDT',name:`${base} · ${row.instId}`,source:'okx',marketType:'usdm-perpetual',exchangeLabel:'OKX',marketBadge:'USDT 永续',contractType:'PERPETUAL'});
    }
    return items.length?items:[...OKX_DEFAULT_SYMBOLS];
  } catch(err){
    if(err instanceof Error&&err.name==='AbortError')throw err;
    return [...OKX_DEFAULT_SYMBOLS];
  }
}

export async function fetchCoinbaseSpotSymbols(signal?:AbortSignal):Promise<MarketSymbol[]> {
  try {
    const restBase=(connectorConfigStore.get('coinbase').restBase||'https://api.exchange.coinbase.com').replace(/\/+$/,'');
    const r=await fetch(`${restBase}/products`,{signal});
    if(!r.ok)return [...COINBASE_DEFAULT_SYMBOLS];
    const rows=await r.json() as Array<{id?:string;base_currency?:string;quote_currency?:string;display_name?:string;status?:string}>;
    if(!Array.isArray(rows))return [...COINBASE_DEFAULT_SYMBOLS];
    const items:MarketSymbol[]=[];
    for(const row of rows){
      if(row.status!=='online'||(row.quote_currency!=='USD'&&row.quote_currency!=='USDC')||typeof row.id!=='string'||typeof row.base_currency!=='string')continue;
      const symbol=normalizeCoinbaseSymbol(row.id);
      if(!symbol)continue;
      items.push({symbol,baseAsset:row.base_currency,quoteAsset:row.quote_currency,name:row.display_name??row.base_currency,source:'coinbase',marketType:'spot',exchangeLabel:'COINBASE',marketBadge:`${row.quote_currency} 现货`});
    }
    return items.length?items:[...COINBASE_DEFAULT_SYMBOLS];
  } catch(err){
    if(err instanceof Error&&err.name==='AbortError')throw err;
    return [...COINBASE_DEFAULT_SYMBOLS];
  }
}

export function normalizeOkxSwapSymbol(input:string):string|null {
  if(typeof input!=='string')return null;
  const raw=input.trim().toUpperCase().replace(/^OKX:/,'').replace(/[-_/]SWAP$/,'').replace(/\.P$/,'');
  return normalizePerpetualSymbol(raw);
}

export function toOkxSwapInstId(symbol:string):string {
  const canonical=normalizeOkxSwapSymbol(symbol)??'BTCUSDT';
  const base=canonical.endsWith('USDT')?canonical.slice(0,-4):canonical;
  return `${base}-USDT-SWAP`;
}

export function toOkxBar(interval:string):string {
  const map:Record<string,string>={
    '1m':'1m','3m':'3m','5m':'5m','15m':'15m','30m':'30m',
    '1h':'1H','2h':'2H','4h':'4H','6h':'6Hutc','12h':'12Hutc',
    '1d':'1Dutc','3d':'3Dutc','7d':'1Wutc','30d':'1Mutc',
  };
  return map[interval]??'15m';
}

export function normalizeCoinbaseSymbol(input:string):string|null {
  if(typeof input!=='string')return null;
  const raw=input.trim().toUpperCase().replace(/^COINBASE:/,'').replace(/\.P$/,'');
  const dashed=/^([A-Z0-9]{2,12})[-/](USD|USDT|USDC)$/.exec(raw);
  if(dashed)return `${dashed[1]}-${dashed[2]==='USDT'?'USD':dashed[2]}`;
  const compact=/^([A-Z0-9]{2,12})(USDT|USDC|USD)$/.exec(raw);
  if(compact)return `${compact[1]}-${compact[2]==='USDT'?'USD':compact[2]}`;
  return null;
}

export function normalizeCnAShareSymbol(input:string):string|null {
  if(typeof input!=='string')return null;
  const raw=input.trim().toUpperCase().replace(/^(?:SSE|SZSE|BSE|CN):/,'');
  const suffixed=/^(\d{6})\.(SH|SZ|BJ)$/.exec(raw);
  if(suffixed)return `${suffixed[1]}.${suffixed[2]}`;
  const prefixed=/^(SH|SZ|BJ)(\d{6})$/.exec(raw);
  if(prefixed)return `${prefixed[2]}.${prefixed[1]}`;
  const digits=/^(\d{6})$/.exec(raw);
  if(digits){
    const code=digits[1],exchange=code.startsWith('6')||code.startsWith('5')||code.startsWith('9')?'SH':code.startsWith('4')||code.startsWith('8')?'BJ':'SZ';
    return `${code}.${exchange}`;
  }
  return null;
}

export function normalizeMockSymbol(input:string):string|null {
  return normalizeCnAShareSymbol(input)??normalizeCoinbaseSymbol(input)??normalizePerpetualSymbol(input)??normalizeSymbol(input);
}

/** OKX public v5 USDT-M Swap kline adapter (REST + WebSocket). */
export class OkxFeed implements BulkFeed {
  readonly name='okx';readonly symbol:string;readonly interval:string;
  private restBase:string;private wsUrl:string;
  private ws:WebSocket|null=null;private stopped=false;private lastT=-1;
  private aborter=new AbortController();
  private barCbs:((e:BarEvent)=>void)[]=[];private statusCbs:((s:FeedStatus)=>void)[]=[];
  constructor(opts:{symbol?:string;interval?:string;restBase?:string;wsUrl?:string}={}) {
    const symbol=normalizeOkxSwapSymbol(opts.symbol??'BTCUSDT');
    if(!symbol)throw Error('请选择有效的 OKX USDT 永续合约');
    this.symbol=symbol;this.interval=opts.interval??'15m';
    nextOpenTime(0,this.interval);
    this.restBase=(opts.restBase??'https://www.okx.com').replace(/\/+$/,'');
    this.wsUrl=opts.wsUrl??'wss://ws.okx.com:8443/ws/v5/business';
  }
  onBar(cb:(e:BarEvent)=>void):void{this.barCbs.push(cb);}
  onStatus(cb:(s:FeedStatus)=>void):void{this.statusCbs.push(cb);}
  private status(s:FeedStatus):void{if(!this.stopped)this.statusCbs.forEach(cb=>cb(s));}
  private parseRows(rows:unknown):BarInput[] {
    if(!Array.isArray(rows))throw Error('OKX 返回了无效的 K 线数据');
    const bars=rows.map((r:unknown)=>{
      if(!Array.isArray(r)||r.length<6)throw Error('OKX K 线行格式无效');
      const b:BarInput={time:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])};
      if(!validBar(b))throw Error('OKX OHLCV 无效');
      return b;
    }).sort((a,b)=>a.time-b.time);
    return bars;
  }
  async loadBulk():Promise<BarInput[]> {
    const query=new URLSearchParams({instId:toOkxSwapInstId(this.symbol),bar:toOkxBar(this.interval),limit:'300'});
    const signal=AbortSignal.any([AbortSignal.timeout(10000),this.aborter.signal]);
    const res=await fetch(`${this.restBase}/api/v5/market/candles?${query}`,{signal});
    if(!res.ok)throw Error(`OKX HTTP ${res.status}`);
    const payload=await res.json() as {data?:unknown};
    const bars=this.parseRows(payload?.data);
    if(bars.length)this.lastT=bars[bars.length-1].time;
    return bars;
  }
  async connect():Promise<void> {
    if(this.ws||this.stopped)return;
    this.status('reconnecting');
    try{
      const ws=new WebSocket(this.wsUrl);this.ws=ws;
      const channel=`candle${toOkxBar(this.interval)}`,instId=toOkxSwapInstId(this.symbol);
      ws.onopen=()=>{if(this.ws===ws){ws.send(JSON.stringify({op:'subscribe',args:[{channel,instId}]}));this.status('ok');}};
      ws.onmessage=ev=>{
        if(this.ws!==ws||this.stopped)return;
        try{
          const msg=JSON.parse(String(ev.data)) as {data?:unknown[]};
          if(!Array.isArray(msg.data)||!msg.data.length)return;
          for(const b of this.parseRows(msg.data)){
            if(b.time<this.lastT)continue;
            const isNew=b.time>this.lastT;this.lastT=b.time;
            this.barCbs.forEach(cb=>cb({...b,isNew}));
          }
        }catch{}
      };
      ws.onerror=()=>this.status('reconnecting');
      ws.onclose=()=>{if(this.ws===ws)this.ws=null;};
    }catch{this.status('ok');}
  }
  disconnect():void {
    this.stopped=true;this.aborter.abort();
    const ws=this.ws;this.ws=null;
    if(ws){ws.onopen=ws.onmessage=ws.onerror=ws.onclose=null;ws.close();}
  }
}

/** Coinbase Exchange public spot kline adapter (REST + WebSocket). */
export class CoinbaseFeed implements BulkFeed {
  readonly name='coinbase';readonly symbol:string;readonly interval:string;
  private restBase:string;private wsUrl:string;
  private ws:WebSocket|null=null;private stopped=false;private lastBar:BarInput|null=null;
  private aborter=new AbortController();
  private barCbs:((e:BarEvent)=>void)[]=[];private statusCbs:((s:FeedStatus)=>void)[]=[];
  constructor(opts:{symbol?:string;interval?:string;restBase?:string;wsUrl?:string}={}) {
    const symbol=normalizeCoinbaseSymbol(opts.symbol??'BTC-USD');
    if(!symbol)throw Error('请选择有效的 Coinbase 现货交易对');
    this.symbol=symbol;this.interval=opts.interval??'15m';
    this.restBase=(opts.restBase??'https://api.exchange.coinbase.com').replace(/\/+$/,'');
    this.wsUrl=opts.wsUrl??'wss://ws-feed.exchange.coinbase.com';
  }
  onBar(cb:(e:BarEvent)=>void):void{this.barCbs.push(cb);}
  onStatus(cb:(s:FeedStatus)=>void):void{this.statusCbs.push(cb);}
  private status(s:FeedStatus):void{if(!this.stopped)this.statusCbs.forEach(cb=>cb(s));}
  async loadBulk():Promise<BarInput[]> {
    const stepSec=Math.floor((TIMEFRAMES[this.interval]??900_000)/1000);
    const granularity=[60,300,900,3600,21600,86400].find(g=>g<=stepSec&&stepSec%g===0)??(stepSec>=86400?86400:3600);
    const signal=AbortSignal.any([AbortSignal.timeout(10000),this.aborter.signal]);
    const res=await fetch(`${this.restBase}/products/${this.symbol}/candles?granularity=${granularity}`,{signal});
    if(!res.ok)throw Error(`Coinbase HTTP ${res.status}`);
    const raw=await res.json();
    if(!Array.isArray(raw))throw Error('Coinbase 返回了无效的 K 线数据');
    const sourceBars=raw.map((r:unknown)=>{
      if(!Array.isArray(r)||r.length<6)throw Error('Coinbase K 线行格式无效');
      const b:BarInput={time:Number(r[0])*1000,low:Number(r[1]),high:Number(r[2]),open:Number(r[3]),close:Number(r[4]),volume:Number(r[5])};
      if(!validBar(b))throw Error('Coinbase OHLCV 无效');
      return b;
    }).sort((a,b)=>a.time-b.time);
    const bucketMs=TIMEFRAMES[this.interval]??900_000;
    const aggregated=new Map<number,BarInput>();
    for(const b of sourceBars){
      const bucket=Math.floor(b.time/bucketMs)*bucketMs;
      const prev=aggregated.get(bucket);
      if(!prev)aggregated.set(bucket,{...b,time:bucket});
      else {prev.high=Math.max(prev.high,b.high);prev.low=Math.min(prev.low,b.low);prev.close=b.close;prev.volume+=b.volume;}
    }
    const bars=[...aggregated.values()];
    if(bars.length)this.lastBar={...bars[bars.length-1]};
    return bars;
  }
  async connect():Promise<void> {
    if(this.ws||this.stopped)return;
    this.status('reconnecting');
    try{
      const ws=new WebSocket(this.wsUrl);this.ws=ws;
      ws.onopen=()=>{if(this.ws===ws){ws.send(JSON.stringify({type:'subscribe',product_ids:[this.symbol],channels:['ticker']}));this.status('ok');}};
      ws.onmessage=ev=>{
        if(this.ws!==ws||this.stopped||!this.lastBar)return;
        try{
          const msg=JSON.parse(String(ev.data)) as {type?:string;price?:string;last_size?:string;time?:string};
          if(msg.type!=='ticker'||!msg.price)return;
          const price=Number(msg.price),size=Number(msg.last_size??0),ts=msg.time?Date.parse(msg.time):Date.now();
          if(!Number.isFinite(price)||price<=0)return;
          const step=TIMEFRAMES[this.interval]??900_000,bucket=Math.floor(ts/step)*step;
          const isNew=bucket>this.lastBar.time;
          this.lastBar=isNew?{time:bucket,open:price,high:price,low:price,close:price,volume:Math.max(0,size)}:{
            ...this.lastBar,high:Math.max(this.lastBar.high,price),low:Math.min(this.lastBar.low,price),close:price,volume:this.lastBar.volume+Math.max(0,size),
          };
          this.barCbs.forEach(cb=>cb({...this.lastBar!,isNew}));
        }catch{}
      };
      ws.onerror=()=>this.status('reconnecting');
      ws.onclose=()=>{if(this.ws===ws)this.ws=null;};
    }catch{this.status('ok');}
  }
  disconnect():void {
    this.stopped=true;this.aborter.abort();
    const ws=this.ws;this.ws=null;
    if(ws){ws.onopen=ws.onmessage=ws.onerror=ws.onclose=null;ws.close();}
  }
}

const CN_BASE_PRICES:Record<string,number>={
  '600519.SH':1520,'300750.SZ':215,'002594.SZ':278,'601318.SH':52.6,'000001.SZ':11.85,
  '600036.SH':38.4,'688981.SH':89.5,'300059.SZ':23.8,'601899.SH':17.2,'000858.SZ':138.5,
  '510300.SH':3.96,'830799.BJ':46.2,'600900.SH':28.5,'601012.SH':17.4,'600276.SH':46.8,
  '601888.SH':65.2,'600030.SH':26.4,'603259.SH':54.1,'601138.SH':22.8,'601088.SH':39.5,
  '000333.SZ':71.2,'000651.SZ':43.5,'002475.SZ':39.8,'002415.SZ':30.6,'002230.SZ':48.2,
  '300760.SZ':265.0,'300274.SZ':82.5,'300124.SZ':62.4,'300308.SZ':136.0,'688041.SH':125.0,
  '688256.SH':480.0,'688111.SH':295.0,'835185.BJ':21.6,'588000.SH':1.05,'159915.SZ':2.18,
};

/** China A-share (沪深京) connector feed: fetches real Eastmoney/Tencent K-lines via local server proxy (`/api/market-data/cn-a/klines`) with automatic fallback to deterministic session K-lines when offline. */
export class CnAShareFeed implements BulkFeed {
  readonly name='cn-a';readonly symbol:string;readonly interval:string;
  private restBase:string;private mode:ConnectorRunMode;
  private timer:ReturnType<typeof setInterval>|null=null;
  private lastBar:BarInput|null=null;
  private usingLiveApi=false;
  private stopped=false;
  private aborter=new AbortController();
  private rng:()=>number;
  private barCbs:((e:BarEvent)=>void)[]=[];private statusCbs:((s:FeedStatus)=>void)[]=[];
  constructor(opts:{symbol?:string;interval?:string;restBase?:string;mode?:ConnectorRunMode}={}) {
    const symbol=normalizeCnAShareSymbol(opts.symbol??'600519.SH');
    if(!symbol)throw Error('请输入有效的沪深京 A 股代码（如 600519.SH、300750.SZ）');
    this.symbol=symbol;this.interval=opts.interval??'15m';
    const cfg=connectorConfigStore.get('cn-a');
    this.restBase=(opts.restBase??cfg.restBase??'/api/market-data/cn-a').replace(/\/+$/,'');
    this.mode=opts.mode??cfg.mode??'auto';
    let s=mockSeedForSymbol(this.symbol);
    this.rng=()=>{s=(s+0x6d2b79f5)|0;let t=Math.imul(s^(s>>>15),1|s);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};
  }
  onBar(cb:(e:BarEvent)=>void):void{this.barCbs.push(cb);}
  onStatus(cb:(s:FeedStatus)=>void):void{this.statusCbs.push(cb);}
  loadBulk():BarInput[] {
    const count=2400,step=TIMEFRAMES[this.interval]??900_000;
    const now=Math.floor(Date.now()/step)*step,start=now-(count-1)*step;
    let price=CN_BASE_PRICES[this.symbol]??35;
    const bars:BarInput[]=[];
    for(let i=0;i<count;i++){
      const time=start+i*step,open=price;
      const move=(this.rng()-.496)*price*.008;
      const close=Math.max(1,Number((open+move).toFixed(2)));
      const high=Number((Math.max(open,close)+this.rng()*price*.005).toFixed(2));
      const low=Number(Math.max(.5,Math.min(open,close)-this.rng()*price*.005).toFixed(2));
      const volume=Math.round((200+this.rng()*1800))*100;
      bars.push({time,open,high,low,close,volume});
      price=close;
    }
    this.lastBar={...bars[bars.length-1]};
    return bars;
  }
  private async fetchBrowserEastmoney(limit:number,signal:AbortSignal):Promise<BarInput[]> {
    const [code,ex='SH']=this.symbol.split('.');
    const secid=`${ex==='SH'?1:0}.${code}`;
    const kltMap:Record<string,number>={'1m':1,'3m':5,'5m':5,'15m':15,'30m':30,'1h':60,'2h':60,'4h':101,'6h':101,'12h':101,'1d':101,'3d':101,'7d':102,'30d':103};
    const klt=kltMap[this.interval]??15;
    const qs=new URLSearchParams({
      secid,
      ut:'fa5fd1943c7b386f172d6893dbfba10b',
      fields1:'f1,f2,f3,f4,f5,f6',
      fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
      klt:String(klt),
      fqt:'1',
      end:'20500101',
      lmt:String(Math.max(20,Math.min(1500,limit))),
    });
    const res=await fetch(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${qs}`,{signal});
    if(!res.ok)throw Error(`Eastmoney HTTP ${res.status}`);
    const body=await res.json() as {data?:{name?:string;klines?:string[]}};
    const klines=body?.data?.klines;
    if(!Array.isArray(klines)||!klines.length)throw Error('Eastmoney 返回空 K 线');
    const bars:BarInput[]=[];
    for(const row of klines){
      const p=row.split(',');
      if(p.length<6)continue;
      const rawTime=p[0].trim();
      const time=/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(rawTime)
        ?Date.parse(`${rawTime.replace(/\s+/,'T')}:00+08:00`)
        :/^\d{4}-\d{2}-\d{2}$/.test(rawTime)
        ?Date.parse(`${rawTime}T00:00:00+08:00`)
        :Date.parse(rawTime);
      const b:BarInput={
        time,
        open:Number(p[1]),
        close:Number(p[2]),
        high:Number(p[3]),
        low:Number(p[4]),
        volume:Math.max(0,Number(p[5])*100),
      };
      if(validBar(b))bars.push(b);
    }
    if(!bars.length)throw Error('Eastmoney K 线解析为空');
    return bars.sort((a,b)=>a.time-b.time);
  }
  async fetchHistory(limit=500):Promise<BarInput[]> {
    if(this.mode==='simulation'||typeof fetch!=='function'){
      this.usingLiveApi=false;
      return this.loadBulk();
    }
    const signal=AbortSignal.any([AbortSignal.timeout(8500),this.aborter.signal]);
    try{
      const query=new URLSearchParams({symbol:this.symbol,interval:this.interval,limit:String(limit)});
      const res=await fetch(`${this.restBase}/klines?${query}`,{signal});
      if(!res.ok){
        const errBody=await res.json().catch(()=>({})) as {message?:string};
        throw Error(errBody.message||`A股网关 HTTP ${res.status}`);
      }
      const payload=await res.json() as {bars?:BarInput[]};
      if(!Array.isArray(payload.bars)||!payload.bars.length){
        throw Error('A股网关返回空 K 线数据');
      }
      const valid=payload.bars.filter(validBar).sort((a,b)=>a.time-b.time);
      if(!valid.length)throw Error('A股 K 线格式校验未通过');
      this.usingLiveApi=true;
      this.lastBar={...valid[valid.length-1]};
      return valid;
    }catch(proxyErr){
      try{
        const direct=await this.fetchBrowserEastmoney(limit,signal);
        this.usingLiveApi=true;
        this.lastBar={...direct[direct.length-1]};
        return direct;
      }catch{
        if(this.mode==='live')throw proxyErr;
        this.usingLiveApi=false;
        return this.loadBulk();
      }
    }
  }
  async connect():Promise<void> {
    if(this.timer||this.stopped)return;
    this.statusCbs.forEach(cb=>cb('ok'));
    if(this.usingLiveApi){
      this.timer=setInterval(async()=>{
        if(this.stopped)return;
        try{
          const query=new URLSearchParams({symbol:this.symbol,interval:this.interval,limit:'2'});
          const res=await fetch(`${this.restBase}/klines?${query}`,{signal:AbortSignal.any([AbortSignal.timeout(5000),this.aborter.signal])});
          if(!res.ok)return;
          const payload=await res.json() as {bars?:BarInput[]};
          if(!Array.isArray(payload.bars)||!payload.bars.length)return;
          for(const b of payload.bars){
            if(!validBar(b))continue;
            if(!this.lastBar||b.time>=this.lastBar.time){
              const isNew=!this.lastBar||b.time>this.lastBar.time;
              this.lastBar={...b};
              this.barCbs.forEach(cb=>cb({...b,isNew}));
            }
          }
        }catch{}
      },5000);
      return;
    }
    const step=TIMEFRAMES[this.interval]??900_000;
    this.timer=setInterval(()=>{
      if(!this.lastBar||this.stopped)return;
      const b=this.lastBar,now=Date.now(),isNew=now-b.time>=step;
      const open=isNew?b.close:b.open;
      const close=Math.max(1,Number((b.close+(this.rng()-.498)*b.close*.0015).toFixed(2)));
      this.lastBar=isNew?{time:b.time+step,open,high:Math.max(open,close),low:Math.min(open,close),close,volume:100}:{
        time:b.time,open,high:Math.max(b.high,close),low:Math.min(b.low,close),close,volume:b.volume+100,
      };
      this.barCbs.forEach(cb=>cb({...this.lastBar!,isNew}));
    },500);
  }
  disconnect():void {
    this.stopped=true;
    this.aborter.abort();
    if(this.timer){clearInterval(this.timer);this.timer=null;}
  }
}

export function tagConnectorSymbol(connector:MarketConnector,item:MarketSymbol):MarketSymbol {
  const defaultBadge=connector.id==='binance'||connector.id==='okx'?'USDT 永续':connector.id==='coinbase'?`${item.quoteAsset||'USD'} 现货`:connector.id==='cn-a'?'沪深京':'模拟行情';
  return {
    ...item,
    source:item.source??connector.id,
    marketType:item.marketType??connector.marketType??'simulation',
    exchangeLabel:item.exchangeLabel??connector.shortLabel.toUpperCase(),
    marketBadge:item.marketBadge??defaultBadge,
  };
}

export function synthesizeSymbolForConnector(connector:MarketConnector,rawInput:string):MarketSymbol|null {
  const symbol=connector.normalizeSymbol(rawInput);
  if(!symbol)return null;
  if(connector.id==='cn-a'){
    const [code,ex='SH']=symbol.split('.');
    const exchangeLabel=ex==='SH'?'上交所':ex==='BJ'?'北交所':'深交所';
    const marketBadge=code.startsWith('688')?'科创板':code.startsWith('30')?'创业板':ex==='BJ'?'北证A股':ex==='SH'?'沪市主板':'深市主板';
    return {symbol,baseAsset:code,quoteAsset:'CNY',name:`A股 ${symbol}`,source:'cn-a',marketType:'cn-equity',exchangeLabel,marketBadge};
  }
  if(connector.id==='coinbase'){
    const [base=symbol,quote='USD']=symbol.split('-');
    return {symbol,baseAsset:base,quoteAsset:quote,name:`${base} / ${quote}`,source:'coinbase',marketType:'spot',exchangeLabel:'COINBASE',marketBadge:`${quote} 现货`};
  }
  const quote=connector.defaultQuoteCurrency||'USDT';
  const base=symbol.endsWith(quote)&&symbol.length>quote.length?symbol.slice(0,-quote.length):symbol;
  return tagConnectorSymbol(connector,{
    symbol,
    baseAsset:base,
    quoteAsset:quote,
    name:connector.id==='okx'?`${base} · ${toOkxSwapInstId(symbol)}`:base,
    ...(connector.marketType==='usdm-perpetual'?{contractType:'PERPETUAL' as const}:{}),
  });
}

export const binanceUsdmConnector:MarketConnector={
  id:'binance',
  label:'Binance · USDT 永续',
  shortLabel:'Binance',
  badge:'BINANCE · USDT 永续',
  connectedLabel:'Binance 已连接',
  errorPrefix:'Binance 行情连接失败',
  assetClass:'crypto-perpetual',
  marketType:BINANCE_PERPETUAL_MARKET,
  defaultSymbol:'BTCUSDT',
  defaultQuoteCurrency:'USDT',
  session:{timezone:'UTC',continuous24x7:true,settlementRule:'T+0'},
  capabilities:{
    supportsPause:false,
    supportsHistoricalBackfill:true,
    supportsDateRangeHistory:true,
    supportsContractRules:true,
    supportsMarkPriceValidation:true,
    supportsFundingRate:true,
    supportsLiveTradeFlow:true,
  },
  defaultSymbols:BINANCE_DEFAULT_SYMBOLS,
  normalizeSymbol:normalizePerpetualSymbol,
  fetchCatalog:async signal=>(await fetchBinancePerpetualSymbols(signal)).map(item=>tagConnectorSymbol(binanceUsdmConnector,item)),
  createFeed:({symbol,interval,intervalMs})=>{
    const cfg=connectorConfigStore.get('binance');
    if(cfg.mode==='simulation')return new MockFeed({count:2400,symbol,intervalMs,seed:mockSeedForSymbol(symbol)});
    return new BinanceFeed({symbol,interval,restBase:cfg.restBase||undefined,wsBase:cfg.wsUrl||undefined});
  },
  extractContract:feed=>feed instanceof BinanceFeed?feed.contract:undefined,
  createHistoryProvider:(persistence,request)=>new BinanceHistoryService(persistence,request),
};

export const okxSwapConnector:MarketConnector={
  id:'okx',
  label:'OKX · USDT 永续',
  shortLabel:'OKX',
  badge:'OKX · USDT 永续',
  connectedLabel:'OKX 已连接',
  errorPrefix:'OKX 行情连接失败',
  assetClass:'crypto-perpetual',
  marketType:'usdm-perpetual',
  defaultSymbol:'BTCUSDT',
  defaultQuoteCurrency:'USDT',
  session:{timezone:'UTC',continuous24x7:true,settlementRule:'T+0'},
  capabilities:{
    supportsPause:false,
    supportsHistoricalBackfill:false,
    supportsDateRangeHistory:false,
    supportsContractRules:false,
    supportsMarkPriceValidation:false,
    supportsFundingRate:false,
    supportsLiveTradeFlow:false,
  },
  defaultSymbols:OKX_DEFAULT_SYMBOLS,
  normalizeSymbol:normalizeOkxSwapSymbol,
  fetchCatalog:fetchOkxSwapSymbols,
  toWireSymbol:toOkxSwapInstId,
  toWireInterval:toOkxBar,
  createFeed:({symbol,interval,intervalMs})=>{
    const cfg=connectorConfigStore.get('okx');
    if(cfg.mode==='simulation')return new MockFeed({count:2400,symbol,intervalMs,seed:mockSeedForSymbol(symbol)});
    return new OkxFeed({symbol,interval,restBase:cfg.restBase||undefined,wsUrl:cfg.wsUrl||undefined});
  },
};

export const coinbaseSpotConnector:MarketConnector={
  id:'coinbase',
  label:'Coinbase · USD 现货',
  shortLabel:'Coinbase',
  badge:'COINBASE · USD 现货',
  connectedLabel:'Coinbase 已连接',
  errorPrefix:'Coinbase 行情连接失败',
  assetClass:'crypto-spot',
  marketType:'spot',
  defaultSymbol:'BTC-USD',
  defaultQuoteCurrency:'USD',
  session:{timezone:'UTC',continuous24x7:true,settlementRule:'T+0'},
  capabilities:{
    supportsPause:false,
    supportsHistoricalBackfill:false,
    supportsDateRangeHistory:false,
    supportsContractRules:false,
    supportsMarkPriceValidation:false,
    supportsFundingRate:false,
    supportsLiveTradeFlow:false,
  },
  defaultSymbols:COINBASE_DEFAULT_SYMBOLS,
  normalizeSymbol:normalizeCoinbaseSymbol,
  fetchCatalog:fetchCoinbaseSpotSymbols,
  createFeed:({symbol,interval,intervalMs})=>{
    const cfg=connectorConfigStore.get('coinbase');
    if(cfg.mode==='simulation')return new MockFeed({count:2400,symbol,intervalMs,seed:mockSeedForSymbol(symbol)});
    return new CoinbaseFeed({symbol,interval,restBase:cfg.restBase||undefined,wsUrl:cfg.wsUrl||undefined});
  },
};

export const cnAShareConnector:MarketConnector={
  id:'cn-a',
  label:'A股 · 沪深京',
  shortLabel:'A股',
  badge:'A股 · 沪深京',
  connectedLabel:'A股行情已连接',
  errorPrefix:'A股行情加载失败',
  assetClass:'cn-equity',
  marketType:'cn-equity',
  defaultSymbol:'600519.SH',
  defaultQuoteCurrency:'CNY',
  session:{
    timezone:'Asia/Shanghai',
    continuous24x7:false,
    sessions:[{open:'09:30',close:'11:30'},{open:'13:00',close:'15:00'}],
    settlementRule:'T+1',
    lotSize:100,
    priceLimitRatio:0.1,
  },
  capabilities:{
    supportsPause:true,
    supportsHistoricalBackfill:false,
    supportsDateRangeHistory:false,
    supportsContractRules:false,
    supportsMarkPriceValidation:false,
    supportsFundingRate:false,
    supportsLiveTradeFlow:false,
  },
  defaultSymbols:CN_A_SHARE_SYMBOLS,
  normalizeSymbol:normalizeCnAShareSymbol,
  fetchCatalog:async()=>[...CN_A_SHARE_SYMBOLS],
  createFeed:({symbol,interval})=>{
    const cfg=connectorConfigStore.get('cn-a');
    return new CnAShareFeed({symbol,interval,restBase:cfg.restBase||undefined,mode:cfg.mode});
  },
};

export const mockMarketConnector:MarketConnector={
  id:'mock',
  label:'模拟行情 · 100万',
  shortLabel:'模拟行情',
  badge:'模拟数据',
  connectedLabel:'模拟行情运行中',
  errorPrefix:'数据加载失败',
  assetClass:'simulation',
  marketType:undefined,
  defaultSymbol:'BTCUSDT',
  defaultQuoteCurrency:'USDT',
  session:{timezone:'UTC',continuous24x7:true,settlementRule:'T+0'},
  capabilities:{
    supportsPause:true,
    supportsHistoricalBackfill:false,
    supportsDateRangeHistory:false,
    supportsContractRules:false,
    supportsMarkPriceValidation:false,
    supportsFundingRate:false,
    supportsLiveTradeFlow:false,
  },
  defaultSymbols:DEFAULT_SYMBOLS,
  normalizeSymbol:normalizeMockSymbol,
  createFeed:({symbol,intervalMs})=>new MockFeed({count:1_000_000,symbol,intervalMs,seed:mockSeedForSymbol(symbol)}),
};

export class MarketConnectorRegistry {
  private readonly connectors=new Map<MarketSourceId,MarketConnector>();
  private readonly listeners=new Set<(list:MarketConnector[])=>void>();
  constructor(initial:readonly MarketConnector[]=[]){
    for(const connector of initial)this.connectors.set(connector.id,connector);
  }
  register(connector:MarketConnector):void {
    if(!connector?.id?.trim())throw Error('数据源适配器必须包含有效的 id');
    this.connectors.set(connector.id,connector);
    this.notify();
  }
  unregister(id:MarketSourceId):boolean {
    const removed=this.connectors.delete(id);
    if(removed)this.notify();
    return removed;
  }
  get(id:string):MarketConnector|undefined {
    return this.connectors.get(id);
  }
  has(id:string):boolean {
    return this.connectors.has(id);
  }
  require(id:string):MarketConnector {
    const found=this.connectors.get(id);
    if(!found)throw Error(`未注册的数据源适配器: ${id}`);
    return found;
  }
  list():MarketConnector[] {
    return [...this.connectors.values()];
  }
  subscribe(listener:(list:MarketConnector[])=>void):()=>void {
    this.listeners.add(listener);
    listener(this.list());
    return ()=>this.listeners.delete(listener);
  }
  private notify():void {
    const current=this.list();
    for(const listener of this.listeners)listener(current);
  }
}

export const BUILTIN_MARKET_CONNECTORS:readonly MarketConnector[]=[
  binanceUsdmConnector,
  okxSwapConnector,
  coinbaseSpotConnector,
  cnAShareConnector,
  mockMarketConnector,
];

export const marketConnectors=new MarketConnectorRegistry(BUILTIN_MARKET_CONNECTORS);

export function getMarketConnector(source:string):MarketConnector|undefined {
  return marketConnectors.get(source);
}

/** Coerce a symbol when switching data sources in UI so cross-market switches
 * (e.g. Binance BTCUSDT -> A-share 600519.SH -> Coinbase BTC-USD) land on a valid symbol. */
export function coerceConnectorSymbol(source:string,symbol:string):string|null {
  const connector=marketConnectors.get(source);
  if(!connector)return null;
  return connector.normalizeSymbol(symbol)??connector.defaultSymbol;
}
