import {describe,expect,it} from 'vitest';
import {depthPriceBins,visibleDepthPriceBins} from '../src/lib/render/depth-price-bins';
import type {BookLevel} from '../src/lib/flow/orderbook';

const freeze=(levels:BookLevel[])=>Object.freeze(levels.map(level=>Object.freeze(level)));
describe('immutable depth price bins',()=>{
  it('floors bids, ceils asks and preserves original price times size',()=>{
    const levels=freeze([{price:100.2,quantity:2},{price:100.8,quantity:3}]);
    expect(depthPriceBins(levels,1,'bid','quote')).toMatchObject([{price:100,quantity:100.2*2+100.8*3}]);
    expect(depthPriceBins(levels,1,'ask','base')).toMatchObject([{price:101,quantity:5}]);
  });
  it('clips source contributions at viewport edges instead of including an entire bin',()=>{
    const bins=depthPriceBins(freeze([{price:100.2,quantity:2},{price:101.2,quantity:3},{price:100.8,quantity:4}]),1,'bid','quote');
    const rows=visibleDepthPriceBins(bins,100.5,101.5);
    expect(rows.map(row=>[row.bin.price,row.quantity,row.firstSourceIndex])).toEqual([[101,303.6,1],[100,403.2,2]]);
  });
  it('reuses immutable input and bounds configurations to four entries',()=>{
    const levels=freeze([{price:100,quantity:2}]),first=depthPriceBins(levels,1,'bid','base');
    expect(depthPriceBins(levels,1,'bid','base')).toBe(first);
    for(const step of [2,3,4,5])depthPriceBins(levels,step,'bid','base');
    expect(depthPriceBins(levels,1,'bid','base')).not.toBe(first);
  });
  it('does not reuse ordinary arrays or a frozen array with mutable children',()=>{
    for(const levels of [[{price:100,quantity:2}],Object.freeze([{price:100,quantity:2}])]){
      const first=depthPriceBins(levels,1,'bid','base');levels[0].quantity=7;
      expect(depthPriceBins(levels,1,'bid','base')).not.toBe(first);
      expect(depthPriceBins(levels,1,'bid','base')[0].quantity).toBe(7);
    }
  });
});
