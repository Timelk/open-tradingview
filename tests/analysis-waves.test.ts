import {describe,expect,it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import type {ColumnView} from '../src/lib/core/types';
import {detectWolfeWaves,detectElliottWaves,validateElliottImpulse} from '../src/lib/analysis/waves';
const minute=60_000,epoch=Date.UTC(2026,0,1);
type Anchor=[number,number];
function path(anchors:Anchor[],mirror=false):ColumnStore {
  const store=new ColumnStore(2048);
  for(let j=0;j<anchors.length-1;j++)for(let i=anchors[j][0];i<anchors[j+1][0];i++){
    const raw=anchors[j][1]+(anchors[j+1][1]-anchors[j][1])*(i-anchors[j][0])/(anchors[j+1][0]-anchors[j][0]),value=mirror?300-raw:raw;
    store.appendBar({time:epoch+i*minute,open:value,high:value,low:value,close:value,volume:100});
  }
  return store;
}
const prefix=(store:ColumnView,length:number):ColumnView=>({length,closedLength:length,intervalMs:minute,col:name=>store.col(name)});
const options={pivotStrength:2,multiScale:false,maxObservations:300,lookback:1500};
const wolfe:Anchor[]=[[0,110],[10,100],[30,120],[50,95],[70,105],[90,88.5],[120,112]];
const impulse:Anchor[]=[[0,110],[10,100],[30,120],[50,110],[70,150],[90,130],[110,160],[130,135],[150,150],[170,125],[190,145]];

describe('Wolfe closed five-point geometry',()=>{
  it.each([false,true])('distinguishes four real anchors from five, and mirrors price geometry (%s)',mirror=>{
    const store=path(wolfe,mirror),early=detectWolfeWaves(prefix(store,73),options).find(o=>o.points.length===4);
    expect(early).toBeDefined();expect(early?.points.map(p=>p.label)).toEqual(['1','2','3','4']);expect(early?.points.some(p=>p.label==='5')).toBe(false);
    const complete=detectWolfeWaves(prefix(store,120),options).find(o=>o.points.length===5)!;expect(complete).toBeDefined();expect(complete.direction).toBe(mirror?'bearish':'bullish');expect(complete.state).toBe('confirmed');
    expect(complete.availableAt).toBe(epoch+93*minute);expect(complete.lines?.some(l=>l.label?.startsWith('1–4'))).toBe(true);expect(complete.events[0].kind).toBe('boundary-return');
    expect(detectWolfeWaves(prefix(store,92),options).some(o=>o.id===complete.id)).toBe(false);
    expect(detectWolfeWaves(prefix(store,93),options).find(o=>o.id===complete.id)?.points).toEqual(complete.points);
  });
  it('rejects a non-convergent outline and an arbitrarily deep fifth plunge',()=>{
    for(const bad of [wolfe.map(([i,v]):Anchor=>[i,i===70?116:v]),wolfe.map(([i,v]):Anchor=>[i,i===90?65:v])])expect(detectWolfeWaves(prefix(path(bad),120),options).some(o=>o.points.length===5)).toBe(false);
  });
  it('keeps earlier geometry/time across prefixes and cannot bridge a data hole',()=>{
    const store=path(wolfe),full=detectWolfeWaves(prefix(store,120),options).find(o=>o.points.length===5)!;
    for(let n=93;n<=120;n++){const item=detectWolfeWaves(prefix(store,n),options).find(o=>o.id===full.id)!;expect(item.points).toEqual(full.points);expect(item.availableAt).toBe(full.availableAt);}
    for(let i=55;i<store.length;i++)store.col('time')[i]+=minute;
    expect(detectWolfeWaves(prefix(store,120),options).some(o=>o.points.length===5)).toBe(false);
  });
});

describe('Elliott explicit hard rules, subwave proof and alternative counts',()=>{
  it('rejects each hard-rule violation independently, including wave 3 being shortest',()=>{
    expect(validateElliottImpulse([100,120,110,150,130,160]).valid).toBe(true);
    for(const bad of [[100,120,99,150,130,160],[100,120,110,150,119,160],[100,130,125,140,135,170]])expect(validateElliottImpulse(bad).valid).toBe(false);
    expect(validateElliottImpulse([100,120,110,150,130,145],true)).toMatchObject({valid:true,truncated:true});
    expect(validateElliottImpulse([100,120,110,150,130,145]).valid).toBe(false);
  });
  it.each([false,true])('emits actual impulse and ABC anchors, with unproven lower-degree structure kept observing (%s)',mirror=>{
    const result=detectElliottWaves(prefix(path(impulse,mirror),190),options),five=result.find(o=>o.ruleVersion==='elliott-impulse/1.0'&&o.points[0].time===epoch+10*minute)!;
    expect(five).toBeDefined();expect(five.points.map(p=>p.label)).toEqual(['0','1','2','3','4','5']);expect(five.state).toBe('observing');expect(five.direction).toBe(mirror?'bearish':'bullish');expect(five.evidence.join(' ')).toContain('细分尚未完整匹配');
    const abc=result.find(o=>o.ruleVersion==='elliott-abc/1.0'&&o.points[0].time===epoch+110*minute)!;
    expect(abc).toBeDefined();expect(abc.points.map(p=>p.label)).toEqual(['0','A','B','C']);expect(abc.direction).toBe(mirror?'bullish':'bearish');
    expect(five.alternatives?.length).toBeGreaterThan(0);expect(five.alternatives?.length).toBeLessThanOrEqual(3);
  });
  it('validates an actual nested 5–3–5–3–5 subdivision instead of assuming it',()=>{
    const major=[100,140,120,200,160,230],anchors:Anchor[]=[[0,110],[40,100]];
    for(let leg=0;leg<5;leg++){
      const subdivisions=leg%2===0?[0,.3,.15,.7,.5,1]:[0,.7,.35,1];
      for(let j=1;j<subdivisions.length;j++)anchors.push([40+leg*30+j*30/(subdivisions.length-1),major[leg]+(major[leg+1]-major[leg])*subdivisions[j]]);
    }
    anchors.push([220,220]);const store=path(anchors),items=detectElliottWaves(prefix(store,220),{...options,pivotStrength:20});
    const item=items.find(o=>o.ruleVersion==='elliott-impulse/1.0'&&o.points[0].time===epoch+40*minute);
    expect(item).toBeDefined();expect(item?.state).toBe('confirmed');expect(item?.evidence.join(' ')).toContain('5–3–5–3–5 细分匹配');
  });
  it('preserves original numbering, availability and then-known alternatives on every later prefix',()=>{
    const store=path(impulse),earliest=detectElliottWaves(prefix(store,113),options).find(o=>o.ruleVersion==='elliott-impulse/1.0')!;expect(earliest).toBeDefined();
    for(let n=113;n<=190;n++){
      const item=detectElliottWaves(prefix(store,n),options).find(o=>o.id===earliest.id)!;expect(item).toBeDefined();expect(item.points).toEqual(earliest.points);expect(item.availableAt).toBe(earliest.availableAt);expect(item.alternatives).toEqual(earliest.alternatives);
    }
    const before=detectElliottWaves(prefix(store,112),options);expect(before.some(o=>o.id===earliest.id)).toBe(false);
  });
});
