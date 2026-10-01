import type {ChartOrderFlowState,OrderFlowSettings} from '../flow/chart-order-flow';
import {HEATMAP_LUT_SIZE,getHeatmapPalette,getHeatmapTheme,heatmapCellAlpha,heatmapRampPosition,resolveHeatmapIntensity,type HeatmapIntensityRange} from '../flow/heatmap-themes';
import {aggregateOrderBook} from '../flow/orderbook-models';
import type {BookLevel} from '../flow/orderbook';
import type {RenderBackend} from './backend';
import {depthPriceBins} from './depth-price-bins';
import {translate} from '../i18n';
import {HEATMAP_FLOATS} from './gl';

export interface DepthCell {left:number;right:number;top:number;bottom:number;time:number;through:number;priceLow:number;priceHigh:number;quantity:number;side:'bid'|'ask';
  /** Continuous observed extent represented by this screen-time cell. `time`
   * remains the actual latest stock sample, never backdated to this start. */
  coverageFrom?:number;aggregation?:'sample'|'latest-stock';
  source?:'live'|'archive';eventTime?:number;receivedAt?:number;availableAt?:number;revision?:number;segmentId?:number;}
export interface DepthOverlay {cells:DepthCell[];profile:Array<{price:number;quantity:number;side:'bid'|'ask'}>;maximum:number;profileMaximum:number;priceStep:number;
  /** Pan-stable intensity statistics (all prepared cells, not just visible). */
  scale?:DepthScale;
  /** Instanced GPU form of every prepared cell; draw with translate (x,y). */
  gpu?:{instances:Float32Array;count:number;translateX:number;translateY:number};
  /** >0 when a throttled live rebuild is pending; repaint after this many ms. */
  staleForMs?:number;
  /** Price-bin × time-column neighborhood around a screen point (hover table). */
  crossSection?:(x:number,y:number,half?:number)=>DepthCrossSection|undefined;}
/** Hover table: previous / hovered / next drawn columns × 2·half+1 price bins
 * (highest first). Values come from the raw stock of each column's sample. */
export interface DepthCrossSection {
  times:Array<number|null>;centerColumn:number;centerRow:number;step:number;
  rows:Array<{priceLow:number;priceHigh:number;cells:Array<{quantity:number;side:'bid'|'ask'}|null>}>;
}
export interface DepthProjection {left:number;right:number;top:number;bottom:number;fromTime:number;toTime:number;min:number;max:number;timeX:(time:number)=>number;priceY:(price:number)=>number;}
interface Sample {time:number;end:number;segment:number;bids:BookLevel[];asks:BookLevel[];source:'live'|'archive';eventTime:number;receivedAt?:number;availableAt?:number;revision?:number;}
interface TimeCell {sample:Sample;from:number;through:number;count:number}
const prepared=new WeakMap<object,{key:string;value:DepthOverlay}>();
const profiles=new WeakMap<object,{key:string;rows:DepthOverlay['profile']}>();
const worlds=new WeakMap<object,DepthWorld>(),liveWorlds=new Map<string,DepthWorld>();
type DepthCellMeta=Omit<DepthCell,'left'|'right'|'top'|'bottom'>;
/** A heatmap cell in anchor-relative CSS px: x relative to timeX(t0), y relative
 * to priceY(p0). `by` already includes the one-pixel minimum height. */
interface WorldCell {lx:number;rx:number;instant:boolean;ty:number;by:number;meta:DepthCellMeta}
/** One drawn time column (anchor-relative x), kept for hover cross-sections. */
interface WorldRun {lx:number;rx:number;sample:Sample}
/** Pan-invariant heatmap geometry. Column and row buckets are anchored to a
 * fixed world time/price instead of the viewport edge, so a pure pan is a
 * translation: cells neither re-bucket (no shimmer) nor get rebuilt, and the
 * GPU instance buffer is reused with a new translate uniform. */
interface DepthWorld {key:string;builtAt:number;shape:string;runs:WorldRun[];t0:number;t1:number;tm:number;p0:number;probe:number;cells:WorldCell[];instances:Float32Array;scale:DepthScale}
/** Viewport-independent intensity statistics of all prepared cells. */
export interface DepthScale {maximum:number;quantities:Float32Array}
const HOUR=3_600_000,roundPx=(v:number)=>Math.round(v*1e3)/1e3;
function worldShape(p:DepthProjection,w:Pick<DepthWorld,'t0'|'t1'|'tm'|'p0'|'probe'>){
  const ax=p.timeX(w.t0),ay=p.priceY(w.p0);
  return [roundPx(p.timeX(w.t1)-ax),roundPx(p.timeX(w.tm)-ax),roundPx(p.priceY(w.probe)-ay)].join(',');
}
/** Sample time is stock-at-time, never a sum of successive stocks. Time columns
 * retain the latest known sample; screen-price cells sum observed price levels. */
