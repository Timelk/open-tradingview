import {describe,expect,it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import type {ColumnView} from '../src/lib/core/types';
import {detectHurstCycles,estimateCausalCycles} from '../src/lib/analysis/cycles';
import {analysisIndicators} from '../src/lib/analysis/registry';
import {detectGann,gannPriceAt} from '../src/lib/analysis/gann';
const minute=60_000,start=Date.UTC(2026,0,1);
function data(values:number[]):ColumnStore {const store=new ColumnStore();values.forEach((v,i)=>store.appendBar({time:start+i*minute,open:v,high:v+.1,low:v-.1,close:v,volume:100}));return store;}
const view=(store:ColumnView,closed=store.length):ColumnView=>({length:store.length,closedLength:closed,intervalMs:minute,col:name=>store.col(name)});
const series=(period:number,n=600)=>Array.from({length:n},(_,i)=>100+i*.03+5*Math.cos(2*Math.PI*i/period));
describe('causal multi-component cycle estimates',()=>{
  it.each([24,47,80])('recovers an independent %i-bar component with stable halves, not a hardcoded nominal length',period=>{
    const result=estimateCausalCycles(series(period),{minPeriod:10,maxPeriod:120});expect(result.length).toBeGreaterThan(0);
    expect(Math.abs(result[0].periodBars-period)).toBeLessThanOrEqual(1);expect(result[0].stability).toBeGreaterThan(.8);expect(result[0].explainedVariance).toBeGreaterThan(.8);
  });
  it('separates simultaneous 32/80-bar components and rejects flat/linear/noise-only evidence',()=>{
    const values=Array.from({length:800},(_,i)=>100+i*.02+5*Math.cos(2*Math.PI*i/32)+4*Math.cos(2*Math.PI*i/80));
    const models=estimateCausalCycles(values,{maxPeriod:120,minFit:.15});expect(models.some(m=>Math.abs(m.periodBars-32)<=1)).toBe(true);expect(models.some(m=>Math.abs(m.periodBars-80)<=1)).toBe(true);
    expect(estimateCausalCycles(Array(600).fill(100))).toEqual([]);expect(estimateCausalCycles(Array.from({length:600},(_,i)=>100+i*.1))).toEqual([]);
    let seed=12345;const noise=Array.from({length:600},()=>{seed=(seed*1664525+1013904223)>>>0;return 100+seed/4294967296;});expect(estimateCausalCycles(noise)).toEqual([]);
  });
  it('widens phase uncertainty and marks instability when the two halves change period',()=>{
    const stable=estimateCausalCycles(series(40))[0],drift=estimateCausalCycles(Array.from({length:600},(_,i)=>100+5*Math.cos(2*Math.PI*i/(i<300?30:60))),{minFit:.08})[0];
    expect(drift).toBeDefined();expect(drift.stability).toBeLessThan(stable.stability);expect(drift.phaseRange[1]-drift.phaseRange[0]).toBeGreaterThan(stable.phaseRange[1]-stable.phaseRange[0]);
  });
  it('uses only the declared closed prefix and restarts its estimation window after a data hole',()=>{
    const store=data(series(40,900)),prefix=view(store,600),before=detectHurstCycles(prefix,{windowBars:600});
    expect(before.length).toBeGreaterThan(0);for(let i=600;i<900;i++){store.col('close')[i]=500;store.col('high')[i]=501;store.col('low')[i]=499;}
    expect(detectHurstCycles(prefix,{windowBars:600})).toEqual(before);expect(before.every(o=>o.availableAt===start+600*minute)).toBe(true);
    const broken=data(series(40,600));for(let i=580;i<600;i++)broken.col('time')[i]+=minute;
    expect(detectHurstCycles(view(broken),{windowBars:600})).toEqual([]);
  });
});
describe('Gann explicit manual price/time units',()=>{
  const config={anchorTime:start+10*minute,anchorPrice:100,priceUnit:2,timeUnitBars:4,projectionBars:40,direction:'up'};
  it('requires actual data and explicit anchors/units, with no automatic flattering pivot',()=>{
    expect(detectGann(view(data([])),config)).toEqual([]);const store=view(data(series(40,100)));
    expect(detectGann(store,{})).toEqual([]);expect(detectGann(store,{...config,anchorTime:start+1000*minute})).toEqual([]);expect(detectGann(store,{...config,priceUnit:0})).toEqual([]);
    const [item]=detectGann(store,config);expect(item.points[0]).toEqual({label:'手动锚点',time:config.anchorTime,value:100});expect(item.lines).toHaveLength(9);expect(item.state).toBe('observing');
  });
  it('computes fixed domain prices unaffected by pixel dimensions and scales predictably with units',()=>{
    expect(gannPriceAt(start+18*minute,config.anchorTime,100,2,4*minute)).toBe(104);
    expect(gannPriceAt(start+18*minute,config.anchorTime,100,2,4*minute,.5)).toBe(102);
    const store=view(data(series(40,100))),a=detectGann(store,config)[0],b=detectGann(store,{...config,chartWidth:4000,chartHeight:2000})[0];expect(a.lines).toEqual(b.lines);
    const doubled=detectGann(store,{...config,priceUnit:4})[0];const line=a.lines!.find(l=>l.label!.includes('1×1'))!,other=doubled.lines!.find(l=>l.label!.includes('1×1'))!;
    expect(other.points.at(-1)!.value-100).toBeCloseTo(2*(line.points.at(-1)!.value-100));
  });
  it('keeps bearish rays positive and never turns post-hoc manual crossings into earlier known signals',()=>{
    const item=detectGann(view(data(series(40,100))),{...config,direction:'down'})[0];expect(item.lines!.every(l=>l.points.every(p=>p.value>0))).toBe(true);
    expect(item.events.every(event=>event.availableAt===item.availableAt)).toBe(true);
  });
  it('does not look at later OHLC and reports gaps in a retained manual projection',()=>{
    const store=data(series(40,100)),before=detectGann(view(store,60),config);
    for(let i=60;i<100;i++)store.col('close')[i]=999;expect(detectGann(view(store,60),config)).toEqual(before);
    for(let i=40;i<100;i++)store.col('time')[i]+=minute;expect(detectGann(view(store,60),config)[0].dataWarning).toContain('缺口');
  });
});

it('registered Gann defaults accept research-page anchors with 0 meaning chart bar duration',()=>{
  const def=analysisIndicators().find(d=>d.id==='analysis-gann')!;
  const defaults=Object.fromEntries(def.inputs.map(input=>[input.key,input.def]));
  const observations=detectGann(view(data(series(40,100))),{...defaults,anchorTime:start+10*minute,anchorPrice:100,priceUnit:2,timeUnitBars:4});
  expect(observations).toHaveLength(1);expect(observations[0].lines).toHaveLength(18);
  const one=observations[0].lines!.find(line=>line.label!.startsWith('↑ 1×1'))!;
  for(const point of one.points)expect(point.value).toBeCloseTo(100+(point.time-start-10*minute)/(4*minute)*2);
  expect(detectGann(view(data(series(40,100))),{...defaults,anchorTime:start+10*minute,anchorPrice:100,timeUnitMs:-1})).toEqual([]);
});
