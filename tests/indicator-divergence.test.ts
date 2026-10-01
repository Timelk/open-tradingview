import {describe,expect,it} from 'vitest';
import type {ColumnName,ColumnView} from '../src/lib/core/types';
import {detectOscillatorDivergences,OscillatorDivergenceCalculator,type OscillatorDivergenceMetadata} from '../src/lib/indicators/divergence';

const step=60_000,metadata:OscillatorDivergenceMetadata={indicator:'rsi',seriesName:'RSI(7)',plotIndex:0};
function fixture(length=42){
  const columns=Object.fromEntries((['time','open','high','low','close','volume'] as ColumnName[]).map(name=>[name,
    Float64Array.from({length},(_,i)=>name==='time'?i*step:name==='high'?101:name==='low'?99:name==='volume'?0:100)])) as Record<ColumnName,Float64Array>;
  const cols:ColumnView={length,intervalMs:step,col:name=>columns[name]},values=new Float64Array(length).fill(50);
  return {cols,columns,values};
}
function bullish(){
  const f=fixture();f.columns.low[10]=90;f.columns.low[20]=85;f.values[10]=30;f.values[20]=40;return f;
}
const prefix=(cols:ColumnView,length:number,closedLength?:number):ColumnView=>({...cols,length,...(closedLength===undefined?{}:{closedLength})});

