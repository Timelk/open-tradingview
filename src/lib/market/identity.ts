/** Legacy Binance records without a market tag are spot, never perpetuals. */
export function marketIdentity(value:{source:string;symbol:string;interval?:string;marketType?:string}):string {
  const typeTag=value.source==='binance'?`${value.marketType??'spot'}:`:value.marketType?`${value.marketType}:`:'';
  return `${value.source}:${typeTag}${value.symbol}${value.interval?`:${value.interval}`:''}`;
}
