import {describe,expect,it,vi} from 'vitest';
import {prepareDepthOverlay,drawDepthHeatmap,drawDepthProfile,hitDepthCell,type DepthProjection} from '../src/lib/render/orderbook-overlay';
import {normalizeOrderFlowSettings,type ChartOrderFlowState} from '../src/lib/flow/chart-order-flow';
import type {BookHistorySample,SharedBookSnapshot} from '../src/lib/flow/orderbook-hub';
import type {DatasetInfo} from '../src/lib/flow/persistence-client';

const sample=(time:number,quantity=2,segmentId=1):BookHistorySample=>({time,eventTime:time-50,receivedAt:time,availableAt:time,revision:time,segmentId,bids:[{price:100.2,quantity}],asks:[{price:101.2,quantity:3}]});
function state(history=[sample(1000),sample(2000,4),sample(3000,5)]):ChartOrderFlowState {
  const market={source:'binance',marketType:'usdm-perpetual',symbol:'BTCUSDT',tickSize:1};
  const book:SharedBookSnapshot={identity:market,key:'book',symbol:market.symbol,supported:true,status:'live',bids:[{price:100.2,quantity:5}],asks:[{price:101.2,quantity:3}],updatedAt:2950,lastReceivedAt:3000,lastUpdateId:3,revision:3,segmentId:1,capturedAt:4000,history,changes:[],coverage:{fromTime:950,throughTime:2950,receivedFromTime:1000,receivedThroughTime:3000,segmentId:1,depthPerSide:1000},changeCoverage:{fromTime:1000,throughTime:3000,truncated:false},historyCoverage:{fromTime:1000,throughTime:3000,samples:history.length,intervalMs:1000,maxSamples:150,levelsPerSide:100}};
  return {market,settings:normalizeOrderFlowSettings({heatmap:true,profile:true,priceStepTicks:1}),mode:'live',running:true,book,error:'',revision:1};
}
const projection:DepthProjection={left:0,right:1000,top:0,bottom:500,fromTime:0,toTime:10000,min:90,max:110,timeX:t=>t/10,priceY:p=>(110-p)*25};

