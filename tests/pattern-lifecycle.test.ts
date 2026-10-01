import {describe,expect,it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import {resolvePatternLifecycle} from '../src/lib/patterns/lifecycle';
import {selectPatterns} from '../src/lib/patterns/selection';
import type {PatternMatch} from '../src/lib/patterns/types';
import marketJson from './fixtures/pattern-lifecycle-market.json?raw';

const step=60_000;
type Candle=number|[number,number,number,number];
function candles(values:Candle[]):ColumnStore {
  const store=new ColumnStore(32);
  values.forEach((value,index)=>{
    const [open,high,low,close]=typeof value==='number'?[value,value,value,value]:value;
    store.appendBar({time:index*step,open,high,low,close,volume:1});
  });
  return store;
}
const pattern=(extra:Partial<PatternMatch>={}):PatternMatch=>({id:'shape',family:'huzi-double',name:'W 双底',direction:'bullish',
  points:[{label:'A',time:0,value:90},{label:'B',time:step,value:100},{label:'C',time:2*step,value:91}],
  confirmedAt:2*step,zone:{low:99,high:101},invalidation:90,targets:[110],ratios:[],description:'结构高度参考',status:'confirmed',...extra});

describe('independent geometric reference-touch measurement',()=>{
  it('retains an earlier touch and every subsequent invalidation, event and warning without changing structural state',()=>{
    const cols=candles([100,100,102,[104,112,103,111],95,88,89]);
    const original=pattern({status:'invalidated',invalidatedAt:6*step,stage:'invalidated',dataWarning:'后续缺口',events:[
      {kind:'breakout',time:step,knownAt:2*step,value:102,boundary:100},
      {kind:'retest',time:2*step,knownAt:3*step,value:102,boundary:100},
      {kind:'failed-breakout',time:4*step,knownAt:5*step,value:95,boundary:100},
      {kind:'invalidation',time:5*step,knownAt:6*step,value:88,boundary:90},
    ]});
    const before=JSON.stringify(original),result=resolvePatternLifecycle(original,cols);
    expect(result).not.toBe(original);
    expect(result.resolution).toEqual({kind:'target-reached',time:3*step,knownAt:4*step,price:110,targetIndex:0});
    expect(result.status).toBe('invalidated');expect(result.stage).toBe('invalidated');
    expect(result.invalidatedAt).toBe(6*step);expect(result.dataWarning).toBe('后续缺口');
    expect(result.events).toBe(original.events);
    const {resolution,...unchanged}=result;expect(unchanged).toEqual(original);
    expect(selectPatterns([result],{})).toEqual([]);
    expect(selectPatterns([result],{historyDisplay:'all'})).toEqual([result]);
    expect(result.points).toBe(original.points);expect(result.zone).toBe(original.zone);
    expect(result.confirmedAt).toBe(original.confirmedAt);expect(result.invalidation).toBe(original.invalidation);
    expect(result.description).toBe(original.description);
    expect(JSON.stringify(original)).toBe(before);
    expect(resolvePatternLifecycle(result,cols)).toBe(result);
  });

  it('records the configured final harmonic reference independently of the earlier T1 touch',()=>{
    const match=pattern({family:'AB=CD',targets:[106,110]});
    expect(resolvePatternLifecycle(match,candles([100,100,102,107,105]))).toBe(match);
    const full=candles([100,100,102,107,111,105]);
    expect(resolvePatternLifecycle(match,full).resolution).toMatchObject({time:4*step,price:110,targetIndex:1});
  });

  it('leaves every guide endpoint intact when an auxiliary reference is touched',()=>{
    const match=pattern({guides:[
      {role:'upper',points:[{label:'上沿',time:0,value:100},{label:'上沿',time:6*step,value:112}]},
      {role:'lower',points:[{label:'下沿',time:0,value:95},{label:'下沿',time:step,value:97}]},
      {role:'pole',points:[{label:'旗杆',time:0,value:90},{label:'旗杆',time:step,value:105}]},
    ]});
    const original=JSON.stringify(match),guides=match.guides!,upperEnd=guides[0].points[1];
    const result=resolvePatternLifecycle(match,candles([100,100,102,112,100]));
    expect(result.resolution?.time).toBe(3*step);
    expect(result.guides).toBe(guides);
    expect(result.guides?.[0].points).toEqual([{label:'上沿',time:0,value:100},{label:'上沿',time:6*step,value:112}]);
    expect(result.guides?.[0]).toBe(guides[0]);
    expect(result.guides?.[0].points[0]).toBe(guides[0].points[0]);
    expect(result.guides?.[0].points[1]).toBe(upperEnd);
    expect(result.guides?.[1]).toBe(guides[1]);
    expect(result.guides?.[2]).toBe(guides[2]);
    expect(result.points).toBe(match.points);expect(result.zone).toBe(match.zone);expect(result.invalidation).toBe(match.invalidation);
    expect(match.guides).toBe(guides);expect(match.guides?.[0].points[1]).toBe(upperEnd);
    expect(JSON.stringify(match)).toBe(original);
  });

  it.each([
    ['earlier risk', [100,100,88,112,100]],
    ['same-bar risk and target', [100,100,102,[105,112,88,106],100]],
    ['exact risk touch on the target bar', [100,100,102,[105,112,90,106],100]],
    ['risk wick before a later target', [100,100,[100,104,89,102],112,100]],
  ] as [string,Candle[]][])('does not infer a reference touch after %s',(_label,bars)=>{
    const match=pattern();expect(resolvePatternLifecycle(match,candles(bars))).toBe(match);
  });

  it('honors already recorded failed-breakout or invalidation before and on the target candle',()=>{
    const cols=candles([100,100,102,112,100]);
    for(const time of [2*step,3*step]){
      const match=pattern({events:[{kind:'failed-breakout',time,knownAt:time+step,value:99,boundary:100}]});
      expect(resolvePatternLifecycle(match,cols)).toBe(match);
    }
    const invalid=pattern({status:'invalidated',invalidatedAt:4*step});
    expect(resolvePatternLifecycle(invalid,cols)).toBe(invalid);
  });

  it('does not reinterpret a target already exceeded at confirmation as a new result',()=>{
    const match=pattern();
    expect(resolvePatternLifecycle(match,candles([100,100,111,105,112,100]))).toBe(match);
  });

  it('ignores the forming tail but consumes an explicit exchange-close confirmation',()=>{
    const match=pattern(),cols=candles([100,100,102,112]);
    expect(resolvePatternLifecycle(match,cols)).toBe(match);
    expect(resolvePatternLifecycle(match,{length:cols.length,closedLength:cols.length,col:name=>cols.col(name)}).resolution)
      .toMatchObject({time:3*step,knownAt:4*step});
    cols.appendBar({time:4*step,open:NaN,high:NaN,low:NaN,close:NaN,volume:NaN});
    expect(resolvePatternLifecycle(match,cols).resolution).toMatchObject({time:3*step,knownAt:4*step});
  });

  it('handles bearish targets symmetrically',()=>{
    const match=pattern({direction:'bearish',invalidation:110,targets:[90]});
    expect(resolvePatternLifecycle(match,candles([100,100,98,88,105])).resolution).toMatchObject({time:3*step,price:90});
    expect(resolvePatternLifecycle(match,candles([100,100,98,[95,112,88,90],100]))).toBe(match);
    expect(resolvePatternLifecycle(match,candles([100,100,89,88,100]))).toBe(match);
  });

  it('does not search through missing, out-of-order or malformed evidence',()=>{
    const match=pattern();
    const nan=candles([100,100,NaN,112,100]);
    expect(resolvePatternLifecycle(match,nan)).toBe(match);
    const gap=candles([100,100,102,112,100]);gap.col('time')[3]=3.5*step;
    expect(resolvePatternLifecycle(match,gap)).toBe(match);
    const clipped=candles([100,100,102,112,100]);
    expect(resolvePatternLifecycle(match,{length:2,col:name=>clipped.col(name).subarray(3,5)})).toBe(match);
  });

  it('treats consecutive calendar months as valid closed evidence',()=>{
    const cols=candles([100,100,102,112,100]);
    for(let i=0;i<cols.length;i++)cols.col('time')[i]=Date.UTC(2026,i,1);
    const match=pattern({confirmedAt:Date.UTC(2026,2,1)});
    expect(resolvePatternLifecycle(match,cols).resolution).toMatchObject({time:Date.UTC(2026,3,1),knownAt:Date.UTC(2026,4,1)});
  });
});

describe('actual Binance touches coexist with later structural failure',()=>{
  const cases=JSON.parse(marketJson) as {algorithm:string;symbol:string;frame:string;match:PatternMatch;barRows:number[][];expectedKnownAt:number}[];
  it.each(cases)('records the $algorithm touch on $symbol $frame without erasing later failure',({match,barRows,expectedKnownAt})=>{
    const cols=new ColumnStore(barRows.length);
    for(const [time,open,high,low,close,volume] of barRows)cols.appendBar({time,open,high,low,close,volume});
    expect(match.status).toBe('invalidated');
    const result=resolvePatternLifecycle(match,cols);
    expect(result.resolution?.knownAt).toBe(expectedKnownAt);
    expect(result.resolution?.price).toBe(match.targets.at(-1));
    expect(match.invalidatedAt!).toBeGreaterThan(expectedKnownAt);
    expect(result.status).toBe('invalidated');expect(result.invalidatedAt).toBe(match.invalidatedAt);
    expect(result.stage).toBe(match.stage);expect(result.events).toBe(match.events);
    expect(selectPatterns([result],{})).toEqual([]);
    const before={length:cols.length-1,col:(name:Parameters<typeof cols.col>[0])=>cols.col(name)};
    expect(resolvePatternLifecycle(match,before)).toBe(match);
  });
});
