// Frozen pre-aggregation optimization oracle. Keep the conservative LOD/gap rules.
// Buckets are anchored to a quantized world time/price (not the viewport edge),
// so panning translates cells instead of re-bucketing them. Geometry is formed
// as (anchor-relative value) + anchor to mirror the production arithmetic.
import type {ChartOrderFlowState} from '../../src/lib/flow/chart-order-flow';
import {aggregateOrderBook} from '../../src/lib/flow/orderbook-models';
import {heatmapPriceStep} from '../../src/lib/render/orderbook-overlay';
import type {BookLevel} from '../../src/lib/flow/orderbook';

export interface DepthCell {left:number;right:number;top:number;bottom:number;time:number;through:number;priceLow:number;priceHigh:number;quantity:number;side:'bid'|'ask';
  /** Continuous observed extent represented by this screen-time cell. `time`
   * remains the actual latest stock sample, never backdated to this start. */
  coverageFrom?:number;aggregation?:'sample'|'latest-stock';
  source?:'live'|'archive';eventTime?:number;receivedAt?:number;availableAt?:number;revision?:number;segmentId?:number;}
export interface DepthOverlay {cells:DepthCell[];profile:Array<{price:number;quantity:number;side:'bid'|'ask'}>;maximum:number;profileMaximum:number;priceStep:number;}
export interface DepthProjection {left:number;right:number;top:number;bottom:number;fromTime:number;toTime:number;min:number;max:number;timeX:(time:number)=>number;priceY:(price:number)=>number;}
interface Sample {time:number;end:number;segment:number;bids:BookLevel[];asks:BookLevel[];source:'live'|'archive';eventTime:number;receivedAt?:number;availableAt?:number;revision?:number;}
interface TimeCell {sample:Sample;from:number;through:number;count:number}
const prepared=new WeakMap<ChartOrderFlowState,{key:string;value:DepthOverlay}>();
/** Sample time is stock-at-time, never a sum of successive stocks. Time columns
 * retain the latest known sample; screen-price cells sum observed price levels. */
