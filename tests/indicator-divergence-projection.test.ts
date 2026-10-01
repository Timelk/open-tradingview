import {describe,it,expect} from 'vitest';
import type {ColumnName,ColumnView,DerivedSeries} from '../src/lib/core/types';
import type {IndicatorInstance} from '../src/lib/scene/types';
import type {OscillatorDivergence} from '../src/lib/indicators/divergence';
import {projectIndicatorDivergences} from '../src/lib/indicators/divergence-projection';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {IndicatorRuntime} from '../src/lib/indicators/runtime';

const minute=60_000,day=86_400_000;
function columns(length=121,step=minute,closedLength=length-1):ColumnView{
  const arrays={} as Record<ColumnName,Float64Array>;
  for(const name of ['time','open','high','low','close','volume'] as ColumnName[])
    arrays[name]=Float64Array.from({length},(_,i)=>name==='time'?i*step:name==='high'?102:name==='low'?98:name==='volume'?1000:100+Math.sin(i*.2));
  return {length,closedLength,intervalMs:step,col:name=>arrays[name]};
}
const target=(id='rsi',timeframe='chart',instanceId='oscillator'):IndicatorInstance=>({id,instanceId,timeframe,hiddenPlots:[],
  params:id==='rsi'?{period:7}:id==='macd'?{fast:5,slow:13,signal:4}:{period:9,k:3,d:3}});
function evidence(extra:Partial<OscillatorDivergence>={}):OscillatorDivergence{
  return {id:'independent-evidence',indicator:'rsi',plotIndex:0,seriesName:'RSI(7)',direction:'bullish',confirmedAt:50*minute,ruleVersion:'oscillator-divergence/1.0-regular',
    points:[{time:10*minute,value:999,price:100},{time:30*minute,value:-999,price:98}],...extra};
}
function line(mounted=target(),data=evidence(),length=121):DerivedSeries{
  return {name:data.seriesName,indicatorId:mounted.instanceId,plotIndex:0,timeframe:mounted.timeframe,plot:'line',pane:'sub',color:'#72a7ef',
    values:Float64Array.from({length},(_,i)=>data.direction==='bullish'?30+i*.1:70-i*.1),divergences:[data]};
}