/**
 * Heatmap price bucket. Liquidity walls only emerge when enough levels are
 * pooled, so the bucket follows the price's order of magnitude (HD: 0.25% of
 * the decade, e.g. BTC ≈ $25, ETH ≈ $2.5; 4K: 0.4× that) instead of the book
 * terminal's fine grouping. It is constant within a decade, so a price moving
 * around a boundary never flips the grid, and never finer than the terminal's
 * own grouping or than the tick.
 */
export function heatmapPriceStep(tickSize:number,groupingTicks:number,reference:number,is4k:boolean):number {
  const grouping=tickSize*groupingTicks;
  if(!(tickSize>0)||!Number.isFinite(grouping))return grouping;
  if(!(reference>0)||!Number.isFinite(reference))return grouping;
  const decade=10**Math.floor(Math.log10(reference)),auto=decade*.0025*(is4k?.4:1);
  const ticks=Math.max(1,Math.round(auto/tickSize));
  return Math.max(grouping,ticks*tickSize);
}

export interface PrepareDepthOptions {
  /** Live mode only: rebuild heatmap geometry at most this often. Between
   * rebuilds the previous world is reused (the latest column lags by at most
   * this long) while the profile stays current. */
  minRebuildMs?:number;
  /** Monotonic clock for {@link minRebuildMs}. */
  now?:number;
}
export function prepareDepthOverlay(state:ChartOrderFlowState,p:DepthProjection,options:PrepareDepthOptions={}):DepthOverlay {
  const is4k=state.settings.resolution==='4k';
  const effectiveTicks=is4k&&state.settings.priceStepTicks>1?Math.max(1,Math.round(state.settings.priceStepTicks*.5)):state.settings.priceStepTicks;
  const reference=state.book?.bids[0]?.price??state.book?.asks[0]?.price??(p.min+p.max)/2;
  const step=heatmapPriceStep(state.market?.tickSize??0,effectiveTicks,reference,is4k),empty={cells:[],profile:[],maximum:0,profileMaximum:0,priceStep:step};
  if(!Number.isFinite(step)||!(step>0)||![p.left,p.right,p.top,p.bottom,p.fromTime,p.toTime,p.min,p.max].every(Number.isFinite)||p.right<=p.left||p.bottom<=p.top||!(p.max>p.min)||p.toTime<p.fromTime)return empty;
  const owner=state.mode==='history'?state.archive?.heatmap??state.book??state:state.book??state;
  // Minimum/threshold hides noise; the max bound only saturates the color ramp
  // and must never hide the largest liquidity walls.
  const minFloor=Math.max(state.settings.threshold,state.settings.minBounds??0);
  const colDiv=is4k?320:160;
  // Rows follow real price bins: each bin keeps its own line, and only bins
  // thinner than a device row are merged (HD 2px, 4K 1px). Merging to a coarse
  // screen grid turned thin liquidity walls into blocks.
  const columnWidth=Math.max(is4k?1:2,(p.right-p.left)/colDiv),rowHeight=is4k?1:2;
  const structureKey=[step,state.settings.heatmap,state.settings.unit,minFloor,is4k?'4k':'hd',columnWidth,rowHeight,state.mode].join(':');
  const dataKey=[state.archive?.cursor,state.archive?.pending,state.book?.revision,state.book?.capturedAt,state.book?.status,state.book?.history.length,state.book?.history.at(-1)?.time,state.depthHistory?.revision,state.depthHistory?.step,Object.isFrozen(owner)?'immutable':state.revision].join(':');
  const worldKey=structureKey+'|'+dataKey;
  // Every live book update is a new snapshot object; key live geometry by the
  // market so a throttled rebuild can keep serving the previous world.
  const slot=state.mode==='live'&&state.book?.key&&Object.isFrozen(state.book)?state.book.key:undefined;
  let world=slot?liveWorlds.get(slot):worlds.get(owner);
  const reusable=world&&world.key.startsWith(structureKey+'|')&&world.shape===worldShape(p,world);
  const throttled=reusable&&slot&&options.minRebuildMs&&options.now!==undefined&&options.now-world!.builtAt<options.minRebuildMs&&state.book?.status==='live';
  if(!reusable||(world!.key!==worldKey&&!throttled)){
    world=buildDepthWorld(state,p,step,minFloor,columnWidth,rowHeight,worldKey,options.now??0);
    if(slot){liveWorlds.delete(slot);liveWorlds.set(slot,world);while(liveWorlds.size>8)liveWorlds.delete(liveWorlds.keys().next().value!);}
    else worlds.set(owner,world);
  }
  const staleForMs=world!.key!==worldKey?Math.max(0,options.minRebuildMs!-(options.now!-world!.builtAt)):0;
  world=world!;
  const ax=p.timeX(world.t0),ay=p.priceY(world.p0);
  const cacheKey=[world.key,world.shape,ax,ay,p.left,p.right,p.top,p.bottom,p.min,p.max,state.settings.profile,state.settings.windowMs,state.book?.revision].join(':');
  const cached=prepared.get(owner);if(cached?.key===cacheKey)return cached.value;
  const projectCells=()=>{
    const cells:DepthCell[]=[];
    for(const w of world!.cells){
      let left=Math.max(p.left,w.lx+ax),right=Math.min(p.right,w.instant?left+.65:w.rx+ax);
      // An instant remains an instant in time metadata. Its visual point can
      // extend inward at the right edge instead of disappearing outside the clip.
      if(w.instant&&left<=p.right&&right-left<.65)left=Math.max(p.left,right-.65);
      if(!Number.isFinite(right)||right<=left)continue;
      const top=Math.max(p.top,w.ty+ay),bottom=Math.min(p.bottom,w.by+ay);
      if(bottom>p.top&&top<p.bottom)cells.push({left,right,top,bottom,...w.meta});
    }
    return cells;
  };
  let profile:DepthOverlay['profile']=[];
  if(state.book&&state.settings.profile){
    const key=`${step}:${state.settings.unit}:${state.book.status}:${state.book.revision}:${Object.isFrozen(state.book)?'immutable':state.revision}`;
    let cachedProfile=profiles.get(state.book);
    if(cachedProfile?.key!==key){
      const aggregate=aggregateOrderBook(state.book,{priceStep:step,unit:state.settings.unit,limit:is4k?320:200,includeChanges:false});
      cachedProfile={key,rows:[...aggregate.bids.map(({price,quantity})=>({price,quantity,side:'bid' as const})),...aggregate.asks.map(({price,quantity})=>({price,quantity,side:'ask' as const}))]};
      profiles.set(state.book,cachedProfile);
    }
    profile=cachedProfile.rows.filter(row=>row.price>=p.min-step&&row.price<=p.max+step);
  }
  // Visible screen cells are only needed for hover hit-testing, the cross
  // section and the CPU fallback; the GPU path draws `gpu` directly. Deferring
  // them keeps a pan frame free of per-cell allocation.
  let cells:DepthCell[]|undefined,maximum:number|undefined;
  const value:DepthOverlay={
    get cells(){return cells??=projectCells();},
    get maximum(){return maximum??=this.cells.reduce((m,c)=>Math.max(m,c.quantity),0);},
    profile,profileMaximum:profile.reduce((m,c)=>Math.max(m,c.quantity),0),priceStep:step,
    scale:world.scale,gpu:{instances:world.instances,count:world.cells.length,translateX:ax,translateY:ay},staleForMs,
    crossSection:(x,y,half=3)=>depthCrossSection(world!,p,ax,step,state.settings.unit,x,y,half)};
  prepared.set(owner,{key:cacheKey,value});return value;
}

