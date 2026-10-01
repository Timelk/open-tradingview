import {it,expect} from 'vitest';
import {RangeMotion} from '../src/lib/interaction/range-motion';

it('keeps the zoom anchor fixed while smoothly changing span',()=>{
  const range=new RangeMotion({min:0,max:100});range.set({min:25,max:75},0,100);
  for(const time of [0,16,45,80,100]){const v=range.step(time);expect((v.min+v.max)/2).toBeCloseTo(50);expect(v.max).toBeGreaterThan(v.min);}
  expect(range.active).toBe(false);expect(range.value).toEqual({min:25,max:75});
});
it('retargets from the shown value without restarting from the old origin',()=>{
  const range=new RangeMotion({min:0,max:100});range.set({min:25,max:75},0,100);const shown={...range.step(50)};
  range.set({min:-50,max:150},50,100);expect(range.step(50)).toEqual(shown);expect(range.step(150)).toEqual({min:-50,max:150});
});
it('snaps immediately for reduced motion and direct manipulation',()=>{
  const range=new RangeMotion({min:0,max:1});range.set({min:2,max:4},0,100);range.snap({min:5,max:6});
  expect(range.active).toBe(false);expect(range.step(1000)).toEqual({min:5,max:6});range.set({min:10,max:11},1000,0);expect(range.value).toEqual(range.target);
});
