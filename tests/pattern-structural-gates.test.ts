import { describe, expect, it } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import type { ColumnView } from '../src/lib/core/types';
import { confirmedPivotEvents } from '../src/lib/patterns/pivots';
import { detectHuzi } from '../src/lib/patterns/huzi';
import { detectHarmonics } from '../src/lib/patterns/harmonic';

const minute=60_000,epoch=Date.parse('2026-08-15T00:00:00Z');
type Anchor=[number,number];
const triangle:Anchor[]=[[0,100],[10,110],[20,90],[30,110],[40,98],[50,110],[55,106],[63,115],[70,115]];
const gartley:Anchor[]=[[0,130],[40,100],[100,200],[140,177],[200,181],[260,138.2],[360,183.2],[460,121.4],[510,145]];
function path(anchors:Anchor[],mirror=false){
  const store=new ColumnStore(1024);
  for(let leg=0;leg<anchors.length-1;leg++){
    const [start,from]=anchors[leg],[end,to]=anchors[leg+1];
    for(let i=start;i<end;i++){
      const raw=from+(to-from)*(i-start)/(end-start),value=mirror?600-raw:raw;
      store.appendBar({time:epoch+i*minute,open:value,high:value,low:value,close:value,volume:1});
    }
  }
  return store;
}
const prefix=(cols:ColumnView,length:number):ColumnView=>({length,col:name=>cols.col(name)});
const options={pivotStrength:3,lookback:1500,tolerance:.04,maxPatterns:1000,showInvalidated:true};

describe('context-supported outside candle pivot',()=>{
  for(const mirrored of [false,true])it(`retains the ${mirrored?'low':'high'} boundary touch when the opposite wick stays inside the prior swing`,()=>{
    const plain=path(triangle,mirrored),outside=path(triangle,mirrored);
    if(mirrored)outside.col('high')[30]=600-98;else outside.col('low')[30]=98;
    const pivots=confirmedPivotEvents(outside,3,1500);
    const point=pivots.find(p=>p.index===30)!;
    expect(point).toBeDefined();expect(point.kind).toBe(mirrored?'low':'high');
    expect(point.value).toBe(mirrored?490:110);
    expect(pivots.filter(p=>p.index===30)).toHaveLength(1);
    const params={...options,family:'三角形',structuralSwings:false};
    const original=detectHuzi(plain,params)[0],recovered=detectHuzi(outside,params).find(p=>p.id===original.id)!;
    expect(recovered).toBeDefined();expect(recovered.points).toEqual(original.points);
    expect(recovered.confirmedAt).toBe(original.confirmedAt);
    for(let length=2;length<35;length++)expect(confirmedPivotEvents(prefix(outside,length),3,1500).some(p=>p.index===30)).toBe(false);
    expect(confirmedPivotEvents(prefix(outside,35),3,1500).find(p=>p.index===30)?.confirmedAt).toBe(epoch+34*minute);
  });

  it('continues to skip a bar breaking both preceding structural extremes',()=>{
    const cols=path(triangle);cols.col('high')[30]=111;cols.col('low')[30]=89;
    expect(confirmedPivotEvents(cols,3,1500).some(p=>p.index===30)).toBe(false);
  });

  it('does not resolve a two-sided extreme before any confirmed swing provides context',()=>{
    const cols=path(triangle);cols.col('low')[10]=95;
    expect(confirmedPivotEvents(cols,3,1500).some(p=>p.index===10)).toBe(false);
  });
});

describe('harmonic amplitude hierarchy without relaxed ratios',()=>{
  for(const mirrored of [false,true])it(`recovers ${mirrored?'bearish':'bullish'} Gartley through a long shallow correction with exact original ratios`,()=>{
    const cols=path(gartley,mirrored),params={...options,family:'Gartley'};
    expect(detectHarmonics(cols,{...params,structuralSwings:false})).toEqual([]);
    const found=detectHarmonics(cols,params),match=found.find(p=>p.points.map(point=>point.time).join() === [40,100,260,360,460].map(i=>epoch+i*minute).join())!;
    expect(match).toBeDefined();expect(match.pivotStrength).toBe(3);
    expect(match.ratios.find(r=>r.label==='AB / XA')?.value).toBeCloseTo(.618);
    expect(match.ratios.find(r=>r.label==='AD / XA')?.value).toBeCloseTo(.786);
    expect(match.ratios.find(r=>r.label==='CD / AB')?.value).toBeCloseTo(1);
    expect(match.description).toContain('结构摆动层级');
    expect(match.confirmedAt).toBe(epoch+464*minute);
    for(let length=430;length<=464;length++)expect(detectHarmonics(prefix(cols,length),params).some(p=>p.id===match.id)).toBe(false);
    for(let length=465;length<=cols.length;length++){
      const first=detectHarmonics(prefix(cols,length),params).find(p=>p.id===match.id)!;
      expect(first).toBeDefined();expect(first.confirmedAt).toBe(match.confirmedAt);expect(first.points).toEqual(match.points);
    }
    const confirmed=detectHarmonics(cols,params);cols.col('high')[cols.length-1]=900;cols.col('low')[cols.length-1]=-100;
    expect(detectHarmonics(cols,params)).toEqual(confirmed);
  });

  it('preserves material opposing swings instead of deleting them to manufacture a ratio match',()=>{
    const material=gartley.map(([i,value]):Anchor=>[i,i===200?195:value]);
    expect(detectHarmonics(path(material),{...options,family:'Gartley'})).toEqual([]);
  });

  it('keeps Fibonacci rejection when the recovered major anchors no longer satisfy Gartley',()=>{
    const mismatched=gartley.map(([i,value]):Anchor=>[i,i===260?130:value]);
    expect(detectHarmonics(path(mismatched),{...options,family:'Gartley'})).toEqual([]);
  });

  it('keeps original clean matches and their confirmation times when amplitude levels are enabled',()=>{
    const clean=gartley.filter(([i])=>i!==140&&i!==200),cols=path(clean),params={...options,family:'Gartley'};
    const original=detectHarmonics(cols,{...params,structuralSwings:false});
    expect(original.length).toBeGreaterThan(0);
    const current=detectHarmonics(cols,params);
    for(const expected of original){
      const actual=current.find(p=>p.id===expected.id)!;
      expect(actual.points).toEqual(expected.points);expect(actual.confirmedAt).toBe(expected.confirmedAt);
    }
  });
});
