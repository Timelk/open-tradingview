import { afterEach, expect, it, vi } from 'vitest';
import { ChartController } from '../src/lib/chart/controller';
import { ColumnStore } from '../src/lib/core/datastore';
import { IndicatorEngine } from '../src/lib/indicators/engine';
import { IndicatorRegistry, registerBuiltins } from '../src/lib/indicators/registry';
import type { DerivedSeries } from '../src/lib/core/types';

class DeferredWorker {
  static current: DeferredWorker;
  onmessage: ((event:{data:unknown})=>void)|null=null;
  onerror: (()=>void)|null=null;
  constructor(){DeferredWorker.current=this;}
  postMessage(){} terminate(){}
  send(data:unknown){this.onmessage?.({data});}
}
afterEach(()=>vi.unstubAllGlobals());

function setup(){
  vi.stubGlobal('Worker',DeferredWorker);const registry=new IndicatorRegistry();registerBuiltins(registry);
  const store=new ColumnStore(16),engine=new IndicatorEngine(registry);
  const append=()=>{const time=store.length*60000;store.appendBar({time,open:10,high:11,low:9,close:10,volume:1});};
  for(let i=0;i<5;i++)append();
  const controller=Object.assign(Object.create(ChartController.prototype),{engine,store,studyMarkers:new Map()});
  const updates: {from:number;length:number}[]=[];
  engine.onUpdate=range=>{updates.push(range);controller.indexStudyMarkers(range);};
  engine.init(store,[{id:'strategy-ma-cross',instanceId:'strategy:burst',params:{fast:1,slow:2,method:'SMA'}}]);
  const series:DerivedSeries={name:'买入',indicatorId:'strategy:burst',plotIndex:0,markerSide:'buy',plot:'markers',pane:'main',color:'#26a69a',values:Float64Array.of(NaN,10,NaN,NaN,NaN)};
  const cache=()=>controller.studyMarkers.get('strategy:burst:0');
  return {engine,store,controller,updates,append,series,cache,worker:DeferredWorker.current};
}

it('indexes every delayed worker patch when the feed has already appended many bars',()=>{
  const h=setup();for(let i=5;i<12;i++){h.append();h.engine.pushBar(true);}
  h.worker.send({type:'full',tick:0,series:[h.series]});
  expect(h.updates.at(-1)).toEqual({from:0,length:5});expect(h.cache().length).toBe(5);
  for(let i=5;i<12;i++){
    h.worker.send({type:'tail',tick:i-4,length:i+1,patches:[{...h.series,start:i,values:Float64Array.of(10+i)}]});
    expect(h.cache().indices).toEqual([1,...Array.from({length:i-4},(_,k)=>k+5)]);
    expect(h.cache().length).toBe(i+1);
  }
  expect(h.controller.sliceMarkers(h.cache().indices,6,11,100)).toEqual([6,7,8,9,10]);
  h.engine.destroy();
});

it('removes replaced tail signals and invalidates all indices after a full recalculation',()=>{
  const h=setup();h.worker.send({type:'full',tick:0,series:[h.series]});h.append();h.engine.pushBar(true);
  h.worker.send({type:'tail',tick:1,length:6,patches:[{...h.series,start:5,values:Float64Array.of(20)}]});
  expect(h.cache().indices).toEqual([1,5]);
  h.worker.send({type:'tail',tick:2,length:6,patches:[{...h.series,start:5,values:Float64Array.of(NaN)}]});
  expect(h.cache().indices).toEqual([1]);
  const previous=h.cache().values;
  h.worker.send({type:'full',tick:3,series:[{...h.series,values:Float64Array.of(NaN,NaN,30,NaN,NaN,NaN)}]});
  expect(h.cache().values).not.toBe(previous);expect(h.cache().indices).toEqual([2]);
  h.worker.send({type:'full',tick:4,series:[]});expect(h.controller.studyMarkers.size).toBe(0);
  h.engine.destroy();
});

it('rebuilds after buffer growth and handles authoritative historical patches on reused buffers',()=>{
  const h=setup();h.worker.send({type:'full',tick:0,series:[h.series]});
  h.engine.derived[0].values=h.engine.derived[0].values.slice(0,5);
  for(let i=5;i<9;i++)h.append();
  h.worker.send({type:'tail',tick:1,length:9,patches:[{...h.series,start:5,values:Float64Array.of(50,NaN,70,NaN)}]});
  expect(h.cache().indices).toEqual([1,5,7]);
  h.worker.send({type:'tail',tick:2,length:9,patches:[{...h.series,start:1,values:Float64Array.of(NaN,20,NaN,NaN,50,NaN,70,NaN)}]});
  expect(h.cache().indices).toEqual([2,5,7]);
  h.engine.destroy();
});