function buildDepthWorld(state:ChartOrderFlowState,p:DepthProjection,step:number,minFloor:number,columnWidth:number,rowHeight:number,key:string,builtAt:number):DepthWorld {
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
      // Server-sampled history precedes this page's own live samples. It is
      // pre-bucketed, so it is only used at the exact bucket it was built for.
      const server=state.depthHistory;
      if(server&&server.symbol===state.market?.symbol&&server.step===step){
        const firstLive=list.find(s=>Number.isFinite(s.time)&&s.time<=state.book!.capturedAt)?.time??state.book.capturedAt;
        const older=server.samples.filter(s=>s.time<firstLive);let segment=-1;
        for(let i=0;i<older.length;i++){
          const s=older[i],next=older[i+1],continuous=!!next&&next.time-s.time<=server.strideMs*2.5;
          const end=continuous?next.time:Math.min(firstLive,s.time+server.strideMs);
          samples.push({time:s.time,end,segment,bids:s.bids,asks:s.asks,source:'archive',eventTime:s.time});
          if(!continuous)segment--;
        }
      }
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
  samples.sort((a,b)=>a.time-b.time);
  // Anchors are quantized so that rolling live history (a new sample each
  // second, the oldest evicted) keeps the same bucket grid.
  const first=samples[0],last=samples.at(-1);
  const t0=first?Math.floor(first.time/HOUR)*HOUR:0,t1=last?Math.max(t0+1,last.end):t0+1,tm=(t0+t1)/2;
  const reference=last?(depthPriceBins(last.bids,step,'bid',state.settings.unit)[0]??depthPriceBins(last.asks,step,'ask',state.settings.unit)[0])?.price??0:0,grid=step*1024,p0=Number.isFinite(reference)?Math.round(reference/grid)*grid:0,probe=p0+step*64;
  const anchors={t0,t1,tm,p0,probe},ax=p.timeX(t0),ay=p.priceY(p0);
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
  const cells:WorldCell[]=[],runs:WorldRun[]=[];
  const projected={bid:new Map<number,{low:number;high:number;top:number;bottom:number;row:number}>(),ask:new Map<number,{low:number;high:number;top:number;bottom:number;row:number}>()};
  for(const run of [...columns.values()].flat()){
    const sample=run.sample,instant=run.from===run.through,lx=p.timeX(run.from)-ax,rx=instant?lx:p.timeX(run.through)-ax;
    if(!Number.isFinite(lx)||!Number.isFinite(rx))continue;
    runs.push({lx,rx:Math.max(rx,lx+.65),sample});
    const rows=new Map<string,WorldCell>();
    for(const side of ['bid','ask'] as const)for(const bin of depthPriceBins(side==='bid'?sample.bids:sample.asks,step,side,state.settings.unit)){
      const {price}=bin;let geometry=projected[side].get(price);
      if(!geometry){const low=side==='bid'?price:price-step,high=low+step,top=p.priceY(high)-ay;geometry={low,high,top,bottom:p.priceY(low)-ay,row:Math.floor((p.priceY(price)-ay)/rowHeight)};projected[side].set(price,geometry);}
      const {low,high,top,bottom,row}=geometry,key=side+':'+row,amount=bin.quantity;
      if(![top,bottom,amount].every(Number.isFinite))continue;
      const old=rows.get(key);if(old){old.meta.quantity+=amount;old.meta.priceLow=Math.min(old.meta.priceLow,low);old.meta.priceHigh=Math.max(old.meta.priceHigh,high);old.ty=Math.min(old.ty,top);old.by=Math.max(old.by,bottom);}
      else rows.set(key,{lx,rx,instant,ty:top,by:Math.max(top+1,bottom),meta:{time:sample.time,through:run.through,coverageFrom:run.from,aggregation:run.count>1?'latest-stock':'sample',priceLow:low,priceHigh:high,quantity:amount,side,
        source:sample.source,eventTime:sample.eventTime,receivedAt:sample.receivedAt,availableAt:sample.availableAt,revision:sample.revision,segmentId:sample.segment}});
    }
    for(const cell of rows.values())if(cell.meta.quantity>=minFloor)cells.push(cell);
  }
  const instances=new Float32Array(Math.max(1,cells.length)*HEATMAP_FLOATS),quantities=new Float32Array(cells.length);let maximum=0;
  for(let i=0,o=0;i<cells.length;i++,o+=HEATMAP_FLOATS){
    const c=cells[i],q=c.meta.quantity;
    instances[o]=c.lx;instances[o+1]=c.rx;instances[o+2]=c.ty;instances[o+3]=c.by;instances[o+4]=c.meta.side==='bid'?q:-q;
    quantities[i]=q;if(q>maximum)maximum=q;
  }
  runs.sort((a,b)=>a.lx-b.lx);
  return {key,builtAt,runs,shape:worldShape(p,anchors),...anchors,cells,instances,scale:{maximum,quantities}};
}

