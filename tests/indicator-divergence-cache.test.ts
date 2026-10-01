import {describe,it,expect} from 'vitest';
import {IndicatorDivergenceProjectionCache,projectIndicatorDivergences} from '../src/lib/indicators/divergence-projection';
import type {ColumnView,DerivedSeries} from '../src/lib/core/types';
import type {OscillatorDivergence} from '../src/lib/indicators/divergence';
import type {IndicatorInstance} from '../src/lib/scene/types';
const step=60000;
function fixture(n=121){
  const times=Float64Array.from({length:n},(_,i)=>i*step),values=Float64Array.from({length:n},(_,i)=>30+i*.1);
  const cols:ColumnView={length:n,closedLength:n-1,col:()=>times};
  const target:IndicatorInstance={id:'rsi',instanceId:'rsi-1',params:{period:7},timeframe:'chart',hiddenPlots:[]};
  const evidence=(id:string,first=10,second=30):OscillatorDivergence=>({id,indicator:'rsi',seriesName:'RSI',plotIndex:0,direction:'bullish',confirmedAt:(second+4)*step,
    points:[{time:first*step,value:1,price:100},{time:second*step,value:2,price:99}],ruleVersion:'test'});
  const line:DerivedSeries={name:'RSI',indicatorId:'rsi-1',plotIndex:0,plot:'line',pane:'sub',color:'#fff',values,divergences:[evidence('a')]};
  return {times,values,cols,target,line,evidence};
}
describe('revision-aware indexed divergence projection',()=>{
  it('matches the uncached path, retains crossing lines, and preserves archive order/deduplication',()=>{
    const f=fixture(),cache=new IndicatorDivergenceProjectionCache();
    f.line.divergences=[f.evidence('late',50,70),f.evidence('crossing',1,100),f.evidence('early'),f.evidence('duplicate')];
    for(const [from,to] of [[0,120],[40,45],[29,60],[90,95]]){
      const window={fromTime:from*step,toTime:to*step};
      expect(cache.project(f.line,f.target,f.cols,'1m',window,1)).toEqual(projectIndicatorDivergences(f.line,f.target,f.cols,'1m',window));
    }
    expect(cache.project(f.line,f.target,f.cols,'1m',{fromTime:40*step,toTime:45*step},1).map(mark=>mark.divergence.id)).toEqual(['crossing']);
  });
  it('reuses a steady frame and invalidates same-array values and timestamp repairs by revision',()=>{
    const f=fixture(),cache=new IndicatorDivergenceProjectionCache(),window={fromTime:0,toTime:100*step};
    const first=cache.project(f.line,f.target,f.cols,'1m',window,1);
    expect(cache.project(f.line,f.target,f.cols,'1m',window,1)).toBe(first);
    f.values[20]=NaN;expect(cache.project(f.line,f.target,f.cols,'1m',window,2)).toEqual([]);
    f.values[20]=32;expect(cache.project(f.line,f.target,f.cols,'1m',window,3)).toHaveLength(1);
    f.times[10]+=1;expect(cache.project(f.line,f.target,f.cols,'1m',window,4)).toEqual([]);
  });
  it('invalidates replacements, archive changes, timeframe changes, and rewind without requiring a revision',()=>{
    const f=fixture(),cache=new IndicatorDivergenceProjectionCache();
    expect(cache.project(f.line,f.target,f.cols,'1m')).toHaveLength(1);
    f.line.values=f.values.slice();f.line.values[30]=0;expect(cache.project(f.line,f.target,f.cols,'1m')).toEqual([]);
    f.line.values=f.values;expect(cache.project(f.line,f.target,f.cols,'1m')).toHaveLength(1);
    expect(cache.project(f.line,f.target,{...f.cols,closedLength:20},'1m')).toEqual([]);
    expect(cache.project(f.line,{...f.target,timeframe:'5m'},f.cols,'1m')).toEqual([]);
    f.line.divergences=[];expect(cache.project(f.line,f.target,f.cols,'1m')).toEqual([]);
    f.line.divergences=[f.evidence('new',20,50)];expect(cache.project(f.line,f.target,f.cols,'1m')[0].divergence.id).toBe('new');
    cache.clear();expect(cache.project(f.line,f.target,f.cols,'1m')).toEqual(projectIndicatorDivergences(f.line,f.target,f.cols,'1m'));
  });
  it('indexes the shifted higher-timeframe display interval, including crossing the viewport',()=>{
    const f=fixture(),cache=new IndicatorDivergenceProjectionCache();f.target.timeframe='5m';f.line.timeframe='5m';
    f.line.divergences=[f.evidence('htf',10,40)];f.line.divergences[0].confirmedAt=50*step;
    for(const window of [{fromTime:44*step,toTime:46*step},{fromTime:16*step,toTime:18*step},{fromTime:46*step,toTime:70*step}])
      expect(cache.project(f.line,f.target,f.cols,'1m',window,1)).toEqual(projectIndicatorDivergences(f.line,f.target,f.cols,'1m',window));
  });
  it('panning queries only relevant entries after indexing a large archive',()=>{
    const f=fixture(20010),cache=new IndicatorDivergenceProjectionCache();let reads=0;
    f.line.divergences=Array.from({length:10000},(_,i)=>{
      const d=f.evidence(String(i),i*2,i*2+1),points=d.points;
      Object.defineProperty(d,'points',{get(){reads++;return points;},enumerable:true});return d;
    });
    cache.project(f.line,f.target,f.cols,'1m',{fromTime:19000*step,toTime:19100*step},1);reads=0;
    const marks=cache.project(f.line,f.target,f.cols,'1m',{fromTime:19050*step,toTime:19150*step},1);
    expect(marks.length).toBeGreaterThan(40);expect(reads).toBeLessThan(200);
  });
  it('bounds overview projection by screen density while retaining selected and complete archived evidence',()=>{
    const f=fixture(20010),cache=new IndicatorDivergenceProjectionCache();let reads=0;
    const archive=Array.from({length:10000},(_,i)=>{
      const d=f.evidence(String(i),i*2,i*2+1),points=d.points;
      Object.defineProperty(d,'points',{get(){reads++;return points;},enumerable:true});return d;
    });
    f.line.divergences=archive;
    cache.project(f.line,f.target,f.cols,'1m',{fromTime:0,toTime:20000*step},1,{maxMarks:100,selectedId:'20'});reads=0;
    const marks=cache.project(f.line,f.target,f.cols,'1m',{fromTime:step,toTime:19990*step},1,{maxMarks:100,selectedId:'20'});
    expect(marks.length).toBeLessThanOrEqual(103);expect(marks.some(mark=>mark.divergence.id==='20')).toBe(true);
    expect(reads).toBeLessThan(500);expect(f.line.divergences).toBe(archive);expect(archive).toHaveLength(10000);
    for(const mark of marks)expect(mark.indices?.map(index=>f.values[index])).toEqual(mark.points.map(point=>point.value));
    const close={fromTime:10*step,toTime:100*step};
    expect(cache.project(f.line,f.target,f.cols,'1m',close,1)).toEqual(projectIndicatorDivergences(f.line,f.target,f.cols,'1m',close));
    f.values[41]=NaN;
    expect(cache.project(f.line,f.target,f.cols,'1m',{fromTime:step,toTime:19990*step},2,{maxMarks:100,selectedId:'20'}).some(mark=>mark.divergence.id==='20')).toBe(false);
    f.values[41]=35;
    const restored=cache.project(f.line,f.target,f.cols,'1m',{fromTime:step,toTime:19990*step},3,{maxMarks:100,selectedId:'20'});
    expect(restored.find(mark=>mark.divergence.id==='20')?.points[1].value).toBe(35);
    f.values[f.cols.length-1]=NaN;
    expect(cache.project(f.line,f.target,f.cols,'1m',{fromTime:step,toTime:19990*step},4,{maxMarks:100,selectedId:'20'})).toEqual(restored);
  });
});
