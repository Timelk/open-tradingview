import {describe,expect,it} from 'vitest';
import {prepareDepthOverlay,type DepthOverlay,type DepthProjection} from '../src/lib/render/orderbook-overlay';
import {referenceDepthOverlay} from './fixtures/orderbook-overlay-reference';
import {normalizeOrderFlowSettings,type ChartOrderFlowState} from '../src/lib/flow/chart-order-flow';
import type {BookHistorySample,SharedBookSnapshot} from '../src/lib/flow/orderbook-hub';
import type {DatasetInfo} from '../src/lib/flow/persistence-client';

function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function makeState(count=35,levels=60):ChartOrderFlowState {
  const market={source:'binance',marketType:'usdm-perpetual',symbol:'BTCUSDT',tickSize:.1};
  const history:BookHistorySample[]=Array.from({length:count},(_,i)=>({time:1000+i*1003+(i%3)*7,eventTime:950+i*1003,receivedAt:1000+i*1003+(i%3)*7,availableAt:1000+i*1003+(i%3)*7,revision:i+1,segmentId:i<15?1:2,
    bids:Array.from({length:levels},(_,j)=>({price:100.97-j*.031,quantity:.02+(j*7%11)+i*.01})),asks:Array.from({length:levels},(_,j)=>({price:101.07+j*.037,quantity:.01+(j*3%13)+i*.02}))}));
  const book:SharedBookSnapshot={identity:market,key:'book',symbol:market.symbol,supported:true,status:'live',bids:history.at(-1)!.bids,asks:history.at(-1)!.asks,updatedAt:history.at(-1)!.eventTime,lastReceivedAt:history.at(-1)!.receivedAt,lastUpdateId:count,revision:count,segmentId:2,capturedAt:count*1003+2000,history,changes:[],coverage:{fromTime:null,throughTime:history.at(-1)!.eventTime,receivedFromTime:null,receivedThroughTime:history.at(-1)!.receivedAt,segmentId:2,depthPerSide:1000},changeCoverage:{fromTime:null,throughTime:null,truncated:false},historyCoverage:{fromTime:history[0].time,throughTime:history.at(-1)!.time,samples:count,intervalMs:1000,maxSamples:300,levelsPerSide:levels}};
  return {market,settings:normalizeOrderFlowSettings({heatmap:true,profile:true,priceStepTicks:5}),mode:'live',running:true,book,error:'',revision:1};
}
function projection(min=97,max=105,width=960,height=460,toTime=42_000):DepthProjection{return {left:5,right:width,top:7,bottom:height,fromTime:0,toTime,min,max,timeX:time=>5+(width-5)*time/toTime,priceY:price=>7+(height-7)*(max-price)/(max-min)};}
function equivalent(actual:DepthOverlay,reference:DepthOverlay){
  expect(actual.cells.length).toBe(reference.cells.length);expect(actual.profile.length).toBe(reference.profile.length);
  for(const [key,rows,expected] of [['cells',actual.cells,reference.cells],['profile',actual.profile,reference.profile]] as const){
    for(let i=0;i<rows.length;i++){
      const {quantity,...metadata}=rows[i],{quantity:expectedQuantity,...expectedMetadata}=expected[i];
      expect(metadata,`${key} ${i}`).toEqual(expectedMetadata);
      expect(Math.abs(quantity-expectedQuantity),`${key} ${i} quantity`).toBeLessThanOrEqual(Math.max(1,Math.abs(expectedQuantity))*1e-12);
    }
  }
  expect(actual.priceStep).toBe(reference.priceStep);
  expect(Math.abs(actual.maximum-reference.maximum)).toBeLessThanOrEqual(Math.max(1,reference.maximum)*1e-12);
  expect(actual.profileMaximum).toBe(reference.profileMaximum);
}

describe('depth overlay cache equivalence',()=>{
  it('matches the frozen raw-level oracle across sides, units, edge bins, LOD gaps and screen rows',()=>{
    for(const mode of ['live','history'] as const)for(const unit of ['base','quote'] as const)for(const step of [1,5,20])for(const [min,max,width,height] of [[97,105,960,460],[100.49,101.51,400,123],[97,105,140,25]]){
      const input=makeState();input.settings={...input.settings,unit,priceStepTicks:step,threshold:unit==='quote'?500:3};input.mode=mode;
      if(mode==='history')input.archive={dataset:{id:'a'} as DatasetInfo,from:1000,to:37_000,cursor:34_000,pending:false,gaps:[{channel:'depth',afterTime:15_100,beforeTime:16_100,reason:'observed gap'}],heatmap:{datasetId:'a',fromTime:1000,toTime:37_000,note:'recorded',samples:input.book!.history.map(sample=>({time:sample.time,book:{status:'available',time:sample.eventTime,bids:sample.bids,asks:sample.asks,lastUpdateId:sample.revision}}))}};
      freeze(input.book);freeze(input.archive?.heatmap);const p=projection(min,max,width,height,2_400_000);
      equivalent(prepareDepthOverlay(input,p),referenceDepthOverlay(input,p));
    }
  });
  it('reuses the same immutable stock across new trade-only state wrappers',()=>{
    const input=makeState();freeze(input.book);const p=projection(),first=prepareDepthOverlay(input,p);
    expect(prepareDepthOverlay({...input,revision:input.revision+1},p)).toBe(first);
    const changed={...input,settings:{...input.settings,unit:'quote' as const}};expect(prepareDepthOverlay(changed,p)).not.toBe(first);
    equivalent(prepareDepthOverlay(changed,p),referenceDepthOverlay(changed,p));
  });
  it('rebuilds mutable same-array price corrections when the source revision changes',()=>{
    const input=makeState(1),p=projection(),before=prepareDepthOverlay(input,p);input.book!.history[0].bids[0].quantity+=17;input.revision++;
    const after=prepareDepthOverlay(input,p);expect(after).not.toBe(before);expect(after.cells[0].quantity).toBeGreaterThan(before.cells[0].quantity);
    equivalent(after,referenceDepthOverlay({...input},p));
  });
  it('renders a stock profile without reading retained delta batches or coverage',()=>{
    const input=makeState();input.settings.heatmap=false;
    Object.defineProperty(input.book,'changes',{get:()=>{throw Error('profile scanned changes');}});
    Object.defineProperty(input.book,'changeCoverage',{get:()=>{throw Error('profile scanned change coverage');}});
    expect(prepareDepthOverlay(input,projection()).profile.length).toBeGreaterThan(0);
  });
  it('does not revisit 60,000 raw immutable levels during repeated viewport projections',()=>{
    const input=makeState(300,100);input.settings.profile=false;let reads=0;
    for(const sample of input.book!.history)for(const side of ['bids','asks'] as const){
      const original=sample[side];for(const level of original)Object.freeze(level);Object.freeze(original);
      sample[side]=new Proxy(original,{get(target,key,receiver){if(typeof key==='string'&&/^\d+$/.test(key))reads++;return Reflect.get(target,key,receiver);}});
    }
    freeze(input.book);prepareDepthOverlay(input,projection(90,110,960,460,400_000));expect(reads).toBeGreaterThan(30_000);reads=0;
    for(let i=0;i<12;i++){const p=projection(90+i*.03,110+i*.03,960+i,460,400_000);const output=prepareDepthOverlay(input,p);expect(output.cells.length).toBeGreaterThan(500);}
    expect(reads).toBe(0);
    referenceDepthOverlay(input,projection(90,110,960,460,400_000));expect(reads).toBeGreaterThan(30_000);
  });
});
