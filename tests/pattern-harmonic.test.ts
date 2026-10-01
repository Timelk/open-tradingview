import { describe, expect, it } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import { detectHarmonics, HARMONIC_FAMILIES } from '../src/lib/patterns/harmonic';
import { confirmedPivotEvents } from '../src/lib/patterns/pivots';
import type { ColumnView } from '../src/lib/core/types';

const step=60_000;
function storeOf(anchors:number[]):ColumnStore {
  const store=new ColumnStore(64),values:number[]=[];
  const leading=anchors[0]+(anchors[1]-anchors[0])*.15;
  values.push(leading,(leading+anchors[0])/2);
  anchors.forEach((value,index)=>{
    values.push(value);
    if(index<anchors.length-1)for(let at=1;at<4;at++)values.push(value+(anchors[index+1]-value)*at/4);
  });
  const last=anchors.at(-1)!,before=anchors.at(-2)!;
  for(let i=1;i<=3;i++)values.push(last+(before-last)*i*.1);
  for(const [i,value] of values.entries())store.appendBar({time:(i+1)*step,open:value,high:value,low:value,close:value,volume:10});
  return store;
}
function prefix(cols:ColumnView,length:number):ColumnView{return {length,col:name=>cols.col(name)};}
const fixtures:[string,number[]][]=[
  ['AB=CD',[200,140,180,120]],
  ['Gartley',[100,200,138.2,183.2,121.4]],
  ['Bat',[100,200,150,180,111.4]],
  ['Butterfly',[100,200,121.4,173,73]],
  ['Crab',[100,200,140,190,38.2]],
  ['Deep Crab',[100,200,110,180,38.2]],
  ['Alternate Bat',[100,200,161.8,190,87]],
  ['5-0',[250,100,200,70,330,200]],
];
const params={pivotStrength:2,tolerance:.04,showInvalidated:true,maxPatterns:100};

