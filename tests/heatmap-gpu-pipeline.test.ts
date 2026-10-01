import {describe,expect,it,vi} from 'vitest';
import {depthCrossTableSize,depthHeatmapIntensity,drawDepthCrossTable,drawDepthHeatmap,prepareDepthOverlay,type DepthProjection} from '../src/lib/render/orderbook-overlay';
import {normalizeOrderFlowSettings,type ChartOrderFlowState,type DepthHistory} from '../src/lib/flow/chart-order-flow';
import type {BookLevel} from '../src/lib/flow/orderbook';
import type {BookHistorySample,SharedBookSnapshot} from '../src/lib/flow/orderbook-hub';
import {HEATMAP_LUT_SIZE,getHeatmapPalette,resolveHeatmapCellColor,resolveHeatmapIntensity} from '../src/lib/flow/heatmap-themes';
import {GLRenderer,HEATMAP_FLOATS} from '../src/lib/render/gl';

function deepFreeze<T>(value:T):T {if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;}
function book(count:number,revision=count,key='gpu-book',wall=0):SharedBookSnapshot {
  const history:BookHistorySample[]=Array.from({length:count},(_,i)=>({time:10_000+i*1000,eventTime:10_000+i*1000,receivedAt:10_000+i*1000,availableAt:10_000+i*1000,revision:i+1,segmentId:1,
    bids:Array.from({length:20},(_,j)=>({price:100-j*.5,quantity:j===3?wall||1+j:1+j})),asks:Array.from({length:20},(_,j)=>({price:100.5+j*.5,quantity:2+j}))}));
  return deepFreeze({identity:{source:'binance',marketType:'usdm-perpetual',symbol:'BTCUSDT'},key,symbol:'BTCUSDT',supported:true,status:'live',bids:history.at(-1)!.bids,asks:history.at(-1)!.asks,
    updatedAt:0,lastReceivedAt:0,lastUpdateId:revision,revision,segmentId:1,capturedAt:10_000+count*1000,history,changes:[],
    historyCoverage:{fromTime:10_000,throughTime:10_000+(count-1)*1000,samples:count,intervalMs:1000,maxSamples:300,levelsPerSide:20},
    coverage:{fromTime:null,throughTime:null,receivedFromTime:null,receivedThroughTime:null,segmentId:1,depthPerSide:1000},changeCoverage:{fromTime:null,throughTime:null,truncated:false}} as unknown as SharedBookSnapshot);
}
function state(b:SharedBookSnapshot,settings:Record<string,unknown>={}):ChartOrderFlowState {
  return {market:{source:'binance',marketType:'usdm-perpetual',symbol:'BTCUSDT',tickSize:.5},settings:normalizeOrderFlowSettings({heatmap:true,profile:false,priceStepTicks:1,theme:'stark',...settings}),mode:'live',running:true,book:b,error:'',revision:1};
}
const projection=(shiftX=0,shiftY=0):DepthProjection=>({left:0,right:900,top:0,bottom:400,fromTime:0,toTime:100_000,min:90,max:110,
  timeX:t=>(t-10_000)/60_000*900-shiftX,priceY:p=>(110-p)*20+shiftY});

describe('pan-invariant heatmap world',()=>{
  it('translates cells on a pure pan instead of re-bucketing, and reuses the GPU instance buffer',()=>{
    const input=state(book(60));
    const a=prepareDepthOverlay(input,projection()),b=prepareDepthOverlay(input,projection(37.25,11.5));
    expect(b.gpu!.instances).toBe(a.gpu!.instances);
    expect(b.gpu!.translateX-a.gpu!.translateX).toBeCloseTo(-37.25);
    expect(b.gpu!.translateY-a.gpu!.translateY).toBeCloseTo(11.5);
    const interior=(cells:typeof a.cells)=>cells.filter(c=>c.left>60&&c.right<800&&c.top>20&&c.bottom<380);
    const moved=interior(b.cells).map(c=>`${c.time}:${c.side}:${c.priceLow}:${(c.left+37.25).toFixed(6)}:${(c.top-11.5).toFixed(6)}`);
    const before=new Set(a.cells.map(c=>`${c.time}:${c.side}:${c.priceLow}:${c.left.toFixed(6)}:${c.top.toFixed(6)}`));
    expect(moved.length).toBeGreaterThan(50);
    const missing=moved.filter(key=>!before.has(key));
    expect(missing).toEqual([]);
  });
  it('rebuilds when the horizontal scale changes (zoom)',()=>{
    const input=state(book(60)),a=prepareDepthOverlay(input,projection());
    const zoomed=prepareDepthOverlay(input,{...projection(),timeX:t=>(t-10_000)/30_000*900});
    expect(zoomed.gpu!.instances).not.toBe(a.gpu!.instances);
  });
  it('treats the max bound as saturation, never hiding the largest walls',()=>{
    const input=state(book(10,10,'wall-book',5000),{maxBounds:50});
    const overlay=prepareDepthOverlay(input,projection());
    expect(overlay.cells.some(c=>c.quantity>=5000)).toBe(true);
    const intensity=depthHeatmapIntensity(overlay,input.settings);
    expect(intensity.maxBounds).toBe(50);
  });
  it('keeps colors pan-stable: intensity comes from all prepared cells, not the visible slice',()=>{
    const input=state(book(60)),a=prepareDepthOverlay(input,projection()),b=prepareDepthOverlay(input,projection(700));
    expect(b.cells.length).toBeLessThan(a.cells.length);
    expect(depthHeatmapIntensity(b,input.settings)).toBe(depthHeatmapIntensity(a,input.settings));
  });
});

