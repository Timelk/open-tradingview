import {describe,it,expect} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import {confirmedPivotEvents,appendPivot} from '../src/lib/patterns/pivots';
import {hitPattern} from '../src/lib/render/patterns';
import type {PatternMatch} from '../src/lib/patterns/types';

const storeOf=(prices:number[])=>{const store=new ColumnStore();prices.forEach((price,i)=>store.appendBar({time:i*60000,open:price,high:price+.1,low:price-.1,close:price,volume:1}));return store;};
describe('causal pattern pivots',()=>{
  it('waits for the right-hand candle to close, and never confirms from a forming high',()=>{
    const store=storeOf([2,4,3]);expect(confirmedPivotEvents(store,1)).toEqual([]);
    store.appendBar({time:180000,open:2,high:100,low:0,close:2,volume:1});
    expect(confirmedPivotEvents(store,1)).toEqual([{index:1,time:60000,value:4.1,kind:'high',confirmedAt:180000}]);
    store.col('high')[3]=1000;expect(confirmedPivotEvents(store,1)[0].confirmedAt).toBe(180000);
  });
  it('keeps confirmation event history when the current zigzag extreme changes',()=>{
    const point={index:1,time:60000,value:4,kind:'high' as const,confirmedAt:180000};
    const stack=[point];const captured=[...stack];
    appendPivot(stack,{...point,index:3,time:180000,value:5,confirmedAt:300000});
    expect(stack[0].value).toBe(5);expect(captured[0]).toEqual(point);
  });
  it('resolves a plateau to its last high and keeps scan work bounded',()=>{
    const store=storeOf([1,3,3,2,1]);
    expect(confirmedPivotEvents(store,1).filter(p=>p.kind==='high').map(p=>p.index)).toEqual([2]);
    const large=storeOf(Array.from({length:1000},(_,i)=>Math.sin(i)));
    expect(confirmedPivotEvents(large,2,100).every(p=>p.index>=899)).toBe(true);
  });
});
it('selects actual pattern edges and labels without capturing the polygon interior',()=>{
  const pattern={id:'x'} as PatternMatch;
  const hit={instanceId:'study',pattern,bounds:{left:45,right:70,top:50,bottom:72},segments:[[{x:0,y:0},{x:100,y:100}]] as [{x:number;y:number},{x:number;y:number}][]};
  expect(hitPattern([hit],{x:52,y:50})).toBe(hit);
  expect(hitPattern([hit],{x:80,y:82})).toBe(hit);
  expect(hitPattern([hit],{x:70,y:20})).toBeUndefined();
  expect(hitPattern([{...hit,clipBounds:{left:0,right:100,top:0,bottom:70}}],{x:80,y:82})).toBeUndefined();
});
