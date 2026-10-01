import type {FlowPriceLevel} from './types';

/** Contiguous expansion around the maximum-volume bucket. The coverage and
 * price bucket size belong to the caller; this is not a whole-session claim. */
export function volumeValueArea(input:readonly FlowPriceLevel[],unit:'base'|'quote'='base',fraction=.7){
  const rows=[...input].sort((a,b)=>a.price-b.price),volume=(r:FlowPriceLevel)=>unit==='base'?r.volumeBase:r.volumeQuote;
  const total=rows.reduce((sum,r)=>sum+volume(r),0);if(!rows.length||!Number.isFinite(total)||total<=0)return;
  const middle=rows.reduce((sum,r)=>sum+(r.price+r.priceEnd)/2*volume(r),0)/total;
  let poc=0;for(let i=1;i<rows.length;i++)if(volume(rows[i])>volume(rows[poc])||volume(rows[i])===volume(rows[poc])&&Math.abs((rows[i].price+rows[i].priceEnd)/2-middle)<Math.abs((rows[poc].price+rows[poc].priceEnd)/2-middle))poc=i;
  let low=poc,high=poc,covered=volume(rows[poc]);const threshold=total*Math.max(.01,Math.min(1,fraction));
  while(covered<threshold&&(low>0||high<rows.length-1)){
    const below=low>0?volume(rows[low-1]):-1,above=high<rows.length-1?volume(rows[high+1]):-1;
    if(below>=above){covered+=volume(rows[--low]);}else covered+=volume(rows[++high]);
  }
  return {poc:rows[poc].price,pocEnd:rows[poc].priceEnd,low:rows[low].price,high:rows[high].priceEnd,covered,total,fraction:covered/total};
}
