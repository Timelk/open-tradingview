import {describe,it,expect} from 'vitest';
import {aggregateOrderBook,type AggregatedBookLevel} from '../src/lib/flow/orderbook-models';
import {sharedBook,terminalState} from './fixtures/orderbook-terminal';
import {TradeFlowStore} from '../src/lib/flow/store';
import type {TradeFlowSessionSnapshot} from '../src/lib/flow/types';
import {terminalStatus,buildTerminalLadder,terminalDeltaRows,terminalPriceDigits,formatTerminalAmount} from '../src/lib/flow/terminal-presentation';

function trades():TradeFlowSessionSnapshot {
  const store=new TradeFlowStore({symbol:'BTCUSDT',tickSize:1,timeframeMs:1000,priceStepTicks:1,maxAgeMs:120000,maxTrades:1000});
  store.ingest([
    {symbol:'BTCUSDT',id:'1',time:30000,price:102,baseQuantity:999,quoteQuantity:101898,aggressor:'buy'},
    {symbol:'BTCUSDT',id:'2',time:31000,price:102,baseQuantity:2,quoteQuantity:204,aggressor:'buy'},
    {symbol:'BTCUSDT',id:'3',time:60000,price:103,baseQuantity:3,quoteQuantity:309,aggressor:'sell'},
    {symbol:'BTCUSDT',id:'4',time:61000,price:102,baseQuantity:888,quoteQuantity:90576,aggressor:'buy'},
  ]);
  return {...store.snapshot(),status:'live',message:'',reconnectAttempts:0,bufferDropped:0,updatedAt:60000};
}

describe('order-book terminal truthful presentation',()=>{
  it('takes only the last 30 one-second blocks, excluding older profile volume and future trades',()=>{
    const book=aggregateOrderBook(sharedBook(),{priceStep:5,now:60000}),tape=trades(),result=buildTerminalLadder(book,tape,102.5,5);
    expect(tape.profile.reduce((sum,level)=>sum+level.buyBase,0)).toBe(1889);
    expect(result.rows.find(row=>row.price===105)?.buy).toBe(2);
    expect(result.rows.find(row=>row.price===100)?.sell).toBe(3);
    expect(result.rows.find(row=>row.price===110)?.buy).toBeNull();
    expect(result.tradeFrom).toBe(31000);expect(result.tradeThrough).toBe(60000);expect(result.tradeBasis).toBe('partial');
  });

  it('preserves actual quote amounts instead of multiplying by the displayed bucket price',()=>{
    const book=aggregateOrderBook(sharedBook(),{priceStep:5,now:60000,unit:'quote'}),result=buildTerminalLadder(book,trades(),102.5,5);
    expect(result.rows.find(row=>row.price===105)?.buy).toBe(204);
    expect(result.rows.find(row=>row.price===100)?.sell).toBe(309);
  });

  it('keeps missing or incompatible tape unknown, including historical windows',()=>{
    const book=aggregateOrderBook(sharedBook(),{priceStep:5,now:60000});
    for(const tape of [undefined,{...trades(),effectivePriceStep:2},{...trades(),aggregation:{...trades().aggregation,timeframeMs:5000}}]){
      const result=buildTerminalLadder(book,tape,102.5,5);
      expect(result.rows.every(row=>row.buy===null&&row.sell===null)).toBe(true);
      expect(result.tradeBasis).toBe(tape?'coarse':'unavailable');
    }
    const incompatible=aggregateOrderBook(sharedBook(),{priceStep:2.5,now:60000});
    expect(buildTerminalLadder(incompatible,trades()).tradeBasis).toBe('coarse');
  });

  it('keeps a fixed price grid when the actual best bid and ask move',()=>{
    const a=aggregateOrderBook(sharedBook(),{priceStep:5,now:60000}),moved={...sharedBook(),bids:[{price:110,quantity:3}],asks:[{price:115,quantity:4}]},b=aggregateOrderBook(moved,{priceStep:5,now:60000});
    expect(buildTerminalLadder(a,undefined,105,9).rows.map(row=>row.price)).toEqual(buildTerminalLadder(b,undefined,105,9).rows.map(row=>row.price));
    expect(buildTerminalLadder(a,undefined,105,9).rows).toHaveLength(9);
    expect(buildTerminalLadder(b,undefined,105,9).rows.find(row=>row.atMid)?.price).toBe(115);
  });

  it('retains removed-to-zero levels in Delta without inventing a current resting size',()=>{
    const book=aggregateOrderBook(sharedBook(),{priceStep:5});
    const zero:AggregatedBookLevel={...book.bids[0],quantity:0,quantityBase:0,quantityQuote:0,added:0,subtracted:7};book.deltas.bids=[zero];
    expect(terminalDeltaRows(book,'bids')).toEqual([zero]);
  });

  it('distinguishes every connection phase and never masks historical gaps as a live book',()=>{
    expect(terminalStatus(terminalState({market:undefined,book:undefined})).phase).toBe('initial');
    expect(terminalStatus(terminalState({book:undefined})).phase).toBe('loading');
    expect(terminalStatus(terminalState()).phase).toBe('live');
    expect(terminalStatus(terminalState({book:{...sharedBook(),status:'stale'}}))).toMatchObject({phase:'stale',showBook:false});
    expect(terminalStatus(terminalState({error:'network'}))).toMatchObject({phase:'error',showBook:false});
    expect(terminalStatus(terminalState({market:{source:'okx',symbol:'BTCUSDT',tickSize:1}})).phase).toBe('unsupported');
    expect(terminalStatus(terminalState({running:false})).phase).toBe('paused');
    expect(terminalStatus(terminalState({mode:'history',book:undefined}))).toMatchObject({phase:'history',showBook:false});
  });

  it('formats unknown values distinctly from observed zero and retains sub-cent price precision',()=>{
    expect(formatTerminalAmount(null,'en-US')).toBe('—');expect(formatTerminalAmount(NaN,'en-US')).toBe('—');
    expect(formatTerminalAmount(0,'en-US')).toBe('0');expect(formatTerminalAmount(.000001,'en-US')).not.toBe('0');
    expect(terminalPriceDigits(.25)).toBe(2);expect(terminalPriceDigits(.0001)).toBe(4);expect(terminalPriceDigits(5)).toBe(0);
  });
});
