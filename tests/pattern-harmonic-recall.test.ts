import {describe,expect,it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import {detectHarmonics} from '../src/lib/patterns/harmonic';
import type {ColumnView} from '../src/lib/core/types';

const step=60_000;
function path(anchors:[number,number][],mirror=false):ColumnStore {
  const store=new ColumnStore(256);
  for(let leg=0;leg<anchors.length-1;leg++){
    const [start,from]=anchors[leg],[end,to]=anchors[leg+1];
    for(let index=start;index<end;index++){
      const price=from+(to-from)*(index-start)/(end-start),value=mirror?600-price:price;
      store.appendBar({time:(index+1)*step,open:value,high:value,low:value,close:value,volume:100});
    }
  }
  return store;
}
const noisyGartley:[number,number][]=[[0,130],[20,100],[60,200],[72,177],[75,181],[100,138.2],[140,183.2],[180,121.4],[206,145]];
// These existing cases isolate the time-radius behavior. Amplitude hierarchy
// has dedicated regressions and is disabled here so neither feature masks it.
const params={pivotStrength:2,lookback:1000,tolerance:.04,maxPatterns:100,showInvalidated:true,family:'Gartley',structuralSwings:false};
const prefix=(cols:ColumnView,length:number):ColumnView=>({length,col:name=>cols.col(name)});

for(const mirror of [false,true])describe(`${mirror?'bearish':'bullish'} harmonic recall`,()=>{
  it('recovers a valid larger XABCD when an internal small swing disrupts the base zigzag',()=>{
    const store=path(noisyGartley,mirror);
    expect(detectHarmonics(store,{...params,multiScale:false})).toEqual([]);
    const results=detectHarmonics(store,params);
    const match=results.find(m=>m.points.map(p=>p.time).join()=== [20,60,100,140,180].map(i=>(i+1)*step).join());
    expect(match).toBeDefined();
    expect(match!.direction).toBe(mirror?'bearish':'bullish');
    expect(match!.pivotStrength).toBe(8);
    expect(match!.confirmedAt).toBe(190*step);
    expect(match!.ratios.find(r=>r.label==='AB / XA')!.value).toBeCloseTo(.618);
  });

  it('does not borrow later right-side confirmation and freezes earlier geometry over every prefix',()=>{
    const store=path(noisyGartley,mirror),known=new Map<string,{points:unknown;confirmedAt:number}>();
    for(let length=50;length<=store.length;length++){
      const results=detectHarmonics(prefix(store,length),params);
      for(const match of results){
        expect(match.confirmedAt).toBeLessThanOrEqual(store.col('time')[length-1]);
        const snapshot={points:match.points,confirmedAt:match.confirmedAt};
        if(known.has(match.id))expect(snapshot).toEqual(known.get(match.id));
        else known.set(match.id,snapshot);
      }
      for(const id of known.keys())expect(results.some(match=>match.id===id)).toBe(true);
    }
    expect(known.size).toBeGreaterThan(0);
  });

  for(const multiple of [1.27,1.618])it(`recognizes the book's ${multiple} alternate AB=CD with a separate BC projection`,()=>{
    const a=200,b=100,c=161.8,d=c-100*multiple;
    const store=path([[0,180],[20,a],[60,b],[100,c],[140,d],[170,d+30]],mirror);
    const matches=detectHarmonics(store,{...params,family:'AB=CD'});
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toContain(`${multiple} 延伸`);
    expect(matches[0].ratios.find(r=>r.label==='CD / AB')?.expected).toBe(multiple.toFixed(3));
    expect(matches[0].zone.low).toBeLessThanOrEqual(mirror?600-d:d);
    expect(matches[0].zone.high).toBeGreaterThanOrEqual(mirror?600-d:d);
    expect(detectHarmonics(store,{...params,family:'AB=CD',includeAlternateABCD:false})).toEqual([]);
  });

  it('rejects a stretched leg without supporting BC Fibonacci confluence',()=>{
    // CD/AB=1.27 but CD/BC=1.77: neither a 1.618 nor a 2.0 projection.
    const c=171.75,d=c-127;
    const store=path([[0,180],[20,200],[60,100],[100,c],[140,d],[170,d+30]],mirror);
    expect(detectHarmonics(store,{...params,family:'AB=CD'})).toEqual([]);
  });

  it('deduplicates the same anchors across scales using their earliest confirmation',()=>{
    const store=path([[0,130],[20,100],[60,200],[100,138.2],[140,183.2],[180,121.4],[220,145]],mirror);
    const matches=detectHarmonics(store,params);
    expect(matches).toHaveLength(1);
    expect(matches[0].pivotStrength).toBe(2);
    expect(matches[0].confirmedAt).toBe(184*step);
    expect(matches[0].points).toEqual(detectHarmonics(store,{...params,multiScale:false})[0].points);
  });
});