describe('causal harmonic pattern recognition',()=>{
  it('retains the eight saved family identifiers and registers three distinct new profiles',()=>{
    expect(HARMONIC_FAMILIES).toEqual([...fixtures.map(([family])=>family),'Shark','Cypher','Three Drives']);
  });

  for(const [family,anchors] of fixtures)for(const mirrored of [false,true]){
    it(`recognizes ${mirrored?'bearish':'bullish'} ${family} with measured ratios and the real confirmation time`,()=>{
      const store=storeOf(mirrored?anchors.map(value=>600-value):anchors);
      const matches=detectHarmonics(store,{...params,family});
      expect(matches).toHaveLength(1);
      const match=matches[0],d=match.points.at(-1)!;
      expect(match.direction).toBe(mirrored?'bearish':'bullish');
      expect(match.confirmedAt).toBe(d.time+3*step);
      expect(match.points.map(point=>point.label).join('')).toBe(family==='5-0'?'0XABCD':family==='AB=CD'?'ABCD':'XABCD');
      expect(match.zone.low).toBeLessThanOrEqual(d.value);
      expect(match.zone.high).toBeGreaterThanOrEqual(d.value);
      expect(match.ratios.every(ratio=>Number.isFinite(ratio.value)&&ratio.expected.length>0)).toBe(true);
      expect(match.targets.every(target=>mirrored?target<d.value:target>d.value)).toBe(true);
      expect(mirrored?match.invalidation>d.value:match.invalidation<d.value).toBe(true);
    });
  }

  it('does not identify D until the full right confirmation window has closed',()=>{
    const cols=storeOf(fixtures[1][1]);
    expect(detectHarmonics(prefix(cols,cols.length-1),{...params,family:'Gartley'})).toEqual([]);
    expect(detectHarmonics(cols,{...params,family:'Gartley'})).toHaveLength(1);
    for(let count=1;count<cols.length-1;count++)expect(detectHarmonics(prefix(cols,count),{...params,family:'Gartley'})).toEqual([]);
  });

  it('ignores changing high and low on the forming candle',()=>{
    const cols=storeOf(fixtures[1][1]),before=detectHarmonics(cols,params);
    cols.col('low')[cols.length-1]=-500;cols.col('high')[cols.length-1]=1000;
    expect(detectHarmonics(cols,params)).toEqual(before);
  });

  it('preserves an earlier completed shape when a later same-side pivot replaces D',()=>{
    const cols=storeOf(fixtures[1][1]);
    const initialD=cols.length-4;
    // Rising upper wicks prevent a confirmed high pivot between the two lows.
    // This is specifically a same-side replacement, not merely a later pattern.
    for(let i=initialD+1;i<cols.length;i++)cols.col('high')[i]=188+(i-initialD)*3;
    const original=detectHarmonics(cols,{...params,family:'Gartley'})[0];
    const time=cols.col('time')[cols.length-1];
    for(const [index,value] of [119,124,128,132].entries())cols.appendBar({time:time+(index+1)*step,open:value,high:200+index*3,low:value,close:value,volume:10});
    const events=confirmedPivotEvents(cols,2,1500).filter(point=>point.index>=initialD);
    expect(events.map(point=>point.kind)).toEqual(['low','low']);
    const matches=detectHarmonics(cols,{...params,family:'Gartley'});
    expect(matches.find(match=>match.id===original.id)?.points).toEqual(original.points);
    expect(matches.find(match=>match.id===original.id)?.confirmedAt).toBe(original.confirmedAt);
  });

  it('marks invalidation only on a closed candle and retains provenance when requested',()=>{
    const cols=storeOf(fixtures[1][1]);
    const time=cols.col('time')[cols.length-1];
    cols.appendBar({time:time+step,open:95,high:99,low:90,close:95,volume:10});
    expect(detectHarmonics(cols,{...params,family:'Gartley'})[0].status).toBe('confirmed');
    cols.appendBar({time:time+2*step,open:96,high:99,low:94,close:96,volume:10});
    const [match]=detectHarmonics(cols,{...params,family:'Gartley'});
    expect(match.status).toBe('invalidated');expect(match.invalidatedAt).toBe(time+2*step);
    expect(detectHarmonics(cols,{...params,showInvalidated:false,family:'Gartley'})).toEqual([]);
  });

  it('does not accept an attractive W whose ratios do not match',()=>{
    expect(detectHarmonics(storeOf([100,200,125,150,115]),{...params})).toEqual([]);
  });

  it('rejects 1.618 XA as a Butterfly and uses the deep B requirement for Deep Crab',()=>{
    expect(detectHarmonics(storeOf([100,200,121.4,175,38.2]),{...params,family:'Butterfly'})).toEqual([]);
    expect(detectHarmonics(storeOf(fixtures[4][1]),{...params,family:'Deep Crab'})).toEqual([]);
  });

  it('keeps 5-0 separate from retracement C rules and requires the prior trend leg',()=>{
    expect(detectHarmonics(storeOf([150,100,200,70,330,200]),{...params,family:'5-0'})).toEqual([]);
    expect(detectHarmonics(storeOf([250,100,200,70,260,165]),{...params,family:'5-0'})).toEqual([]);
  });

  it('is price-scale invariant and returns a bounded recent set',()=>{
    const normal=detectHarmonics(storeOf(fixtures[1][1]),params);
    const scaled=detectHarmonics(storeOf(fixtures[1][1].map(price=>price*.00001)),params);
    expect(scaled.map(match=>match.family)).toEqual(normal.map(match=>match.family));
    expect(detectHarmonics(storeOf(fixtures[1][1]),{...params,maxPatterns:1})).toHaveLength(1);
  });

  it('uses immutable confirmation events with chronological timestamps',()=>{
    const cols=storeOf(fixtures[1][1]);
    const events=confirmedPivotEvents(cols,2,1500);
    expect(events.map(point=>point.value)).toEqual(fixtures[1][1]);
    expect(events.every(point=>point.confirmedAt===point.time+3*step)).toBe(true);
  });
});
