import type { ColumnView } from '../core/types';
/** Binary search avoids walking million-row history for each drawing anchor. */
export function indexForTime(cols:ColumnView,time:number,interval:number):number {
  const n=cols.length,t=cols.col('time');if(!n)return 0;
  if(time<=t[0])return (time-t[0])/interval;
  if(time>=t[n-1])return n-1+(time-t[n-1])/interval;
  let left=0,right=n-1;
  while(right-left>1){const middle=(left+right)>>>1;if(t[middle]<=time)left=middle;else right=middle;}
  return left+(time-t[left])/(t[right]-t[left]);
}
export function timeForIndex(cols:ColumnView,index:number,interval:number):number {
  const n=cols.length,t=cols.col('time');if(!n)return 0;
  if(index<=0)return t[0]+index*interval;
  if(index>=n-1)return t[n-1]+(index-n+1)*interval;
  const i=Math.floor(index);return t[i]+(t[i+1]-t[i])*(index-i);
}
