import {describe,expect,it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {MAX_PATTERN_HISTORY_BARS,neededPatternBars,prependPatternHistory} from '../src/lib/patterns/history';
import type {IndicatorInstance} from '../src/lib/scene/types';
const step=60_000,reg=new IndicatorRegistry();registerBuiltins(reg);
const instance=(id='pattern-harmonic',timeframe='chart',params={}):IndicatorInstance=>({instanceId:'test',id,timeframe,params,hiddenPlots:[]});
const bar=(i:number,close=101)=>({time:i*step,open:100,high:110,low:90,close,volume:12});

describe('pattern history coverage and atomic prepend',()=>{
  it('budgets the actual study timeframe and both pivot edges, not just 1000 chart candles',()=>{
    expect(neededPatternBars([instance()],reg,'1m')).toBe(1550);
    expect(neededPatternBars([instance('pattern-harmonic','5m')],reg,'1m')).toBe(7750);
    expect(neededPatternBars([instance('pattern-harmonic','chart',{lookback:2000,pivotStrength:5,multiScale:false})],reg,'1m')).toBe(2012);
    expect(neededPatternBars([instance('pattern-harmonic','4h')],reg,'1m')).toBe(MAX_PATTERN_HISTORY_BARS);
  });
  it('takes the maximum shared coverage and ignores ordinary, missing and lower-timeframe studies',()=>{
    expect(neededPatternBars([instance('ma'),instance('uninstalled'),instance('pattern-harmonic','1m')],reg,'5m')).toBe(0);
    expect(neededPatternBars([instance('pattern-harmonic'),instance('pattern-huzi','chart',{lookback:3000})],reg,'1m')).toBe(3050);
    expect(neededPatternBars([instance()],reg,'bad')).toBe(0);
  });
  it('preserves the exact live tail received while historical candles were loading',()=>{
    const store=new ColumnStore(2);store.appendBar(bar(3));store.appendBar(bar(4));
    // These updates happen after the request was sent but before it resolves.
    store.updateLast(bar(4,104));store.appendBar(bar(5,105));
    const shifted=prependPatternHistory(store,[bar(1),bar(2)],'1m');
    expect(shifted).toBe(2);expect(store.length).toBe(5);
    expect([...store.col('time').subarray(0,store.length)]).toEqual([1,2,3,4,5].map(i=>i*step));
    expect([...store.col('close').subarray(0,store.length)]).toEqual([101,101,101,104,105]);
  });
  it('validates the entire history before any mutation and rejects overlapping stale replies',()=>{
    const store=new ColumnStore();store.appendBar(bar(4));const old=Array.from(store.col('time'));
    for(const older of [[bar(1),bar(3)],[bar(3),bar(4)],[bar(2),bar(2)],[{...bar(3),high:1}]]){
      expect(()=>prependPatternHistory(store,older,'1m')).toThrow();expect(store.length).toBe(1);expect(Array.from(store.col('time'))).toEqual(old);
    }
    expect(prependPatternHistory(store,[],'1m')).toBe(0);
  });
});
