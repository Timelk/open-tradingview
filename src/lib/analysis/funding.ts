import type {DatasetSnapshot} from '../history/types';
import {BINANCE_FUTURES_REST} from '../market/binance-contracts';

export interface ValidationFundingSnapshot {
  from:number;to:number;rates:{time:number;rate:number;markPrice:number}[];
  coverage:{basis:'completed-public-range-query';pages:number;source:'Binance USDⓈ-M fundingRate';note:string};
}
const PAGE_SIZE=1000,MAX_PAGES=50;
const numeric=(value:unknown)=>typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;
function range(dataset:DatasetSnapshot):{from:number;to:number}{
  if(dataset.source!=='binance'||dataset.marketType!=='usdm-perpetual'||!/^[\p{L}\p{N}]+USDT$/u.test(dataset.symbol)||!dataset.bars.length)throw Error('资金费读取需要 Binance USDT 合约的有效历史区间');
  if(dataset.contract&&dataset.contract.symbol!==dataset.symbol)throw Error('资金费品种与合约元数据不一致');
  let previous=-1;
  for(const bar of dataset.bars){if(!Number.isSafeInteger(bar?.time)||bar.time<0||bar.time<=previous)throw Error('资金费区间包含无效、重复或倒序行情时间');previous=bar.time;}
  const from=dataset.bars[0].time,last=dataset.bars.at(-1)!.time,match=/^([1-9]\d*)([smhdwM])$/.exec(dataset.interval);
  if(!match)throw Error('资金费覆盖需要明确有效的行情周期');
  const count=Number(match[1]),unit=match[2];let to:number;
  if(unit==='M'){
    const date=new Date(last);
    if(date.getUTCDate()!==1||date.getUTCHours()||date.getUTCMinutes()||date.getUTCSeconds()||date.getUTCMilliseconds())throw Error('月线资金费覆盖需要真实月初锚点');
    to=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+count,1);
  }else to=last+count*({s:1000,m:60_000,h:3600_000,d:86400_000,w:604800_000}[unit as 'm']);
  if(!Number.isSafeInteger(to)||to<=last||to>Date.now())throw Error('资金费区间尚未结束或结束时间无效，不能宣称覆盖未知未来');
  return {from,to};
}

/** Public funding observations for a frozen closed-bar dataset, through the
 * final candle's close (not merely its open). Binance's inclusive time query
 * returns ascending rows; a full page continues at its final timestamp + 1ms.
 * Query completion is recorded, not an assumed fixed 8-hour event schedule.
 * No partial snapshot is returned after cancellation, malformed data or caps. */
export async function fetchValidationFunding(dataset:DatasetSnapshot,request:typeof fetch=fetch,signal?:AbortSignal):Promise<ValidationFundingSnapshot>{
  signal?.throwIfAborted();const {from,to}=range(dataset);
  let cursor=from;const rates:ValidationFundingSnapshot['rates']=[],seen=new Map<number,{rate:number;markPrice:number}>();
  for(let page=0;page<MAX_PAGES;page++){
    const pageSignal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15000)]);pageSignal.throwIfAborted();
    const params=new URLSearchParams({symbol:dataset.symbol,startTime:String(cursor),endTime:String(to),limit:String(PAGE_SIZE)});
    const response=await request(`${BINANCE_FUTURES_REST}/fapi/v1/fundingRate?${params}`,{signal:pageSignal});pageSignal.throwIfAborted();
    if(!response.ok)throw Error(`资金费读取失败 HTTP ${response.status}`);
    const rows:unknown=await response.json();pageSignal.throwIfAborted();
    if(!Array.isArray(rows)||rows.length>PAGE_SIZE)throw Error('资金费响应格式或分页长度无效');
    let previous=cursor-1;
    for(const row of rows){
      if(!row||typeof row!=='object'||Array.isArray(row))throw Error('资金费记录格式无效');
      const time=numeric(row.fundingTime),rate=numeric(row.fundingRate),markPrice=numeric(row.markPrice);
      if(row.symbol!==dataset.symbol||!Number.isSafeInteger(time)||!Number.isFinite(rate)||!Number.isFinite(markPrice)||markPrice<=0||time<cursor||time>to)throw Error('资金费缺少匹配品种、有效时间、费率或标记价格，无法完整计入');
      if(row.rateType!==undefined&&row.rateType!=='Regular')throw Error('响应含特殊资金费类型，当前单时间点资金费模型不能静默合并');
      if(time<previous)throw Error('资金费分页未按时间升序返回，不能确定覆盖');previous=time;
      const existing=seen.get(time);
      if(existing){if(existing.rate!==rate||existing.markPrice!==markPrice)throw Error('同一时间的资金费记录冲突，无法确定费用');}
      else{seen.set(time,{rate,markPrice});rates.push({time,rate,markPrice});}
    }
    pageSignal.throwIfAborted();
    if(rows.length<PAGE_SIZE||previous>=to)return {from,to,rates,coverage:{basis:'completed-public-range-query',pages:page+1,source:'Binance USDⓈ-M fundingRate',note:'已完成该时间范围的公开历史查询；不假定固定8小时频率，不证明交易所响应之外没有缺失记录。'}};
    if(previous<cursor)throw Error('资金费分页未前进');cursor=previous+1;
  }
  throw Error('资金费区间超出本次查询上限，请缩短验收区间');
}