function depthCrossSection(world:DepthWorld,p:DepthProjection,ax:number,step:number,unit:ChartOrderFlowState['settings']['unit'],x:number,y:number,half:number):DepthCrossSection|undefined {
  const runs=world.runs;if(!runs.length||!(step>0)||y<p.top||y>p.bottom)return undefined;
  let index=-1,distance=Infinity;
  for(let i=0;i<runs.length;i++){const left=runs[i].lx+ax,right=runs[i].rx+ax,d=x<left?left-x:x>right?x-right:0;if(d<distance){distance=d;index=i;}}
  if(index<0||distance>4)return undefined;
  // Linear price axis: invert priceY from its two ends.
  const yMin=p.priceY(p.min),yMax=p.priceY(p.max),price=p.min+(yMin-y)/(yMin-yMax)*(p.max-p.min);
  const centerBin=Math.floor(price/step+1e-9);
  const columns=[index-1,index,index+1].map(i=>runs[i]?.sample);
  const tables=columns.map(sample=>{
    const levels=new Map<number,{quantity:number;side:'bid'|'ask'}>();if(!sample)return levels;
    for(const bin of depthPriceBins(sample.bids,step,'bid',unit))levels.set(Math.round(bin.price/step),{quantity:bin.quantity,side:'bid'});
    for(const bin of depthPriceBins(sample.asks,step,'ask',unit))levels.set(Math.round(bin.price/step)-1,{quantity:bin.quantity,side:'ask'});
    return levels;
  });
  const rows:DepthCrossSection['rows']=[];
  for(let k=half;k>=-half;k--){const bin=centerBin+k;rows.push({priceLow:bin*step,priceHigh:(bin+1)*step,cells:tables.map((levels,i)=>columns[i]?levels.get(bin)??{quantity:0,side:bin>=centerBin?'ask':'bid'}:null)});}
  return {times:columns.map(sample=>sample?.time??null),centerColumn:1,centerRow:half,step,rows};
}

