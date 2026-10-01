import {ColumnStore} from '../../src/lib/core/datastore';
import type {ColumnView} from '../../src/lib/core/types';
import {mulberry32} from './huzi-synthetic';

/**
 * Deterministic harmonic paths with a controlled speed per leg, so the momentum at D can be made exhausted
 * (a slow grind into a new extreme: DIF does not confirm) or confirming (a fast drop: DIF makes a new extreme too).
 * `prices` are the extreme prices of the anchors (highs and lows alternate, the first one is a high for a
 * bullish shape), `bars[i]` is the number of candles of the leg from anchor i to i+1.
 */
export const HOUR=3_600_000;
export interface PlantOptions {
  prices:number[];bars:number[];
  /** Candles before the first anchor, rising into it. */prefix?:number;
  /** Candles after D: a steady move away from it. */tail?:number;tailStep?:number;
  /** The D candle is a pin bar (long rejecting wick, small body at the far end). */pin?:boolean;
  /** Mirror the whole path around `mirrorAt` (turns a bullish shape into a bearish one). */mirror?:boolean;
  seed?:number;
  /** After D + `after` candles, that candle's wick reaches `depth` price units beyond D (its close is unchanged). */
  stab?:{after:number;depth:number};
}
export interface Planted {
  store:ColumnStore;view:ColumnView;
  /** Candle index of each anchor. */anchor:number[];dIndex:number;
  /** Absolute price of D in the (possibly mirrored) path. */dPrice:number;
  closedLength:number;
}
const MIRROR=400;
/** Anchor closes sit this far inside the extreme, more than any wick, so the neighbours never out-reach it. */
const INSET=1.2;

export function plantHarmonic(options:PlantOptions):Planted {
  const {prices,bars}=options,rnd=mulberry32(options.seed??7),prefix=options.prefix??90,tail=options.tail??12,tailStep=options.tailStep??4;
  const n=prices.length;
  // Kinds alternate and the last anchor D is always a low here (a bullish shape); `mirror` makes it bearish.
  const firstHigh=n%2===0;
  const kind=(i:number)=>((i%2===0)===firstHigh?'high':'low') as 'high'|'low';
  const rows:Array<{open:number;high:number;low:number;close:number}>=[];
  const wick=()=>.25+.25*rnd();
  const push=(close:number,prev:number)=>{const open=prev,w=wick();rows.push({open,close,high:Math.max(open,close)+w,low:Math.min(open,close)-w});};
  // Approach: a steady advance into the first anchor.
  const startLevel=prices[0]+(firstHigh?-40:40);let prev=startLevel;
  const firstTarget=prices[0]+(firstHigh?-INSET:INSET);
  for(let i=1;i<=prefix;i++){const c=startLevel+(firstTarget-startLevel)*i/prefix+(rnd()-.5)*.3;push(c,prev);prev=c;}
  const anchor:number[]=[rows.length-1];
  if(firstHigh)rows[anchor[0]].high=prices[0];else rows[anchor[0]].low=prices[0];
  for(let leg=0;leg<n-1;leg++){
    const from=prev,target=prices[leg+1]+(kind(leg+1)==='high'?-INSET:INSET);
    for(let k=1;k<=bars[leg];k++){const c=from+(target-from)*k/bars[leg]+(k<bars[leg]?(rnd()-.5)*.3:0);push(c,prev);prev=c;}
    const at=rows.length-1;anchor.push(at);
    if(kind(leg+1)==='high')rows[at].high=prices[leg+1];else rows[at].low=prices[leg+1];
  }
  const dIndex=anchor.at(-1)!,d=prices.at(-1)!,dLow=kind(n-1)==='low';
  if(options.pin){
    const R=8,row=rows[dIndex];
    row.low=dLow?d:d-R;row.high=dLow?d+R:d;
    row.open=dLow?d+.78*R:d-.78*R;row.close=dLow?d+.86*R:d-.86*R;
  }
  // Tail: a steady move away from D.
  for(let k=1;k<=tail;k++){const c=(dLow?d+INSET:d-INSET)+(dLow?1:-1)*tailStep*k;push(c,prev);prev=c;}
  if(options.stab){
    const at=dIndex+options.stab.after,row=rows[at];
    if(dLow)row.low=Math.min(row.low,d-options.stab.depth);else row.high=Math.max(row.high,d+options.stab.depth);
  }
  const store=new ColumnStore(rows.length+8);
  rows.forEach((row,i)=>{
    const m=options.mirror;
    store.appendBar({time:(i+1)*HOUR,open:m?MIRROR-row.open:row.open,high:m?MIRROR-row.low:row.high,low:m?MIRROR-row.high:row.low,close:m?MIRROR-row.close:row.close,volume:100});
  });
  const closedLength=store.length-1;
  return {store,view:{length:store.length,closedLength,intervalMs:HOUR,col:name=>store.col(name)} as ColumnView,anchor,dIndex,
    dPrice:options.mirror?MIRROR-d:d,closedLength};
}

/** Hand-checkable Wilder ATR (mean of the first `period` true ranges, then Wilder smoothing) over the whole history. */
export function referenceAtr(high:ArrayLike<number>,low:ArrayLike<number>,close:ArrayLike<number>,index:number,period:number):number {
  const tr=(i:number)=>Math.max(high[i]-low[i],Math.abs(high[i]-close[i-1]),Math.abs(low[i]-close[i-1]));
  let atr=0;
  for(let i=1;i<=period;i++)atr+=tr(i);
  atr/=period;
  for(let i=period+1;i<=index;i++)atr=(atr*(period-1)+tr(i))/period;
  return atr;
}