describe('independent confirmed oscillator divergence',()=>{
  it('detects lower-price-low / higher-oscillator-low using only the supplied line, with no pattern or volume prerequisites',()=>{
    const {cols,values}=bullish(),[signal]=detectOscillatorDivergences(cols,values,metadata);
    expect(signal).toMatchObject({direction:'bullish',indicator:'rsi',seriesName:'RSI(7)',plotIndex:0,confirmedAt:24*step,
      points:[{time:10*step,value:30,price:90},{time:20*step,value:40,price:85}]});
    expect(signal.ruleVersion).toContain('regular');expect(structuredClone(signal)).toEqual(signal);
  });

  it('detects bearish higher highs on an arbitrary custom-parameter indicator line',()=>{
    const {cols,columns,values}=fixture();columns.high[10]=110;columns.high[20]=120;values[10]=1200;values[20]=-200;
    const signals=detectOscillatorDivergences(cols,values,{indicator:'custom-oscillator',seriesName:'Momentum(37)',plotIndex:7});
    expect(signals).toHaveLength(1);expect(signals[0]).toMatchObject({direction:'bearish',indicator:'custom-oscillator',seriesName:'Momentum(37)',plotIndex:7,
      points:[{time:10*step,value:1200,price:110},{time:20*step,value:-200,price:120}]});
  });

  it('waits for every right-side candle to close and honors explicit exchange closure',()=>{
    const {cols,values}=bullish();
    expect(detectOscillatorDivergences(prefix(cols,24),values,metadata)).toEqual([]);
    expect(detectOscillatorDivergences(prefix(cols,24,24),values,metadata)).toHaveLength(1);
    expect(detectOscillatorDivergences(prefix(cols,25),values,metadata)).toHaveLength(1);
    expect(detectOscillatorDivergences({...cols,closedLength:23},values,metadata)).toEqual([]);
  });

  it('allows the requested pivot strength to change confirmation timing without changing an indicator period',()=>{
    const {cols,values}=bullish();
    expect(detectOscillatorDivergences(cols,values,metadata,{divergenceStrength:1})[0].confirmedAt).toBe(22*step);
    expect(detectOscillatorDivergences(cols,values,metadata,{divergenceStrength:5})[0].confirmedAt).toBe(26*step);
    expect(detectOscillatorDivergences(cols,values,metadata,{divergenceStrength:NaN})[0].confirmedAt).toBe(24*step);
  });

  it('uses the immediately preceding same-side pivot, including intervening higher lows',()=>{
    const {cols,columns,values}=bullish();columns.low[20]=95;columns.low[30]=85;values[10]=10;values[20]=50;values[30]=30;
    expect(detectOscillatorDivergences(cols,values,metadata)).toEqual([]);
    values[30]=60;
    const [signal]=detectOscillatorDivergences(cols,values,metadata);
    expect(signal.points.map(point=>point.time)).toEqual([20*step,30*step]);
  });

  it('emits each successive divergence pair once with a stable metadata/side/time identity',()=>{
    const {cols,columns,values}=bullish();columns.low[30]=80;values[30]=45;
    const signals=detectOscillatorDivergences(cols,values,metadata);
    expect(signals.map(signal=>signal.points.map(point=>point.time))).toEqual([[10*step,20*step],[20*step,30*step]]);
    expect(new Set(signals.map(signal=>signal.id)).size).toBe(signals.length);
    expect(detectOscillatorDivergences(cols,values,metadata).map(signal=>signal.id)).toEqual(signals.map(signal=>signal.id));
    expect(detectOscillatorDivergences(cols,values,{...metadata,plotIndex:1})[0].id).not.toBe(signals[0].id);
  });

  it('chooses the rightmost equal-price plateau extremum and emits no flat/equal-momentum divergence',()=>{
    const {cols,columns,values}=bullish();columns.low[21]=85;values[21]=40;
    const [plateau]=detectOscillatorDivergences(cols,values,metadata);
    expect(plateau.points[1].time).toBe(21*step);expect(plateau.confirmedAt).toBe(25*step);
    columns.low.fill(99);expect(detectOscillatorDivergences(cols,values,metadata)).toEqual([]);
    columns.low[10]=90;columns.low[20]=90;expect(detectOscillatorDivergences(cols,values,metadata)).toEqual([]);
    columns.low[20]=85;values[20]=values[10];expect(detectOscillatorDivergences(cols,values,metadata)).toEqual([]);
  });

  it('does not identify hidden divergence or same-direction price/momentum recovery',()=>{
    const {cols,columns,values}=bullish();columns.low[20]=95;values[20]=20;
    expect(detectOscillatorDivergences(cols,values,metadata)).toEqual([]);
    values[20]=40;expect(detectOscillatorDivergences(cols,values,metadata)).toEqual([]);
  });

  it('handles outside candles independently by side without inventing an intrabar high-low ordering',()=>{
    const {cols,columns,values}=bullish();columns.high[10]=110;columns.high[20]=120;columns.high[30]=130;columns.low[30]=80;values[30]=20;
    const signals=detectOscillatorDivergences(cols,values,metadata);
    expect(signals.map(signal=>signal.direction)).toEqual(['bullish','bearish']);
    for(const signal of signals)expect(signal.points[0].time).toBeLessThan(signal.points[1].time);
    expect(signals[1].points.map(point=>point.time)).toEqual([20*step,30*step]);
  });

  it('does not bridge invalid OHLC, unavailable oscillator intervals, or non-increasing timestamps',()=>{
    const {cols,columns,values}=bullish();columns.close[15]=NaN;
    expect(detectOscillatorDivergences(cols,values,metadata)).toEqual([]);
    columns.close[15]=100;values[15]=NaN;expect(detectOscillatorDivergences(cols,values,metadata)).toEqual([]);
    values[15]=50;columns.time[15]=columns.time[14];expect(detectOscillatorDivergences(cols,values,metadata)).toEqual([]);
  });

  it('does not skip an intervening price pivot merely because its oscillator value is unavailable',()=>{
    const {cols,columns,values}=bullish();columns.low[30]=80;values[20]=NaN;values[30]=45;
    expect(detectOscillatorDivergences(cols,values,metadata)).toEqual([]);
  });

  it('preserves valid sessions and does not timestamp an earlier signal from a later opening session',()=>{
    const {cols,columns,values}=bullish();for(let i=24;i<cols.length;i++)columns.time[i]+=8*60*step;
    const full=detectOscillatorDivergences(cols,values,metadata),atClose=detectOscillatorDivergences(prefix(cols,24,24),values,metadata);
    expect(full[0].confirmedAt).toBe(24*step);expect(full).toEqual(atClose);
    // A legitimate session break between anchors is not unavailable price data.
    for(let i=15;i<24;i++)columns.time[i]+=60*step;
    expect(detectOscillatorDivergences(cols,values,metadata)).toHaveLength(1);
  });

  it('keeps past detections identical for every growing prefix and arbitrary future tail prices',()=>{
    const {cols,columns,values}=bullish(),full=detectOscillatorDivergences(cols,values,metadata);
    for(let length=2;length<=cols.length;length++){
      const signals=detectOscillatorDivergences(prefix(cols,length),values,metadata);
      expect(signals).toEqual(full.filter(signal=>signal.confirmedAt<=(length-1)*step));
    }
    const view=prefix(cols,25),before=detectOscillatorDivergences(view,values,metadata);
    for(let i=24;i<cols.length;i++){columns.high[i]=10000;columns.low[i]=1;columns.close[i]=500;columns.open[i]=500;values[i]=-999;}
    expect(detectOscillatorDivergences(view,values,metadata)).toEqual(before);
  });
});

