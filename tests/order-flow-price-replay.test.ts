import {describe,expect,it} from 'vitest';
import {closedPricePrefix} from '../src/lib/flow/price-replay';
import type {DatasetSnapshot} from '../src/lib/history/types';
const dataset:DatasetSnapshot={source:'binance',symbol:'BTCUSDT',interval:'1m',marketType:'usdm-perpetual',bars:Array.from({length:5},(_,i)=>({time:i*60000,open:100,high:110+i,low:90,close:101+i,volume:1}))};
describe('depth cursor and closed price knowledge',()=>{
  it('never displays a candle eventual OHLC before its close',()=>{
    expect(closedPricePrefix(dataset,59999).bars).toHaveLength(0);
    expect(closedPricePrefix(dataset,60000).bars).toHaveLength(1);
    expect(closedPricePrefix(dataset,150000).bars).toEqual(dataset.bars.slice(0,2));
    expect(dataset.bars).toHaveLength(5);
  });
  it('can rewind and move forward against one immutable fetched archive',()=>{
    expect(closedPricePrefix(dataset,300000).bars).toHaveLength(5);
    expect(closedPricePrefix(dataset,120000).bars).toHaveLength(2);
    expect(closedPricePrefix(dataset,240000).bars).toHaveLength(4);
    expect(()=>closedPricePrefix(dataset,NaN)).toThrow();
  });
});