type HeatmapIntensitySettings=Partial<Pick<OrderFlowSettings,'theme'|'threshold'|'ceiling'|'minBounds'|'maxBounds'|'sensitivity'>>;
const intensities=new WeakMap<object,{key:string;value:HeatmapIntensityRange}>();
/** Threshold/ceiling actually used to paint `data`. Derived from pan-stable
 * scale statistics, so colors do not breathe while the viewport moves, and
 * cached so the sort behind it never runs per frame. The settings popover
 * reads this same value, keeping its histogram handles truthful. */
export function depthHeatmapIntensity(data:DepthOverlay,settings:HeatmapIntensitySettings):HeatmapIntensityRange {
  const scale=data.scale??{maximum:data.maximum,quantities:Float32Array.from(data.cells,c=>c.quantity)};
  const key=[settings.sensitivity,settings.threshold,settings.ceiling,settings.minBounds,settings.maxBounds].join(':');
  const cached=intensities.get(scale);if(cached?.key===key)return cached.value;
  const value=resolveHeatmapIntensity(Array.from(scale.quantities),scale.maximum,settings);
  if(data.scale)intensities.set(scale,{key,value});
  return value;
}

export function drawDepthHeatmap(
  r:Pick<RenderBackend,'rect'>&Partial<Pick<RenderBackend,'rectRgb'|'heatmap'>>,
  data:DepthOverlay,
  opacity:number,
  colors:{bid:string;ask:string},
  settings?:HeatmapIntensitySettings,
){
  if(!((data.scale?.maximum??data.maximum)>0)||!Number.isFinite(opacity)||opacity<=0)return;
  opacity=Math.min(1,opacity);
  if(!settings?.theme){
    if(!(data.maximum>0))return;
    for(const cell of data.cells)r.rect(cell.left,cell.top,cell.right,cell.bottom,cell.side==='bid'?colors.bid:colors.ask,Math.max(opacity*.07,Math.sqrt(cell.quantity/data.maximum)*opacity));
    return;
  }
  const intensity=depthHeatmapIntensity(data,settings),palette=getHeatmapPalette(settings.theme);
  if(data.gpu&&r.heatmap?.(data.gpu.instances,data.gpu.count,data.gpu.translateX,data.gpu.translateY,intensity.threshold,intensity.ceiling,opacity,palette))return;
  const last=HEATMAP_LUT_SIZE-1;
  for(const cell of data.cells){
    const position=heatmapRampPosition(cell.quantity,intensity.threshold,intensity.ceiling);if(position<0)continue;
    const o=((cell.side==='bid'?0:HEATMAP_LUT_SIZE)+Math.round(position*last))*4,lut=palette.rgba,alpha=heatmapCellAlpha(lut[o+3],opacity);
    if(r.rectRgb)r.rectRgb(cell.left,cell.top,cell.right,cell.bottom,lut[o],lut[o+1],lut[o+2],alpha);
    else r.rect(cell.left,cell.top,cell.right,cell.bottom,rgbHex(lut[o],lut[o+1],lut[o+2]),alpha);
  }
}
const rgbHex=(r:number,g:number,b:number)=>'#'+[r,g,b].map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join('');

