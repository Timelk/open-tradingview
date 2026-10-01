import {describe,expect,it} from 'vitest';
import {OverlayLabelOccupancy,placeOverlayLabel} from '../src/lib/render/overlay-label';

type Box={left:number;right:number;top:number;bottom:number};
describe('dense overlay label collision queries',()=>{
  it('preserves the exact placement and priority of the original rectangle scan',()=>{
    const bounds={left:0,right:640,top:0,bottom:280};
    const original:Box[]=[{left:0,right:220,top:0,bottom:40},{left:560,right:640,top:0,bottom:30}],indexed=original.map(box=>({...box}));
    const occupancy=new OverlayLabelOccupancy(indexed);
    for(let i=0;i<1200;i++){
      const anchor={x:(i*47)%660-10,y:(i*31)%300-10},width=65+(i%4)*13,preferred=i%2?1:-1;
      const expected=placeOverlayLabel(anchor,width,18,bounds,original,preferred);
      const actual=placeOverlayLabel(anchor,width,18,bounds,indexed,preferred,box=>occupancy.collides(box));
      expect(actual).toEqual(expected);
      if(expected)original.push(expected);
      if(actual){indexed.push(actual);occupancy.add(actual);}
    }
    expect(indexed).toEqual(original);
  });
  it('queries local rectangles without repeatedly reading a large distant archive',()=>{
    let reads=0;
    const boxes=Array.from({length:10000},(_,i)=>({get left(){reads++;return 1000+i*80;},right:1050+i*80,top:0,bottom:18}));
    const occupancy=new OverlayLabelOccupancy(boxes);reads=0;
    expect(occupancy.collides({left:1010,right:1020,top:1,bottom:10})).toBe(true);
    expect(occupancy.collides({left:0,right:100,top:40,bottom:58})).toBe(false);
    expect(reads).toBeLessThan(20);
  });
});