describe('independent mounted oscillator evidence projection',()=>{
  it.each(['rsi','macd','kdj'])('projects arbitrary mounted %s parameters without requiring a price shape',id=>{
    const mounted=target(id),d=evidence({indicator:id,seriesName:id==='rsi'?'RSI(7)':id==='macd'?'DIF':'K'}),series=line(mounted,d),before=structuredClone(d);
    const marks=projectIndicatorDivergences(series,mounted,columns(),'1m');
    expect(marks).toHaveLength(1);expect(marks[0].divergence).toBe(d);
    expect(marks[0].points).toEqual([{time:10*minute,value:series.values[10]},{time:30*minute,value:series.values[30]}]);
    expect(d).toEqual(before);
  });

  it('checks bearish price/oscillator direction against the mounted line, with no default delta threshold',()=>{
    const d=evidence({direction:'bearish',points:[{time:10*minute,value:999,price:100},{time:30*minute,value:-999,price:102}]}),mounted=target(),series=line(mounted,d);
    series.values[30]=series.values[10]-.001;
    expect(projectIndicatorDivergences(series,mounted,columns(),'1m')).toHaveLength(1);
    series.values[30]=series.values[10];expect(projectIndicatorDivergences(series,mounted,columns(),'1m')).toEqual([]);
    series.values[30]=series.values[10]+1;expect(projectIndicatorDivergences(series,mounted,columns(),'1m')).toEqual([]);
    series.values[30]=series.values[10]-1;d.points[1].price=99;
    expect(projectIndicatorDivergences(series,mounted,columns(),'1m')).toEqual([]);
  });

  it('deduplicates metadata ids for one plot/direction/anchor pair while preserving separate pairs',()=>{
    const mounted=target(),d=evidence(),series=line(mounted,d);
    series.divergences=[d,{...d,id:'same-pair-another-id'},evidence({id:'other-pair',points:[{time:11*minute,value:30,price:100},{time:31*minute,value:32,price:98}]})];
    expect(projectIndicatorDivergences(series,mounted,columns(),'1m').map(m=>m.divergence.id)).toEqual([d.id,'other-pair']);
  });

  it('matches the exact mounted instance, output index, indicator and effective timeframe',()=>{
    const mounted=target(),series=line(mounted),cols=columns();
    for(const bad of [{...series,indicatorId:'another-instance'},{...series,plotIndex:1},{...series,timeframe:'5m'},
      {...series,divergences:[evidence({indicator:'macd'})]}])expect(projectIndicatorDivergences(bad,mounted,cols,'1m')).toEqual([]);
    const plotOne={...series,plotIndex:1,divergences:[evidence({plotIndex:1})]};
    expect(projectIndicatorDivergences(plotOne,mounted,cols,'1m')).toHaveLength(1);
    expect(projectIndicatorDivergences(series,{...mounted,params:{period:7,showDivergences:false}},cols,'1m')).toEqual([]);
  });

  it('handles chart and explicit equal timeframe without shifting',()=>{
    const mounted=target('rsi','1m'),series=line(mounted),cols=columns();
    expect(projectIndicatorDivergences(series,mounted,cols,'1m')[0].points[0].time).toBe(10*minute);
    expect(projectIndicatorDivergences({...series,timeframe:'chart'},{...mounted,timeframe:'chart'},cols,'1m')).toEqual(projectIndicatorDivergences(series,mounted,cols,'1m'));
    expect(projectIndicatorDivergences(series,mounted,cols,'5m')).toEqual([]);
    expect(projectIndicatorDivergences({...series,timeframe:'1M'},{...mounted,timeframe:'1M'},cols,'1m')).toEqual([]);
  });

  it('keeps indicator instances isolated, leaving plot/layer visibility to the controller',()=>{
    const a=target('rsi','chart','a'),b=target('rsi','chart','b'),first=line(a),second=line(b);b.hiddenPlots=[0];
    second.values=Float64Array.from(second.values,value=>value+5);
    const av=projectIndicatorDivergences(first,a,columns(),'1m'),bv=projectIndicatorDivergences(second,b,columns(),'1m');
    expect(bv[0].points[0].value-av[0].points[0].value).toBe(5);
    expect(projectIndicatorDivergences(second,a,columns(),'1m')).toEqual([]);
  });

  it('never interpolates missing anchors, spans NaN samples, or reads an unavailable confirmation',()=>{
    const mounted=target(),series=line(mounted),cols=columns();
    const missing=evidence();missing.points[0].time+=1;
    expect(projectIndicatorDivergences({...series,divergences:[missing]},mounted,cols,'1m')).toEqual([]);
    for(const index of [10,20,30]){
      const broken={...series,values:series.values.slice()};broken.values[index]=NaN;
      expect(projectIndicatorDivergences(broken,mounted,cols,'1m')).toEqual([]);
    }
    expect(projectIndicatorDivergences(series,mounted,{...cols,closedLength:25},'1m')).toEqual([]);
    expect(projectIndicatorDivergences({...series,divergences:[evidence({confirmedAt:200*minute})]},mounted,cols,'1m')).toEqual([]);
  });

  it('allows the final explicitly closed same-timeframe sample but not a forming sample',()=>{
    const d=evidence({points:[{time:10*minute,value:30,price:100},{time:60*minute,value:40,price:98}],confirmedAt:61*minute}),mounted=target(),series=line(mounted,d,61);
    expect(projectIndicatorDivergences(series,mounted,columns(61,minute,61),'1m')).toHaveLength(1);
    expect(projectIndicatorDivergences(series,mounted,columns(61,minute,60),'1m')).toEqual([]);
  });

  it('projects higher-timeframe values at their actual next-bucket display coordinates',()=>{
    const mounted=target('rsi','5m'),d=evidence({points:[{time:10*minute,value:1,price:100},{time:40*minute,value:2,price:98}]}),series=line(mounted,d);
    expect(projectIndicatorDivergences(series,mounted,columns(),'1m')[0].points).toEqual([
      {time:15*minute,value:series.values[15]},{time:45*minute,value:series.values[45]},
    ]);
    expect(projectIndicatorDivergences(series,mounted,columns(),'1m',{fromTime:44*minute,toTime:46*minute})).toHaveLength(1);
    expect(projectIndicatorDivergences(series,mounted,columns(),'1m',{fromTime:46*minute,toTime:70*minute})).toEqual([]);
  });

  it('rejects incomplete higher-timeframe buckets, missing constituents and the live preview slot',()=>{
    const mounted=target('rsi','5m'),d=evidence({points:[{time:10*minute,value:1,price:100},{time:40*minute,value:2,price:98}],confirmedAt:46*minute}),series=line(mounted,d);
    expect(projectIndicatorDivergences(series,mounted,columns(46,minute,46),'1m')).toEqual([]);
    expect(projectIndicatorDivergences(series,mounted,columns(44),'1m')).toEqual([]);
    const cols=columns(),missing:ColumnView={...cols,length:cols.length-1,closedLength:cols.length-2,col:name=>cols.col(name).filter((_,i)=>i!==12)};
    expect(projectIndicatorDivergences(series,mounted,missing,'1m')).toEqual([]);
    const misaligned=structuredClone(d);misaligned.points[0].time=11*minute;
    expect(projectIndicatorDivergences({...series,divergences:[misaligned]},mounted,columns(),'1m')).toEqual([]);
  });

  it('uses actual fixed 30-day runtime buckets instead of assuming calendar months',()=>{
    const mounted=target('rsi','30d'),d=evidence({points:[{time:0,value:1,price:100},{time:60*day,value:2,price:98}],confirmedAt:100*day}),series=line(mounted,d,130);
    expect(projectIndicatorDivergences(series,mounted,columns(130,day),'1d')[0].points).toEqual([
      {time:30*day,value:series.values[30]},{time:90*day,value:series.values[90]},
    ]);
  });

  it('agrees with the actual mounted RSI(7) higher-timeframe runtime output',()=>{
    const cols=columns(401),registry=new IndicatorRegistry();registerBuiltins(registry);
    const runtime=new IndicatorRuntime(registry),mounted=target('rsi','5m');
    runtime.set([{id:'rsi',instanceId:mounted.instanceId,params:mounted.params,timeframe:'5m',baseIntervalMs:minute}]);
    const series=runtime.compute(cols,0)[0];
    let pair:[number,number]|undefined;
    for(let a=80;a<250&&!pair;a+=5)for(let b=a+10;b<300;b+=5)if(series.values[b+5]>series.values[a+5]){pair=[a,b];break;}
    expect(pair).toBeDefined();const [a,b]=pair!;
    const d=evidence({points:[{time:a*minute,value:1,price:100},{time:b*minute,value:2,price:98}],confirmedAt:350*minute});
    const marks=projectIndicatorDivergences({...series,divergences:[d]},mounted,cols,'1m');
    expect(marks[0].points).toEqual([{time:(a+5)*minute,value:series.values[a+5]},{time:(b+5)*minute,value:series.values[b+5]}]);
  });
});
