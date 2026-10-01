import {describe,expect,it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import {AgentInputError,formatTime,parseTime,resolveAnchor,resolveRange} from '../src/lib/agent/anchors';
import {aggregateBars,bucketSize,sampleSeries} from '../src/lib/agent/sampling';
import {pickActiveChart,type ChartSessionInfo} from '../src/lib/agent/protocol';

const MINUTE=60_000,T0=Date.UTC(2026,8,30,0,0);
function bars(count:number){
  const store=new ColumnStore(count);
  for(let i=0;i<count;i++)store.appendBar({time:T0+i*MINUTE,open:100+i,high:102+i,low:99+i,close:101+i,volume:10+i});
  return store;
}
const space=(n=50)=>({cols:bars(n),intervalMs:MINUTE});

describe('agent time parsing',()=>{
  it('accepts epoch ms, epoch seconds, offset ISO and local wall-clock strings',()=>{
    expect(parseTime(T0)).toBe(T0);
    expect(parseTime(T0/1000)).toBe(T0);
    expect(parseTime('2026-09-30T00:00:00Z')).toBe(T0);
    expect(parseTime('2026-09-30T08:00:00+08:00')).toBe(T0);
    expect(parseTime('2026-09-30 10:15')).toBe(new Date(2026,8,30,10,15).getTime());
    expect(parseTime('2026-09-30')).toBe(new Date(2026,8,30).getTime());
    expect(()=>parseTime('yesterday')).toThrow(AgentInputError);
    expect(()=>parseTime(Number.NaN)).toThrow(AgentInputError);
  });
  it('formats with the local UTC offset so the output round-trips exactly',()=>{
    const text=formatTime(T0+1234) as string;
    expect(text).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.234[+-]\d\d:\d\d$/);
    expect(parseTime(text)).toBe(T0+1234);
    expect(formatTime(T0,'ms')).toBe(T0);
    expect(formatTime(Number.NaN)).toBeNull();
  });
});

describe('agent anchors',()=>{
  it('resolves time, bar, barsAgo and offsets against loaded bars',()=>{
    const s=space();
    expect(resolveAnchor(s,{time:T0+5*MINUTE,value:1})).toEqual({time:T0+5*MINUTE,value:1});
    expect(resolveAnchor(s,{time:T0+5*MINUTE+30_000,value:1}).time).toBe(T0+5*MINUTE+30_000);
    expect(resolveAnchor(s,{bar:-1,value:2}).time).toBe(T0+49*MINUTE);
    expect(resolveAnchor(s,{barsAgo:3,value:2}).time).toBe(T0+46*MINUTE);
    expect(resolveAnchor(s,{barsAgo:0,offset:10,value:2}).time).toBe(T0+59*MINUTE);
    expect(resolveAnchor(s,[T0+2*MINUTE,7])).toEqual({time:T0+2*MINUTE,value:7});
  });
  it('snaps price fields to the bar and its open time',()=>{
    const s=space();
    expect(resolveAnchor(s,{barsAgo:0,price:'high'})).toEqual({time:T0+49*MINUTE,value:151});
    expect(resolveAnchor(s,{time:T0+10*MINUTE+20_000,price:'low'})).toEqual({time:T0+10*MINUTE,value:109});
    expect(resolveAnchor(s,{bar:2,price:'hlc3'}).value).toBeCloseTo((104+101+103)/3);
  });
  it('rejects ambiguous or incomplete anchors with actionable messages',()=>{
    const s=space();
    expect(()=>resolveAnchor(s,{time:T0,bar:1,value:1})).toThrow(/exactly one of time, bar or barsAgo/);
    expect(()=>resolveAnchor(s,{time:T0})).toThrow(/needs value/);
    expect(()=>resolveAnchor(s,{barsAgo:0,offset:5,price:'close'})).toThrow(/outside the loaded data/);
    expect(()=>resolveAnchor(s,{time:T0,price:'mid'})).toThrow(/price must be one of/);
    expect(()=>resolveAnchor({cols:new ColumnStore(),intervalMs:MINUTE},{time:T0,value:1})).toThrow(/no loaded bars/);
  });
});

describe('agent ranges and sampling',()=>{
  const context={...space(),visible:{from:10.4,to:19.6}};
  it('resolves presets, last-N, time and bar ranges to whole loaded bars',()=>{
    expect(resolveRange(context,undefined)).toEqual({start:10,end:21});
    expect(resolveRange(context,'all')).toEqual({start:0,end:50});
    expect(resolveRange(context,{last:5})).toEqual({start:45,end:50});
    expect(resolveRange(context,{from:T0+2*MINUTE+1,to:T0+6*MINUTE})).toEqual({start:3,end:7});
    expect(resolveRange(context,{fromBar:-3})).toEqual({start:47,end:50});
    expect(resolveRange(context,{last:500})).toEqual({start:0,end:50});
    expect(()=>resolveRange(context,'selection')).toThrow(/nothing with a time span/);
    expect(resolveRange({...context,selection:{from:T0+4*MINUTE,to:T0+8*MINUTE}},'selection')).toEqual({start:4,end:9});
  });
  it('aggregates OHLCV buckets and samples series at bucket ends',()=>{
    const cols=bars(10),range={start:0,end:10},size=bucketSize(range,4);
    expect(size).toBe(3);
    const rows=aggregateBars(cols,range,size,['time','open','high','low','close','volume'],'ms');
    expect(rows).toEqual([[T0,100,104,99,103,33],[T0+3*MINUTE,103,107,102,106,42],[T0+6*MINUTE,106,110,105,109,51],[T0+9*MINUTE,109,111,108,110,19]]);
    const values=new Float64Array([1,2,NaN,4,5,NaN,NaN,NaN,NaN,10]);
    expect(sampleSeries(values,0,range,size)).toEqual([2,5,null,10]);
    expect(sampleSeries(new Float64Array([7,8]),8,range,size)).toEqual([null,null,7,8]);
  });
});

describe('active chart choice',()=>{
  const chart=(chartId:string,patch:Partial<ChartSessionInfo>):ChartSessionInfo=>({chartId,title:chartId,url:'',source:'mock',symbol:'BTCUSDT',interval:'1m',loading:false,focused:false,visible:false,lastActiveAt:0,writable:true,...patch});
  it('prefers the visible, then focused page, then the latest interaction',()=>{
    expect(pickActiveChart([chart('a',{visible:true,lastActiveAt:1}),chart('b',{visible:true,focused:true,lastActiveAt:0})])?.chartId).toBe('b');
    expect(pickActiveChart([chart('a',{visible:true,lastActiveAt:1}),chart('b',{lastActiveAt:9})])?.chartId).toBe('a');
    expect(pickActiveChart([chart('a',{visible:true,lastActiveAt:1}),chart('b',{visible:true,lastActiveAt:5})])?.chartId).toBe('b');
    expect(pickActiveChart([])).toBeUndefined();
  });
});
