import {expect,it} from 'vitest';
import {volumeValueArea} from '../src/lib/flow/value-area';
import type {FlowPriceLevel} from '../src/lib/flow/types';
const rows:FlowPriceLevel[]=[1,3,8,4,2].map((v,i)=>({tick:i,price:100+i,priceEnd:101+i,buyBase:v,sellBase:0,deltaBase:v,volumeBase:v,buyQuote:v*(100+i),sellQuote:0,deltaQuote:v*(100+i),volumeQuote:v*(100+i),aggregateCount:1}));
it('expands neighboring price buckets around POC until requested observed volume is covered',()=>{
  const result=volumeValueArea([...rows].reverse())!;
  expect(result).toMatchObject({poc:102,low:101,high:104,covered:15,total:18});
  expect(result.fraction).toBeGreaterThanOrEqual(.7);expect(volumeValueArea(rows)).toEqual(result);
});
it('uses the selected unit and does not invent levels for absent volume',()=>{
  expect(volumeValueArea([])).toBeUndefined();
  const adjusted=rows.map((r,i)=>({...r,volumeQuote:i===4?10000:1}));
  expect(volumeValueArea(adjusted,'quote')?.poc).toBe(104);
  expect(volumeValueArea(adjusted,'base')?.poc).toBe(102);
  expect(volumeValueArea(rows,'base',1)?.covered).toBe(18);
});
