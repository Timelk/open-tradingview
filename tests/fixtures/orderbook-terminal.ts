import type {SharedBookSnapshot} from '../../src/lib/flow/orderbook-hub';
import type {ChartOrderFlowState} from '../../src/lib/flow/chart-order-flow';

export function sharedBook():SharedBookSnapshot {
  return {symbol:'BTCUSDT',identity:{source:'binance',marketType:'usdm-perpetual',symbol:'BTCUSDT'},key:'book',supported:true,status:'live',
    bids:[{price:100,quantity:10}],asks:[{price:105,quantity:20}],updatedAt:60000,lastReceivedAt:60000,lastUpdateId:20,revision:1,segmentId:1,capturedAt:60000,
    history:[],changes:[],historyCoverage:{fromTime:null,throughTime:null,samples:0,intervalMs:1000,maxSamples:300,levelsPerSide:100},
    coverage:{fromTime:0,throughTime:60000,receivedFromTime:0,receivedThroughTime:60000,segmentId:1,depthPerSide:1000},changeCoverage:{fromTime:0,throughTime:60000,truncated:false}};
}
export function terminalState(patch:Partial<ChartOrderFlowState>={}):ChartOrderFlowState {
  return {market:{source:'binance',marketType:'usdm-perpetual',symbol:'BTCUSDT',tickSize:1},mode:'live',running:true,error:'',revision:1,book:sharedBook(),
    settings:{heatmap:false,profile:false,view:'book',unit:'base',priceStepTicks:5,threshold:0,opacity:.5,windowMs:5000},...patch};
}