describe('incremental oscillator divergence archive',()=>{
  it('matches full scans for every closed-bar update and reuses metadata identity for forming ticks',()=>{
    const {cols,columns,values}=bullish();columns.low[30]=80;values[30]=45;
    const calculator=new OscillatorDivergenceCalculator(metadata);
    for(let length=1;length<=cols.length;length++){
      const view=prefix(cols,length),result=calculator.update(view,values,length-2);
      expect(result).toEqual(detectOscillatorDivergences(view,values,metadata));
      const forming=length-1,oldHigh=columns.high[forming],oldLow=columns.low[forming],oldValue=values[forming];
      columns.high[forming]=999;columns.low[forming]=1;values[forming]=-999;
      expect(calculator.update(view,values,forming)).toBe(result);
      columns.high[forming]=oldHigh;columns.low[forming]=oldLow;values[forming]=oldValue;
    }
  });

  it('preserves the previous result array when a new closed bar creates no new divergence',()=>{
    const {cols,values}=bullish(),calculator=new OscillatorDivergenceCalculator(metadata);
    const first=calculator.update(prefix(cols,25),values);
    expect(first).toHaveLength(1);
    expect(calculator.update(prefix(cols,26),values,24)).toBe(first);
  });

  it('recomputes historical corrections and rewinds without retaining invalidated detections',()=>{
    const {cols,values}=bullish(),calculator=new OscillatorDivergenceCalculator(metadata);
    const first=calculator.update(cols,values);expect(first).toHaveLength(1);
    values[20]=20;
    const corrected=calculator.update(cols,values,20);expect(corrected).toEqual([]);expect(first).toHaveLength(1);
    values[20]=40;expect(calculator.update(cols,values,20)).toHaveLength(1);
    expect(calculator.update(prefix(cols,20),values)).toEqual([]);
    expect(calculator.update(cols,values,19)).toEqual(detectOscillatorDivergences(cols,values,metadata));
  });

  it('rebuilds when source/indicator buffers are replaced or the last closed sample is corrected',()=>{
    const {cols,values}=bullish(),calculator=new OscillatorDivergenceCalculator(metadata);
    calculator.update(cols,values);
    const replacements=values.slice();replacements[20]=20;
    expect(calculator.update(cols,replacements)).toEqual([]);
    const short=prefix(cols,24,24);replacements[20]=40;
    const initial=calculator.update(short,replacements);expect(initial).toHaveLength(1);
    cols.col('low')[23]=80;
    expect(calculator.update(short,replacements)).toEqual([]);
  });

  it('examines a bounded number of samples on append instead of rescanning loaded history',()=>{
    const {cols,columns,values}=fixture(30_002);let reads=0;
    const measured=(array:Float64Array)=>new Proxy(array,{get(target,key){
      if(typeof key==='string'&&/^\d+$/.test(key))reads++;
      return Reflect.get(target,key,target);
    }});
    const observed=Object.fromEntries(Object.entries(columns).map(([name,array])=>[name,measured(array)])) as Record<ColumnName,Float64Array>;
    const measuredValues=measured(values),view:ColumnView={...cols,length:30_000,col:name=>observed[name]};
    const calculator=new OscillatorDivergenceCalculator(metadata);
    calculator.update(view,measuredValues);
    reads=0;
    calculator.update({...view,length:30_001},measuredValues,29_999);
    expect(reads).toBeLessThan(200);
  });
});
