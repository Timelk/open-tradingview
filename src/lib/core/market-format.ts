import {getLocale} from '../i18n';
const formats=new Map<string,Intl.NumberFormat>();

/** Prices can be far below one currency unit. Keep meaningful fractional
 * digits instead of rendering newly supported small-price symbols as 0.00. */
export function marketPriceDigits(value:number):number {
  const size=Math.abs(value);
  if(!Number.isFinite(size)||size===0||size>=100)return 2;
  if(size>=1)return 4;
  return Math.min(12,Math.max(4,Math.ceil(-Math.log10(size))+3));
}
export function formatMarketPrice(value:number,digits=marketPriceDigits(value)):string {
  if(!Number.isFinite(value))return '—';
  const language=getLocale(),key=`${language}:${digits}`;
  let format=formats.get(key);
  if(!format){format=new Intl.NumberFormat(language,{minimumFractionDigits:Math.min(2,digits),maximumFractionDigits:digits});formats.set(key,format);}
  return format.format(value);
}

export function formatSeriesValue(value:number,priceBased=false):string {
  return formatMarketPrice(value,priceBased||Math.abs(value)>0&&Math.abs(value)<.01?marketPriceDigits(value):2);
}
