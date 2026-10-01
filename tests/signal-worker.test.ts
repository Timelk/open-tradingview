import { afterEach, expect, it, vi } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import type { ColumnName } from '../src/lib/core/types';
import type { OutMsg } from '../src/lib/indicators/worker';

afterEach(()=>vi.unstubAllGlobals());

it('transmits confirmed strategy markers and metadata in real worker full/tail messages',async()=>{
  const messages:OutMsg[]=[];
  const transfers:number[][]=[];
  const port={postMessage:(message:OutMsg,transfer:Transferable[]=[])=>{transfers.push(transfer.map(value=>(value as ArrayBuffer).byteLength));messages.push(structuredClone(message,{transfer}));},onmessage:null as ((event:{data:unknown})=>void)|null};
  vi.stubGlobal('self',port);await import('../src/lib/indicators/worker');
  const store=new ColumnStore();
  const bar=(index:number,close:number)=>({time:index*60000,open:close,high:close,low:close,close,volume:1});
  [5,4,3,2,3,5].forEach((close,index)=>store.appendBar(bar(index,close)));
  const columns=Object.fromEntries((['time','open','high','low','close','volume'] as ColumnName[]).map(name=>[name,store.col(name).slice()]));
  port.onmessage!({data:{type:'init',...columns,length:store.length,capacity:store.capacity,reqs:[{id:'strategy-ma-cross',instanceId:'worker:strategy',params:{fast:1,slow:2,method:'SMA'}}]}});
  const full=messages.at(-1)!;expect(full.type).toBe('full');if(full.type!=='full')throw new Error('expected full');
  expect(full.series[0].values[5]).toBe(3);expect(full.series.map(s=>[s.indicatorId,s.plotIndex,s.markerSide,s.plot])).toEqual([['worker:strategy',0,'buy','markers'],['worker:strategy',1,'sell','markers']]);
  expect(full.series[0].markerOffsets).toHaveLength(6);expect(full.series[0].markerOffsets![5]).toBe(-1.5);expect(full.series[0].markerValues![5]).toBe(2.5);expect(transfers[0]).toEqual(Array(6).fill(6*8));
  port.onmessage!({data:{type:'bar',bar:bar(5,-100),isNew:false,length:6,capacity:store.capacity,tick:1}});
  const replacement=messages.at(-1)!;if(replacement.type!=='tail')throw new Error('expected tail');
  expect(replacement.patches[0]).toMatchObject({start:5,plotIndex:0,markerSide:'buy',plot:'markers'});expect(replacement.patches[0].values[0]).toBe(3);
  expect([...replacement.patches[0].markerOffsets!]).toEqual([-1.5]);expect([...replacement.patches[0].markerValues!]).toEqual([2.5]);expect(transfers[1]).toEqual(Array(6).fill(8));
  port.onmessage!({data:{type:'bar',bar:bar(6,100),isNew:true,length:7,capacity:store.capacity,tick:2}});
  const appended=messages.at(-1)!;if(appended.type!=='tail')throw new Error('expected tail');
  expect(appended.patches[1]).toMatchObject({start:6,plotIndex:1,markerSide:'sell',plot:'markers'});expect(appended.patches[1].values[0]).toBe(-100);
  expect(appended.patches[1].markerOffsets![0]).toBeCloseTo(1/104-2,12);expect(appended.patches[1].markerValues![0]).toBeCloseTo(3-103/104,12);expect(transfers[2]).toEqual(Array(6).fill(8));
  expect(full.series[0].values[5]).toBe(3);
  expect(full.series[0].markerOffsets![5]).toBe(-1.5);expect(full.series[0].markerValues![5]).toBe(2.5);
});
