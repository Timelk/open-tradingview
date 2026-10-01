import {describe,expect,it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import type {ColumnView} from '../src/lib/core/types';
import {detectHarmonics} from '../src/lib/patterns/harmonic';
import {detectHarmonicCandidates} from '../src/lib/patterns/harmonic-candidates';

const step=60_000,start=Date.UTC(2026,8,20);
const options={pivotStrength:2,multiScale:false,structuralSwings:false,tolerance:.04,maxPatterns:100,showInvalidated:true};
const families=[
  {family:'Shark',values:[100,200,160,220,111.4],labels:'0XABC'},
  {family:'Cypher',values:[100,200,150,230,127.82],labels:'XABCD'},
  {family:'Three Drives',values:[200,160,184.72,153.3256,172.7273392,148.087130416],labels:'01A2B3'},
];
function candles(values:number[],durations=values.slice(1).map(()=>8)):ColumnStore {
  const store=new ColumnStore(256),prices=[values[0]+(values[1]-values[0])*.2,values[0]+(values[1]-values[0])*.1];
  for(let leg=0;leg<values.length-1;leg++)for(let j=0;j<durations[leg];j++)prices.push(values[leg]+(values[leg+1]-values[leg])*j/durations[leg]);
  const last=values.at(-1)!,prior=values.at(-2)!;prices.push(last);
  for(let j=1;j<=3;j++)prices.push(last+(prior-last)*j*.1);
  prices.forEach((value,index)=>store.appendBar({time:start+index*step,open:value,high:value,low:value,close:value,volume:1}));
  return store;
}
const prefix=(store:ColumnView,length:number):ColumnView=>({length,col:name=>store.col(name)});

describe('distinct harmonic families with shared causal scaffolds',()=>{
  for(const spec of families)for(const mirrored of [false,true]){
    const params={...options,family:spec.family};
    it(`confirms ${mirrored?'bearish':'bullish'} ${spec.family} at its real terminal with measured evidence`,()=>{
      const values=mirrored?spec.values.map(p=>500-p):spec.values,store=candles(values),results=detectHarmonics(store,params);
      expect(results).toHaveLength(1);
      const match=results[0];expect(match.family).toBe(spec.family);expect(match.direction).toBe(mirrored?'bearish':'bullish');
      expect(match.points.map(p=>p.label).join('')).toBe(spec.labels);expect(match.points.map(p=>p.value)).toEqual(values);
      expect(match.confirmedAt).toBe(match.points.at(-1)!.time+3*step);
      expect(match.zone.low).toBeLessThanOrEqual(values.at(-1)!);expect(match.zone.high).toBeGreaterThanOrEqual(values.at(-1)!);
      expect(match.ratios.every(r=>Number.isFinite(r.value))).toBe(true);
      expect(detectHarmonics(prefix(store,store.length-1),params)).toEqual([]);
      for(let length=1;length<store.length;length++)expect(detectHarmonics(prefix(store,length),params)).toEqual([]);
    });
    it(`projects ${mirrored?'bearish':'bullish'} ${spec.family}, then hands off without a fictional terminal`,()=>{
      const values=mirrored?spec.values.map(p=>500-p):spec.values,store=candles(values),lastScaffold=2+(values.length-2)*8,view=prefix(store,lastScaffold+4);
      const candidates=detectHarmonicCandidates(view,params,[]);expect(candidates).toHaveLength(1);
      const candidate=candidates[0];expect(candidate.points.map(p=>p.value)).toEqual(values.slice(0,-1));expect(candidate.points.map(p=>p.label).join('')).toBe(spec.labels.slice(0,-1));
      expect(candidate.availableAt).toBe(store.col('time')[lastScaffold+3]);expect(candidate.zone!.low).toBeLessThanOrEqual(values.at(-1)!);expect(candidate.zone!.high).toBeGreaterThanOrEqual(values.at(-1)!);
      expect(candidate).not.toHaveProperty('confirmedAt');expect(candidate).not.toHaveProperty('targets');
      const confirmed=detectHarmonics(store,params);expect(detectHarmonicCandidates(store,params,confirmed).some(p=>p.id===candidate.id)).toBe(false);
      expect(detectHarmonicCandidates(view,params,confirmed)).toEqual([]);
    });
  }
  it('measures Cypher D from XC, rejects the same-looking XA retracement, and requires C beyond A',()=>{
    expect(detectHarmonics(candles([100,200,150,230,121.4]),{...options,family:'Cypher'})).toEqual([]);
    expect(detectHarmonics(candles([100,200,150,190,119.26]),{...options,family:'Cypher'})).toEqual([]);
    const match=detectHarmonics(candles(families[1].values),{...options,family:'Cypher'})[0];expect(match.ratios.find(r=>r.label==='CD / XC')?.value).toBeCloseTo(.786);
  });
  it('does not rename a 5-0 as Shark or accept a Shark with no 0X confluence',()=>{
    const invalid=candles([40,200,160,220,111.4]);expect(detectHarmonics(invalid,{...options,family:'Shark'})).toEqual([]);
    expect(detectHarmonicCandidates(prefix(invalid,30),{...options,family:'Shark'},[])).toEqual([]);
    expect(detectHarmonics(candles(families[0].values),{...options,family:'5-0'})).toEqual([]);
  });
  it('requires price and time symmetry for Three Drives, not merely three falling lows',()=>{
    const params={...options,family:'Three Drives'};
    expect(detectHarmonics(candles(families[2].values,[8,8,8,8,24]),params)).toEqual([]);
    expect(detectHarmonics(candles(families[2].values,[8,8,8,24,8]),params)).toEqual([]);
    expect(detectHarmonics(candles([200,160,184.72,153.3256,172.7273392,141.337]),params)).toEqual([]);
    expect(detectHarmonicCandidates(prefix(candles(families[2].values,[8,8,8,8,24]),48),params,[])).toEqual([]);
  });
  it.each(families.map(f=>[f.family,f.values] as const))('does not bridge missing or corrupt candles in %s',(family,values)=>{
    const params={...options,family},store=candles([...values]),beforeLast=2+(values.length-2)*8+4;
    for(let i=12;i<store.length;i++)store.col('time')[i]+=step;
    expect(detectHarmonics(store,params)).toEqual([]);expect(detectHarmonicCandidates(prefix(store,beforeLast),params,[])).toEqual([]);
    const corrupt=candles([...values]);corrupt.col('close')[12]=NaN;
    expect(detectHarmonics(corrupt,params)).toEqual([]);expect(detectHarmonicCandidates(prefix(corrupt,beforeLast),params,[])).toEqual([]);
  });
  it('honors explicit closedLength and exchange-close sentinel without sampling future OHLC',()=>{
    const store=candles(families[1].values),params={...options,family:'Cypher'},forming=detectHarmonics(store,params);
    const hidden:ColumnView={length:store.length,closedLength:store.length-2,col:name=>store.col(name)};
    expect(detectHarmonics(hidden,params)).toEqual([]);
    const closed:ColumnView={length:store.length-1,closedLength:store.length-1,col:name=>store.col(name)};
    expect(detectHarmonics(closed,params)[0].points).toEqual(forming[0].points);
    expect(detectHarmonics(closed,params)[0].confirmedAt).toBe(forming[0].confirmedAt);
  });
  it('freezes a confirmed structure across later price updates and reports later data interruption',()=>{
    const store=candles(families[1].values),params={...options,family:'Cypher'},initial=detectHarmonics(store,params)[0];
    store.appendBar({time:store.col('time')[store.length-1]+2*step,open:135,high:137,low:134,close:136,volume:1});
    store.appendBar({time:store.col('time')[store.length-1]+step,open:136,high:138,low:135,close:137,volume:1});
    const next=detectHarmonics(store,params).find(p=>p.id===initial.id)!;
    expect(next.points).toEqual(initial.points);expect(next.confirmedAt).toBe(initial.confirmedAt);expect(next.dataWarning).toContain('缺口');
  });
  it.each([false,true])('shares amplitude-compressed scaffolds before and after confirmation (%s)',mirrored=>{
    const anchors:[[number,number],...[number,number][]]=[[0,130],[40,100],[100,200],[140,177],[200,181],[260,138.2],[360,183.2],[460,121.4],[510,145]],store=new ColumnStore(600);
    for(let leg=0;leg<anchors.length-1;leg++){
      const [from,a]=anchors[leg],[to,b]=anchors[leg+1];
      for(let index=from;index<to;index++){const raw=a+(b-a)*(index-from)/(to-from),value=mirrored?600-raw:raw;store.appendBar({time:start+index*step,open:value,high:value,low:value,close:value,volume:1});}
    }
    const params={...options,family:'Gartley',structuralSwings:true},view=prefix(store,365);
    expect(detectHarmonicCandidates(view,{...params,structuralSwings:false},[])).toEqual([]);
    const [candidate]=detectHarmonicCandidates(view,params,[]);expect(candidate).toBeDefined();
    expect(candidate.points.map(p=>p.time)).toEqual([40,100,260,360].map(index=>start+index*step));
    const completed=detectHarmonics(store,params),match=completed.find(m=>m.points.slice(0,-1).every((point,i)=>point.time===candidate.points[i]?.time));
    expect(match).toBeDefined();expect(detectHarmonicCandidates(view,params,completed)).toEqual([]);
  });
  it('accepts calendar-month cadence and confirms the last explicitly closed month at the next month boundary',()=>{
    const store=candles(families[1].values),params={...options,family:'Cypher'};
    for(let index=0;index<store.length;index++)store.col('time')[index]=Date.UTC(2023,index,1);
    const actual=detectHarmonics(store,params)[0];expect(actual).toBeDefined();
    const closed:ColumnView={length:store.length-1,closedLength:store.length-1,col:name=>store.col(name)};
    expect(detectHarmonics(closed,params)[0]?.confirmedAt).toBe(actual.confirmedAt);
  });
});
