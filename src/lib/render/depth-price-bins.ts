import type {BookLevel} from '../flow/orderbook';
import type {BookUnit} from '../flow/orderbook-models';

interface SourceAmount {price:number;amount:number;index:number}
export interface DepthPriceBin {
  price:number;quantity:number;minSourcePrice:number;maxSourcePrice:number;firstSourceIndex:number;
  sources:readonly SourceAmount[];
}
interface LevelCache {configurations:Map<string,readonly DepthPriceBin[]>}
const cachedLevels=new WeakMap<readonly BookLevel[],LevelCache>();
const MAX_CONFIGURATIONS=4;

/** Only genuinely immutable arrays are cached. A frozen array with mutable
 * children, and ordinary archive/test arrays, deliberately use fresh values. */
export function depthPriceBins(levels:readonly BookLevel[],step:number,side:'bid'|'ask',unit:BookUnit):readonly DepthPriceBin[] {
  let cache=cachedLevels.get(levels);
  if(!cache&&Object.isFrozen(levels)&&levels.every(level=>Object.isFrozen(level))){cache={configurations:new Map()};cachedLevels.set(levels,cache);}
  const key=`${step}:${side}:${unit}`,hit=cache?.configurations.get(key);
  if(hit){cache!.configurations.delete(key);cache!.configurations.set(key,hit);return hit;}
  const bins=new Map<number,{price:number;quantity:number;minSourcePrice:number;maxSourcePrice:number;firstSourceIndex:number;sources:SourceAmount[]}>();
  for(let index=0;index<levels.length;index++){
    const {price,quantity}=levels[index];if(!Number.isFinite(price)||!Number.isFinite(quantity)||quantity<=0)continue;
    const amount=unit==='quote'?price*quantity:quantity;if(!Number.isFinite(amount))continue;
    const ratio=price/step,epsilon=Number.EPSILON*Math.max(1,Math.abs(ratio))*8;
    const bin=side==='bid'?Math.floor(ratio+epsilon):Math.ceil(ratio-epsilon),source={price,amount,index},existing=bins.get(bin);
    if(existing){existing.quantity+=amount;existing.minSourcePrice=Math.min(existing.minSourcePrice,price);existing.maxSourcePrice=Math.max(existing.maxSourcePrice,price);existing.sources.push(source);}
    else bins.set(bin,{price:bin*step,quantity:amount,minSourcePrice:price,maxSourcePrice:price,firstSourceIndex:index,sources:[source]});
  }
  const result:readonly DepthPriceBin[]=cache?Object.freeze([...bins.values()].map(bin=>Object.freeze({...bin,sources:Object.freeze(bin.sources.map(source=>Object.freeze(source)))}))):[...bins.values()];
  if(cache){cache.configurations.set(key,result);while(cache.configurations.size>MAX_CONFIGURATIONS)cache.configurations.delete(cache.configurations.keys().next().value!);}
  return result;
}

/** Match the original raw-price viewport filter. Whole bins are O(1); only
 * bins cut by a viewport edge re-read their cached original price contributions.
 * First surviving source order is retained for deterministic screen-row order. */
export function visibleDepthPriceBins(bins:readonly DepthPriceBin[],minimum:number,maximum:number):Array<{bin:DepthPriceBin;quantity:number;firstSourceIndex:number}> {
  const result:Array<{bin:DepthPriceBin;quantity:number;firstSourceIndex:number}>=[];
  for(const bin of bins){
    if(bin.maxSourcePrice<minimum||bin.minSourcePrice>maximum)continue;
    if(bin.minSourcePrice>=minimum&&bin.maxSourcePrice<=maximum){result.push({bin,quantity:bin.quantity,firstSourceIndex:bin.firstSourceIndex});continue;}
    let quantity=0,firstSourceIndex=-1;
    for(const source of bin.sources){if(source.price<minimum||source.price>maximum)continue;if(firstSourceIndex<0)firstSourceIndex=source.index;quantity+=source.amount;}
    if(firstSourceIndex>=0)result.push({bin,quantity,firstSourceIndex});
  }
  return result.sort((a,b)=>a.firstSourceIndex-b.firstSourceIndex);
}
