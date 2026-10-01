import { afterEach,it,expect,vi } from 'vitest';
import { IndicatorRegistry,registerBuiltins } from '../src/lib/indicators/registry';
import { IndicatorEngine } from '../src/lib/indicators/engine';
import { ColumnStore } from '../src/lib/core/datastore';
class TestWorker {
  static current:TestWorker;
  onmessage:((e:{data:unknown})=>void)|null=null;
  onerror:(()=>void)|null=null;
  constructor(){TestWorker.current=this;}
  postMessage(){} terminate(){}
  send(data:unknown){this.onmessage?.({data});}
}
afterEach(()=>vi.unstubAllGlobals());
it('keeps configuration pending and discards obsolete full results until the latest request arrives',()=>{
  vi.stubGlobal('Worker',TestWorker);const reg=new IndicatorRegistry();registerBuiltins(reg);
  const store=new ColumnStore();store.appendBar({time:0,open:1,high:2,low:0,close:1,volume:1});
  const engine=new IndicatorEngine(reg);engine.init(store,[{id:'ma',params:{period:1}}]);
  engine.setReqs([{id:'ma',params:{period:5}}]);expect(engine.pending).toBe(true);
  TestWorker.current.send({type:'full',tick:0,series:[]});expect(engine.pending).toBe(true);
  TestWorker.current.send({type:'full',tick:1,series:[]});expect(engine.pending).toBe(false);engine.destroy();
});

it('preserves direction and plot identity when worker patches have the same display name',()=>{
  vi.stubGlobal('Worker',TestWorker);const reg=new IndicatorRegistry();registerBuiltins(reg);
  const store=new ColumnStore();store.appendBar({time:0,open:10,high:12,low:9,close:10,volume:1});
  const engine=new IndicatorEngine(reg);engine.init(store,[{id:'strategy-ma-cross',instanceId:'strategy:alpha',params:{fast:1,slow:2,method:'SMA'}}]);
  const series=([0,1] as const).map(plotIndex=>({name:'signal',indicatorId:'strategy:alpha',plotIndex,markerSide:plotIndex===0?'buy':'sell',plot:'markers',pane:'main',color:'#ffffff',values:Float64Array.of(NaN)}));
  TestWorker.current.send({type:'full',tick:0,series});
  TestWorker.current.send({type:'tail',tick:1,length:1,patches:[{...series[1],start:0,values:Float64Array.of(10),color:'#ef5350',timeframe:'5m'}]});
  expect(engine.derived[0].values[0]).toBeNaN();expect(engine.derived[1].values[0]).toBe(10);
  expect(engine.derived[1]).toMatchObject({indicatorId:'strategy:alpha',plotIndex:1,markerSide:'sell',plot:'markers',timeframe:'5m'});
  engine.destroy();
});

it('keeps confirmed strategy markers stable in the main-thread fallback',()=>{
  vi.stubGlobal('Worker',class{constructor(){throw new Error('unavailable');}});
  const reg=new IndicatorRegistry();registerBuiltins(reg);const store=new ColumnStore();
  const bar=(index:number,close:number)=>({time:index*60000,open:close,high:close,low:close,close,volume:1});
  [5,4,3,2,3,5].forEach((close,index)=>store.appendBar(bar(index,close)));
  const engine=new IndicatorEngine(reg);engine.init(store,[{id:'strategy-ma-cross',instanceId:'local:strategy',params:{fast:1,slow:2,method:'SMA'}}]);
  expect(engine.mode).toBe('main');expect(engine.derived[0].values[5]).toBe(3);
  expect(engine.derived[0].markerOffsets![5]).toBe(-1.5);expect(engine.derived[0].markerValues![5]).toBe(2.5);
  store.updateLast(bar(5,-100));engine.pushBar(false);expect(engine.derived[0].values[5]).toBe(3);
  store.appendBar(bar(6,100));engine.pushBar(true);expect(engine.derived[1].values[6]).toBe(-100);
  expect(engine.derived.map(s=>[s.indicatorId,s.markerSide,s.plotIndex])).toEqual([['local:strategy','buy',0],['local:strategy','sell',1]]);
  engine.destroy();
});

it('copies and grows full/tail marker geometry with signals and clears obsolete optional metadata',()=>{
  vi.stubGlobal('Worker',TestWorker);const reg=new IndicatorRegistry();registerBuiltins(reg);const store=new ColumnStore(2),bar=(i:number)=>({time:i*60000,open:10,high:12,low:9,close:10,volume:1});store.appendBar(bar(0));store.appendBar(bar(1));
  const engine=new IndicatorEngine(reg);engine.init(store,[{id:'strategy-ma-cross',instanceId:'geometry',params:{fast:1,slow:2,method:'SMA'}}]);
  const identity={name:'buy',indicatorId:'geometry',plotIndex:0,markerSide:'buy',plot:'markers',pane:'main',color:'#26a69a'},series={...identity,values:Float64Array.of(10,NaN),markerOffsets:Float64Array.of(-1.5,NaN),markerValues:Float64Array.of(9,NaN)};
  TestWorker.current.send({type:'full',tick:0,series:[series]});expect(engine.derived[0].markerOffsets).not.toBe(series.markerOffsets);expect(engine.derived[0].markerValues).not.toBe(series.markerValues);
  store.appendBar(bar(2));engine.pushBar(true);expect(engine.derived[0].markerOffsets!.length).toBe(4);expect(engine.derived[0].markerValues![0]).toBe(9);expect(engine.derived[0].markerOffsets![2]).toBeNaN();
  TestWorker.current.send({type:'tail',tick:1,length:3,patches:[{...identity,start:2,values:Float64Array.of(20),markerOffsets:Float64Array.of(-1.25),markerValues:Float64Array.of(18)}]});expect(engine.derived[0].values[2]).toBe(20);expect(engine.derived[0].markerOffsets![2]).toBe(-1.25);expect(engine.derived[0].markerValues![2]).toBe(18);
  TestWorker.current.send({type:'tail',tick:2,length:3,patches:[{...identity,start:2,values:Float64Array.of(NaN),markerOffsets:Float64Array.of(NaN),markerValues:Float64Array.of(NaN)}]});expect(engine.derived[0].markerOffsets![2]).toBeNaN();expect(engine.derived[0].markerValues![2]).toBeNaN();
  TestWorker.current.send({type:'tail',tick:3,length:3,patches:[{...identity,start:2,values:Float64Array.of(21)}]});expect(engine.derived[0].values[0]).toBe(10);expect(engine.derived[0].values[2]).toBe(21);expect(engine.derived[0].markerOffsets).toBeUndefined();expect(engine.derived[0].markerValues).toBeUndefined();engine.destroy();
});