describe('depth overlay data projection',()=>{
  it('projects actual observation time and price bins; the live book\'s newest stock lasts through capture, never past it',()=>{
    const data=prepareDepthOverlay(state(),projection),first=data.cells.find(cell=>cell.side==='bid'&&cell.time===1000)!;
    expect(first).toMatchObject({left:100,right:200,top:225,bottom:250,time:1000,through:2000,priceLow:100,priceHigh:101,quantity:2});
    expect(first).toMatchObject({source:'live',eventTime:950,receivedAt:1000,availableAt:1000,revision:1000,segmentId:1});
    const last=data.cells.find(cell=>cell.side==='bid'&&cell.time===3000)!;expect(last.through).toBe(4000);expect(last.right-last.left).toBeCloseTo(100);
    expect(hitDepthCell(data.cells,150,240)).toBe(first);
  });
  it('never carries a depth wall across a segment gap and retains the last actual sample before that gap',()=>{
    const input=state([sample(1000),sample(2000),sample(5000,4,2)]);input.book={...input.book!,capturedAt:6000};
    const data=prepareDepthOverlay(input,projection),previous=data.cells.find(cell=>cell.time===2000)!;
    expect(previous).toBeDefined();expect(previous.through).toBe(2000);expect(data.cells.some(cell=>cell.time<5000&&cell.through>2000)).toBe(false);
  });
  it('uses sum of actual price times size in quote mode and current stock for profile rather than summed snapshots',()=>{
    const input=state();input.settings={...input.settings,unit:'quote'};const data=prepareDepthOverlay(input,projection);
    expect(data.cells.find(cell=>cell.time===1000&&cell.side==='bid')!.quantity).toBeCloseTo(200.4);
    expect(data.profile.find(row=>row.side==='bid')!.quantity).toBeCloseTo(501);
    expect(data.profile.find(row=>row.side==='bid')!.quantity).not.toBeCloseTo((2+4+5)*100.2);
  });
  it('does not draw unavailable depth, future receipts, or current profile from a stale book',()=>{
    const future={...sample(1000),availableAt:5000};const input=state([future]);input.book={...input.book!,status:'stale'};
    expect(prepareDepthOverlay(input,projection)).toMatchObject({cells:[],profile:[],maximum:0});
    const empty=state([]);empty.book={...empty.book!,bids:[],asks:[]};expect(prepareDepthOverlay(empty,projection).cells).toEqual([]);expect(prepareDepthOverlay(empty,projection).profile).toEqual([]);
    const pending=state([sample(1000),{...sample(2000),availableAt:5000}]);
    expect(prepareDepthOverlay(pending,projection).cells.every(cell=>cell.time===1000&&cell.through===1000)).toBe(true);
  });
  it('keeps only the latest stock inside one screen-time column, never adding successive stocks',()=>{
    const data=prepareDepthOverlay(state([sample(1000,2),sample(1001,4)]),projection);
    const bids=data.cells.filter(cell=>cell.side==='bid');expect(bids).toHaveLength(1);expect(bids[0].quantity).toBe(4);expect(bids[0].time).toBe(1001);
  });
  it('retains continuous sampled coverage when minutes of history collapse into one coarse screen column',()=>{
    const end=160*15*60_000,width=1470,history=Array.from({length:300},(_,i)=>sample(end-300_000+i*1000,i+1));
    const input=state(history);input.settings.profile=false;input.book={...input.book!,capturedAt:end};
    const p={...projection,right:width,fromTime:0,toTime:end,timeX:(time:number)=>time/end*width};
    const bids=prepareDepthOverlay(input,p).cells.filter(cell=>cell.side==='bid');expect(bids).toHaveLength(1);
    const cell=bids[0],first=history[0],latest=history.at(-1)!;
    expect(cell.right-cell.left).toBeCloseTo((end-first.time)/end*width,8);
    expect(cell.right-cell.left).toBeGreaterThan(3);expect(cell.right-cell.left).toBeLessThan(width/160);
    expect(cell).toMatchObject({coverageFrom:first.time,through:end,time:latest.time,availableAt:latest.availableAt,revision:latest.revision,quantity:300,aggregation:'latest-stock'});
    expect(cell.quantity).not.toBe(history.reduce((sum,s)=>sum+s.bids[0].quantity,0));
  });
  it('keeps actual temporal holes separate even when their samples share a column and a segment',()=>{
    const input=state([sample(1000,2),sample(2000,3),sample(8000,6),sample(9000,7)]);input.book={...input.book!,capturedAt:10000};
    const p={...projection,toTime:144_000_000,timeX:(time:number)=>time/144_000_000*1000};
    const cells=prepareDepthOverlay(input,p).cells.filter(cell=>cell.side==='bid');
    expect(cells.map(cell=>[cell.coverageFrom,cell.through,cell.time,cell.quantity])).toEqual([[1000,3000,2000,3],[8000,10000,9000,7]]);
    expect(cells.some(cell=>cell.coverageFrom!<8000&&cell.through>3000)).toBe(false);
  });
  it('does not merge different continuity segments inside one coarse pixel column',()=>{
    const input=state([sample(1000,2),sample(2000,3),sample(3000,6,2),sample(4000,7,2)]);input.book={...input.book!,capturedAt:5000};
    const p={...projection,toTime:144_000_000,timeX:(time:number)=>time/144_000_000*1000};
    const cells=prepareDepthOverlay(input,p).cells.filter(cell=>cell.side==='bid');
    expect(cells.map(cell=>[cell.segmentId,cell.coverageFrom,cell.through,cell.quantity])).toEqual([[1,1000,2000,3],[2,3000,5000,7]]);
  });
  it('bounds the live newest stock to five sample intervals and never extends a non-live book',()=>{
    const stalled=state([sample(1000),sample(2000)]);stalled.book={...stalled.book!,capturedAt:60_000};
    expect(Math.max(...prepareDepthOverlay(stalled,projection).cells.map(cell=>cell.through))).toBe(2000+5*1000);
    const paused=state([sample(1000),sample(2000)]);paused.book={...paused.book!,status:'paused',capturedAt:4000};
    expect(Math.max(...prepareDepthOverlay(paused,projection).cells.map(cell=>cell.through))).toBe(2000);
  });
  it('keeps a real instant visible at the right clip edge without extending its time coverage',()=>{
    const input=state([sample(projection.toTime,2)]);input.book={...input.book!,capturedAt:projection.toTime};
    const cell=prepareDepthOverlay(input,projection).cells.find(cell=>cell.side==='bid')!;
    expect(cell).toMatchObject({time:projection.toTime,through:projection.toTime,coverageFrom:projection.toTime,aggregation:'sample',right:projection.right});
    expect(cell.right-cell.left).toBeCloseTo(.65);
  });
  it('clips history to its selected cursor and recorded depth gaps, rejecting samples with future event times',()=>{
    const input=state();input.mode='history';input.settings.profile=false;
    const dataset={id:'recorded'} as DatasetInfo;
    const observed=(time:number)=>({time,book:{status:'available' as const,time:time-10,bids:[{price:100,quantity:2}],asks:[],lastUpdateId:time}});
    input.archive={dataset,from:1000,to:5000,cursor:3500,pending:false,gaps:[{channel:'depth',afterTime:1500,beforeTime:2500,reason:'gap'}],heatmap:{datasetId:'recorded',fromTime:1000,toTime:5000,samples:[observed(1000),observed(2000),observed(3000),observed(4000),{time:3200,book:{...observed(3200).book,time:3600}}],note:'recorded'}};
    const data=prepareDepthOverlay(input,projection);
    expect(data.cells.some(cell=>cell.time===1000&&cell.through===1500)).toBe(true);
    expect(data.cells.some(cell=>cell.time===2000||cell.time===3200||cell.time===4000||cell.through>3500)).toBe(false);
    expect(data.cells.some(cell=>cell.time===3000)).toBe(true);
    expect(data.cells.every(cell=>cell.source==='archive'&&cell.receivedAt===undefined&&cell.availableAt===undefined)).toBe(true);
  });
  it('preserves bounded pixel geometry, stable prepared results and explicit opacity',()=>{
    const input=state(),data=prepareDepthOverlay(input,projection);expect(prepareDepthOverlay(input,{...projection})).toBe(data);
    expect(data.cells.every(cell=>cell.left>=projection.left&&cell.right<=projection.right&&cell.top>=projection.top&&cell.bottom<=projection.bottom)).toBe(true);
    const render={rect:vi.fn()};drawDepthHeatmap(render,data,.2,{bid:'#0f0',ask:'#f00'});expect(render.rect.mock.calls.every(call=>call[5]<=.2)).toBe(true);
    render.rect.mockClear();drawDepthHeatmap(render,data,0,{bid:'#0f0',ask:'#f00'});drawDepthProfile(render,data,projection,0,{bid:'#0f0',ask:'#f00'});expect(render.rect).not.toHaveBeenCalled();
  });
  it('bounds the output and reuses prepared heatmap geometry across unchanged draw frames',()=>{
    const history=Array.from({length:300},(_,i)=>({...sample(1000+i*1000),bids:Array.from({length:100},(_,j)=>({price:100-j*.1,quantity:1+j})),asks:Array.from({length:100},(_,j)=>({price:101+j*.1,quantity:2+j}))}));
    const input=state(history);input.book={...input.book!,capturedAt:301000};input.settings.priceStepTicks=1;input.market={...input.market!,tickSize:.1};
    const p={...projection,toTime:301000,timeX:(time:number)=>time/301,min:85,max:115,priceY:(price:number)=>(115-price)*500/30};
    const first=prepareDepthOverlay(input,p);expect(first.cells.length).toBeLessThanOrEqual(160*240+240);
    for(let i=0;i<40;i++)expect(prepareDepthOverlay(input,{...p})).toBe(first);
  });
});