export function drawDepthProfile(
  r:Pick<RenderBackend,'rect'>&Partial<Pick<RenderBackend,'seg'>>,
  data:DepthOverlay,
  p:DepthProjection,
  opacity:number,
  colors:{bid:string;ask:string},
  settings?:Partial<Pick<OrderFlowSettings,'theme'|'crossSection'>>,
){
  if(data.profileMaximum<=0||!Number.isFinite(opacity)||opacity<=0)return;
  const themeColors=settings?.theme?getHeatmapTheme(settings.theme).profileColors:colors;
  const width=Math.min(130,(p.right-p.left)*.15);
  for(const row of data.profile){
    const yy=p.priceY(row.price),height=Math.max(1,Math.min(18,Math.abs(p.priceY(row.price+data.priceStep)-yy))),size=width*row.quantity/data.profileMaximum;
    // Per-level bars stay faint: the cumulative staircase carries the read,
    // and the column must not read as an opaque box over the price action.
    r.rect(p.right-size,Math.max(p.top,yy-height/2),p.right,Math.min(p.bottom,yy+height/2),row.side==='bid'?themeColors.bid:themeColors.ask,settings?.theme?Math.min(.16,opacity*.24):Math.min(.5,opacity*.75));
  }
  // Cumulative depth staircase, anchored at the best price on the right edge.
  if(r.seg&&settings?.theme&&data.profile.length>=2){
    const bids=data.profile.filter(row=>row.side==='bid').sort((a,b)=>b.price-a.price);
    const asks=data.profile.filter(row=>row.side==='ask').sort((a,b)=>a.price-b.price);
    let cumBid=0,cumAsk=0;
    const bidStairs=bids.map(row=>{cumBid+=row.quantity;return {price:row.price,cum:cumBid};});
    const askStairs=asks.map(row=>{cumAsk+=row.quantity;return {price:row.price,cum:cumAsk};});
    const maxCum=Math.max(1e-9,cumBid,cumAsk);
    const drawStaircase=(stairs:Array<{price:number;cum:number}>,color:string)=>{
      const alpha=Math.min(.9,opacity*1.3);
      let prevX:number|null=null,prevY:number|null=null;
      for(const pt of stairs){
        const yy=Math.max(p.top,Math.min(p.bottom,p.priceY(pt.price)));
        const xx=p.right-width*(pt.cum/maxCum);
        if(prevX===null||prevY===null)r.seg!(p.right,yy,xx,yy,color,alpha,1.25);
        else {
          r.seg!(prevX,prevY,prevX,yy,color,alpha,1.25);
          r.seg!(prevX,yy,xx,yy,color,alpha,1.25);
        }
        prevX=xx;prevY=yy;
      }
    };
    drawStaircase(bidStairs,themeColors.bid);
    drawStaircase(askStairs,themeColors.ask);
  }
}

export function drawDepthCrossSection(
  ctx:CanvasRenderingContext2D,
  data:DepthOverlay,
  p:DepthProjection,
  pointer:{x:number;y:number}|null,
  unitLabel:string,
  themeId?:OrderFlowSettings['theme'],
  tone:'dark'|'light'='dark',
):void {
  const ink=depthCardInk(tone),themeColors=themeId?getHeatmapTheme(themeId).profileColors:{bid:'#00e676',ask:'#ff00ff'};
  const targetX=pointer&&pointer.x>=p.left&&pointer.x<=p.right?pointer.x:null;
  // Collect cross-section slice from hovered time column or fall back to live profile
  let sliceRows:Array<{price:number;quantity:number;side:'bid'|'ask'}>=[];
  let sliceLabel=translate('当前盘口截面');
  if(targetX!==null&&data.cells.length){
    const columnCells=data.cells.filter(c=>targetX>=c.left-2&&targetX<=c.right+2);
    if(columnCells.length){
      sliceRows=columnCells.map(c=>({price:(c.priceLow+c.priceHigh)/2,quantity:c.quantity,side:c.side}));
      const sampleTime=columnCells[0].time;
      const d=new Date(sampleTime);
      sliceLabel=translate('截面 {0} UTC',{0:`${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`});
    }
  }
  if(!sliceRows.length&&data.profile.length){
    sliceRows=data.profile;
  }
  if(!sliceRows.length)return;

  const bids=sliceRows.filter(r=>r.side==='bid').sort((a,b)=>b.price-a.price);
  const asks=sliceRows.filter(r=>r.side==='ask').sort((a,b)=>a.price-b.price);
  const totalBid=bids.reduce((s,r)=>s+r.quantity,0);
  const totalAsk=asks.reduce((s,r)=>s+r.quantity,0);
  const total=Math.max(1e-9,totalBid+totalAsk);
  const bidPct=Math.round((totalBid/total)*100);

  // Draw floating Cross-section mini card at bottom-right of main pane
  const cardW=216,cardH=94;
  const cardX=Math.max(p.left+8,p.right-cardW-136);
  const cardY=Math.max(p.top+8,p.bottom-cardH-10);

  ctx.save();
  ctx.fillStyle=ink.card;
  ctx.strokeStyle=ink.border;
  ctx.lineWidth=1;
  ctx.beginPath();
  ctx.roundRect(cardX,cardY,cardW,cardH,6);
  ctx.fill();
  ctx.stroke();

  ctx.font='600 10.5px "IBM Plex Mono", ui-monospace, monospace';
  ctx.fillStyle=ink.strong;
  ctx.textBaseline='top';
  ctx.fillText(`${translate('深度截面')} · ${sliceLabel}`,cardX+10,cardY+8);

  // Bid vs Ask imbalance bar
  const barX=cardX+10,barY=cardY+26,barW=cardW-20,barH=6;
  const bidW=Math.round(barW*(totalBid/total));
  ctx.fillStyle=themeColors.bid;
  ctx.fillRect(barX,barY,bidW,barH);
  ctx.fillStyle=themeColors.ask;
  ctx.fillRect(barX+bidW,barY,barW-bidW,barH);

  // Cumulative depth spark-curve inside card
  const plotX=cardX+10,plotY=cardY+38,plotW=cardW-20,plotH=32;
  ctx.fillStyle=ink.well;
  ctx.fillRect(plotX,plotY,plotW,plotH);

  const midX=plotX+plotW/2;
  const maxCum=Math.max(1e-9,totalBid,totalAsk);
  const drawMiniCurve=(rows:Array<{price:number;quantity:number}>,dir:-1|1,color:string)=>{
    if(!rows.length)return;
    let cum=0;
    ctx.beginPath();
    ctx.moveTo(midX,plotY+plotH);
    rows.forEach((row,i)=>{
      cum+=row.quantity;
      const x=midX+dir*((i+1)/Math.max(1,rows.length))*(plotW/2);
      const y=plotY+plotH-(cum/maxCum)*(plotH-4);
      ctx.lineTo(x,y);
    });
    ctx.strokeStyle=color;
    ctx.lineWidth=1.5;
    ctx.stroke();
    ctx.lineTo(midX+dir*(plotW/2),plotY+plotH);
    ctx.closePath();
    ctx.fillStyle=color+'26';
    ctx.fill();
  };
  drawMiniCurve(bids,-1,themeColors.bid);
  drawMiniCurve(asks,1,themeColors.ask);

  const fmtCompact=(v:number)=>{
    const abs=Math.abs(v);
    if(abs>=1_000_000_000)return `${(v/1_000_000_000).toFixed(2)}B`;
    if(abs>=1_000_000)return `${(v/1_000_000).toFixed(2)}M`;
    if(abs>=1_000)return `${(v/1_000).toFixed(1)}K`;
    return v>=100?v.toFixed(0):v.toFixed(2);
  };
  ctx.font='500 10px ui-monospace, monospace';
  ctx.fillStyle=themeColors.bid;
  ctx.textAlign='left';
  ctx.fillText(`ΣBid ${fmtCompact(totalBid)} (${bidPct}%)`,cardX+10,cardY+75);
  ctx.fillStyle=themeColors.ask;
  ctx.textAlign='right';
  ctx.fillText(`ΣAsk ${fmtCompact(totalAsk)} ${unitLabel}`,cardX+cardW-10,cardY+75);
  ctx.restore();
}