export function referenceDepthOverlay(state:ChartOrderFlowState,p:DepthProjection):DepthOverlay {
  // Bucket width is policy (shared); the aggregation below stays independent.
  const step=heatmapPriceStep(state.market?.tickSize??0,state.settings.priceStepTicks,state.book?.bids[0]?.price??state.book?.asks[0]?.price??(p.min+p.max)/2,false),empty={cells:[],profile:[],maximum:0,profileMaximum:0,priceStep:step};
  if(!Number.isFinite(step)||!(step>0)||![p.left,p.right,p.top,p.bottom,p.fromTime,p.toTime,p.min,p.max].every(Number.isFinite)||p.right<=p.left||p.bottom<=p.top||!(p.max>p.min)||p.toTime<p.fromTime)return empty;
  const cacheKey=[p.left,p.right,p.top,p.bottom,p.fromTime,p.toTime,p.min,p.max,p.timeX(p.fromTime),p.timeX(p.toTime),p.priceY(p.min),p.priceY(p.max),
    step,state.settings.heatmap,state.settings.profile,state.settings.unit,state.settings.threshold,state.mode,state.archive?.cursor,state.archive?.pending,state.book?.revision,state.book?.capturedAt,state.book?.status].join(':');
  const cached=prepared.get(state);if(cached?.key===cacheKey)return cached.value;
  const samples:Sample[]=[];
  if(state.settings.heatmap){
    if(state.mode==='history'&&state.archive?.heatmap){
      const a=state.archive,source=a.heatmap!,list=source.samples.filter(s=>Number.isFinite(s.time)&&s.time<=a.cursor).sort((a,b)=>a.time-b.time),cadence=(source.toTime-source.fromTime)/Math.max(1,source.samples.length-1);
      const gaps=a.gaps.filter(g=>g.channel==='depth'&&Number.isFinite(g.afterTime)&&Number.isFinite(g.beforeTime));
      for(let i=0;i<list.length;i++){
        const s=list[i];if(s.book.status!=='available'||s.book.time===undefined||!Number.isFinite(s.book.time)||s.book.time>s.time)continue;
        const next=list[i+1],nextAvailable=next?.book.status==='available'&&next.book.time!==undefined&&Number.isFinite(next.book.time)&&next.book.time<=next.time;
        let end=nextAvailable?Math.min(a.cursor,next.time,s.time+Math.max(1,cadence)):s.time,blocked=false;
        for(const gap of gaps){
          if(s.time>gap.afterTime&&s.time<gap.beforeTime){blocked=true;break;}
          if(gap.afterTime>=s.time&&gap.afterTime<end)end=gap.afterTime;
        }
        if(!blocked&&end>=s.time)samples.push({time:s.time,end,segment:gaps.filter(gap=>gap.beforeTime<=s.time).length,bids:s.book.bids,asks:s.book.asks,source:'archive',eventTime:s.book.time});
      }
    }else if(state.book){
      const list=state.book.history,interval=state.book.historyCoverage?.intervalMs??1000;
      for(let i=0;i<list.length;i++){
        const s=list[i],next=list[i+1];if(![s.time,s.availableAt].every(Number.isFinite)||s.availableAt>state.book.capturedAt||s.time>state.book.capturedAt)continue;
        // A quiet/disconnected period is not a continuous wall. At most one
        // sample interval is drawn; segment boundaries never carry depth.
        const nextAvailable=next&&Number.isFinite(next.time)&&Number.isFinite(next.availableAt)&&next.time<=state.book.capturedAt&&next.availableAt<=state.book.capturedAt;
        // The newest stock of a live book remains the current book through the
        // capture time (bounded, so a stalled feed never paints a long wall).
        const live=!next&&state.book.status==='live';
        const end=nextAvailable&&next.segmentId===s.segmentId?Math.min(s.time+interval,next.time,state.book.capturedAt):live?Math.max(s.time,Math.min(state.book.capturedAt,s.time+interval*5)):s.time;
        if(end>=s.time)samples.push({time:s.time,end,segment:s.segmentId,bids:s.bids,asks:s.asks,source:'live',eventTime:s.eventTime,receivedAt:s.receivedAt,availableAt:s.availableAt,revision:s.revision});
      }
    }
  }
  const columnWidth=Math.max(2,(p.right-p.left)/160),rowHeight=2;
  samples.sort((a,b)=>a.time-b.time);
  const first=samples[0],lastSample=samples.at(-1),t0=first?Math.floor(first.time/3_600_000)*3_600_000:0;
  const binOf=(side:'bid'|'ask',level?:BookLevel)=>{if(!level)return undefined;const ratio=level.price/step,epsilon=Number.EPSILON*Math.max(1,Math.abs(ratio))*8;return (side==='bid'?Math.floor(ratio+epsilon):Math.ceil(ratio-epsilon))*step;};
  const firstValid=(levels:BookLevel[]=[])=>levels.find(l=>Number.isFinite(l.price)&&Number.isFinite(l.quantity)&&l.quantity>0&&Number.isFinite(state.settings.unit==='quote'?l.price*l.quantity:l.quantity));
  const reference=binOf('bid',firstValid(lastSample?.bids))??binOf('ask',firstValid(lastSample?.asks))??0,grid=step*1024,p0=Math.round(reference/grid)*grid;
  const ax=p.timeX(t0),ay=p.priceY(p0);
  const columns=new Map<string,TimeCell[]>();
  for(const s of samples){
    const x=p.timeX(s.time);if(!Number.isFinite(x))continue;
    const key=`${Math.floor((x-ax)/columnWidth)}:${s.segment}`,runs=columns.get(key)??[],last=runs.at(-1);
    // Keep the latest stock, but retain the actual continuous coverage of all
    // samples collapsed into this pixel column. Same-segment temporal holes
    // remain separate runs; neither zooming out nor a fresh snapshot fills them.
    if(last&&s.time<=last.through){last.through=Math.max(last.through,s.end);last.sample=s;last.count++;}
    else runs.push({sample:s,from:s.time,through:s.end,count:1});
    columns.set(key,runs);
  }
  const cells:DepthCell[]=[];
  for(const run of [...columns.values()].flat()){
    const sample=run.sample,instant=run.from===run.through;
    let left=Math.max(p.left,(p.timeX(run.from)-ax)+ax),right=Math.min(p.right,instant?left+.65:(p.timeX(run.through)-ax)+ax);
    // An instant remains an instant in time metadata. Its visual point can
    // extend inward at the right edge instead of disappearing outside the clip.
    if(instant&&left<=p.right&&right-left<.65)left=Math.max(p.left,right-.65);
    if(!Number.isFinite(right)||right<=left)continue;
    const rows=new Map<string,DepthCell>();
    for(const side of ['bid','ask'] as const)for(const level of side==='bid'?sample.bids:sample.asks){
      if(!Number.isFinite(level.price)||!Number.isFinite(level.quantity)||level.quantity<=0)continue;
      const ratio=level.price/step,epsilon=Number.EPSILON*Math.max(1,Math.abs(ratio))*8,bin=side==='bid'?Math.floor(ratio+epsilon):Math.ceil(ratio-epsilon),price=bin*step;
      const low=side==='bid'?price:price-step,high=low+step,top=(p.priceY(high)-ay)+ay,bottom=(p.priceY(low)-ay)+ay,row=Math.floor((p.priceY(price)-ay)/rowHeight),key=side+':'+row;
      const amount=state.settings.unit==='quote'?level.price*level.quantity:level.quantity;
      if(![top,bottom,amount].every(Number.isFinite))continue;
      const old=rows.get(key);if(old){old.quantity+=amount;old.priceLow=Math.min(old.priceLow,low);old.priceHigh=Math.max(old.priceHigh,high);old.top=Math.min(old.top,top);old.bottom=Math.max(old.bottom,bottom);}
      else rows.set(key,{left,right,top:Math.max(p.top,top),bottom:Math.min(p.bottom,Math.max(top+1,bottom)),time:sample.time,through:run.through,coverageFrom:run.from,aggregation:run.count>1?'latest-stock':'sample',priceLow:low,priceHigh:high,quantity:amount,side,
        source:sample.source,eventTime:sample.eventTime,receivedAt:sample.receivedAt,availableAt:sample.availableAt,revision:sample.revision,segmentId:sample.segment});
    }
    for(const cell of rows.values())if(cell.quantity>=state.settings.threshold&&cell.bottom>p.top&&cell.top<p.bottom){cell.top=Math.max(p.top,cell.top);cell.bottom=Math.min(p.bottom,cell.bottom);cells.push(cell);}
  }
  const aggregate=state.book&&state.settings.profile?aggregateOrderBook(state.book,{priceStep:step,unit:state.settings.unit,limit:200,windowMs:state.settings.windowMs,now:state.mode==='history'?state.archive?.cursor:state.book.capturedAt}):undefined;
  const profile=aggregate?[...aggregate.bids.map(r=>({...r,side:'bid' as const})),...aggregate.asks.map(r=>({...r,side:'ask' as const}))].filter(r=>r.price>=p.min-step&&r.price<=p.max+step).map(({price,quantity,side})=>({price,quantity,side})):[];
  const value={cells,profile,maximum:cells.reduce((m,c)=>Math.max(m,c.quantity),0),profileMaximum:profile.reduce((m,c)=>Math.max(m,c.quantity),0),priceStep:step};
  prepared.set(state,{key:cacheKey,value});return value;
}
