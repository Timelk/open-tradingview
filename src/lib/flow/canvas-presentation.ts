import type {FlowPriceLevel,FlowFootprintBar} from './types';
import type {PriceImbalance} from './studies';

const numberFormats=new Map<string,Intl.NumberFormat>(),timeFormats=new Map<string,Intl.DateTimeFormat>();
export function formatFlowNumber(value:number|undefined,locale:string,digits=4):string {
  if(!Number.isFinite(value))return '—';
  const precision=Math.max(0,Math.min(20,Math.floor(digits))),key=`${locale}:${precision}`;
  let formatter=numberFormats.get(key);
  if(!formatter){formatter=new Intl.NumberFormat(locale,{maximumFractionDigits:precision});numberFormats.set(key,formatter);}
  return formatter.format(value!);
}
export function formatFlowTime(time:number,locale:string):string {
  if(!Number.isFinite(time))return '—';
  let formatter=timeFormats.get(locale);
  if(!formatter){formatter=new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZone:'UTC'});timeFormats.set(locale,formatter);}
  return formatter.format(time);
}
export function depthDisplayAmount(level:{price:number;quantity:number},unit:'base'|'quote'):number {
  return unit==='quote'?level.price*level.quantity:level.quantity;
}
/** Pixel glyph height, not an assertion that a sparse order book fills every
 * intermediate price. Unknown ticks use only observed spacing and stay <=6px. */
export function depthMarkerHeight(priceStep:number|undefined,priceSpan:number,pixelHeight:number):number {
  const pixels=priceStep&&priceStep>0&&priceSpan>0?priceStep/priceSpan*pixelHeight*.85:4;
  return Math.max(1,Math.min(6,pixels));
}
interface HitBounds {left:number;right:number;top:number;bottom:number;time?:number}
export type FlowCanvasHit=HitBounds&(
  |{kind:'depth';side:'bids'|'asks';price:number;quantity:number}
  |{kind:'footprint';bar:FlowFootprintBar;level:FlowPriceLevel;imbalance?:PriceImbalance}
  |{kind:'distribution';level:FlowPriceLevel;count:number;tpo:boolean}
);
/** Time columns do not overlap except at shared edges. Within the selected
 * column preserve drawing order, matching the previous first-hit semantics. */
export class FlowHitIndex {
  private columns:Array<{left:number;right:number;cells:FlowCanvasHit[]}>=[];
  constructor(cells:readonly FlowCanvasHit[]=[]){
    const groups=new Map<number,{left:number;right:number;cells:FlowCanvasHit[]}>();
    for(const cell of cells){let group=groups.get(cell.left);if(!group){group={left:cell.left,right:cell.right,cells:[]};groups.set(cell.left,group);}group.right=Math.max(group.right,cell.right);group.cells.push(cell);}
    this.columns=[...groups.values()].sort((a,b)=>a.left-b.left);
  }
  hit(x:number,y:number):FlowCanvasHit|undefined {
    let lo=0,hi=this.columns.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(this.columns[mid].left<=x)lo=mid+1;else hi=mid;}
    const at=lo-1;if(at<0)return;
    for(const index of [at-1,at]){
      const column=this.columns[index];if(!column||x<column.left||x>column.right)continue;
      const hit=column.cells.find(cell=>x>=cell.left&&x<=cell.right&&y>=cell.top&&y<=cell.bottom);if(hit)return hit;
    }
  }
}