describe('live rebuild throttle',()=>{
  it('reuses the previous world within the window, reports staleness, and rebuilds after it',()=>{
    const key='throttle-book',p=projection();
    const first=prepareDepthOverlay(state(book(30,30,key)),p,{minRebuildMs:250,now:1000});
    const within=prepareDepthOverlay(state(book(31,31,key)),p,{minRebuildMs:250,now:1100});
    expect(within.gpu!.instances).toBe(first.gpu!.instances);
    expect(within.staleForMs).toBe(150);
    const after=prepareDepthOverlay(state(book(31,31,key)),p,{minRebuildMs:250,now:1300});
    expect(after.gpu!.instances).not.toBe(first.gpu!.instances);
    expect(after.staleForMs).toBe(0);
  });
  it('never throttles without a clock (tests, archives) or for mutable books',()=>{
    const p=projection(),a=prepareDepthOverlay(state(book(30,30,'nt')),p),b=prepareDepthOverlay(state(book(31,31,'nt')),p);
    expect(b.gpu!.instances).not.toBe(a.gpu!.instances);
  });
});

describe('heatmap draw paths',()=>{
  it('draws through the instanced GPU path with the resolved threshold/ceiling and no per-cell rects',()=>{
    const input=state(book(20)),overlay=prepareDepthOverlay(input,projection());
    const heatmap=vi.fn(()=>true),rect=vi.fn();
    drawDepthHeatmap({rect,heatmap},overlay,.7,{bid:'#0f0',ask:'#f00'},input.settings);
    expect(rect).not.toHaveBeenCalled();
    const intensity=depthHeatmapIntensity(overlay,input.settings);
    expect(heatmap).toHaveBeenCalledWith(overlay.gpu!.instances,overlay.gpu!.count,overlay.gpu!.translateX,overlay.gpu!.translateY,intensity.threshold,intensity.ceiling,.7,getHeatmapPalette('stark'));
    expect(overlay.gpu!.instances.length).toBeGreaterThanOrEqual(overlay.gpu!.count*HEATMAP_FLOATS);
  });
  it('falls back to LUT rects on Canvas2D and culls cells below the threshold',()=>{
    const input=state(book(20),{sensitivity:'low'}),overlay=prepareDepthOverlay(input,projection());
    const rectRgb=vi.fn(),rect=vi.fn();
    drawDepthHeatmap({rect,rectRgb,heatmap:()=>false},overlay,.7,{bid:'#0f0',ask:'#f00'},input.settings);
    const threshold=depthHeatmapIntensity(overlay,input.settings).threshold,drawable=overlay.cells.filter(c=>c.quantity>=threshold).length;
    expect(drawable).toBeGreaterThan(0);expect(drawable).toBeLessThan(overlay.cells.length);
    expect(rectRgb).toHaveBeenCalledTimes(drawable);expect(rect).not.toHaveBeenCalled();
  });
  it('matches resolveHeatmapCellColor at the ramp endpoints',()=>{
    for(const theme of ['stark','fire','classic'] as const){
      const palette=getHeatmapPalette(theme);
      for(const [side,row] of [['bid',0],['ask',1]] as const){
        const top=resolveHeatmapCellColor(100,side,1,theme,{threshold:0,ceiling:100},{bid:'#000',ask:'#000'});
        const o=(row*HEATMAP_LUT_SIZE+HEATMAP_LUT_SIZE-1)*4,hex='#'+[0,1,2].map(i=>palette.bytes[o+i].toString(16).padStart(2,'0')).join('');
        expect(hex).toBe(top.color);expect(palette.rgba[o+3]).toBeCloseTo(top.alpha);
      }
    }
  });
});