export function hitDepthCell(cells:readonly DepthCell[],x:number,y:number):DepthCell|undefined {
  return cells.find(c=>x>=c.left&&x<=c.right&&y>=c.top&&y<=c.bottom);
}


/** Canvas inks for floating depth cards, per chart tone. */
export interface DepthCardInk {card:string;border:string;text:string;muted:string;strong:string;well:string;emptyCell:string;rule:string;outline:string;onLight:string;onDark:string}
const DARK_CARD:DepthCardInk={card:'rgba(22,23,27,.96)',border:'rgba(255,255,255,.2)',text:'rgba(226,232,240,.82)',muted:'rgba(226,232,240,.6)',strong:'#f8fafc',well:'rgba(255,255,255,.035)',emptyCell:'#000',rule:'rgba(148,163,184,.55)',outline:'rgba(255,255,255,.85)',onLight:'#0b0c0f',onDark:'#f1f5f9'};
const LIGHT_CARD:DepthCardInk={card:'rgba(255,255,255,.97)',border:'rgba(16,24,40,.18)',text:'rgba(37,43,52,.86)',muted:'rgba(37,43,52,.6)',strong:'#0d1117',well:'rgba(16,24,40,.045)',emptyCell:'#eef0f3',rule:'rgba(71,85,105,.5)',outline:'rgba(16,24,40,.8)',onLight:'#0b0c0f',onDark:'#f1f5f9'};
export const depthCardInk=(tone:'dark'|'light'='dark'):DepthCardInk=>tone==='light'?LIGHT_CARD:DARK_CARD;

export interface DepthCrossTableStyle {
  /** Chart tone; light charts get a paper card instead of a dark chip. */
  tone?:'dark'|'light';
  /** Heatmap palette + ramp so cells are tinted exactly like the heatmap. */
  theme:OrderFlowSettings['theme'];threshold:number;ceiling:number;
  formatPrice:(price:number)=>string;formatQuantity:(quantity:number)=>string;
  caption?:string;
}
const TABLE={pad:4,cell:62,price:78,row:22,gap:2,caption:18,radius:8,offset:16};
/** Size of {@link drawDepthCrossTable} for a table with `rows` rows. */
export function depthCrossTableSize(rows:number,caption=true){
  return {width:TABLE.pad*2+TABLE.cell*3+TABLE.price+TABLE.gap*3,height:TABLE.pad*2+rows*TABLE.row+(rows-1)*TABLE.gap+(caption?TABLE.caption:0)};
}
/**
 * Hover table for the heatmap: previous / hovered / next column × price bins.
 * Cells that pass the heatmap threshold take the heatmap's own color, so the
 * table reads as a magnified slice of what is painted; the hovered cell is
 * enlarged and outlined; the hovered price row is bracketed by rules.
 */
