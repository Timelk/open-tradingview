/** Binance USDⓈ-M public market endpoints. Klines/tickers use the routed market stream. */
export const BINANCE_FUTURES_REST='https://fapi.binance.com';
export const BINANCE_FUTURES_STREAM='wss://fstream.binance.com/market';
export const BINANCE_PERPETUAL_MARKET='usdm-perpetual' as const;

export interface BinanceLeverageBracket {
  bracket:number;initialLeverage:number;notionalFloor:number;notionalCap:number;maintMarginRatio:number;cum:number;
}
export interface BinanceContractMetadata {
  symbol:string;marketType:'usdm-perpetual';contractType:'PERPETUAL';marginAsset:'USDT';quoteCurrency:'USDT';baseAsset:string;
  tickSize:number;minPrice:number;maxPrice:number;minQty:number;maxQty:number;stepSize:number;
  marketMinQty:number;marketMaxQty:number;marketStepSize:number;minNotional:number;fetchedAt:number;
  pricePrecision?:number;quantityPrecision?:number;onboardDate?:number;
  /** Authenticated leverage brackets are optional; exchangeInfo does not supply them. */
  leverageBrackets?:BinanceLeverageBracket[];
  makerCommissionRate?:number;takerCommissionRate?:number;
  leverageStatus?:'ready'|'notConfigured'|'unavailable';leverageMessage?:string;rulesFetchedAt?:number;
}
export interface BinancePerpetualSymbol {symbol:string;baseAsset:string;quoteAsset:'USDT';contractType:'PERPETUAL';contract:BinanceContractMetadata}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const number=(value:unknown)=>typeof value==='number'||typeof value==='string'&&value.trim()?Number(value):NaN;
const nonnegative=(value:unknown)=>Number.isFinite(number(value))&&number(value)>=0;

/** Price/quantity rules come from filters, never the display precision fields. */
export function parseBinancePerpetualSymbols(raw:unknown,fetchedAt=Date.now()):BinancePerpetualSymbol[]{
  if(!object(raw)||!Array.isArray(raw.symbols))throw Error('Binance 永续合约目录格式无效');
  const symbols=new Map<string,BinancePerpetualSymbol>();
  for(const row of raw.symbols){
    if(!object(row)||row.status!=='TRADING'||row.contractType!=='PERPETUAL'||row.quoteAsset!=='USDT'||row.marginAsset!=='USDT')continue;
    if(typeof row.symbol!=='string'||typeof row.baseAsset!=='string'||!row.baseAsset||row.symbol!==`${row.baseAsset}USDT`||!/^[\p{L}\p{N}]+USDT$/u.test(row.symbol)||!Array.isArray(row.filters))continue;
    const filters=row.filters.filter(object),price=filters.find(filter=>filter.filterType==='PRICE_FILTER'),lot=filters.find(filter=>filter.filterType==='LOT_SIZE'),market=filters.find(filter=>filter.filterType==='MARKET_LOT_SIZE'),notional=filters.find(filter=>filter.filterType==='MIN_NOTIONAL');
    if(filters.some(filter=>filter.filterType==='POSITION_RISK_CONTROL'&&filter.positionControlSide!=='NONE'))continue;
    if(!price||!lot||!market||!notional)continue;
    const rules={tickSize:number(price.tickSize),minPrice:number(price.minPrice),maxPrice:number(price.maxPrice),minQty:number(lot.minQty),maxQty:number(lot.maxQty),stepSize:number(lot.stepSize),marketMinQty:number(market.minQty),marketMaxQty:number(market.maxQty),marketStepSize:number(market.stepSize),minNotional:number(notional.notional)};
    if(!Object.values(rules).every(Number.isFinite)||Object.values(rules).some(value=>value<0)||rules.tickSize<=0||rules.stepSize<=0||rules.maxPrice<rules.minPrice||rules.maxQty<rules.minQty||rules.marketMaxQty<rules.marketMinQty)continue;
    const contract:BinanceContractMetadata={symbol:row.symbol,marketType:BINANCE_PERPETUAL_MARKET,contractType:'PERPETUAL',marginAsset:'USDT',quoteCurrency:'USDT',baseAsset:row.baseAsset,...rules,fetchedAt,
      ...(nonnegative(row.pricePrecision)?{pricePrecision:number(row.pricePrecision)}:{}),...(nonnegative(row.quantityPrecision)?{quantityPrecision:number(row.quantityPrecision)}:{}),...(nonnegative(row.onboardDate)?{onboardDate:number(row.onboardDate)}:{})};
    symbols.set(row.symbol,{symbol:row.symbol,baseAsset:row.baseAsset,quoteAsset:'USDT',contractType:'PERPETUAL',contract});
  }
  if(!symbols.size)throw Error('Binance 未返回具备完整交易规则的 USDT 永续合约');
  return [...symbols.values()].sort((a,b)=>a.symbol.localeCompare(b.symbol));
}

export async function fetchBinancePerpetualSymbols(signal?:AbortSignal,request:typeof fetch=(input,init)=>globalThis.fetch(input,init),restBase=BINANCE_FUTURES_REST):Promise<BinancePerpetualSymbol[]>{
  const response=await request(`${restBase}/fapi/v1/exchangeInfo`,{signal:AbortSignal.any([AbortSignal.timeout(12000),...(signal?[signal]:[])])});
  if(!response.ok)throw Error(`Binance 永续合约目录暂不可用（HTTP ${response.status}）`);
  return parseBinancePerpetualSymbols(await response.json());
}