describe('GL vertex streaming',()=>{
  it('allocates GPU storage for the full staging array so larger later frames never overflow bufferSubData',()=>{
    const allocated=new Map<unknown,number>(),errors:string[]=[];let bound:unknown=null;
    const gl=new Proxy({} as Record<string,unknown>,{get(_t,key){
      if(key==='getShaderParameter'||key==='getProgramParameter')return ()=>true;
      if(key==='getExtension')return ()=>null;
      if(key==='getAttribLocation')return ()=>0;
      if(key==='isContextLost')return ()=>false;
      if(typeof key==='string'&&key.startsWith('create'))return ()=>({id:Math.random()});
      if(key==='bindBuffer')return (_:unknown,buffer:unknown)=>{bound=buffer;};
      if(key==='bufferData')return (_:unknown,size:number|ArrayBufferView)=>{allocated.set(bound,typeof size==='number'?size:size.byteLength);};
      if(key==='bufferSubData')return (_:unknown,offset:number,data:Float32Array,srcOffset=0,length=data.length-srcOffset)=>{if(offset+length*4>(allocated.get(bound)??0))errors.push(`overflow ${length*4}>${allocated.get(bound)}`);};
      return ()=>undefined;
    }});
    const canvas={getContext:()=>gl,addEventListener:()=>{},removeEventListener:()=>{},width:0,height:0} as unknown as HTMLCanvasElement;
    const renderer=new GLRenderer(canvas);renderer.resize(100,100,1);
    renderer.begin('#000000');renderer.rect(0,0,1,1,'#ffffff');renderer.flush();
    renderer.begin('#000000');for(let i=0;i<5000;i++)renderer.rect(i,0,i+1,1,'#ffffff');renderer.flush();
    expect(errors).toEqual([]);
  });
});

describe('auto intensity',()=>{
  it('is robust to a single far liquidity wall (quantiles, not the maximum)',()=>{
    const levels=[...Array.from({length:200},(_,i)=>1+i%50),10_000];
    const range=resolveHeatmapIntensity(levels,10_000,{sensitivity:'med'});
    expect(range.threshold).toBeLessThan(50);expect(range.ceiling).toBeLessThan(60);
    // Default shows walls, not the whole book: roughly the top 15% paints.
    const share=levels.filter(q=>q>=range.threshold).length/levels.length;
    expect(share).toBeGreaterThan(.08);expect(share).toBeLessThan(.25);
  });
});

describe('heatmap hover cross-section',()=>{
  it('returns previous / hovered / next columns × price bins from each column\'s raw stock, highest price first',()=>{
    const input=state(book(60)),p=projection(),overlay=prepareDepthOverlay(input,p);
    const hovered=overlay.cells.find(c=>c.side==='bid'&&c.priceLow===98&&c.time===30_000)!;
    const table=overlay.crossSection!((hovered.left+hovered.right)/2,(hovered.top+hovered.bottom)/2)!;
    expect(table.times).toEqual([29_000,30_000,31_000]);expect(table.centerColumn).toBe(1);expect(table.centerRow).toBe(3);
    expect(table.rows.map(r=>r.priceLow)).toEqual([99.5,99,98.5,98,97.5,97,96.5]);
    // bid j at price 100-0.5j carries quantity 1+j (j=3 is 98.5 → 4, 98 → 5)
    expect(table.rows[3].cells[1]).toEqual({quantity:5,side:'bid'});expect(table.rows[2].cells[1]).toEqual({quantity:4,side:'bid'});
    expect(overlay.crossSection!(p.right+50,(hovered.top+hovered.bottom)/2)).toBeUndefined();
  });
  it('draws a palette-tinted table that stays inside the pane and brackets the hovered row',()=>{
    const input=state(book(60)),overlay=prepareDepthOverlay(input,projection()),cell=overlay.cells.find(c=>c.side==='bid'&&c.time===30_000)!;
    const table=overlay.crossSection!(cell.left+1,cell.top+1)!;
    const calls:string[]=[],fills:string[]=[];
    const ctx=new Proxy({} as Record<string,unknown>,{get(target,key){if(typeof key!=='string')return undefined;if(key in target)return target[key];if(key==='fillRect')return (...a:number[])=>{calls.push('rect');fills.push(String(target.fillStyle));void a;};return (...a:unknown[])=>{calls.push(String(key));void a;};},set(target,key,value){target[key as string]=value;return true;}}) as unknown as CanvasRenderingContext2D;
    const {width,height}=depthCrossTableSize(7);
    drawDepthCrossTable(ctx,table,{x:880,y:390},{left:0,top:0,right:900,bottom:400},{theme:'stark',threshold:4,ceiling:15,formatPrice:v=>v.toFixed(1),formatQuantity:v=>v.toFixed(2),caption:'t · BTC'});
    expect(width).toBeLessThan(300);expect(height).toBeLessThan(200);
    expect(calls.filter(c=>c==='fillText').length).toBeGreaterThanOrEqual(7*4);
    expect(fills.some(f=>f.startsWith('rgb('))).toBe(true);expect(fills).toContain('#000');
  });
  it('draws the hover table as a paper card on light charts',()=>{
    const input=state(book(60)),overlay=prepareDepthOverlay(input,projection()),cell=overlay.cells.find(c=>c.side==='bid'&&c.time===30_000)!;
    const table=overlay.crossSection!(cell.left+1,cell.top+1)!,paints:string[]=[];
    const ctx=new Proxy({} as Record<string,unknown>,{get(target,key){if(typeof key!=='string')return undefined;if(key in target)return target[key];if(key==='fill'||key==='fillRect')return ()=>{paints.push(String(target.fillStyle));};return ()=>undefined;},set(target,key,value){target[key as string]=value;return true;}}) as unknown as CanvasRenderingContext2D;
    const style={theme:'stark' as const,threshold:4,ceiling:15,formatPrice:(v:number)=>v.toFixed(1),formatQuantity:(v:number)=>v.toFixed(2)};
    drawDepthCrossTable(ctx,table,{x:400,y:200},{left:0,top:0,right:900,bottom:400},{...style,tone:'light'});
    expect(paints[0]).toBe('rgba(255,255,255,.97)');expect(paints).not.toContain('#000');expect(paints).toContain('#eef0f3');
    paints.length=0;drawDepthCrossTable(ctx,table,{x:400,y:200},{left:0,top:0,right:900,bottom:400},style);
    expect(paints[0]).toBe('rgba(22,23,27,.96)');
  });
});

