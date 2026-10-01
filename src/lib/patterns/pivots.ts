import type {ColumnView} from '../core/types';

export interface Pivot {index:number;time:number;value:number;kind:'high'|'low';confirmedAt:number}

/** Emit immutable confirmation events. The forming final candle is excluded.
 * Ties resolve to the rightmost extreme. An outside candle may retain one
 * structural side when its other wick remains inside the prior confirmed swing;
 * a candle breaking both prior extremes remains ambiguous and is skipped.
 * A pivot's time is its price anchor; confirmedAt is when it could first be known. */
export function confirmedPivotEvents(cols:ColumnView,strength=3,lookback=1500,maxRadius=30):Pivot[] {
  const radius=Math.max(1,Math.min(maxRadius,Math.round(strength))),end=cols.length-1;
  const start=Math.max(radius,end-Math.max(50,Math.min(10000,Math.round(lookback))));
  const h=cols.col('high'),l=cols.col('low'),t=cols.col('time'),events:Pivot[]=[],context:Pivot[]=[];
  for(let i=start;i+radius<end;i++){
    if(!Number.isFinite(h[i])||!Number.isFinite(l[i]))continue;
    let high=true,low=true;
    for(let d=1;d<=radius&&(high||low);d++){
      high=high&&h[i]>=h[i-d]&&h[i]>h[i+d];
      low=low&&l[i]<=l[i-d]&&l[i]<l[i+d];
    }
    if(high&&low){
      const previous=context.at(-1),priorHigh=context.find(p=>p.kind==='high'),priorLow=context.find(p=>p.kind==='low');
      const keepsLow=!!priorLow&&l[i]>=priorLow.value,keepsHigh=!!priorHigh&&h[i]<=priorHigh.value;
      if(priorHigh&&priorLow&&!keepsLow&&!keepsHigh)continue;
      // Select a single context-supported side, never fabricate an intrabar
      // high-then-low (or low-then-high) sequence from an OHLC candle.
      if(previous?.kind==='low'&&keepsLow)low=false;
      else if(previous?.kind==='high'&&keepsHigh)high=false;
      else if(priorHigh&&keepsLow&&h[i]>priorHigh.value)low=false;
      else if(priorLow&&keepsHigh&&l[i]<priorLow.value)high=false;
      else continue;
    }
    if(!high&&!low)continue;
    const point:Pivot={index:i,time:t[i],value:high?h[i]:l[i],kind:high?'high':'low',confirmedAt:t[i+radius+1]};
    events.push(point);appendPivot(context,point);if(context.length>2)context.shift();
  }
  return events;
}

export function appendPivot(pivots:Pivot[],point:Pivot):boolean {
  const last=pivots.at(-1);
  if(last?.kind===point.kind){
    if(point.kind==='high'?point.value<=last.value:point.value>=last.value)return false;
    pivots[pivots.length-1]=point;
  }else pivots.push(point);
  return true;
}

/** Latest zigzag only. Use events + appendPivot for historical causal recognition. */
export function confirmedPivots(cols:ColumnView,strength=3,lookback=1500):Pivot[] {
  const pivots:Pivot[]=[];
  for(const event of confirmedPivotEvents(cols,strength,lookback))appendPivot(pivots,event);
  return pivots;
}