export function drawDepthCrossTable(ctx:CanvasRenderingContext2D,table:DepthCrossSection,pointer:{x:number;y:number},bounds:{left:number;top:number;right:number;bottom:number},style:DepthCrossTableStyle):void {
  const size=depthCrossTableSize(table.rows.length,!!style.caption);
  let x=pointer.x+TABLE.offset,y=pointer.y+TABLE.offset;
  if(x+size.width>bounds.right-4)x=pointer.x-TABLE.offset-size.width;
  if(y+size.height>bounds.bottom-4)y=pointer.y-TABLE.offset-size.height;
  x=Math.max(bounds.left+4,x);y=Math.max(bounds.top+4,y);
  const palette=style.theme?getHeatmapPalette(style.theme):undefined,last=HEATMAP_LUT_SIZE-1,ink=depthCardInk(style.tone);
  ctx.save();
  ctx.fillStyle=ink.card;ctx.strokeStyle=ink.border;ctx.lineWidth=1;
  ctx.beginPath();ctx.roundRect(x+.5,y+.5,size.width-1,size.height-1,TABLE.radius);ctx.fill();ctx.stroke();
  let top=y+TABLE.pad;
  if(style.caption){
    ctx.font='500 10.5px "IBM Plex Mono", ui-monospace, monospace';ctx.fillStyle=ink.muted;ctx.textAlign='left';ctx.textBaseline='middle';
    ctx.fillText(style.caption,x+TABLE.pad+4,top+TABLE.caption/2-1);top+=TABLE.caption;
  }
  ctx.textAlign='center';ctx.textBaseline='middle';
  table.rows.forEach((row,r)=>{
    const rowTop=top+r*(TABLE.row+TABLE.gap);
    row.cells.forEach((cell,c)=>{
      const cellX=x+TABLE.pad+c*(TABLE.cell+TABLE.gap);
      let background=ink.emptyCell,text=style.tone==='light'?'#252b34':ink.onDark;
      if(cell&&palette){
        const position=heatmapRampPosition(cell.quantity,style.threshold,style.ceiling);
        if(position>=0){
          const o=((cell.side==='bid'?0:HEATMAP_LUT_SIZE)+Math.round(position*last))*4,[red,green,blue]=[palette.bytes[o],palette.bytes[o+1],palette.bytes[o+2]];
          background=`rgb(${red},${green},${blue})`;text=.299*red+.587*green+.114*blue>150?ink.onLight:ink.onDark;
        }
      }
      ctx.fillStyle=background;ctx.fillRect(cellX,rowTop,TABLE.cell,TABLE.row);
      if(!cell)return;
      const center=r===table.centerRow&&c===table.centerColumn;
      ctx.fillStyle=text;ctx.font=center?'700 15px "IBM Plex Mono", ui-monospace, monospace':'600 12px "IBM Plex Mono", ui-monospace, monospace';
      ctx.fillText(style.formatQuantity(cell.quantity),cellX+TABLE.cell/2,rowTop+TABLE.row/2+.5);
      if(center){ctx.strokeStyle=ink.outline;ctx.lineWidth=1.5;ctx.beginPath();ctx.roundRect(cellX+.75,rowTop+.75,TABLE.cell-1.5,TABLE.row-1.5,4);ctx.stroke();}
    });
    const priceX=x+TABLE.pad+3*(TABLE.cell+TABLE.gap);
    ctx.fillStyle=ink.well;ctx.fillRect(priceX,rowTop,TABLE.price,TABLE.row);
    ctx.fillStyle=r===table.centerRow?ink.strong:ink.text;ctx.font=`${r===table.centerRow?700:600} 12px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.fillText(style.formatPrice(row.priceLow),priceX+TABLE.price/2,rowTop+TABLE.row/2+.5);
  });
  // Rules bracketing the hovered price row.
  const ruleTop=top+table.centerRow*(TABLE.row+TABLE.gap)-TABLE.gap/2,ruleBottom=ruleTop+TABLE.row+TABLE.gap;
  ctx.strokeStyle=ink.rule;ctx.lineWidth=1.5;ctx.beginPath();
  ctx.moveTo(x+2,ruleTop);ctx.lineTo(x+size.width-2,ruleTop);ctx.moveTo(x+2,ruleBottom);ctx.lineTo(x+size.width-2,ruleBottom);ctx.stroke();
  ctx.restore();
}