describe('heatmap price bucket',()=>{
  it('pools levels by the price decade, stays stable within it, and never undercuts grouping or tick',async()=>{
    const {heatmapPriceStep}=await import('../src/lib/render/orderbook-overlay');
    expect(heatmapPriceStep(.1,50,82_900,false)).toBe(25);expect(heatmapPriceStep(.1,50,82_900,true)).toBe(10);
    expect(heatmapPriceStep(.1,50,99_999,false)).toBe(25);// same decade → same grid
    expect(heatmapPriceStep(.01,50,2_645,false)).toBeCloseTo(2.5);expect(heatmapPriceStep(.01,10,118,false)).toBeCloseTo(.25);
    expect(heatmapPriceStep(.1,500,82_900,false)).toBe(50);// coarser terminal grouping wins
    expect(heatmapPriceStep(1,1,150,false)).toBe(1);// never below one tick
    expect(heatmapPriceStep(.1,50,NaN,false)).toBe(5);
  });
});

describe('server-sampled history in the heatmap',()=>{
  const frozen=(rows:Array<[number,number]>)=>Object.freeze(rows.map(([price,quantity])=>Object.freeze({price,quantity}))) as BookLevel[];
  it('draws server samples before this page\'s live history, split at gaps, only at the matching bucket',()=>{
    const live=book(10);const input=state(live);const step=prepareDepthOverlay(input,projection()).priceStep;
    const server=[0,1,2,5].map(k=>Object.freeze({time:1_000+k*2_000,bids:frozen([[99,10]]),asks:frozen([[101,10]])}));
    const history:DepthHistory={symbol:'BTCUSDT',step,from:0,to:10_000,strideMs:2_000,fetchedAt:0,revision:1,samples:server};
    input.depthHistory=history;
    const view=projection(-200);// show t=1,000…
    const cells=prepareDepthOverlay(input,view).cells.filter(c=>c.source==='archive'&&c.side==='bid');
    // 1,000→3,000→5,000 are continuous; 11,000 is after the first live sample (10,000) and is dropped.
    expect(cells.map(c=>[c.time,c.through])).toEqual([[1_000,3_000],[3_000,5_000],[5_000,7_000]]);
    input.depthHistory={...history,samples:[...server.slice(0,2),Object.freeze({time:9_000,bids:frozen([[99,10]]),asks:frozen([[101,10]])})],revision:2};
    const split=prepareDepthOverlay(input,view).cells.filter(c=>c.source==='archive'&&c.side==='bid');
    expect(split.map(c=>c.segmentId)).toEqual([-1,-1,-2]);// a gap (3,000 → 9,000) starts a new segment
    input.depthHistory={...history,step:step*2,revision:3};
    expect(prepareDepthOverlay(input,view).cells.some(c=>c.source==='archive')).toBe(false);
  });
});
